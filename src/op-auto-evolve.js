'use strict';

// Shim: delegates to src/evolve/ modules.
// All original exports are re-exported for backward compatibility.

const sync = require('./evolve/sync');
const promote = require('./evolve/promote');
const revert = require('./evolve/revert');
const queries = require('./evolve/queries');
const { slugify } = require('./lib/slugify');
const { extractBody, parseFrontmatter: parseYamlFrontmatter } = require('./lib/frontmatter');
const { getComponentPath } = require('./lib/paths');

module.exports = {
  // lib re-exports (kept for backward compat)
  slugify,
  parseYamlFrontmatter,
  extractBody,
  getComponentPath,
  // evolve/sync
  ...sync,
  // evolve/promote
  ...promote,
  // evolve/revert
  ...revert,
  // evolve/queries
  ...queries,
};
