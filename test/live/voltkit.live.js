// Run with `npm run test:live`. Talks to the real service using the credentials in .env.
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { createRtc } from '../../src/services/rtc.js';

const rtc = createRtc(loadConfig());
const roomId = `live-check-${Date.now()}`;

const usage = await rtc.getUsage();
console.log('usage ok, minutes remaining:', usage.minutesRemaining);

const room = await rtc.ensureRoom({ roomId, hostIdentity: 'check-host', metadata: { type: 'video' } });
assert.ok(room.hostToken && room.wsUrl);
const token = await rtc.createToken({ roomId, identity: 'check-viewer', role: 'viewer' });
assert.equal(token.role, 'viewer');
const chat = await rtc.createChatToken({ channel: 'public-lounge', identity: 'check-viewer' });
assert.ok(chat.wsUrl.includes('chat'));
const message = await rtc.sendMessage({ channel: roomId, type: 'gift', from: 'check-host', metadata: { giftId: 'rose' } });
assert.ok(message.id);
const { rooms } = await rtc.listRooms();
assert.ok(rooms.some((r) => r.roomId === roomId));
const rates = await rtc.getRates();
assert.ok(rates.tiers.some((t) => t.id === 'audio_std'));
await rtc.deleteRoom(roomId);
console.log('live check passed');
