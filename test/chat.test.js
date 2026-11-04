import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Guest } from '../src/models/Guest.js';
import { makeApp, reset, setup, teardown } from './helpers.js';

describe('chat', () => {
  let t, me, peer, stranger;
  const start = (from, peerId) => t.call('POST', '/v1/conversations', { token: from.token, body: { peerId } });
  const say = (from, id, text) => t.call('POST', `/v1/conversations/${id}/messages`, { token: from.token, body: { text } });

  before(async () => {
    await setup();
    t = await makeApp();
  });
  beforeEach(async () => {
    await reset();
    t.rtc.messages = [];
    t.sent.length = 0;
    me = await t.guest('Asha');
    peer = await t.guest('Ravi');
    stranger = await t.guest('Mallory');
  });
  after(async () => {
    await t.close();
    await teardown();
  });

  it('mints a chat token for the public lounge', async () => {
    const res = await t.call('POST', '/v1/chat/lounge/token', { token: me.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.channel, 'public-lounge');
    assert.ok(res.body.token);
  });

  it('gives two people one conversation, whoever starts it', async () => {
    const a = await start(me, peer.id);
    const b = await start(peer, me.id);
    assert.equal(a.body.conversation.id, b.body.conversation.id);
    assert.equal(a.body.conversation.peer.id, peer.id);
    assert.equal(b.body.conversation.peer.id, me.id);
  });

  it('delivers through VoltKit, keeps history, and counts unread for the other side only', async () => {
    const { id } = (await start(me, peer.id)).body.conversation;
    const res = await say(me, id, 'hello');
    assert.equal(res.status, 201);
    assert.equal(t.rtc.messages[0].channel, id);
    assert.equal(t.rtc.messages[0].from, me.id);
    assert.deepEqual(t.sent.at(-1), { to: peer.id, event: 'dm:new', payload: { conversationId: id } });

    const [peerInbox, myInbox] = await Promise.all([
      t.call('GET', '/v1/conversations', { token: peer.token }),
      t.call('GET', '/v1/conversations', { token: me.token }),
    ]);
    assert.equal(peerInbox.body.conversations[0].unread, 1);
    assert.equal(myInbox.body.conversations[0].unread, 0);

    await t.call('POST', `/v1/conversations/${id}/read`, { token: peer.token });
    const after = await t.call('GET', '/v1/conversations', { token: peer.token });
    assert.equal(after.body.conversations[0].unread, 0);

    const history = await t.call('GET', `/v1/conversations/${id}`, { token: peer.token });
    assert.equal(history.body.messages[0].text, 'hello');
    assert.equal(history.body.chat.channel, id);
  });

  it('keeps a stored message when VoltKit delivery fails', async () => {
    const { id } = (await start(me, peer.id)).body.conversation;
    t.rtc.failNextMessage = true;
    assert.equal((await say(me, id, 'still here')).status, 201);
    const history = await t.call('GET', `/v1/conversations/${id}`, { token: peer.token });
    assert.equal(history.body.messages[0].text, 'still here');
  });

  it('keeps conversations private to their two members', async () => {
    const { id } = (await start(me, peer.id)).body.conversation;
    await say(me, id, 'private');
    assert.equal((await t.call('GET', `/v1/conversations/${id}`, { token: stranger.token })).status, 404);
    assert.equal((await say(stranger, id, 'let me in')).status, 404);
    assert.equal((await t.call('POST', `/v1/conversations/${id}/read`, { token: stranger.token })).status, 404);
  });

  it('holds blocks in both directions', async () => {
    const { id } = (await start(me, peer.id)).body.conversation;
    await t.call('POST', `/v1/blocks/${peer.id}`, { token: me.token });
    assert.equal((await say(peer, id, 'hello?')).status, 403);
    assert.equal((await say(me, id, 'hello?')).status, 403);
    assert.equal((await start(peer, me.id)).status, 403);
    const inbox = await t.call('GET', '/v1/conversations', { token: me.token });
    assert.equal(inbox.body.conversations.length, 0);
  });

  it('refuses a restricted account', async () => {
    const { id } = (await start(me, peer.id)).body.conversation;
    await Guest.updateOne({ _id: me.id }, { restrictedUntil: new Date(Date.now() + 60_000) });
    assert.equal((await say(me, id, 'hello')).status, 403);
    assert.equal((await t.call('POST', '/v1/chat/lounge/token', { token: me.token })).status, 403);
  });

  it('refuses empty and oversized messages', async () => {
    const { id } = (await start(me, peer.id)).body.conversation;
    assert.equal((await say(me, id, '   ')).status, 400);
    assert.equal((await say(me, id, 'x'.repeat(1001))).status, 400);
  });
});
