import mongoose from 'mongoose';

/** 센서 등록 이력. Eq 는 재등록 때 startAt 을 덮어쓰므로 과거 세션이 남지 않았다. */
const EqHistorySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    serial: { type: String, required: true, index: true },
    action: {
      type: String,
      enum: ['register', 'reregister', 'release', 'transfer', 'start_fix', 'block', 'unblock', 'rejected'],
      required: true,
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    startAt: { type: Date },
    prevUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    prevStartAt: { type: Date },
    byKind: { type: String, enum: ['user', 'admin', 'system'], default: 'user' },
    byId: { type: String },
    byName: { type: String },
    note: { type: String },
  },
  { versionKey: false }
);

export default mongoose.models.EqHistory || mongoose.model('EqHistory', EqHistorySchema);
