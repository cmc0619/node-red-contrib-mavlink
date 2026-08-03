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
