'use strict';

/**
 * mavlink-health — Flow-facing health assertion (DESIGN.md §3, §7 "A faulted
 * component must not heartbeat").
 *
 * Lets a flow assert an identity's health with an expiring lease:
 * `msg.payload = { health: 'ok', ttl_s }` clears any fault on the Connection
 * and promises 'ok' for `ttl_s` seconds — renew before it lapses, or the
 * identity faults on its own (companion failsafe: a flow that has gone quiet
 * reads as unhealthy, never as "still fine"). `{ health: 'fatal' }` faults
 * immediately and cancels any pending lease. A `health` value naming neither
 * selects no behavior (§5) — msg is trusted, so an unmatched vocabulary just
 * doesn't act, the same unmatched-tier contract every other action node in
 * this palette carries.
 *
 * Output 0 — continue: the original msg, on an accepted 'ok'/'fatal' assertion.
 * Output 1 — status: a record on every assertion this node makes, including
 * the lease expiring on its own.
 */

const {
  makeStatusRecord,
  shouldSuppress,
  applyActionStatus,
  failInput,
} = require('../lib/delivery');
const { applyConnectionStatus } = require('../lib/addressing');

module.exports = function registerMavlinkHealth(RED) {
  /**
   * @param {object} config  Node-RED node config from the editor
   */
  function MavlinkHealthNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const connectionNode = RED.nodes.getNode(config.connection);
    applyConnectionStatus(node, true, connectionNode);

    // Which identity's health this asserts. Blank config (the editor writes
    // blank for a single-identity Connection whose field is hidden) means the
    // Connection's Local Identity — the same absent-override rule
    // resolveIdentity uses for outbound sends. A non-blank saved pick rides as
    // given. assertHealth refuses an id this Connection does not heartbeat, so
    // a hand-edited unbound pick is loud rather than a silent healthy no-op.
    const identityId = config.identity !== undefined && config.identity !== null && config.identity !== ''
      ? config.identity
      : connectionNode.localIdentity;

    // The editor owns the default and the positive-number ring — just convert
    // it. msg.payload.ttl_s overrides by presence (§0 presence-fallback).
    const defaultTtlS = Number(config.ttlS);

    // Subscribed eagerly, like mavlink-in's message subscriptions, so a
    // lease expiring between inputs still reaches this node's own status and
    // output. The Connection reference is editor-required, so the runtime
    // trusts it (§0) the way mavlink-state's feed does — a disabled Connection
    // still answers with its stub, and a hand-edited dangling reference craters
    // here at construction rather than deferring the failure.
    const unsubscribeExpired = connectionNode.onHealthExpired(({ identityId: expiredId }) => {
      if (expiredId !== identityId) return;
      applyActionStatus(node, 'error', 'lease expired');
      node.send([null, makeStatusRecord(node.type, {
        result: 'lease-expired',
        identity: identityId,
      })]);
    });

    node.on('input', (msg, send, done) => {
      // §9 suppress: msg.payload === false → silent no-op.
      if (shouldSuppress(msg)) {
        done();
        return;
      }

      try {
        // No `?? {}`: the health verb lives only on the payload — there is no
        // configured fallback verb, so a missing payload is absence, not an
        // empty selection, and synthesizing `{}` would turn it into a silent
        // no-op. It craters into failInput instead; absence is never invented.
        const payload = msg.payload;
        // Affirmative dispatch (§5): a health value naming neither member
        // selects no behavior — nothing asserted, nothing sent, nothing
        // reported, the same unmatched-tier contract mavlink-param and
        // mavlink-command carry for their own closed-vocabulary msg fields.
        switch (payload.health) {
          case 'ok': {
            const ttlS = payload.ttl_s ?? defaultTtlS;
            connectionNode.assertHealth(identityId, true, Number(ttlS) * 1000);
            applyActionStatus(node, 'ok', `healthy (${ttlS}s lease)`);
            send([msg, makeStatusRecord(node.type, {
              result: 'healthy',
              identity: identityId,
              ttlS: Number(ttlS),
            })]);
            break;
          }
          case 'fatal': {
            connectionNode.assertHealth(identityId, false, 0);
            applyActionStatus(node, 'error', 'faulted');
            send([msg, makeStatusRecord(node.type, {
              result: 'faulted',
              identity: identityId,
            })]);
            break;
          }
          default: break; // This space intentionally left blank (§5)
        }
        done();
      } catch (err) {
        failInput(node, send, err, done);
      }
    });

    node.on('close', () => {
      unsubscribeExpired();
    });
  }

  RED.nodes.registerType('mavlink-health', MavlinkHealthNode);
};
