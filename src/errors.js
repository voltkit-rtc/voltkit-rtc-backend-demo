import { StreamError } from '@voltkit-rtc/server';

/** An error the client is meant to see: a stable `code` to branch on and words to show. */
export class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** VoltKit's refusals in words for a guest. The service's own details stay in the server log. */
export function fromRtcError(err) {
  if (!(err instanceof StreamError)) return null;
  if (err.isNotFound) return new AppError(410, 'room-ended', 'This room has ended.');
  if (err.isOutOfMinutes || err.code === 'tenant-suspended' || err.isBillingUnavailable) {
    return new AppError(503, 'rtc-unavailable', 'Live rooms are unavailable right now. Please try again later.');
  }
  if (err.code === 'viewer-quota') return new AppError(429, 'room-full', 'This room is full.');
  if (err.code === 'room-quota') return new AppError(429, 'too-many-rooms', 'Too many rooms are live right now.');
  if (err.isCapacityExhausted || err.retryable) {
    return new AppError(503, 'rtc-busy', 'The live service is busy. Try again in a moment.');
  }
  return new AppError(502, 'rtc-error', 'Something went wrong on the live service.');
}
