import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/models/Room.js';
import { config, makeApp, reset, setup, teardown } from './helpers.js';

describe('rooms', () => {
  let t;
  before(async () => {
    await setup();
    t = await makeApp();
  });
  beforeEach(async () => {
    await reset();
    t.rtc.rooms.clear();
    t.rtc.tokens = [];
    t.rtc.messages = [];
  });
  after(async () => {
    await t.close();
    await teardown();
  });

  it('creates a room and returns a host token', async () => {
    const host = await t.guest();
    const res = await t.call('POST', '/v1/rooms', { token: host.token, body: { type: 'audio', title: 'Late night', seats: 10 } });
    assert.equal(res.status, 201);
    assert.equal(res.body.credentials.role, 'host');
    assert.ok(t.rtc.rooms.has(res.body.room.id));
    assert.equal(res.body.room.host.id, host.id);
  });

  it('refuses seat counts that do not belong to the room type', async () => {
    const host = await t.guest();
    const res = await t.call('POST', '/v1/rooms', { token: host.token, body: { type: 'audio', title: 'Late night', seats: 6 } });
    assert.equal(res.status, 400);
  });

  it('replaces the guest\'s last room when they go live again', async () => {
    const host = await t.guest();
    const first = await t.room(host);
    const second = await t.room(host);
    assert.notEqual(first.id, second.id);
    assert.equal(t.rtc.rooms.has(first.id), false);
    const live = await t.call('GET', '/v1/rooms', { token: host.token });
    assert.deepEqual(live.body.rooms.map((r) => r.id), [second.id]);
  });

  it('stops at the live room ceiling', async () => {
    const small = await makeApp({ maxLiveRooms: 1 });
    await small.room(await small.guest('One'));
    const res = await small.call('POST', '/v1/rooms', {
      token: (await small.guest('Two')).token,
      body: { type: 'video', title: 'Second room', seats: 4 },
    });
    assert.equal(res.status, 429);
    await small.close();
  });

  it('says so when the project cannot go live', async () => {
    const broke = await makeApp({ canGoLive: async () => false });
    const res = await broke.call('POST', '/v1/rooms', {
      token: (await broke.guest()).token,
      body: { type: 'video', title: 'No credit', seats: 4 },
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'rtc-unavailable');
    await broke.close();
  });

  it('lets a viewer in as a viewer, however they ask', async () => {
    const host = await t.guest();
    const viewer = await t.guest('Ravi');
    const room = await t.room(host);
    const res = await t.call('POST', `/v1/rooms/${room.id}/join`, { token: viewer.token, body: { role: 'host' } });
    assert.equal(res.body.credentials.role, 'viewer');
  });

  it('gives the host a host token when they rejoin', async () => {
    const host = await t.guest();
    const room = await t.room(host);
    const res = await t.call('POST', `/v1/rooms/${room.id}/join`, { token: host.token });
    assert.equal(res.body.credentials.role, 'host');
  });

  it('refreshes a token with the role held now', async () => {
    const host = await t.guest();
    const cohost = await t.guest('Ravi');
    const room = await t.room(host);
    t.rtc.seat(room.id, cohost.id, 'cohost');
    const res = await t.call('POST', `/v1/rooms/${room.id}/token`, { token: cohost.token });
    assert.equal(res.body.credentials.role, 'cohost');
  });

  it('announces a framed guest\'s entrance, from the server', async () => {
    const host = await t.guest();
    const fancy = await t.guest('Ravi');
    await t.call('PATCH', '/v1/me', { token: fancy.token, body: { frame: 'wolf' } });
    const room = await t.room(host);
    await t.call('POST', `/v1/rooms/${room.id}/join`, { token: fancy.token });
    const entrance = t.rtc.messages.find((m) => m.type === 'entrance');
    assert.equal(entrance.metadata.identity, fancy.id);
    assert.equal(entrance.ephemeral, true);
  });

  it('answers 410 for a room that has ended', async () => {
    const host = await t.guest();
    const viewer = await t.guest('Ravi');
    const room = await t.room(host);
    await t.call('POST', `/v1/rooms/${room.id}/end`, { token: host.token });
    const res = await t.call('POST', `/v1/rooms/${room.id}/join`, { token: viewer.token });
    assert.equal(res.status, 410);
    assert.equal(res.body.error.code, 'room-ended');
  });

  it('marks a room ended when the service says it is gone', async () => {
    const host = await t.guest();
    const viewer = await t.guest('Ravi');
    const room = await t.room(host);
    t.rtc.rooms.delete(room.id);
    const res = await t.call('POST', `/v1/rooms/${room.id}/join`, { token: viewer.token });
    assert.equal(res.status, 410);
    assert.equal((await Room.findById(room.id)).status, 'ended');
  });

  it('only lets the host end a room', async () => {
    const host = await t.guest();
    const other = await t.guest('Ravi');
    const room = await t.room(host);
    assert.equal((await t.call('POST', `/v1/rooms/${room.id}/end`, { token: other.token })).status, 403);
    assert.equal((await t.call('POST', `/v1/rooms/${room.id}/end`, { token: host.token })).status, 204);
    assert.equal(t.rtc.rooms.has(room.id), false);
  });

  describe('removal', () => {
    let host, viewer, moderator, cohost, room;
    beforeEach(async () => {
      host = await t.guest('Host');
      viewer = await t.guest('Viewer');
      moderator = await t.guest('Mod');
      cohost = await t.guest('Cohost');
      room = await t.room(host);
      t.rtc.seat(room.id, host.id, 'host');
      t.rtc.seat(room.id, viewer.id, 'viewer');
      t.rtc.seat(room.id, moderator.id, 'moderator');
      t.rtc.seat(room.id, cohost.id, 'cohost');
    });

    const ban = (actor, identity) => t.call('POST', `/v1/rooms/${room.id}/bans`, { token: actor.token, body: { identity } });

    it('keeps a removed guest out', async () => {
      assert.equal((await ban(host, viewer.id)).status, 204);
      const res = await t.call('POST', `/v1/rooms/${room.id}/join`, { token: viewer.token });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'banned');
    });

    it('lets a moderator remove viewers but nobody else', async () => {
      assert.equal((await ban(moderator, viewer.id)).status, 204);
      assert.equal((await ban(moderator, cohost.id)).status, 403);
      assert.equal((await ban(moderator, host.id)).status, 403);
    });

    it('refuses viewers and co-hosts', async () => {
      assert.equal((await ban(viewer, cohost.id)).status, 403);
      assert.equal((await ban(cohost, viewer.id)).status, 403);
    });

    it('never lets anyone remove the host', async () => {
      assert.equal((await ban(host, host.id)).status, 403);
    });
  });

  describe('reconcile', () => {
    const age = (roomId, ms) => Room.collection.updateOne({ _id: roomId }, { $set: { createdAt: new Date(Date.now() - ms) } });

    it('takes live counts from the service', async () => {
      const host = await t.guest();
      const room = await t.room(host);
      t.rtc.seat(room.id, host.id, 'host');
      t.rtc.seat(room.id, 'g_other', 'viewer');
      await t.rooms.reconcile();
      const list = await t.call('GET', '/v1/rooms', { token: host.token });
      assert.equal(list.body.rooms[0].viewers, 2);
    });

    it('ends a room the service no longer has', async () => {
      const host = await t.guest();
      const room = await t.room(host);
      t.rtc.rooms.delete(room.id);
      await age(room.id, 60_000);
      await t.rooms.reconcile();
      assert.equal((await Room.findById(room.id)).status, 'ended');
    });

    it('does not end a room still starting up', async () => {
      const host = await t.guest();
      const room = await t.room(host);
      await t.rooms.reconcile();
      assert.equal((await Room.findById(room.id)).status, 'live');
    });

    it('ends a room everyone has left', async () => {
      const host = await t.guest();
      const room = await t.room(host);
      await age(room.id, config.roomStartGraceMs + 1000);
      await t.rooms.reconcile();
      assert.equal((await Room.findById(room.id)).status, 'ended');
      assert.equal(t.rtc.rooms.has(room.id), false);
    });

    it('ends a room whose host has been gone past the grace period', async () => {
      const host = await t.guest();
      const room = await t.room(host);
      t.rtc.seat(room.id, 'g_viewer', 'viewer');
      await age(room.id, config.roomStartGraceMs + 1000);
      await Room.updateOne({ _id: room.id }, { hostLastSeenAt: new Date(Date.now() - config.hostGraceMs - 1000) });
      for (let i = 0; i < 5; i++) await t.rooms.reconcile(); // the host check runs every fifth pass
      assert.equal((await Room.findById(room.id)).status, 'ended');
    });

    it('keeps a room while the host is there', async () => {
      const host = await t.guest();
      const room = await t.room(host);
      t.rtc.seat(room.id, host.id, 'host');
      await age(room.id, config.roomStartGraceMs + 1000);
      await Room.updateOne({ _id: room.id }, { hostLastSeenAt: new Date(Date.now() - config.hostGraceMs - 1000) });
      for (let i = 0; i < 5; i++) await t.rooms.reconcile();
      assert.equal((await Room.findById(room.id)).status, 'live');
    });
  });
});
