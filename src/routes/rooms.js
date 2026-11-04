import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { publicRoom } from '../models/Room.js';
import { Gift } from '../models/Gift.js';
import { GiftEvent } from '../models/GiftEvent.js';
import { Guest, privateGuest } from '../models/Guest.js';
import { Room } from '../models/Room.js';
import { requireGuest } from '../middleware/auth.js';
import { limiter } from '../middleware/limits.js';
import { CreateRoomBody } from '../services/rooms.js';

const ListQuery = z.object({ type: z.enum(['video', 'audio']).optional() });
const BanBody = z.object({ identity: z.string().min(1).max(64) });
const GiftBody = z.object({
  giftId: z.string().min(1).max(32),
  to: z.string().min(1).max(64),
  count: z.number().int().min(1).max(99).default(1),
});

export function roomRoutes({ config, rtc, rooms }) {
  const r = Router();
  const auth = requireGuest(config);
  const createLimit = limiter(config, { windowMs: 60_000, limit: 6 });
  const joinLimit = limiter(config, { windowMs: 60_000, limit: 40 });
  const giftLimit = limiter(config, { windowMs: 60_000, limit: 60 });

  r.get('/rooms', auth, async (req, res) => {
    const { type } = ListQuery.parse(req.query);
    const list = await rooms.list(type);
    res.json({ rooms: list.map(publicRoom) });
  });

  r.post('/rooms', auth, createLimit, async (req, res) => {
    const body = CreateRoomBody.parse(req.body);
    const { room, credentials } = await rooms.create(req.guest, body);
    res.status(201).set('Cache-Control', 'no-store').json({ room: publicRoom(room), credentials });
  });

  r.get('/rooms/:id', auth, async (req, res) => {
    const room = await rooms.loadLive(req.params.id);
    res.json({ room: publicRoom(room) });
  });

  r.post('/rooms/:id/join', auth, joinLimit, async (req, res) => {
    const { room, credentials } = await rooms.join(req.guest, req.params.id);
    res.set('Cache-Control', 'no-store').json({ room: publicRoom(room), credentials });
  });

  // A fresh token for someone already in the room, when the SDK's tokenExpiring asks for one.
  r.post('/rooms/:id/token', auth, joinLimit, async (req, res) => {
    const { credentials } = await rooms.issueToken(req.guest, req.params.id);
    res.set('Cache-Control', 'no-store').json({ credentials });
  });

  r.post('/rooms/:id/end', auth, async (req, res) => {
    await rooms.end(req.guest, req.params.id);
    res.status(204).end();
  });

  r.post('/rooms/:id/bans', auth, async (req, res) => {
    const { identity } = BanBody.parse(req.body);
    await rooms.ban(req.guest, req.params.id, identity);
    res.status(204).end();
  });

  r.get('/gifts', auth, async (_req, res) => {
    const gifts = await Gift.find({ active: true }).sort({ order: 1 });
    res.json({
      gifts: gifts.map((g) => ({ id: g._id, name: g.name, price: g.price, tier: g.tier, svgaUrl: g.svgaUrl, icon: g.icon })),
      demoCoins: true,
    });
  });

  // The server settles a gift and announces it: a client-sent gift could claim anything.
  r.post('/rooms/:id/gifts', auth, giftLimit, async (req, res) => {
    const { giftId, to, count } = GiftBody.parse(req.body);
    const room = await rooms.loadLive(req.params.id);
    const [gift, recipient] = await Promise.all([Gift.findOne({ _id: giftId, active: true }), Guest.findById(to)]);
    if (!gift) throw new AppError(404, 'not-found', 'That gift is not available.');
    if (!recipient) throw new AppError(404, 'not-found', 'That person has left.');

    const coins = gift.price * count;
    const sender = await Guest.findOneAndUpdate(
      { _id: req.guest._id, coins: mongoose.trusted({ $gte: coins }) },
      { $inc: { coins: -coins } },
      { returnDocument: 'after' },
    );
    if (!sender) throw new AppError(402, 'not-enough-coins', 'You need more demo coins for that gift.');

    const updated = await Room.findByIdAndUpdate(room._id, { $inc: { giftCoins: coins } }, { returnDocument: 'after' });

    try {
      await rtc.sendMessage({
        channel: room._id,
        type: 'gift',
        from: sender._id,
        metadata: {
          giftId: gift._id,
          giftName: gift.name,
          tier: gift.tier,
          svgaUrl: gift.svgaUrl,
          icon: gift.icon,
          count,
          coins,
          fromName: sender.name,
          toId: recipient._id,
          toName: recipient.name,
          roomCoins: updated.giftCoins,
        },
      });
    } catch (err) {
      // Nobody saw it, so it was not sent.
      await Promise.all([
        Guest.updateOne({ _id: sender._id }, { $inc: { coins } }),
        Room.updateOne({ _id: room._id }, { $inc: { giftCoins: -coins } }),
      ]);
      throw err;
    }

    await Promise.all([
      GiftEvent.create({ roomId: room._id, from: sender._id, to: recipient._id, giftId: gift._id, count, coins }),
      Guest.updateOne({ _id: recipient._id }, { $inc: { giftsReceived: count } }),
    ]);
    res.json({ guest: privateGuest(sender) });
  });

  return r;
}
