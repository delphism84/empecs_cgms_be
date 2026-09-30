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

// OAuth (docs/cgms info.csv 또는 환경변수에 보관, 저장소 커밋 금지)
const oauthCfg = fileCfg.OAuth || {};
const oauthEnv = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || oauthCfg.GoogleClientId,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || oauthCfg.GoogleClientSecret,
  },
  kakao: {
    restApiKey: process.env.KAKAO_REST_API_KEY || oauthCfg.KakaoRestApiKey,
    clientSecret: process.env.KAKAO_CLIENT_SECRET || oauthCfg.KakaoClientSecret,
  },
  apple: {
    clientId: process.env.APPLE_CLIENT_ID || oauthCfg.AppleClientId,
    teamId: process.env.APPLE_TEAM_ID || oauthCfg.AppleTeamId,
    keyId: process.env.APPLE_KEY_ID || oauthCfg.AppleKeyId,
    privateKey: process.env.APPLE_PRIVATE_KEY || oauthCfg.ApplePrivateKey,
  },
};
const baseUrl = process.env.BASE_URL || oauthCfg.BaseUrl || 'https://empecs.lunarsystem.co.kr';

const adminCfg = fileCfg.Admin || {};

export const config = {
  host: process.env.HOST || fileCfg.Host || (fileCfg.Server && fileCfg.Server.Host) || '0.0.0.0',
  port: Number(process.env.PORT || fileCfg.Port || (fileCfg.Server && fileCfg.Server.Port) || 58002),
  jwtSecret: process.env.JWT_SECRET || fileCfg.JwtSecret || 'change-me',
  // 사용자 JWT 유효기간. 앱이 사용 중 매일 /api/auth/refresh 로 갱신하므로(슬라이딩 세션)
  // 이 기간 동안 앱을 한 번도 쓰지 않은 경우에만 재로그인이 필요하다.
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || fileCfg.JwtExpiresIn || '30d',
  mongo: mongoCfg,
  oauth: oauthEnv,
  baseUrl,
  admin: {
    username: process.env.ADMIN_USERNAME || adminCfg.Username || 'admin',
    // 기본값 없음: 값이 없으면 최초 관리자 비밀번호를 무작위로 만들어 서버 로그에 1회 출력한다(admin/auth.js).
    password: process.env.ADMIN_PASSWORD || adminCfg.Password || '',
  },
};


