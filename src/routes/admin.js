import express from 'express';
import accounts from './admin/accounts.js';
import stats from './admin/stats.js';
import users from './admin/users.js';
import devices from './admin/devices.js';
import ops from './admin/ops.js';

/**
 * 관리자 API (/api/admin).
 * - accounts : 로그인·내 계정·관리자 계정 관리
 * - stats    : 대시보드 통계(전체·국가별)
 * - users    : 회원 관리
 * - devices  : 센서 재고(SN)·QR·로트·등록 조치
 * - ops      : 동기화 감시·데이터·공지·설정·감사/로그인 기록·초기화
 * 권한은 admin/auth.js 의 역할표(ROLE_PERMS)를 따른다.
 */
const router = express.Router();

// 로그인 등 인증 전 경로가 있는 accounts 를 먼저 건다(나머지는 라우터 전체가 requireAdmin).
router.use(accounts);
router.use(stats);
router.use(users);
router.use(devices);
router.use(ops);

export { requireAdmin } from '../admin/auth.js';
export default router;
