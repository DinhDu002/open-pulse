'use strict';

const path = require('path');
const fs = require('fs');

const DEFAULT_CONFIG = {
  port: 3827,
  ingest_interval_ms: 10000,
  cl_sync_interval_ms: 60000,
};

function getRepoDir() {
  return process.env.OPEN_PULSE_DIR || path.join(__dirname, '..', '..');
}

function loadConfig(repoDir) {
  const dir = repoDir || getRepoDir();
  const configPath = path.join(dir, 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

module.exports = { loadConfig, DEFAULT_CONFIG };
