import mongoose from 'mongoose';

const GlucosePointSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    eqsn: { type: String, index: true },
    time: { type: Date, index: true },
    value: { type: Number },
    trid: { type: Number, index: true }, // CGMS Transaction ID (monotonic per-session)
  },
  { timestamps: true }
);

GlucosePointSchema.index({ userId: 1, time: -1 });
GlucosePointSchema.index({ userId: 1, trid: -1 });
GlucosePointSchema.index({ userId: 1, eqsn: 1, time: -1 });

export default mongoose.model('GlucosePoint', GlucosePointSchema);


