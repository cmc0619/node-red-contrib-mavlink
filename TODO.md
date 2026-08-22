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

**Two things are wrong before the lab can even try.**

*Loopback is off, and it should not be.* `_enableBroadcast` calls
`setMulticastLoopback(false)` so we do not hear our own transmissions. That
breaks the main use case: ArduPilot's `mcast:` exists precisely so several
tools on one host can share a SITL link, and with loopback off a locally-run
SITL and Node-RED never hear each other. It does not even solve what it was
for — a socket bound to `0.0.0.0:14550` receives its own subnet broadcasts
too, and there is no `IP_BROADCAST_LOOP` to turn off.

*Nothing filters our own frames.* `runtime.js`'s `_onFrame` puts every
accepted frame into `peerTable.update()` and dispatches it. Once loopback is
on, our GCS registers as peer sysid 255 and an In node subscribed to
`COMMAND_LONG` sees our own commands echoed. The fix is to ignore inbound
frames whose `(sysid, compid)` matches a bound identity — a component should
not treat its own transmissions as peer traffic. Only reachable on
multicast/broadcast loopback; no other path echoes us.

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

## Regenerate the editor screenshots

All of `docs/screenshots/`, as one pass — not a file at a time. Once a live
Node-RED and Puppeteer are up, recapturing the whole set costs barely more than
recapturing one, and a per-file list of what is stale goes stale itself.

`docs/screenshots/README.md` records the method: a live Node-RED 4 editor with
the package installed, driven through `RED.editor.edit` via Puppeteer rather
than a double-click. So this is re-running something known, not inventing it.

Known wrong at the time of writing: `13-fanout.png` still shows a dialog titled
**mavlink swarm** from before the rename, and the payload and command shots
predate the generated payload form, the device topics, the checkboxes and the
removal of blank enum options.

**Why it waited.** These document a UI that was moving daily; recapturing
mid-churn buys pictures that are stale again next week. Payload is settled now,
which is what makes the pass worth doing.

**Worth deciding once:** hand-regenerate when a dialog settles, or make the
Puppeteer capture something CI runs. The second only pays off if the pictures
are load-bearing for users rather than decoration in the README.
