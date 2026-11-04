import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Guest } from '../src/models/Guest.js';
import { GiftEvent } from '../src/models/GiftEvent.js';
import { Gift } from '../src/models/Gift.js';
import { Room } from '../src/models/Room.js';
import { config, makeApp, reset, setup, teardown } from './helpers.js';

describe('gifts', () => {
  let t, sender, host, room;
  const send = (body, token = sender.token) => t.call('POST', `/v1/rooms/${room.id}/gifts`, { token, body });

  before(async () => {
    await setup();
    t = await makeApp();
  });
  beforeEach(async () => {
    await reset();
    t.rtc.rooms.clear();
    t.rtc.messages = [];
    host = await t.guest('Host');
    sender = await t.guest('Ravi');
    room = await t.room(host);
  });
  after(async () => {
    await t.close();
    await teardown();
  });

  it('lists the catalog as demo coins', async () => {
    const res = await t.call('GET', '/v1/gifts', { token: sender.token });
    assert.equal(res.body.demoCoins, true);
    assert.ok(res.body.gifts.length > 0);
    assert.ok(res.body.gifts.every((g) => g.svgaUrl && g.price >= 0));
  });

  it('takes the coins, tells the room and keeps a record', async () => {
    const res = await send({ giftId: 'rose', to: host.id, count: 3 });
    assert.equal(res.status, 200);
    assert.equal(res.body.guest.coins, config.startingCoins - 60);
    const [message] = t.rtc.messages;
    assert.equal(message.type, 'gift');
    assert.equal(message.from, sender.id);
    assert.equal(message.channel, room.id);
    assert.equal(message.metadata.toName, 'Host');
    assert.equal(message.metadata.coins, 60);
    assert.equal(await GiftEvent.countDocuments({ roomId: room.id }), 1);
    assert.equal((await Room.findById(room.id)).giftCoins, 60);
    assert.equal((await Guest.findById(host.id)).giftsReceived, 3);
  });

  it('prices from the catalog, whatever the client claims', async () => {
    const res = await send({ giftId: 'rose', to: host.id, count: 1, price: 0, coins: 0 });
    assert.equal(res.body.guest.coins, config.startingCoins - 20);
  });

  it('refuses when there are not enough coins and takes nothing', async () => {
    await Guest.updateOne({ _id: sender.id }, { coins: 5 });
    const res = await send({ giftId: 'rose', to: host.id });
    assert.equal(res.status, 402);
    assert.equal(res.body.error.code, 'not-enough-coins');
    assert.equal((await Guest.findById(sender.id)).coins, 5);
    assert.equal(t.rtc.messages.length, 0);
  });

  it('cannot spend the same coins twice at once', async () => {
    await Guest.updateOne({ _id: sender.id }, { coins: 100 });
    const results = await Promise.all(Array.from({ length: 12 }, () => send({ giftId: 'rose', to: host.id })));
    assert.equal(results.filter((r) => r.status === 200).length, 5);
    assert.equal((await Guest.findById(sender.id)).coins, 0);
  });

  it('gives the coins back when the announcement fails', async () => {
    t.rtc.failNextMessage = true;
    const res = await send({ giftId: 'ring', to: host.id });
    assert.equal(res.status, 503);
    assert.equal((await Guest.findById(sender.id)).coins, config.startingCoins);
    assert.equal((await Room.findById(room.id)).giftCoins, 0);
    assert.equal(await GiftEvent.countDocuments(), 0);
  });

  it('lets you send a gift to yourself, paid for like any other', async () => {
    const res = await send({ giftId: 'rose', to: sender.id, count: 2 });
    assert.equal(res.status, 200);
    assert.equal(res.body.guest.coins, config.startingCoins - 40);
    assert.equal(t.rtc.messages[0].metadata.toName, 'Ravi');
    assert.equal((await Guest.findById(sender.id)).giftsReceived, 2);
  });

  it('refuses an unknown gift, an unknown person and silly counts', async () => {
    assert.equal((await send({ giftId: 'nope', to: host.id })).status, 404);
    assert.equal((await send({ giftId: 'rose', to: 'g_nobody' })).status, 404);
    assert.equal((await send({ giftId: 'rose', to: host.id, count: 0 })).status, 400);
    assert.equal((await send({ giftId: 'rose', to: host.id, count: -5 })).status, 400);
    assert.equal((await send({ giftId: 'rose', to: host.id, count: 1.5 })).status, 400);
    assert.equal((await Guest.findById(sender.id)).coins, config.startingCoins);
  });

  it('refuses gifts to a room that has ended', async () => {
    await t.call('POST', `/v1/rooms/${room.id}/end`, { token: host.token });
    assert.equal((await send({ giftId: 'rose', to: host.id })).status, 410);
  });

  it('keeps an edited animation URL through a re-seed', async () => {
    await Gift.updateOne({ _id: 'rose' }, { svgaUrl: 'https://cdn.example/rose.svga' });
    const { seedGifts } = await import('../src/db.js');
    await seedGifts();
    assert.equal((await Gift.findById('rose')).svgaUrl, 'https://cdn.example/rose.svga');
  });
});
