# Photo Sorter

Photo Sorter is a local-first Electron application for organizing photos and videos on the computer that stores them. Its responsive web interface can also be opened by phones on the same private network.

The application includes password and optional passkey sign-in, local collections and watched folders, responsive photo/video review, safe apply/restore with recovery journaling, an audit log, English/German UI, appearance preferences, generated previews, and a static-shell PWA. Cloud sync and automatic backups are intentionally excluded. See [implementation status](docs/ARCHITECTURE.md#current-scope-by-handoff-area) for the full scope and limitations.

## Development

- Requires Node.js 22.13 or newer and npm.
- `npm install` installs Electron, packaging tools, and the Playwright test runner.
- `npx playwright install chromium` installs the browser used by UI tests.
- `npm run dev` starts the desktop host.
- `npm test` runs unit tests, HTTP/API workflow tests, and real-browser Playwright tests.
- `npm run test:unit`, `npm run test:e2e`, and `npm run test:browser` run those suites individually.
- `npm run build` builds the unpacked desktop application for the current OS.
- `npm run dist:win`, `npm run dist:mac`, and `npm run dist:linux` create native packages for their target OS.

The first launch on the host desktop asks you to set a password (12 characters minimum). Create a collection and use **Choose folder** in the desktop app; phone/browser clients cannot register filesystem paths. The host displays local-network URLs after login.

## Safety and privacy

The service listens on loopback and private IPv4 interfaces only. LAN HTTP does not encrypt passwords or media in transit; use it only on a trusted network, or configure your own HTTPS/VPN reverse proxy. Do not expose the service directly to the public internet.

Changing a decision never moves a file. **Review and apply moves** presents a summary and requires a separate confirmation. Delete decisions move into a `deleted` folder under the selected root; unsure decisions move into `unsure`. Files are never permanently deleted or overwritten. The latest successful apply batch can be restored when original paths are free.

The SQLite database contains the password hash, collections, decisions, apply journal, and audit log. Automatic backups are not made. Removing app data loses this history, but does not remove original media.

See [Development and security](docs/DEVELOPMENT.md) and [Architecture and current scope](docs/ARCHITECTURE.md) for setup details and implementation boundaries.
