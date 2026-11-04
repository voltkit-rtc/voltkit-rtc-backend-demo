import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config, makeApp, reset, setup, teardown } from './helpers.js';

describe('security', () => {
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

  it('never returns the API secret or a Mongo address', async () => {
    const me = await t.guest();
    const room = await t.room(me);
    for (const path of ['/v1/rooms', `/v1/rooms/${room.id}`, '/v1/me', '/v1/gifts', '/v1/voltkit', '/health']) {
      const { text } = await t.call('GET', path, { token: me.token });
      assert.ok(!text.includes(config.rtcSecret), path);
      assert.ok(!text.includes('mongodb://'), path);
    }
  });

  it('does not list who is banned from a room', async () => {
    const host = await t.guest();
    const room = await t.room(host);
    await t.call('POST', `/v1/rooms/${room.id}/bans`, { token: host.token, body: { identity: 'g_someone' } });
    const { text } = await t.call('GET', `/v1/rooms/${room.id}`, { token: host.token });
    assert.ok(!text.includes('g_someone'));
  });

  it('turns query operators into plain values', async () => {
    const me = await t.guest();
    // Express 5 does not expand brackets in a query string, so this is an unknown key and nothing more.
    const res = await t.call('GET', '/v1/rooms?type[$ne]=video', { token: me.token });
    assert.equal(res.status, 200);
    const peer = await t.call('POST', '/v1/conversations', { token: me.token, body: { peerId: { $ne: null } } });
    assert.equal(peer.status, 400);
    const gift = await t.call('POST', '/v1/rooms/r_x/gifts', { token: me.token, body: { giftId: { $gt: '' }, to: 'x' } });
    assert.equal(gift.status, 400);
  });

  it('refuses malformed and oversized JSON without a stack trace', async () => {
    const bad = await t.call('POST', '/v1/guests', { raw: '{not json' });
    assert.equal(bad.status, 400);
    assert.ok(!/\n\s+at /.test(bad.text));
    const big = await t.call('POST', '/v1/guests', { body: { name: 'x'.repeat(20_000), avatar: 'a01', ageConfirmed: true } });
    assert.equal(big.status, 400);
  });

  it('sets the usual headers and hides the framework', async () => {
    const res = await t.call('GET', '/health');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  it('does not let a path escape the static folder', async () => {
    const res = await t.call('GET', '/static/..%2f.env');
    assert.notEqual(res.status, 200);
    assert.ok(!res.text.includes('VOLTKIT'));
  });

  it('limits how fast guests can be made', async () => {
    const strict = await makeApp({ rateScale: 1 });
    let last;
    for (let i = 0; i < 21; i++) {
      last = await strict.call('POST', '/v1/guests', { body: { name: 'Spammer', avatar: 'a01', ageConfirmed: true } });
    }
    assert.equal(last.status, 429);
    assert.equal(last.body.error.code, 'rate-limited');
    await strict.close();
  });

  it('counts per guest once signed in, so one guest cannot use up a neighbour\'s allowance', async () => {
    const strict = await makeApp({ rateScale: 1 });
    const a = await strict.guest('Asha');
    const b = await strict.guest('Ravi');
    let last;
    for (let i = 0; i < 11; i++) last = await strict.call('POST', '/v1/me/coins/topup', { token: a.token });
    assert.equal(last.status, 429);
    assert.equal((await strict.call('POST', '/v1/me/coins/topup', { token: b.token })).status, 200);
    await strict.close();
  });

  it('reports published prices, and none when they cannot be read', async () => {
    const me = await t.guest();
    const res = await t.call('GET', '/v1/voltkit', { token: me.token });
    assert.deepEqual([res.body.rates.audio, res.body.rates.video], ['39.00', '99.00']);
    const down = await makeApp();
    down.rtc.getRates = async () => {
      throw new Error('down');
    };
    const none = await down.call('GET', '/v1/voltkit', { token: (await down.guest()).token });
    assert.equal(none.body.rates, null);
    await down.close();
  });
});
