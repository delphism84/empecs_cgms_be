import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { config } from './config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoMemoryServer } from 'mongodb-memory-server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const app = express();
app.use(cors());
app.use(express.json());
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

async function seedDefaultUser() {
  // seed default account if not exists
  const { default: User } = await import('./models/User.js');
  const email = 'empecs';
  const exists = await User.findOne({ email }).lean();
  if (!exists) {
    const passwordHash = await User.hashPassword('admin');
    await User.create({ email, passwordHash, name: 'EMPECS Admin' });
    console.log('[seed] created default user empecs/admin');
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
  await seedDefaultUser();
  app.listen(config.port, config.host, () => console.log(`[server] listening on ${config.host}:${config.port}`));
}

main().catch((e) => {
  console.error('[server] fatal', e?.message || e);
  process.exit(1);
});


