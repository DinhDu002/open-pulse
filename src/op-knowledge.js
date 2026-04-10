'use strict';
// Shim: delegates to knowledge/ modules during migration
const extract = require('./knowledge/extract');
const vault = require('./knowledge/vault');
const scan = require('./knowledge/scan');
module.exports = { ...extract, ...vault, ...scan };
