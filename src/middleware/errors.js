import { ZodError } from 'zod';
import { AppError, fromRtcError } from '../errors.js';

export const notFound = (_req, _res, next) => next(new AppError(404, 'not-found', 'Not found.'));

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let e = err;
  if (err instanceof ZodError) {
    const first = err.issues[0];
    e = new AppError(400, 'bad-request', first?.message ?? 'That request is not valid.');
  } else if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    e = new AppError(400, 'bad-request', 'That request is not valid.');
  } else {
    e = fromRtcError(err) ?? err;
  }

  if (e instanceof AppError) {
    if (e.status >= 500) console.error(`${req.method} ${req.path}:`, err); // safe: the SDK redacts its secret
    return res.status(e.status).json({ error: { code: e.code, message: e.message, ...e.extra } });
  }
  console.error(`${req.method} ${req.path}:`, err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong.' } });
}
