'use strict';
const net = require('node:net');

const PRIVATE_SUFFIXES = ['.ts.net', '.local', '.lan', '.internal', '.home.arpa'];

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function ipv6Private(ip) {
  const s = ip.toLowerCase();
  if (s === '::1') return true;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s); // URL parser rewrites ::ffff:1.2.3.4 into hex form
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) return ipv4Private(dotted[1]);
  return /^f[cd][0-9a-f]{2}:/.test(s); // fc00::/7 (Tailscale's fd7a:115c:a1e0::/48 is inside it)
}

/**
 * True for hosts that cannot be on the public internet. Hostnames are judged by name only
 * (no DNS lookup), so only list names you control.
 */
function isPrivateHost(hostname) {
  const h = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return false;
  if (net.isIPv4(h)) return ipv4Private(h);
  if (net.isIPv6(h)) return ipv6Private(h);
  if (h === 'localhost') return true;
  if (PRIVATE_SUFFIXES.some((s) => h.endsWith(s))) return true;
  return !h.includes('.'); // single-label LAN / Docker service names such as "ollama"
}

function assertPrivateUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error('is not a valid URL (check the AI_NODES url field)');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('URL must start with http:// or https://');
  if (!isPrivateHost(u.hostname)) {
    throw new Error(
      `${u.hostname} is not on a private network. AI nodes must be loopback, a LAN address, a Tailscale address (100.64.0.0/10 or *.ts.net) or a *.local/*.lan/*.internal name`
    );
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

module.exports = { isPrivateHost, assertPrivateUrl };
