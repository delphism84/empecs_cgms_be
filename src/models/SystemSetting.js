import mongoose from 'mongoose';

/** 단일 문서(_id: 'global') 시스템 설정. 기본값과 접근은 lib/settingsStore.js. */
const SystemSettingSchema = new mongoose.Schema(
  { _id: { type: String }, values: { type: mongoose.Schema.Types.Mixed, default: {} }, updatedBy: { type: String } },
  { timestamps: true, minimize: false }
);

export default mongoose.models.SystemSetting || mongoose.model('SystemSetting', SystemSettingSchema);
