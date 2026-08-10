'use strict';

/**
 * Default ready: specialized PASS only.
 *
 * The suite's generic fallback (`reason: "results: accepted|…"`) fires on the
 * first good ack while multi-step chains (arm→GUIDED→takeoff) are still
 * running — that must not end the wait. Specialized verdicts return distinct
 * reasons and are safe to early-exit on.
 *
 * @param {{ status: string, reason?: string }} verdict
 * @returns {boolean}
 */
function isSpecializedPass(verdict) {
  if (!verdict || verdict.status !== 'PASS') return false;
  const reason = verdict.reason || '';
  return !/^results:\s*/i.test(reason);
}

/**
 * Poll until the example looks done, or waitMs elapses.
 *
 * Default ready signal: specialized `verdict.status === 'PASS'` only (see
 * `isSpecializedPass`). PARTIAL / FAIL / UNKNOWN / generic `results:` PASS
 * keep polling. Optional readyWhen overrides that rule.
 *
 * @param {object} opts
 * @param {() => { summary: object, log: string }} opts.snapshot
 * @param {(summary: object, log: string) => { status: string, reason?: string }} opts.verdict
 * @param {(summary: object, log: string) => boolean} [opts.readyWhen]
 * @param {number} opts.waitMs  hard ceiling (former fixed sleep)
 * @param {number} [opts.pollMs=500]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @returns {Promise<{ ready: boolean, waitedMs: number, verdict: { status: string, reason?: string }, summary: object, log: string }>}
 */
async function waitUntilReady(opts) {
  const waitMs = Number(opts.waitMs);
  const pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : 500;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now || Date.now;
  const started = now();
  const deadline = started + waitMs;

  /** @type {{ summary: object, log: string }} */
  let last;
  /** @type {{ status: string, reason?: string }} */
  let lastVerdict;

  while (now() < deadline) {
    last = opts.snapshot();
    lastVerdict = opts.verdict(last.summary, last.log);
    const ready = opts.readyWhen
      ? Boolean(opts.readyWhen(last.summary, last.log))
      : isSpecializedPass(lastVerdict);
    if (ready) {
      // Re-run verdict so readyWhen overrides still record the final classification.
      lastVerdict = opts.verdict(last.summary, last.log);
      return {
        ready: true,
        waitedMs: now() - started,
        verdict: lastVerdict,
        summary: last.summary,
        log: last.log,
      };
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  last = opts.snapshot();
  lastVerdict = opts.verdict(last.summary, last.log);
  return {
    ready: false,
    waitedMs: now() - started,
    verdict: lastVerdict,
    summary: last.summary,
    log: last.log,
  };
}

module.exports = { waitUntilReady, isSpecializedPass };
