import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const MESSAGE = { error: { code: 'rate-limited', message: 'Slow down a little and try again.' } };

/** A limiter counting per guest once they are signed in, and per address before that. */
export function limiter(config, { windowMs, limit }) {
  return rateLimit({
    windowMs,
    limit: Math.ceil(limit * config.rateScale),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: MESSAGE,
    keyGenerator: (req) => req.guest?._id ?? ipKeyGenerator(req.ip),
  });
}
