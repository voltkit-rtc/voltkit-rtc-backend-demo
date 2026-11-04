import mongoose from 'mongoose';

const GiftEventSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    from: { type: String, required: true, index: true },
    to: { type: String, required: true },
    giftId: { type: String, required: true },
    count: { type: Number, required: true },
    coins: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

export const GiftEvent = mongoose.model('GiftEvent', GiftEventSchema);
