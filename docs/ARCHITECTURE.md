# Architecture and implementation status

This document describes what the repository implements today, not the complete MVP in the implementation handoff. The status table near the end identifies important gaps; do not assume a feature is complete just because it appears in the product handoff.

## Runtime and processes

- `src/electron/main.js` starts the local HTTP host, opens the desktop window, provides a native directory chooser, and offers a tray menu to reopen the window, toggle OS login autostart, or quit the host.
- `src/electron/preload.js` exposes only the folder chooser and autostart actions to the isolated renderer. The HTTP API has no endpoint for registering a client-supplied path.
- `src/app.js` implements the HTTP service, password authentication, SQLite schema, collection/root operations, recursive scanning, media streaming, decision and audit records, and apply/restore operations.
- `src/ui/` is the shared responsive browser/Electron interface. The Electron renderer uses context isolation, disables Node integration, and enables Chromium's sandbox.
- Node.js 22.13+ is the declared development/runtime requirement. SQLite uses Node's built-in `node:sqlite`; Electron supplies its own Node runtime.
- The HTTP service uses port `43127` by default (`PHOTO_SORTER_PORT` overrides it). It binds loopback and detected private IPv4 addresses, not every interface. LAN traffic is plain HTTP: use a trusted network or an operator-managed HTTPS/VPN proxy, and never expose the service directly to the public internet. The app does not configure firewall rules, TLS, or internet access.

## Data and API

The SQLite database is `photo-sorter.sqlite` in the OS app-data directory; `PHOTO_SORTER_DATA_DIR` overrides that directory. The current schema is created with `CREATE TABLE IF NOT EXISTS`; a versioned migration system is not implemented. Tables hold one account, collections, roots, indexed media, audit events, apply batches, and apply operations. Sessions and pending apply plans live in memory, so restarting the host requires login again and discards any unconfirmed plan.

All data and media API routes except setup status, login/setup/logout, and LAN address discovery require the session cookie. The API currently provides:

| Route | Purpose |
| --- | --- |
| `GET /api/setup-status`, `POST /api/setup`, `POST /api/login`, `POST /api/logout` | First-run account setup and session handling |
| `GET /api/network` | Report detected local IPv4 URLs |
| `GET /api/collections`, `POST /api/collections` | List or create a collection |
| `GET /api/media` | List one category page, with modified-time or filename ordering |
| `GET /api/media/:id/content` | Serve an indexed item, including HTTP byte ranges |
| `PUT /api/media/:id/decision` | Set a decision (`keep`, `delete`, `unsure`) or clear it to unseen |
| `POST /api/rescan` | Manually rescan all roots in a collection |
| `POST /api/apply/plan`, `POST /api/apply/confirm` | Create a move summary, then confirm and run it |
| `POST /api/restore` | Restore completed operations from the latest batch containing a completed move |
| `GET /api/audit` | Read the most recent 200 audit events |

There is no API for root removal/archival, settings, queue state, locks, audit export/clear, or history navigation (undo/redo).

## Scanning and media

Only the host's native folder picker can register a root. A collection may contain multiple roots; exact duplicate roots within that collection return the existing registration. Any parent/child overlap with another active root is rejected, including overlap in the same collection. Symlinks are skipped and root-level `deleted` and `unsure` directories are excluded from scanning. Image/video recognition uses extension allowlists in `src/app.js`.

Scanning is a synchronous recursive pass from the API's perspective: adding a root scans it before returning, and **Rescan roots** runs each root in sequence. Per-file and per-directory read errors are logged and do not stop other paths. A missing/unresolvable root is marked offline and its indexed history is retained. A rescan that finds a changed size or modification time clears that item's decision. A moved or renamed file is treated as a different path; removed files are not reconciled out of the index. Scanning does not start automatically at service startup, watch for changes, or expose live scan progress. Read-only detection is based on the root's permission bits; the API exposes this flag and apply reports skipped items, but the UI does not show read-only status per root.

Media is looked up by indexed ID and checked against the registered root before serving. The API handles browser range requests for videos. Preview rendering and playback use browser/OS codecs; there is no generated thumbnail/poster pipeline, managed preview cache, or guaranteed support for every allowlisted codec.

The interface fetches category pages (60 items by default) and offers previous/next page controls. This is pagination, not a virtualized grid; it has not been performance-tested at the handoff's 200,000-item target.

