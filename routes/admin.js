'use strict';

const express      = require('express');
const router       = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb, getOrgBins, setOrgBin, deleteOrgBin } = require('../utils/firebase-admin');

let _scanHistory = null;

function setScanHistory(sh) { _scanHistory = sh; }

// GET /api/admin/bins
router.get('/bins', requireAuth, async (req, res) => {
  const org_id = req.user && req.user.org_id;
  if (!org_id) return res.status(403).json({ error: 'No organization associated with this account' });
  try {
    const bins = await getOrgBins(org_id);
    res.json(bins);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load bins' });
  }
});

// PUT /api/admin/bins/:id
router.put('/bins/:id', requireAuth, async (req, res) => {
  const org_id = req.user && req.user.org_id;
  if (!org_id) return res.status(403).json({ error: 'No organization associated with this account' });
  const { id } = req.params;

  try {
    const bins = await getOrgBins(org_id);
    const bin  = bins[id];
    if (!bin) return res.status(404).json({ error: 'Bin not found' });

    const { location, fillLevel, name } = req.body;
    if (location  !== undefined) bin.location  = location;
    if (name      !== undefined) bin.name      = name;
    if (fillLevel !== undefined) {
      bin.fillLevel = Math.max(0, Math.min(100, Number(fillLevel)));
      bin.status = bin.fillLevel > 85 ? 'full' : bin.fillLevel > 60 ? 'warning' : 'ok';
    }

    await setOrgBin(org_id, id, bin);

    if (_scanHistory) {
      _scanHistory.unshift({ timestamp: new Date().toISOString(), binId: id, binName: bin.name, material: bin.lastMaterial || '—', action: 'Admin updated' });
      if (_scanHistory.length > 200) _scanHistory.length = 200;
    }
    res.json(bin);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update bin' });
  }
});

// DELETE /api/admin/bins/:id
router.delete('/bins/:id', requireAuth, async (req, res) => {
  const org_id = req.user && req.user.org_id;
  if (!org_id) return res.status(403).json({ error: 'No organization associated with this account' });
  const { id } = req.params;

  try {
    await deleteOrgBin(org_id, id);
    res.json({ message: `Bin ${id} removed` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete bin' });
  }
});

// POST /api/admin/bins
router.post('/bins', requireAuth, async (req, res) => {
  const org_id = req.user && req.user.org_id;
  if (!org_id) return res.status(403).json({ error: 'No organization associated with this account' });
  const { id, name, location } = req.body;
  if (!id || !name || !location) return res.status(400).json({ error: 'id, name, and location are required' });

  try {
    const existing = await getOrgBins(org_id);
    if (existing[id]) return res.status(409).json({ error: 'Bin ID already exists' });

    const newBin = { id, name, location, fillLevel: 0, lastMaterial: null, lastScanTime: null, status: 'ok' };
    await setOrgBin(org_id, id, newBin);
    res.status(201).json(newBin);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add bin' });
  }
});

// GET /api/admin/scans — recent map scans the admin may moderate
// (scans belonging to the admin's org, plus unassigned public scans)
router.get('/scans', requireAuth, async (req, res) => {
  const org_id = req.user && req.user.org_id;
  if (!org_id) return res.status(403).json({ error: 'No organization associated with this account' });

  try {
    const db = getDb();
    if (!db) return res.json({ scans: [], error: 'Firestore not configured' });

    const snap = await db.collection('scans')
      .orderBy('timestamp', 'desc')
      .limit(200)
      .get();

    const scans = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (d.org_id && d.org_id !== org_id) return; // other orgs' data stays invisible
      scans.push({
        id:            doc.id,
        item_name:     d.item_name || '',
        category:      d.category || '',
        location_name: d.location_name || '',
        latitude:      d.latitude || null,
        longitude:     d.longitude || null,
        user_id:       d.user_id || 'anon',
        org_id:        d.org_id || null,
        in_use:        d.in_use === true,
        timestamp:     d.timestamp && d.timestamp.toDate ? d.timestamp.toDate().toISOString() : null,
      });
    });

    res.json({ scans });
  } catch (err) {
    console.error('/api/admin/scans error:', err);
    res.status(500).json({ error: 'Failed to load scans' });
  }
});

// DELETE /api/admin/scans/:id — remove a bogus scan from the map
router.delete('/scans/:id', requireAuth, async (req, res) => {
  const org_id = req.user && req.user.org_id;
  if (!org_id) return res.status(403).json({ error: 'No organization associated with this account' });

  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'Firestore not configured' });

    const ref = db.collection('scans').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Scan not found' });

    const data = doc.data();
    if (data.org_id && data.org_id !== org_id) {
      return res.status(403).json({ error: 'Scan belongs to another organization' });
    }

    await ref.delete();
    res.json({ message: 'Scan removed from the map' });
  } catch (err) {
    console.error('/api/admin/scans delete error:', err);
    res.status(500).json({ error: 'Failed to delete scan' });
  }
});

// GET /api/admin/logs
router.get('/logs', requireAuth, (req, res) => {
  const history = _scanHistory || [];
  const today   = new Date().toDateString();
  const todayScans = history.filter(e => new Date(e.timestamp).toDateString() === today);

  const materialCounts = {};
  todayScans.forEach(e => {
    if (e.material && e.material !== '—') materialCounts[e.material] = (materialCounts[e.material] || 0) + 1;
  });

  let topMaterial = null, topCount = 0;
  Object.entries(materialCounts).forEach(([mat, cnt]) => {
    if (cnt > topCount) { topMaterial = mat; topCount = cnt; }
  });

  res.json({
    history: history.slice(0, 100),
    analytics: {
      totalScansToday: todayScans.length,
      topMaterial,
      topMaterialPercent: todayScans.length ? Math.round((topCount / todayScans.length) * 100) : 0,
      binsAtCapacity: 0,
    },
  });
});

module.exports = { router, setScanHistory };
