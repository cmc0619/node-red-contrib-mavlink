# MAVLINK.md

MAVLink protocol lessons learned while building this toolkit. This file is the
protocol-fact counterpart to `DESIGN.md` §14: `DESIGN.md` records how the toolkit must be
built; this file records what the MAVLink protocol actually does.

## The certainty gate (read before adding anything)

An entry is written **only when sure**. "Sure" means confirmed against:

- the dialect XML (the message/enum definitions compiled from `mavlink-mappings`); or
- measured on-wire behavior — a SITL capture or real-vehicle exchange, recorded as a §14
  ground-truth entry in `DESIGN.md`.

Reading the established implementations — pymavlink, MAVSDK, the GCS codebases, and above all
the ArduPilot and PX4 source trees — is the right way to form the hypothesis; their behavior
is the default expectation. But an entry is only written once that hypothesis is confirmed
against the XML or the wire: even the true references disagree with each other, and with the
spec, often enough that none of them alone is ground truth (see `AGENTS.md`). If a belief is
plausible but unconfirmed, it does not go in the entries — it goes in **Open questions** below
until someone measures it.

## Entry format

Each entry:

- states the protocol fact as confirmed;
- names the evidence — dialect XML file and field, or the capture/rig that demonstrated it,
  with a date;
- notes the consequence for the toolkit — which node or `lib/` module cares, and why.

Delete or correct an entry the moment a §14 measurement contradicts it; this file is ground
truth only because it is kept honest, not because it is written down.

## Entries

*(None yet — the file starts empty by design.)*

## Open questions

*(Unverified beliefs worth measuring go here — never in Entries.)*
