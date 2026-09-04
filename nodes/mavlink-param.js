'use strict';

/**
 * mavlink-param — read one, set one, or request the list (DESIGN.md §3, §9).
 *
 * Param confirmation is echo-based, not COMMAND_ACK: a set is confirmed by the
 * PARAM_VALUE the vehicle broadcasts back, and a list by collecting every
 * PARAM_VALUE up to the advertised count (§9 "Three kinds of confirmation").
 *
 * Chain model (§9):
 *   output 0 — continue: fires only on success (built message / echo / list)
 *   output 1 — status:   a status record on every terminal outcome
 *
 * Single-flight: at most one PARAM_VALUE transaction runs per node. A second
 * input supersedes any in-flight one — the prior subscription and timers are
 * torn down and a generation token guards against a late echo settling the node
 * after it was cancelled. Every waiting transaction carries a timeout so a lost
 * echo or dropped list message cannot leave the flow open forever.
 *
 * A confirm-tier set waits for its PARAM_VALUE echo, a confirm-tier read waits
 * for its reply, and a collect waits for the complete list.
 */

const {
  buildParamMessage,
  createParamListCollector,
  matchesParamEcho,
  matchesParamReadReply,
} = require('../lib/param');
const {
  readParamDefs,
  updateParamDefs,
} = require('../lib/param/defs');
const {
  defsFor: seedDefsFor,
  seedStamp,
  seedError,
  catalogLabel,
} = require('../lib/param/seed');
const { BAND } = require('../lib/connection/bands');
const {
  makeStatusRecord,
  shouldSuppress,
  applyActionStatus,
  failInput,
} = require('../lib/delivery');
const {
  resolveDeliveryContext,
} = require('../lib/addressing');

/**
 * A confirm-tier PARAM_SET gets its initial send plus two retries. MAVLink
 * common.xml message 23 says a sender that times out waiting for PARAM_VALUE
 * should re-send PARAM_SET: https://github.com/mavlink/mavlink/blob/master/message_definitions/v1.0/common.xml#L5615-L5624
 */
const PARAM_SET_ATTEMPTS = 3;

/** Admin route for the parameter definition catalog. */
const PARAM_DEFS_ROUTE = '/mavlink/param/defs';
const PARAM_DEFS_UPDATE_ROUTE = '/mavlink/param/defs/update';

/** Guard against double-registering the admin route (one per process). */
let _paramDefsRouteRegistered = false;

