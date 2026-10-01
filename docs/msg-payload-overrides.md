# What you can set from `msg.payload`

Every node reads its setup from the edit box. Some of those fields can also be
set at run time, by the message that comes in. This page lists which ones, for
every node.

Audit date: **2026-09-27**, against the code after the R-series review fixes.
Read from the code, not from the help text.

## The rule

A key in `msg.payload` wins if the key is **there at all**. `null`, `0` and `""`
all count as there, and ride through as typed. Leave the key out and the saved
value is used.

```js
// lib/addressing/resolve.js
payload[key] === undefined ? config[key] : payload[key]
```

A few keys use the blank rule instead (`firstDefined` and `isBlank` in the
same file): `null` and `""` count as left out, so the saved value is used.
Those are `target.sysid` and `target.compid` wherever a node takes them,
State's `sysid` and `compid`, and Formation's `headingDeg` and `pitchDeg`.
Command's `mode` has no saved value; a blank one names no mode.

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
**Out**, **Build**, and **System** on its upload and restore work. Out and
Build also read keys at the message root, beside `msg.payload`.

| node | send in `msg.payload` | edit box only |
|---|---|---|
| **Build** | any field of the message (merged one key at a time); at the message root, `msg.band`, `msg.target` and `msg.identityId` (Send tier) | Message, Tier, Band, Repeat, Dialect, Connection, Vehicle |
| **Command** | `1`–`7` (the params), `mode` (a mode name), `target.sysid`, `target.compid`, `identityId`; at the message root, `msg.mavFrame` | Mode, Preset, Advanced command, Send as, Unconfirmed, Completion timeout |
| **Fan-out** | `message`, `targets`, `selection`, `delivery`, `executionMode`, `stopOnError`, `intervalMs`, `timeoutMs`, `maxRetries`, `concurrency`, `identityId` | Connection |
| **Formation** | `sysids`, `headingDeg`, `pitchDeg`, `anchor` | Shape, Spacing, Promote leader, Leader, Change mode |
| **Health** | `health` (the verb), `ttl_s` | Identity, Connection |
| **Mission** | `items`, `seq`, `missionType`, `target.*`, `identityId` | Operation |
| **Move** | 23 named fields, plus `position`, `velocity`, `accel`, `rateHz` and `ttlMs` (Stream), `timeBootMs` (Build and Send), `action: "stop"`, `target.*`, `identityId` | Action |
| **Out** | the message, in one of three shapes (below); at the message root, `msg.topic`, `msg.band`, `msg.target`, `msg.identityId` | Band, Connection |
| **Param** | `action`, `paramId`, `paramIndex`, `value`, `paramType`, `paramEncoding`, `firmware` (the encoding's firmware rung), `target.*`, `identityId` | Lookup |
| **Payload** | `topic`, `verb`, `path`, `values`, `sendAs`, `mavFrame`, `target.*`, `identityId` | — |
| **State** | `sysid`, `compid` (Snapshot mode only; a Feed reads neither) | Mode, Events, Connection |
| **System** | `id`, `size`, `paramEncoding` (parameter backup and restore alike), `path`, `target.*`, `identityId`, plus the file or restore bundle as the whole payload; at the message root, `msg.path` | Service, Operation, Sections |

Move's 23 named fields are: `altRef` (`home`, `msl`, `terrain`), `reference`
(`world`, `body`, `offset`), `speed`, `radius`, `changeMode`, `heading`,
`turnRate`, `direction`, `relative`, `roll`, `pitch`, `rollRate`, `pitchRate`,
`thrust`, `stickX`, `stickY`, `stickZ`, `stickR`, `buttons`, `throttle`,
`speedType`, `yaw`, `yawRate`. The Move help lists which action reads each.

Out reads its message in this order, and the first that applies wins:

1. the Build-tier envelope `{message: {name, fields}, …}`;
2. the topic shape: a `msg.topic` that is present is the message name and
   `msg.payload` its fields — what In emits, so In → Out forwards as received.
   A stock Inject sends `topic: ""`, which selects this shape; clear or delete
   `msg.topic` to use the next one;
3. `{name, fields}` as the whole payload.

Field names are the dialect's own snake_case (`target_system`, not
`targetSystem`), as In delivers them; any other spelling is not in the
message, and the send fails with `invalid packet`.

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
| Out, Build | Target, Identity | `msg.target` / `msg.identityId` (not in payload) |
| State | Target sysid / compid | `msg.payload.sysid` / `.compid` (flat) |
| all other nodes | Target sysid / compid | `msg.payload.target.sysid` / `.compid` |
| Command, Fan-out, Mission, Move, Param, Payload, System | Identity | `msg.payload.identityId` |

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
- **Move `yawRate`** is read by Steer and Attitude only. Go to has no yaw-rate
  field on either path, so the key is ignored there.
- **Move Go to on Stream delivery** ignores `speed`, `radius` and `changeMode`.
  They belong to the command path only.
- **State `sysid` / `compid`** filter a Snapshot. A Feed ignores them.
- **Payload `values`** swaps the whole slot set. It does not merge.
- **Build const fields** win over the payload. A field the dialect fixes cannot
  be set by message.
- **Dead box.** `lookup` on Param is saved by the editor, which uses it to
  show the name or the index field, and is never read at run time.

## Where the help text stands

Node help does not cover this well.

- Build, Command, Fan-out, Health, Mission, Move, Out, Param, Payload and
  System help each has an Inputs section naming the keys it reads; Move lists
  all of its keys there. Formation and State still name theirs in prose.
- Command names its payload overrides (`1`–`7`, `target`, `identityId`,
  `mode`) and the root `msg.mavFrame`.
- Out lists its three shapes and the root keys.

No test pins this surface. If you change it, change this page too.
