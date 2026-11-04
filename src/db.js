import mongoose from 'mongoose';
import { Gift } from './models/Gift.js';
import { GIFTS } from './data/gifts.js';

export async function connectDb(uri) {
  mongoose.set('strictQuery', true);
  // Turns any object in a query filter into a literal, which closes operator injection.
  mongoose.set('sanitizeFilter', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
}

/** Adds gifts that are missing and leaves existing ones alone, so an edited svgaUrl survives a restart. */
export async function seedGifts() {
  await Gift.bulkWrite(
    GIFTS.map(({ _id, ...rest }) => ({
      updateOne: { filter: { _id }, update: { $setOnInsert: rest }, upsert: true },
    })),
  );
}

export function dbReady() {
  return mongoose.connection.readyState === 1;
}
