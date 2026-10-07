# Architecture and implementation status

This document describes what the repository implements today, not the complete MVP in the implementation handoff. The status table near the end identifies important gaps; do not assume a feature is complete just because it appears in the product handoff.

## Runtime and processes

- `src/electron/main.js` starts the local HTTP host, opens the desktop window, provides a native directory chooser, and offers a tray menu to reopen the window, toggle OS login autostart, or quit the host.
- `src/electron/preload.js` exposes only the folder chooser and autostart controls to the isolated renderer. The HTTP API has no endpoint for registering a client-supplied path.
- `src/app.js` implements the HTTP service, password and passkey authentication, SQLite schema, collection/root operations, recursive scanning, media streaming, queue events, generated-preview caching, decision/audit records, and apply/restore operations.
- `src/ui/` is the shared responsive browser/Electron interface. The Electron renderer uses context isolation, disables Node integration, and enables Chromium's sandbox.
- Node.js 22.13+ is the declared development/runtime requirement. SQLite uses Node's built-in `node:sqlite`; Electron supplies its own Node runtime.
- The HTTP service uses port `43127` by default (`PHOTO_SORTER_PORT` overrides it). It binds loopback and detected private IPv4 addresses, not every interface. LAN traffic is plain HTTP: use a trusted network or an operator-managed HTTPS/VPN proxy, and never expose the service directly to the public internet. The app does not configure firewall rules, TLS, or internet access.

## Data and API

The SQLite database is `photo-sorter.sqlite` in the OS app-data directory; `PHOTO_SORTER_DATA_DIR` overrides that directory. The current schema is created with `CREATE TABLE IF NOT EXISTS` plus additive column checks; a versioned migration system is not implemented. Tables hold one account, collections, roots, indexed media and presence, per-device review state, expiring media locks, decision history, passkey public credentials, scan progress, app settings, preview-cache metadata, audit events, apply batches, and apply operations. Sessions, passkey challenges, and pending apply plans live in memory, so restarting the host requires login again and discards any unconfirmed plan. Login issues a random, persistent HttpOnly device cookie; it identifies local review state but does not keep an authentication session alive across restart. Sessions from the configured HTTPS origin receive `Secure` cookies.

All data and media API routes except setup status, login/setup/logout, and LAN address discovery require the session cookie. Login also issues a long-lived, HttpOnly device identifier used only for per-device review state and edit locks; the authentication session itself still expires on host restart. The API currently provides:

| Route | Purpose |
| --- | --- |
| `GET /api/setup-status`, `POST /api/setup`, `POST /api/login`, `POST /api/logout` | First-run account setup and session handling |
| `GET /api/passkeys/status`, `POST /api/passkeys/authentication/options`, `POST /api/passkeys/authentication/verify` | Passkey availability and authentication; passkeys require the configured secure origin |
| `GET /api/passkeys`, `POST /api/passkeys/registration/options`, `POST /api/passkeys/registration/verify`, `DELETE /api/passkeys/:id` | Authenticated passkey management |
| `GET /api/network` | Report detected local IPv4 URLs |
| `GET /api/events` | Authenticated server-sent queue updates with logout notification |
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
| `GET /api/media/:id/preview`, `POST /api/media/:id/preview` | Read cached JPEG thumbnails/posters or upload a generated preview bound to the indexed file size and modification time |
| `POST` / `DELETE /api/media/:id/lock` | Acquire/renew a 60-second item lock or release it |
| `PUT /api/media/:id/decision` | Set a decision (`keep`, `delete`, `unsure`) or clear it to unseen while holding the item lock |
| `POST /api/decisions/undo`, `POST /api/decisions/redo` | Undo or redo this device's latest decision, unless it has since changed elsewhere |
| `POST /api/apply/plan`, `POST /api/apply/confirm` | Create a move summary, then confirm and run it |
| `POST /api/restore` | Restore completed operations from the latest batch containing a completed move |
| `GET /api/audit` | Read the most recent 200 audit events |
| `GET /api/audit/export`, `DELETE /api/audit` | Export all audit events as JSON or clear them explicitly |

The preview-cache limit defaults to 2,048 MB; setting it to zero disables caching and removes cached previews. Changing the limit evicts least-recently-used entries until the stored cache is within the configured limit. Passkeys are disabled unless `PHOTO_SORTER_WEBAUTHN_ORIGIN` and `PHOTO_SORTER_WEBAUTHN_RP_ID` configure the exact HTTPS origin and relying-party domain; loopback `http://localhost` is permitted for local development. The HTTPS reverse proxy remains operator-managed.

## Scanning and media

