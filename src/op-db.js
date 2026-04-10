'use strict';
// Shim: delegates to db/ modules during migration
const { DEFAULT_DB_PATH, createDb } = require('./db/schema');
const events = require('./db/events');
const sessions = require('./db/sessions');
const knowledge = require('./db/knowledge-sync');
const components = require('./db/components');
const prompts = require('./db/prompts');
const projects = require('./db/projects');
const scan = require('./db/scan');

module.exports = {
  DEFAULT_DB_PATH,
  createDb,
  ...events,
  ...sessions,
  ...knowledge,
  ...components,
  ...prompts,
  ...projects,
  ...scan,
};
