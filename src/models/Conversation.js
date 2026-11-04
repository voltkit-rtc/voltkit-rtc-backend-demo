import mongoose from 'mongoose';

const ConversationSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // also the VoltKit chat channel
    members: { type: [String], required: true },
    last: {
      text: { type: String, default: '' },
      from: { type: String, default: null },
      at: { type: Date, default: null },
    },
    unread: { type: Map, of: Number, default: {} },
  },
  { timestamps: true, versionKey: false },
);

ConversationSchema.index({ members: 1, updatedAt: -1 });

export const Conversation = mongoose.model('Conversation', ConversationSchema);

const MessageSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true },
    from: { type: String, required: true },
    text: { type: String, required: true, maxlength: 1000 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

MessageSchema.index({ conversationId: 1, createdAt: -1 });

export const Message = mongoose.model('Message', MessageSchema);
