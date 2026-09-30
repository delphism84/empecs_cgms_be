import mongoose from 'mongoose';

/** 로그인 시도 기록(관리자·회원 공용). 성공/실패와 사유를 남긴다. */
const LoginLogSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    kind: { type: String, enum: ['admin', 'user'], required: true, index: true },
    subjectId: { type: String, index: true },
    identifier: { type: String, index: true },
    success: { type: Boolean, required: true },
    reason: { type: String },
    method: { type: String },
    ip: { type: String },
    userAgent: { type: String },
  },
  { versionKey: false }
);
LoginLogSchema.index({ kind: 1, at: -1 });

export default mongoose.models.LoginLog || mongoose.model('LoginLog', LoginLogSchema);
