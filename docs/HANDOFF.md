# Photo Sorter - Implementation Handoff

## Purpose

Implement the agreed local-first photo/video sorting application in this repository. This handoff records the product decisions from the design interview and the implementation sequence. Treat the decisions below as authoritative; do not reopen them unless implementation reveals a real contradiction.

## Workspace instructions

Implement the application from scratch using this handoff as the product source of truth. Choose and create the project structure, dependencies, and tests to suit the agreed Node.js/Electron approach. Preserve unrelated user changes and do not commit unless separately asked.

## Product decisions: question-and-answer ledger

### Hosting, platform, and security

| # | Question | Decision |
|---|---|---|
| 1 | Where does the app run relative to the photos? | Self-host on the computer holding the photos; desktop and phone connect over the same local network. |
| 2 | Single user or multiple users? | One user/account. |
| 3 | Local network or internet access? | Local network only; no public/internet access requirement. |
| 4 | Which host operating systems? | Windows, macOS, and Linux desktops. |
| 5 | One universal installer or per-OS packages? | Use a cross-platform technology and one codebase; produce a separate native installer/package for each OS. One identical native installer artifact is not expected. |
| 6 | Preferred stack? | Node.js with Electron, shared responsive web UI, and native desktop folder picker. |
| 7 | Authentication method? | Require a password of at least 12 characters with uppercase and lowercase letters, a number, and a special character; biometric/passkey login was acceptable where supported, but is deferred from the MVP. |
| 8 | Forgotten-password recovery? | Host-only reset command; no email service. |
| 9 | Internet/cloud dependency? | Fully local. Normal operation must not need an internet connection, cloud account, or cloud sync. |
| 10 | HTTPS ownership? | HTTPS is handled by the user's reverse proxy/VPN, not by the app in the MVP. |
| 11 | Is LAN HTTP allowed? | Yes, with a prominent warning that credentials and media are not encrypted in transit. Do not expose the service directly to the public internet. HTTPS/VPN is optional but recommended on untrusted networks. |
| 12 | How long should a login last? | Keep the current host session across page reloads, but require authentication again after the host service or browser session restarts. |
| 13 | How are scan roots chosen from a phone? | Only the host desktop app can invoke the native folder picker. Phone users can select and use existing collections, not enter arbitrary host paths. |
| 14 | How does a phone connect? | Show local address(es) and a scannable QR code in the host UI. |
| 15 | Should the host keep serving after the desktop window closes? | Yes. Offer a background service/autostart option and an explicit quit/stop control. |
| 16 | Browser site or phone app? | Responsive website; optional PWA was desired, but deferred. PWA/passkeys require HTTPS configuration. |
| 17 | What happens on uninstall? | Remove app data only after a clear warning. Original photo/video files must never be removed by uninstall. |

### Collections and scanning

| # | Question | Decision |
|---|---|---|
| 18 | One collection or several? | Multiple named collections, each with its own roots and decisions. |
| 19 | How should startup behave with multiple collections? | Reopen the last-used collection automatically and provide a collection switcher. |
| 20 | How are several selected folders grouped? | One combined collection with a shared grid and queue. |
| 21 | What happens when a root is removed? | Stop displaying its items in the active collection but retain its indexed history/decisions for re-addition. |
| 22 | May active collections share roots? | No. Reject any overlapping directory trees across active collections, including parent/child overlap. |
| 23 | What about overlapping roots inside one collection? | Canonicalize/deduplicate; each file path appears once. |
| 24 | Should scans follow symlinks/junctions? | No by default. Do not follow symbolic links. |
| 25 | How should offline roots behave? | Retain their indexed items and decisions, mark the root/items offline, and show them again when available. |
| 26 | How should readable but read-only roots behave? | Allow scanning and sorting; report that file moves are unavailable for that root. |
| 27 | What if a scan cannot read one folder/file? | Continue scanning other paths, log/report the failures, and preserve existing decisions. |
| 28 | How are new/changed files discovered? | Watch roots continuously, provide manual rescan, and run a catch-up scan when the host service starts after being stopped. |
| 29 | Can sorting begin before a full scan completes? | Yes. Start as soon as items are indexed; continue indexing/previews in the background. |
| 30 | What happens to files discovered during an active queue? | Append new unseen items without interrupting the photo currently being reviewed. |
| 31 | How are files identified across external changes? | Path-based for speed. External move/rename is a new unseen item. |
| 32 | What if content at the same path changes? | If size or modified time changes, reset its decision to unseen and regenerate/update its preview. |

### Sorting, review, and interface

