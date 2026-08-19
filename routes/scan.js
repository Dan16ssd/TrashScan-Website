'use strict';

const express = require('express');
const router  = express.Router();
const { analyzeTrashImage } = require('../utils/gemini-lens');
const { getDb, getOrgBins, setOrgBin } = require('../utils/firebase-admin');

let _scanHistory = null;

function setScanHistory(sh)  { _scanHistory = sh; }

const POINTS_PER_SCAN      = 10;
const DAILY_POINTS_CAP     = 100;
const DAILY_SCAN_WRITE_CAP = 50; // max scan documents per user per day (keeps the map flood-proof)

router.post('/scan', async (req, res) => {
  const {
    imageBase64,
    mimeType = 'image/jpeg',
    binId = 'bin-1',
    lat,
    lng,
    gps_accuracy,
    location_name = 'Unknown',
    user_id = 'anonymous',
    org_id = null,
    probe = false,
  } = req.body;

  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });
  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY && !process.env.HF_TOKEN) {
    return res.status(500).json({ error: 'No vision provider API key configured' });
  }

  try {
    const items = await analyzeTrashImage(imageBase64, mimeType);

    if (probe) return res.json({ items });

    // Update org bin fill level in Firestore (only when org is known)
    if (org_id && items.length > 0) {
      try {
        const bins = await getOrgBins(org_id);
        const bin  = bins[binId];
        if (bin) {
          bin.fillLevel    = Math.min(100, (bin.fillLevel || 0) + 10);
          bin.lastMaterial = items[0].material;
          bin.lastScanTime = new Date().toISOString();
          bin.status = bin.fillLevel > 85 ? 'full' : bin.fillLevel > 60 ? 'warning' : 'ok';
          await setOrgBin(org_id, binId, bin);
        }
      } catch (binErr) {
        console.warn('Bin update failed (non-fatal):', binErr.message);
      }
    }

    const toLog = items.slice(0, 5);
    if (_scanHistory) {
      for (const item of toLog) {
        _scanHistory.unshift({
          timestamp: new Date().toISOString(),
          binId,
          binName: binId,
          object:   item.object,
          material: item.material,
          action:   'Scanned',
        });
      }
      if (_scanHistory.length > 200) _scanHistory.length = 200;
    }

    // Only items the AI judged as actual discarded waste earn points —
    // in-use belongings (your phone, a full bottle on a desk) do not.
    const wasteItems = toLog.filter(i => i.in_use !== true);

    let total_points  = null;
    let pointsAwarded = wasteItems.length > 0 ? POINTS_PER_SCAN : 0; // default when db is unavailable
    const db = getDb();
    if (db && toLog.length > 0) {
      const timestamp = new Date();
      const latVal = typeof lat === 'number' ? lat : (parseFloat(lat) || null);
      const lngVal = typeof lng === 'number' ? lng : (parseFloat(lng) || null);
      const accVal = typeof gps_accuracy === 'number' ? gps_accuracy : (parseFloat(gps_accuracy) || null);

      const userRef  = db.collection('users').doc(user_id);
      const todayStr = timestamp.toISOString().slice(0, 10); // "YYYY-MM-DD" UTC
      pointsAwarded  = 0;  // will be calculated inside transaction
      let scansAllowed = 0; // how many scan docs this user may still write today

      await db.runTransaction(async (t) => {
        const doc  = await t.get(userRef);
        const data = doc.exists ? doc.data() : {};

        const current      = data.total_points  || 0;
        const dailyReset   = data.daily_reset   || '';
        const sameDay      = dailyReset === todayStr;
        const dailyEarned  = sameDay ? (data.daily_points || 0) : 0;
        const dailyScans   = sameDay ? (data.daily_scans  || 0) : 0;

        pointsAwarded = wasteItems.length === 0
          ? 0
          : Math.max(0, Math.min(POINTS_PER_SCAN, DAILY_POINTS_CAP - dailyEarned));
        total_points  = current + pointsAwarded;
        scansAllowed  = Math.max(0, Math.min(toLog.length, DAILY_SCAN_WRITE_CAP - dailyScans));

        t.set(userRef, {
          total_points,
          daily_points: dailyEarned + pointsAwarded,
          daily_scans:  dailyScans + scansAllowed,
          daily_reset:  todayStr,
          last_scan:    timestamp,
          org_id:       org_id || null,
        }, { merge: true });
      });

      for (const item of toLog.slice(0, scansAllowed)) {
        await db.collection('scans').add({
          item_name:    item.object,
          category:     item.material,
          location_name,
          latitude:     latVal,
          longitude:    lngVal,
          gps_accuracy: accVal,
          timestamp,
          user_id,
          org_id:       org_id || null,
          regen_points: POINTS_PER_SCAN,
          in_use:       item.in_use === true,
        });
      }
    }

    return res.json({
      items,
      binId,
      regen_points:    pointsAwarded,
      total_points,
      daily_cap_reached: wasteItems.length > 0 && pointsAwarded === 0,
      no_items: toLog.length === 0,
      in_use_only: toLog.length > 0 && wasteItems.length === 0,
    });
  } catch (err) {
    console.error('Scan error:', err);
    return res.status(500).json({ error: 'Scan failed', details: err.message });
  }
});

module.exports = { router, setScanHistory };
