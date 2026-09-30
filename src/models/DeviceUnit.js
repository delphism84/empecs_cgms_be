import mongoose from 'mongoose';

/**
 * 센서 재고(SN 대장). Eq(앱 등록 기록)와 serial 로 1:1 대응한다.
 *
 * Eq 는 앱이 QR 을 찍어야만 생기므로 출고 전 재고·차단·로트를 표현할 수 없었다.
 * 여기에는 관리자가 등록한 SN 과, 앱이 등록했지만 재고에 없던 SN(source='app', verified=false)이 함께 들어간다.
 * startAt/ownerId 는 Eq 에서 복제한 값이다(목록 필터·정렬용). 원본은 항상 Eq — lib/deviceRegistry.js 가 동기화한다.
 */
const DeviceUnitSchema = new mongoose.Schema(
  {
    serial: { type: String, required: true, unique: true, uppercase: true, trim: true },
    bleMac: { type: String, sparse: true, unique: true },
    model: { type: String, default: '' },
    yearCode: { type: String, default: '' },
    sample: { type: Boolean, default: false },
    seq: { type: Number },
    formatOk: { type: Boolean, default: true },
    lotCode: { type: String, default: '', index: true },
    manufacturedAt: { type: Date },
    /** 관리자가 직접 바꾸는 단계. 등록/사용중/만료는 startAt 에서 계산한다. */
    stage: { type: String, enum: ['stock', 'shipped'], default: 'stock' },
    shippedAt: { type: Date },
    shippedTo: { type: String, default: '' },
    blocked: { type: Boolean, default: false, index: true },
    blockedReason: { type: String, default: '' },
    blockedAt: { type: Date },
    source: { type: String, enum: ['admin', 'import', 'app'], default: 'admin', index: true },
    /** 재고로 확인된 SN 인가. 앱이 먼저 등록한 미확인 SN 은 false. */
    verified: { type: Boolean, default: true, index: true },
    note: { type: String, default: '' },
    // Eq 복제 필드
    startAt: { type: Date, index: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    registeredAt: { type: Date },
    createdBy: { type: String },
  },
  { timestamps: true }
);

export default mongoose.models.DeviceUnit || mongoose.model('DeviceUnit', DeviceUnitSchema);
