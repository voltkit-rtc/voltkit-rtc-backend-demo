import mongoose from 'mongoose';

const GuestSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 24 },
    avatar: { type: String, required: true },
    frame: { type: String, enum: ['none', 'lion', 'wolf'], default: 'none' },
    coins: { type: Number, default: 0, min: 0 },
    giftsReceived: { type: Number, default: 0, min: 0 },
    blocked: { type: [String], default: [] },
    restrictedUntil: { type: Date, default: null },
    ageConfirmedAt: { type: Date, required: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false },
);

export const Guest = mongoose.model('Guest', GuestSchema);

export const publicGuest = (g) => ({ id: g._id, name: g.name, avatar: g.avatar, frame: g.frame });

export const privateGuest = (g) => ({
  ...publicGuest(g),
  coins: g.coins,
  giftsReceived: g.giftsReceived,
  blocked: g.blocked,
  restricted: isRestricted(g),
});

export const isRestricted = (g) => Boolean(g.restrictedUntil && g.restrictedUntil > new Date());
