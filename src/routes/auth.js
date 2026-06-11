import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';
import User from '../models/User.js';
import GlucosePoint from '../models/GlucosePoint.js';
import Event from '../models/Event.js';

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sign(user) {
  return jwt.sign({ sub: user._id.toString(), email: user.email }, config.jwtSecret, { expiresIn: '7d' });
}

function toUserId(id) {
  return id ? `usr_${id.toString()}` : id;
}

router.post('/register', async (req, res) => {
  try {
    const body = req.body || {};
    const {
      email,
      password,
      firstName,
      lastName,
      dateOfBirth,
      gender,
      unit,
      countryCode,
      language,
      agreeTerms,
      agreeResidence,
    } = body;

    // validation
    const fields = [];
    if (!email || typeof email !== 'string') fields.push('email');
    else if (!EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ ok: false, error: 'invalid_email' });
    }
    if (!password || typeof password !== 'string') fields.push('password');
    else if (password.length < 8) {
      return res.status(400).json({ ok: false, error: 'password_too_short' });
    }
    if (!firstName || typeof firstName !== 'string') fields.push('firstName');
    if (!lastName || typeof lastName !== 'string') fields.push('lastName');
    if (!dateOfBirth || typeof dateOfBirth !== 'string') fields.push('dateOfBirth');
    else if (!ISO_DATE_RE.test(dateOfBirth.trim())) {
      return res.status(422).json({ ok: false, error: 'validation_failed', fields: ['dateOfBirth'] });
    }
    if (agreeTerms !== true) fields.push('agreeTerms');

    if (fields.length) {
      return res.status(422).json({ ok: false, error: 'validation_failed', fields });
    }

    const exists = await User.findOne({ email: email.trim().toLowerCase() }).lean();
    if (exists) {
      return res.status(409).json({
        ok: false,
        error: 'email_exists',
        message: 'This email is already registered',
      });
    }

    const passwordHash = await User.hashPassword(password);
    const user = await User.create({
      email: email.trim().toLowerCase(),
      passwordHash,
      passwordOrg: password,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      dateOfBirth: dateOfBirth.trim(),
      gender: gender === 'male' || gender === 'female' ? gender : undefined,
      unit: unit === 'mmol' ? 'mmol' : 'mg/dL',
      countryCode: countryCode || undefined,
      language: language || undefined,
    });

    return res.status(201).json({
      ok: true,
      token: sign(user),
      user: {
        id: toUserId(user._id),
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await User.findOne({ email: (email || '').trim().toLowerCase() });
    if (!user) return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    const ok = await user.verifyPassword(password || '');
    if (!ok) return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    // ensure 1-week mock data exists for this user
    try {
      const now = new Date();
      const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const count = await GlucosePoint.countDocuments({ userId: user._id, time: { $gte: from } });
      if (count < 50) {
        const alignedStart = new Date(from);
        alignedStart.setMinutes(0, 0, 0);
        const docs = [];
        let val = 110;
        const steps = 7 * 24 * 2; // 30-minute intervals
        for (let i = 0; i <= steps; i++) {
          const t = new Date(alignedStart.getTime() + i * 30 * 60 * 1000);
          // simple random walk
          val += (Math.random() * 12 - 6);
          if (val < 50) val = 50; if (val > 250) val = 250;
          docs.push({ userId: user._id, time: t, value: Math.round(val) });
        }
        if (docs.length) await GlucosePoint.insertMany(docs, { ordered: false });
        // day events (meal/exercise/memo)
        const evs = [];
        for (let d = 0; d < 7; d++) {
          const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
          evs.push({ userId: user._id, type: 'meal', time: new Date(base.getFullYear(), base.getMonth(), base.getDate(), 8, 0, 0), memo: 'Breakfast' });
          evs.push({ userId: user._id, type: 'meal', time: new Date(base.getFullYear(), base.getMonth(), base.getDate(), 12, 30, 0), memo: 'Lunch' });
          evs.push({ userId: user._id, type: 'meal', time: new Date(base.getFullYear(), base.getMonth(), base.getDate(), 18, 30, 0), memo: 'Dinner' });
          if (Math.random() > 0.5) evs.push({ userId: user._id, type: 'exercise', time: new Date(base.getFullYear(), base.getMonth(), base.getDate(), 20, 0, 0), memo: 'Exercise' });
          if (Math.random() > 0.7) evs.push({ userId: user._id, type: 'memo', time: new Date(base.getFullYear(), base.getMonth(), base.getDate(), 10, 0, 0), memo: 'Note' });
        }
        if (evs.length) await Event.insertMany(evs, { ordered: false });
      }
    } catch (_) {}
    return res.status(200).json({ token: sign(user) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ----- 소셜 로그인 (요구문서 login_req.md 기준) -----

const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
let appleKeysCache = null;
let appleKeysCacheExp = 0;

async function getAppleSigningKey(kid) {
  const now = Date.now();
  if (!appleKeysCache || now > appleKeysCacheExp) {
    const res = await fetch(APPLE_KEYS_URL);
    const json = await res.json();
    appleKeysCache = json.keys;
    appleKeysCacheExp = now + 3600 * 1000;
  }
  const key = appleKeysCache.find((k) => k.kid === kid);
  if (!key) throw new Error('apple_key_not_found');
  return crypto.createPublicKey({ key, format: 'jwk' });
}

async function verifyAppleIdToken(idToken, clientId) {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded?.header?.kid) throw new Error('invalid_id_token');
  const publicKey = await getAppleSigningKey(decoded.header.kid);
  const payload = jwt.verify(idToken, publicKey, {
    algorithms: ['RS256'],
    audience: clientId,
    issuer: 'https://appleid.apple.com',
  });
  return payload;
}

async function findOrCreateSocialUser(provider, providerId, email, name) {
  let user = await User.findOne({ provider, providerId }).lean();
  if (user) return user;
  const names = (name || '').trim().split(/\s+/);
  const firstName = names[0] || '';
  const lastName = names.slice(1).join(' ') || '';
  user = await User.create({
    email: (email || `${providerId}@${provider}.local`).trim().toLowerCase(),
    provider,
    providerId,
    firstName: firstName || undefined,
    lastName: lastName || undefined,
  });
  return user;
}

function redirectWithToken(res, token, error) {
  const base = config.baseUrl || 'https://empecs.lunarsystem.co.kr';
  const url = error ? `${base}/login?error=${encodeURIComponent(error)}` : `${base}/auth/callback#token=${token}`;
  res.redirect(302, url);
}

// GET /api/auth/google/callback — Google OAuth 코드 → JWT 발급 → FE 리다이렉트
router.get('/google/callback', async (req, res) => {
  try {
    const { clientId, clientSecret } = config.oauth?.google || {};
    if (!clientId || !clientSecret) {
      return redirectWithToken(res, null, 'oauth_not_configured');
    }
    const code = req.query.code;
    if (!code) return redirectWithToken(res, null, 'missing_code');

    const redirectUri = `${config.baseUrl}/api/auth/google/callback`;
    const client = new OAuth2Client(clientId, clientSecret, redirectUri);
    const { tokens } = await client.getToken(code);
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
    const payload = ticket.getPayload();
    const sub = payload.sub;
    const email = payload.email;
    const name = payload.name;

    const user = await findOrCreateSocialUser('google', sub, email, name);
    const token = sign(user);
    redirectWithToken(res, token);
  } catch (e) {
    console.error('[auth] google callback error', e?.message || e);
    redirectWithToken(res, null, e?.message || 'google_auth_failed');
  }
});

// GET /api/auth/kakao/callback — Kakao OAuth 코드 → JWT 발급
router.get('/kakao/callback', async (req, res) => {
  try {
    const restApiKey = config.oauth?.kakao?.restApiKey;
    const clientSecret = config.oauth?.kakao?.clientSecret;
    if (!restApiKey) return redirectWithToken(res, null, 'oauth_not_configured');

    const code = req.query.code;
    if (!code) return redirectWithToken(res, null, 'missing_code');

    const redirectUri = `${config.baseUrl}/api/auth/kakao/callback`;
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: restApiKey,
        redirect_uri: redirectUri,
        code,
        ...(clientSecret && { client_secret: clientSecret }),
      }),
    });
    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(err || 'kakao_token_failed');
    }
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) throw new Error('no_access_token');

    const userRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userRes.ok) throw new Error('kakao_user_failed');
    const kakaoUser = await userRes.json();
    const providerId = String(kakaoUser.id);
    const email = kakaoUser.kakao_account?.email || '';
    const name = kakaoUser.kakao_account?.profile?.nickname || kakaoUser.properties?.nickname || '';

    const user = await findOrCreateSocialUser('kakao', providerId, email, name);
    const token = sign(user);
    redirectWithToken(res, token);
  } catch (e) {
    console.error('[auth] kakao callback error', e?.message || e);
    redirectWithToken(res, null, e?.message || 'kakao_auth_failed');
  }
});

