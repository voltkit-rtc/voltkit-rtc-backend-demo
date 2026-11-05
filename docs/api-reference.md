# API reference

Everything the [React Native app](https://github.com/voltkit-rtc/react-native-example-audio-video) calls. The app's client is
[`src/api/client.ts`](https://github.com/voltkit-rtc/react-native-example-audio-video/blob/main/src/api/client.ts).

## Basics

- All routes start with `/v1`, except `GET /health` and `GET /static/...`.
- Send JSON, and sign in with `Authorization: Bearer <session token>`. Only `POST /v1/guests` needs no token.
- Failures look like this. Branch on `code`, and show `message`.

```json
{ "error": { "code": "room-ended", "message": "This room has ended." } }
```

## Guests

| Method and path | Body | Returns |
| --- | --- | --- |
| `POST /guests` | `name`, `avatar`, `ageConfirmed: true` | `201` `{ token, guest }` |
| `GET /me` | | `{ guest }` |
| `PATCH /me` | Any of `name`, `avatar`, `frame` | `{ guest }` |
| `POST /me/coins/topup` | | `{ guest }` |
| `DELETE /me` | | `204`. Removes the guest and their conversations, and ends their live rooms |
| `GET /guests/:id` | | `{ guest, blockedByMe }` |
| `GET /blocks` | | `{ guests }` |
| `POST /blocks/:id` | | `204` |
| `DELETE /blocks/:id` | | `204` |
| `POST /reports` | `target`, `reason`, optional `roomId`, `note` | `202` `{ ok: true }` |

`name` is 2 to 24 characters. `avatar` looks like `a01`. `frame` is `none`, `lion` or `wolf`. `reason` is `harassment`, `nudity`, `violence`, `spam`, `underage` or `other`.

One report counts per person per day. Five different people reporting an account within a day restricts it for 24 hours: it cannot go live, match or send messages.

## Rooms

| Method and path | Body | Returns |
| --- | --- | --- |
| `GET /rooms` | Query: optional `type` | `{ rooms }`, most viewers first, up to 60 |
| `POST /rooms` | See below | `201` `{ room, credentials }` |
| `GET /rooms/:id` | | `{ room }` |
| `POST /rooms/:id/join` | | `{ room, credentials }` |
| `POST /rooms/:id/token` | | `{ credentials }`. For `tokenExpiring` |
| `POST /rooms/:id/end` | | `204`. Host only |
| `POST /rooms/:id/bans` | `identity` | `204`. Call this, then `client.kick()` |

Creating a room:

| Field | Values |
| --- | --- |
| `type` | `video` or `audio` |
| `title` | 3 to 48 characters |
| `seats` | Video: 4, 6 or 9, counting the host's card. Audio: 8, 10 or 15 |
| `theme` | `royal`, `neon`, `galaxy`, `city`, `sunset` or `ocean`. Default `royal` |
| `seatMode` | `request` or `open`. Default `request` |
| `layout` | `stage` or `grid`. Default `stage` |

`credentials` is what the app gives `VoltkitProvider`:

```json
{ "token": "eyJ...", "wsUrl": "wss://rtc.voltkit.in/ws", "role": "viewer", "expiresAt": 1793803799 }
```

## Gifts

| Method and path | Body | Returns |
| --- | --- | --- |
| `GET /gifts` | | `{ gifts, demoCoins: true }` |
| `POST /rooms/:id/gifts` | `giftId`, `to`, optional `count` from 1 to 99 | `{ guest }`, with the new coin balance |

A gift reaches the room as a VoltKit chat message with `type: "gift"`, and these fields in `metadata`:
`giftId`, `giftName`, `tier`, `svgaUrl`, `icon`, `count`, `coins`, `fromName`, `toId`, `toName` and `roomCoins`.

Sending a gift to yourself is allowed, and is paid for like any other.

## Chat

| Method and path | Body | Returns |
| --- | --- | --- |
| `POST /chat/lounge/token` | | `{ channel, token, wsUrl, expiresAt }` |
| `GET /conversations` | | `{ conversations }`, newest first, up to 50 |
| `POST /conversations` | `peerId` | `201` `{ conversation }`. Starts it, or returns the existing one |
| `GET /conversations/:id` | Query: optional `before`, an ISO date | `{ conversation, messages, chat }`. `chat` is a token for this channel |
| `POST /conversations/:id/messages` | `text`, up to 1000 characters | `201` `{ message }` |
| `POST /conversations/:id/read` | | `204` |

## Other

| Method and path | Returns |
| --- | --- |
| `GET /health` | `{ ok: true }`, or `503` when the database is down |
| `GET /stats` | `{ liveRooms, online, waiting }` |
| `GET /voltkit` | `{ rates, site, docs }`. `rates` is today's published prices, or `null` when they cannot be read |
| `GET /static/svga/<name>.svga` | A gift animation |

## Socket.IO

Connect with the session token, using WebSocket transport.

```ts
import { io } from 'socket.io-client';

const socket = io('https://api.example.com', { auth: { token: 'session-token' }, transports: ['websocket'] });
```

A bad token fails the connection with `unauthorized`.

### The app sends

| Event | Payload | Meaning |
| --- | --- | --- |
| `match:join` | | Join the 1v1 waiting line |
| `match:leave` | | Leave it |
| `match:end` | `{ callId }` | End this call |

`match:join` and `match:end` are accepted at most every 400 ms per connection.

### The server sends

| Event | Payload | Meaning |
| --- | --- | --- |
| `match:waiting` | `{ waiting }` | You are in the line, with this many people |
| `match:found` | `{ callId, token, wsUrl, role, peer }` | Connect to this call |
| `match:ended` | `{ callId }` | The other person hung up |
| `match:error` | `{ message }` | Matching failed, or the account is restricted |
| `rooms:changed` | | Refresh the room list. Sent at most once a second |
| `dm:new` | `{ conversationId }` | A new direct message arrived |

## Error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `bad-request` | 400 | The body is not valid |
| `coins-full` | 400 | The demo coin ceiling has been reached |
| `unauthorized` | 401 | Missing or invalid session token |
| `not-enough-coins` | 402 | The gift costs more than the balance |
| `forbidden` | 403 | Your role cannot do that |
| `restricted` | 403 | The account is restricted after reports |
| `banned` | 403 | You were removed from this room |
| `blocked` | 403 | A block stops this conversation |
| `not-found` | 404 | No such guest, gift or conversation |
| `room-ended` | 410 | The room is over |
| `rate-limited` | 429 | Too many requests |
| `too-many-rooms` | 429 | At the live room limit |
| `room-full` | 429 | At the room's viewer limit |
| `rtc-error` | 502 | VoltKit gave an unexpected answer |
| `rtc-unavailable` | 503 | The VoltKit project cannot be used right now |
| `rtc-busy` | 503 | VoltKit is busy. Try again |
| `internal` | 500 | A bug here |

## Rate limits

| What | Limit | Counted per |
| --- | --- | --- |
| Everything under `/v1` | 600 a minute | Address |
| `POST /guests` | 20 an hour | Address |
| Profile, blocks, reports | 30 a minute | Guest |
| `POST /me/coins/topup` | 10 a minute | Guest |
| `POST /rooms` | 6 a minute | Guest |
| Joining a room, refreshing a token | 40 a minute | Guest |
| `POST /rooms/:id/gifts` | 60 a minute | Guest |
| Chat tokens, opening or starting conversations | 30 a minute | Guest |
| `POST /conversations/:id/messages` | 60 a minute | Guest |
