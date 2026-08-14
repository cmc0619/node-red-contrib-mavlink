'use strict';

/**
 * Outbound queue bands (DESIGN.md §7 "Queue bands").
 *
 * Priority here is not importance — it is what happens if the message is late.
 * Marks descend monotonically with the band so a device that only compares the
 * DSCP field still orders correctly. CS6 (48) and CS7 (56) are deliberately
 * unused: those are reserved for network control, and marking application
 * traffic into them either gets it remarked or competes with the routing
 * protocols keeping the link up.
 *
 * Nothing in the band scheme may depend on the DSCP mark being honoured —
 * across the public internet marks are routinely remarked or cleared, so treat
 * DSCP as an optimisation on links you control (§7 "Where it pays").
 */

/** @enum {number} */
const BAND = {
  EMERGENCY: 0,
  LIVENESS: 1,
  CONTROL: 2,
  STREAMING: 3,
  BULK: 4,
};

/** Human-readable band names, indexed by band number. */
const BAND_NAME = ['emergency', 'liveness', 'control', 'streaming', 'bulk'];

/**
 * DSCP mark per band. IP transports only — Node exposes no traffic-class setter,
 * so marking needs an optional native `setsockopt` binding on the `serialport`
 * pattern; absent, the queue behaves identically and frames go out unmarked
 * (DESIGN.md §7 "Scheduling is the driver's").
 *
 * @type {Object<number, number>}
 */
const DSCP = {
  [BAND.EMERGENCY]: 46, // EF
  [BAND.LIVENESS]: 40, // CS5
  [BAND.CONTROL]: 34, // AF41
  [BAND.STREAMING]: 32, // CS4
  [BAND.BULK]: 10, // AF11
};

/**
 * Ageing promotes a waiting item toward higher priority (lower band number) but
 * clamps at Control. The ceiling sits one band above Liveness, not at it: a
 * clamped item still wins on an age tie-break, so it must never reach Liveness
 * or Emergency (§7 "Ageing promotes, but clamps at band 2").
 */
const AGE_CLAMP_BAND = BAND.CONTROL;

/**
 * Default per-band queue depth. Every queue is bounded; overflow behaviour
 * differs by band (§7 "Every queue is bounded"). Liveness is bounded to one
 * outstanding item per identity structurally, so it carries no numeric cap.
 *
 * @type {Object<number, number>}
 */
const DEFAULT_CAPACITY = {
  [BAND.EMERGENCY]: 64,
  [BAND.CONTROL]: 256,
  [BAND.STREAMING]: 128,
  [BAND.BULK]: 1024,
};

/**
 * Default age-promotion period: every `AGE_STEP_MS` a waiting item's effective
 * band rises by one until it reaches the Control clamp. MAVLink does not define
 * this rate; the value keeps a long bulk transfer from starving behind steady
 * control traffic without letting it jump the ordering of genuine control.
 */
const AGE_STEP_MS = 250;

/**
 * @param {number} band
 * @returns {boolean} True for a recognised band number.
 */
function isBand(band) {
  return Number.isInteger(band) && band >= BAND.EMERGENCY && band <= BAND.BULK;
}

/** `${number} (${name})` per band, for naming the vocabulary in a refusal. */
const BAND_LIST = BAND_NAME.map((name, i) => `${i} (${name})`).join(', ');

/**
 * Resolve the queue band for one send (owner ruling, 2026-08-14, extending
 * the no-defaults ruling to this site). `msg.band` absent is a presence
 * fallback to the config default — not a default the driver invents, the
 * config value the operator already chose — and stays exactly as it was.
 *
 * A *present* `msg.band` that is blank or not a BAND member must throw rather
 * than coerce: `Number('')` is `0`, `BAND.EMERGENCY`, so an unset band used to
 * silently outrank every other message on the link — the specific bug this
 * closes. `isBand` owns membership; a numeric string that names a real band
 * (`'2'`) keeps working, same as today.
 *
 * Lives beside the vocabulary it names (§14 selection-typo cluster: "one
 * vocabulary, not a copy") — extracted from `mavlink-out` when
 * `mavlink-build`'s Send tier, the band twin §14 flagged for the next pass,
 * needed the identical read.
 *
 * @param {*} msgBand  msg.band, as received
 * @param {number} defaultBand  the node's editor-configured default
 * @returns {number}
 */
function resolveBand(msgBand, defaultBand) {
  // null falls back like undefined (Codacy, #305): msg.band is an optional
  // per-message override, and null is JSON's only spelling of "not set" — a
  // Function node writing msg.band = null means the config band, not a band
  // named nothing. This is the opposite call from the wire guard, on purpose:
  // a wire integer field is required content with no default to fall to, so
  // null there refuses; an override has the config to fall to, so null here
  // is absence.
  if (msgBand === undefined || msgBand === null) return defaultBand;
  if (typeof msgBand === 'string' && msgBand.trim() === '') {
    throw new Error(`msg.band is blank — expected one of ${BAND_LIST}`);
  }
  // Only a number or a numeric string may reach Number(): booleans coerce
  // (Number(true) is 1, a member) and would ride as a band nobody named —
  // the same typeof class the wire guard's §14 entry closed (Codacy, #310).
  const band = (typeof msgBand === 'number' || typeof msgBand === 'string')
    ? Number(msgBand)
    : NaN;
  if (isBand(band)) return band;
  throw new Error(`unknown msg.band ${JSON.stringify(msgBand)} — expected one of ${BAND_LIST}`);
}

module.exports = {
  BAND,
  BAND_NAME,
  BAND_LIST,
  DSCP,
  AGE_CLAMP_BAND,
  DEFAULT_CAPACITY,
  AGE_STEP_MS,
  isBand,
  resolveBand,
};
