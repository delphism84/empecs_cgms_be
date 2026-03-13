import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, unique: true, required: true, index: true },
    passwordHash: { type: String, required: true },
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

UserSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

UserSchema.statics.hashPassword = async function (plain) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
};

export default mongoose.model('User', UserSchema);