Only the host's native folder picker can register a root. A collection may contain multiple roots; exact duplicate roots within that collection return the existing registration. Any parent/child overlap with another active root is rejected, including overlap in the same collection. Removing a root hides its items but retains its history; registering that same path again in the same collection reactivates its existing index. Archiving a collection retains all its roots, items, decisions, and audit history while releasing its paths for use in other active collections. Restoring an archived collection rejects roots that now overlap another active collection. Symlinks are skipped and root-level `deleted` and `unsure` directories are excluded from scanning. Image/video recognition uses extension allowlists in `src/app.js`.

The desktop folder picker registers a root and returns while its scan continues in the background; **Rescan roots** also queues background work. At most two roots are scanned concurrently, and the scanner yields periodically while indexing so the UI/API can serve already indexed items. Per-root progress/errors persist in SQLite and are exposed to the UI. Active roots are scanned for catch-up when the host starts. Per-file and per-directory read errors are logged and do not stop other paths; a partial scan does not reconcile absent files. A missing/unresolvable root is marked offline and its indexed history is retained. A rescan that finds a changed size or modification time clears that item's decision and updates its capture metadata. JPEG, TIFF, HEIC, and PNG EXIF capture dates are read when available; other files and images without EXIF use modified time. A moved or renamed file is a new path. Recursive filesystem watchers debounce change events into scans; after a complete error-free scan, no-longer-present files are hidden from active queues but their index and decisions are retained. Watcher setup/runtime failures retry with exponential backoff capped at 60 seconds; recursive watching has no per-directory fallback on platforms where it is unavailable. Read-only detection is based on the root's permission bits; read-only status is shown in folder management, and apply reports skipped items.

Media is looked up by indexed ID and checked against the registered root before serving. The API handles browser range requests for videos. The grid first uses embedded image thumbnails; when none exists, the browser lazily generates a resized JPEG for visible image cards. Visible videos generate first-frame JPEG posters when browser/OS codecs permit. Authenticated uploads are limited to 8 MB, checked against the indexed file version, and stored only as derived data in the managed LRU cache. Eviction never affects originals; unsupported media remains sortable and shows a placeholder.

The interface virtualizes the scrollable category grid over bounded 60-item API pages, keeping the DOM and browser-side item list bounded while scrolling large collections. SQLite indexes support per-root category counts and filename, modified-time, and capture-time ordering. A regression fixture inserts 200,000 records and verifies a 60-item page near the end; this verifies bounded pagination, not real-world rendering performance across devices or the full browser UI. The configured default sort applies when a device/collection has no saved review state; subsequent sort choices remain device/collection-specific.

## Decisions and file operations

Decisions update the database immediately, not the filesystem. The review view supports arrow keys, swipe gestures, explicit buttons, category filters, video playback, and image zoom/pan by controls, pinch, and drag. Sorting offers capture date ascending/descending with modified time and filename fallback, or filename. Category, sort order, current item, and page are persisted per device and collection. The current item's 60-second lock is renewed every 20 seconds while the page is visible; another device cannot change a locked item's decision. Undo/redo applies to the signed-in device's decision history, obtains the item lock, and refuses to overwrite a newer decision from another device. Authenticated server-sent events push decision and scan queue changes to connected devices; a five-second page refresh remains as a reconnect fallback.

Apply plans new `delete`/`unsure` moves, category-to-category moves for files already applied, and restores of files whose decisions changed to `keep` or unseen. It shows operation counts and up to five source/destination examples, then requires separate confirmation. The plan expires after ten minutes. Files are placed in the root's `deleted` or `unsure` folder with their original relative subfolder structure preserved. Existing output folders without the app marker require explicit reuse approval. Name collisions receive ` (1)`, ` (2)`, and so on before the extension; restore operations refuse occupied original paths. Root identity and output paths are checked again before moving.

Moves use a same-filesystem hard link followed by unlink; the app does not copy-and-delete across volumes. Unsupported filesystems, read-only roots, and operation errors are reported, and apply stops at its first failure; the result lists successful, failed, and not-attempted files. Each move is journaled before the filesystem action. If the source is gone and the destination exists after a restart, recovery completes the journal and updates the indexed path. If both paths exist, recovery preserves both and marks the operation failed because it cannot safely prove which link was created by the interrupted operation; it never cleans up an ambiguous path. Restore actions have their own pre-action journal rows linked to the move they reverse, so a restart can finish the database updates when the filesystem restore completed first. Recovery validates registered-root boundaries and regular files before reconciling. Restore processes only successful moves from the latest batch, refuses occupied originals without overwriting, and reports conflicts. New decisions after apply remain staged until the next double-confirmed apply; they can then recategorize moved files or restore changed-to-keep/unseen files. Recovery is conservative: ambiguous filesystem states are preserved and reported as failures rather than guessed or automatically rolled back.

