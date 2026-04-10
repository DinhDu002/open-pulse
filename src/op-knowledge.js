'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const {
  upsertKgVaultHash,
  getKgVaultHash,
} = require('./op-db');

const {
  upsertKnowledgeEntry,
  getExistingTitles,
  queryKnowledgeEntries,
} = require('./db/knowledge-entries');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORY_FILES = {
  domain:        'domain.md',
  stack:         'stack.md',
  schema:        'schema.md',
  api:           'api.md',
  feature:       'features.md',
  architecture:  'architecture.md',
  convention:    'conventions.md',
  decision:      'decisions.md',
  footgun:       'footguns.md',
  contract:      'contracts.md',
  error_pattern: 'error-patterns.md',
};

const CATEGORY_TITLES = {
  domain:        'Domain & Business Logic',
  stack:         'Tech Stack',
  schema:        'Database Schema',
  api:           'API Contracts',
  feature:       'Features & Business Logic',
  architecture:  'Architecture',
  convention:    'Conventions',
  decision:      'Decisions',
  footgun:       'Footguns',
  contract:      'Contracts',
  error_pattern: 'Error Patterns',
};

const VALID_CATEGORIES = new Set(Object.keys(CATEGORY_FILES));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isGitRepo(dir) {
  try { return fs.statSync(path.join(dir, '.git')).isDirectory(); }
  catch { return false; }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Stable hash: strips timestamp lines so files aren't rewritten when only
 * timestamps change (reuses the same pattern as op-vault-generator.js).
 */
function stableHash(content) {
  const stable = content
    .replace(/^generated_at:.*$/m, '')
    .replace(/^> Generated at.*$/m, '')
    .replace(/^<!-- generated_at:.*-->$/m, '');
  return sha256(stable);
}

// ---------------------------------------------------------------------------
// buildExtractPrompt
// ---------------------------------------------------------------------------

/**
 * Builds LLM prompt for post-ingest extraction.
 *
 * @param {string} projectName
 * @param {Array}  events  — [{name, event_type, tool_input, tool_response}]
 * @param {string[]} existingTitles
 * @returns {string}
 */
function buildExtractPrompt(projectName, events, existingTitles = []) {
  const eventLines = events.map((ev, i) => {
    let detail = '';

    // Extract key fields from tool_input JSON
    if (ev.tool_input) {
      let input = {};
      try { input = JSON.parse(ev.tool_input); } catch { /* use empty */ }

      const key = input.file_path || input.command || input.pattern
        || input.path || input.query || null;
      if (key) detail += ` [${key}]`;
    }

    // Truncate tool_response to 300 chars
    let response = '';
    if (ev.tool_response) {
      response = String(ev.tool_response).slice(0, 300);
      if (ev.tool_response.length > 300) response += '…';
    }

    const lines = [`${i + 1}. [${ev.event_type}] ${ev.name || ''}${detail}`];
    if (response) lines.push(`   → ${response}`);
    return lines.join('\n');
  }).join('\n');

  const existingBlock = existingTitles.length
    ? `\nExisting knowledge titles (avoid duplicating these):\n${existingTitles.map(t => `- ${t}`).join('\n')}\n`
    : '';

  return [
    `Project: ${projectName}`,
    '',
    'Analyze the following tool usage events from a Claude Code session and extract',
    'reusable project knowledge that would help future sessions.',
    existingBlock,
    'Events:',
    eventLines,
    '',
    'Extract knowledge entries as a JSON array. Each entry:',
    '  { "category": "<category>", "title": "<short title>", "body": "<detailed explanation>",',
    '    "source_file": "<file path if relevant, else null>", "tags": ["<tag>", ...] }',
    '',
    'Valid categories: domain, stack, schema, api, feature, architecture, convention,',
    '                  decision, footgun, contract, error_pattern',
    '',
    'Rules:',
    '- Only extract knowledge that is reusable across sessions (not just what happened)',
    '- Skip trivial actions (reading a README, listing files)',
    '- Skip anything already in the existing titles list',
    '- Return [] if nothing reusable is found',
    '',
    'Respond with a JSON array only. No explanation.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// buildScanPrompt
// ---------------------------------------------------------------------------

/**
 * Builds LLM prompt for cold-start scan.
 *
 * @param {string} projectName
 * @param {Object} files — {filename: content}
 * @returns {string}
 */
function buildScanPrompt(projectName, files) {
  const fileBlocks = Object.entries(files).map(([name, content]) => {
    return `### ${name}\n\`\`\`\n${content}\n\`\`\``;
  }).join('\n\n');

  return [
    `Project: ${projectName}`,
    '',
    'Perform a comprehensive knowledge extraction from the following project files.',
    'Extract everything that helps understand the project: domain, stack, schema,',
    'API contracts, architectural decisions, conventions, footguns, and error patterns.',
    '',
    fileBlocks,
    '',
    'Extract knowledge entries as a JSON array. Each entry:',
    '  { "category": "<category>", "title": "<short title>", "body": "<detailed explanation>",',
    '    "source_file": "<file path if relevant, else null>", "tags": ["<tag>", ...] }',
    '',
    'Valid categories: domain, stack, schema, api, feature, architecture, convention,',
    '                  decision, footgun, contract, error_pattern',
    '',
    'Be thorough. Return [] only if no useful knowledge can be extracted.',
    '',
    'Respond with a JSON array only. No explanation.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// callHaiku
// ---------------------------------------------------------------------------

/**
 * Calls Claude Haiku API.
 *
 * @param {string} apiKey
 * @param {string} prompt
 * @param {number} [maxTokens=1024]
 * @returns {Promise<string>} response text
 */
function callHaiku(apiKey, prompt, maxTokens = 1024) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          resolve(data.content?.[0]?.text || '');
        } catch {
          reject(new Error(`Failed to parse Haiku response: ${raw}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// parseJsonResponse
// ---------------------------------------------------------------------------

/**
 * Extracts a JSON array from LLM response text.
 *
 * @param {string} text
 * @returns {Array}
 */
function parseJsonResponse(text) {
  if (!text) return [];
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// mergeOrUpdate
// ---------------------------------------------------------------------------

/**
 * Upsert knowledge entries into DB and return insert/update counts.
 *
 * Distinguishes insert vs update by comparing created_at === updated_at on
 * the returned row. A fresh insert will have both equal; an update will have
 * updated_at > created_at.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {Array}  newEntries — [{category, title, body, source_file, tags}]
 * @returns {{ inserted: number, updated: number }}
 */
function mergeOrUpdate(db, projectId, newEntries) {
  let inserted = 0;
  let updated = 0;

  for (const entry of newEntries) {
    const category = VALID_CATEGORIES.has(entry.category) ? entry.category : 'domain';

    const result = upsertKnowledgeEntry(db, {
      project_id:  projectId,
      category,
      title:       entry.title || 'Untitled',
      body:        entry.body || '',
      source_file: entry.source_file || null,
      tags:        entry.tags || [],
    });

    // created_at === updated_at → just inserted; otherwise updated
    if (result.created_at === result.updated_at) {
      inserted++;
    } else {
      updated++;
    }
  }

  return { inserted, updated };
}

// ---------------------------------------------------------------------------
// renderCategoryPage
// ---------------------------------------------------------------------------

/**
 * Renders markdown for one category file.
 *
 * @param {string} category
 * @param {Array}  entries — knowledge_entries rows
 * @returns {string}
 */
function renderCategoryPage(category, entries) {
  const title = CATEGORY_TITLES[category] || category;
  const now = new Date().toISOString();

  const lines = [
    '<!-- Auto-generated by Open Pulse. Do not edit. -->',
    `<!-- generated_at: ${now} -->`,
    '',
    `# ${title}`,
    '',
  ];

  for (const entry of entries) {
    let tags = [];
    try { tags = JSON.parse(entry.tags || '[]'); } catch { /* ignore */ }

    lines.push(`## ${entry.title}`, '');
    lines.push(entry.body || '', '');

    if (entry.source_file) {
      lines.push(`_Source: \`${entry.source_file}\`_`, '');
    }

    if (tags.length > 0) {
      lines.push(`_Tags: ${tags.map(t => `\`${t}\``).join(', ')}_`, '');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderIndexPage
// ---------------------------------------------------------------------------

/**
 * Renders index.md with table of contents grouped by category.
 *
 * @param {string} projectName
 * @param {Object} entriesByCategory — { [category]: entries[] }
 * @returns {string}
 */
function renderIndexPage(projectName, entriesByCategory) {
  const now = new Date().toISOString();

  const lines = [
    '<!-- Auto-generated by Open Pulse. Do not edit. -->',
    `<!-- generated_at: ${now} -->`,
    '',
    `# Knowledge Base — ${projectName}`,
    '',
    `> Generated at ${now}`,
    '',
  ];

  const categories = Object.keys(entriesByCategory).sort();

  if (categories.length === 0) {
    lines.push('_No knowledge entries yet._', '');
    return lines.join('\n');
  }

  for (const cat of categories) {
    const entries = entriesByCategory[cat];
    if (!entries || entries.length === 0) continue;

    const catTitle = CATEGORY_TITLES[cat] || cat;
    const fileName = CATEGORY_FILES[cat] || `${cat}.md`;

    lines.push(`## ${catTitle}`, '');
    for (const entry of entries) {
      lines.push(`- [${entry.title}](${fileName})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderKnowledgeVault
// ---------------------------------------------------------------------------

/**
 * Generates .md files per category into <project_dir>/.claude/knowledge/.
 * Uses content-hash dedup (kg_vault_hashes) to skip unchanged files.
 * Only renders for git repos.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {{ filesWritten: number, filesSkipped: number }}
 */
function renderKnowledgeVault(db, projectId) {
  const project = db.prepare('SELECT * FROM cl_projects WHERE project_id = ?').get(projectId);
  if (!project || !project.directory || !isGitRepo(project.directory)) {
    return { filesWritten: 0, filesSkipped: 0 };
  }

  const vaultDir = path.join(project.directory, '.claude', 'knowledge');
  fs.mkdirSync(vaultDir, { recursive: true });

  // Query all active entries for this project
  const { items: allEntries } = queryKnowledgeEntries(db, {
    projectId,
    status: 'active',
    perPage: 1000,
  });

  // Group entries by category
  const entriesByCategory = {};
  for (const entry of allEntries) {
    if (!entriesByCategory[entry.category]) {
      entriesByCategory[entry.category] = [];
    }
    entriesByCategory[entry.category].push(entry);
  }

  let filesWritten = 0;
  let filesSkipped = 0;

  // Render one file per category
  for (const [category, entries] of Object.entries(entriesByCategory)) {
    const fileName = CATEGORY_FILES[category] || `${category}.md`;
    const relPath = fileName;
    const fullPath = path.join(vaultDir, relPath);

    const content = renderCategoryPage(category, entries);
    const hash = stableHash(content);
    const stored = getKgVaultHash(db, projectId, relPath);

    if (stored === hash) {
      filesSkipped++;
      continue;
    }

    fs.writeFileSync(fullPath, content, 'utf8');
    upsertKgVaultHash(db, { project_id: projectId, file_path: relPath, content_hash: hash });
    filesWritten++;
  }

  // Render index.md
  const projectName = project.name || projectId;
  const indexContent = renderIndexPage(projectName, entriesByCategory);
  const indexRelPath = 'index.md';
  const indexHash = stableHash(indexContent);
  const storedIndex = getKgVaultHash(db, projectId, indexRelPath);

  if (storedIndex === indexHash) {
    filesSkipped++;
  } else {
    fs.writeFileSync(path.join(vaultDir, indexRelPath), indexContent, 'utf8');
    upsertKgVaultHash(db, { project_id: projectId, file_path: indexRelPath, content_hash: indexHash });
    filesWritten++;
  }

  return { filesWritten, filesSkipped };
}

// ---------------------------------------------------------------------------
// extractKnowledgeFromPrompt
// ---------------------------------------------------------------------------

/**
 * Full extraction pipeline triggered after a prompt is ingested.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} promptId
 * @param {object} [opts]
 * @param {number} [opts.maxEvents=50]
 * @returns {Promise<{extracted:number, inserted:number, updated:number}|{message:string}>}
 */
async function extractKnowledgeFromPrompt(db, promptId, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { message: 'ANTHROPIC_API_KEY not set' };
  }

  const maxEvents = opts.maxEvents ?? 50;

  // Get prompt
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(promptId);
  if (!prompt) return { message: `Prompt ${promptId} not found` };

  // Get session
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(prompt.session_id);
  if (!session) return { message: `Session ${prompt.session_id} not found` };

  // Resolve project via working_directory
  const project = db.prepare(
    'SELECT * FROM cl_projects WHERE directory = ?'
  ).get(session.working_directory);
  if (!project) return { message: `No project found for directory: ${session.working_directory}` };

  // Get events for this prompt
  const events = db.prepare(
    'SELECT name, event_type, tool_input, tool_response FROM events WHERE prompt_id = ? ORDER BY seq_num ASC LIMIT ?'
  ).all(promptId, maxEvents);

  if (events.length === 0) return { message: 'No events for this prompt' };

  // Get existing titles for dedup
  const existingTitles = getExistingTitles(db, project.project_id);

  // Build prompt and call Haiku
  const llmPrompt = buildExtractPrompt(project.name || project.project_id, events, existingTitles);
  const rawResponse = await callHaiku(apiKey, llmPrompt);
  const entries = parseJsonResponse(rawResponse);

  if (entries.length === 0) return { extracted: 0, inserted: 0, updated: 0 };

  // Merge into DB
  const { inserted, updated } = mergeOrUpdate(db, project.project_id, entries);

  // Render vault
  renderKnowledgeVault(db, project.project_id);

  return { extracted: entries.length, inserted, updated };
}

// ---------------------------------------------------------------------------
// scanProject
// ---------------------------------------------------------------------------

/**
 * Cold-start scan pipeline. Reads files and extracts knowledge.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {object} [opts]
 * @param {string[]} [opts.scanFiles]    — explicit filenames to read
 * @param {string[]} [opts.patterns]     — glob-like patterns (checks src/ dir)
 * @returns {Promise<{extracted:number, inserted:number, updated:number}|{message:string}>}
 */
async function scanProject(db, projectId, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { message: 'ANTHROPIC_API_KEY not set' };
  }

  const project = db.prepare('SELECT * FROM cl_projects WHERE project_id = ?').get(projectId);
  if (!project || !project.directory) {
    return { message: `Project ${projectId} not found or has no directory` };
  }

  const projectDir = project.directory;
  const files = {};

  // Read explicit scanFiles (capped at 5000 chars each)
  const scanFiles = opts.scanFiles || [];
  for (const filename of scanFiles) {
    const fullPath = path.join(projectDir, filename);
    try {
      const content = fs.readFileSync(fullPath, 'utf8').slice(0, 5000);
      files[filename] = content;
    } catch {
      // File doesn't exist or can't be read — skip
    }
  }

  // Read files matching patterns by checking src/ directory (capped at 3000 chars each)
  const patterns = opts.patterns || [];
  if (patterns.length > 0) {
    const srcDir = path.join(projectDir, 'src');
    let srcFiles = [];
    try { srcFiles = fs.readdirSync(srcDir); } catch { /* src/ doesn't exist */ }

    for (const pattern of patterns) {
      // Simple matching: filename includes the pattern (strip leading wildcards)
      const clean = pattern.replace(/^[\*\.]+/, '');
      for (const fname of srcFiles) {
        if (fname.includes(clean)) {
          const key = `src/${fname}`;
          if (!files[key]) {
            const fullPath = path.join(srcDir, fname);
            try {
              files[key] = fs.readFileSync(fullPath, 'utf8').slice(0, 3000);
            } catch { /* skip */ }
          }
        }
      }
    }
  }

  if (Object.keys(files).length === 0) {
    return { message: 'No files found to scan' };
  }

  const projectName = project.name || projectId;
  const llmPrompt = buildScanPrompt(projectName, files);
  const rawResponse = await callHaiku(apiKey, llmPrompt, 2048);
  const entries = parseJsonResponse(rawResponse);

  if (entries.length === 0) return { extracted: 0, inserted: 0, updated: 0 };

  const { inserted, updated } = mergeOrUpdate(db, projectId, entries);

  renderKnowledgeVault(db, projectId);

  return { extracted: entries.length, inserted, updated };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  CATEGORY_FILES,
  CATEGORY_TITLES,
  buildExtractPrompt,
  buildScanPrompt,
  callHaiku,
  parseJsonResponse,
  mergeOrUpdate,
  extractKnowledgeFromPrompt,
  scanProject,
  renderKnowledgeVault,
  renderCategoryPage,
  renderIndexPage,
};
