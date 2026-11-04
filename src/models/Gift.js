import mongoose from 'mongoose';

const GiftSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    tier: { type: String, enum: ['basic', 'premium', 'royal'], default: 'basic' },
    // A path on this server or a full URL: swap in hosted .svga files without an app update.
    svgaUrl: { type: String, required: true },
    icon: { type: String, required: true },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { versionKey: false },
);

export const Gift = mongoose.model('Gift', GiftSchema);

export const publicGift = (g) => ({
  id: g._id,
  name: g.name,
  price: g.price,
  tier: g.tier,
  svgaUrl: g.svgaUrl,
  icon: g.icon,
});
