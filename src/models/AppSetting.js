import mongoose from 'mongoose';

const appSettingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Types.ObjectId, required: true, unique: true },
    // general app settings
    unit: { type: String, enum: ['mg/dL', 'mmol/L'], default: 'mg/dL' },
    notifications: { type: Boolean, default: true },
    darkMode: { type: Boolean, default: false },
    // arbitrary preferences blob
    preferences: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export default mongoose.models.AppSetting || mongoose.model('AppSetting', appSettingSchema);