| # | Question | Decision |
|---|---|---|
| 33 | How should sorting order work? | Let users choose capture date ascending/descending or filename; default to capture date ascending. If capture date is unavailable, fall back to modified time, then filename. |
| 34 | What should reopening do? | Resume the saved mode/current queue position on that device. Queue positions are per-device; a new device with no position starts at the first currently unseen item. |
| 35 | Can devices be used simultaneously? | Yes. Decisions synchronize immediately, while each device retains its own queue position. |
| 36 | What if two devices open the same photo? | Prevent simultaneous edits with an item lock. Expire the lock automatically after a short idle timeout. |
| 37 | What happens when a review decision changes category? | Remove the photo from the current category queue immediately and advance. In the combined review queue, keep/delete removes it; unsure remains pending and moves to the end of the unsure pass. |
| 38 | Can a decision be cleared? | Yes, provide a clear-to-unseen action. |
| 39 | What controls categorize a photo? | Left arrow/swipe = delete; right arrow/swipe = keep; down arrow/swipe = unsure. Also show explicit action buttons on phones. |
| 40 | Undo/redo? | Provide undo; redo too if practical. |
| 41 | Should photos zoom? | Yes, support zoom and pan on desktop and phone. |
| 42 | Grid navigation for large libraries? | Virtualized scrolling and category filters only. No filename/date/folder search in the agreed MVP. |
| 43 | Grid appearance settings? | Adjustable thumbnail size/columns and light/dark/system theme were desired, but cosmetic settings are deferred from the MVP. |
| 44 | Interface language? | English and German were initially desired, but German is deferred from the MVP; first MVP is English. |
| 45 | Help? | Include a built-in help/quick guide with clear instructions for keys, swipes, categories, review, apply/restore, and LAN security. |

### Media and performance

| # | Question | Decision |
|---|---|---|
| 46 | Include video? | Yes. Categorize photos and videos together; play videos on demand in the sorting view. |
| 47 | Decoder strategy? | Prefer OS/browser-provided codecs to keep packages smaller. If a recognized file cannot be previewed, show a clear placeholder but still allow decisions and safe moves. |
| 48 | Preview cache? | Automatically managed LRU cache with configurable size; initial limit is 2 GB. |
| 49 | Large collection target? | Support 200,000 items with progressive indexing and virtualized navigation. |

### Applying decisions, recovery, and audit

| # | Question | Decision |
|---|---|---|
| 50 | Where do categorized files go? | Create `deleted` and `unsure` as child folders inside each selected root. This supersedes the earlier ambiguity about placing them beside a root. |
| 51 | Preserve subfolders or flatten? | Preserve the source-relative subfolder structure beneath the category folder. |
| 52 | How to resolve filename conflicts? | Append ` (1)`, ` (2)`, etc. before the extension. Never overwrite. |
| 53 | What if a `deleted`/`unsure` folder already exists and is not app-owned? | Stop and ask the user whether to reuse it; never merge silently. |
| 54 | Should output folders be rescanned? | Always exclude the app's root-level `deleted` and `unsure` output folders from future recursive scans. |
| 55 | How is apply confirmed? | Show one review summary, then require a second explicit confirmation for the planned file operations. |
| 56 | What if a move fails? | Stop at the first failure and report exactly which files moved and which did not. |
| 57 | What about cross-volume moves? | Refuse and report them; do not attempt copy-and-delete. |
| 58 | Restore/undo after moving files? | Provide restore for the most recent apply batch as a unit; never overwrite an occupied original path and report conflicts. |
| 59 | What if a decision changes after apply? | Stage the new decision until the next double-confirmed apply; do not move immediately. |
| 60 | If a moved file becomes `keep`, what happens at next apply? | Restore it to its original path as part of reconciling current decisions. |
| 61 | Does the app ever permanently delete photos/videos? | Never. Delete-category items are moved to `deleted`; no permanent deletion operation. |
| 62 | Where/how are audit logs kept? | Persistent app-managed log, viewable in-app and exportable. |
| 63 | What goes in the audit log? | Scan events, every decision change, each file operation/result, timestamps, and paths. |
| 64 | How long are logs retained? | Indefinitely until explicitly cleared by the user. |
| 65 | Automatic database backup? | No automatic backup is needed/desired. |

### Delivery sequencing

| # | Question | Decision |
|---|---|---|
| 66 | One complete release or staged work? | Build a complete end-to-end MVP first, then add advanced features in follow-up iterations. |
| 67 | MVP boundary? | Include desktop + phone LAN access, authentication, collections, scanning/sorting/review, safe apply/restore, audit log, video support/playback, and help. Defer PWA/passkeys, cosmetic appearance controls, and German localization. |

### Confirmed UI redesign (2026-10-09)

