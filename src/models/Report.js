import mongoose from 'mongoose';

export const REPORT_REASONS = ['harassment', 'nudity', 'violence', 'spam', 'underage', 'other'];

const ReportSchema = new mongoose.Schema(
  {
    reporter: { type: String, required: true },
    target: { type: String, required: true },
    roomId: { type: String, default: null },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    note: { type: String, default: '', maxlength: 280 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

ReportSchema.index({ target: 1, createdAt: -1 });
ReportSchema.index({ reporter: 1, target: 1, createdAt: -1 });

export const Report = mongoose.model('Report', ReportSchema);
