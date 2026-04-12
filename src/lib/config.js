'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  plan_generation_enabled: true,
  plan_generation_model: 'opus',
  plan_generation_timeout_ms: 120000,
  plan_generation_max_context_kb: 100,
  plan_generation_max_concurrent: 3,
};

function loadConfig() {
  const cfgPath = process.env.OPEN_PULSE_CONFIG
    || path.resolve(__dirname, '..', '..', 'config.json');
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

module.exports = { loadConfig, DEFAULT_CONFIG };
