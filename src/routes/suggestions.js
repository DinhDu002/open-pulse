'use strict';

const path = require('path');
const { execFile, spawn } = require('child_process');
const {
  querySuggestions,
  updateSuggestionStatus,
  updateSuggestionVi,
} = require('../op-db');

module.exports = async function suggestionsRoutes(app, opts) {
  const { db, repoDir, config, helpers } = opts;
  const { errorReply } = helpers;

  // ── Suggestions ─────────────────────────────────────────────────────────

  app.get('/api/suggestions', async (request) => {
    const { status, category } = request.query;
    return querySuggestions(db, status || null, category || null);
  });

  app.post('/api/suggestions/analyze', async (request, reply) => {
    const agentScript = path.join(repoDir, 'scripts', 'op-suggestion-agent.js');
    const timeout = config.suggestion_agent_timeout_ms || 180000;

    return new Promise((resolve) => {
      execFile(process.execPath, [agentScript], {
        cwd: repoDir,
        timeout,
        env: { ...process.env, OPEN_PULSE_DIR: repoDir, OP_SKIP_COLLECT: '1' },
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          return resolve(errorReply(reply, 500, 'Suggestion agent failed: ' + (stderr || error.message).slice(-500)));
        } else {
          try { resolve(JSON.parse(stdout)); }
          catch { resolve({ generated: 0, raw: stdout.slice(0, 500) }); }
        }
      });
    });
  });

  app.put('/api/suggestions/:id/approve', async (request) => {
    const { id } = request.params;
    updateSuggestionStatus(db, id, 'approved', 'user');
    return { success: true, id, status: 'approved' };
  });

  app.put('/api/suggestions/:id/dismiss', async (request) => {
    const { id } = request.params;
    updateSuggestionStatus(db, id, 'dismissed', 'user');
    return { success: true, id, status: 'dismissed' };
  });

  app.post('/api/suggestions/:id/translate', async (request, reply) => {
    const { id } = request.params;
    const all = querySuggestions(db, null, null);
    const sug = all.find(s => s.id === id);
    if (!sug) return reply.code(404).send({ error: 'not found' });
    if (sug.description_vi) return { description_vi: sug.description_vi };
    if (!sug.description) return reply.code(400).send({ error: 'no description to translate' });

    const prompt =
      'Giải thích đề xuất sau bằng tiếng Việt theo đúng format 3 dòng:\n' +
      'Nghĩa là gì: [giải thích ngắn gọn đề xuất này nói gì]\n' +
      'Vấn đề: [tại sao cần quan tâm — rủi ro hoặc cơ hội bị bỏ lỡ]\n' +
      'Cách xử lý: [hành động cụ thể nên làm]\n\n' +
      'Chỉ trả về 3 dòng trên, không thêm giải thích. Dùng đầy đủ dấu tiếng Việt.\n\n' +
      'Description: ' + sug.description + '\n' +
      'Category: ' + sug.category + '\n' +
      'Type: ' + sug.type + '\n' +
      (sug.action_data ? 'Action data: ' + sug.action_data + '\n' : '');

    return new Promise((resolve) => {
      const child = spawn('claude', ['--model', 'haiku', '--max-turns', '1', '--print'], {
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        if (code !== 0) {
          request.log.error({ code, stderr }, 'suggestion translate failed');
          return resolve(reply.code(500).send({ error: 'Translation failed (exit ' + code + ')' }));
        }
        const translated = stdout.trim();
        if (!translated) {
          return resolve(reply.code(500).send({ error: 'Empty translation result' }));
        }
        updateSuggestionVi(db, id, translated);
        resolve({ description_vi: translated });
      });
      child.on('error', (err) => {
        request.log.error({ err }, 'suggestion translate spawn error');
        resolve(reply.code(500).send({ error: 'Translation failed: ' + err.message }));
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  });
};
