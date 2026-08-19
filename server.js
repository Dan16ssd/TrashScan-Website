'use strict';

require('dotenv').config();
const express = require('express');
const cors   = require('cors');
const path   = require('path');

const app    = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory scan history (shared across routes)
const scanHistory = [];

// ── Firebase client config ────────────────────────────────────────────────────
app.get('/api/firebase-config', (_req, res) => {
  res.json({
    apiKey:     process.env.FIREBASE_API_KEY     || '',
    projectId:  process.env.FIREBASE_PROJECT_ID  || '',
    configured: !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_API_KEY),
  });
});

// ── Mount routes ──────────────────────────────────────────────────────────────
const recyclingGuidelines = require('./data/recycling-guidelines.json');
app.get('/api/guidelines', (_req, res) => res.json(recyclingGuidelines));

const scanRouter = require('./routes/scan');
scanRouter.setScanHistory(scanHistory);
app.use('/api', scanRouter.router);

// ── Server-side scan data (bypasses Firestore client security rules) ──────────
app.get('/api/scans', async (req, res) => {
  try {
    const db = require('./utils/firebase-admin').getDb();
    if (!db) return res.json({ scans: [], error: 'Firestore not configured' });

    const { period = 'today', org_id } = req.query;
    const now = new Date();
    let since;
    if (period === 'week')  { since = new Date(now); since.setDate(since.getDate() - 7); }
    else if (period === 'month') { since = new Date(now); since.setDate(since.getDate() - 30); }
    else { since = new Date(now); since.setHours(0, 0, 0, 0); }

    let q = db.collection('scans')
      .where('timestamp', '>=', since)
      .orderBy('timestamp', 'desc')
      .limit(500);

    if (org_id) {
      q = db.collection('scans')
        .where('org_id', '==', org_id)
        .where('timestamp', '>=', since)
        .orderBy('timestamp', 'desc')
        .limit(500);
    }

    const snap = await q.get();
    const includeInUse = req.query.include_in_use === '1';
    const scans = [];
    snap.forEach(doc => {
      const d = doc.data();
      // Items the AI judged as still in use (not discarded) stay off the public map
      if (d.in_use === true && !includeInUse) return;
      scans.push({
        id: doc.id,
        item_name: d.item_name || '',
        category: d.category || '',
        location_name: d.location_name || '',
        latitude: d.latitude || null,
        longitude: d.longitude || null,
        gps_accuracy: d.gps_accuracy || null,
        regen_points: d.regen_points || 10,
        user_id: d.user_id || 'anon',
        org_id: d.org_id || null,
        in_use: d.in_use === true,
        timestamp: d.timestamp && d.timestamp.toDate ? d.timestamp.toDate().toISOString() : null,
      });
    });

    res.json({ scans });
  } catch (err) {
    console.error('/api/scans error:', err);
    res.status(500).json({ scans: [], error: err.message });
  }
});

const authRouter = require('./routes/auth');
app.use('/api', authRouter);

const adminModule = require('./routes/admin');
adminModule.setScanHistory(scanHistory);
app.use('/api/admin', adminModule.router);

const chatRouter = require('./routes/chat');
app.use('/api', chatRouter);

const communityRouter = require('./routes/community');
app.use('/api/community', communityRouter);

// ── Error handlers ────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

// ── Start server ────────────────────────────────────────────────────────────
// Vercel imports `app` and wraps it as a serverless function — it must not
// call listen() itself. Local/Render runs still start a normal HTTP server.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`SARA server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