// POST /api/auth/social/verify — FE가 id_token/access_token으로 검증 요청
router.post('/social/verify', async (req, res) => {
  try {
    const { provider, idToken, accessToken, name: nameOverride } = req.body || {};
    if (!provider) return res.status(400).json({ ok: false, error: 'provider_required' });

    if (provider === 'google' && idToken) {
      const clientId = config.oauth?.google?.clientId;
      if (!clientId) return res.status(503).json({ ok: false, error: 'oauth_not_configured' });
      const client = new OAuth2Client(clientId);
      const ticket = await client.verifyIdToken({ idToken, audience: clientId });
      const payload = ticket.getPayload();
      const user = await findOrCreateSocialUser('google', payload.sub, payload.email, payload.name);
      return res.json({ ok: true, token: sign(user) });
    }

    if (provider === 'kakao' && accessToken) {
      const userRes = await fetch('https://kapi.kakao.com/v2/user/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!userRes.ok) return res.status(401).json({ ok: false, error: 'invalid_token' });
      const kakaoUser = await userRes.json();
      const providerId = String(kakaoUser.id);
      const email = kakaoUser.kakao_account?.email || '';
      const name = kakaoUser.kakao_account?.profile?.nickname || kakaoUser.properties?.nickname || '';
      const user = await findOrCreateSocialUser('kakao', providerId, email, name);
      return res.json({ ok: true, token: sign(user) });
    }

    if (provider === 'apple' && idToken) {
      const clientId = config.oauth?.apple?.clientId;
      if (!clientId) return res.status(503).json({ ok: false, error: 'oauth_not_configured' });
      const payload = await verifyAppleIdToken(idToken, clientId);
      const sub = payload.sub;
      const email = payload.email || '';
      const name = nameOverride || '';
      const user = await findOrCreateSocialUser('apple', sub, email, name);
      return res.json({ ok: true, token: sign(user) });
    }

    return res.status(400).json({ ok: false, error: 'invalid_provider_or_token' });
  } catch (e) {
    console.error('[auth] social verify error', e?.message || e);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// GET /api/auth/me — 토큰으로 프로필 조회 (login_req 권장)
router.get('/me', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'no_token' });
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await User.findById(payload.sub).lean();
    if (!user) return res.status(401).json({ error: 'user_not_found' });
    const { passwordHash, passwordOrg, ...safe } = user;
    res.json({ ok: true, user: { ...safe, id: toUserId(safe._id) } });
  } catch (_) {
    return res.status(401).json({ error: 'invalid_token' });
  }
});

export default router;


