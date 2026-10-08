'use strict';
const H = { 'x-requested-with': 'memento' };

/** Cookie-keeping API client (same behaviour as the one inlined in api.test.js). */
class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, url, { json, form, headers = {} } = {}) {
    const h = { ...H, ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let body;
    if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const res = await fetch(this.base + url, { method, headers: h, body });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return res;
  }
  async json(method, url, opts) {
    const res = await this.req(method, url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    return { status: res.status, data };
  }
}

function memoryForm(fields, files = []) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  for (const x of files) f.append('files', new Blob([x.data], { type: x.type }), x.name);
  return f;
}

module.exports = { Client, memoryForm };
