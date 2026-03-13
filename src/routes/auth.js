import express from 'express';
import jwt from 'jsonwebtoken';
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
    if (exists) return res.status(409).json({ ok: false, error: 'email_exists' });

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

export default router;


