# Development and security

## Run locally

1. Install Node.js 22.13+.
2. Run `npm install`.
3. Run `npm run dev`.
4. In the host window, set a password of at least 12 characters, create a collection, and choose one or more folders.
5. Log in from a phone using a displayed address on the same private network.

`npm test` runs the unit suite and HTTP workflow tests. `npm run test:unit` and `npm run test:e2e` run either suite independently. `npm run build` checks and packages the unpacked app for the current OS; `npm run dist:win`, `npm run dist:mac`, and `npm run dist:linux` build the native installer/package target.

GitHub Actions runs tests and the unpacked build on Ubuntu, Windows, and macOS for pushes and pull requests.

## Account recovery and app data

Stop the running host before resetting its account password. In a terminal with Node.js 22.13+, run `npm run reset-password`; the command hides password input and uses the same default OS data directory as the desktop app. To use a custom directory, run `npm run reset-password -- --data-dir <directory>` (the same path supplied through `PHOTO_SORTER_DATA_DIR`). Restart the app to invalidate existing sessions.

The default data directory is `%APPDATA%/photo-sorter` on Windows, `~/Library/Application Support/photo-sorter` on macOS, and `$XDG_CONFIG_HOME/photo-sorter` or `~/.config/photo-sorter` on Linux. No automatic backups are made. Database removal or loss discards account, collection, decision, apply, and audit history, but never touches original media.

## Network warning

The service accepts connections only on loopback and detected private IPv4 interfaces. The LAN site uses HTTP: passwords, sessions, and media are not encrypted in transit. Use a trusted LAN, or configure an HTTPS/VPN reverse proxy yourself. Never expose the service directly to the public internet. The app does not configure firewall or router rules.

## File-operation semantics

Sorting decisions are database changes only. Applying presents source and destination examples and a separate confirmation. Categorized files move into root-level `deleted` or `unsure` folders while preserving relative subfolders; pre-existing unowned output folders need an explicit user approval. Destinations are never overwritten and collisions use numbered names. Cross-volume and unsupported hard-link operations stop the batch. Restore never overwrites an occupied original path.
