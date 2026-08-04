# Security

## Reporting

Open a GitHub issue. This is a pre-1.0 hobby-scale project with one maintainer;
there is no private disclosure channel and no response-time commitment.

## Accepted risk: the `xml2js` chain under `node-mavlink`

`npm audit` reports moderate advisories against `xml2js`, reached only through:

```
node-mavlink → mavlink-mappings → mavlink-mappings-gen → xml2js
```

**This is accepted, not overlooked.** It stays until `node-mavlink` moves off
it.

**Why it is not exploitable here.** That chain exists to parse *MAVLink dialect
XML*, and the only XML this package parses is what it ships or what an operator
deliberately points it at — the seed dialects in `seed/`, or a custom dialect
file the operator supplies from their own disk. There is no path from network
traffic to the XML parser. Decoded MAVLink frames never reach it: the wire codec
works from the *compiled* metadata, not the source XML.

**Why it is not simply fixed.** `mavlink-mappings` is effectively unmaintained,
and `npm audit`'s only remedy is downgrading `node-mavlink` to 2.0.3 — a
breaking change to the codec this package is built on. Trading a working wire
implementation for a green audit line is the wrong trade.

**What would change the decision.** An advisory that is reachable without local
file access, or `node-mavlink` publishing a release off the old chain. Either
one, and this section goes away along with the pin.

`.github/dependabot.yml` deliberately ignores major updates to `node-mavlink`
so a bot cannot take that trade unattended.

## Dev-only advisories

Advisories under `node-red` and other `devDependencies` do not ship — they are
not in the published package and cannot reach a user. They are cleared by
keeping the dev tree current rather than by pinning, and Dependabot handles that
monthly.

To see only what actually ships:

```
npm audit --omit=dev
```

At the time of writing that reports the four `xml2js` advisories above and
nothing else.
