'use strict';
const client = require('./client');
const { NoEligibleNode, NodeUnavailable } = require('./errors');

/**
 * Knows which nodes exist and who may use them. THE privacy choke point:
 * privacy === 'private' only ever matches nodes with `local === true`; unknown privacy values throw.
 */
class NodeRegistry {
  constructor(nodes, { now = Date.now, retryAfterMs = 30_000 } = {}) {
    this.now = now;
    this.retryAfterMs = retryAfterMs;
    this.nodes = nodes.map((n) => ({ ...n, healthy: true, failedAt: 0, lastError: '' }));
  }

  eligible(capability, privacy) {
    // Fail closed: anything but the two known values is a caller bug, never silently treated as "family".
    if (privacy !== 'family' && privacy !== 'private') throw new TypeError('unknown privacy value');
    return this.nodes
      .filter((n) => n.capabilities.includes(capability) && (privacy !== 'private' || n.local === true))
      .sort((a, b) => a.priority - b.priority);
  }

  hasEligible(capability, privacy) {
    return this.eligible(capability, privacy).length > 0;
  }

  /** Runs fn(node) on the best eligible node, failing over on node failures. */
  async withNode(capability, privacy, fn) {
    const list = this.eligible(capability, privacy);
    if (!list.length) {
      throw new NoEligibleNode(
        privacy === 'private'
          ? `no local node can do "${capability}" for private memories`
          : `no configured node offers "${capability}"`
      );
    }
    const t = this.now();
    const ready = list.filter((n) => n.healthy || t - n.failedAt >= this.retryAfterMs);
    const order = [...ready, ...list.filter((n) => !ready.includes(n))]; // cooling-down nodes only as a last resort
    let last;
    for (const n of order) {
      try {
        const out = await fn(n);
        n.healthy = true;
        n.lastError = '';
        return out;
      } catch (e) {
        // A non-node error (e.g. HTTP 400/401, or a failing source stream) deliberately aborts: retrying elsewhere cannot fix it.
        if (!e || e.nodeFailure !== true) throw e;
        n.healthy = false;
        n.failedAt = this.now(); // when it failed, not when the call started: a 45-minute call must not skip its cool-down
        n.lastError = e.message;
        last = e;
      }
    }
    throw new NodeUnavailable(`no AI node answered for "${capability}" (${last.message})`);
  }

  status({ includeUrls = false } = {}) {
    return this.nodes.map((n) => ({
      name: n.name, local: n.local, capabilities: n.capabilities, healthy: n.healthy, lastError: n.lastError,
      ...(includeUrls ? { url: n.url } : {}),
    }));
  }

  async checkAll() {
    await Promise.all(this.nodes.map(async (n) => {
      try {
        await client.health(n);
        n.healthy = true;
        n.lastError = '';
      } catch (e) {
        n.healthy = false;
        n.failedAt = this.now();
        n.lastError = e.message;
      }
    }));
  }
}

module.exports = { NodeRegistry };
