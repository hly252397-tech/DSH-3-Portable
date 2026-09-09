# Changelog

[简体中文](CHANGELOG.zh-CN.md)

The five most recent published versions are listed below.

## 1.0.51 Portable Integration — 2026-09-09

- Aligned git ancestry with upstream `v1.0.51` via an `merge -s ours` re-baseline, so every future sync is a three-way merge from that point instead of replaying conflicts from already-ported 1.0.42–1.0.46 content.
- Ported the upstream `v1.0.50` subagent unread fix: sessions with `origin === 'subagent'` are excluded from the taskbar badge across the initial baseline, completion-transition notifications, and delayed origin metadata.
- Bumped the desktop version to `1.0.51`, electron to `44.1.1`, and `@types/node` to `26.4.1`; the `yaml` dependency used only by upstream's bridge migration module is intentionally not adopted.
- Reviewed and intentionally skipped the upstream 1.0.47–1.0.51 recovery-mode hardening series: it is deeply coupled to upstream's `desktop-bridge` migration architecture, while the portable build keeps its own bridge closure (`dsh-process.js`/`profile-bundle-health.js`/`profile-quarantine.js`) and per-plugin quarantine transactions by design. The desktop pet, native Mica backdrop, and the bundled-plugin matrix jump (codex-ui 0.2→1.1 and friends) are likewise deferred; plugin upgrades will be evaluated separately through Profile transactions.
- Unified-updater enhancements: upstream releases without the portable compatibility contract now enter a dedicated "blocked" state instead of a red update failure; the release source is build-time configurable (`PortableDesktopReleaseSource`); candidate slots and download caches are pruned at commit points (pointer-referenced slots are always kept, three most recent unreferenced slots retained, audited in `events.jsonl`).
- Development-gate fixes: the official-baseline verifier now checks the real `@deepseek-ai/dsh` version inside the current pointer slot's packaged `dsh-runtime.tgz` (with GNU-tar `--force-local` detection to avoid the drive-letter pitfall) and downgrades the legacy fallback runtime directory to an informational note when an active runtime slot exists, turning the permanently red offline gate green; the builder falls back to the npmmirror electron mirror when `ELECTRON_MIRROR` is unset, eliminating build failures from direct GitHub download timeouts.

## 1.0.46 Portable Integration — 2026-09-04

- Upgraded the bundled official DSH runtime and its launch peers from `0.1.2-alpha.3` to `0.1.2-rc.1`, matching the trusted release list and removing the persistent "配套管理插件" update prompt.
- Integrated the upstream `v1.0.46` unread-completion badge fix and aligned all ten bundled community components with that release's pinned version matrix.
- Preserved the portable build's full embedded browser, transactional per-plugin quarantine, portable paths, and desktop/Harness dual A/B updaters instead of installing an upstream binary that lacks those capabilities.
- Added a release-level portable compatibility contract. The client verifies the contract SHA256, artifact SHA256, and required capabilities before download, preventing incompatible releases from replacing portable customizations.
- Fixed Electron physical-ASAR validation, reuse of verified download caches, and preservation of visible failure progress, error codes, and transaction IDs.
- Changed desktop updates to prewarm the shared runtime before activation. Archives now carry logical-content digests that ignore packaging timestamps and pnpm's volatile SQLite mtime index while retaining a deterministic store lockfile: unchanged content reuses the cache across desktop builds, changed content is prepared while the old desktop remains usable, and restart only performs the slot switch and health check. Startup extraction remains solely as interrupted/damaged-cache recovery.
- Hardened the Windows cold-start smoke gate: local acceptance data can be pinned to the portable drive, HTTP 401 checks use a bounded `HttpClient` instead of the version-dependent web cmdlet, and cleanup validates its boundary, normalizes read-only entries, and retries before reporting success.

## 1.0.43 — 2026-09-01

