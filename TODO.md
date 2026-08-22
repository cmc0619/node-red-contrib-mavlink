# TODO

Work that is understood and deliberately not done yet. An entry earns its place
by naming the concrete gap, what it would cost, and what has to be true before
it is worth doing — not by being a good idea.

Settled decisions live in DESIGN.md §14. This file is for work, not rulings.

---

## Swarm delivery has never spoken to a vehicle

The Swarm address landed in "Speaking to the swarm" (#137) with unit tests
against a mock `dgram` and nothing else. Multicast and broadcast are both
unverified against a real socket, let alone a real autopilot.

**The two driver defects are fixed:** multicast loopback stays at the OS
default (on), and `_onFrame` drops frames stamped with a bound identity's
exact `(sysid, compid)` before the peer table or any subscriber sees them.

**Measured 2026-08-22** (`node sitl/measure-swarm-mcast.js`, §14.133): multicast
group + subnet broadcast both arm a vehicle from one `target_system=0` write;
self-echo filtered; ap-mcast-41 needs `network_mode: host` (compose bridge does
not deliver inter-container IPv4 multicast).

**What the lab needs.** The AP containers launch `udpclient:` and join no
group, so a multicast swarm address reaches nobody today. They would need
`--serial0 mcast:239.255.145.50:14550` — ArduPilot's SITL parser accepts
`mcast:[ADDRESS][:PORT]` but has no `udpin:`, so multicast is the only
one-write mode AP SITL can be a member of. Plain subnet broadcast would have
to be tested against PX4, whose mavlink module does bind a UDP port.

**The trap to expect.** Node-RED runs `network_mode: host` while the vehicles
sit on the compose bridge. `addMembership(group)` with no interface argument
lets the OS pick by routing table — likely the default route, not the bridge.
So this probably also needs a multicast-interface option, and possibly
Node-RED moved onto the bridge network. That is a lab-topology problem, and it
is the part most likely to eat an evening.

**Worth knowing before spending that evening:** the fan-out already makes
broadcast *correct* on any IP topology where we have heard from the vehicles.
A swarm address buys wire efficiency, not capability — noise at five vehicles,
real at fifty.
---

## Verification debt — post-1.0 measurement queue

Inventoried in `docs/verification-debt.md`; release posture in `DESIGN.md` §14.132
(documented, not blocking 1.0.0). Drift check: `node scripts/inventory-verification-debt.js`.

**Worth measuring first** (operator-visible, cheap on the existing lab):

1. ~~Offset Steer stream walk~~ — **done 2026-08-22**.
2. ~~Turn yaw-timeout subclaims~~ — **done 2026-08-22**.
3. ~~Takeoff completion at non-zero home~~ — **done 2026-08-22** (`sitl/measure-verification-debt.js`).
4. ~~PX4 AUTO_LOITER flag-clear on goto~~ — **done 2026-08-22** (`sitl/measure-verification-debt.js`).

Remaining open subclaim: **14.95-terrain** (terrain alt ref absent from Move surface — no rig path).
