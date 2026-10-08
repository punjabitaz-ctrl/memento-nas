'use strict';
const { assertPrivateUrl } = require('./netguard');

const CAPS = ['transcribe', 'embed', 'chat'];

function parseNodes(raw, problems) {
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    problems.push('AI_NODES must be valid JSON: an array of node objects.');
    return [];
  }
  if (!Array.isArray(arr)) {
    problems.push('AI_NODES must be a JSON array of node objects.');
    return [];
  }
  const out = [];
  const names = new Set();
  arr.forEach((n, i) => {
    const where = `AI_NODES[${i}]`;
    if (!n || typeof n !== 'object') return problems.push(`${where} must be an object.`);
    const name = String(n.name || '').trim();
    if (!/^[\w.-]{1,40}$/.test(name)) problems.push(`${where}.name must be 1-40 letters, digits, dot, dash or underscore.`);
    if (names.has(name)) problems.push(`${where}.name "${name}" is used twice.`);
    names.add(name);
    let url = '';
    try {
      url = assertPrivateUrl(n.url);
    } catch (e) {
      problems.push(`${where}.url: ${e.message}`);
    }
    const caps = Array.isArray(n.capabilities) ? n.capabilities : [];
    if (!caps.length || !caps.every((c) => CAPS.includes(c))) {
      problems.push(`${where}.capabilities must be a non-empty subset of: ${CAPS.join(', ')}.`);
    }
    const models = {};
    const rawModels = n.models && typeof n.models === 'object' ? n.models : {};
    for (const [k, v] of Object.entries(rawModels)) models[k] = typeof v === 'string' ? v.trim() : v;
    for (const c of caps) {
      if (typeof models[c] !== 'string' || !models[c].trim()) {
        problems.push(`${where}.models.${c} is required because the node declares "${c}".`);
      }
    }
    const priority = n.priority === undefined ? 100 : Number(n.priority);
    if (!Number.isFinite(priority)) problems.push(`${where}.priority must be a number.`);
    out.push({
      name, url, capabilities: caps, models, local: n.local === true, priority,
      token: typeof n.token === 'string' ? n.token : '',
    });
  });
  return out;
}

function intIn(env, key, def, min, max, problems) {
  const v = parseInt(env[key] || String(def), 10);
  if (!Number.isInteger(v) || v < min || v > max) {
    problems.push(`${key} must be a whole number between ${min} and ${max}.`);
    return def;
  }
  return v;
}

/** Reads AI_* settings. Pushes human-readable messages onto `problems`; never throws. */
function parseAi(env, problems) {
  const enabled = String(env.AI_ENABLED || 'false').toLowerCase() === 'true';
  const raw = (env.AI_NODES || '').trim();
  const before = problems.length;
  const nodes = raw ? parseNodes(raw, problems) : [];
  // Fire for unset AND for a list that parses to zero nodes, unless parseNodes already reported why.
  if (enabled && !nodes.length && problems.length === before) {
    problems.push('AI_ENABLED=true needs at least one node in AI_NODES.');
  }
  const embedModels = [...new Set(nodes.filter((n) => n.capabilities.includes('embed')).map((n) => n.models.embed))];
  if (embedModels.length > 1) {
    problems.push(`Every node that declares "embed" must use the same embedding model (vectors from different models cannot be compared). Found: ${embedModels.join(', ')}.`);
  }
  return {
    enabled,
    nodes,
    embedModel: embedModels[0] || '',
    chunkTokens: intIn(env, 'AI_MAX_CHUNK_TOKENS', 200, 50, 2000, problems),
    pollMs: intIn(env, 'AI_POLL_MS', 5000, 20, 60000, problems),
  };
}

module.exports = { parseAi, CAPS };
