'use strict';

/**
 * Mission transfer lock (DESIGN.md §9 "Lock per connection, profile, and
 * type"). The vehicle drives a mission conversation, and two transfers of the
 * *same* type on the *same* target would interleave their `MISSION_REQUEST` /
 * `MISSION_ITEM` traffic into nonsense. So a transfer holds a lock keyed by
 * `(connection, target, mission_type)` for its whole duration.
 *
 * The key deliberately excludes the operation: a fence upload and a fence
 * download conflict (same type, same target), but a fence upload and a mission
 * download run concurrently (different type). "Two fence uploads not OK; fence
 * upload ∥ mission download OK."
 *
 * The registry is in-memory and per process. A shared default instance
 * ({@link locks}) is what the node uses; tests construct their own isolated
 * {@link MissionLockRegistry} so they never contend with each other.
 */

class MissionLockRegistry {
  constructor() {
    /** @type {Set<string>} held lock keys */
    this._held = new Set();
  }

  /**
   * Compose the lock key. `connectionId` scopes to the Connection config node;
   * target and mission type distinguish concurrent transfers on one link.
   *
   * @param {string} connectionId
   * @param {{sysid: number, compid: number}} target
   * @param {number} missionType
   * @returns {string}
   */
  key(connectionId, target, missionType) {
    return `${connectionId}::${target.sysid}.${target.compid}::${missionType}`;
  }

  /**
   * Acquire the lock. Returns a single-use release function on success, or
   * `null` when the lock is already held (the caller refuses the transfer and
   * reports why on output 1).
   *
   * @param {string} connectionId
   * @param {{sysid: number, compid: number}} target
   * @param {number} missionType
   * @returns {(() => void)|null}
   */
  acquire(connectionId, target, missionType) {
    const k = this.key(connectionId, target, missionType);
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
   * @param {number} missionType
   * @returns {boolean} whether the lock is currently held
   */
  isHeld(connectionId, target, missionType) {
    return this._held.has(this.key(connectionId, target, missionType));
  }

  /** @returns {number} number of currently held locks */
  size() {
    return this._held.size;
  }
}

/** Process-wide shared registry used by the mavlink-mission node. */
const locks = new MissionLockRegistry();

module.exports = { MissionLockRegistry, locks };
