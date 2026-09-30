import express from 'express';
import http from 'http';
import cors from 'cors';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { config } from './config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { attachDevicesEndingWs } from './ws/devicesEndingWs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const app = express();
app.use(cors());
// 센서 재고 일괄 등록(최대 5,000행)을 받을 수 있게 본문 한도를 올린다.
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// access log (file)
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const accessLogPath = path.join(logsDir, 'access.log');
app.use((req, res, next) => {
  const startedAt = Date.now();
  const { method, originalUrl } = req;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '';
  const safeBody = (() => {
    try {
      const b = req.body && typeof req.body === 'object' ? { ...req.body } : req.body;
      if (b && typeof b === 'object') {
        if (b.password) b.password = '[masked]';
        if (b.token) b.token = '[masked]';
      }
      return JSON.stringify(b);
    } catch (_) { return '[unserializable]'; }
  })();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    const line = `[${new Date().toISOString()}] ${ip} ${method} ${originalUrl} ${res.statusCode} ${ms}ms ua="${ua}" body=${safeBody}\n`;
    try { fs.appendFileSync(accessLogPath, line); } catch (_) {}
  });
  next();
});

// db
mongoose.set('strictQuery', true);
let mem = null;
async function connectMongo() {
  const wantMem = process.env.MONGO_MEMORY === '1' || process.env.MONGO_MEMORY === 'true';
  if (wantMem) {
    mem = await MongoMemoryServer.create({ instance: { dbName: config.mongo.DatabaseName } });
    const uri = mem.getUri();
    await mongoose.connect(uri, { dbName: config.mongo.DatabaseName });
    console.log('[mongo] connected (memory)');
    return;
  }
  try {
    await mongoose.connect(config.mongo.ConnectionString, { dbName: config.mongo.DatabaseName, serverSelectionTimeoutMS: 5000 });
    console.log('[mongo] connected');
  } catch (err) {
    console.error('[mongo] connection error; falling back to in-memory mongo', err?.message || err);
    mem = await MongoMemoryServer.create({ instance: { dbName: config.mongo.DatabaseName } });
    const uri = mem.getUri();
    await mongoose.connect(uri, { dbName: config.mongo.DatabaseName });
    console.log('[mongo] connected (memory fallback)');
  }
}

/**
 * 기동 시 1회 정리·준비.
 * - 평문 비밀번호 사본(passwordOrg) 삭제: 예전 가입 코드가 디버그용으로 저장하던 값
 * - 최초 관리자 계정 생성, 시스템 설정 로드, 센서 재고(SN 대장) 동기화
 * (예전의 고정 비밀번호 기본 회원 'empecs' 자동 생성은 없앴다.)
 */
async function startupTasks() {
  const { default: User } = await import('./models/User.js');
  try {
    const r = await User.collection.updateMany({ passwordOrg: { $exists: true } }, { $unset: { passwordOrg: 1 } });
    if (r.modifiedCount) console.log(`[startup] removed plaintext password copies from ${r.modifiedCount} users`);
  } catch (e) {
    console.warn('[startup] passwordOrg cleanup:', e?.message || e);
  }
  const { seedInitialAdmin } = await import('./admin/auth.js');
  await seedInitialAdmin();
  const { backfillUnits } = await import('./lib/deviceRegistry.js');
  try {
    const b = await backfillUnits();
    console.log(`[startup] device registry synced: eqs=${b.eqs} created=${b.created} updated=${b.updated} cleared=${b.cleared}`);
  } catch (e) {
    console.warn('[startup] device registry sync:', e?.message || e);
  }
  // 동기화 감시용 마지막 업로드 시각: 값이 없는 센서 보유 회원만 최근 혈당 시각으로 채운다.
  try {
    const { default: Eq } = await import('./models/Eq.js');
    const { default: GlucosePoint } = await import('./models/GlucosePoint.js');
    const owners = await Eq.distinct('userId');
    const missing = await User.find({ _id: { $in: owners }, lastUploadAt: { $exists: false } }).select('_id').lean();
    for (const u of missing) {
      const last = await GlucosePoint.findOne({ userId: u._id }).sort({ time: -1 }).select('time createdAt').lean();
      if (last) await User.updateOne({ _id: u._id }, { $set: { lastUploadAt: last.createdAt || last.time } });
    }
    if (missing.length) console.log(`[startup] lastUploadAt backfilled for ${missing.length} users`);
  } catch (e) {
    console.warn('[startup] lastUploadAt backfill:', e?.message || e);
  }
}