- With an active collection and pending items, open directly to a photo-first review workspace containing unseen items followed by unsure items. Preserve the full photo with `contain`; show filename/date only in an on-demand info overlay.
- Keep the queue bounded and paginated. Each unsure action moves that item behind other pending items; if it is marked unsure again, move it to the end of the unsure pass. Repeat unsure passes automatically until all items are resolved, while keeping Pause review available.
- Pausing review or completing the queue opens Browse. Browse starts at All and remembers its last category filter on that device. Review retains swipe and arrow-key mappings plus compact explicit phone buttons, zoom, and pan.
- Keep a pinned, narrow, collapsible side sheet visible by default on large screens. On phone-sized screens keep it closed behind a burger button and open it as an overlay drawer. Give Review, Collections, Browse, Apply/restore, History, Help, and Settings equal navigation prominence within that sheet.
- Persist server-backed settings immediately when their controls change; do not require a separate save action.
- Allow an authenticated user to change the account password from Settings after verifying the current password. Keep the current session active and revoke other sessions.

## Authoritative safety and behavior invariants

1. Never permanently delete or overwrite an original media file.
2. File changes are not performed when a user changes a decision. They happen only after the explicit apply summary and second confirmation.
3. A file-operation failure must be visible and must not be represented as success. Apply stops on its first failed operation.
4. Restore must preserve conflicts rather than overwrite. Cross-volume moves are refused.
5. Use registered roots as hard path boundaries for every API and file operation. A client must never be able to supply an arbitrary path for reading/moving files.
6. The host is local-first. LAN HTTP is an acknowledged security trade-off and must carry a visible warning; never advertise public internet exposure as safe.
7. Decision history, apply history, and audit history are app data. Since automatic backups were declined and uninstall removes app data after warning, explain that loss of host app data loses this history.

## Recommended implementation stages

### Stage 0 - Create the project foundation

- Create the Node.js/Electron project structure with a shared responsive web UI and a local HTTP API.
- Select compatible runtime/dependency versions and define development, test, and per-OS packaging commands.
- Set up unit-test and end-to-end-test foundations, and add a GitHub Actions CI workflow that installs dependencies, runs both test suites, and builds the application on relevant pull requests and pushes.
- Document the architecture and local development workflow.

**Exit criteria:** the desktop host and local web UI start reliably in development; unit tests, end-to-end tests, and CI provide a repeatable baseline.

### Stage 1 - Durable domain model, authentication, and host lifecycle

- Formalize/migrate SQLite schema for collections, roots, media, per-device queue positions, decisions/undo-redo, item locks, apply batches/operations, settings, and append-only audit events.
- Enforce root canonicalization and non-overlap across active collections (including nested trees), while deduplicating roots inside one collection.
- Implement secure password setup/login, bounded password attempts/rate limiting, host-only password reset against the correct packaged data directory, per-browser session cookie, logout, and restart reauthentication.
- Ensure initial password setup and folder-picker/root registration are host-only. Validate all IDs/categories/paths at API boundaries.
- Implement Electron tray/background lifecycle, explicit quit/stop, optional OS autostart, LAN URL discovery/QR, and HTTP warning. Keep desktop folder picking in the Electron main process.

**Exit criteria:** no phone/API client can register arbitrary paths; authentication gates all media and collection data; password reset targets the same database as the running app; host window close and explicit quit behave as agreed.

### Stage 2 - Scanning and 200k-item collection service

- Build incremental recursive scan with explicit extension allowlists for common image/video formats; skip symlinks and app output folders.
- Continue after per-path errors, log them, retain unavailable roots/items, support readable read-only roots, and catch up on startup.
- Add bounded concurrency/back-pressure instead of a single global scan lock or unbounded queue; begin use as soon as first indexed items arrive.
- Keep file identity path-based; compare size/mtime to reset changed-file decision/preview; treat external rename as a new item.
- Watch for additions/changes/removals; append new unseen items without changing the active item.
- Ensure removed roots retain history; archive collections and release their root ownership.

**Exit criteria:** scan 200,000 entries without loading all rows into browser memory; progress/errors are visible; offline/reconnected roots and file changes are reconciled without losing decision history.

### Stage 3 - Media preview and cache

- Serve files only through authenticated media endpoints after validating root membership and current path.
- Support HTTP range requests for on-demand video playback.
- Render supported browser/OS media; unsupported recognized formats show a placeholder but remain sortable.
- Implement generated/managed previews for grid and sort views where available, plus a configurable 2 GB LRU cache; cache eviction must affect only generated previews, never originals.
- Generate video posters where the chosen platform codecs permit; report placeholder when not possible.