- Upgraded the bundled official DSH runtime and its launch peers to `0.1.2-alpha.3`.
- Updated the bundled ecosystem to Codex UI 0.2.97, IM Connect 0.1.30, Archive Manager 0.1.22, and MCP Connector 0.2.32.
- Hardened offline runtime initialization by sharing the bundled-plugin verifier across Windows smoke tests, waiting for the desktop ready marker on both HTTP paths, and cleaning the full extraction process tree when initialization is cancelled or times out.

Release tag: [`v1.0.43`](https://github.com/MichengAI/dsh-codex-desktop/tree/v1.0.43).

## 1.0.41 — 2026-08-31

- Fixed the offline bundle so it includes every peer required to launch the official DSH runtime without network access.
- Moved portable first-run verification, extraction, and bulk file copying into a separate child process with staged progress, preventing the window from becoming unresponsive during initialization.
- Bound runtime and plugin-store completion markers to the bundled archive SHA256. Empty or stale markers from overwritten or reused portable directories now trigger re-extraction, so offline first launch no longer starts without plugins.
- Made Windows, macOS, and Linux packaged-app smoke tests force offline mode and verify all ten bundled plugins and their pinned versions in an isolated profile.

Release tag: [`v1.0.41`](https://github.com/MichengAI/dsh-codex-desktop/tree/v1.0.41).

## 1.0.40 — 2026-08-31

- Upgraded the bundled official DSH runtime and its launch peers to `0.1.2-alpha.2`, including authenticated startup-token handling and the alpha.2 native-script requirements.
- Updated the bundled ecosystem to IM Connect 0.1.27, Skills Manager 0.1.32, Archive Manager 0.1.21, Agency Agents 0.1.23, `dsh-context` 0.38.5, DSH Better Sidebar 0.18.0-alpha.0, MCP Connector 0.2.31, and `dshmarket` 1.38.1.
- Upgraded `electron-builder` to 26.15.7 and refreshed the offline runtime and plugin-store assembly for fresh installs and missing-package repair.
- Aligned Windows, macOS, and Linux packaged-app smoke tests with alpha.2 authentication by verifying the expected unauthenticated response, process liveness, startup diagnostics, and the post-window ready marker in isolated profiles.

Release tag: [`v1.0.40`](https://github.com/MichengAI/dsh-codex-desktop/tree/v1.0.40).

## 1.0.39 — 2026-08-30

- Added native Linux ARM64 / aarch64 packages for Ubuntu, Debian, and other compatible distributions, with both `.deb` and `.AppImage` artifacts.
- Added a native GitHub-hosted ARM64 packaging job and packaged-app smoke test instead of relying on unverified cross-compilation.
- Added the verified Node.js 24.20.0 Linux ARM64 executable checksum and a release guard for the architecture-specific `latest-linux-arm64.yml` update metadata.
- Updated the English and Chinese download, system-requirement, and development documentation for Linux x64 / ARM64 parity.

Release tag: [`v1.0.39`](https://github.com/MichengAI/dsh-codex-desktop/tree/v1.0.39).

## 1.0.38 — 2026-08-30

- Updated the six bundled MichengAI products to Codex UI 0.2.94, IM Connect 0.1.26, Automation 0.1.22, Skills Manager 0.1.31, Archive Manager 0.1.19, and Agency Agents 0.1.22.
- Updated the bundled ecosystem components to `dsh-context` 0.38.3, DSH Better Sidebar 0.17.1, MCP Connector 0.2.29, and `dshmarket` 1.38.0.
- Refreshed the offline plugin catalog used by fresh installs and missing-package repair. Existing profiles can apply the same versions through the plugin market without the desktop silently overriding user-selected package versions.
- Kept the bundled official DSH runtime on the current npm release, 0.1.1-rc.2; the source-only 0.1.2 Alpha remains outside the stable desktop channel.

Release tag: [`v1.0.38`](https://github.com/MichengAI/dsh-codex-desktop/tree/v1.0.38).
