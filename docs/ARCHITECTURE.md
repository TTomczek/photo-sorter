# Architecture and implementation status

This document describes what the repository implements today, not the complete MVP in the implementation handoff. The status table near the end identifies important gaps; do not assume a feature is complete just because it appears in the product handoff.

## Runtime and processes

- `src/electron/main.js` starts the local HTTP host, opens the desktop window, provides a native directory chooser, and offers a tray menu to reopen the window, toggle OS login autostart, or quit the host.
- `src/electron/preload.js` exposes only the folder chooser and autostart controls to the isolated renderer. The HTTP API has no endpoint for registering a client-supplied path.
- `src/app.js` implements the HTTP service, password authentication, SQLite schema, collection/root operations, recursive scanning, media streaming, decision and audit records, and apply/restore operations.
- `src/ui/` is the shared responsive browser/Electron interface. The Electron renderer uses context isolation, disables Node integration, and enables Chromium's sandbox.
- Node.js 22.13+ is the declared development/runtime requirement. SQLite uses Node's built-in `node:sqlite`; Electron supplies its own Node runtime.
- The HTTP service uses port `43127` by default (`PHOTO_SORTER_PORT` overrides it). It binds loopback and detected private IPv4 addresses, not every interface. LAN traffic is plain HTTP: use a trusted network or an operator-managed HTTPS/VPN proxy, and never expose the service directly to the public internet. The app does not configure firewall rules, TLS, or internet access.

## Data and API

The SQLite database is `photo-sorter.sqlite` in the OS app-data directory; `PHOTO_SORTER_DATA_DIR` overrides that directory. The current schema is created with `CREATE TABLE IF NOT EXISTS` plus additive column checks; a versioned migration system is not implemented. Tables hold one account, collections, roots, indexed media and presence, per-device review state, expiring media locks, decision history, scan progress, app settings, preview-cache metadata, audit events, apply batches, and apply operations. Sessions and pending apply plans live in memory, so restarting the host requires login again and discards any unconfirmed plan. Login issues a random, persistent HttpOnly device cookie; it identifies local review state but does not keep an authentication session alive across restart.

All data and media API routes except setup status, login/setup/logout, and LAN address discovery require the session cookie. Login also issues a long-lived, HttpOnly device identifier used only for per-device review state and edit locks; the authentication session itself still expires on host restart. The API currently provides:

| Route | Purpose |
| --- | --- |
| `GET /api/setup-status`, `POST /api/setup`, `POST /api/login`, `POST /api/logout` | First-run account setup and session handling |
| `GET /api/network` | Report detected local IPv4 URLs |
| `GET /api/settings`, `PUT /api/settings` | Read or update the default sort and preview-cache limit |
| `GET /api/collections`, `POST /api/collections` | List or create an active collection |
| `GET /api/collections/archived`, `POST /api/collections/:id/archive`, `POST /api/collections/:id/restore` | Archive or restore a collection while retaining its history |
| `GET /api/collections/:id/roots`, `DELETE /api/collections/:id/roots/:rootId` | List or remove a registered root; re-adding its path restores its retained index |
| `GET /api/preferences`, `PUT /api/preferences` | Read or save this device's last-used collection |
| `GET /api/device-state`, `PUT /api/device-state` | Restore or save a device's collection, category, sort order, current item, and page |
| `GET /api/media` | List one category page, ordered by capture date with modified-time and filename fallback, descending capture date, or filename |
| `GET /api/scans?collectionId=...` | Read persistent per-root scan progress and errors |
| `POST /api/rescan` | Queue bounded background scans for a collection |
| `GET /api/media/:id/content` | Serve an indexed item, including HTTP byte ranges |
| `GET /api/media/:id/preview` | Serve an embedded image thumbnail when available |
| `POST` / `DELETE /api/media/:id/lock` | Acquire/renew a 60-second item lock or release it |
| `PUT /api/media/:id/decision` | Set a decision (`keep`, `delete`, `unsure`) or clear it to unseen while holding the item lock |
| `POST /api/decisions/undo`, `POST /api/decisions/redo` | Undo or redo this device's latest decision, unless it has since changed elsewhere |
| `POST /api/apply/plan`, `POST /api/apply/confirm` | Create a move summary, then confirm and run it |
| `POST /api/restore` | Restore completed operations from the latest batch containing a completed move |
| `GET /api/audit` | Read the most recent 200 audit events |
| `GET /api/audit/export`, `DELETE /api/audit` | Export all audit events as JSON or clear them explicitly |

