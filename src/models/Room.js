import mongoose from 'mongoose';

const RoomSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // also the VoltKit roomId and chat channel
    type: { type: String, enum: ['video', 'audio'], required: true },
    title: { type: String, required: true, trim: true, maxlength: 48 },
    theme: { type: String, required: true },
    seats: { type: Number, required: true },
    seatMode: { type: String, enum: ['open', 'request'], default: 'request' },
    layout: { type: String, enum: ['stage', 'grid'], default: 'stage' },
    host: {
      id: { type: String, required: true },
      name: { type: String, required: true },
      avatar: { type: String, required: true },
      frame: { type: String, default: 'none' },
    },
    status: { type: String, enum: ['live', 'ended'], default: 'live' },
    viewers: { type: Number, default: 0 },
    peakViewers: { type: Number, default: 0 },
    giftCoins: { type: Number, default: 0 },
    bans: { type: [String], default: [] },
    hostLastSeenAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

RoomSchema.index({ status: 1, viewers: -1, createdAt: -1 });
RoomSchema.index({ 'host.id': 1, status: 1 });
// Ended rooms are kept for a week, for reports that point at them.
RoomSchema.index({ endedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export const Room = mongoose.model('Room', RoomSchema);

export const publicRoom = (r) => ({
  id: r._id,
  type: r.type,
  title: r.title,
  theme: r.theme,
  seats: r.seats,
  seatMode: r.seatMode,
  layout: r.layout,
  host: { id: r.host.id, name: r.host.name, avatar: r.host.avatar, frame: r.host.frame },
  status: r.status,
  viewers: r.viewers,
  giftCoins: r.giftCoins,
  createdAt: r.createdAt,
});
