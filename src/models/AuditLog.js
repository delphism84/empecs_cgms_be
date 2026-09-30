import mongoose from 'mongoose';

/** 관리자 변경 작업 기록: 누가·언제·무엇을·변경 전/후. */
const AuditLogSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    actorId: { type: String, index: true },
    actorName: { type: String },
    actorRole: { type: String },
    action: { type: String, required: true, index: true },
    targetType: { type: String, index: true },
    targetId: { type: String, index: true },
    targetLabel: { type: String },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    note: { type: String },
    ip: { type: String },
    userAgent: { type: String },
    success: { type: Boolean, default: true },
  },
  { versionKey: false }
);

export default mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);
