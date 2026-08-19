# Implementation Plan: WebDAV VFS Mount

## Overview

This plan covers the implementation of the WebDAV VFS Mount feature as a `marketplace-item` service facet. The service is a background WebDAV daemon that binds its own HTTP port (default `0`, OS-assigned) and is reached through BOS's existing service-reachability mechanism (`docs/dev/apps/services.md` §11 — the same one Terminal already uses). Each user gets their own service instance. Auth is via BOS's Generic Secrets mechanism, reached over a loopback bridge (`/api/secrets/webdav-vfs-mount`, `/api/secrets/webdav-vfs-mount/verify`) — the service never generates, hashes, or stores a token itself.

**Spec file**: `spec.md`
**Design file**: `design.md`

## Tasks

### T-01 — Project scaffolding & service manifest

Create the marketplace-item directory and the `service.json` manifest.

**Files**: `data/user-apps/items/webdav-vfs-mount/services/service.json`

**Acceptance criteria**:
- The `service.json` declares `id: "webdav-vfs-mount"`, `name`, `version`, `entry`, `configSchema`, and `settingsRegistration`.
- `configSchema` defines ONLY `port` (number, **default `0`** — never a fixed number, see `docs/dev/apps/services.md` §3) and `host` (string, default `127.0.0.1`) — **no `hashedToken`/`token` field at all**; the service holds no token material of its own (see T-02).
- `settingsRegistration` registers the service under the Plugins → Services panel (label: "WebDAV Service", icon: "server") with `configApp: "templates/config.html"`.
- No `runtime.json` shipped in the item source — that file is written by `ServiceManager.ts` after the service's first `bound` IPC message, exactly like every other BOS service.

### T-02 — Auth layer: loopback verify (NOT token generation/hashing)

Implement the auth check the daemon runs on every request — a loopback call to BOS's own Generic Secrets bridge, never local crypto.

**Files**: `data/user-apps/items/webdav-vfs-mount/services/index.js` (auth functions)

