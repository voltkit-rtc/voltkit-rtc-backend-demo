import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import { errorHandler, notFound } from './middleware/errors.js';
import { limiter } from './middleware/limits.js';
import { guestRoutes } from './routes/guests.js';
import { roomRoutes } from './routes/rooms.js';
import { chatRoutes } from './routes/chat.js';
import { healthRoute, metaRoutes } from './routes/meta.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ config, rtc, rooms, send = () => {}, stats = () => ({ online: 0, waiting: 0 }) }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(helmet());
  app.use(compression());

  app.get('/health', healthRoute);

  // Gift animations: named by content in the catalog, so they can be cached for a long time.
  app.use('/static', express.static(PUBLIC_DIR, { maxAge: '30d', immutable: true, index: false, dotfiles: 'ignore' }));

  app.use(limiter(config, { windowMs: 60_000, limit: 600 }));
  app.use(express.json({ limit: '16kb' }));

  const v1 = express.Router();
  v1.use(guestRoutes({ config, rtc }));
  v1.use(roomRoutes({ config, rtc, rooms }));
  v1.use(chatRoutes({ config, rtc, send }));
  v1.use(metaRoutes({ config, rtc, stats }));
  app.use('/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
