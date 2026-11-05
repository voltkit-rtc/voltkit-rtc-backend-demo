/**
 * Rooms: creating them on VoltKit, deciding who gets which role, and keeping Mongo in line with what is live.
 * VoltKit is the truth about live state. Mongo holds what VoltKit has no reason to know: titles, bans, coins.
 * Guide: docs/voltkit-server-sdk.md
 */
import { z } from 'zod';
import { AppError } from '../errors.js';
import { newId } from '../util.js';
import { Room } from '../models/Room.js';
import { isRestricted } from '../models/Guest.js';
import { ENTRANCE_EFFECT } from '../data/gifts.js';
import { deleteRoomQuietly } from './rtc.js';

export const THEMES = ['royal', 'neon', 'galaxy', 'city', 'sunset', 'ocean'];
export const SEATS = { video: [4, 6, 9], audio: [8, 10, 15] };

export const CreateRoomBody = z
  .object({
    type: z.enum(['video', 'audio']),
    title: z.string().trim().min(3, 'Give your room a title of at least 3 characters.').max(48),
    theme: z.enum(THEMES).default('royal'),
    seats: z.number().int(),
    seatMode: z.enum(['open', 'request']).default('request'),
    layout: z.enum(['stage', 'grid']).default('stage'),
  })
  .refine((b) => SEATS[b.type].includes(b.seats), { message: 'That seat count is not available.' });

