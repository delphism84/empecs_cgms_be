import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true },
    passwordHash: { type: String }, // 소셜 로그인 시 null 허용
    provider: { type: String, enum: ['google', 'kakao', 'apple', null], default: null },
    providerId: { type: String }, // sub / id (provider별 고유 ID)
    // debug only (to be removed later)
    passwordOrg: { type: String },
    name: { type: String },
    // req_be_account fields
    firstName: { type: String },
    lastName: { type: String },
    dateOfBirth: { type: String },
    gender: { type: String },
    unit: { type: String, enum: ['mg/dL', 'mmol'], default: 'mg/dL' },
    countryCode: { type: String },
    language: { type: String },
  },
  { timestamps: true }
);

// 소셜 로그인: (provider, providerId) 유일
UserSchema.index({ provider: 1, providerId: 1 }, { unique: true, sparse: true });
// 이메일/비밀번호 계정: email 유일 (provider null인 경우만)
UserSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { provider: null } });

UserSchema.methods.verifyPassword = function (plain) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plain, this.passwordHash);
};

UserSchema.statics.hashPassword = async function (plain) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
};

export default mongoose.model('User', UserSchema);


