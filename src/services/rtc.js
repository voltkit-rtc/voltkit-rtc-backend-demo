import { StreamClient, StreamError } from '@voltkit-rtc/server';

export function createRtc(config) {
  return new StreamClient({
    baseUrl: config.rtcUrl,
    apiKey: config.rtcSecret,
    ratesBaseUrl: config.ratesUrl,
    // A guest is waiting on most of these calls.
    timeoutMs: 6000,
    retries: 1,
  });
}

/** Ends a room that may already be gone. */
export async function deleteRoomQuietly(rtc, roomId) {
  await rtc.deleteRoom(roomId).catch((err) => {
    if (!(err instanceof StreamError && err.isNotFound)) throw err;
  });
}

/** Whether a new join would be admitted, read at most once every 30 seconds. */
export function createBalanceGuard(rtc) {
  let cached = null;
  let readAt = 0;
  return async function canGoLive() {
    if (cached !== null && Date.now() - readAt < 30_000) return cached;
    try {
      const { canJoin } = await rtc.getBalance();
      cached = canJoin;
      readAt = Date.now();
    } catch (err) {
      // Not being able to read the balance is no reason to refuse: VoltKit still enforces it.
      console.warn('balance check failed:', err.message);
      return cached ?? true;
    }
    return cached;
  };
}
