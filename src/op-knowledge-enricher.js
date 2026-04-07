'use strict';

const https = require('https');
const { getKgNode, getKgEdges, upsertKgNode, setKgSyncState } = require('./op-db');

// ---------------------------------------------------------------------------
// buildEnrichmentPrompt
// ---------------------------------------------------------------------------

function buildEnrichmentPrompt(db, nodeId) {
  const node = getKgNode(db, nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);

  let props = {};
  try { props = JSON.parse(node.properties || '{}'); } catch { /* use empty */ }

  const outgoing = getKgEdges(db, nodeId).slice(0, 10);
  const incoming = db.prepare(
    'SELECT * FROM kg_edges WHERE target_id = ? AND valid_to IS NULL'
  ).all(nodeId).slice(0, 10);

  const lines = [
    `Node: ${node.name}`,
    `Type: ${node.type}`,
    '',
    'Stats:',
    `  invocations: ${props.invocations ?? 'n/a'}`,
    `  sessions_used: ${props.sessions_used ?? 'n/a'}`,
    `  success_rate: ${props.success_rate ?? 'n/a'}`,
    `  confidence: ${props.confidence ?? 'n/a'}`,
    `  category: ${props.category ?? 'n/a'}`,
    '',
  ];

  if (outgoing.length > 0) {
    lines.push('Outgoing relationships (triggers):');
    for (const e of outgoing) {
      lines.push(`  ${e.relationship} → ${e.target_id} (weight: ${e.weight})`);
    }
    lines.push('');
  }

  if (incoming.length > 0) {
    lines.push('Incoming relationships (triggered by):');
    for (const e of incoming) {
      lines.push(`  ${e.source_id} → ${e.relationship} (weight: ${e.weight})`);
    }
    lines.push('');
  }

  lines.push('Write a concise summary (1-2 sentences). Focus on what it does and how it relates to the workflow.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// applyEnrichment
// ---------------------------------------------------------------------------

function applyEnrichment(db, nodeId, summary) {
  const node = getKgNode(db, nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);

  let props = {};
  try { props = JSON.parse(node.properties || '{}'); } catch { /* use empty */ }

  const updated = {
    ...props,
    summary,
    enriched_at: new Date().toISOString(),
  };

  upsertKgNode(db, {
    id: node.id,
    type: node.type,
    name: node.name,
    properties: JSON.stringify(updated),
  });
}

// ---------------------------------------------------------------------------
// getUnenrichedNodes
// ---------------------------------------------------------------------------

function getUnenrichedNodes(db) {
  const rows = db.prepare(
    "SELECT * FROM kg_nodes WHERE type IN ('tool', 'component', 'pattern', 'instinct')"
  ).all();

  return rows.filter(row => {
    let props = {};
    try { props = JSON.parse(row.properties || '{}'); } catch { /* treat as empty */ }
    return !props.summary;
  });
}

// ---------------------------------------------------------------------------
// callHaiku (private)
// ---------------------------------------------------------------------------

function callHaiku(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
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
// enrichNodes
// ---------------------------------------------------------------------------

async function enrichNodes(db, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { enriched: 0, errors: 0, message: 'ANTHROPIC_API_KEY not set' };
  }

  const maxNodes = opts.maxNodes ?? 50;
  const nodes = getUnenrichedNodes(db).slice(0, maxNodes);

  let enriched = 0;
  let errors = 0;

  for (const node of nodes) {
    try {
      const prompt = buildEnrichmentPrompt(db, node.id);
      const summary = await callHaiku(apiKey, prompt);
      if (summary) {
        applyEnrichment(db, node.id, summary);
        enriched++;
      }
    } catch {
      errors++;
    }
  }

  setKgSyncState(db, 'last_enrich_at', new Date().toISOString());

  return { enriched, errors };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildEnrichmentPrompt,
  applyEnrichment,
  getUnenrichedNodes,
  enrichNodes,
};
