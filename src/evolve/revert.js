'use strict';

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Revert a promoted auto-evolve component
// ---------------------------------------------------------------------------

function revertAutoEvolve(db, id) {
  const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(id);
  if (!row) throw new Error(`Auto-evolve not found: ${id}`);

  if (row.promoted_to && fs.existsSync(row.promoted_to)) {
    fs.unlinkSync(row.promoted_to);
    try {
      const dir = path.dirname(row.promoted_to);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* ignore */ }
  }

  db.prepare(`
    UPDATE auto_evolves
    SET status = 'reverted',
        rejection_count = rejection_count + 1,
        confidence = MIN(confidence, 0.5),
        updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id);
}

module.exports = { revertAutoEvolve };
