import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { newId } from '../util.js';
import { Guest, publicGuest, privateGuest } from '../models/Guest.js';
import { Report, REPORT_REASONS } from '../models/Report.js';
import { Conversation, Message } from '../models/Conversation.js';
import { Room } from '../models/Room.js';
import { requireGuest, signGuestToken } from '../middleware/auth.js';
import { limiter } from '../middleware/limits.js';
import { deleteRoomQuietly } from '../services/rtc.js';

const CONTROL = /[\p{Cc}\p{Cf}]/u;
const Name = z
  .string()
  .trim()
  .min(2, 'Pick a name of at least 2 characters.')
  .max(24, 'Pick a shorter name.')
  .refine((s) => !CONTROL.test(s), 'That name has characters we cannot show.');
const AvatarKey = z.string().regex(/^a\d{2}$/, 'Pick an avatar from the list.');

const CreateGuest = z.object({
  name: Name,
  avatar: AvatarKey,
  ageConfirmed: z.literal(true, { error: 'You must be 18 or older to use this app.' }),
});

const UpdateMe = z
  .object({ name: Name, avatar: AvatarKey, frame: z.enum(['none', 'lion', 'wolf']) })
  .partial();

const CreateReport = z.object({
  target: z.string().min(1).max(64),
  roomId: z.string().max(64).optional(),
  reason: z.enum(REPORT_REASONS),
  note: z.string().trim().max(280).optional(),
});

export function guestRoutes({ config, rtc }) {
  const r = Router();
  const auth = requireGuest(config);
  const createLimit = limiter(config, { windowMs: 60 * 60_000, limit: 20 });
  const writeLimit = limiter(config, { windowMs: 60_000, limit: 30 });
  const topupLimit = limiter(config, { windowMs: 60_000, limit: 10 });

  // No sign-in: a guest is made on first open, and the app keeps this token.
  r.post('/guests', createLimit, async (req, res) => {
    const body = CreateGuest.parse(req.body);
    const guest = await Guest.create({
      _id: newId('g'),
      name: body.name,
      avatar: body.avatar,
      coins: config.startingCoins,
      ageConfirmedAt: new Date(),
    });
    res.status(201).set('Cache-Control', 'no-store').json({ token: signGuestToken(config, guest._id), guest: privateGuest(guest) });
  });

  r.get('/me', auth, async (req, res) => {
    await Guest.updateOne({ _id: req.guest._id }, { $set: { lastSeenAt: new Date() } });
    res.json({ guest: privateGuest(req.guest) });
  });

  r.patch('/me', auth, writeLimit, async (req, res) => {
    const patch = UpdateMe.parse(req.body);
    const guest = await Guest.findByIdAndUpdate(req.guest._id, { $set: patch }, { returnDocument: 'after' });
    res.json({ guest: privateGuest(guest) });
  });

  // Fictional coins for trying gifts. No payment and nothing to cash out.
  r.post('/me/coins/topup', auth, topupLimit, async (req, res) => {
    const guest = await Guest.findOneAndUpdate(
      { _id: req.guest._id, coins: mongoose.trusted({ $lte: config.maxCoins - config.topupCoins }) },
      { $inc: { coins: config.topupCoins } },
      { returnDocument: 'after' },
    );
    if (!guest) throw new AppError(400, 'coins-full', 'You have plenty of demo coins already.');
    res.json({ guest: privateGuest(guest) });
  });

  // Everything held about a guest goes, on their say-so.
  r.delete('/me', auth, writeLimit, async (req, res) => {
    const id = req.guest._id;
    const rooms = await Room.find({ 'host.id': id, status: 'live' });
    await Promise.all(rooms.map((room) => deleteRoomQuietly(rtc, room._id).catch(() => {})));
    await Room.updateMany({ 'host.id': id, status: 'live' }, { $set: { status: 'ended', endedAt: new Date() } });
    const conversations = await Conversation.find({ members: id }).select('_id');
    const ids = conversations.map((c) => c._id);
    await Promise.all([
      Message.deleteMany({ conversationId: mongoose.trusted({ $in: ids }) }),
      Conversation.deleteMany({ _id: mongoose.trusted({ $in: ids }) }),
      Guest.deleteOne({ _id: id }),
    ]);
    res.status(204).end();
  });

  r.get('/guests/:id', auth, async (req, res) => {
    const guest = await Guest.findById(req.params.id);
    if (!guest) throw new AppError(404, 'not-found', 'This guest no longer exists.');
    res.json({ guest: { ...publicGuest(guest), giftsReceived: guest.giftsReceived }, blockedByMe: req.guest.blocked.includes(guest._id) });
  });

  r.get('/blocks', auth, async (req, res) => {
    const guests = await Guest.find({ _id: mongoose.trusted({ $in: req.guest.blocked }) });
    res.json({ guests: guests.map(publicGuest) });
  });

  r.post('/blocks/:id', auth, writeLimit, async (req, res) => {
    if (req.params.id === req.guest._id) throw new AppError(400, 'bad-request', 'You cannot block yourself.');
    await Guest.updateOne({ _id: req.guest._id }, { $addToSet: { blocked: req.params.id } });
    res.status(204).end();
  });

  r.delete('/blocks/:id', auth, writeLimit, async (req, res) => {
    await Guest.updateOne({ _id: req.guest._id }, { $pull: { blocked: req.params.id } });
    res.status(204).end();
  });

  r.post('/reports', auth, writeLimit, async (req, res) => {
    const body = CreateReport.parse(req.body);
    if (body.target === req.guest._id) throw new AppError(400, 'bad-request', 'You cannot report yourself.');

    const since = new Date(Date.now() - 24 * 3600_000);
    const repeat = await Report.exists({ reporter: req.guest._id, target: body.target, createdAt: mongoose.trusted({ $gte: since }) });
    if (repeat) return res.status(202).json({ ok: true, alreadyReported: true });

    await Report.create({ ...body, reporter: req.guest._id });

    // Enough different people in a day limits the account until someone has looked at it.
    const reporters = await Report.distinct('reporter', { target: body.target, createdAt: mongoose.trusted({ $gte: since }) });
    if (reporters.length >= config.reportsToRestrict) {
      await Guest.updateOne({ _id: body.target }, { $set: { restrictedUntil: new Date(Date.now() + 24 * 3600_000) } });
    }
    res.status(202).json({ ok: true });
  });

  return r;
}
