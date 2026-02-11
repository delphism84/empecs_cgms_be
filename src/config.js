import dotenv from 'dotenv';
dotenv.config();

// 우선순위: ENV > config.json > 하드코딩 기본값
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configPath = path.join(__dirname, '..', 'config.json');
let fileCfg = {};
if (fs.existsSync(configPath)) {
  try {
    fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) || {};
  } catch (_) {
    fileCfg = {};
  }
}

const mongoCfg = process.env.MONGO_URI
  ? { ConnectionString: process.env.MONGO_URI, DatabaseName: process.env.MONGO_DB || 'empecs_cgms' }
  : (fileCfg.MongoDb || {
      ConnectionString: 'mongodb://localhost:27017/empecs_cgms',
      DatabaseName: 'empecs_cgms',
    });

export const config = {
  host: process.env.HOST || fileCfg.Host || (fileCfg.Server && fileCfg.Server.Host) || '0.0.0.0',
  port: Number(process.env.PORT || fileCfg.Port || (fileCfg.Server && fileCfg.Server.Port) || 58002),
  jwtSecret: process.env.JWT_SECRET || fileCfg.JwtSecret || 'change-me',
  mongo: mongoCfg,
};


