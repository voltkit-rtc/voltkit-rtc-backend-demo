import http from 'node:http';
import mongoose from 'mongoose';
import { StreamError } from '@voltkit-rtc/server';
import { loadConfig } from '../src/config.js';
import { connectDb, seedGifts } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createRoomService } from '../src/services/rooms.js';

export const config = loadConfig();

/** Stands in for VoltKit: holds rooms and participants in memory and records what was asked of it. */
export class FakeRtc {
  rooms = new Map();
  messages = [];
  failNextMessage = false;
  tokens = [];

  notFound() {
    return new StreamError('no-room', 404, 'room not found', false);
  }
  async ensureRoom({ roomId, hostIdentity, metadata }) {
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, { roomId, hostIdentity, metadata, participants: [] });
    return { roomId, hostToken: `host-token-${roomId}`, wsUrl: 'wss://fake/ws', expiresAt: 1, existed: false };
  }
  async createToken({ roomId, identity, role }) {
    if (!this.rooms.has(roomId)) throw this.notFound();
    this.tokens.push({ roomId, identity, role });
    return { token: `token-${identity}-${role}`, wsUrl: 'wss://fake/ws', role, identity, roomId, expiresAt: 1 };
  }
  async createChatToken({ channel, identity }) {
    return { token: `chat-${identity}`, wsUrl: 'wss://fake/ws/chat', channel, identity, role: 'viewer', expiresAt: 1 };
  }
  async listParticipants(roomId) {
    if (!this.rooms.has(roomId)) throw this.notFound();
    return this.rooms.get(roomId).participants;
  }
  async listRooms() {
    return {
      rooms: [...this.rooms.values()].map((r) => ({ roomId: r.roomId, participants: r.participants.length, metadata: r.metadata })),
    };
  }
  async deleteRoom(roomId) {
    if (!this.rooms.delete(roomId)) throw this.notFound();
  }
  async sendMessage(message) {
    if (this.failNextMessage) {
      this.failNextMessage = false;
      throw new StreamError('unavailable', 503, 'down', true);
    }
    this.messages.push(message);
    return { id: String(this.messages.length) };
  }
  async getBalance() {
    return { canJoin: true };
  }
  async getRates() {
    return { tiers: [{ id: 'audio_std', credits: '39.00' }, { id: 'video_30', credits: '99.00' }] };
  }
  /** Test helper: puts someone in a room as the service would report them. */
  seat(roomId, identity, role) {
    this.rooms.get(roomId).participants.push({ identity, role });
  }
}

export async function setup() {
  await connectDb(config.mongoUri);
}

export async function teardown() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

export async function reset() {
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  await seedGifts();
}

/** A running app with a fake RTC. Uses a real HTTP server, so requests pass through everything. */
export async function makeApp(overrides = {}) {
  const rtc = new FakeRtc();
  const sent = [];
  const cfg = { ...config, ...overrides };
  const rooms = createRoomService({ config: cfg, rtc, canGoLive: overrides.canGoLive ?? (async () => true), onRoomsChanged: () => {} });
  const app = createApp({ config: cfg, rtc, rooms, send: (to, event, payload) => sent.push({ to, event, payload }) });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { token, body, raw } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, text };
  }

  const guest = async (name = 'Asha', avatar = 'a01') => {
    const res = await call('POST', '/v1/guests', { body: { name, avatar, ageConfirmed: true } });
    return { token: res.body.token, id: res.body.guest.id, guest: res.body.guest };
  };

  const room = async (owner, body = {}) => {
    const res = await call('POST', '/v1/rooms', {
      token: owner.token,
      body: { type: 'video', title: 'Friday night', seats: 6, ...body },
    });
    return res.body.room;
  };

  return { rtc, sent, rooms, call, guest, room, close: () => new Promise((resolve) => server.close(resolve)) };
}