## Decisions and file operations

Decisions update the database immediately, not the filesystem. The review view supports arrow keys, swipe gestures, explicit buttons, category filters, and video playback. The grid can be ordered by modified time ascending/descending or filename. It does **not** read capture/EXIF dates. Review position and category are not persisted per device, and concurrent edits are not protected by locks.

Apply currently plans `delete` and `unsure` moves. It shows a count and up to five source/destination examples, then requires a separate confirmation. The plan expires after ten minutes. Files are placed in the root's `deleted` or `unsure` folder with their relative subfolder structure preserved. Existing output folders without the app marker require explicit reuse approval. Name collisions receive ` (1)`, ` (2)`, and so on before the extension. Root identity and output paths are checked again before moving.

Moves use a same-filesystem hard link followed by unlink; the app does not copy-and-delete across volumes. Unsupported filesystems, read-only roots, and operation errors are reported, and a batch stops at its first failure. Operation rows are journaled before the move, and startup attempts to reconcile rows left in `planned` state. This is basic recovery, not a complete transaction/reconciliation system. Restore processes completed moves from the latest batch that has a completed operation, refuses occupied originals, and reports conflicts; it does not reconcile new decisions or restore a previous category automatically.

Audit rows record account/collection/root creation, scans and scan errors, decision changes, apply outcomes, recovery, password reset, and restore outcomes. The UI displays at most 200 recent events. There is no audit export, clear action, or automatic app-data backup. Losing/removing app data loses account, decision, operation, and audit history; original media is not removed by uninstall or data loss.

## Current scope by handoff area

| Area | Current status |
| --- | --- |
| Desktop + LAN access, local warning, host-only folder picker | Implemented; LAN uses plain HTTP and reports IPv4 addresses (no QR code). |
| Account/password | First-run host-local setup, salted scrypt hash, login/logout, restart reauthentication, and in-memory per-IP throttling are implemented. Passkeys/biometrics are deferred. |
| Collections and roots | Create and switch collections in the selector, add roots, enforce overlap, and retain history for missing roots. Last-used collection restoration, root removal, archival/re-add lifecycle, and root-management settings are not implemented. |
| Scanning | Extension-filtered recursive manual scan, symlink/output exclusion, per-path error logging, offline flag, and size/mtime decision reset are implemented. Watchers, startup catch-up, bounded asynchronous indexing, removal reconciliation, and progress reporting are absent. Read-only status is returned by the API and summarized during apply; it is not shown per root in the UI. |
| Sorting/review | Keep/delete/unsure/unseen decisions, category filters, modified-time/filename ordering, basic paging, keyboard/swipe/buttons, and on-demand video playback are implemented. Capture-date sorting, virtualized 200k navigation, per-device queue persistence, locks, undo/redo, zoom/pan, and dynamic multi-device synchronization behavior are absent. |
| Previews | Browser-native rendering and range-based video serving are implemented. Generated thumbnails/posters and configurable LRU cache are absent. |
| Apply/restore | Two-step confirmation, output-folder consent, relative paths, collision numbering, no-overwrite moves, first-failure stop, journal rows, and latest completed-batch restore are implemented. Full keep/category reconciliation, comprehensive interrupted-batch handling, and a broader apply review/count by category remain incomplete. |
| Audit/help | Basic persistent audit browsing and in-app quick help are implemented. Export, explicit clear, complete audit coverage, and an uninstall data warning are absent. |
| Packaging and tests | Per-OS build commands and Ubuntu/Windows/macOS CI build/test jobs are configured. Automated tests exercise the HTTP/domain workflow on the current runner; they do not automate a real Electron UI, phone connection, or native picker across operating systems. |
| Deferred by product decision | PWA/passkeys, German localization, theme/grid-density controls, cloud access, and automatic backups are not part of the MVP. |

## Validation commands

- `npm test` runs all Node test suites.
- `npm run test:unit` and `npm run test:e2e` run the unit and HTTP workflow suites separately. The `e2e` suite name refers to API workflow tests; it does not launch Electron or a phone browser.
- `npm run build` creates an unpacked package for the current OS.
- `npm run dist:win`, `npm run dist:mac`, and `npm run dist:linux` request the corresponding NSIS, DMG, and AppImage packages.
