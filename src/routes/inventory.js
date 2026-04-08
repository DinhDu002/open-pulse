'use strict';

const { getComponentsByType } = require('../op-db');
const { parseQualifiedName } = require('../op-helpers');

module.exports = async function inventoryRoutes(app, opts) {
  const { db, helpers, componentETagFn } = opts;
  const { periodToDate, readItemMeta, extractKeywordsFromPrompts } = helpers;

  app.get('/api/inventory/:type', async (request, reply) => {
    const { type } = request.params;
    const { period } = request.query;
    const since = periodToDate(period);

    // ETag check (includes period so different periods don't share cache)
    const requestETag = `${componentETagFn()}:${period || 'all'}`;
    if (request.headers['if-none-match'] === `"${requestETag}"`) {
      reply.code(304);
      return;
    }

    const singularType = type.replace(/s$/, '');
    const validTypes = ['skill', 'agent', 'hook', 'rule'];
    if (!validTypes.includes(singularType)) {
      return { error: 'Invalid type. Use skills, agents, hooks, or rules.' };
    }

    const components = getComponentsByType(db, singularType);

    if (singularType === 'hook') {
      reply.header('etag', `"${requestETag}"`);
      return components.map(c => ({
        name: c.name,
        event: c.hook_event,
        matcher: c.hook_matcher,
        command: c.hook_command,
        project: c.project || 'global',
      }));
    }

    if (singularType === 'rule') {
      reply.header('etag', `"${requestETag}"`);
      return components.map(c => ({
        name: c.name,
        type: 'rule',
        project: c.project || 'global',
      }));
    }

    // Skills and agents: join with events for usage counts
    const eventTypeMap = { skill: 'skill_invoke', agent: 'agent_spawn' };
    const eventType = eventTypeMap[singularType];

    const conditions = ['event_type = @eventType'];
    if (since) conditions.push('timestamp >= @since');
    const where = 'WHERE ' + conditions.join(' AND ');

    const usageRows = db.prepare(
      `SELECT name, COUNT(*) as count, MAX(timestamp) as last_used
       FROM events ${where} GROUP BY name`
    ).all({ eventType, since: since || undefined });

    const usageMap = new Map(usageRows.map(r => [r.name, r]));

    const items = components.map(c => {
      const usage = usageMap.get(c.name) || { count: 0, last_used: null };
      const item = {
        name: c.name,
        count: usage.count,
        last_used: usage.last_used,
        status: usage.count > 0 ? 'active' : 'unused',
        origin: 'custom',
        plugin: c.plugin || null,
        project: c.project || 'global',
      };
      if (singularType === 'agent') {
        item.agent_class = c.agent_class || 'built-in';
      }
      return item;
    });

    // Also include "built-in" agents from events that aren't on disk
    if (singularType === 'agent') {
      const knownNames = new Set(components.map(c => c.name));
      for (const [name, usage] of usageMap) {
        if (!knownNames.has(name)) {
          items.push({
            name,
            count: usage.count,
            last_used: usage.last_used,
            status: 'active',
            origin: 'custom',
            plugin: parseQualifiedName(name).plugin,
            project: 'global',
            agent_class: 'built-in',
          });
        }
      }
    }

    items.sort((a, b) => b.count - a.count);
    reply.header('etag', `"${requestETag}"`);
    return items;
  });

  app.get('/api/inventory/:type/:name', async (request) => {
    const { type, name } = request.params;
    const { period, page: pageStr, per_page: perPageStr } = request.query;
    const since = periodToDate(period);
    const page = Math.max(1, parseInt(pageStr) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(perPageStr) || 10));

    const eventTypeMap = { skills: 'skill_invoke', agents: 'agent_spawn' };
    const eventType = eventTypeMap[type];
    if (!eventType) return { error: 'Invalid type' };

    const singularType = type.replace(/s$/, '');
    const comp = db.prepare(
      'SELECT * FROM components WHERE type = ? AND name = ?'
    ).get(singularType, name);
    const meta = comp
      ? { description: comp.description || '', origin: 'custom' }
      : readItemMeta(type, name);

    const conditions = ['event_type = @eventType', 'name = @name'];
    if (since) conditions.push('timestamp >= @since');
    const where = 'WHERE ' + conditions.join(' AND ');

    const allInvocations = db.prepare(
      `SELECT timestamp, detail, session_id, duration_ms, user_prompt FROM events ${where} ORDER BY timestamp DESC`
    ).all({ eventType, name, since: since || undefined });

    // Enrich each invocation with trigger source (nearest preceding skill/agent in same session)
    const triggerStmt = db.prepare(`
      SELECT name, event_type FROM events
      WHERE session_id = @sessionId
        AND event_type IN ('skill_invoke', 'agent_spawn')
        AND timestamp < @timestamp
        AND name != @currentName
      ORDER BY timestamp DESC LIMIT 1
    `);

    // Find what each invocation subsequently triggers
    const triggersStmt = db.prepare(`
      SELECT name, event_type FROM events
      WHERE session_id = @sessionId
        AND event_type IN ('skill_invoke', 'agent_spawn')
        AND timestamp > @timestamp
        AND name != @currentName
      ORDER BY timestamp ASC LIMIT 1
    `);

    const triggerCounts = new Map();

    for (const inv of allInvocations) {
      const trigger = triggerStmt.get({
        sessionId: inv.session_id,
        timestamp: inv.timestamp,
        currentName: name,
      });
      inv.triggered_by = trigger
        ? { name: trigger.name, type: trigger.event_type }
        : null;

      const triggered = triggersStmt.get({
        sessionId: inv.session_id,
        timestamp: inv.timestamp,
        currentName: name,
      });
      if (triggered) {
        const key = `${triggered.event_type}:${triggered.name}`;
        if (!triggerCounts.has(key)) {
          triggerCounts.set(key, { name: triggered.name, event_type: triggered.event_type, count: 0 });
        }
        triggerCounts.get(key).count++;
      }
    }

    const total = allInvocations.length;
    const invocations = allInvocations.slice((page - 1) * perPage, page * perPage);

    return {
      name,
      description: meta.description,
      origin: meta.origin,
      keywords: extractKeywordsFromPrompts(allInvocations),
      invocations,
      triggers: [...triggerCounts.values()],
      total,
      page,
      per_page: perPage,
    };
  });
};