module.exports = function registerMavlinkParam(RED) {
  if (!_paramDefsRouteRegistered && RED.httpAdmin && RED.auth) {
    RED.httpAdmin.get(
      PARAM_DEFS_ROUTE,
      RED.auth.needsPermission('mavlink.read'),
      async (req, res) => {
        const profileId = req.query.vehicle;

        // Firmware and vehicle family come from the query when the editor sent
        // them, and from the deployed profile otherwise.
        //
        // The query wins deliberately. `getNode` resolves only *deployed*
        // config nodes, so a Vehicle Profile the operator just created — or
        // edited and not yet deployed — is invisible here while being perfectly
        // visible in the editor that sent the request. Preferring the query
        // also means an edited-but-undeployed firmware is honoured rather than
        // answered from the stale deployed value.
        let firmware = req.query.firmware;
        let vehicleFamily = req.query.vehicleFamily;
        if (profileId && (!firmware || !vehicleFamily)) {
          const profile = RED.nodes.getNode(profileId);
          if (profile) {
            firmware = firmware || profile.firmware || '';
            vehicleFamily = vehicleFamily || profile.vehicleFamily || '';
          }
        }

        const seeded = seedDefsFor({ firmware, vehicleFamily });

        /**
         * The seed is the baseline; a profile's downloaded definitions override
         * it id by id, because that download came from the firmware actually
         * being flown while the seed is a snapshot of whenever it was built.
         */
        function merged(downloaded) {
          const out = new Map(seeded);
          for (const [id, def] of downloaded) out.set(id, def);
          return out;
        }

        function answer(map, source) {
          if (map.size > 0) {
            return res.json({
              defs: Object.fromEntries(map),
              source,
              stamp: seedStamp(),
              // Named here rather than in the dialog, because this is where
              // the firmware was actually resolved: the query may have omitted
              // it and been answered from the deployed profile, so only this
              // side knows which document the operator is really looking at.
              catalog: catalogLabel({ firmware, vehicleFamily, count: map.size, source }),
            });
          }
          return res.json({
            defs: {},
            notice: seedError()
              || (firmware
                ? `No parameter definitions for firmware "${firmware}".`
                : 'Pick a firmware, or a Vehicle Profile, to load parameter definitions.'),
          });
        }

        if (!profileId) return answer(seeded, 'seed');

        try {
          const downloaded = await readParamDefs(RED.settings.userDir, profileId);
          return answer(
            downloaded.size ? merged(downloaded) : seeded,
            downloaded.size ? 'profile' : 'seed'
          );
        } catch (err) {
          // A corrupt holding file is the operator's own download and must be
          // reported — but it should not also cost them the shipped baseline.
          if (seeded.size > 0) {
            return res.json({
              defs: Object.fromEntries(seeded),
              source: 'seed',
              stamp: seedStamp(),
              catalog: catalogLabel({
                firmware, vehicleFamily, count: seeded.size, source: 'seed',
              }),
              notice: `Downloaded definitions are unreadable, showing the shipped seed: ${err.message}`,
            });
          }
          return res.status(500).json({
            defs: {},
            error: `Local parameter definitions are invalid: ${err.message}`,
          });
        }
      }
    );

    RED.httpAdmin.post(
      PARAM_DEFS_UPDATE_ROUTE,
      RED.auth.needsPermission('mavlink.write'),
      async (req, res) => {
        const body = req.body;
        const profileId = body.vehicle;
        const url = body.url;
        if (!profileId) {
          return res.status(400).json({ ok: false, error: 'Vehicle Profile ID is required' });
        }
        if (!url) {
          return res.status(400).json({ ok: false, error: 'Parameter definitions URL is required' });
        }
        try {
          const result = await updateParamDefs(RED.settings.userDir, profileId, url);
          return res.json({ ok: true, count: result.count });
        } catch (err) {
          return res.status(500).json({ ok: false, error: err.message });
        }
      }
    );
    _paramDefsRouteRegistered = true;
  }

  function MavlinkParamNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const delivery = config.delivery;
    const connAtDeploy = RED.nodes.getNode(config.connection);

    /**
     * In-flight transaction, or null. `gen` is the single-flight token: a
     * callback or timeout only settles the node when its captured generation
     * still matches, so a superseded operation's late echo is ignored. `timer`
     * is the deadline.
     * @type {{unsubscribe: ()=>void, timer: any, done: Function,
     *         gen: number}|null}
     */
    let pending = null;
    let generation = 0;

    /**
     * Tear down the in-flight transaction. When `releaseDone` is true the
     * abandoned op's `done` callback is invoked so Node-RED does not consider
     * its message perpetually unfinished.
     *
     * @param {boolean} releaseDone
     */
    function clearPending(releaseDone) {
      if (!pending) return;
      const { unsubscribe, timer, done } = pending;
      pending = null;
      unsubscribe();
      clearTimeout(timer);
      if (releaseDone) done();
    }

    node.on('input', (msg, send, done) => {
      try {
        if (shouldSuppress(msg)) {
          done();
          return;
        }

        // The editor owns the default and the number ring.
        const timeoutMs = Number(config.timeout);
        const payload = msg.payload;

        // Concrete Build dialects carry firmware from the editor (no target rung).
        const {
          connectionNode: connNode,
          profile,
          target,
          identityId,
        } = resolveDeliveryContext(RED, {
          delivery,
          config,
          payload,
          connectionNode: connAtDeploy,
          buildFirmwareProfile: true,
        });

        // Affirmative dispatch on the tier (§5): a token the editor's delivery
        // ring cannot save (mavlink-param.html) matches no case, so nothing
        // reaches the wire and the input completes as a no-op. Each arm builds
        // its own request: Build has no peer table to ask, so the firmware
        // rung decides its encoding; the wire tiers read AUTOPILOT_VERSION.
        switch (delivery) {
          case 'build':
            completeBuild(node, send, buildParamMessage(
              requestFrom(config, payload, { target, profile, capabilities: null })
            ));
            break;
          case 'send':
          case 'confirm':
          case 'collect':
            wireTier();
            return;
          default: break; // This space intentionally left blank (§5)
        }
        // Build has emitted by here; an unmatched tier has done nothing at all
        // — no send, no output, no status record. Either way the input is
        // completed, because a message left hanging is worse than one that did
        // nothing (mavlink-mission precedent).
        done();
        return;

        /** Send the message and, on a waiting tier, arm its transaction. */
        function wireTier() {
          const request = requestFrom(config, payload, {
            target,
            profile,
            capabilities: capabilitiesFromPeer(connNode, target),
          });
          const message = buildParamMessage(request);
          // Queue band per action (§5, §7): the full-table stream rides Bulk,
          // the single-param conversations ride Control. A stray action
          // selects no band here — and built no message either
          // (buildParamMessage's own §5 default), so the send throws at the
          // Connection's serialize choke before anything is queued.
          let band;
          switch (request.action) {
            case 'request-list':
              band = BAND.BULK;
              break;
            case 'read':
            case 'set':
              band = BAND.CONTROL;
              break;
            default: break; // This space intentionally left blank (§5)
          }
          connNode.send(message, {
            band,
            target: request.target,
            identityId,
          });

          // Scope the PARAM_VALUE subscription to the addressed vehicle so a
          // reply from another system on a shared connection cannot confirm this
          // operation or interleave into a list from a different vehicle.
          // trustedOnly: an explicitly untrusted PARAM_VALUE must never confirm
          // a set or feed a collect (§7 trust ruling #264); plain unsigned
          // links carry no mark and pass.
          const echoFilter = { message: 'PARAM_VALUE', sysid: request.target.sysid, trustedOnly: true };
          if (request.target.compid) echoFilter.compid = request.target.compid;

          // The wait this delivery×action combination arms (§5, §9): a confirm
          // set waits for its echo, a confirm read for its reply, a collect
          // for the full list. The subscribe callback and deadline dispatch on it.
          let mode = '';
          switch (delivery) {
            case 'confirm':
              switch (request.action) {
                case 'set': mode = 'confirm-set'; break;
                case 'read': mode = 'confirm-read'; break;
                default: break; // This space intentionally left blank (§5)
              }
              break;
            case 'collect':
              switch (request.action) {
                case 'request-list': mode = 'collect-list'; break;
                default: break; // This space intentionally left blank (§5)
              }
              break;
            default: break; // This space intentionally left blank (§5)
          }

          // No case armed a wait: the send above was the whole job, so the
          // input completes as sent — fire-and-forget is the general path
          // here, the three waits above are the special cases. The composed
          // token's vocabulary is closed by construction, so its no-wait
          // member dispatches affirmatively like the rest (§5).
          switch (mode) {
            case '':
              completeResult(node, send, 'succeeded', 'sent', message);
              done();
              return;
            default: break; // This space intentionally left blank (§5)
          }

          // Supersede any prior in-flight transaction, releasing its done().
          clearPending(true);
          const myGen = ++generation;

          /** Settle the current transaction if it has not been superseded. */
          function settle(fn) {
            if (!pending || pending.gen !== myGen) return;
            const finishDone = pending.done;
            clearPending(false);
            fn(finishDone);
          }

          let attempt = 1;
          let collector = null;
          switch (mode) {
            case 'collect-list':
              collector = createParamListCollector({ warn: (text) => node.warn(`mavlink-param: ${text}`) });
              break;
            default: break; // This space intentionally left blank (§5)
          }

          const unsubscribe = connNode.subscribe(echoFilter, (decoded) => {
            if (!pending || pending.gen !== myGen) return;
            switch (mode) {
              case 'confirm-set':
                if (!matchesParamEcho(request, decoded)) return;
                settle((finishDone) => {
                  completeResult(node, send, 'succeeded', 'echo-confirmed', decoded, { attempts: attempt });
                  finishDone();
                });
                break;
              case 'confirm-read':
                if (!matchesParamReadReply(request, decoded)) return;
                settle((finishDone) => {
                  completeResult(node, send, 'succeeded', 'value-received', decoded);
                  finishDone();
                });
                break;
              case 'collect-list': {
                const params = collector.accept(decoded);
                if (params === null) return;
                if (params === true) return;
                settle((finishDone) => {
                  completeResult(node, send, 'succeeded', 'list-complete', params);
                  finishDone();
                });
                break;
              }
              default: break; // This space intentionally left blank (§5)
            }
          });

          // Display mapping, not dispatch (§5 last paragraph).
          const timeoutDetail = mode === 'confirm-set' ? 'echo timeout'
            : mode === 'confirm-read' ? 'read timeout' : 'list timeout';

          /** Arm the transaction deadline. */
          function armDeadline() {
            return setTimeout(() => {
              if (!pending || pending.gen !== myGen) return;
              let extra;
              switch (mode) {
                case 'confirm-set':
                  if (attempt < PARAM_SET_ATTEMPTS) {
                    attempt += 1;
                    applyActionStatus(node, 'sending', `resend ${attempt}/${PARAM_SET_ATTEMPTS} ${request.paramId}\u2026`);
                    send([null, makeStatusRecord(node.type, {
                      result: 'progress',
                      detail: `resend ${attempt}/${PARAM_SET_ATTEMPTS}`,
                    })]);
                    try {
                      connNode.send(message, { band: BAND.CONTROL, target: request.target, identityId });
                    } catch (err) {
                      settle((finishDone) => failInput(node, send, err, finishDone));
                      return;
                    }
                    pending.timer = armDeadline();
                    return;
                  }
                  extra = { attempts: attempt };
                  break;
                default: break; // This space intentionally left blank (§5)
              }
              settle((finishDone) => timeoutResult(node, send, timeoutDetail, finishDone, extra));
            }, timeoutMs);
          }

          pending = { unsubscribe, timer: null, done, gen: myGen };
          pending.timer = armDeadline();
        }
      } catch (err) {
        failInput(node, send, err, done);
      }
    });

    node.on('close', (done) => {
      // Release the in-flight transaction's own done() — a redeploy mid-request
      // otherwise leaves that message forever unfinished for Node-RED's
      // onComplete hook / any wired Complete node. Matches the supersede path
      // above and the close handlers in mavlink-command / mavlink-mission
      // (issue #96).
      clearPending(true);
      done();
    });
  }

  RED.nodes.registerType('mavlink-param', MavlinkParamNode);
};

