'use strict';

const { getComponentsByType } = require('../op-db');
const { parseQualifiedName } = require('../op-helpers');

const VALID_TYPES = new Set(['skills', 'agents', 'hooks', 'rules']);

module.exports = async function inventoryRoutes(app, opts) {
  const { db, helpers, componentETagFn } = opts;
  const { periodToDate, readItemMeta, extractKeywordsFromPrompts, errorReply, parsePagination } = helpers;

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

    if (!VALID_TYPES.has(type)) {
      return errorReply(reply, 400, 'Invalid type. Must be: skills, agents, hooks, rules');
    }
    const singularType = type.replace(/s$/, '');

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

  app.get('/api/inventory/:type/:name', async (request, reply) => {
    const { type, name } = request.params;
    const { period } = request.query;
    const since = periodToDate(period);
    const { page, perPage } = parsePagination(request.query, { perPage: 10 });

    const eventTypeMap = { skills: 'skill_invoke', agents: 'agent_spawn' };
    const eventType = eventTypeMap[type];
    if (!eventType) return errorReply(reply, 400, 'Invalid type. Must be: skills, agents');

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

    // Batch query: find triggered_by for all invocations at once
    // (nearest preceding skill/agent in the same session, before each invocation)
    const triggeredBySinceFrag = since ? 'AND e1.timestamp >= @since' : '';
    const triggeredByRows = db.prepare(`
      SELECT e1.timestamp AS inv_ts, e2.name, e2.event_type
      FROM events e1
      JOIN events e2 ON e2.session_id = e1.session_id
        AND e2.event_type IN ('skill_invoke', 'agent_spawn')
        AND e2.timestamp < e1.timestamp
        AND e2.name != @currentName
      WHERE e1.name = @currentName AND e1.event_type = @eventType
        ${triggeredBySinceFrag}
      GROUP BY e1.session_id, e1.timestamp
      HAVING e2.timestamp = MAX(e2.timestamp)
    `).all({ currentName: name, eventType, since: since || undefined });

    const triggeredByMap = new Map(
      triggeredByRows.map(r => [r.inv_ts, { name: r.name, type: r.event_type }])
    );

    // Batch query: find what each invocation subsequently triggers
    // (nearest following skill/agent in the same session, after each invocation)
    const triggersSinceFrag = since ? 'AND e1.timestamp >= @since' : '';
    const triggersRows = db.prepare(`
      SELECT e1.timestamp AS inv_ts, e2.name, e2.event_type
      FROM events e1
      JOIN events e2 ON e2.session_id = e1.session_id
        AND e2.event_type IN ('skill_invoke', 'agent_spawn')
        AND e2.timestamp > e1.timestamp
        AND e2.name != @currentName
      WHERE e1.name = @currentName AND e1.event_type = @eventType
        ${triggersSinceFrag}
      GROUP BY e1.session_id, e1.timestamp
      HAVING e2.timestamp = MIN(e2.timestamp)
    `).all({ currentName: name, eventType, since: since || undefined });

    // Build trigger counts from batch results
    const triggerCounts = new Map();
    for (const row of triggersRows) {
      const key = `${row.event_type}:${row.name}`;
      if (!triggerCounts.has(key)) {
        triggerCounts.set(key, { name: row.name, event_type: row.event_type, count: 0 });
      }
      triggerCounts.get(key).count++;
    }

    // Assign triggered_by to each invocation from the batch lookup
    for (const inv of allInvocations) {
      inv.triggered_by = triggeredByMap.get(inv.timestamp) || null;
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