**Exit criteria:** virtualized grid loads lightweight previews rather than decoding every original at full size; cache stays within configured limit; unsupported formats remain categorisable; videos can seek/play when the host browser supports their codec.

### Stage 4 - Sorting, review, and responsive UI

- Implement unseen and keep/delete/unsure queues, capture-date ascending default with descending/filename choices, fallback date ordering, category filter grid, and visible category icons.
- Implement per-device mode/current item persistence and immediate shared decision updates.
- Implement edit locks with heartbeat/release and short idle expiry; communicate a lock conflict clearly.
- Implement keyboard arrows, touch swipe mappings, visible buttons, zoom/pan, undo/redo, clear-to-unseen, and dynamic removal from the reviewed category queue.
- Launch pending work directly into the combined photo-first review queue; defer unsure items to the tail of their pass, support pause, and route pause/completion to Browse.
- Keep the responsive navigation sheet pinned/collapsible on desktop and burger-controlled/overlay on phones; expose collection, apply, history, help, and settings workflows there.
- Implement a virtualized grid appropriate for 200k items and progressive refresh as scans find new content.
- Include English quick-help instructions and simple, accessible loading/error/empty states.

**Exit criteria:** users can sort/review on desktop and phone; position is restored per device; simultaneous edits are prevented; keyboard, touch, buttons, undo, and category changes work consistently.

### Stage 5 - Audited apply/restore operations

- Produce a deterministic preflight summary of every planned move/restore and destination example/count.
- Require the second confirmation; prompt before reusing any unowned `deleted`/`unsure` directory.
- Preserve relative directory structure beneath each root; append numbered names before extensions; never overwrite.
- Verify source/destination remain within registered root; refuse cross-volume moves; stop on first failure and record per-file outcome.
- Journal each operation before/after the filesystem action and reconcile safely on restart after interruption.
- Restore the latest apply batch, including only successful operations, with no overwrite and visible conflict results.
- Reconcile latest decisions on each confirmed apply, including moving delete<->unsure and restoring changed-to-keep items.

**Exit criteria:** tests prove originals are never permanently deleted, existing files are never overwritten, partial batches are accurately reported, and successful moves can be restored.

### Stage 6 - Audit, settings, docs, and packaging

- Complete persistent in-app audit browsing and export; record scan/decision/operation events with paths and timestamps; explicit clear action only.
- Include basic required settings: root management, sort order, cache limit, service/autostart controls. Cosmetic theme/grid controls and German remain deferred.
- Document data location, host-only reset, local-network warning, HTTPS/VPN setup expectations, file-move semantics, unsupported previews, backup/uninstall consequences, and build/package commands.
- Build separate Windows, macOS, and Linux packages from the shared codebase; test the host app's native folder picker and QR connection path.
- Ensure GitHub Actions CI runs unit and end-to-end tests and the relevant build/package checks, reporting failures on pull requests and pushes.

**Exit criteria:** fresh install/setup, phone connection, auth, scanning, sorting/review, apply/restore, audit export, uninstall warning, and per-OS packaging are documented and smoke-tested; unit and end-to-end tests run reliably in GitHub Actions CI.

## Minimum regression/acceptance test coverage

- Unit tests for core domain logic and file-operation safety; end-to-end tests for setup/login, collection scanning, sorting/review, apply/restore, and audit access.
- GitHub Actions CI must install dependencies and run unit tests, end-to-end tests, and application build checks on pull requests and pushes.
- Path traversal, symlink exclusion, overlapping roots, cross-collection root conflicts, output-folder exclusion, and collection archive/re-add behavior.
- Recursive indexing, unsupported extension rejection, image/video extension recognition, unreadable path handling, offline roots, watcher updates, startup catch-up, and size/mtime decision reset.
- Password setup host restriction, hash verification, login/logout/restart behavior, reset command data location, and authenticated media/API routes.
- Per-device queue restoration, category ordering/filtering, lock conflict/expiry, decision/clear/undo/redo behavior, and newly indexed item queue behavior.
- Apply preflight, unowned-folder prompt, numbered filename, relative path preservation, no overwrite, cross-volume refusal, first-failure stop, partial journal recovery, latest-batch restore, and restore conflict.
- Audit completeness/export/clear behavior and LRU cache size enforcement.
- Load/performance test or measured fixture for 200,000 indexed items; verify UI virtualization and bounded API pagination.

## Deferred beyond MVP

- PWA installation and passkey/biometric authentication (HTTPS-dependent).
- German localization.
- Cosmetic appearance controls (theme and adjustable grid density).
- Any cloud sync, cloud account, or remote internet access.
- Automatic database backups.