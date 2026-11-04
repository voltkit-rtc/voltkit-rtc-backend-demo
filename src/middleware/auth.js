import jwt from 'jsonwebtoken';
import { Guest } from '../models/Guest.js';
import { AppError } from '../errors.js';

export const signGuestToken = (config, guestId) =>
  jwt.sign({}, config.jwtSecret, { subject: guestId, expiresIn: config.jwtTtl, algorithm: 'HS256' });

/** The guest id in a session token, or null when it is not ours or has expired. */
export function verifyGuestToken(config, token) {
  try {
    return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }).sub;
  } catch {
    return null;
  }
}

export function requireGuest(config) {
  return async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const id = header.startsWith('Bearer ') ? verifyGuestToken(config, header.slice(7)) : null;
    if (!id) return next(new AppError(401, 'unauthorized', 'Please open the app again.'));
    const guest = await Guest.findById(id);
    if (!guest) return next(new AppError(401, 'unauthorized', 'This guest no longer exists.'));
    req.guest = guest;
    next();
  };
}
