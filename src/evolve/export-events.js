#!/usr/bin/env node
'use strict';

/**
 * Export project-scoped events from SQLite as JSONL for CL observer analysis.
 *
 * Usage:
 *   node export-events.js --project-root /path --limit 500 --output /tmp/obs.jsonl --db /path/open-pulse.db
 *
 * Writes JSONL to --output and prints the line count to stdout.
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { limit: 500, since: null, output: null, projectRoot: null, db: null };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--project-root': args.projectRoot = argv[++i]; break;
      case '--limit':        args.limit = parseInt(argv[++i], 10) || 500; break;
      case '--since':        args.since = argv[++i]; break;
      case '--output':       args.output = argv[++i]; break;
      case '--db':           args.db = argv[++i]; break;
    }
  }
  return args;
}

function exportEvents(dbPath, projectRoot, since, limit) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 3000');

  try {
    const conditions = ["event_type IN ('tool_call', 'skill_invoke', 'agent_spawn')"];
    const params = [];

    if (projectRoot) {
      conditions.push('working_directory LIKE ?');
      params.push(projectRoot + '%');
    }
    if (since) {
      conditions.push('timestamp > ?');
      params.push(since);
    }

    const sql = `
      SELECT timestamp, session_id, event_type, name, detail,
             tool_input, tool_response, user_prompt, seq_num, success,
             duration_ms, working_directory
      FROM events
      WHERE ${conditions.join(' AND ')}
        AND tool_input IS NOT NULL
      ORDER BY timestamp ASC
      LIMIT ?
    `;
    params.push(limit);

    const rows = db.prepare(sql).all(...params);

    return rows.map(row => ({
      timestamp:  row.timestamp,
      event_type: row.event_type,
      tool:       row.name,
      session:    row.session_id,
      seq_num:    row.seq_num,
      success:    row.success != null ? Boolean(row.success) : null,
      input:      row.tool_input,
      output:     row.tool_response,
      user_prompt: row.user_prompt,
      detail:     row.detail,
      duration_ms: row.duration_ms,
    }));
  } finally {
    db.close();
  }
}

function main() {
  const args = parseArgs(process.argv);

  if (!args.db) {
    const defaultDb = path.join(__dirname, '..', '..', 'open-pulse.db');
    if (fs.existsSync(defaultDb)) {
      args.db = defaultDb;
    } else {
      process.stderr.write('Error: --db required or open-pulse.db must exist\n');
      process.exit(1);
    }
  }

  if (!fs.existsSync(args.db)) {
    process.stderr.write(`Error: database not found: ${args.db}\n`);
    process.exit(1);
  }

  const events = exportEvents(args.db, args.projectRoot, args.since, args.limit);

  if (args.output) {
    const lines = events.map(e => JSON.stringify(e)).join('\n');
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, lines ? lines + '\n' : '', 'utf8');
  }

  if (events.length > 0 && events.length === args.limit) {
    process.stderr.write(
      `Warning: event count (${events.length}) hit limit (${args.limit}); older events may remain unprocessed\n`
    );
  }

  // Print count + max timestamp to stdout for the caller (observer-loop.sh)
  const maxTs = events.length > 0 ? events[events.length - 1].timestamp : '';
  process.stdout.write(`${events.length}\t${maxTs}`);
}

// Allow both CLI and require() usage
module.exports = { exportEvents, parseArgs };

if (require.main === module) {
  main();
}
