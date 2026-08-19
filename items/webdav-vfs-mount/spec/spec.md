# Feature Specification: WebDAV VFS Mount

**Feature Branch**: `037-webdav-vfs-mount`

**Created**: 2026-08-01

**Status**: Draft

**App Target**: `marketplace-item` — service facet: a background WebDAV daemon that binds its own HTTP port (a plain Node worker-thread service, the same shape as the Terminal precedent) and is reached by clients through BOS's existing service-reachability mechanism (`docs/dev/apps/services.md` §11) — entirely outside Next.js's request pipeline, but never by any "portless" routing. See `references/target-marketplace-item.md` for the delegation mechanism.

**Input**: User wants to expose the same VFS directory layout they see in Files (all of it, mirrored identically) over WebDAV for native mount support.

## User Scenarios & Testing

### User Story 1 — Access VFS via WebDAV (Priority: P1)

The user wants to expose their BrowserOS VFS as a WebDAV server. Any WebDAV-compatible client (like Windows' "Add network drive" wizard with HTTP, macOS Finder's "Connect to Server", or Linux `davfs2`) can connect to the service and interact with the VFS as if it were a remote file server.

**Why this priority**: This is the core value proposition. Without this, there is no end-user experience.

**Independent Test**: A WebDAV client can connect, authenticate, list the root, create and delete files, and see the full Files layout — including through a multi-user Bastion deployment, not just plain `npm run dev`.

**Acceptance Scenarios**:

