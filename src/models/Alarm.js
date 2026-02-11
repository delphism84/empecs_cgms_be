import mongoose from 'mongoose';

const alarmSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Types.ObjectId, required: true, index: true },
    type: { type: String, enum: ['very_low', 'low', 'high', 'rate', 'system'], required: true },
    enabled: { type: Boolean, default: true },
    threshold: { type: Number },
    // optional quiet hours
    quietFrom: { type: String }, // '22:00'
    quietTo: { type: String }, // '07:00'
    // notification options
    sound: { type: Boolean, default: true },
    vibrate: { type: Boolean, default: true },
    repeatMin: { type: Number, default: 10 },
    // very-low only: try to behave like critical alert (platform dependent)
    overrideDnd: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.models.Alarm || mongoose.model('Alarm', alarmSchema);


