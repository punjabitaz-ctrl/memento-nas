'use strict';
/**
 * Auto-organize: offline heuristics by default (no network), optional Claude.
 * Output is a SUGGESTION. Callers only fill fields the user left empty.
 */

const STOP = new Set(
  ('about above after again against almost also always among another because been before being between both ' +
    'cannot could didnt does doing dont down during each even every from further have having here hers herself ' +
    'himself into itself just know like made make many more most much must myself never only other ought ourselves ' +
    'over really said same should since some such than that their theirs them themselves then there these they ' +
    'thing things think this those through today under until very want wanted well were what when where which while ' +
    'whom will with would your yours yourself yourselves been just then also back came come went going gone were ' +
    'told tell used still take took little really people remember remembered').split(/\s+/)
);

const THEMES = {
  wedding: /\b(wedding|married|bride|groom|honeymoon|engaged|engagement)\b/i,
  recipe: /\b(recipe|baking|baked|cooking|cooked|kitchen|dinner|pie|bread)\b/i,
  holiday: /\b(christmas|thanksgiving|easter|hanukkah|diwali|eid|new year|passover|holiday)\b/i,
  school: /\b(school|teacher|classroom|college|university|graduat\w+)\b/i,
  military: /\b(army|navy|marines|air force|draft|veteran|deployed|enlisted|war)\b/i,
  career: /\b(job|career|worked|factory|office|company|boss|retired|retirement)\b/i,
  childhood: /\b(childhood|growing up|as a kid|as a child|toy|playground)\b/i,
  birthday: /\b(birthday|birth|born)\b/i,
  travel: /\b(trip|vacation|traveled|travelled|journey|voyage|flight|road trip)\b/i,
  faith: /\b(church|temple|mosque|synagogue|prayer|faith|baptism|blessing)\b/i,
  home: /\b(house|apartment|farm|neighborhood|hometown|moved)\b/i,
  music: /\b(song|sing|sang|music|piano|guitar|band|dance|danced)\b/i,
};

const REL = 'Grandma|Grandpa|Grandmother|Grandfather|Granny|Nana|Papa|Uncle|Aunt|Auntie|Mom|Dad|Mother|Father|Cousin|Brother|Sister|Mr\\.|Mrs\\.|Ms\\.|Dr\\.';
const REL_RE = new RegExp(`\\b(${REL})\\s+([A-Z][a-z]{1,20})\\b`, 'g');
const NOT_NAMES = new Set(['The', 'And', 'But', 'When', 'Then', 'Well', 'She', 'He', 'They', 'We', 'It', 'I', 'My', 'Our']);
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function sentences(text) {
  return (text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || []).map((s) => s.trim()).filter(Boolean);
}

function summarize(text, max = 240) {
  const ss = sentences(text);
  let out = '';
  for (const s of ss) {
    if ((out + ' ' + s).trim().length > max) break;
    out = (out + ' ' + s).trim();
    if (out.length > max * 0.6) break;
  }
  if (!out && ss[0]) out = ss[0].slice(0, max - 1) + '…';
  return out;
}

