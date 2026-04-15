'use strict';

const { queryAllKnowledgeEntries } = require('../db/knowledge-entries');
const { queryAllAutoEvolves } = require('../evolve/queries');

module.exports = async function synthesizeRoutes(app, opts) {
  const { db, helpers } = opts;
  const { errorReply } = helpers;

  app.get('/api/synthesize/data', (req, reply) => {
    const { project, type = 'all' } = req.query;

    if (!['knowledge', 'patterns', 'all'].includes(type)) {
      return errorReply(reply, 400, 'type must be knowledge, patterns, or all');
    }

    // Resolve projects
    let projects;
    if (project) {
      const row = db.prepare('SELECT * FROM cl_projects WHERE name = ?').get(project);
      projects = row ? [row] : [{ project_id: project, name: project, directory: null }];
    } else {
      projects = db.prepare('SELECT * FROM cl_projects').all();
    }

    let totalKnowledge = 0;
    let totalPatterns = 0;

    const result = projects.map(proj => {
      const entry = { project: { project_id: proj.project_id, name: proj.name, directory: proj.directory } };

      if (type === 'knowledge' || type === 'all') {
        const keRows = queryAllKnowledgeEntries(db, { projectId: proj.project_id, status: 'active', limit: 500 });
        const byCategory = {};
        for (const row of keRows) {
          if (!byCategory[row.category]) byCategory[row.category] = [];
          byCategory[row.category].push(row);
        }
        entry.knowledge_entries = { by_category: byCategory };
        totalKnowledge += keRows.length;
      }

      if (type === 'patterns' || type === 'all') {
        const aeRows = queryAllAutoEvolves(db, { project: proj.name, limit: 200 });
        const byType = {};
        for (const row of aeRows) {
          if (!byType[row.target_type]) byType[row.target_type] = [];
          byType[row.target_type].push(row);
        }
        entry.auto_evolves = { by_type: byType };
        totalPatterns += aeRows.length;
      }

      return entry;
    });

    reply.send({
      projects: result,
      totals: { knowledge_entries: totalKnowledge, auto_evolves: totalPatterns },
    });
  });
};
