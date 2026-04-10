'use strict';

// ---------------------------------------------------------------------------
// Scan results
// ---------------------------------------------------------------------------

function insertScanResult(db, scan) {
  db.prepare(`
    INSERT INTO scan_results
      (scanned_at, report, total_skills, total_agents,
       issues_critical, issues_high, issues_medium, issues_low)
    VALUES
      (@scanned_at, @report, @total_skills, @total_agents,
       @issues_critical, @issues_high, @issues_medium, @issues_low)
  `).run(scan);
}

function getLatestScan(db) {
  return db.prepare('SELECT * FROM scan_results ORDER BY scanned_at DESC LIMIT 1').get();
}

function getScanHistory(db, limit) {
  return db.prepare('SELECT * FROM scan_results ORDER BY scanned_at DESC LIMIT ?').all(limit || 10);
}

module.exports = {
  insertScanResult,
  getLatestScan,
  getScanHistory,
};