// models
import './models/User.js';
import './models/GlucosePoint.js';
import './models/Event.js';
import './models/Eq.js';

// routes
import authRouter from './routes/auth.js';
import dataRouter from './routes/data.js';
import settingsRouter from './routes/settings.js';
import adminRouter from './routes/admin.js';

app.use('/api/auth', authRouter);
app.use('/api/data', dataRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/admin', adminRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// 앱용 공지 목록(공개). 게시 중이고 기간 내인 것만, 고정 공지 먼저.
app.get('/api/notices', async (req, res) => {
  try {
    const { default: Notice } = await import('./models/Notice.js');
    const now = new Date();
    const lang = String(req.query.lang || '').trim().toLowerCase().slice(0, 8);
    const q = { active: true, publishAt: { $lte: now }, $or: [{ expireAt: null }, { expireAt: { $exists: false } }, { expireAt: { $gt: now } }] };
    if (lang) q.language = { $in: ['', lang] };
    const rows = await Notice.find(q).sort({ pinned: -1, publishAt: -1 }).limit(50).lean();
    res.json({ items: rows.map((n) => ({ id: n._id.toString(), title: n.title, body: n.body || '', language: n.language || '', pinned: !!n.pinned, publishAt: n.publishAt })) });
  } catch (e) {
    console.error('[notices]', e?.message || e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// FE 참조용 API 문서 (Markdown). nginx: location ^~ /api/ → BE
function sendMarkdownDoc(relName) {
  return (_req, res, next) => {
    const p = path.join(__dirname, '..', 'docs', relName);
    if (!fs.existsSync(p)) return res.status(404).type('text/plain').send(`${relName} not found`);
    res.type('text/markdown; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=120');
    res.sendFile(p, (err) => (err ? next(err) : undefined));
  };
}
app.get('/api/docs', sendMarkdownDoc('api.md'));
app.get('/api/docs/api.md', sendMarkdownDoc('api.md'));
app.get('/api/docs/api_rev_260417a.md', sendMarkdownDoc('api_rev_260417a.md'));
app.get('/api/docs/api_rev_260504.md', sendMarkdownDoc('api_rev_260504.md'));

// 소셜 로그인 테스트 페이지
const logintestPath = path.join(publicDir, 'logintest.html');
const redirectPath = path.join(publicDir, 'logintest-redirect.html');
if (fs.existsSync(logintestPath)) {
  app.get('/logintest.html', (_req, res) => res.type('text/html').send(fs.readFileSync(logintestPath, 'utf-8')));
}
// 리다이렉트 전용 (redirectURI: /auth/callback)
if (fs.existsSync(redirectPath)) {
  const redirectHtml = fs.readFileSync(redirectPath, 'utf-8');
  app.get('/logintest-redirect.html', (_req, res) => res.type('text/html').send(redirectHtml));
  app.get('/auth/callback', (_req, res) => res.type('text/html').send(redirectHtml));
} else if (fs.existsSync(logintestPath)) {
  app.get('/auth/callback', (_req, res) => res.type('text/html').send(fs.readFileSync(logintestPath, 'utf-8')));
}

async function main() {
  await connectMongo();
  const { default: UserModel } = await import('./models/User.js');
  try {
    await UserModel.syncIndexes();
  } catch (e) {
    console.warn('[mongo] syncIndexes(users):', e?.message || e);
  }
  await startupTasks();
  const server = http.createServer(app);
  attachDevicesEndingWs(server);
  server.listen(config.port, config.host, () => console.log(`[server] listening on ${config.host}:${config.port}`));
}

main().catch((e) => {
  console.error('[server] fatal', e?.message || e);
  process.exit(1);
});


