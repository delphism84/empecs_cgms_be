import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import User from '../models/User.js';
import GlucosePoint from '../models/GlucosePoint.js';
import Event from '../models/Event.js';

const router = express.Router();

function sign(user) {
  return jwt.sign({ sub: user._id.toString(), email: user.email }, config.jwtSecret, { expiresIn: '7d' });
}

router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    const exists = await User.findOne({ email }).lean();
    if (exists) return res.status(409).json({ error: 'email already exists' });
    const passwordHash = await User.hashPassword(password);
    const user = await User.create({ email, passwordHash, passwordOrg: password, name });
    return res.json({ token: sign(user), user: { id: user._id, email: user.email, name: user.name } });
  } catch (e) {
    return res.status(500).json({ error: 'register_failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });
    const ok = await user.verifyPassword(password || '');
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
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
    return res.json({ token: sign(user), user: { id: user._id, email: user.email, name: user.name } });
  } catch (e) {
    return res.status(500).json({ error: 'login_failed' });
  }
});

export default router;


