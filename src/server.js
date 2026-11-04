import http from 'node:http';
import mongoose from 'mongoose';
import { loadConfig } from './config.js';
import { connectDb, seedGifts } from './db.js';
import { createApp } from './app.js';
import { createBalanceGuard, createRtc } from './services/rtc.js';
import { createRoomService } from './services/rooms.js';
import { createMatchmaker } from './services/matchmaker.js';
import { createRealtime } from './realtime/socket.js';

const config = loadConfig();
await connectDb(config.mongoUri);
await seedGifts();

const rtc = createRtc(config);
// Catches a wrong secret at start-up rather than on someone's first room.
await rtc.getUsage().catch((err) => {
  console.error('VoltKit check failed:', err.code, err.message);
  process.exit(1);
});

const httpServer = http.createServer();
const realtime = createRealtime({ httpServer, config });
const rooms = createRoomService({
  config,
  rtc,
  canGoLive: createBalanceGuard(rtc),
  onRoomsChanged: realtime.roomsChanged,
});
const matchmaker = createMatchmaker({ rtc, send: realtime.send });
realtime.useMatchmaker(matchmaker);

const app = createApp({
  config,
  rtc,
  rooms,
  send: realtime.send,
  stats: () => ({ online: realtime.online(), waiting: matchmaker.waitingCount() }),
});
httpServer.on('request', app);

let reconciling = false;
const reconcile = setInterval(async () => {
  if (reconciling) return;
  reconciling = true;
  await rooms.reconcile().catch((err) => console.warn('reconcile failed:', err.message));
  reconciling = false;
}, config.reconcileMs);

httpServer.listen(config.port, config.host, () => console.log(`VoltKit Live backend on ${config.host}:${config.port}`));

async function shutdown() {
  clearInterval(reconcile);
  await realtime.close();
  httpServer.close();
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
