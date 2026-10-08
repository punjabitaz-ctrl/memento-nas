'use strict';

/** No configured node may do this work (wrong capability, or private memory but no local node). Not retryable. */
class NoEligibleNode extends Error {
  constructor(message) { super(message); this.name = 'NoEligibleNode'; }
}

/** Eligible nodes exist but none answered. Retry later without counting it as a failed attempt. */
class NodeUnavailable extends Error {
  constructor(message) { super(message); this.name = 'NodeUnavailable'; }
}

module.exports = { NoEligibleNode, NodeUnavailable };