export function createRoomService({ config, rtc, canGoLive, onRoomsChanged }) {
  async function endRoom(room) {
    await deleteRoomQuietly(rtc, room._id);
    await markEnded(room._id);
  }

  async function markEnded(roomId) {
    const res = await Room.updateOne({ _id: roomId, status: 'live' }, { $set: { status: 'ended', endedAt: new Date(), viewers: 0 } });
    if (res.modifiedCount) onRoomsChanged();
  }

  async function create(guest, body) {
    if (isRestricted(guest)) throw new AppError(403, 'restricted', 'Your account is restricted after reports from other people.');
    if (!(await canGoLive())) throw new AppError(503, 'rtc-unavailable', 'Live rooms are unavailable right now. Please try again later.');

    // One live room per guest: going live again replaces the last one.
    const previous = await Room.find({ 'host.id': guest._id, status: 'live' });
    await Promise.all(previous.map(endRoom));

    const live = await Room.countDocuments({ status: 'live' });
    if (live >= config.maxLiveRooms) throw new AppError(429, 'too-many-rooms', 'Too many rooms are live right now. Try again soon.');

    const roomId = newId('r');
    const { title, type, seats, seatMode, layout, theme } = body;
    // ensureRoom, not createRoom: it is safe to repeat, so a retry after a lost reply gives the right answer.
    // The metadata reaches every participant on joining, so the app can draw the room with no extra request.
    const created = await rtc.ensureRoom({
      roomId,
      hostIdentity: guest._id,
      metadata: { title, type, seats, seatMode, layout, theme },
    });
    if (!created.hostToken || !created.wsUrl) throw new AppError(502, 'rtc-error', 'The live service did not answer properly.');

    const room = await Room.create({
      _id: roomId,
      ...body,
      host: { id: guest._id, name: guest.name, avatar: guest.avatar, frame: guest.frame },
    });
    onRoomsChanged();
    return {
      room,
      credentials: { token: created.hostToken, wsUrl: created.wsUrl, role: 'host', expiresAt: created.expiresAt },
    };
  }

  async function loadLive(roomId) {
    const room = await Room.findById(roomId);
    if (!room || room.status !== 'live') throw new AppError(410, 'room-ended', 'This room has ended.');
    return room;
  }

  /** The role someone holds in the room now. Roles change on the service, so it is the one to ask. */
  async function liveRole(roomId, identity) {
    const people = await rtc.listParticipants(roomId);
    return people.find((p) => p.identity === identity)?.role ?? null;
  }

  async function issueToken(guest, roomId) {
    const room = await loadLive(roomId);
    if (room.bans.includes(guest._id)) throw new AppError(403, 'banned', 'You were removed from this room.');

    try {
      // The role is decided here, never by the request, and is signed into the token. Promotions happen between the
      // host's app and VoltKit, so someone rejoining keeps the role VoltKit says they hold now.
      const present = room.host.id === guest._id ? 'host' : await liveRole(roomId, guest._id);
      const role = present ?? 'viewer';
      const minted = await rtc.createToken({ roomId, identity: guest._id, role });
      if (!minted.token || !minted.wsUrl) throw new AppError(502, 'rtc-error', 'The live service did not answer properly.');
      return {
        room,
        credentials: { token: minted.token, wsUrl: minted.wsUrl, role, expiresAt: minted.expiresAt },
        alreadyInRoom: Boolean(present) && room.host.id !== guest._id,
      };
    } catch (err) {
      if (err.isNotFound) await markEnded(roomId);
      throw err;
    }
  }

  async function join(guest, roomId) {
    const issued = await issueToken(guest, roomId);
    if (!issued.alreadyInRoom) announceEntrance(guest, roomId);
    return issued;
  }

  /** A guest wearing a frame arrives with an effect. Sent from here so it cannot be faked by a client. */
  function announceEntrance(guest, roomId) {
    if (guest.frame === 'none') return;
    rtc
      .sendMessage({
        channel: roomId,
        type: 'entrance',
        ephemeral: true,
        metadata: { identity: guest._id, name: guest.name, frame: guest.frame, svgaUrl: ENTRANCE_EFFECT.svgaUrl },
      })
      .catch((err) => console.warn('entrance announcement failed:', err.message));
  }

  async function end(guest, roomId) {
    const room = await loadLive(roomId);
    if (room.host.id !== guest._id) throw new AppError(403, 'forbidden', 'Only the host can end this room.');
    await endRoom(room);
  }

  /**
   * Keeps someone out of a room for good. VoltKit's kick stops the tokens minted so far, so the app bars
   * them from new ones. The app calls this, then client.kick(). Hosts may ban anyone but themselves;
   * moderators may ban viewers, as on the service.
   */
  async function ban(guest, roomId, target) {
    const room = await loadLive(roomId);
    if (target === room.host.id) throw new AppError(403, 'forbidden', 'The host cannot be removed.');

    if (room.host.id !== guest._id) {
      const people = await rtc.listParticipants(roomId);
      const roleOf = (id) => people.find((p) => p.identity === id)?.role;
      if (roleOf(guest._id) !== 'moderator') throw new AppError(403, 'forbidden', 'Only the host or a moderator can do that.');
      if (roleOf(target) !== 'viewer') throw new AppError(403, 'forbidden', 'Moderators can only remove viewers.');
    }
    await Room.updateOne({ _id: roomId }, { $addToSet: { bans: target } });
  }

  async function list(type) {
    const filter = { status: 'live', ...(type ? { type } : {}) };
    return Room.find(filter).sort({ viewers: -1, createdAt: -1 }).limit(60);
  }

  /**
   * Brings Mongo in line with the service. VoltKit is the truth about what is live: its room list gives
   * the counts, and polling it is the documented way to hold a live count.
   */
  let tick = 0;
  async function reconcile() {
    tick += 1;
    const { rooms: serviceRooms } = await rtc.listRooms();
    const onService = new Map(serviceRooms.map((r) => [r.roomId, r]));
    const ours = await Room.find({ status: 'live' });
    const now = Date.now();
    let changed = false;

    for (const room of ours) {
      const age = now - room.createdAt.getTime();
      const live = onService.get(room._id);

      if (!live) {
        if (age > 15_000) await markEnded(room._id);
        continue;
      }

      const viewers = Number(live.participants) || 0;
      if (viewers !== room.viewers) {
        changed = true;
        await Room.updateOne({ _id: room._id }, { $set: { viewers }, $max: { peakViewers: viewers } });
      }

      // Nobody ever came, or everyone has gone: the service will close it, this only tidies up sooner.
      if (viewers === 0 && age > config.roomStartGraceMs) {
        await endRoom(room);
        continue;
      }

      // About every 30 seconds per room, look for the host. A room without one has nobody to moderate it.
      if (tick % 5 === 0 && viewers > 0 && age > config.roomStartGraceMs) {
        const people = await rtc.listParticipants(room._id);
        if (people.some((p) => p.identity === room.host.id)) {
          await Room.updateOne({ _id: room._id }, { $set: { hostLastSeenAt: new Date() } });
        } else if (now - room.hostLastSeenAt.getTime() > config.hostGraceMs) {
          await endRoom(room);
        }
      }
    }
    if (changed) onRoomsChanged();
  }

  return { create, join, issueToken, end, ban, list, loadLive, reconcile, markEnded };
}
