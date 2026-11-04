import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  VOLTKIT_RTC_URL: z.string().url(),
  VOLTKIT_RTC_SECRET: z.string().min(1),
  VOLTKIT_RATES_URL: z.string().url().default('https://api.voltkit.in'),
  // How many proxies sit in front of the app. 0 when it is reached directly.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  MAX_LIVE_ROOMS: z.coerce.number().int().positive().default(50),
  STARTING_COINS: z.coerce.number().int().min(0).default(5000),
  TOPUP_COINS: z.coerce.number().int().positive().default(2000),
  // Raises every rate limit. Only the test suite sets it.
  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
});

export function loadConfig(env = process.env) {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${problems}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    isTest: e.NODE_ENV === 'test',
    host: e.HOST,
    port: e.PORT,
    mongoUri: e.MONGODB_URI,
    jwtSecret: e.JWT_SECRET,
    jwtTtl: '180d',
    rtcUrl: e.VOLTKIT_RTC_URL,
    rtcSecret: e.VOLTKIT_RTC_SECRET,
    ratesUrl: e.VOLTKIT_RATES_URL,
    trustProxy: e.TRUST_PROXY,
    maxLiveRooms: e.MAX_LIVE_ROOMS,
    startingCoins: e.STARTING_COINS,
    topupCoins: e.TOPUP_COINS,
    maxCoins: 1_000_000,
    rateScale: e.RATE_LIMIT_SCALE,
    reconcileMs: 6_000,
    hostGraceMs: 90_000,
    roomStartGraceMs: 45_000,
    reportsToRestrict: 5,
  };
}
