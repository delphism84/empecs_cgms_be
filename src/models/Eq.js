import mongoose from 'mongoose';

const EqSchema = new mongoose.Schema(
  {
    serial: { type: String, required: true, unique: true, index: true },
    startAt: { type: Date, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.models.Eq || mongoose.model('Eq', EqSchema);


