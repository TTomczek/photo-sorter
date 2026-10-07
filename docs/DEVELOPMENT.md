# Development and security

## Run locally

1. Install Node.js 22.13+.
2. Run `npm install`.
3. Run `npm run dev`.
4. In the host window, set a password of at least 12 characters, create a collection, and choose one or more folders.
5. Log in from a phone using a displayed address on the same private network.

`npm run lint` runs ESLint. `npm test` runs the unit suite and HTTP workflow tests. `npm run test:unit` and `npm run test:e2e` run either suite independently. `npm run build` checks and packages the unpacked app for the current OS; `npm run dist:win`, `npm run dist:mac`, and `npm run dist:linux` build the native installer/package target.

GitHub Actions runs lint, tests, the unpacked build, and the native NSIS, DMG, or AppImage package on Windows, macOS, and Linux for pushes and pull requests. Each successful platform job uploads its release output as a downloadable workflow artifact retained for 14 days.

## Account recovery and app data

Stop the running host before resetting its account password. In a terminal with Node.js 22.13+, run `npm run reset-password`; the command hides password input and uses the same default OS data directory as the desktop app. To use a custom directory, run `npm run reset-password -- --data-dir <directory>` (the same path supplied through `PHOTO_SORTER_DATA_DIR`). Restart the app to invalidate existing sessions.

The default data directory is `%APPDATA%/photo-sorter` on Windows, `~/Library/Application Support/photo-sorter` on macOS, and `$XDG_CONFIG_HOME/photo-sorter` or `~/.config/photo-sorter` on Linux. No automatic backups are made. Database removal or loss discards account, collection, decision, apply, and audit history, but never touches original media.

Uninstalling the desktop application leaves this data directory untouched on every platform. The in-app safety guide warns that manually deleting it permanently removes the account and history; original photo and video files are never part of app-data cleanup.

Settings lets you choose the default sort used before a device has saved a review position, set the managed preview cache limit (2,048 MB by default; 0 disables it), and, in the desktop host, toggle sign-in autostart. The host first uses embedded image thumbnails; for visible cards without one, the browser generates a resized JPEG on demand and sends it to the authenticated cache endpoint. Video cards generate and cache a first-frame poster when the browser's OS codecs can decode the video. These generated assets are version-bound to the indexed file size and modification time, kept in the LRU cache, and never replace or modify originals. The sorting view still displays the original media for zoom and playback.

Theme, grid column count, and language are stored in each browser's local storage. The interface supports English and German and defaults to the browser language on first use. The collection grid keeps a bounded 60-item data window and loads the page at the visible scroll position.

## PWA and passkeys

The responsive site includes a PWA manifest and caches only its static application shell; API responses and media are never placed in the service-worker cache. Browsers require HTTPS for LAN service workers and passkeys. Loopback `localhost` is treated as a secure context for local development, but plain-HTTP phone connections cannot install the PWA or use passkeys.

To enable passkeys behind an operator-managed HTTPS reverse proxy, set both `PHOTO_SORTER_WEBAUTHN_ORIGIN` (the exact origin, such as `https://photos.example.org`, with no trailing slash) and `PHOTO_SORTER_WEBAUTHN_RP_ID` (the relying-party domain, such as `photos.example.org`) before starting the host. The proxy must preserve the browser's `Origin` header. Passkeys are optional; password login remains available. The HTTPS proxy/VPN is still the operator's responsibility, and the app must not be exposed directly to the public internet.

## Network warning

The service accepts connections only on loopback and detected private IPv4 interfaces. The LAN site uses HTTP: passwords, sessions, and media are not encrypted in transit. Use a trusted LAN, or configure an HTTPS/VPN reverse proxy yourself. Never expose the service directly to the public internet. The app does not configure firewall or router rules.

## File-operation semantics

Sorting decisions are database changes only. Applying presents source and destination examples and a separate confirmation. Categorized files move into root-level `deleted` or `unsure` folders while preserving relative subfolders; pre-existing unowned output folders need an explicit user approval. Destinations are never overwritten and collisions use numbered names. Cross-volume and unsupported hard-link operations stop the batch. Restore never overwrites an occupied original path.
