'use strict';

/**
 * Single-owner lock registry, shared by the behaviors that must not run two
 * conversations against one target. Mission transfers (DESIGN.md §9 "Lock per
 * connection, profile, and type") key by `(connection, target, mission_type)`:
 * two transfers of the same type on the same target would interleave their
 * `MISSION_REQUEST` / `MISSION_ITEM` traffic into nonsense, while a fence
 * upload and a mission download run concurrently. Move setpoint streams (#176)
 * key by `(connection, target)` alone: two streams feeding one vehicle
 * alternate contradictory setpoints — the vehicle oscillates while both nodes
 * report success — and that holds regardless of what each setpoint commands,
 * so streams get no third component. Both fail closed: acquire returns a
 * release function or `null`, and the caller refuses loudly on `null`.
 *
 * The registry is in-memory and per process. Mission owns its instance
 * (`locks` in lib/mission); the setpoint-stream instance lives here as
 * `streamLocks` so every streaming producer contends on the same registry.
 * Tests construct their own isolated {@link LockRegistry} so they never
 * contend with each other.
 */

class LockRegistry {
  constructor() {
    /** @type {Set<string>} held lock keys */
    this._held = new Set();
  }

  /**
   * Compose the lock key. `connectionId` scopes to the Connection config node
   * and the target distinguishes vehicles on one link — the same sysid on two
   * different connections is two different vehicles. `scope` is an optional
   * extra component for behaviors whose conversations subdivide further
   * (mission passes the mission type; streams pass nothing).
   *
   * @param {string} connectionId
   * @param {{sysid: number, compid: number}} target
   * @param {number} [scope]
   * @returns {string}
   */
  key(connectionId, target, scope) {
    const base = `${connectionId}::${target.sysid}.${target.compid}`;
    return scope === undefined ? base : `${base}::${scope}`;
  }

  /**
   * Acquire the lock. Returns a single-use release function on success, or
   * `null` when the lock is already held (the caller refuses the operation
   * and reports why on output 1).
   *
   * @param {string} connectionId
   * @param {{sysid: number, compid: number}} target
   * @param {number} [scope]
   * @returns {(() => void)|null}
   */
  acquire(connectionId, target, scope) {
    const k = this.key(connectionId, target, scope);
    if (this._held.has(k)) return null;
    this._held.add(k);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._held.delete(k);
    };
  }

  /**
   * @param {string} connectionId
   * @param {{sysid: number, compid: number}} target
   * @param {number} [scope]
   * @returns {boolean} whether the lock is currently held
   */
  isHeld(connectionId, target, scope) {
    return this._held.has(this.key(connectionId, target, scope));
  }
}

/**
 * Process-wide single-owner scope for setpoint streams, keyed by
 * `(connection, target)` with no scope suffix (#176): two streams feeding one
 * vehicle alternate contradictory setpoints regardless of what each commands,
 * so streams are one-per-target, period. The same sysid on two different
 * connections is two different vehicles and does not conflict. Lives here —
 * not in lib/move — so every setpoint-streaming producer shares the one
 * instance.
 */
const streamLocks = new LockRegistry();

module.exports = { LockRegistry, streamLocks };
