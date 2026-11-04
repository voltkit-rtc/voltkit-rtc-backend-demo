import { Router } from 'express';
import { dbReady } from '../db.js';
import { Room } from '../models/Room.js';
import { requireGuest } from '../middleware/auth.js';

/** Today's published prices, read once in a while. No price is ever invented when they cannot be read. */
function createRatesReader(rtc) {
  let cached = null;
  let readAt = 0;
  return async () => {
    if (cached && Date.now() - readAt < 10 * 60_000) return cached;
    try {
      const { tiers } = await rtc.getRates();
      const credits = (id) => tiers.find((t) => t.id === id)?.credits ?? null;
      cached = { audio: credits('audio_std'), video: credits('video_30'), unit: 'per 1,000 participant-minutes' };
      readAt = Date.now();
    } catch (err) {
      console.warn('could not read rates:', err.message);
    }
    return cached;
  };
}

export function metaRoutes({ config, rtc, stats }) {
  const r = Router();
  const readRates = createRatesReader(rtc);

  r.get('/stats', requireGuest(config), async (_req, res) => {
    const liveRooms = await Room.countDocuments({ status: 'live' });
    res.json({ liveRooms, ...stats() });
  });

  r.get('/voltkit', requireGuest(config), async (_req, res) => {
    res.json({ rates: await readRates(), site: 'https://voltkit.in', docs: 'https://voltkit.in/docs' });
  });

  return r;
}

export function healthRoute(req, res) {
  const db = dbReady();
  res.status(db ? 200 : 503).json({ ok: db });
}