The preview-cache limit defaults to 2,048 MB; setting it to zero disables caching and removes cached previews. Changing the limit evicts least-recently-used entries until the stored cache is within the configured limit.

## Scanning and media

Only the host's native folder picker can register a root. A collection may contain multiple roots; exact duplicate roots within that collection return the existing registration. Any parent/child overlap with another active root is rejected, including overlap in the same collection. Removing a root hides its items but retains its history; registering that same path again in the same collection reactivates its existing index. Archiving a collection retains all its roots, items, decisions, and audit history while releasing its paths for use in other active collections. Restoring an archived collection rejects roots that now overlap another active collection. Symlinks are skipped and root-level `deleted` and `unsure` directories are excluded from scanning. Image/video recognition uses extension allowlists in `src/app.js`.

The desktop folder picker registers a root and returns while its scan continues in the background; **Rescan roots** also queues background work. At most two roots are scanned concurrently, and the scanner yields periodically while indexing so the UI/API can serve already indexed items. Per-root progress/errors persist in SQLite and are exposed to the UI. Active roots are scanned for catch-up when the host starts. Per-file and per-directory read errors are logged and do not stop other paths; a partial scan does not reconcile absent files. A missing/unresolvable root is marked offline and its indexed history is retained. A rescan that finds a changed size or modification time clears that item's decision and updates its capture metadata. JPEG, TIFF, HEIC, and PNG EXIF capture dates are read when available; other files and images without EXIF use modified time. A moved or renamed file is a new path. Recursive filesystem watchers debounce change events into scans; after a complete error-free scan, no-longer-present files are hidden from active queues but their index and decisions are retained. Watchers are not currently retried if the OS rejects recursive watch setup. Read-only detection is based on the root's permission bits; read-only status is shown in folder management, and apply reports skipped items.

Media is looked up by indexed ID and checked against the registered root before serving. The API handles browser range requests for videos. Preview rendering and playback use browser/OS codecs; there is no generated thumbnail/poster pipeline, managed preview cache, or guaranteed support for every allowlisted codec.

The interface fetches category pages (60 items by default) and offers previous/next page controls. This is pagination, not a virtualized grid; it has not been performance-tested at the handoff's 200,000-item target. The configured default sort applies when a device/collection has no saved review state; subsequent sort choices remain device/collection-specific.

## Decisions and file operations

Decisions update the database immediately, not the filesystem. The review view supports arrow keys, swipe gestures, explicit buttons, category filters, and video playback. Sorting offers capture date ascending/descending with modified time and filename fallback, or filename. Category, sort order, current item, and page are persisted per device and collection. The current item's 60-second lock is renewed every 20 seconds while the page is visible; another device cannot change a locked item's decision. Undo/redo applies to the signed-in device's decision history, obtains the item lock, and refuses to overwrite a newer decision from another device. This does not yet provide live queue refresh or synchronously notify other clients.

Apply plans new `delete`/`unsure` moves, category-to-category moves for files already applied, and restores of files whose decisions changed to `keep` or unseen. It shows operation counts and up to five source/destination examples, then requires separate confirmation. The plan expires after ten minutes. Files are placed in the root's `deleted` or `unsure` folder with their original relative subfolder structure preserved. Existing output folders without the app marker require explicit reuse approval. Name collisions receive ` (1)`, ` (2)`, and so on before the extension; restore operations refuse occupied original paths. Root identity and output paths are checked again before moving.

