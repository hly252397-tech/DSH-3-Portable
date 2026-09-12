# Changelog

[简体中文](CHANGELOG.zh-CN.md)

The five most recent published versions are listed below.

## 1.0.65 Portable Integration — 2026-09-12

- Fixed the rc.2 new-frontend (dsh-web-frontend,  module family) workspace tab menu overflowing over the portable sidebar: the menu is fixed-positioned with a JS right-aligned anchor, so a button at the strip's left edge pushed the menu's left rim into the sidebar zone. The theme pins the menu's left to 260px via module-prefix matching, after reviewing the new frontend's CSS source ( rule).

## 1.0.64 Portable Integration — 2026-09-12

- The native browser panel's reported-bounds path (when the page reports the card placeholder rect) was **not** going through `capBrowserWorkspacePanelWidth` — only the ratio-derived fallback was. This meant the native card could still render wider than `viewport − 900px` when the page's placeholder was itself too wide (the in-page clamp caught the in-page panel, but the native view mirrored the pre-clamp bounds). Fix: `normalizeBrowserPanelBounds` now clamps the reported width through the same `viewport − 900px` constraint before returning, so both paths enforce the conversation protection symmetrically. Also reinforced the shell's ratio cap from 0.55 to 0.48 and added `MAXIMUM_BROWSER_WIDTH_RATIO` as a named constant.

## 1.0.63 Portable Integration — 2026-09-12

- **Aligned the conversation layout with the official Harness model** (per user direction to stop patching and follow upstream): the official source defines `--dsh-chat-content-width = var(--dsh-chat-user-width, clamp(680px, 64% of column, 920px))` — already responsive by design. Two portable-side violations broke it: a legacy drag preference (`--dsh-chat-user-width: 640px` fixed pixels) overrode the responsive clamp, and the conversation floor (420→560px) sat below the official 680px content minimum. The theme now clears the stale preference (`unset`) so the official clamp governs, raises the conversation floor to the official 680px, and moves the workbench panel cap to `calc(100vw − 1040px)` (hides below a 1100px viewport). Verified the official source (`dsh-client-ui-conversation`) before changing anything.

## 1.0.62 Portable Integration — 2026-09-12

- Applied the same conversation-protection clamp to the shell's **native** browser workspace panel, which page CSS cannot reach: the width ratio cap drops from 0.75 to 0.55 of the window, and the ratio-derived width is additionally hard-capped at `viewport − 900px` (`capBrowserWorkspacePanelWidth`), so the native panel can never consume the conversation area regardless of how the ratio was dragged. A legacy persisted ratio above 0.55 is clamped at load. This closes the gap where the in-page clamp (1.0.56–1.0.61) governed better-sidebar's in-page panel while the native card followed its own ratio.

## 1.0.61 Portable Integration — 2026-09-12

- Re-proportioned the narrow-window layout using the user's reference (WorkBuddy): the conversation column floor rises from 420px to a comfortable 560px, the workbench panel takes the remainder capped at `calc(100vw − 1000px)`, and below a ~1040px viewport the panel hides entirely so the conversation owns the window. The panel yields first; the conversation floor yields last.

## 1.0.60 Portable Integration — 2026-09-12

- Narrow-window pass on the user's own screenshots: the previous clamp still granted the workbench panel up to `100vw − 740px`, which at a 2000px window left the conversation at its 420px floor with home cards clipped mid-card. The panel cap is now `clamp(340px, calc(100vw − 900px), 1100px)` — an 1100px absolute maximum (the dragged 1075px still fits on wide screens) that yields space first as the window narrows (measured: panel 460 / conversation 508 at a 1450px window, zero overflow). The home cards row also wraps now (`flex-wrap: wrap`), degrading to a 2×2 grid instead of being clipped.

## 1.0.59 Portable Integration — 2026-09-12

- Fixed the root cause of the clipped conversation content (titles and cards cut in half at narrow widths): the conversation root carries inline persisted pixel widths from the retired width-handle era (`--dsh-conversation-column-width: 1035px`, `--dsh-chat-user-width: 640px`), so whenever the container shrank below those pixels the content overflowed and was clipped. The theme now overrides them responsively (`min(100%, 900px)` / `min(100%, 640px)`): the content fills its container at any width and caps at a readable 900px line length on wide screens. Verified live: container 623px → content 623px, zero clipping.

## 1.0.58 Portable Integration — 2026-09-12

- GitHub API rate limiting (HTTP 403/429 from the unauthenticated `releases/latest` call) no longer renders as a red "update failed": the check now keeps the previous conclusion (up-to-date / available, whichever was last confirmed), refreshes the check timestamp with a "rate limited, will retry" note, and only surfaces the `RELEASE_RATE_LIMITED` code. High-frequency checking (restarts × check cycles × manual) exhausts the 60/hour anonymous quota easily — that is a transient condition, not a broken release.
- Loosened the workbench panel clamp: the 900px absolute cap from 1.0.57 locked the file-visualization panel ("固定死了"). The clamp is now a single hard floor for the conversation — the panel may occupy anything up to the viewport minus 740px (icon rail + sidebar + 420px conversation + gaps), i.e. up to ~1820px on a 2560 screen. The user decides how wide; the conversation floor is the only invariant.