Audit rows record account/collection/root lifecycle, scan starts/completions/errors, decision changes and history navigation, passkey changes, apply outcomes, recovery, password reset, and restore outcomes. The UI displays at most 200 recent events; export downloads the full audit history as JSON. Explicit clear removes existing rows while recording an `audit_cleared` event with the number removed. There is no automatic app-data backup. Uninstallers preserve app data; manually removing it loses account, decision, operation, and audit history, but original media is never removed by uninstall or data loss.

The PWA manifest and service worker are available only in secure contexts (HTTPS, with loopback exceptions). The service worker caches the static application shell only; API responses and originals are never cached. Language, system/light/dark theme, and automatic or 2–6-column grid density are stored per browser in local storage.

## Current scope by handoff area

| Area | Current status |
| --- | --- |
| Desktop + LAN access, local warning, host-only folder picker | Implemented; LAN uses plain HTTP and displays local QR codes for detected private IPv4 addresses. |
| Account/password/passkeys | First-run host-local setup, salted scrypt hash, login/logout, restart reauthentication, in-memory per-IP throttling, and WebAuthn passkey registration/login with exact configured-origin verification are implemented. Passkeys require operator-managed HTTPS (or local `localhost`) and passwords remain as fallback. |
| Collections and roots | Create/switch collections, remember the last-used collection per device, add/remove roots while retaining their index, archive/restore collections, and enforce active-root overlap. Root registration remains host-picker-only. Broader root-management settings are not implemented. |
| Scanning | Extension-filtered recursive scans, symlink/output exclusion, per-path errors, offline retention, changed-file decision reset, EXIF capture-date extraction, per-root progress, startup catch-up, two-root bounded background scanning, recursive watchers, and absent-file hiding after complete scans are implemented. Partial scans retain prior presence state; watcher fallback/retry and progress for individual path errors remain limited. |
| Sorting/review | Keep/delete/unsure/unseen decisions, category filters, capture-date sorting with modified-time fallback, filename ordering, virtualized scrolling over bounded pages, keyboard/swipe/buttons, zoom/pan, on-demand video playback, per-device queue state, expiring item locks, decision undo/redo, and server-sent cross-device queue updates are implemented. A 200,000-row fixture verifies bounded API paging; real-browser rendering/gesture performance remains to be smoke-tested. |
| Previews | Embedded EXIF thumbnails are preferred. Visible image cards without an embedded preview lazily generate resized JPEGs; visible videos generate first-frame JPEG posters where codecs permit. Authenticated, file-version-bound uploads use a configurable 2,048 MB LRU cache; originals are never modified. |
| Apply/restore | Two-step confirmation, output-folder consent, relative paths, collision numbering, no-overwrite moves, first-failure stop with per-operation outcomes, pre-action move/restore journal rows, conservative restart reconciliation, latest completed-batch restore, and staged keep/delete/unsure/unseen reconciliation are implemented. Ambiguous states preserve both paths and are reported for manual resolution. |
| Audit/help/settings | Persistent audit browsing/export/clear, scan lifecycle events, passkey audit entries, default-sort/cache settings, per-browser light/dark/system theme and grid density, English/German UI, desktop autostart, and in-app help are implemented. Uninstall preserves app data; help/docs warn that manually deleting it loses history. |
| PWA/passkeys | The PWA manifest and offline static shell are secure-context gated; passkeys are backed by WebAuthn and require an explicit origin/RP domain configuration. The service worker does not cache API or media responses. |
| Packaging and tests | CI runs unit, HTTP workflow, and Playwright Chromium browser tests, lint, unpacked builds, and native NSIS/DMG/AppImage packages on Windows/macOS/Linux. Browser tests exercise the real HTTP service and responsive web UI with generated PNGs, and use Chromium's virtual WebAuthn authenticator. They do not launch the Electron shell or native folder picker. |
| Still excluded by product decision | Cloud access/sync and automatic backups remain excluded. |

## Validation commands

- `npm test` runs unit, HTTP workflow, and Playwright Chromium browser suites.
- `npm run lint` runs ESLint.
- `npm run test:unit`, `npm run test:e2e`, and `npm run test:browser` run the unit, HTTP workflow, and browser suites separately. HTTP workflow tests exercise the API; Playwright tests launch Chromium against the real local server.
- `npm run build` creates an unpacked package for the current OS.
- `npm run dist:win`, `npm run dist:mac`, and `npm run dist:linux` request the corresponding NSIS, DMG, and AppImage packages.
- GitHub Actions runs lint, unit/HTTP/Playwright tests, `npm run build`, and the NSIS/DMG/AppImage package on Windows, macOS, and Linux for pushes and pull requests. The workflow summary reports each test suite, and platform packages are retained as workflow artifacts.
- Successful pushes to `main` publish a prerelease with all platform packages under a unique `main-<commit-sha>` tag. Enable the repository's **Settings > General > Releases > Immutable releases** option for GitHub to lock each published release and its assets.