/**
 * Build a normalized param request from payload, node config, identity node,
 * and profile (per the role × tier matrix, DESIGN.md §6).
 *
 * Resolution order per field (sysid/compid): msg.payload.target →
 * companion derivation → config → profile default.
 * Firmware: payload → active profile. On Build, a concrete dialect supplies
 * `{ firmware: config.firmware }`; the Vehicle Profile escape supplies the
 * vehicle profile. Encoding: override → capabilities → named firmware.
 *
 * @param {object} config
 * @param {object} payload
 * @param {{target: object, profile: object|null, capabilities: number|null}} ctx
 * @returns {object} normalized param request
 */
function requestFrom(config, payload, { target, profile, capabilities }) {
  const firmware = payload.firmware === undefined ? profile.firmware : payload.firmware;
  // `paramEncoding` only. The old `payload.encoding` rung was undocumented,
  // unexampled and untested — nothing in the repo ever wrote it (1a79c88 removed
  // the matching config-side alias).
  const encoding = payload.paramEncoding;
  return {
    action: payload.action === undefined ? config.action : payload.action,
    target,
    paramId: payload.paramId === undefined ? config.paramId : payload.paramId,
    // paramIndex 0 is a valid index; keep it rather than letting `||` drop it to
    // the library's -1 default. Absent (undefined) is left for the library.
    paramIndex: payload.paramIndex === undefined ? config.paramIndex : payload.paramIndex,
    value: payload.value !== undefined ? payload.value : config.value,
    // No REAL32 fallback: an absent type resolves to nothing, never to a
    // guess — guessing the type silently mis-encodes the value (#222).
    paramType: payload.paramType === undefined ? config.paramType : payload.paramType,
    firmware,
    encoding,
    capabilities,
  };
}

/**
 * Read AUTOPILOT_VERSION.capabilities for the addressed component, when known.
 *
 * @param {object} connectionNode
 * @param {{sysid: number, compid: number}} target
 * @returns {number|null}
 */
function capabilitiesFromPeer(connectionNode, target) {
  // Missing component or capabilities → fall through to firmware (null).
  const component = connectionNode.peerTable.getComponent(target.sysid, target.compid);
  if (!component || component.capabilities == null || component.capabilities === '') {
    return null;
  }
  return Number(component.capabilities);
}

function completeBuild(node, send, message) {
  applyActionStatus(node, 'ok', 'built param');
  send([{ payload: message }, makeStatusRecord(node.type, { result: 'succeeded', detail: 'built', message })]);
}

function completeResult(node, send, result, detail, payload, extra) {
  applyActionStatus(node, 'ok', detail);
  send([{ payload }, makeStatusRecord(node.type, { result, detail, payload, ...extra })]);
}

function timeoutResult(node, send, detail, done, extra) {
  applyActionStatus(node, 'error', detail);
  send([null, makeStatusRecord(node.type, { result: 'timed-out', detail, ...extra })]);
  done();
}
