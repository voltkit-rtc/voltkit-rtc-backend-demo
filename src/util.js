import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A short random id. VoltKit ids may use letters, digits, dots, dashes and underscores. */
export function newId(prefix, length = 14) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}_${out}`;
}

/** One-to-one channel name: the same two people always land in the same conversation. */
export function conversationId(a, b) {
  return `dm_${[a, b].sort().join('__')}`;
}
