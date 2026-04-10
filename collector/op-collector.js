'use strict';
// Shim: moved to src/ingest/collector.js
const mod = require('../src/ingest/collector');
module.exports = mod;

if (require.main === module) {
  // `node collector/op-collector.js` arrives here (require.main === module is true).
  // The new module's own `if (require.main === module)` guard is false when required,
  // so we invoke main() explicitly to preserve hook execution.
  mod.main().catch(() => process.exit(0));
}
