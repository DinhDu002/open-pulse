#!/usr/bin/env node
'use strict';

/**
 * Cold-start seeding for Continuous Learning.
 *
 * Part A: Parse project CLAUDE.md for rules → project-scoped instincts
 * Part B: Copy universal starter instincts → global inherited
 *
 * Usage:
 *   node seed.js [--repo-dir <path>] [--claude-md <path>] [--project-id <id>]
 *
 * Idempotent: skips files that already exist.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Starter instincts (universal, shipped with Open Pulse)
// ---------------------------------------------------------------------------

const STARTER_INSTINCTS = [
  {
    id: 'grep-before-edit',
    trigger: 'before editing an unfamiliar file',
    confidence: 0.5,
    domain: 'workflow',
    type: 'rule',
    body: '## Action\nSearch for the target code with Grep before using Edit, to ensure you modify the correct location.\n\n## Evidence\n- Universal best practice for reducing unintended edits',
  },
  {
    id: 'read-before-write',
    trigger: 'before creating or overwriting a file',
    confidence: 0.5,
    domain: 'workflow',
    type: 'rule',
    body: '## Action\nRead the existing file first to understand its structure and avoid losing content.\n\n## Evidence\n- Prevents accidental overwrites of existing work',
  },
  {
    id: 'test-after-change',
    trigger: 'after modifying implementation code',
    confidence: 0.5,
    domain: 'testing',
    type: 'rule',
    body: '## Action\nRun the relevant test suite after making code changes to catch regressions early.\n\n## Evidence\n- Standard TDD/CI practice',
  },
  {
    id: 'small-focused-commits',
    trigger: 'when preparing a git commit',
    confidence: 0.5,
    domain: 'git',
    type: 'rule',
    body: '## Action\nKeep commits small and focused on a single logical change. Use descriptive commit messages.\n\n## Evidence\n- Makes code review easier and git history more useful',
  },
  {
    id: 'validate-user-input',
    trigger: 'when handling user-provided data',
    confidence: 0.5,
    domain: 'security',
    type: 'rule',
    body: '## Action\nValidate and sanitize all user input at system boundaries before processing.\n\n## Evidence\n- OWASP Top 10 best practice for preventing injection attacks',
  },
  {
    id: 'handle-errors-explicitly',
    trigger: 'when writing async or fallible operations',
    confidence: 0.5,
    domain: 'code-style',
    type: 'rule',
    body: '## Action\nHandle errors explicitly rather than silently swallowing them. Log or propagate meaningfully.\n\n## Evidence\n- Silent failures are the hardest bugs to debug',
  },
  {
    id: 'check-existing-before-creating',
    trigger: 'before creating a new file or function',
    confidence: 0.5,
    domain: 'workflow',
    type: 'rule',
    body: '## Action\nSearch the codebase for existing implementations before creating new ones to avoid duplication.\n\n## Evidence\n- Reduces code duplication and maintenance burden',
  },
  {
    id: 'prefer-dedicated-tools',
    trigger: 'when performing file operations',
    confidence: 0.5,
    domain: 'workflow',
    type: 'rule',
    body: '## Action\nUse dedicated tools (Read, Edit, Grep, Glob) instead of shell equivalents (cat, sed, grep) for better reliability.\n\n## Evidence\n- Dedicated tools provide better error handling and user experience',
  },
  {
    id: 'verify-before-done',
    trigger: 'before declaring a task complete',
    confidence: 0.5,
    domain: 'workflow',
    type: 'rule',
    body: '## Action\nRun tests and verify the change works before declaring the task done.\n\n## Evidence\n- Prevents false completion reports and follow-up debugging sessions',
  },
  {
    id: 'immutable-data-patterns',
    trigger: 'when modifying data structures',
    confidence: 0.5,
    domain: 'code-style',
    type: 'rule',
    body: '## Action\nCreate new objects instead of mutating existing ones. Use spread/Object.assign for updates.\n\n## Evidence\n- Prevents hidden side effects and makes debugging easier',
  },
];

// ---------------------------------------------------------------------------
// CLAUDE.md rule extraction
// ---------------------------------------------------------------------------

const RULE_INDICATORS = /^[-*]\s+(ALWAYS|NEVER|MUST|SHOULD|DO NOT|DON'T)\b/i;
const HEADER_INDICATORS = /^#{1,3}\s+.*(rules?|conventions?|guidelines?|standards?|requirements?)/i;

/**
 * Extract rules from a CLAUDE.md file.
 * @param {string} content
 * @returns {Array<{text: string, source: string}>}
 */
function extractRulesFromClaudeMd(content) {
  const rules = [];
  const lines = content.split('\n');
  let inRulesSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track if we're under a rules/conventions header
    if (/^#{1,3}\s+/.test(line)) {
      inRulesSection = HEADER_INDICATORS.test(line);
    }

    // Extract bullet points with rule indicators
    if (RULE_INDICATORS.test(line)) {
      const text = line.replace(/^[-*]\s+/, '').trim();
      if (text.length >= 10 && text.length <= 200) {
        rules.push({ text, source: 'claude-md-rule' });
      }
    }

    // Extract bullets under rules sections
    if (inRulesSection && /^[-*]\s+\w/.test(line)) {
      const text = line.replace(/^[-*]\s+/, '').trim();
      if (text.length >= 10 && text.length <= 200 && !rules.some(r => r.text === text)) {
        rules.push({ text, source: 'claude-md-section' });
      }
    }
  }

  return rules;
}

