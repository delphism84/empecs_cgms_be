import mongoose from 'mongoose';

/** 생산 로트(묶음). 센서 재고(DeviceUnit)가 lotCode 로 참조한다. */
const LotSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    model: { type: String, default: '' },
    manufacturedAt: { type: Date },
    note: { type: String, default: '' },
    createdBy: { type: String },
  },
  { timestamps: true }
);

export default mongoose.models.Lot || mongoose.model('Lot', LotSchema);
