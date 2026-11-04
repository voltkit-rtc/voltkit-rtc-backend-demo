import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as connect } from 'socket.io-client';
import { Guest } from '../src/models/Guest.js';
import { createMatchmaker } from '../src/services/matchmaker.js';
import { createRealtime } from '../src/realtime/socket.js';
import { signGuestToken } from '../src/middleware/auth.js';
import { config, FakeRtc, reset, setup, teardown } from './helpers.js';

const guest = (id, extra = {}) => Guest.create({ _id: id, name: id, avatar: 'a01', ageConfirmedAt: new Date(), ...extra });

describe('1v1 matching', () => {
  let rtc, sent, match;
  const found = (id) => sent.filter((s) => s.to === id && s.event === 'match:found').map((s) => s.payload);

  before(setup);
  beforeEach(async () => {
    await reset();
    rtc = new FakeRtc();
    sent = [];
    match = createMatchmaker({ rtc, send: (to, event, payload) => sent.push({ to, event, payload }) });
  });
  after(teardown);

  it('waits alone, then pairs two people with a host and a co-host in one room', async () => {
    await Promise.all([guest('a'), guest('b')]);
    await match.join('a');
    assert.equal(found('a').length, 0);
    await match.join('b');
    const [a] = found('a');
    const [b] = found('b');
    assert.equal(a.callId, b.callId);
    assert.deepEqual([a.role, b.role], ['host', 'cohost']);
    assert.equal(a.peer.id, 'b');
    assert.equal(b.peer.id, 'a');
    assert.ok(rtc.rooms.has(a.callId));
    assert.equal(match.waitingCount(), 0);
  });

  it('never pairs people when either has blocked the other', async () => {
    await Promise.all([guest('a', { blocked: ['b'] }), guest('b'), guest('c')]);
    await match.join('a');
    await match.join('b');
    assert.equal(found('a').length, 0);
    await match.join('c');
    assert.equal(found('a')[0].peer.id, 'c');
    assert.equal(match.waitingCount(), 1);
  });

  it('does not hand back the same stranger when someone else is waiting', async () => {
    await Promise.all([guest('a'), guest('b'), guest('c')]);
    await match.join('a');
    await match.join('b');
    await match.end('a', found('a')[0].callId);
    await match.leave('a');
    sent = [];
    await match.join('c');
    await match.join('a');
    await match.join('b');
    const pairs = sent.filter((s) => s.event === 'match:found');
    assert.notEqual(pairs.find((s) => s.to === 'a').payload.peer.id, 'b');
  });

  it('pairs the same two again when nobody else is there', async () => {
    await Promise.all([guest('a'), guest('b')]);
    await match.join('a');
    await match.join('b');
    await match.end('a', found('a')[0].callId);
    await match.join('a');
    await match.join('b');
    assert.equal(found('a').length, 2);
  });

  it('tells the other side when a call ends and closes the room', async () => {
    await Promise.all([guest('a'), guest('b')]);
    await match.join('a');
    await match.join('b');
    const { callId } = found('a')[0];
    await match.end('a', callId);
    assert.ok(sent.some((s) => s.to === 'b' && s.event === 'match:ended' && s.payload.callId === callId));
    assert.equal(rtc.rooms.has(callId), false);
  });

  it('ignores someone ending a call they are not in', async () => {
    await Promise.all([guest('a'), guest('b'), guest('c')]);
    await match.join('a');
    await match.join('b');
    const { callId } = found('a')[0];
    await match.end('c', callId);
    assert.ok(rtc.rooms.has(callId));
    assert.ok(!sent.some((s) => s.event === 'match:ended'));
  });

  it('keeps a restricted account out', async () => {
    await guest('a', { restrictedUntil: new Date(Date.now() + 60_000) });
    await match.join('a');
    assert.equal(match.waitingCount(), 0);
    assert.ok(sent.some((s) => s.event === 'match:error'));
  });

  it('tells both people when the call cannot start', async () => {
    await Promise.all([guest('a'), guest('b')]);
    rtc.ensureRoom = async () => {
      throw new Error('down');
    };
    await match.join('a');
    await match.join('b');
    assert.equal(sent.filter((s) => s.event === 'match:error').length, 2);
  });
});

describe('sockets', () => {
  let httpServer, realtime, url, rtc;
  const open = [];
  const client = (token) => {
    const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    open.push(socket);
    return socket;
  };
  const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

  before(async () => {
    await setup();
    httpServer = http.createServer();
    realtime = createRealtime({ httpServer, config });
    rtc = new FakeRtc();
    realtime.useMatchmaker(createMatchmaker({ rtc, send: realtime.send }));
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${httpServer.address().port}`;
  });
  beforeEach(reset);
  after(async () => {
    open.forEach((s) => s.close());
    await realtime.close();
    await teardown();
  });

  it('refuses a connection without a valid session', async () => {
    const err = await once(client('forged'), 'connect_error');
    assert.equal(err.message, 'unauthorized');
  });

  it('matches two sockets end to end', async () => {
    await Promise.all([guest('s1'), guest('s2')]);
    const one = client(signGuestToken(config, 's1'));
    const two = client(signGuestToken(config, 's2'));
    await Promise.all([once(one, 'connect'), once(two, 'connect')]);
    const events = Promise.all([once(one, 'match:found'), once(two, 'match:found')]);
    one.emit('match:join');
    await once(one, 'match:waiting');
    two.emit('match:join');
    const [a, b] = await events;
    assert.equal(a.callId, b.callId);
    const ended = once(two, 'match:ended');
    one.emit('match:end', { callId: a.callId });
    assert.equal((await ended).callId, a.callId);
  });
});
