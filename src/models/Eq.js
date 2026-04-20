import mongoose from 'mongoose';

const EqSchema = new mongoose.Schema(
  {
    serial: { type: String, required: true, unique: true, index: true },
    /** Uppercase hex, no separators (e.g. A1B2C3D4E5F6). Sparse unique when set. */
    bleMac: { type: String, sparse: true, unique: true },
    startAt: { type: Date, required: true },
    /** Last registering user; used with createdBy/updatedBy for ownership checks. */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.models.Eq || mongoose.model('Eq', EqSchema);


