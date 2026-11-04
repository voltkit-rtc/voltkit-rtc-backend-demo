import { newId } from '../util.js';
import { Guest, publicGuest, isRestricted } from '../models/Guest.js';
import { MatchCall } from '../models/MatchCall.js';
import { deleteRoomQuietly } from './rtc.js';

/**
 * Random 1v1: a waiting line held in memory, one VoltKit room per call. The caller is host and the
 * other side co-host, so both publish. Running several server instances would need this in shared
 * storage; one instance is plenty for a demo.
 */
export function createMatchmaker({ rtc, send }) {
  /** @type {Map<string, { guest: object, joinedAt: number }>} */
  const waiting = new Map();
  /** Who each person last met, so "Next" does not hand back the same stranger when others wait. */
  const lastPeer = new Map();
  /** callId -> members */
  const calls = new Map();
  let matching = false;

  const blockedEitherWay = (a, b) => a.blocked.includes(b._id) || b.blocked.includes(a._id);

  function findPair() {
    const line = [...waiting.values()].sort((x, y) => x.joinedAt - y.joinedAt);
    for (let i = 0; i < line.length; i++) {
      for (let j = i + 1; j < line.length; j++) {
        const a = line[i].guest;
        const b = line[j].guest;
        if (blockedEitherWay(a, b)) continue;
        if (lastPeer.get(a._id) === b._id && line.length > 2) continue;
        return [a, b];
      }
    }
    return null;
  }

  async function startCall(a, b) {
    const callId = newId('call');
    const room = await rtc.ensureRoom({ roomId: callId, hostIdentity: a._id, metadata: { type: 'call' } });
    const other = await rtc.createToken({ roomId: callId, identity: b._id, role: 'cohost' });
    await MatchCall.create({ _id: callId, members: [a._id, b._id] });
    calls.set(callId, [a._id, b._id]);
    lastPeer.set(a._id, b._id);
    lastPeer.set(b._id, a._id);
    send(a._id, 'match:found', {
      callId,
      token: room.hostToken,
      wsUrl: room.wsUrl,
      role: 'host',
      peer: publicGuest(b),
    });
    send(b._id, 'match:found', {
      callId,
      token: other.token,
      wsUrl: other.wsUrl,
      role: 'cohost',
      peer: publicGuest(a),
    });
  }

  async function runMatching() {
    if (matching) return;
    matching = true;
    try {
      for (let pair = findPair(); pair; pair = findPair()) {
        const [a, b] = pair;
        waiting.delete(a._id);
        waiting.delete(b._id);
        try {
          await startCall(a, b);
        } catch (err) {
          console.error('could not start a match:', err.message);
          for (const guest of [a, b]) send(guest._id, 'match:error', { message: 'Could not start the call. Try again.' });
        }
      }
    } finally {
      matching = false;
    }
  }

  async function join(guestId) {
    const guest = await Guest.findById(guestId);
    if (!guest) return;
    if (isRestricted(guest)) {
      send(guestId, 'match:error', { message: 'Your account is restricted after reports from other people.' });
      return;
    }
    if (!waiting.has(guestId)) waiting.set(guestId, { guest, joinedAt: Date.now() });
    send(guestId, 'match:waiting', { waiting: waiting.size });
    await runMatching();
  }

  const leave = (guestId) => waiting.delete(guestId);

  async function end(guestId, callId) {
    const members = calls.get(callId);
    if (!members?.includes(guestId)) return;
    calls.delete(callId);
    const peer = members.find((m) => m !== guestId);
    if (peer) send(peer, 'match:ended', { callId });
    await Promise.all([
      deleteRoomQuietly(rtc, callId).catch((err) => console.warn('could not close call:', err.message)),
      MatchCall.updateOne({ _id: callId }, { $set: { endedAt: new Date() } }),
    ]);
  }

  return { join, leave, end, waitingCount: () => waiting.size };
}
