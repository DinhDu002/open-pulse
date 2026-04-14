'use strict';

const fs = require('fs');
const path = require('path');
const { extractBody } = require('./frontmatter');

const SKILLS_DIR = path.join(__dirname, '..', '..', 'claude', 'skills');

function loadSkillBody(skillName) {
  const skillPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
  try {
    const raw = fs.readFileSync(skillPath, 'utf8');
    const body = extractBody(raw);
    return body || null;
  } catch {
    return null;
  }
}

function loadCompactPrompt(skillName) {
  const body = loadSkillBody(skillName);
  if (!body) return null;

  const extractSection = (heading) => {
    const lines = body.split('\n');
    let inSection = false;
    const result = [];
    for (const line of lines) {
      if (line === `## ${heading}`) { inSection = true; continue; }
      if (inSection && line.startsWith('## ')) break;
      if (inSection) result.push(line);
    }
    return result.length ? result.join('\n').trim() : null;
  };

  const schema = extractSection('JSON Schema');
  const compact = extractSection('Compact Instructions');

  if (!schema || !compact) return null;

  return `## JSON Schema\n\n${schema}\n\n## Instructions\n\n${compact}`;
}

module.exports = { loadSkillBody, loadCompactPrompt };
