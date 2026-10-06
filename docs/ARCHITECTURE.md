# Architecture and current scope

## Runtime

- `src/electron/main.js` owns the desktop window, tray lifecycle, optional login autostart, and native directory chooser.
- `src/electron/preload.js` exposes only the folder chooser and autostart actions to the isolated renderer. A client cannot submit a filesystem path through the HTTP API.
- `src/app.js` implements the local HTTP API, authentication, SQLite persistence, scanning, media streaming, audit records, and confirmed file operations.
- `src/ui/` is the shared responsive browser/Electron interface. Media and collection endpoints require a session cookie. Sessions are process-memory-only and expire when the host restarts.
- SQLite uses Node's built-in `node:sqlite`; the supported runtime is Node 22.13+ (Electron supplies its own Node runtime).

The host binds to loopback and private IPv4 addresses, rather than every network interface. LAN transport is still plain HTTP; keep it on a trusted network or use an operator-managed HTTPS/VPN proxy. The application does not configure firewall rules or provide internet access.

## Data and file safety

The database is stored in the operating-system application-data directory (`PHOTO_SORTER_DATA_DIR` can override it). Collections own canonical directory roots; overlapping roots in active collections are rejected. Scanning allowlists common image and video extensions, excludes symlinks and the root-level `deleted`/`unsure` directories, and continues past unreadable paths.

File identity is root plus relative path. A size or modification-time change clears a previous decision. Media is served by an authenticated ID endpoint, never by a client-provided path. Video responses support HTTP byte ranges.

Apply creates an expiring plan and records a journal row before each filesystem action. The UI presents the planned operations and requires an explicit second confirmation. Existing output folders require explicit reuse consent. Same-filesystem hard-link/unlink moves provide atomic no-overwrite destination creation; unsupported filesystems or cross-volume cases fail visibly. Apply stops at the first failure. Restore processes the latest batch and preserves occupied original paths as conflicts.

Audit records are append-only through the current UI/API. There is no automatic database backup. Host app data includes decision, apply, and audit history; losing or removing it loses that history, not original media.

## Implemented and deferred

Implemented: desktop host and LAN web UI, first-run password and login, named collections, host-only root selection, recursive manual scanning, path-bounded media/range endpoints, decisions, paged category browsing, keyboard/touch/button decisions, video playback where the OS supports it, apply summary/confirmation, latest-batch restore, audit browsing, and per-OS packaging commands.

Further MVP work remains before the full handoff acceptance criteria are met: filesystem watchers/startup catch-up, removable-root and collection archival UI, persistent per-device queue positions, simultaneous-edit locks, decision undo/redo, capture-date extraction and selectable sort order, true virtualized 200k-item navigation, zoom/pan, QR generation, preview caching, complete keep/delete/unsure reconciliation, robust interrupted-operation recovery, audit export/clear, uninstall data warning, and end-to-end desktop/phone packaging smoke tests. Do not treat these absent features as supported.