## 1.0.57 Portable Integration — 2026-09-12

- Refined the workbench panel clamp from the previous release: a pure `70vw` cap still let the panel take 70% of a narrow window (the conversation was left at its 420px floor with home content clipped mid-card). The cap is now `clamp(320px, calc(100vw - 740px), 900px)` — the panel never exceeds 900px in absolute terms, yields space first as the window narrows (measured 494px at a 1250px window), and only bottoms out at 320px. Verified live at 2560/1984/1234 viewports with zero horizontal overflow.

## 1.0.56 Portable Integration — 2026-09-12

- Fixed the subagent "task manager" panel squeezing the conversation into an unusable sliver: better-sidebar clamps its draggable panel width only to the viewport (`clampWidth` max = `innerWidth`), so a wide drag (or a restored stale width) plus the `autoOpenSubagent` auto-open left the conversation column at min-content (text wrapping one character per line). `theme.css` now clamps the workbench panel to 70vw and gives the conversation column a 420px floor; verified against the live DOM by persisting a 2500px panel width and measuring.
- The plugin market upgraded `@michengai/dsh-codex-ui` to 1.1.2 (local 0.2.x layout gone, package now in `node_modules`). The ≥1.1 sidebar variable mappings were already in place; content-contract tests that pinned the local 0.2.x build now skip there and the retirement-selector contract resolves both layouts.
- Re-pinned the Automation-Workbench adapter to the market-upgraded `@michengai/dsh-automation` 0.1.40 (added `maxConcurrentRuns`, schedule granularity 5→1 min, schedule form redesign): all four anchors (`apply`, runtime line, settings return line, `IconListPenOutline16`) verified unchanged, adapter rebuilt and applied to the installed client.

## 1.0.55 Portable Integration — 2026-09-12

- Removed the redundant in-page close button from the desktop settings window: the window has a native titlebar, so the second X under it was noise (Esc still closes; the frameless About window keeps its in-page close as the only close affordance).
- Same cleanup for the keyboard-shortcuts window, which is also natively framed.
- Changed nothing else; this release exists so the self-serve update loop can be exercised again end-to-end from 1.0.54.

## 1.0.54 Portable Integration — 2026-09-12

- Fixed the sidebar drag affordance that could cover the conversation workspace: the installed conversation UI renamed its width-handle namespace (`data-width-handle` → `data-dcu-width-handle`), so the portable retirement rule no longer matched and the handles resurfaced as full-column-height (32px × 100vh) invisible strips that blocked clicks and, while dragged, resized the input column over the whole workspace. `theme.css` now retires both generations; verified against the live DOM through the debug protocol.
- Removed the redundant sidebar-header "collapse sidebar" button per user decision: collapsing is owned by the double-click on the DSH logo (desktop bridge), and the conversation topbar keeps its "expand sidebar" button as the recovery path. Both zh/en aria labels are covered.
- Added a regression test pinning both retirement selectors against the installed codex-ui locale contract (drift fails the gate instead of silently resurfacing the controls).

## 1.0.53 Portable Integration — 2026-09-11

- Aligned git ancestry with upstream `v1.0.53` via an `merge -s ours` re-baseline, then reviewed the upstream `v1.0.51..v1.0.53` increments group by group.
- Intentionally not ported — bundled runtime/plugin matrix jump (upstream `00515df`): the portable build keeps shipping `@deepseek-ai/dsh` `0.1.2-rc.1` and reaches `0.1.5-rc.2` through its own A/B runtime updater (family-pinned resolution, shadow validation, idle switch with automatic rollback and per-version deployment backoff). The upstream `dsh-bootstrap` `runCli` guard for 0.1.5+ entries was already absorbed earlier. Note: upstream warns that `0.1.5-rc.2` moves sessions to the Session V3 format — new sessions are not readable by old runtimes; the runtime updater's rollback protects the executable slot, so back up important sessions before accepting a runtime update.
- Intentionally not ported — native theme sync fix (upstream `8748b33`): it injects the `theme` service into the desktop bridge to report theme *preference* changes for the native Mica material. The portable shell deliberately does not inject `theme` into the bridge (regression-tested) and derives native theming from the resolved color scheme, so the preference-only Mica-variant bug it fixes cannot occur here. The desktop-pet window fix targets a feature the portable build defers.
- The desktop update source is now genuinely self-serve: `prepare-runtime` bakes `DSH_PORTABLE_RELEASE_SOURCE` into `resources/release-source.json` at packaging time, `<portableRoot>/Data/config/desktop-release-source.json` overrides it per machine, and the packaged updater resolves its release source through both before falling back to the built-in default. CI publishes contract-bearing releases on `v*` tags, so in-app "Check for updates" can download and A/B-deploy new versions without local rebuilds.
- Bumped the desktop version to `1.0.53`.

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
