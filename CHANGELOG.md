# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/). Releases up to and including 0.10.0 were published from the original monorepo (codingfragments/pi-extensions, tags `gdrive-publish-v*`); this repository's history starts at 0.10.1.

## [0.13.0] - 2026-11-09

### Added

- `gdrive-publish auth` (also spelled `auth status`): read-only report of the credential-resolution chain — which source won, which were set but skipped and why — reported by name, path and hash, never by secret value. Also shows the client identity hash and the cached token's state (access-token expiry, refresh-token presence). `--verify` adds one authenticated Drive round trip (fetches the signed-in account; inside a publish root it also checks folder visibility under `drive.file` and the manifest's client identity). `--json` for scripts. Exits 0 only when credentials resolve and a token is cached for that client, mirroring `gh auth status`.
- `GOOGLE_OAUTH_CREDENTIALS` is honoured as an alias for `GDRIVE_PUBLISH_CLIENT_SECRET_FILE` (a path to a Google `client_secret.json`). The project-specific variable wins when both are set; a set-but-invalid alias file is skipped in favour of the next source.

### Changed

- **Breaking:** `gdrive-publish login` is now `gdrive-publish auth login`. The old name is rejected with a `did you mean "auth login"?` hint. Update scripts and muscle memory accordingly.

## [0.12.0] - 2026-10-30

### Added

- `markdownMode: native` (`init --markdown-mode native`, or `markdownMode` in `.gdrive-publish.json`): publish `.md` files as raw Drive markdown for Docs Markdown Mode instead of converting them to Google Docs.

## [0.11.0] - 2026-10-29

### Added

- Configurable document naming: a `naming` object in `.gdrive-publish.json` controls how published documents derive their titles, with explicit per-format fallback chains.

## [0.10.1] - 2026-10-29

First release published from the standalone repository (metadata only; the code is unchanged from 0.10.0, which was published from the original monorepo).
