'use strict';

const { getComponentsByType } = require('../op-db');
const { parseQualifiedName } = require('../op-helpers');

const VALID_TYPES = new Set(['skills', 'agents']);

module.exports = async function inventoryRoutes(app, opts) {
  const { db, helpers, componentETagFn } = opts;
  const { periodToDate, readItemMeta, extractKeywordsFromPrompts, errorReply, parsePagination } = helpers;

  app.get('/api/inventory/:type', async (request, reply) => {
    const { type } = request.params;
    const { period, project } = request.query;
    const since = periodToDate(period);

    // ETag check (includes period and project so different filters don't share cache)
    const requestETag = `${componentETagFn()}:${period || 'all'}:${project || ''}`;
    if (request.headers['if-none-match'] === `"${requestETag}"`) {
      reply.code(304);
      return;
    }

    if (!VALID_TYPES.has(type)) {
      return errorReply(reply, 400, 'Invalid type. Must be: skills, agents');
    }
    const singularType = type.replace(/s$/, '');

    const components = getComponentsByType(db, singularType);

    // Deduplicate components by name — merge entries with same name, collect projects into array
    const byName = new Map();
    for (const c of components) {
      const proj = c.project || 'global';
      if (!byName.has(c.name)) {
        byName.set(c.name, { ...c, projects: [proj] });
      } else {
        const existing = byName.get(c.name);
        if (!existing.projects.includes(proj)) existing.projects.push(proj);
        if (!existing.plugin && c.plugin) existing.plugin = c.plugin;
        if (c.agent_class === 'configured') existing.agent_class = 'configured';
      }
    }

    // Skills and agents: join with events for usage counts
    const eventTypeMap = { skill: 'skill_invoke', agent: 'agent_spawn' };
    const eventType = eventTypeMap[singularType];

    const conditions = ['event_type = @eventType'];
    if (since) conditions.push('timestamp >= @since');
    if (project) conditions.push('project_name = @project');
    const where = 'WHERE ' + conditions.join(' AND ');

    const usageRows = db.prepare(
      `SELECT name, COUNT(*) as count, MAX(timestamp) as last_used
       FROM events ${where} GROUP BY name`
    ).all({ eventType, since: since || undefined, project: project || undefined });

    const usageMap = new Map(usageRows.map(r => [r.name, r]));

    const items = [...byName.values()].map(c => {
      const usage = usageMap.get(c.name) || { count: 0, last_used: null };
      return {
        name: c.name,
        count: usage.count,
        last_used: usage.last_used,
        status: usage.count > 0 ? 'active' : 'unused',
        origin: 'custom',
        projects: c.projects,
        plugin: c.plugin || null,
        ...(singularType === 'agent' ? { agent_class: c.agent_class || 'built-in' } : {}),
      };
    });

    // Also include "built-in" agents from events that aren't on disk
    if (singularType === 'agent') {
      const knownNames = new Set(byName.keys());
      for (const [name, usage] of usageMap) {
        if (!knownNames.has(name)) {
          items.push({
            name,
            count: usage.count,
            last_used: usage.last_used,
            status: 'active',
            origin: 'custom',
            plugin: parseQualifiedName(name).plugin,
            projects: ['global'],
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
    const { period, project } = request.query;
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

    // by_project breakdown — always unfiltered by project (shows full picture)
    const bpConditions = ['event_type = @eventType', 'name = @name'];
    if (since) bpConditions.push('timestamp >= @since');
    const bpWhere = 'WHERE ' + bpConditions.join(' AND ');
    const byProject = db.prepare(
      `SELECT project_name AS project, COUNT(*) AS count, MAX(timestamp) AS last_used
       FROM events ${bpWhere} GROUP BY project_name ORDER BY count DESC`
    ).all({ eventType, name, since: since || undefined });

    const conditions = ['event_type = @eventType', 'name = @name'];
    if (since) conditions.push('timestamp >= @since');
    if (project) conditions.push('project_name = @project');
    const where = 'WHERE ' + conditions.join(' AND ');

    const allInvocations = db.prepare(
      `SELECT timestamp, detail, session_id, duration_ms, user_prompt, project_name FROM events ${where} ORDER BY timestamp DESC`
    ).all({ eventType, name, since: since || undefined, project: project || undefined });

    // Batch query: find triggered_by for all invocations at once
    // (nearest preceding skill/agent in the same session, before each invocation)
    const triggeredBySinceFrag = since ? 'AND e1.timestamp >= @since' : '';
    const triggeredByProjectFrag = project ? 'AND e1.project_name = @project' : '';
    const triggeredByRows = db.prepare(`
      SELECT e1.timestamp AS inv_ts, e2.name, e2.event_type
      FROM events e1
      JOIN events e2 ON e2.session_id = e1.session_id
        AND e2.event_type IN ('skill_invoke', 'agent_spawn')
        AND e2.timestamp < e1.timestamp
        AND e2.name != @currentName
      WHERE e1.name = @currentName AND e1.event_type = @eventType
        ${triggeredBySinceFrag}
        ${triggeredByProjectFrag}
      GROUP BY e1.session_id, e1.timestamp
      HAVING e2.timestamp = MAX(e2.timestamp)
    `).all({ currentName: name, eventType, since: since || undefined, project: project || undefined });

    const triggeredByMap = new Map(
      triggeredByRows.map(r => [r.inv_ts, { name: r.name, type: r.event_type }])
    );

    // Batch query: find what each invocation subsequently triggers
    // (nearest following skill/agent in the same session, after each invocation)
    const triggersSinceFrag = since ? 'AND e1.timestamp >= @since' : '';
    const triggersProjectFrag = project ? 'AND e1.project_name = @project' : '';
    const triggersRows = db.prepare(`
      SELECT e1.timestamp AS inv_ts, e2.name, e2.event_type
      FROM events e1
      JOIN events e2 ON e2.session_id = e1.session_id
        AND e2.event_type IN ('skill_invoke', 'agent_spawn')
        AND e2.timestamp > e1.timestamp
        AND e2.name != @currentName
      WHERE e1.name = @currentName AND e1.event_type = @eventType
        ${triggersSinceFrag}
        ${triggersProjectFrag}
      GROUP BY e1.session_id, e1.timestamp
      HAVING e2.timestamp = MIN(e2.timestamp)
    `).all({ currentName: name, eventType, since: since || undefined, project: project || undefined });

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
      by_project: byProject,
      total,
      page,
      per_page: perPage,
    };
  });
};