function suggestTags(text, limit = 6) {
  const tags = [];
  for (const [name, re] of Object.entries(THEMES)) if (re.test(text)) tags.push(name);
  const freq = new Map();
  for (const w of text.toLowerCase().match(/[a-z]{5,}/g) || []) {
    if (STOP.has(w) || THEMES[w]) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const common = [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([w]) => w);
  for (const w of common) if (tags.length < limit && !tags.includes(w)) tags.push(w);
  return tags.slice(0, limit);
}

function suggestPeople(text) {
  const found = new Map();
  let m;
  REL_RE.lastIndex = 0;
  while ((m = REL_RE.exec(text))) {
    const name = m[2];
    if (NOT_NAMES.has(name)) continue;
    const full = `${m[1]} ${name}`;
    const rel = /^(Mr|Mrs|Ms|Dr)\./.test(m[1]) ? '' : m[1].toLowerCase();
    if (!found.has(full.toLowerCase())) found.set(full.toLowerCase(), { name: full, relationship: rel });
  }
  return [...found.values()].slice(0, 8);
}

/** Returns {memoryDate, precision} or null. Looks for "June 1962", "1962-06-15", then bare years. */
function suggestDate(text) {
  let m = text.match(/\b(1[0-9]{3}|20[0-9]{2})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])\b/);
  if (m) return { memoryDate: m[0], precision: 'day' };
  const mre = new RegExp(`\\b(${MONTHS.join('|')})\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?(1[5-9]\\d{2}|20\\d{2})\\b`, 'i');
  m = text.match(mre);
  if (m) {
    const mm = String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0');
    return { memoryDate: `${m[2]}-${mm}-01`, precision: 'month' };
  }
  const years = (text.match(/\b(1[89]\d{2}|20[0-4]\d)\b/g) || []).map(Number);
  if (years.length) {
    // earliest mentioned year is usually when the remembered event happened
    return { memoryDate: `${Math.min(...years)}-01-01`, precision: 'year' };
  }
  return null;
}

function suggestLocation(text) {
  const m = text.match(/\b(?:in|at|from|near)\s+((?:[A-Z][a-zA-Z.'-]+)(?:\s+[A-Z][a-zA-Z.'-]+){0,3}(?:,\s*[A-Z][a-zA-Z]+)?)/);
  if (!m) return '';
  const loc = m[1];
  if (NOT_NAMES.has(loc) || MONTHS.includes(loc.toLowerCase())) return '';
  return loc;
}

function organize(input) {
  const text = [input.title, input.description, input.content, input.transcript].filter(Boolean).join('\n');
  if (!text.trim()) return { summary: '', tags: [], people: [], date: null, location: '' };
  const body = [input.description, input.content, input.transcript].filter(Boolean).join(' ') || text;
  return {
    summary: summarize(body),
    tags: suggestTags(text),
    people: suggestPeople(text),
    date: suggestDate(text),
    location: suggestLocation(text),
  };
}

// ---------------------------------------------------------------------------
// Optional Claude enrichment. Sends ONLY the single item passed in.
// ---------------------------------------------------------------------------
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

async function organizeWithClaude(config, input, image) {
  const content = [];
  if (image && IMAGE_MIMES.has(image.mime) && image.buffer.length <= 3.5 * 1024 * 1024) {
    content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.buffer.toString('base64') } });
  }
  content.push({
    type: 'text',
    text:
      'You help a family archive their memories. From the item below, reply with ONLY a JSON object: ' +
      '{"summary": string (max 240 chars, warm and factual), "tags": string[] (max 6, lowercase), ' +
      '"people": [{"name": string, "relationship": string}], "location": string, "year": number|null}. ' +
      'Do not invent facts that are not present.\n\n' +
      `Title: ${input.title || ''}\nDescription: ${input.description || ''}\nNotes: ${(input.content || input.transcript || '').slice(0, 6000)}\nFilename: ${input.filename || ''}`,
  });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.aiModel, max_tokens: 500, messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = await res.json();
    const raw = (data.content || []).map((c) => c.text || '').join('');
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return {
      summary: String(json.summary || '').slice(0, 400),
      tags: (Array.isArray(json.tags) ? json.tags : []).map((x) => String(x).toLowerCase().slice(0, 40)).slice(0, 6),
      people: (Array.isArray(json.people) ? json.people : [])
        .map((p) => ({ name: String(p.name || '').slice(0, 80), relationship: String(p.relationship || '').slice(0, 40) }))
        .filter((p) => p.name)
        .slice(0, 10),
      location: String(json.location || '').slice(0, 120),
      date: Number.isInteger(json.year) && json.year > 1000 && json.year < 2100 ? { memoryDate: `${json.year}-01-01`, precision: 'year' } : null,
    };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { organize, organizeWithClaude, summarize, suggestDate };
