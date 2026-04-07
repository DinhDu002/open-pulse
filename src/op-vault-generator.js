'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  getKgGraph,
  getKgEdges,
  upsertKgVaultHash,
  getKgVaultHash,
  setKgSyncState,
} = require('./op-db');

// ---------------------------------------------------------------------------
// nodeIdToPath
// ---------------------------------------------------------------------------

/**
 * Maps a KG node ID to a relative vault file path.
 *
 * Examples:
 *   tool:Read                     → tools/Read.md
 *   component:agent:code-reviewer → components/agent:code-reviewer.md
 *   instinct:my-inst              → instincts/my-inst.md
 *   pattern:read-edit             → patterns/read-edit.md
 *   session:s1                    → other/s1.md
 *
 * @param {string} id
 * @returns {string}
 */
function nodeIdToPath(id) {
  const colonIdx = id.indexOf(':');
  if (colonIdx === -1) return `other/${id}.md`;

  const type = id.slice(0, colonIdx);
  const rest = id.slice(colonIdx + 1);

  switch (type) {
    case 'tool':      return `tools/${rest}.md`;
    case 'component': return `components/${rest}.md`;
    case 'instinct':  return `instincts/${rest}.md`;
    case 'pattern':   return `patterns/${rest}.md`;
    default:          return `other/${rest}.md`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseProperties(node) {
  if (!node.properties) return {};
  if (typeof node.properties === 'object') return node.properties;
  try { return JSON.parse(node.properties); } catch { return {}; }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Compute a stable hash by stripping timestamp-only lines before hashing.
 * Removes `generated_at: <timestamp>` from frontmatter and `> Generated at <timestamp>` from body
 * so that files are only re-written when actual content changes.
 */
function stableHash(content) {
  const stable = content
    .replace(/^generated_at:.*$/m, '')
    .replace(/^> Generated at.*$/m, '');
  return sha256(stable);
}

function isoNow() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// renderToolPage
// ---------------------------------------------------------------------------

/**
 * Generates markdown for a tool node.
 *
 * @param {object} node           - kg_nodes row
 * @param {Array}  outgoingEdges  - kg_edges rows where source_id = node.id
 * @returns {string}
 */
function renderToolPage(node, outgoingEdges) {
  const props = parseProperties(node);
  const {
    invocations = 0,
    sessions_used = 0,
    success_rate = null,
    last_used = null,
  } = props;

  const frontmatter = [
    '---',
    `type: tool`,
    `total_invocations: ${invocations}`,
    `sessions_used: ${sessions_used}`,
    success_rate !== null ? `success_rate: ${success_rate}` : null,
    last_used ? `last_used: ${last_used}` : null,
    `generated_at: ${isoNow()}`,
    '---',
  ].filter(Boolean).join('\n');

  const lines = [frontmatter, '', `# ${node.name}`, ''];

  // Relationships section
  const triggers = outgoingEdges.filter(e => e.relationship === 'triggers');
  const coOccurs = outgoingEdges.filter(e => e.relationship === 'co_occurs');

  if (triggers.length > 0 || coOccurs.length > 0) {
    lines.push('## Relationships', '');
    if (triggers.length > 0) {
      lines.push('**Triggers:**');
      for (const e of triggers) {
        const targetPath = nodeIdToPath(e.target_id).replace(/\.md$/, '');
        lines.push(`- [[${targetPath}]] (weight: ${e.weight})`);
      }
      lines.push('');
    }
    if (coOccurs.length > 0) {
      lines.push('**Co-occurs with:**');
      for (const e of coOccurs) {
        const targetPath = nodeIdToPath(e.target_id).replace(/\.md$/, '');
        lines.push(`- [[${targetPath}]] (weight: ${e.weight})`);
      }
      lines.push('');
    }
  }

  // Stats section
  lines.push('## Stats', '');
  lines.push(`- **Total invocations:** ${invocations}`);
  lines.push(`- **Sessions used:** ${sessions_used}`);
  if (success_rate !== null) {
    lines.push(`- **Success rate:** ${(success_rate * 100).toFixed(1)}%`);
  }
  if (last_used) {
    lines.push(`- **Last used:** ${last_used}`);
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderInstinctPage
// ---------------------------------------------------------------------------

/**
 * Generates markdown for an instinct node.
 *
 * @param {object} node - kg_nodes row
 * @returns {string}
 */
function renderInstinctPage(node) {
  const props = parseProperties(node);
  const {
    project_id = null,
    category = null,
    confidence = 0,
    seen_count = 0,
    last_seen = null,
  } = props;

  const frontmatter = [
    '---',
    `type: instinct`,
    project_id ? `project_id: ${project_id}` : null,
    category ? `category: ${category}` : null,
    `confidence: ${confidence}`,
    `seen_count: ${seen_count}`,
    last_seen ? `last_seen: ${last_seen}` : null,
    `generated_at: ${isoNow()}`,
    '---',
  ].filter(Boolean).join('\n');

  const lines = [
    frontmatter,
    '',
    `# ${node.name}`,
    '',
    '## Pattern',
    '',
    node.name,
    '',
    '## Confidence',
    '',
    `**${(confidence * 100).toFixed(0)}%** (seen ${seen_count} times)`,
    '',
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderComponentPage
// ---------------------------------------------------------------------------

/**
 * Generates markdown for a component node (skill/agent/hook/rule).
 *
 * @param {object} node          - kg_nodes row
 * @param {Array}  outgoingEdges - kg_edges rows where source_id = node.id
 * @returns {string}
 */
function renderComponentPage(node, outgoingEdges) {
  const props = parseProperties(node);
  const {
    component_type = null,
    description = null,
    invocations = 0,
    sessions_used = 0,
    last_used = null,
    last_seen_at = null,
  } = props;

  const frontmatter = [
    '---',
    `type: component`,
    component_type ? `component_type: ${component_type}` : null,
    `invocations: ${invocations}`,
    `sessions_used: ${sessions_used}`,
    last_used || last_seen_at ? `last_used: ${last_used || last_seen_at}` : null,
    `generated_at: ${isoNow()}`,
    '---',
  ].filter(Boolean).join('\n');

  const lines = [frontmatter, '', `# ${node.name}`, ''];

  if (description) {
    lines.push('## Description', '', description, '');
  }

  const triggers = outgoingEdges.filter(e => e.relationship === 'triggers');
  if (triggers.length > 0) {
    lines.push('## Triggers', '');
    for (const e of triggers) {
      const targetPath = nodeIdToPath(e.target_id).replace(/\.md$/, '');
      lines.push(`- [[${targetPath}]] (weight: ${e.weight})`);
    }
    lines.push('');
  }

  lines.push('## Stats', '');
  lines.push(`- **Invocations:** ${invocations}`);
  lines.push(`- **Sessions used:** ${sessions_used}`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderPatternPage
// ---------------------------------------------------------------------------

/**
 * Generates markdown for a pattern node.
 *
 * @param {object} node - kg_nodes row
 * @returns {string}
 */
function renderPatternPage(node) {
  const props = parseProperties(node);
  const {
    source = null,
    target = null,
    weight = 0,
  } = props;

  const frontmatter = [
    '---',
    `type: pattern`,
    source ? `source: ${source}` : null,
    target ? `target: ${target}` : null,
    `occurrences: ${weight}`,
    `generated_at: ${isoNow()}`,
    '---',
  ].filter(Boolean).join('\n');

  const lines = [frontmatter, '', `# ${node.name}`, ''];

  lines.push('## Pattern', '');
  lines.push(`This pattern describes: **${node.name}**`, '');
  lines.push(`**Occurrence count:** ${weight}`, '');

  if (source && target) {
    const srcPath = nodeIdToPath(source).replace(/\.md$/, '');
    const tgtPath = nodeIdToPath(target).replace(/\.md$/, '');
    lines.push('## Nodes', '');
    lines.push(`- Source: [[${srcPath}]]`);
    lines.push(`- Target: [[${tgtPath}]]`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderIndexPage
// ---------------------------------------------------------------------------

/**
 * Generates index.md as a table of contents for the vault.
 *
 * @param {Array}  nodes       - Array of kg_nodes rows (already filtered, non-session)
 * @param {Array}  edges       - Array of kg_edges rows
 * @param {string} projectName - Display name of the project
 * @returns {string}
 */
function renderIndexPage(nodes, edges, projectName) {
  const MAX_ITEMS = 10;

  // Separate by type
  const tools = nodes.filter(n => n.type === 'tool');
  const components = nodes.filter(n => n.type === 'component');
  const patterns = nodes.filter(n => n.type === 'pattern');
  const instincts = nodes.filter(n => n.type === 'instinct');

  // Sort by relevant metric
  const byInvocations = (a, b) => {
    const pa = parseProperties(a);
    const pb = parseProperties(b);
    return (pb.invocations || 0) - (pa.invocations || 0);
  };
  const byConfidence = (a, b) => {
    const pa = parseProperties(a);
    const pb = parseProperties(b);
    return (pb.confidence || 0) - (pa.confidence || 0);
  };
  const byOccurrences = (a, b) => {
    const pa = parseProperties(a);
    const pb = parseProperties(b);
    return (pb.weight || 0) - (pa.weight || 0);
  };

  const topTools = [...tools].sort(byInvocations).slice(0, MAX_ITEMS);
  const topComponents = [...components].sort(byInvocations).slice(0, MAX_ITEMS);
  const topPatterns = [...patterns].sort(byOccurrences).slice(0, MAX_ITEMS);
  const validatedInstincts = [...instincts].sort(byConfidence).slice(0, MAX_ITEMS);

  const lines = [
    '<!-- Auto-generated by Open Pulse. Do not edit. -->',
    '',
    `# Knowledge Base — ${projectName}`,
    '',
    `> Generated at ${isoNow()}`,
    '',
  ];

  // Top Tools
  lines.push('## Top Tools', '');
  if (topTools.length === 0) {
    lines.push('_No tool data yet._', '');
  } else {
    for (const node of topTools) {
      const props = parseProperties(node);
      const filePath = nodeIdToPath(node.id).replace(/\.md$/, '');
      lines.push(`- [[${filePath}]] — ${props.invocations || 0} invocations`);
    }
    lines.push('');
  }

  // Active Components
  lines.push('## Active Components', '');
  if (topComponents.length === 0) {
    lines.push('_No component data yet._', '');
  } else {
    for (const node of topComponents) {
      const props = parseProperties(node);
      const filePath = nodeIdToPath(node.id).replace(/\.md$/, '');
      lines.push(`- [[${filePath}]] — ${props.invocations || props.sessions_used || 0} invocations`);
    }
    lines.push('');
  }

  // Key Patterns
  lines.push('## Key Patterns', '');
  if (topPatterns.length === 0) {
    lines.push('_No patterns detected yet._', '');
  } else {
    for (const node of topPatterns) {
      const props = parseProperties(node);
      const filePath = nodeIdToPath(node.id).replace(/\.md$/, '');
      lines.push(`- [[${filePath}]] — ${props.weight || 0} occurrences`);
    }
    lines.push('');
  }

  // Validated Instincts
  lines.push('## Validated Instincts', '');
  if (validatedInstincts.length === 0) {
    lines.push('_No validated instincts yet._', '');
  } else {
    for (const node of validatedInstincts) {
      const props = parseProperties(node);
      const filePath = nodeIdToPath(node.id).replace(/\.md$/, '');
      lines.push(`- [[${filePath}]] — confidence ${((props.confidence || 0) * 100).toFixed(0)}%`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// generateVault
// ---------------------------------------------------------------------------

/**
 * Generate per-project vault: renders .md files into {projectDir}/.claude/knowledge/
 * Uses SHA-256 to skip unchanged files.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {{ filesWritten: number, filesSkipped: number }}
 */
function generateVault(db, projectId) {
  // Look up the project directory
  const project = db.prepare('SELECT * FROM cl_projects WHERE project_id = ?').get(projectId);
  if (!project || !project.directory) {
    return { filesWritten: 0, filesSkipped: 0 };
  }

  const vaultDir = path.join(project.directory, '.claude', 'knowledge');
  fs.mkdirSync(vaultDir, { recursive: true });

  // Query all KG nodes and edges, filter out session nodes (too noisy)
  const { nodes, edges } = getKgGraph(db);
  const filteredNodes = nodes.filter(n => n.type !== 'session' && n.type !== 'project');

  let filesWritten = 0;
  let filesSkipped = 0;

  // Render each node page
  for (const node of filteredNodes) {
    const relPath = nodeIdToPath(node.id);
    const fullPath = path.join(vaultDir, relPath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });

    // Get outgoing edges for this node
    const outgoing = edges.filter(e => e.source_id === node.id);

    // Render content based on node type
    let content;
    switch (node.type) {
      case 'tool':
        content = renderToolPage(node, outgoing);
        break;
      case 'component':
        content = renderComponentPage(node, outgoing);
        break;
      case 'instinct':
        content = renderInstinctPage(node);
        break;
      case 'pattern':
        content = renderPatternPage(node);
        break;
      default:
        // Generic fallback
        content = `---\ntype: ${node.type}\ngenerated_at: ${isoNow()}\n---\n\n# ${node.name}\n`;
    }

    // SHA-256 deduplication (stable: excludes timestamp-only fields)
    const hash = stableHash(content);
    const stored = getKgVaultHash(db, projectId, relPath);

    if (stored === hash) {
      filesSkipped++;
      continue;
    }

    fs.writeFileSync(fullPath, content, 'utf8');
    upsertKgVaultHash(db, { project_id: projectId, file_path: relPath, content_hash: hash }); // hash is stableHash
    filesWritten++;
  }

  // Generate index.md
  const projectName = project.name || projectId;
  const indexContent = renderIndexPage(filteredNodes, edges, projectName);
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

  // Record vault generation timestamp
  setKgSyncState(db, 'last_vault_gen_at', isoNow());

  return { filesWritten, filesSkipped };
}

// ---------------------------------------------------------------------------
// generateAllVaults
// ---------------------------------------------------------------------------

/**
 * Iterate all projects and generate their vaults.
 * Projects without a directory are skipped.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{ projectId: string, filesWritten: number, filesSkipped: number }>}
 */
function generateAllVaults(db) {
  const projects = db.prepare(
    'SELECT project_id, directory FROM cl_projects WHERE directory IS NOT NULL'
  ).all();

  const results = [];
  for (const proj of projects) {
    const { filesWritten, filesSkipped } = generateVault(db, proj.project_id);
    results.push({ projectId: proj.project_id, filesWritten, filesSkipped });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  nodeIdToPath,
  renderToolPage,
  renderInstinctPage,
  renderComponentPage,
  renderPatternPage,
  renderIndexPage,
  generateVault,
  generateAllVaults,
};
