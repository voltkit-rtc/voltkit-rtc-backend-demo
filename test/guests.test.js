import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Guest } from '../src/models/Guest.js';
import { Report } from '../src/models/Report.js';
import { config, makeApp, reset, setup, teardown } from './helpers.js';

describe('guests', () => {
  let t;
  before(async () => {
    await setup();
    t = await makeApp();
  });
  beforeEach(reset);
  after(async () => {
    await t.close();
    await teardown();
  });

  it('needs no sign-in, only a name, an avatar and the 18+ confirmation', async () => {
    const res = await t.call('POST', '/v1/guests', { body: { name: 'Asha', avatar: 'a03', ageConfirmed: true } });
    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.equal(res.body.guest.coins, config.startingCoins);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('refuses anyone who has not confirmed they are 18 or older', async () => {
    for (const ageConfirmed of [false, undefined, 'true']) {
      const res = await t.call('POST', '/v1/guests', { body: { name: 'Kid', avatar: 'a01', ageConfirmed } });
      assert.equal(res.status, 400, `ageConfirmed=${ageConfirmed}`);
    }
  });

  it('validates names', async () => {
    for (const name of ['x', ' ', 'a'.repeat(25), 'bad\u0000name', 'bad‮name']) {
      const res = await t.call('POST', '/v1/guests', { body: { name, avatar: 'a01', ageConfirmed: true } });
      assert.equal(res.status, 400, JSON.stringify(name));
    }
  });

  it('rejects a missing or forged token', async () => {
    assert.equal((await t.call('GET', '/v1/me')).status, 401);
    assert.equal((await t.call('GET', '/v1/me', { token: 'forged' })).status, 401);
  });

  it('updates a profile, but never coins through that route', async () => {
    const me = await t.guest();
    const res = await t.call('PATCH', '/v1/me', { token: me.token, body: { name: 'Ashika', frame: 'lion', coins: 999999 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.guest.name, 'Ashika');
    assert.equal(res.body.guest.frame, 'lion');
    assert.equal(res.body.guest.coins, config.startingCoins);
  });

  it('tops up demo coins, up to a ceiling', async () => {
    const me = await t.guest();
    const res = await t.call('POST', '/v1/me/coins/topup', { token: me.token });
    assert.equal(res.body.guest.coins, config.startingCoins + config.topupCoins);
    await Guest.updateOne({ _id: me.id }, { coins: config.maxCoins });
    assert.equal((await t.call('POST', '/v1/me/coins/topup', { token: me.token })).status, 400);
  });

  it('deletes a guest and their token stops working', async () => {
    const me = await t.guest();
    const peer = await t.guest('Ravi');
    await t.call('POST', '/v1/conversations', { token: me.token, body: { peerId: peer.id } });
    assert.equal((await t.call('DELETE', '/v1/me', { token: me.token })).status, 204);
    assert.equal((await t.call('GET', '/v1/me', { token: me.token })).status, 401);
    assert.equal((await t.call('GET', '/v1/conversations', { token: peer.token })).body.conversations.length, 0);
  });

  it('blocks and unblocks', async () => {
    const me = await t.guest();
    const other = await t.guest('Ravi');
    await t.call('POST', `/v1/blocks/${other.id}`, { token: me.token });
    let list = await t.call('GET', '/v1/blocks', { token: me.token });
    assert.deepEqual(list.body.guests.map((g) => g.id), [other.id]);
    await t.call('DELETE', `/v1/blocks/${other.id}`, { token: me.token });
    list = await t.call('GET', '/v1/blocks', { token: me.token });
    assert.equal(list.body.guests.length, 0);
    assert.equal((await t.call('POST', `/v1/blocks/${me.id}`, { token: me.token })).status, 400);
  });

  it('counts one report per person a day', async () => {
    const me = await t.guest();
    const other = await t.guest('Ravi');
    await t.call('POST', '/v1/reports', { token: me.token, body: { target: other.id, reason: 'spam' } });
    const again = await t.call('POST', '/v1/reports', { token: me.token, body: { target: other.id, reason: 'spam' } });
    assert.equal(again.body.alreadyReported, true);
    assert.equal(await Report.countDocuments(), 1);
  });

  it('restricts an account once enough different people report it, and it can then not go live', async () => {
    const target = await t.guest('Troll');
    for (let i = 0; i < config.reportsToRestrict; i++) {
      const reporter = await t.guest(`Reporter ${i}`);
      await t.call('POST', '/v1/reports', { token: reporter.token, body: { target: target.id, reason: 'harassment' } });
    }
    const me = await t.call('GET', '/v1/me', { token: target.token });
    assert.equal(me.body.guest.restricted, true);
    const res = await t.call('POST', '/v1/rooms', { token: target.token, body: { type: 'video', title: 'Spam', seats: 6 } });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'restricted');
  });
});
