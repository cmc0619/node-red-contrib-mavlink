# Security

## Reporting

Open a GitHub issue. This is a pre-1.0 hobby-scale project with one maintainer;
there is no private disclosure channel and no response-time commitment.

## Fixed: path traversal in two admin routes (found 2026-09-27)

Both affect 0.7.3 and earlier and are fixed in the next release (`CHANGELOG.md`,
[Unreleased]). Upgrade if an untrusted user can reach your Node-RED admin API.

- **Param definitions route (R7a).** `POST /mavlink/param/defs/update` named its
  holding file from the raw Vehicle Profile id (`req.body.vehicle`), so a user
  holding `mavlink.write` could send `"vehicle": "../../flows"` with a URL they
  controlled and overwrite `flows.json`. The route writes the fetched document
  whatever it parses to, so the injected flow loaded on the next restart: code
  execution for anyone with that permission. `../../../x` wrote a `*.json` file
  outside the userDir. The `GET` side, which needs only `mavlink.read`, could leak
  about ten bytes of a non-JSON `*.json` file, or whole entries of a JSON file
  shaped like parameter definitions. Measured on Node-RED 5.0.5. **Fix:** the
  holding file is the basename of the profile id, for both routes, so an id can
  name only a file in the holding directory.
- **XML catalog update (R7b).** The update followed `<include>` names found in
  the downloaded XML into both the fetch URL and the file write, so a poisoned
  upstream file could write outside the snapshot directory (probed with injected
  fetchers). **Fix:** an update fetches exactly the upstream directory listing,
  which is already closed under `<include>`; downloaded text names nothing to
  fetch or write.

In a default Node-RED install with no `adminAuth`, every visitor to the editor
holds both permissions. Set `adminAuth` on any instance reachable from a network
you do not control.

## Accepted risk: the `xml2js` chain under `node-mavlink`

A consumer install of this package gets `xml2js@0.4.23`, reached only through:

```
node-mavlink@2.3.0 → mavlink-mappings@1.0.21 → mavlink-mappings-gen@0.0.9 → xml2js@0.4.23
```

`npm audit` in a project that installs the package reports **5 moderate severity
vulnerabilities**: one advisory,
[GHSA-776f-qx25-q3cc](https://github.com/advisories/GHSA-776f-qx25-q3cc), counted
once for each package on that path (measured on a clean consumer install of the
0.7.3 tarball, 2026-09-27).

**This is accepted, not overlooked.** It stays until `node-mavlink` moves off
it.

**No `overrides` pin.** `package.json` carries no `overrides`. npm applies
`overrides` only to the root project's own install, never to a consumer's, so an
`xml2js@0.6.2` pin made this repository's audit report 0 vulnerabilities while
every user still got 0.4.23. Without it, `npm audit --omit=dev` here shows what a
consumer installs.

**Why it is not exploitable here.** The chain exists to *generate* code from
MAVLink dialect XML. Nothing in this package calls `xml2js`: every XML it parses —
the seed dialects in `seed/`, a custom dialect file from the operator's disk, the
upstream definitions the XML catalog update downloads, and parameter-definition
XML — goes through `fast-xml-parser`. Decoded MAVLink frames never reach any XML
parser: the wire codec works from the *compiled* metadata, not the source XML.

**Why it is not simply fixed.** `mavlink-mappings` is effectively unmaintained,
and `npm audit`'s only remedy is downgrading `node-mavlink` to 2.0.3 — a
breaking change to the codec this package is built on. Trading a working wire
implementation for a green audit line is the wrong trade.

**What would change the decision.** An advisory reachable through a code path
this package actually calls, or `node-mavlink` publishing a release off the old
chain. Either one, and this section goes away.

`.github/dependabot.yml` deliberately ignores major updates to `node-mavlink`
so a bot cannot take that trade unattended. CI's "Audit shipped dependencies"
step runs `npm audit --omit=dev --audit-level=high`, so these moderate findings
are reported there and do not fail the build.

## Dev-only advisories

Advisories under `node-red` and other `devDependencies` do not ship — they are
not in the published package and cannot reach a user. They are cleared by
keeping the dev tree current rather than by pinning, and Dependabot handles that
monthly.

To see only what actually ships:

```
npm audit --omit=dev
```

That should report the `xml2js` chain above and nothing else.
