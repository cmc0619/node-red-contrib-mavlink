# What you can set from `msg.payload`

Every node reads its setup from the edit box. Some of those fields can also be
set at run time, by the message that comes in. This page lists which ones, for
every node.

Audit date: **2026-09-12**, against `main` at 0.7.0. Read from the code, not
from the help text.

## The rule

A key in `msg.payload` wins if the key is **there at all**. `null`, `0` and `""`
all count as there, and ride through as typed. Leave the key out and the saved
value is used.

```js
// lib/addressing/resolve.js
payload[key] === undefined ? config[key] : payload[key]
```

There is no merge and no clean-up. What you send is what goes on the wire.

## What no node lets you change

**The job the node does.** You can change a node's inputs, never its verb:

| node | locked field |
|---|---|
| Command | Mode, Preset, Advanced command |
| Mission | Operation |
| Move | Action |
| System | Service, Operation |
| State | Mode |
| Formation | Shape |

**The plumbing.** No node takes these from a message: Delivery, Timeout,
Max retries, Connection, Dialect, Vehicle Profile, Name.

Fan-out is the one break in that rule. It takes Delivery, Timeout, Max retries
and more (see below).

## Per node

Four nodes take no input at all, so nothing can be set by message: **Connection**,
**Vehicle Profile**, **Local Identity**, and **In**.

Three take the whole payload as their data rather than merging fields:
**Out**, **Build**, and **System** on its upload and restore work.

| node | send in `msg.payload` | edit box only |
|---|---|---|
| **Build** | any field of the message (merged one key at a time) | Message, Tier, Band, Repeat, Dialect, Connection, Vehicle |
| **Command** | `1`–`7` (the params), `mode` (a mode name), `target.sysid`, `target.compid`, `identityId` | Mode, Preset, Advanced command, Send as, Frame, Unconfirmed, Completion timeout |
| **Fan-out** | `message`, `targets`, `selection`, `delivery`, `executionMode`, `stopOnError`, `intervalMs`, `timeoutMs`, `maxRetries`, `concurrency`, `identityId` | Connection |
| **Formation** | `sysids`, `headingDeg`, `pitchDeg`, `anchor` | Shape, Spacing, Promote leader, Leader, Change mode |
| **Health** | `health` (the verb), `ttl_s` | Identity, Connection |
| **Mission** | `items`, `seq`, `missionType`, `target.*`, `identityId` | Operation |
| **Move** | 23 named fields, plus `position`, `velocity`, `accel`, `rateHz`, `ttlMs`, `timeBootMs`, `action: "stop"`, `target.*`, `identityId` | Action |
| **Out** | `message`, or the whole payload as the message | Band, Connection |
| **Param** | `action`, `paramId`, `paramIndex`, `value`, `paramType`, `paramEncoding`, `firmware`, `target.*`, `identityId` | Lookup |
| **Payload** | `topic`, `verb`, `path`, `values`, `sendAs`, `mavFrame`, `target.*`, `identityId` | — |
| **State** | `sysid`, `compid` | Mode, Events, Connection |
| **System** | `id`, `size`, `paramEncoding`, `path`, `target.*`, `identityId`, plus the file or param data as the whole payload | Service, Operation, Sections |

Move's 23 named fields are: `altRef`, `reference`, `speed`, `radius`,
`changeMode`, `heading`, `turnRate`, `direction`, `relative`, `roll`, `pitch`,
`rollRate`, `pitchRate`, `thrust`, `stickX`, `stickY`, `stickZ`, `stickR`,
`buttons`, `throttle`, `speedType`, `yaw`, `yawRate`.

## Name traps

The key you send is not always the name of the field in the box. Some keys do
not sit in `msg.payload` at all.

| node | field in the box | what to send |
|---|---|---|
| Health | Lease TTL | `msg.payload.ttl_s` |
| System | Log | `msg.payload.id` |
| Payload | Frame | `msg.payload.mavFrame` |
| Command | Frame | `msg.mavFrame` (not in payload) |
| Out, Build | Band | `msg.band` (not in payload) |
| State | Target sysid / compid | `msg.payload.sysid` / `.compid` (flat) |
| all other nodes | Target sysid / compid | `msg.payload.target.sysid` / `.compid` |
| all nodes | Identity | `msg.payload.identityId` |

System splits its Path two ways. List and download read `msg.payload.path`.
Upload, backup and restore read `msg.path`, because the payload holds the file
bytes there.

## Group keys wipe the whole group

Four keys stand in for several boxed fields at once. Send one and **every**
saved field behind it is dropped. There is no way to set just one part.

| key | fields it replaces |
|---|---|
| `position` | North, East, Up, Lat, Lon, Alt (Move) |
| `velocity` | vNorth, vEast, vUp (Move) |
| `accel` | aNorth, aEast, aUp (Move) |
| `anchor` | Anchor mode, Lat, Lon, Alt (Formation) |
| `selection` | Selection mode, Members, Vehicle type, Firmware, Armed (Fan-out) |
| `values` | every slot (Payload) |

## Sharp edges

- **Move `action`.** `msg.payload.action` is not a way to pick the Action. Only
  the word `"stop"` is read, and it halts a stream. Any other value is ignored
  and the boxed Action still runs.
- **Move `yawRate` on the goto command path.** That path reads the payload key
  on its own and never falls back to the boxed Yaw rate. A saved value is
  dropped. The stream, steer and attitude paths do fall back. This looks like a
  bug, not a choice.
- **Move on Stream delivery** ignores `speed`, `radius`, `changeMode` and
  `yawRate`. They belong to the command path only.
- **Payload `values`** swaps the whole slot set. It does not merge.
- **Build const fields** win over the payload. A field the dialect fixes cannot
  be set by message.
- **Dead boxes.** `lookup` on Param and `firmware` on Mission are saved by the
  editor and never read at run time.

## Where the help text stands

Node help does not cover this well.

- Move names about 15 of its 23 keys. The Turn and Steer fields, among them
  `heading`, `turnRate`, `throttle`, `stickX` and `buttons`, are not written
  down anywhere but here.
- Command says only that `msg.payload` can override values. It names none.
- Most other nodes name one or two keys, or none.

No test pins this surface. If you change it, change this page too.
