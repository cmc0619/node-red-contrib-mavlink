# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/spec/v2.0.0.html). Pre-1.0 means the
config-node shapes and message contracts may still change without a major bump.

## [Unreleased]

### Changed

- **Breaking — `mavlink-in`**: the message filter is now a list. The `message`
  config key is replaced by `messages`, an array of message names; an empty
  array means "receive everything", which is what a blank `message` meant. The
  bundled examples are converted. A flow saved with 0.1.0 keeps the retired
  `message` key, which the node no longer reads — such a node subscribes
  unfiltered until the filter is re-entered in the editor. Pre-1.0: there is no
  alias for the old key.

## [0.1.0] - 2026-08-08

Initial release.
