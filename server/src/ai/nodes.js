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

  /**
   * Runs fn(node) on the best eligible node, failing over on node failures.
   * `privacy` is 'family' / 'private', or a function returning one of them. A function is called again right
   * before EVERY attempt (failover included), so work whose memory became private while an earlier node was
   * busy never moves on to a node that is no longer allowed. Any other value (or return value) is a TypeError.
   *
   * Errors: one with `nodeFailure === true` marks the node unhealthy and fails over. One with `tryNextNode === true`
   * (our own guard aborted the call, e.g. a transcription upload stopped because the memory became private) also
   * moves on to the next still-eligible node but does NOT blame the node. If no node is left it is rethrown as is.
   * Anything else aborts at once.
   */
  async withNode(capability, privacy, fn) {
    const current = typeof privacy === 'function' ? () => privacy() : () => privacy;
    const noneFor = (p) => new NoEligibleNode(
      p === 'private'
        ? `no local node can do "${capability}" for private memories`
        : `no configured node offers "${capability}"`
    );
    let p = current();
    const list = this.eligible(capability, p);
    if (!list.length) throw noneFor(p);
    const t = this.now();
    const ready = list.filter((n) => n.healthy || t - n.failedAt >= this.retryAfterMs);
    const order = [...ready, ...list.filter((n) => !ready.includes(n))]; // cooling-down nodes only as a last resort
    let last;
    let aborted;
    for (const n of order) {
      p = current();
      // Re-checked per attempt (throws TypeError on a bad value). Only nodes from the original list are tried.
      if (!this.eligible(capability, p).includes(n)) continue;
      try {
        const out = await fn(n);
        n.healthy = true;
        n.lastError = '';
        return out;
      } catch (e) {
        if (e && e.tryNextNode === true && e.nodeFailure !== true) {
          aborted = e; // our guard stopped this attempt; the node did nothing wrong, so its health is left alone
          continue;
        }
        // A non-node error (e.g. HTTP 400/401, or a failing source stream) deliberately aborts: retrying elsewhere cannot fix it.
        if (!e || e.nodeFailure !== true) throw e;
        n.healthy = false;
        n.failedAt = this.now(); // when it failed, not when the call started: a 45-minute call must not skip its cool-down
        n.lastError = e.message;
        last = e;
      }
    }
    if (aborted && !last) throw aborted; // every remaining node was ruled out after a guard abort
    // Privacy tightened mid-way and nothing that is still allowed exists: not retryable as "unavailable".
    if (!last || !this.eligible(capability, p).length) throw noneFor(p);
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
