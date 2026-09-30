import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

export const ADMIN_ROLES = ['superadmin', 'operator', 'cs', 'viewer'];

/** 관리자 계정. 예전에는 환경변수의 공용 계정 1개뿐이라 누가 무엇을 했는지 구분할 수 없었다. */
const AdminUserSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, default: '' },
    role: { type: String, enum: ADMIN_ROLES, default: 'viewer' },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    /** 초기 계정·관리자가 재설정한 계정은 첫 로그인 때 비밀번호를 바꾸게 한다. */
    mustChangePassword: { type: Boolean, default: false },
    /** 증가시키면 그 계정의 기존 토큰이 전부 무효가 된다. */
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
    lastLoginIp: { type: String },
    createdBy: { type: String },
  },
  { timestamps: true }
);

AdminUserSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(String(plain || ''), this.passwordHash);
};
AdminUserSchema.statics.hashPassword = async function (plain) {
  return bcrypt.hash(String(plain), await bcrypt.genSalt(10));
};

export default mongoose.models.AdminUser || mongoose.model('AdminUser', AdminUserSchema);
