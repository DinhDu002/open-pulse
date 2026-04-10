'use strict';
// Shim: moved to src/review/
module.exports = require('../src/review/pipeline');

if (require.main === module) {
  const pipeline = require('../src/review/pipeline');
  if (typeof pipeline.main === 'function') pipeline.main();
}