**Acceptance criteria**:
- `extractBearerToken(req)` parses `Authorization: Bearer <token>` (case-insensitive scheme), returns `null` if absent or a different scheme.
- `verifyCandidate(serviceId, candidate)` POSTs `{ candidate }` to `/api/secrets/<serviceId>/verify` over the same loopback base URL used for `/api/fs` (`vfsBaseUrl()`/`process.env.PORT`), and resolves to `!!res.body.valid` — never throws for a plain mismatch.
- `validateAuth(req, serviceId)` is `async`: returns `false` immediately if no Bearer token is present (no loopback call needed), otherwise awaits `verifyCandidate` and fails closed (`false`) if the loopback call itself errors.
- **No `generateToken`/`hashToken`/`verifyToken`/`generateAndStore` functions exist in this file at all** — token generation, hashing, and storage are BOS's job (`src/lib/secrets/service-secrets.ts`'s `createSecret`), invoked only from the browser-facing config UI (T-08), never from this worker thread. An earlier revision implemented all of this locally; it shipped a real bug (the token was never registered with Bastion's headless-auth routing) and was removed — see design.md's ADR-4 for the incident.

### T-03 — WebDAV protocol handlers

Implement HTTP method handlers for WebDAV operations.

**Files**: `data/user-apps/items/webdav-vfs-mount/services/index.js` (handler functions)

**Acceptance criteria**:
- `handlePROPFIND(path)` — returns XML listing of directory contents at the given path.
- `handleGET(path)` — streams file contents (no body for HEAD).
- `handleHEAD(path)` — returns only headers (Content-Type, Content-Length, Last-Modified) with no body.
- `handlePUT(path, body)` — creates or overwrites a file at the given path.
- `handleDELETE(path)` — removes a file or empty directory.
- `handleMKCOL(path)` — creates a directory (no-op if already exists).
- Each handler returns appropriate HTTP status codes and WebDAV headers.
- The dispatch logic routes all requests (any method) to the correct handler.

### T-04 — VFS API mapping layer

Implement the VFS HTTP API calls that translate WebDAV operations into VFS operations.

**Files**: `data/user-apps/items/webdav-vfs-mount/services/index.js` (VFS layer functions)

**Acceptance criteria**:
- `vfsList(rootPath, subPath)` → `GET /api/fs?op=list` — returns directory listing.
- `vfsRead(rootPath, subPath)` → `GET /api/fs/raw?path=` — returns file content.
- `vfsWrite(rootPath, subPath, body)` → `POST /api/fs {op: write, path, body}`.
- `vfsDelete(rootPath, subPath)` → `POST /api/fs {op: delete, path}`.
- `vfsMkdir(rootPath, subPath)` → `POST /api/fs {op: mkdir, path}`.
- `vfsStat(rootPath, subPath)` → `GET /api/fs?op=stat` — returns file metadata.
- Each function uses plain loopback HTTP requests (no framework imports) — the same `vfsJsonRequest`/`vfsBaseUrl` helpers double as the transport for T-02's `verifyCandidate`.
- Each function resolves `rootPath + subPath` for the VFS API call.

### T-05 — Path validation & directory traversal prevention

Implement path sanitization and security checks.

**Files**: `data/user-apps/items/webdav-vfs-mount/services/index.js` (security functions)

**Acceptance criteria**:
- `sanitizePath(requestPath)` strips leading `/` and normalizes the path.
- `isPathSafe(resolvedPath, vfsRoot)` ensures resolvedPath starts with vfsRoot.
- `validatePath(requestPath, vfsRoot)` combines sanitization + safety check.
- Requests that resolve outside the VFS root receive an HTTP 403 or 404.
- Tests cover `../` traversal attempts and absolute paths.

### T-06 — Main daemon entry point

Wire everything together in `index.js`.

**Files**: `data/user-apps/items/webdav-vfs-mount/services/index.js` (main handler)

**Acceptance criteria**:
- `index.js` is a self-contained Node script using only built-in modules (`http`, `path`, `fs`) — no `crypto` either, since it no longer hashes anything.
- On `initialize`, creates a plain `http.createServer(...)` bound to `config.port`/`config.host` (config's `port` defaults to `0`).
- On the server's `listening` event, reads back `server.address().port` and reports it via `parentPort.postMessage({ type: "bound", port, host })` — the standard IPC contract every BOS service follows (`docs/dev/apps/services.md` §6).
- On each incoming request to the bound port: `await`s the auth gate (T-02) before anything else — for every method including `OPTIONS` — then resolves VFS root, sanitizes path, dispatches to handler.
- Returns appropriate HTTP status codes (200, 201, 204, 206, 401, 403, 404, 405, 500).
- Returns WebDAV-compatible headers (Content-Type, Content-Length, Last-Modified, ETag, etc.).
- Unauthenticated (or not-yet-minted-token) requests receive 401 with `WWW-Authenticate: Bearer` header.

### T-07 — Config file & eager start behavior

Implement config loading and eager startup behavior.

**Files**: `data/user-apps/items/webdav-vfs-mount/config/webdav-vfs-mount.json`

**Acceptance criteria**:
- Default config is `{"port": 0, "host": "127.0.0.1"}` — no token/hash field.
- The service starts eagerly even with no token minted yet — returns 401 on all requests (T-02's `verifyCandidate` naturally resolves `false` when nothing has been created via `/api/secrets/webdav-vfs-mount`).
- The service does not block on config — `loadConfig` only ever reads `port`/`host`, never anything auth-related.

### T-08 — Settings UI integration

Integrate the service with the generic Settings → Plugins → Services UI, show the ACTUAL reachable connection URL for the current deployment, and mint/list/revoke tokens through BOS's Generic Secrets surface — never client-side.

**Files**: `data/user-apps/items/webdav-vfs-mount/templates/config.html`

**Acceptance criteria**:
- The service appears in Settings → Plugins → Services.
- **Generate**: `POST /api/secrets/webdav-vfs-mount` (body `{ label }`) — the response's `rawSecret` is displayed once; **no client-side token generation or hashing** (an earlier revision hand-rolled a pure-JS SHA-256 implementation for this — it's gone entirely; the browser session already satisfies the route's `hasSessionScope()` check transparently).
- **Regenerate**: `GET /api/secrets/webdav-vfs-mount` to list existing secrets, `DELETE` (body `{ secretId }`) each one, THEN `POST` to mint a new one — so the old token stops working immediately, with nothing to invalidate service-side since the worker never cached anything.
- **Token existence check** (for whether to show "Generate" vs "Regenerate"): `GET /api/secrets/webdav-vfs-mount` and check `secrets.length > 0` — never `configData.configFiles[...].values.hashedToken` (that field no longer exists).
- The config page fetches `GET /api/services/webdav-vfs-mount/config` and computes the connection URL the same way Terminal's own `app/index.html` does (`docs/dev/apps/services.md` §12): prefer `httpPath` (proxied through the Supervisor) when non-null, else fall back to direct `host:runtime.port`. **Never hardcode a literal host/port** — this has gone wrong for real (an earlier mockup showed `localhost:9876`, which is neither the actual assigned port nor reachable at all behind a reverse proxy).
- Instructions show how to mount the VFS using that DISCOVERED url:
  - macOS Finder: `dav://<discovered-host>[:<discovered-port>]/`
  - Linux (davfs2): `mount -t davfs -o username=webdav,password=<token> <discovered-url> /mnt/webdav`
  - Windows: the discovered URL, to enter in the "Network Drive" wizard

### T-09 — Integration testing

Verify the complete service end-to-end.

**Acceptance criteria**:
- All WebDAV methods (PROPFIND, GET, PUT, DELETE, MKCOL, HEAD) work against the VFS.
- Authentication works: valid token allows access, invalid token returns 401 — tested against a fake server standing in for BOTH `/api/fs` AND `/api/secrets/webdav-vfs-mount/verify` (same loopback base URL), not a locally-computed hash.
- Path traversal is blocked.
- The service starts eagerly and returns 401 when no token has been minted.
- The VFS directory tree is mirrored exactly.
- The service actually binds a port (`GET /api/services/webdav-vfs-mount` shows a non-null `boundPort`) and a WebDAV client can connect using the config page's displayed URL, verified in at least one Supervisor-fronted test deployment (not just `npm run dev`).
- A fixed, non-zero configured port that collides with BOS's own reserved ports is refused with a visible error in Settings, not a silent failure.
- **A token minted via `/api/secrets/webdav-vfs-mount` actually authenticates through a REAL multi-user Bastion deployment** over Basic auth (e.g. `davfs2`) — this is the specific thing that broke before (a locally-hashed token was never registered with Bastion's routing) and unit tests against the daemon in isolation cannot catch it; this line item must be checked against a real deployment, not simulated.

### T-10 — Unit tests

Write unit tests for each module: auth (against a fake `/api/secrets/.../verify` server, not local hashing), VFS, path validation, and main daemon.

**Acceptance criteria**:
- Each module has at least one test case per function.
- Tests cover normal cases and edge cases, including: no token minted yet, a valid token, a wrong token, and a revoked token (removed from the fake server's valid set) failing on the very next request.
- Tests run in isolation without network dependencies beyond the fake in-process HTTP servers they stand up themselves (no real BOS server, no real VFS).

### T-11 — Market registration

Register the marketplace item in `marketplace.json`.

**Acceptance criteria**:
- The item is listed in `marketplace.json`.
- The entry points and metadata are correct.
- The item can be installed via the marketplace.

## Dependencies

| Task | Depends on |
|---|---|
| T-02 | — (standalone module; depends on BOS's `/api/secrets/[service]/verify` route existing, but not on anything else in this item) |
| T-03 | T-02 (auth), T-04 (VFS layer) |
| T-04 | — (standalone layer) |
| T-05 | — (standalone module) |
| T-06 | T-02, T-03, T-04, T-05 |
| T-07 | T-06 (entry point) |
| T-08 | T-06 (service must work first) |
| T-09 | T-06, T-07, T-08 |

## Notes

- All files live under `data/user-apps/items/webdav-vfs-mount/` — no BOS source changes for the item itself. It DOES depend on real BOS source that already exists once, shared by every future service: `src/app/api/secrets/[service]/route.ts` (mint/list/revoke) and `src/app/api/secrets/[service]/verify/route.ts` (loopback verify) — see `docs/dev/features/headless-client-auth.md`.
- The service uses only Node.js built-in modules (`http`, `path`, `fs`) — no `crypto`, since it no longer hashes anything itself.
- No `@/` imports, no Next.js dependencies, no webpack bundling.
- The `service.json` declares `entry: "index.js"` — the full daemon.
- The `settingsRegistration` in `service.json` handles the UI integration — no custom React components, just `templates/config.html`.
- The service binds its own port like any other BOS service — `port` config defaults to `0` (OS-assigned); BOS writes `runtime.json` after the first `bound` IPC message. The config UI discovers the real, deployment-correct connection URL via `GET /api/services/webdav-vfs-mount/config` — there is no fixed address pattern that works across every deployment mode, so nothing in this item should ever hardcode one.
- **Auth is never local to this item.** Every token operation — mint, list, revoke, verify — goes through BOS's Generic Secrets loopback bridge. Nothing in `services/index.js` or `templates/config.html` generates, hashes, or stores a single byte of token material. This is the corrected version of a design that previously did all of this locally and broke Bastion routing as a result.
