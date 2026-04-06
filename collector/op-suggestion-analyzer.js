#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_CONFIDENCE_STORE = 0.5;

function getRepoDir() {
  const pathFile = path.join(process.env.HOME || require('os').homedir(), '.open-pulse-path');
  try {
    return fs.readFileSync(pathFile, 'utf8').trim();
  } catch {
    return null;
  }
}

function readExistingSuggestions(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isDuplicate(newSugg, existing) {
  return existing.some(e =>
    e.type === newSugg.type &&
    e.description === newSugg.description &&
    e.status === 'pending'
  );
}

function analyzeForSuggestions(content, timestamp, sessionId) {
  const patterns = [
    { regex: /always\s+(run|execute|do)\s+(.+?)\s+(after|before|when)/i, type: 'hook', confidence: 0.75 },
    { regex: /repeatedly\s+(search|look\s+up|check)\s+(.+)/i, type: 'skill', confidence: 0.70 },
    { regex: /delegate\s+(.+?)\s+to\s+(a\s+)?specialist/i, type: 'agent', confidence: 0.70 },
    { regex: /(?:must|should|always)\s+follow\s+(.+)/i, type: 'rule', confidence: 0.70 },
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern.regex);
    if (match && pattern.confidence >= MIN_CONFIDENCE_STORE) {
      return {
        id: crypto.randomUUID(),
        created_at: timestamp,
        type: pattern.type,
        confidence: pattern.confidence,
        description: `Pattern detected: "${match[0]}"`,
        evidence: JSON.stringify([`session:${sessionId}`]),
        status: 'pending',
      };
    }
  }
  return null;
}

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');

  await new Promise((resolve) => {
    process.stdin.on('data', chunk => raw += chunk);
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
  });

  try {
    const repoDir = getRepoDir();
    if (!repoDir) { process.exit(0); }

    const suggestionsFile = path.join(repoDir, 'data', 'suggestions.jsonl');
    const existing = readExistingSuggestions(suggestionsFile);
    const timestamp = new Date().toISOString();
    const sessionId = process.env.CLAUDE_SESSION_ID || 'unknown';
    const suggestions = [];

    // Scan CL instincts for patterns
    const clDir = path.join(repoDir, 'cl');
    const projectsDir = path.join(clDir, 'projects');

    const scanDir = (dir) => {
      try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(dir, file), 'utf8');
            const suggestion = analyzeForSuggestions(content, timestamp, sessionId);
            if (suggestion && !isDuplicate(suggestion, [...existing, ...suggestions])) {
              suggestions.push(suggestion);
            }
          } catch { /* skip */ }
        }
      } catch { /* dir not found */ }
    };

    // Scan global instincts
    scanDir(path.join(clDir, 'instincts', 'personal'));
    scanDir(path.join(clDir, 'instincts', 'inherited'));

    // Scan per-project instincts
    try {
      for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        scanDir(path.join(projectsDir, entry.name, 'instincts', 'personal'));
        scanDir(path.join(projectsDir, entry.name, 'instincts', 'inherited'));
      }
    } catch { /* projects dir not found */ }

    // Also scan auto-memory for patterns
    const memoryBaseDir = path.join(process.env.HOME || require('os').homedir(), '.claude', 'projects');
    try {
      for (const entry of fs.readdirSync(memoryBaseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const memDir = path.join(memoryBaseDir, entry.name, 'memory');
        scanDir(memDir);
      }
    } catch { /* ignore */ }

    // Write new suggestions
    if (suggestions.length > 0) {
      const dataDir = path.join(repoDir, 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const lines = suggestions.map(s => JSON.stringify(s)).join('\n') + '\n';
      fs.appendFileSync(suggestionsFile, lines);
    }

    process.exit(0);
  } catch (err) {
    process.stderr.write(`op-suggestion-analyzer: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { analyzeForSuggestions, isDuplicate };

if (require.main === module) { main(); }
