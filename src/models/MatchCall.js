import mongoose from 'mongoose';

const MatchCallSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // also the VoltKit roomId
    members: { type: [String], required: true },
    endedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

MatchCallSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export const MatchCall = mongoose.model('MatchCall', MatchCallSchema);
