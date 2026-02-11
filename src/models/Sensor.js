import mongoose from 'mongoose';

const sensorSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    serial: { type: String },
    isActive: { type: Boolean, default: true },
    // calibration params
    offset: { type: Number, default: 0 },
    scale: { type: Number, default: 1 },
  },
  { timestamps: true }
);

export default mongoose.models.Sensor || mongoose.model('Sensor', sensorSchema);


