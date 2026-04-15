'use strict';

const crypto = require('crypto');

function makeId(title, targetType) {
  const hash = crypto
    .createHash('sha256')
    .update(`${title}::${targetType}`)
    .digest('hex')
    .substring(0, 16);
  return `ae-${hash}`;
}

module.exports = { makeId };
