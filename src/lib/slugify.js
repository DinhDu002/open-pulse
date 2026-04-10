'use strict';

/**
 * Convert a string to a URL-safe slug (lowercase, hyphens, max 60 chars).
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

module.exports = { slugify };
