import mongoose from 'mongoose';

const NoticeSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    body: { type: String, default: '' },
    /** '' = 모든 언어 */
    language: { type: String, default: '' },
    pinned: { type: Boolean, default: false },
    active: { type: Boolean, default: true, index: true },
    publishAt: { type: Date, default: Date.now },
    expireAt: { type: Date },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

export default mongoose.models.Notice || mongoose.model('Notice', NoticeSchema);
