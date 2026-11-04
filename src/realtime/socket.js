import { Server } from 'socket.io';
import { verifyGuestToken } from '../middleware/auth.js';

const guestChannel = (id) => `guest:${id}`;

/** Socket.IO carries what VoltKit does not: the live room list, the 1v1 waiting line and inbox notices. */
export function createRealtime({ httpServer, config }) {
  const io = new Server(httpServer, { cors: { origin: false }, serveClient: false, maxHttpBufferSize: 8 * 1024 });
  let matchmaker = null;
  let changeTimer = null;

  io.use((socket, next) => {
    const id = verifyGuestToken(config, socket.handshake.auth?.token);
    if (!id) return next(new Error('unauthorized'));
    socket.data.guestId = id;
    next();
  });

  io.on('connection', (socket) => {
    const { guestId } = socket.data;
    socket.join(guestChannel(guestId));

    // Each event at most every 400 ms per socket: nothing here is worth repeating faster.
    const lastAt = new Map();
    const allowed = (event) => {
      const now = Date.now();
      if (now - (lastAt.get(event) ?? 0) < 400) return false;
      lastAt.set(event, now);
      return true;
    };

    socket.on('match:join', () => {
      if (allowed('match:join')) matchmaker?.join(guestId).catch((err) => console.error('match:join', err));
    });
    socket.on('match:leave', () => matchmaker?.leave(guestId));
    socket.on('match:end', (payload) => {
      if (typeof payload?.callId === 'string' && allowed('match:end')) {
        matchmaker?.end(guestId, payload.callId).catch((err) => console.error('match:end', err));
      }
    });
    socket.on('disconnect', async () => {
      const others = await io.in(guestChannel(guestId)).fetchSockets();
      if (others.length === 0) matchmaker?.leave(guestId);
    });
  });

  return {
    io,
    useMatchmaker: (m) => {
      matchmaker = m;
    },
    send: (guestId, event, payload) => io.to(guestChannel(guestId)).emit(event, payload),
    /** Tells every client to refresh its room list, at most once a second however many rooms change. */
    roomsChanged: () => {
      if (changeTimer) return;
      changeTimer = setTimeout(() => {
        changeTimer = null;
        io.emit('rooms:changed');
      }, 1000);
      changeTimer.unref?.();
    },
    online: () => io.engine.clientsCount,
    close: () => {
      clearTimeout(changeTimer);
      return io.close();
    },
  };
}
