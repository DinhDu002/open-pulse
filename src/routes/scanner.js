'use strict';

const { runScan } = require('../ingest/sync');
const {
  insertScanResult,
  getLatestScan,
  getScanHistory,
} = require('../db/scan');

module.exports = async function scannerRoutes(app, opts) {
  const { db } = opts;

  // ── Scanner ─────────────────────────────────────────────────────────────

  app.post('/api/scanner/run', async () => {
    return runScan(db);
  });

  app.get('/api/scanner/latest', async () => {
    return getLatestScan(db) || null;
  });

  app.get('/api/scanner/history', async (request) => {
    const { limit = 10 } = request.query;
    return getScanHistory(db, parseInt(limit, 10));
  });
};
