# Using the VoltKit server SDK

How this backend uses [`@voltkit-rtc/server`](https://voltkit.in/docs/server-sdk), and why each part is done the way it is. Read it with the code open:
each section names the file.

## The idea

Your backend is never in the media path. It does two things: decide who may do what, and hand the app a short-lived token that says so.

| Credential | Held by | Lasts | Used for |
| --- | --- | --- | --- |
| API secret (`sk_...`) | This server only | Until revoked | Creating rooms, minting tokens, sending chat |
| Room token | One person's phone | Ten minutes | Joining one room, in one role |
| Chat token | One person's phone | Ten minutes | Reading and writing one chat channel |

> [!IMPORTANT]
> Never put the API secret in an app. Anyone who has it can create rooms, mint host tokens and spend your minutes, and an app can be unpacked.

## 1. Make one client

[`src/services/rtc.js`](../src/services/rtc.js)

```js
import { StreamClient } from '@voltkit-rtc/server';

const rtc = new StreamClient({
  baseUrl: process.env.VOLTKIT_RTC_URL,
  apiKey: process.env.VOLTKIT_RTC_SECRET,
  ratesBaseUrl: 'https://api.voltkit.in',
  timeoutMs: 6000,
  retries: 1,
});
```

**Why one:** create it once at start-up and share it. The constructor checks its options, so a missing value fails at start, not on someone's first room.

**Why a shorter timeout:** the defaults allow about 31 seconds for a call, because of retries. Most calls here have a person waiting on a spinner, so 6
seconds and one retry fail sooner and let the app say so.

**Why `ratesBaseUrl`:** `getRates()` reads the public price list from VoltKit's website API, a different address. The secret is never sent there.

### Check the secret at start-up

[`src/server.js`](../src/server.js)

```js
await rtc.getUsage().catch((err) => {
  console.error('VoltKit check failed:', err.code, err.message);
  process.exit(1);
});
```

**Why:** a wrong secret should stop a deploy, not surprise your first user. A server that exits here also lets `deploy.sh` roll back. Logging the error is
safe: the SDK removes your secret from every error.

### Pass it in, do not import it

Services receive `rtc` as an argument:

```js
const rooms = createRoomService({ config, rtc, canGoLive, onRoomsChanged });
```

**Why:** the tests pass [`FakeRtc`](../test/helpers.js) in the same place, so all the logic can be tested without a VoltKit account.

## 2. Create a room

[`src/services/rooms.js`](../src/services/rooms.js), `create()`

```js
const created = await rtc.ensureRoom({
  roomId,
  hostIdentity: guest._id,
  metadata: { title, type, seats, seatMode, layout, theme },
});
// created: { hostToken, wsUrl, expiresAt, existed, ... }
```

The app gets `hostToken` and `wsUrl`, and goes straight into the room.

**Why `ensureRoom` and not `createRoom`:** `createRoom` fails with `room-exists` if the id is taken, and is never retried, because a lost reply would look like a
failure. `ensureRoom` is safe to repeat: it returns the room if it exists, or makes it. So a retry after a network blip gives the right answer.

**Why your own room id:** the same id then names the VoltKit room, the chat channel and your database row, with nothing to map between them.

**Why metadata here:** every participant receives it on joining, so the app can draw the room with no extra request. It is applied only when the room is created.
After that, the host's app changes it with `setRoomMetadata`.

**Why a Mongo row as well:** VoltKit tracks what is live. Your database holds what VoltKit has no reason to know: the title and cover for the list, who is banned,
and coins earned.

**Why order matters:** `create()` checks limits first, and only then calls VoltKit. It also ends the guest's previous room, so one person cannot leave a trail of
open rooms using up your limit.

## 3. Let people in

[`src/services/rooms.js`](../src/services/rooms.js), `issueToken()`

```js
const present = room.host.id === guest._id ? 'host' : await liveRole(roomId, guest._id);
const role = present ?? 'viewer';
const minted = await rtc.createToken({ roomId, identity: guest._id, role });
```

**How the role is chosen:** the host of record gets `host`. Anyone already in the room keeps the role they hold now. Everyone else is a `viewer`.

**Why ask VoltKit for the role:** promotions happen live, between the host's app and VoltKit, so this backend is not told. If a co-host's token needs refreshing, or they
rejoin after a crash, `listParticipants` gives their real role. A token that said `viewer` would quietly send them to the audience.

**Why a request body cannot set the role:** a client could ask for anything. It is decided only here, and it is signed into the token. A test checks this: a viewer who
posts `{ "role": "host" }` still gets `viewer`.

**Why identity is your own id:** it is what other participants see, what moderation acts on, and what appears in webhooks, so it must be stable. This app uses the guest's id.

**Why `Cache-Control: no-store`:** a token is a credential, so nothing between here and the phone should keep it.

### Refreshing a token

`POST /v1/rooms/:id/token` runs the same code, for when the SDK's `tokenExpiring` event asks for one. It is a separate route from `join` because a refresh is not an arrival: it
must not play an entrance effect. VoltKit normally refreshes connected sessions by itself, so this is a fallback.

## 4. VoltKit is the truth about what is live

[`src/services/rooms.js`](../src/services/rooms.js), `reconcile()`, called every 6 seconds

```js
const { rooms: serviceRooms } = await rtc.listRooms();
```

For each room your database says is live, it compares that with VoltKit:

| VoltKit says | This backend does |
| --- | --- |
| Gone, and the room is over 15 seconds old | Marks it ended |
| A new participant count | Saves it, and tells clients to refresh the list |
| Nobody there, and over 45 seconds old | Ends it |
| People there, but the host has been gone over 90 seconds | Ends it |

**Why poll instead of counting joins and leaves:** rooms end in ways your backend never sees, such as the last phone dying. Webhooks are delivered at least once and in no
fixed order, so a counter built from them drifts. VoltKit's guide recommends reading the count, and one `listRooms()` call covers every room.

**Why the 15 and 45 second grace periods:** a room exists before its host's phone has connected. Without them, a room could be ended while the host is still loading.

**Why end a room with no host:** nobody is left who can moderate it. The 90 seconds cover the host's phone reconnecting. The host check calls `listParticipants` for each room,
so it runs on every fifth pass, about every 30 seconds.

Everything in the loop is also why the app stays honest: if a backend restarts, the next pass corrects its database.

### Ending a room

```js
import { StreamError } from '@voltkit-rtc/server';

await rtc.deleteRoom(roomId).catch((err) => {
  if (!(err instanceof StreamError && err.isNotFound)) throw err;
});
```

**Why ignore "not found":** a room that has already gone is what you wanted, so it is not an error.

## 5. Keep removed people out

[`src/services/rooms.js`](../src/services/rooms.js), `ban()`

The app removes someone in two steps: it asks this backend to ban them, then calls `client.kick()`.

**Why both:** `kick` stops the tokens minted so far. Without the ban, they could ask this backend for a new token and walk back in. `issueToken` checks `room.bans` first.

**Why the ban re-checks permissions:** this route is called by clients, so it asks VoltKit what the caller's role really is. Moderators can only ban viewers, the same rule
the service applies to `kick`.

## 6. Send trusted messages

### Gifts

[`src/routes/rooms.js`](../src/routes/rooms.js), `POST /rooms/:id/gifts`

```js
await rtc.sendMessage({
  channel: room._id,
  type: 'gift',
  from: sender._id,
  metadata: { giftId: gift._id, svgaUrl: gift.svgaUrl, count, coins, fromName: sender.name, toName: recipient.name },
});
```

The room's chat channel has the same name as the room, so everyone in it receives this as a normal `message` event.

**Why from the server:** VoltKit has no gift API, because a gift is a chat message your app understands. A message sent by a client could claim any gift. One sent with your API
secret can be trusted, and `from` can name the sender.

The order of the steps is what keeps coins correct:

1. **Take the coins in one atomic update**, with `coins: { $gte: cost }` in the filter. Two gifts at once cannot spend the same coins, and a test sends twelve together to prove it.
2. **Send the message.**
3. **If sending fails, give the coins back.** Nobody saw the gift, so it was not sent.
4. **Only then record it** and count it for the recipient.

**Why the price comes from the catalog:** the request names a gift and a count, and never a price.

> [!NOTE]
> `sendMessage` is never retried by the SDK, because a lost reply could post the message twice. If you need exactly-once delivery, put your own id in `metadata` and look for it in
> `listMessages` before sending again. See [Calls that are never repeated](https://voltkit.in/docs/server-sdk#calls-that-are-never-repeated).

### Entrance effects

[`src/services/rooms.js`](../src/services/rooms.js), `announceEntrance()`

```js
rtc
  .sendMessage({ channel: roomId, type: 'entrance', ephemeral: true, metadata: { name: guest.name, frame: guest.frame } })
  .catch((err) => console.warn('entrance announcement failed:', err.message));
```

**Why `ephemeral`:** it is delivered and forgotten, so people who join later do not replay old arrivals.

**Why not awaited:** an effect is decoration. It should not slow someone's join, or fail it.

## 7. Chat tokens

[`src/routes/chat.js`](../src/routes/chat.js)

```js
const { token, wsUrl } = await rtc.createChatToken({ channel: 'public-lounge', identity: req.guest._id });
```

People in a room already have chat on their room connection. A chat token is for chat with no room behind it.

**The Lounge** is one channel for everyone. It exists as soon as someone connects, with nothing to create.

**Direct messages** use one channel per pair of people. The id comes from both guest ids, sorted, so two people always land in the same place:

```js
export function conversationId(a, b) {
  return `dm_${[a, b].sort().join('__')}`;
}
```

**Why tokens are minted after a membership check:** a chat token opens a whole channel. So `GET /conversations/:id` confirms the caller is one of its two members first.

**Why direct messages are stored in Mongo:** VoltKit keeps the last 500 messages per channel, and clears a quiet channel after 24 hours. It is built for live chat, not as an
archive. Mongo holds the conversation, and VoltKit carries each message live.

**Why they go through this server:** blocks have to hold, and a check in the app can be removed. If VoltKit delivery fails, the message is kept and shows up in history, so that
failure is logged and not returned as an error.

## 8. 1v1 calls

[`src/services/matchmaker.js`](../src/services/matchmaker.js)

```js
const room = await rtc.ensureRoom({ roomId: callId, hostIdentity: a._id, metadata: { type: 'call' } });
const other = await rtc.createToken({ roomId: callId, identity: b._id, role: 'cohost' });
```

**Why host and co-host:** a call is a room with two people, and both must publish. Those are the two roles that can.

**Why the waiting line is here:** nobody is in a room yet, so VoltKit has no connection to them. The line is held in memory and offered over Socket.IO.

**Why a new room per call:** nothing carries over between strangers, and each room's usage is separate.

**How a call ends:** either person sends `match:end`, and this backend calls `deleteRoom` and tells the other side. Calls left open by a crash are closed by VoltKit once everyone has
gone.

> [!NOTE]
> The waiting line lives in one server's memory, so this runs as a single instance. To run several, move the line to Redis or similar.

## 9. Check credit before going live

[`src/services/rtc.js`](../src/services/rtc.js), `createBalanceGuard()`

```js
const { canJoin } = await rtc.getBalance();
```

**Why:** when a project is out of credit, a clear "unavailable" beats a failed join. It is read at most once every 30 seconds, so going live stays fast.

**Why a failed read does not block anyone:** VoltKit still enforces the limit itself. This check exists to give a better message, so being unable to read it is no reason to refuse.

## 10. Turn errors into words

[`src/errors.js`](../src/errors.js)

Every failed SDK call rejects with a `StreamError`. Its details are for your logs, and people get a plain sentence.

| `StreamError` | Answer | Code for the app |
| --- | --- | --- |
| `isNotFound` | 410 | `room-ended` |
| `isOutOfMinutes`, `tenant-suspended`, `isBillingUnavailable` | 503 | `rtc-unavailable` |
| `viewer-quota` | 429 | `room-full` |
| `room-quota` | 429 | `too-many-rooms` |
| `isCapacityExhausted`, or `retryable` | 503 | `rtc-busy` |
| Anything else | 502 | `rtc-error` |

**Why not pass VoltKit's message along:** a user cannot act on "POST /v1/rooms/x/tokens: room not found", and your account's state is not theirs to see.

**Why the app gets a code as well:** it branches on the code, for example to hide a Join again button when a room has ended. Words can then change freely.

## Security notes

- **Query injection:** Mongoose runs with `sanitizeFilter`, which turns any object in a filter into a plain value, so `{"peerId": {"$ne": null}}` cannot match everyone. Operators the server writes itself
  are wrapped in `mongoose.trusted()`.
- **Input:** every route checks its body with Zod, and JSON bodies are limited to 16 KB.
- **Rate limits:** per guest once signed in, and per address before that. See the [API reference](api-reference.md#rate-limits). Behind a proxy, set `TRUST_PROXY`, or every visitor looks the same. See
  [Deployment](deployment.md#behind-your-own-proxy).
- **Sessions:** guests get a signed token, kept in the phone's secure storage. There is no password to lose.

## Going further

- [Webhooks](https://voltkit.in/docs/webhooks): record who watched and for how long. This backend does not use them.
- [Usage and billing](https://voltkit.in/docs/usage-and-billing)
- [Every error code](https://voltkit.in/docs/errors)
