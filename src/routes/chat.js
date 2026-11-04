import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { conversationId } from '../util.js';
import { Conversation, Message } from '../models/Conversation.js';
import { Guest, publicGuest, isRestricted } from '../models/Guest.js';
import { requireGuest } from '../middleware/auth.js';
import { limiter } from '../middleware/limits.js';

export const LOUNGE_CHANNEL = 'public-lounge';

const StartBody = z.object({ peerId: z.string().min(1).max(64) });
const SendBody = z.object({ text: z.string().trim().min(1).max(1000), clientMsgId: z.string().max(64).optional() });
const HistoryQuery = z.object({ before: z.iso.datetime().optional() });

const publicMessage = (m) => ({ id: String(m._id), from: m.from, text: m.text, at: m.createdAt });

export function chatRoutes({ config, rtc, send }) {
  const r = Router();
  const auth = requireGuest(config);
  const tokenLimit = limiter(config, { windowMs: 60_000, limit: 30 });
  const messageLimit = limiter(config, { windowMs: 60_000, limit: 60 });

  async function peersById(ids) {
    const guests = await Guest.find({ _id: mongoose.trusted({ $in: ids }) });
    return new Map(guests.map((g) => [g._id, publicGuest(g)]));
  }

  async function loadConversation(req) {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation?.members.includes(req.guest._id)) throw new AppError(404, 'not-found', 'Conversation not found.');
    return conversation;
  }

  const describe = (conversation, me, peers) => {
    const peerId = conversation.members.find((m) => m !== me) ?? me;
    return {
      id: conversation._id,
      peer: peers.get(peerId) ?? { id: peerId, name: 'Guest', avatar: 'a01', frame: 'none' },
      last: conversation.last?.at ? conversation.last : null,
      unread: conversation.unread?.get(me) ?? 0,
      updatedAt: conversation.updatedAt,
    };
  };

  // The public lounge is a VoltKit chat channel with no room behind it.
  r.post('/chat/lounge/token', auth, tokenLimit, async (req, res) => {
    if (isRestricted(req.guest)) throw new AppError(403, 'restricted', 'Your account is restricted after reports from other people.');
    const { token, wsUrl, expiresAt } = await rtc.createChatToken({ channel: LOUNGE_CHANNEL, identity: req.guest._id });
    res.set('Cache-Control', 'no-store').json({ channel: LOUNGE_CHANNEL, token, wsUrl, expiresAt });
  });

  r.get('/conversations', auth, async (req, res) => {
    const list = await Conversation.find({ members: req.guest._id }).sort({ updatedAt: -1 }).limit(50);
    const peers = await peersById(list.flatMap((c) => c.members));
    const blocked = new Set(req.guest.blocked);
    res.json({
      conversations: list
        .map((c) => describe(c, req.guest._id, peers))
        .filter((c) => !blocked.has(c.peer.id)),
    });
  });

  r.post('/conversations', auth, tokenLimit, async (req, res) => {
    const { peerId } = StartBody.parse(req.body);
    if (peerId === req.guest._id) throw new AppError(400, 'bad-request', 'You cannot message yourself.');
    const peer = await Guest.findById(peerId);
    if (!peer) throw new AppError(404, 'not-found', 'This guest no longer exists.');
    if (peer.blocked.includes(req.guest._id) || req.guest.blocked.includes(peerId)) {
      throw new AppError(403, 'blocked', 'You cannot message this person.');
    }
    const id = conversationId(req.guest._id, peerId);
    const conversation = await Conversation.findByIdAndUpdate(
      id,
      { $setOnInsert: { members: [req.guest._id, peerId] } },
      { upsert: true, returnDocument: 'after' },
    );
    const peers = await peersById([peerId]);
    res.status(201).json({ conversation: describe(conversation, req.guest._id, peers) });
  });

  // History from Mongo, and a token for this one channel so new messages arrive live.
  r.get('/conversations/:id', auth, tokenLimit, async (req, res) => {
    const conversation = await loadConversation(req);
    const { before } = HistoryQuery.parse(req.query);
    const filter = { conversationId: conversation._id, ...(before ? { createdAt: mongoose.trusted({ $lt: new Date(before) }) } : {}) };
    const [messages, peers, chat] = await Promise.all([
      Message.find(filter).sort({ createdAt: -1 }).limit(40),
      peersById(conversation.members),
      rtc.createChatToken({ channel: conversation._id, identity: req.guest._id }),
    ]);
    res.set('Cache-Control', 'no-store').json({
      conversation: describe(conversation, req.guest._id, peers),
      messages: messages.map(publicMessage),
      chat: { channel: conversation._id, token: chat.token, wsUrl: chat.wsUrl, expiresAt: chat.expiresAt },
    });
  });

  // Sent through here so that blocks hold and the conversation is kept. VoltKit carries it to the other side.
  r.post('/conversations/:id/messages', auth, messageLimit, async (req, res) => {
    const conversation = await loadConversation(req);
    const { text, clientMsgId } = SendBody.parse(req.body);
    const me = req.guest._id;
    const peerId = conversation.members.find((m) => m !== me);
    const peer = await Guest.findById(peerId);
    if (!peer || peer.blocked.includes(me) || req.guest.blocked.includes(peerId)) {
      throw new AppError(403, 'blocked', 'You cannot message this person.');
    }
    if (isRestricted(req.guest)) throw new AppError(403, 'restricted', 'Your account is restricted after reports from other people.');

    const message = await Message.create({ conversationId: conversation._id, from: me, text });
    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { last: { text: text.slice(0, 120), from: me, at: message.createdAt } }, $inc: { [`unread.${peerId}`]: 1 } },
    );

    await rtc
      .sendMessage({ channel: conversation._id, from: me, text, metadata: { messageId: String(message._id), clientMsgId } })
      .catch((err) => console.warn('dm delivery failed; it is kept in history:', err.message));

    send(peerId, 'dm:new', { conversationId: conversation._id });
    res.status(201).json({ message: publicMessage(message) });
  });

  r.post('/conversations/:id/read', auth, async (req, res) => {
    const conversation = await loadConversation(req);
    await Conversation.updateOne({ _id: conversation._id }, { $set: { [`unread.${req.guest._id}`]: 0 } });
    res.status(204).end();
  });

  return r;
}
