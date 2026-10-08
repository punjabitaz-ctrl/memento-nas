'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Trim + length-check a string field. */
function str(v, max, { name = 'field', required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `${name} is required`);
    return '';
  }
  const s = String(v).trim();
  if (required && !s) throw new HttpError(400, `${name} is required`);
  if (s.length > max) throw new HttpError(400, `${name} is too long (max ${max} characters)`);
  return s;
}

function oneOf(v, allowed, name) {
  if (!allowed.includes(v)) throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}`);
  return v;
}

const MIN_YEAR = 1000;
const MAX_YEAR = 2100;

/**
 * Accepts "1962", "1962-06", "1962-06-15" (or empty/null). Returns
 * { date: 'YYYY-MM-DD', precision } or null. Elders often only know the year.
 */
function parseFuzzyDate(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!m) throw new HttpError(400, 'Date must look like 1962, 1962-06 or 1962-06-15');
  const y = +m[1];
  const mo = m[2] ? +m[2] : 1;
  const d = m[3] ? +m[3] : 1;
  if (y < MIN_YEAR || y > MAX_YEAR) throw new HttpError(400, `Year must be between ${MIN_YEAR} and ${MAX_YEAR}`);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    throw new HttpError(400, 'That date does not exist');
  }
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${y}-${pad(mo)}-${pad(d)}`, precision: m[3] ? 'day' : m[2] ? 'month' : 'year' };
}

function parseJsonField(v, name, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    throw new HttpError(400, `${name} must be valid JSON`);
  }
}

function cleanTags(arr) {
  if (!Array.isArray(arr)) return [];
  const out = new Set();
  for (const t of arr) {
    const s = String(t).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
    if (s) out.add(s);
    if (out.size >= 20) break;
  }
  return [...out];
}

function cleanPeople(arr) {
  if (!Array.isArray(arr)) return [];
  const out = new Map();
  for (const p of arr) {
    const name = String((p && p.name) || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!name) continue;
    if (!out.has(name.toLowerCase())) {
      out.set(name.toLowerCase(), { name, relationship: String((p && p.relationship) || '').trim().slice(0, 40) });
    }
    if (out.size >= 30) break;
  }
  return [...out.values()];
}

function slug(s, max = 40) {
  return (
    String(s || '')
      .normalize('NFKD')
      .replace(/[^\w\s.-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, max) || 'untitled'
  );
}

module.exports = { HttpError, wrap, str, oneOf, parseFuzzyDate, parseJsonField, cleanTags, cleanPeople, slug, MIN_YEAR, MAX_YEAR };