/**
 * Convert extracted rule to instinct ID (kebab-case).
 * @param {string} text
 * @returns {string}
 */
function ruleToId(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 50)
    .replace(/-+$/, '');
}

/**
 * Map rule text to a domain.
 * @param {string} text
 * @returns {string}
 */
function ruleToDomain(text) {
  const lower = text.toLowerCase();
  if (/test|spec|coverage|tdd/.test(lower)) return 'testing';
  if (/commit|branch|merge|push|git/.test(lower)) return 'git';
  if (/secur|secret|token|password|inject/.test(lower)) return 'security';
  if (/debug|error|log/.test(lower)) return 'debugging';
  if (/style|format|naming|convention/.test(lower)) return 'code-style';
  return 'workflow';
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeInstinct(instinct) {
  const lines = [
    '---',
    `id: ${instinct.id}`,
    `trigger: "${instinct.trigger}"`,
    `confidence: ${instinct.confidence}`,
    `domain: ${instinct.domain}`,
    `name: ${instinct.name || instinct.title || instinct.id}`,
    `type: ${instinct.type || 'rule'}`,
    `source: ${instinct.source}`,
    `scope: ${instinct.scope}`,
  ];
  if (instinct.project_id) lines.push(`project_id: ${instinct.project_id}`);
  if (instinct.project_name) lines.push(`project_name: ${instinct.project_name}`);
  lines.push('---', '', `# ${instinct.title || instinct.id}`, '', instinct.body, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Seeding logic
// ---------------------------------------------------------------------------

/**
 * Seed global starter instincts.
 * @param {string} repoDir
 * @returns {number} Number of instincts written
 */
function seedStarter(repoDir) {
  const targetDir = path.join(repoDir, 'cl', 'instincts', 'inherited');
  fs.mkdirSync(targetDir, { recursive: true });

  let written = 0;
  for (const inst of STARTER_INSTINCTS) {
    const filePath = path.join(targetDir, `${inst.id}.md`);
    if (fs.existsSync(filePath)) continue;

    const content = serializeInstinct({
      ...inst,
      trigger: inst.trigger,
      source: 'starter-pack',
      scope: 'global',
      title: inst.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      body: inst.body,
    });
    fs.writeFileSync(filePath, content, 'utf8');
    written++;
  }
  return written;
}

/**
 * Seed project instincts from CLAUDE.md.
 * @param {string} repoDir
 * @param {string} claudeMdPath
 * @param {string} projectId
 * @param {string} projectName
 * @returns {number} Number of instincts written
 */
function seedFromClaudeMd(repoDir, claudeMdPath, projectId, projectName) {
  if (!fs.existsSync(claudeMdPath)) return 0;

  const content = fs.readFileSync(claudeMdPath, 'utf8');
  const rules = extractRulesFromClaudeMd(content);
  if (rules.length === 0) return 0;

  const targetDir = projectId
    ? path.join(repoDir, 'cl', 'projects', projectId, 'instincts', 'inherited')
    : path.join(repoDir, 'cl', 'instincts', 'inherited');
  fs.mkdirSync(targetDir, { recursive: true });

  let written = 0;
  for (const rule of rules) {
    const id = ruleToId(rule.text);
    if (!id || id.length < 3) continue;

    const filePath = path.join(targetDir, `${id}.md`);
    if (fs.existsSync(filePath)) continue;

    const instinct = serializeInstinct({
      id,
      trigger: `when relevant to: ${rule.text.slice(0, 80)}`,
      confidence: 0.7,
      domain: ruleToDomain(rule.text),
      type: 'rule',
      source: 'claude-md',
      scope: projectId ? 'project' : 'global',
      project_id: projectId || undefined,
      project_name: projectName || undefined,
      title: id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      body: `## Action\n${rule.text}\n\n## Evidence\n- Extracted from CLAUDE.md (${rule.source})`,
    });
    fs.writeFileSync(filePath, instinct, 'utf8');
    written++;
  }
  return written;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { repoDir: null, claudeMd: null, projectId: null, projectName: null };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--repo-dir':   args.repoDir = argv[++i]; break;
      case '--claude-md':  args.claudeMd = argv[++i]; break;
      case '--project-id': args.projectId = argv[++i]; break;
      case '--project-name': args.projectName = argv[++i]; break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const repoDir = args.repoDir || path.resolve(__dirname, '../..');

  // Part A: Seed global starter instincts
  const starterCount = seedStarter(repoDir);
  if (starterCount > 0) {
    console.log(`  Seeded ${starterCount} global starter instincts`);
  } else {
    console.log('  Global starter instincts already present');
  }

  // Part B: Seed from CLAUDE.md (if provided or found in project root)
  const claudeMdPath = args.claudeMd
    || (args.projectId ? path.join(repoDir, 'CLAUDE.md') : null);

  if (claudeMdPath && fs.existsSync(claudeMdPath)) {
    const mdCount = seedFromClaudeMd(repoDir, claudeMdPath, args.projectId, args.projectName);
    if (mdCount > 0) {
      console.log(`  Seeded ${mdCount} instincts from CLAUDE.md`);
    } else {
      console.log('  No new rules extracted from CLAUDE.md');
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  STARTER_INSTINCTS,
  extractRulesFromClaudeMd,
  ruleToId,
  ruleToDomain,
  seedStarter,
  seedFromClaudeMd,
};

if (require.main === module) {
  main().catch(err => {
    console.error(`seed: ${err.message}`);
    process.exit(1);
  });
}
