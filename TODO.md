# TODO

Work that is understood and deliberately not done yet. An entry earns its place
by naming the concrete gap, what it would cost, and what has to be true before
it is worth doing — not by being a good idea.

Settled decisions live in DESIGN.md §14. This file is for work, not rulings.

---

## Gimbal aim via `GIMBAL_MANAGER_SET_ATTITUDE` — the roll axis

**The gap.** The two gimbal aim paths do not carry the same axes:

```
gimbal|aim|legacy    (DO_MOUNT_CONTROL)              pitch, roll, yaw
gimbal|aim|manager   (GIMBAL_MANAGER_SET_PITCHYAW)   pitch, yaw, pitch_rate, yaw_rate
```

Moving a flow from the legacy mount protocol to the modern gimbal-manager one
**silently drops roll**. No error, no warning — the Roll box stops existing.

Upstream's answer is a third message, which we do not implement:

```
GIMBAL_MANAGER_SET_ATTITUDE (282)
  flags  gimbal_device_id  q (quaternion)  angular_velocity_x/y/z
```

`GIMBAL_MANAGER_SET_PITCHYAW` (287) is the same protocol without roll.
`node-red-contrib-mavlink-ai` ships both and puts it plainly: *"sends the full
roll/pitch/yaw as a quaternion… Use this when roll matters; otherwise pitch/yaw
is simpler."*

This is an omission, not a removal — `git log -S GIMBAL_MANAGER_SET_ATTITUDE`
across all history returns nothing.

**What it costs.** More than most payload work, because `q` is a quaternion —
four floats — and an operator thinks in degrees. Something has to convert euler
angles to a quaternion, which would be the first place a payload recipe
*computes* rather than passes a value through. That is a real function in
`lib/payload` with its own tests, not a table entry.

The picker cost is one option: a third `gimbal|aim|*` path alongside `legacy`
and `manager`, using the Gimbal path select that already exists.

**Before doing it, answer this.** Do you ever command gimbal roll? Most
stabilisation gimbals reject roll commands outright and hold level themselves;
cinema gimbals with a deliberate dutch-roll accept it. If the answer is no, the
asymmetry above is a curiosity rather than a gap, and the euler→quaternion
helper is code with no caller.

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

---

## Per-target patches in the Fan-out editor

**The gap.** Fan-out replicates one built message across a group, and
`msg.payload.targets` can patch fields per member — but only from a payload.
There is no editor surface, so the case that motivates the feature needs a
function node to express:

> Send one GPS location to Fan-out. Without a per-member offset, every drone in
> the group is commanded to *the same coordinate*.

That is not a formatting inconvenience. Replicating a `COMMAND_INT` Reposition
or a `SET_POSITION_TARGET_GLOBAL_INT` verbatim across N vehicles is a set of
converging trajectories to one point, and the operator who reached for Fan-out
because it is the simple node is exactly the one who will not think to write a
function node first.

**What it costs — and why the obvious UI is the wrong one.** The naive version
is a sysid → JSON table of raw field patches. Three reasons that is not the
thing to build:

1. Fan-out is the **raw wire plane** (DESIGN.md, "unit conversion belongs to
   exactly one of two surfaces"). Patches are wire units, so on either global
   carrier the operator is hand-typing degE7 — `900` to mean 0.00009°. An
   unvalidated integer box where a typo is a hundred metres is the surface §2
   exists to keep out of editors.
2. **A degree offset is not a distance.** 1e-5° of latitude is ≈1.11 m
   anywhere; 1e-5° of longitude is 1.11 m at the equator and ≈0.56 m at 60° N.
   A UI offering "offset X/Y" in degE7 gives separation that silently changes
   with latitude — the spacing tested at the test field is not the spacing
   flown elsewhere. The useful unit is **metres**, converted against the
   message's own latitude at build time. That is computation, not a config
   field, which is what makes this more than an editor change.
3. That computation already exists. `lib/formation/index.js` has
   `EARTH_RADIUS_M`, the flat-earth conversion and the `cos(lat) → 0` refusal
   (`:272-284`). A second implementation inside the Fan-out editor is the
   duplication this repo keeps deleting.

Note the feature is not position-only — per-member `PARAM_SET` values or
per-member speeds are the same shape — but position is what carries the hazard,
and units are what make it hard.

**Before doing it, answer this.** Is the need *"spread a group around a point"*
or *"nudge any replicated message per member"*? The first is
`mavlink-formation`, which already takes an anchor and emits per-member
coordinates — and if that is the real need, the answer is documentation and an
example, not a new editor surface. The second is genuinely absent: Formation
only emits Reposition, so there is no way to spread a group using any *other*
built message.

If it gets built: metres and not degE7, converted through `lib/formation`'s
existing helpers rather than a second copy, and the table has to make clear
which member gets which offset — an unlabelled sysid → JSON blob fails the same
readability test that retired Fan-out's embedded mini-editor.