Moves use a same-filesystem hard link followed by unlink; the app does not copy-and-delete across volumes. Unsupported filesystems, read-only roots, and operation errors are reported, and a batch stops at its first failure. Operation rows are journaled before the move, and startup attempts to reconcile rows left in `planned` state. Restore processes completed operations from the latest batch with a completed operation, refuses occupied originals, and reports conflicts. New decisions after apply remain staged until the next double-confirmed apply; they can then recategorize moved files or restore changed-to-keep/unseen files. This remains basic recovery, not a fully transactional journal/reconciliation system.

Audit rows record account/collection/root lifecycle, scans and scan errors, decision changes and history navigation, apply outcomes, recovery, password reset, and restore outcomes. The UI displays at most 200 recent events; export downloads the full audit history as JSON. Explicit clear removes existing rows while recording an `audit_cleared` event with the number removed. There is no automatic app-data backup. Losing/removing app data loses account, decision, operation, and audit history; original media is not removed by uninstall or data loss.

## Current scope by handoff area

| Area | Current status |
| --- | --- |
| Desktop + LAN access, local warning, host-only folder picker | Implemented; LAN uses plain HTTP and displays local QR codes for detected private IPv4 addresses. |
| Account/password | First-run host-local setup, salted scrypt hash, login/logout, restart reauthentication, and in-memory per-IP throttling are implemented. Passkeys/biometrics are deferred. |
| Collections and roots | Create/switch collections, remember the last-used collection per device, add/remove roots while retaining their index, archive/restore collections, and enforce active-root overlap. Root registration remains host-picker-only. Broader root-management settings are not implemented. |
| Scanning | Extension-filtered recursive scans, symlink/output exclusion, per-path errors, offline retention, changed-file decision reset, EXIF capture-date extraction, per-root progress, startup catch-up, two-root bounded background scanning, recursive watchers, and absent-file hiding after complete scans are implemented. Partial scans retain prior presence state; watcher fallback/retry and progress for individual path errors remain limited. |
| Sorting/review | Keep/delete/unsure/unseen decisions, category filters, capture-date sorting with modified-time fallback, filename ordering, basic paging, keyboard/swipe/buttons, on-demand video playback, per-device queue state, expiring item locks, and decision undo/redo are implemented. Virtualized 200k navigation, zoom/pan, and live queue refresh across devices are absent. |
| Previews | Image grids use embedded EXIF thumbnails when available and fall back to the original image. These thumbnails are stored in an app-managed LRU cache (default 2,048 MB, configurable in Settings). There is no generated thumbnail pipeline or video poster cache; videos use browser-native playback. |
| Apply/restore | Two-step confirmation, output-folder consent, relative paths, collision numbering, no-overwrite moves, first-failure stop, journal rows, latest completed-batch restore, and staged keep/delete/unsure/unseen reconciliation are implemented. Comprehensive interrupted-batch handling remains incomplete. |
| Audit/help/settings | Persistent audit browsing, full JSON export, explicit clear with a retained clear event, app default-sort/cache settings, desktop sign-in autostart, and in-app quick help are implemented. Audit coverage is not yet complete for every scan lifecycle, and there is no uninstall data warning. |
| Packaging and tests | Per-OS package commands are available. CI runs lint, tests, and unpacked application builds on Ubuntu/Windows/macOS, then uploads each platform's build artifact. Automated tests exercise the HTTP/domain workflow; they do not automate a real Electron UI, phone connection, or native picker across operating systems. |
| Deferred by product decision | PWA/passkeys, German localization, theme/grid-density controls, cloud access, and automatic backups are not part of the MVP. |

## Validation commands

- `npm test` runs all Node test suites.
- `npm run lint` runs ESLint.
- `npm run test:unit` and `npm run test:e2e` run the unit and HTTP workflow suites separately. The `e2e` suite name refers to API workflow tests; it does not launch Electron or a phone browser.
- `npm run build` creates an unpacked package for the current OS.
- `npm run dist:win`, `npm run dist:mac`, and `npm run dist:linux` request the corresponding NSIS, DMG, and AppImage packages.
- GitHub Actions runs lint, tests, and `npm run build` on all three desktop OSes for pushes and pull requests; successful jobs upload the unpacked application as artifacts.