1. **Given** the service is installed and a token is configured, **when** a WebDAV client connects at the address shown in the config page, **then** they see the full VFS directory tree exactly as it appears in Files.
2. **Given** the service is installed, **when** a WebDAV client performs standard operations (PROPFIND, GET, PUT, DELETE, MKCOL), **then** the VFS is modified correspondingly.
3. **Given** no valid token is provided (or a wrong one), **then** the server returns HTTP 401.
4. **Given** the token was minted via the config page (which registers it with Bastion's headless-auth routing — see AUTH-002), **when** a WebDAV client presents it over Basic auth through a Bastion deployment, **then** Bastion routes the request to the right container and the service's own check succeeds — both halves must agree, not just the service's own check in isolation.

---

### User Story 2 — Configure auth credentials (Priority: P2)

The user needs to generate a token in Settings → Plugins → WebDAV Service → config, and use that token to authenticate any WebDAV client.

**Why this priority**: Without auth, the service is exposed to the network — a security risk.

**Independent Test**: The user can generate a token, configure their WebDAV client with it, and successfully authenticate.

**Acceptance Scenarios**:

1. **Given** the WebDAV Service is installed, **when** the user navigates to Settings → Plugins → WebDAV Service, **then** they see a "Generate Access Token" action.
2. **Given** a token has been generated, **when** the user navigates back, **then** they see a copyable token value (or "Show" button).
3. **Given** a token exists, **when** the user clicks regenerate, **then** a new token is issued and the old one is revoked.
4. **Given** the user is not currently authenticated with a real browser session, **when** something attempts to mint/list/revoke a token via the API directly, **then** the request is rejected (403) regardless of what credential it presents — see AUTH-006.

---

### User Story 3 — Eager start, no startup blocking (Priority: P3)

The service starts immediately after install (eagerly). If no token has been configured, any connection is rejected with 401 — but the service itself runs fine. This avoids a chicken-and-egg problem: the user can visit the settings page while the service is already running.

**Why this priority**: If the service only starts after config, the user has no way to reach the settings UI to configure it.

**Independent Test**: The service starts without a configured token, returning 401 on all requests.

**Acceptance Scenarios**:

1. **Given** the service is installed, **when** it is started, **then** it is listening and responding to all requests with 401.
2. **Given** no token is set, **when** a WebDAV client connects, **then** they receive a 401 response (not a connection timeout).

---

## Requirements

### Functional Requirements

- **FR-001**: The service MUST implement the WebDAV protocol — specifically PROPFIND, GET, PUT, DELETE, MKCOL, and HEAD.
- **FR-002**: The service MUST authenticate requests via BOS's Generic Secrets mechanism (`src/lib/secrets/service-secrets.ts`'s `createSecret`/`verifySecret`, under a `webdav-vfs-mount` service namespace) — never a token generated, hashed, or stored by the worker thread itself. Since a worker thread cannot `import` that module directly, verification happens over a loopback HTTP call to `/api/secrets/webdav-vfs-mount/verify` (see AUTH-002/AUTH-006 and `docs/dev/features/headless-client-auth.md`'s "Worker-thread services" section) — the same bridge pattern already used for VFS access.
- **FR-003**: The service MUST expose the VFS directory tree exactly as it appears in Files, with all subdirectories and files mirrored.
- **FR-004**: The service MUST start eagerly after installation, returning 401 for any request when no token has been minted yet.
- **FR-005**: The user MUST be able to generate, view, copy, and regenerate an access token from Settings → Plugins → WebDAV Service → config.
- **FR-006**: The service MUST bind its own HTTP port — defaulting to `0` (OS-assigned, see NET-001) — and MUST be reachable in every deployment mode (Bastion, Supervisor-only, standalone) via BOS's existing service-reachability mechanism: `wsPath`/`httpPath` from `GET /api/services/<id>/config`, proxied through the Supervisor when present, falling back to a direct `host:port` connection when it isn't. There is no separate "path-proxy" mechanism to build or invoke — this is the same mechanism every other BOS service with a network port already uses (see `docs/dev/apps/services.md` §11).

### Authentication & Token Generation

- **AUTH-001**: Access tokens are generated server-side by `createSecret("webdav-vfs-mount", label)` (256 bits of entropy) — never by the worker thread. The raw value is returned to the browser exactly once and never persisted anywhere in plaintext.
- **AUTH-002**: Minting a token via `createSecret()` automatically registers it with Bastion's headless Basic-auth routing (`credentials-index.json`) in the SAME step — this is what makes the token usable through a multi-user Bastion deployment at all. A token the worker thread generated and hashed entirely on its own (an earlier revision of this feature) is NEVER registered there, so Bastion rejects every request at the front door before it ever reaches the service — this happened for real and is the reason this requirement exists.
- **AUTH-003**: Authentication uses the `Authorization: Bearer <token>` header (standard HTTP auth for WebDAV clients) at the service's own request-handling layer. Bastion, when routing a Basic-auth request, rewrites it to this same `Bearer` form before forwarding — the service's check is unaffected either way.
- **AUTH-004**: The token can be regenerated from Settings → Plugins → WebDAV Service → config. Regenerating revokes every previously-minted secret for this service (via `DELETE /api/secrets/webdav-vfs-mount`) before minting a new one, so the old token stops working immediately — no restart required, since the service never caches or locally stores any token/hash at all.
- **AUTH-005**: An unauthenticated request receives HTTP 401 with a `WWW-Authenticate: Bearer` header.
- **AUTH-006**: Minting/listing/revoking a token (`/api/secrets/webdav-vfs-mount`) is a browser-only, session-authenticated operation — it explicitly rejects a request that arrived via ANY per-service secret (including this service's own), regardless of which service minted it (`hasSessionScope()`, `src/lib/secrets/auth-scope.ts`). The loopback verify call the service itself makes (`/api/secrets/webdav-vfs-mount/verify`) is the opposite: restricted to same-container loopback callers only (`isLoopbackOnly()`), never reachable externally, so it can't be used as a token-guessing oracle. These are deliberately two different surfaces with two different gates — see `docs/dev/features/headless-client-auth.md`'s "Why not under `/api/services/[id]/*`" for why a single shared, less-restricted surface would be a privilege-escalation path.

### Network Topology & Service Exposure

- **NET-001**: The service MUST bind its own configurable HTTP port. The `port` config field MUST default to `0` (OS-assigned) — never a fixed number — to avoid colliding with BOS's own reserved ports (the Supervisor's public port and its base+preview-worktree pool; see `docs/dev/apps/services.md` §3's "Choosing a port"). BOS refuses to start the service if a fixed, non-zero configured port collides with a reserved one.
- **NET-002**: The client-facing connection URL is deployment-dependent, not a single fixed pattern — see `docs/dev/apps/services.md` §11's three-scenario table (multi-user Bastion, Supervisor-only, standalone). The config UI (CFG-001/002) MUST show the address that's actually correct for the CURRENT deployment, discovered live from `GET /api/services/webdav-vfs-mount/config`'s `httpPath` (proxied deployments) or `runtime.port` (standalone) — never a hardcoded example passed off as universal.
- **NET-003**: In every deployment mode, the service starts eagerly after installation — it does not block on token configuration.
- **NET-004**: TLS termination is handled by the reverse proxy in front of BOS (Bastion, or the operator's own Traefik/nginx in a Supervisor-only deployment) or is absent entirely in a standalone deployment; the service itself always speaks plain HTTP.

### Security

- **SEC-001**: All file paths received from WebDAV clients MUST be validated against the VFS root to prevent directory traversal (e.g., `../../etc/passwd` style attacks).
- **SEC-002**: The service MUST reject paths that resolve outside the configured VFS root.
- **SEC-003**: Request headers (especially `If-Match`, `If-None-Match`, `If-Modified-Since`) are NOT supported — the service treats each request as authoritative.
- **SEC-004**: Directory listings do NOT paginate — the service returns all entries at once. This is a known limitation for large directories.
- **SEC-005**: The service implements no rate limiting or connection throttling — for local mode, the user is responsible for their own network-layer protections.
- **SEC-006**: A per-service secret (this service's own token, or any other service's) MUST NEVER be sufficient to mint, list, or revoke secrets for ANY service, including its own — see AUTH-006. Bastion's headless routing resolves which container a secret belongs to, never which path it may reach; the admin surface enforces the actual restriction.

### Configuration Page Requirements

- **CFG-001**: The config page includes clear instructions on how to mount the VFS, using the ACTUAL, live-discovered connection URL for the current deployment (never a hardcoded example — see NET-002).
- **CFG-002**: The page provides example mount commands for common clients, each using the discovered connection URL:
  - macOS Finder: `dav://<discovered-host>[:<discovered-port>]/`
  - Linux (davfs2): `mount -t davfs -o username=webdav,password=<token> <discovered-url> /mnt/webdav`
  - Windows: the discovered URL, to enter in the "Network Drive" wizard
- **CFG-003**: The page shows connection information and notes about TLS, and — since the discovered URL differs by deployment — briefly explains which of the three scenarios (Bastion / Supervisor-only / standalone) applies and why.

### Key Entities

- **WebDAV Service**: A background daemon that processes WebDAV requests and translates them to VFS operations. It runs as a worker-thread process, entirely outside Next.js, binding its own HTTP port like any other BOS service. It holds no token material of its own at any point.
- **Access Token**: A cryptographically random secret minted by BOS's Generic Secrets mechanism (`createSecret("webdav-vfs-mount", label)`) — its authoritative record lives in the existing encrypted per-user SecretsStore, with a fast companion hash in `credentials-index.json` for Bastion's routing. Never generated, hashed, or stored inside the item's own `config/`.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A WebDAV client can connect, authenticate, and perform all standard file operations on the VFS.
- **SC-002**: The service starts immediately upon installation, returning 401 for unauthenticated requests.
- **SC-003**: Directory layout over WebDAV matches the Files UI exactly — no missing files or directories.
- **SC-004**: The config page shows a connection URL that is actually correct and reachable for whatever deployment BOS is currently running under — verified manually in at least a Supervisor-fronted deployment, not just plain `npm run dev`.
- **SC-005**: A token minted from the config page authenticates successfully through an ACTUAL multi-user Bastion deployment, over real Basic auth (e.g. `davfs2`) — not just verified in isolation against the service's own check. This is the scenario that broke for real before AUTH-002 existed, and is the one that must be manually re-verified, not just unit-tested.

## Assumptions

- The VFS provides a synchronous or async API for directory listing, file read/write/delete/mkdir operations.
- BOS's Generic Secrets mechanism (`createSecret`/`verifySecret`/`listSecrets`/`revokeSecret`, `src/lib/secrets/service-secrets.ts`) and its loopback bridge (`/api/secrets/<service>`, `/api/secrets/<service>/verify`) exist and are available — this feature is a consumer of that mechanism, not something reinventing token storage itself.
- The service runs as a background daemon — no browser or UI involved, other than the generic Settings → Plugins → Services config panel.
- The "Files" layout in BOS exposes the user's complete VFS hierarchy — the WebDAV mount mirrors this exactly, starting from the VFS root.
- The service's own port default of `0` is safe in every deployment because the OS's ephemeral port range never overlaps BOS's own reserved ports — see `docs/dev/apps/services.md` §3.
