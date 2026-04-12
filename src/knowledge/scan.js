'use strict';

const fs = require('fs');
const path = require('path');

const { getExistingTitles } = require('./queries');
const { callClaude, parseJsonResponse, mergeOrUpdate, loadSkillTemplate } = require('./extract');
const { renderKnowledgeVault } = require('./vault');
const { insertPipelineRun } = require('../db/pipeline-runs');

// ---------------------------------------------------------------------------
// buildScanPrompt
// ---------------------------------------------------------------------------

/**
 * Builds LLM prompt for cold-start scan.
 *
 * @param {string}   projectName
 * @param {Object}   files           — {filename: content}
 * @param {string[]} [existingTitles]
 * @param {string}   [claudeMdContent]
 * @returns {string}
 */
function buildScanPrompt(projectName, files, existingTitles = [], claudeMdContent = '') {
  const fileBlocks = Object.entries(files).map(([name, content]) => {
    return `### ${name}\n\`\`\`\n${content}\n\`\`\``;
  }).join('\n\n');

  const claudeBlock = claudeMdContent
    ? [
        '',
        '### Already documented in CLAUDE.md (DO NOT extract knowledge that overlaps with this):',
        '```',
        claudeMdContent.slice(0, 3000),
        '```',
        '',
      ].join('\n')
    : '';

  const existingBlock = existingTitles.length
    ? `\nExisting knowledge titles (avoid duplicating these — compare case-insensitively):\n${existingTitles.map(t => `- ${t}`).join('\n')}\n`
    : '';

  const skillTemplate = loadSkillTemplate();

  if (skillTemplate) {
    return [
      `Project: ${projectName}`,
      '',
      'Perform a comprehensive knowledge extraction from the following project files.',
      claudeBlock,
      existingBlock,
      fileBlocks,
      '',
      '--- ENTRY FORMAT AND RULES ---',
      '',
      skillTemplate,
      '',
      '--- END FORMAT AND RULES ---',
      '',
      'Extract knowledge entries as a JSON array following the format above.',
      'Respond with a JSON array only. No explanation.',
    ].join('\n');
  }

  // Fallback if skill file missing
  return [
    `Project: ${projectName}`,
    '',
    'Perform a comprehensive knowledge extraction from the following project files.',
    claudeBlock,
    existingBlock,
    fileBlocks,
    '',
    'Extract knowledge entries as a JSON array. Each entry:',
    '  { "category": "<category>", "title": "<short title>", "body": "<detailed explanation>",',
    '    "source_file": "<file path if relevant, else null>", "tags": ["<tag>", ...] }',
    '',
    'Valid categories: domain, stack, schema, api, feature, architecture, convention,',
    '                  decision, footgun, contract, error_pattern',
    '',
    'Rules:',
    '- Only extract knowledge that CANNOT be derived by reading the source code directly',
    '- Each entry must be ACTIONABLE',
    '- Return [] if nothing genuinely new is found',
    '',
    'Respond with a JSON array only. No explanation.',
  ].join('\n');
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
  const model = opts.model || 'opus';
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
      const content = fs.readFileSync(fullPath, 'utf8').slice(0, 50000);
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
              files[key] = fs.readFileSync(fullPath, 'utf8').slice(0, 20000);
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
  const existingTitles = getExistingTitles(db, projectId);

  let claudeMdContent = '';
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  try { claudeMdContent = fs.readFileSync(claudeMdPath, 'utf8').slice(0, 20000); } catch { /* skip */ }

  const llmPrompt = buildScanPrompt(projectName, files, existingTitles, claudeMdContent);

  let claudeResult;
  try {
    claudeResult = await callClaude(llmPrompt, model);
  } catch (err) {
    insertPipelineRun(db, {
      pipeline: 'knowledge_scan',
      project_id: projectId,
      model,
      status: 'error',
      error: err.message,
      duration_ms: err.duration_ms || 0,
    });
    throw err;
  }

  insertPipelineRun(db, {
    pipeline: 'knowledge_scan',
    project_id: projectId,
    model,
    status: 'success',
    input_tokens: claudeResult.input_tokens,
    output_tokens: claudeResult.output_tokens,
    duration_ms: claudeResult.duration_ms,
  });

  const entries = parseJsonResponse(claudeResult.output);
  if (entries.length === 0) return { extracted: 0, inserted: 0, updated: 0 };

  const { inserted, updated } = mergeOrUpdate(db, projectId, entries);
  renderKnowledgeVault(db, projectId);

  return { extracted: entries.length, inserted, updated };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildScanPrompt,
  scanProject,
};
