import mongoose from 'mongoose';

const EventSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    eqsn: { type: String, index: true },
    type: { type: String, enum: ['bloodGlucose', 'exercise', 'insulin', 'memo', 'meal', 'medication'], index: true },
    time: { type: Date, index: true },
    memo: { type: String },
  },
  { timestamps: true }
);

EventSchema.index({ userId: 1, time: -1 });
EventSchema.index({ userId: 1, eqsn: 1, time: -1 });

export default mongoose.model('Event', EventSchema);


