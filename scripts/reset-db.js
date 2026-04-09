#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_DIR = process.env.OPEN_PULSE_DIR || path.join(__dirname, '..');
const DB_PATH  = process.env.OPEN_PULSE_DB  || path.join(REPO_DIR, 'open-pulse.db');
const DATA_DIR = path.join(REPO_DIR, 'data');

console.log('Open Pulse — Clean Break DB Reset');
console.log('==================================');

// 1. Delete existing DB
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log(`Deleted: ${DB_PATH}`);
  for (const suffix of ['-wal', '-shm']) {
    const f = DB_PATH + suffix;
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log(`Deleted: ${f}`); }
  }
} else {
  console.log('No existing DB found.');
}

// 2. Recreate DB with fresh schema
const { createDb } = require('../src/op-db');
const db = createDb(DB_PATH);
db.close();
console.log(`Created: ${DB_PATH}`);

// 3. Clean up legacy .seq-* files
if (fs.existsSync(DATA_DIR)) {
  const seqFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('.seq-'));
  for (const f of seqFiles) {
    fs.unlinkSync(path.join(DATA_DIR, f));
  }
  if (seqFiles.length > 0) {
    console.log(`Cleaned up ${seqFiles.length} legacy .seq-* files`);
  }

  // 4. Clean up leftover JSONL files
  const jsonlFiles = fs.readdirSync(DATA_DIR).filter(f =>
    f.endsWith('.jsonl') || f.endsWith('.processing') || f.endsWith('.retries') || f.endsWith('.failed')
  );
  for (const f of jsonlFiles) {
    fs.unlinkSync(path.join(DATA_DIR, f));
  }
  if (jsonlFiles.length > 0) {
    console.log(`Cleaned up ${jsonlFiles.length} JSONL/state files`);
  }
}

console.log('Done. Fresh DB ready.');
