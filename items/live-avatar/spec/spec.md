# Live Avatar

**Status:** Draft  
**Item ID:** `live-avatar`  
**Facets:** `voiceEngine` · `app`

---

## Overview

Live Avatar is a BOS marketplace plugin that connects the BOS voice pipeline to an
[AVTR-1](https://github.com/avaturn-live/avtr-1) avatar rendering server. When
installed and active, the agent's TTS audio is streamed to the avatar server over a
WebSocket; the server renders a lip-synced video of the chosen avatar and streams it
back to the browser over WebRTC. The net result: instead of hearing a disembodied
voice, the user sees and hears a speaking avatar in a dedicated BOS window.

The item ships two facets:

- **`voiceEngine`** — a server-side plugin that registers a `live-avatar` voice
  engine in BOS, manages the avatar server session, and exposes its own API surface
  via BOS's generic plugin catch-all route.
- **`app`** — an iframe application served through the plugin's own routes
  (same-origin, WebRTC-capable) that renders the avatar video and audio.

---

## Dependencies and Prerequisites

This item depends on platform features that must land in BOS before this plugin can
be built. They are tracked in BOS system spec
[`032-dynamic-integration-plugins`](../../../bos-system-specs/032-dynamic-integration-plugins/spec.md).
Specifically, the following must exist:

| Prerequisite | From 032 spec |
|---|---|
| Generic plugin catch-all route `GET\|POST /api/plugin/[pluginId]/[...path]` | Phase A |
| `sdk.registerRoute(method, path, handler)` | Phase A |
| `sdk.registerVoiceEngine(type, config)` | Phase A (extended — voice engine registry) |
| `sdk.registerSettingsPanel(config)` | Phase A |
| Marketplace `voiceEngine` facet in schema | Phase B |
| Plugin loader (`instrumentation.ts`) | Phase A |

The `voiceEngine` facet and `sdk.registerVoiceEngine` are extensions to the 032
spec that must be added before this item is implemented.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ BOS (Node.js process)                                           │
│                                                                  │
│  Plugin: live-avatar                                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Registered routes (/api/plugin/live-avatar/...)          │   │
│  │  GET  /session    → proxy /avatars + /ice-servers        │   │
│  │  POST /offer      → relay browser SDP → avatar server   │   │
│  │  POST /speak      → generate TTS + stream MP3 to WS     │   │
│  │  POST /interrupt  → send interrupt on WS                │   │
│  │  GET  /app        → serve avatar app index.html          │   │
│  │  GET  /app/*      → serve avatar app assets              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          │ WebSocket (MP3 audio + control)       │
└──────────────────────────┼──────────────────────────────────────┘
                           │
                    ┌──────▼────────┐
                    │ AVTR-1 server │  (internal network)
                    │ :7861         │
                    └──────┬────────┘
                           │ WebRTC (video + avatar audio)
                    ┌──────▼────────┐
                    │ Browser       │  (external, via reverse proxy)
                    │  avatar app   │  TURN relay if needed
                    └───────────────┘
```

**Two connections, not one:**

1. **BOS → avatar server (WebSocket `wss://<host>/agent/audio`)** — carries MP3
   audio chunks and JSON control messages. BOS holds this connection for the
   lifetime of a voice session. One connection per active BOS voice session.

2. **Browser → avatar server (WebRTC)** — carries the rendered avatar video track
   and the avatar's voice audio track back to the browser. BOS acts only as a
   signaling relay; it never touches the media stream itself.

---

## Voice Engine Registration

The plugin registers itself as a voice engine with ID `live-avatar` via
`sdk.registerVoiceEngine`. When selected as the active TTS provider in voice
settings, BOS routes all TTS calls through the plugin instead of the default
OpenAI-compatible or OmniVoice engines.

The voice engine interface the plugin implements:

```typescript
interface VoiceEnginePlugin {
  id: string;                         // "live-avatar"
  displayName: string;
  speak(text: string, voiceConfig: VoiceConfig): Promise<{ durationMs: number }>;
  interrupt(): Promise<void>;
  onSessionStart(sessionId: string): Promise<void>;
  onSessionEnd(sessionId: string): Promise<void>;
}
```

`speak()` is called by the BOS voice hook for each TTS utterance. It:
1. Requests TTS audio from the configured TTS backend in MP3 format.
2. Sends `{"type": "turn_start"}` on the avatar WebSocket.
3. Streams MP3 chunks to the avatar WebSocket as binary frames as they arrive.
4. Sends `{"type": "turn_end"}` when the stream completes.
5. Returns `{ durationMs }` estimated from the audio length so the voice hook knows
   when to transition back to listening state.

`interrupt()` sends `{"type": "interrupt"}` on the WebSocket immediately and cancels
any in-flight TTS stream.

---

## Plugin Routes

All routes are served under `/api/plugin/live-avatar/` via the BOS catch-all plugin
dispatch. They inherit BOS's session authentication — only authenticated users reach
them.

### `GET /api/plugin/live-avatar/session`

Initialises a session context. Proxies two requests to the avatar server:

```
GET <avatarServerUrl>/avatars      → { avatars: string[], backgrounds: string[] }
GET <avatarServerUrl>/ice-servers  → { iceServers: [...], iceTransportPolicy }
```

Returns a combined response to the browser:

```json
{
  "sessionId": "<uuid>",
  "avatars": ["elena", "marcus", ...],
  "backgrounds": ["minimal_office", ...],
  "iceServers": [...],
  "iceTransportPolicy": "all"
}
```

The `sessionId` is held in the plugin's in-memory session map. Only one session is
active at a time per BOS process (the avatar server itself enforces this with `409`).

### `POST /api/plugin/live-avatar/offer`

Relays the browser's WebRTC SDP offer to the avatar server.

Request body:
```json
{
  "sessionId": "<uuid>",
  "sdp": "<browser SDP offer>",
  "type": "offer",
  "avatarId": "elena",
  "backgroundId": "minimal_office"
}
```

Plugin forwards to the avatar server:
```
POST <avatarServerUrl>/offer
{
  "engine": { "type": "external_agent" },
  "sdp": "...",
  "type": "offer",
  "avatar_id": "elena",
  "background_id": "minimal_office"
}
```

On success: opens the WebSocket to `<avatarServerUrl>/agent/audio` with
`Authorization: Bearer <AGENT_API_TOKEN>`, sends `{"type": "session_start",
"sample_rate": 24000}` (placeholder; actual sample rate is MP3-implicit), and stores
the WebSocket on the session map entry.

Returns the SDP answer to the browser:
```json
{ "sdp": "<answer SDP>", "type": "answer" }
```

### `POST /api/plugin/live-avatar/speak`

Called by the BOS voice hook for each utterance when the live-avatar engine is
active. The route suppresses the normal TTS audio response.

Request body:
```json
{ "sessionId": "<uuid>", "text": "Hello, how can I help you?" }
```

Server-side flow:
1. Calls the configured TTS backend requesting MP3 format.
2. Sends `{"type": "turn_start"}` on the avatar WebSocket.
3. Pipes MP3 chunks to the WebSocket as binary frames as they arrive.
4. Sends `{"type": "turn_end"}` when the stream ends.
5. Returns `{ "durationMs": <estimated> }`.

Response:
```json
{ "ok": true, "durationMs": 3200 }
```

### `POST /api/plugin/live-avatar/interrupt`

Request body: `{ "sessionId": "<uuid>" }`

Sends `{"type": "interrupt"}` on the avatar WebSocket. Returns `{ "ok": true }`.

### `GET /api/plugin/live-avatar/app` and `GET /api/plugin/live-avatar/app/*`

Serves the avatar app HTML and assets directly from the plugin directory. Because
these are BOS API routes, the iframe that loads them is same-origin — no sandbox
origin restriction, full WebRTC access.

---

## Avatar App

The `app/` facet is an iframe application opened as a BOS window. Its URL is
`/api/plugin/live-avatar/app` — served by the plugin's own route handler, not by
the standard `/apps/[...slug]/` machinery, which gives it same-origin status
without needing `allow-same-origin` in the sandbox attribute.

The BOS window shell that opens the avatar app sets:

```html
<iframe
  src="/api/plugin/live-avatar/app"
  allow="autoplay"
/>
```

`allow="autoplay"` is required for the WebRTC audio and video tracks to play without
a user gesture. No `camera` or `microphone` permission is needed — the WebRTC
connection is receive-only.

### App responsibilities

1. On mount: call `GET /api/plugin/live-avatar/session` to get avatar list, ICE
   servers, and session ID.
2. Present avatar and background pickers populated from the session response.
3. On "Connect": create an `RTCPeerConnection` with the provided ICE servers. Add
   two `recvonly` transceivers (audio + video). Create an SDP offer. **Wait for
   `iceGatheringState === "complete"`** (the avatar server does not support trickle
   ICE). POST the offer to `/api/plugin/live-avatar/offer`.
4. Apply the SDP answer via `setRemoteDescription`.
5. In `ontrack`: attach video track to a `<video autoplay playsinline>` element;
   attach audio track to an `<audio autoplay>` element. Display the avatar.
6. Notify the BOS host window via `postMessage` that WebRTC is established and the
   session ID, so the voice hook knows to activate avatar mode.

### Audio coordination

When the BOS voice hook receives the `bos-avatar-ready` postMessage from the avatar
app, it enters avatar mode:
- All subsequent TTS calls are routed to `POST /api/plugin/live-avatar/speak`
  instead of the local audio player.
- The normal `Audio` element used for TTS playback is silenced / not created.
- Audio comes exclusively from the WebRTC audio track inside the avatar iframe.

When the avatar app closes or disconnects, it posts `bos-avatar-closed`, and the
voice hook reverts to the normal TTS audio player.

---

## Settings Panel

Registered via `sdk.registerSettingsPanel`. Provides a configuration section in the
BOS Settings app when the plugin is installed.

Config schema:
```json
{
  "type": "object",
  "properties": {
    "avatarServerUrl": {
      "type": "string",
      "description": "Base URL of the AVTR-1 server (e.g. http://192.168.1.10:7861)."
    },
    "agentApiToken": {
      "type": "string",
      "description": "AGENT_API_TOKEN configured on the avatar server.",
      "secret": true
    },
    "defaultAvatarId": {
      "type": "string",
      "description": "Avatar to use by default (leave blank to always prompt)."
    },
    "defaultBackgroundId": {
      "type": "string",
      "description": "Background to use by default (leave blank to always prompt)."
    }
  },
  "required": ["avatarServerUrl", "agentApiToken"]
}
```

Config is persisted in BOS's config store under the `live-avatar` namespace. The
`agentApiToken` is stored in the secrets store (never returned to the browser in
clear text).

A **Test connection** action in the settings panel calls `GET /avatars` on the
configured server and reports success/failure.

---

## WebSocket Audio Protocol

The plugin communicates with the avatar server using the protocol defined in the
AVTR-1 integration guide (`/agent/docs`).

| Frame type | Content |
|---|---|
| JSON text | `{"type": "session_start", "sample_rate": 24000}` — sent once on connect |
| JSON text | `{"type": "turn_start"}` — before each utterance |
| Binary | MP3 audio data, streamed in chunks as produced by the TTS backend |
| JSON text | `{"type": "turn_end"}` — after the last MP3 chunk |
| JSON text | `{"type": "interrupt"}` — on barge-in |

**Note:** The avatar server currently accepts PCM16LE binary frames per the
integration guide. MP3 support is being added to the avatar server; once available,
BOS can stream TTS output directly without any format conversion, reducing latency
and CPU usage. Until MP3 is available, the plugin must decode MP3 to PCM16LE
server-side before sending. The `session_start` `sample_rate` field should match the
decoded output rate (24000 Hz recommended).

---

## Network and ICE

The avatar server's `/ice-servers` response is passed through verbatim to the
browser. When the avatar server has `CLOUDFLARE_TURN_KEY_ID` and
`CLOUDFLARE_TURN_KEY_TOKEN` set in its environment, it mints short-lived TURN
credentials per session and includes them in the response. The browser uses these to
relay WebRTC media through Cloudflare's TURN servers when direct UDP is not
available — covering the case where the browser is external but the avatar server is
on an internal network.

No TURN configuration is required on the BOS side. TURN is configured entirely on
the avatar server.

---

## Session Lifecycle

```
User opens avatar app
  → GET /session           (BOS proxies /avatars + /ice-servers)
  → Avatar/background pick
  → POST /offer            (BOS relays SDP; opens WS to avatar server)
  → WebRTC established     (browser ↔ avatar server, media flows)
  → postMessage bos-avatar-ready
  → Voice hook enters avatar mode

Each agent utterance:
  → POST /speak            (BOS streams MP3 to WS)
  → Avatar lip-syncs, audio plays in iframe

User speaks (barge-in):
  → VAD detects speech
  → POST /interrupt        (BOS sends interrupt on WS)
  → Voice hook cancels TTS, starts listening

User closes avatar app:
  → postMessage bos-avatar-closed
  → Voice hook exits avatar mode (reverts to normal TTS audio)
  → Plugin closes WS session
```

---

## Marketplace Manifest Entry

```json
{
  "id": "live-avatar",
  "name": "Live Avatar",
  "description": "Lip-synced avatar powered by AVTR-1. Streams TTS audio to an avatar rendering server and shows the result as a live video in a BOS window.",
  "tags": ["voice", "avatar", "ai"],
  "voiceEngine": {
    "entrypoint": "items/live-avatar/plugin",
    "version": "0.1.0",
    "engineId": "live-avatar"
  },
  "app": {
    "entrypoint": "items/live-avatar/plugin",
    "runtime": "plugin-served",
    "version": "0.1.0",
    "icon": "Video"
  }
}
```

The `runtime: "plugin-served"` value signals to BOS that the app is not served via
the standard `/apps/[...slug]/` route but through the plugin's own registered route
at `/api/plugin/live-avatar/app`. This requires a corresponding addition to the
marketplace schema.

---

## Folder Structure (final)

```
items/live-avatar/
├── spec/
│   └── spec.md              ← this document
├── plugin/
│   ├── integration-plugin.json
│   ├── index.js             ← compiled: registers routes, voice engine, settings
│   ├── client.js            ← framework-free metadata
│   └── app/
│       ├── index.html       ← avatar display app
│       └── bundle.js        ← WebRTC logic, avatar/background picker
```

---

## Acceptance Scenarios

### S1 — Install and configure
**Given** the marketplace, **when** the user installs Live Avatar and enters the
avatar server URL + token in Settings, **then** the Test Connection button confirms
reachability and the `live-avatar` engine appears in voice settings.

### S2 — Avatar session
**Given** the plugin is configured and voice mode is active, **when** the user opens
the Live Avatar app and connects, **then** the avatar video appears and the WebRTC
ICE check shows a valid connection path (direct or via TURN relay).

### S3 — Speaking
**Given** an active avatar session, **when** the agent responds, **then** the avatar
lip-syncs to the speech and no separate TTS audio plays from the BOS host page.

### S4 — Barge-in
**Given** the avatar is mid-utterance, **when** the user speaks, **then** the avatar
stops immediately, the agent listens, and the avatar resumes with the next response.

### S5 — TURN fallback
**Given** the browser cannot reach the avatar server over direct UDP, **when** the
avatar server has Cloudflare TURN configured, **then** the WebRTC connection
succeeds via the TURN relay with no extra configuration in BOS.

### S6 — Disconnect
**Given** an active avatar session, **when** the user closes the avatar app,
**then** the voice hook silently reverts to the normal TTS audio player for the rest
of the session.

---

## Open Questions

| # | Question |
|---|---|
| OQ1 | MP3 support on the avatar server: until it lands, should the plugin decode MP3 → PCM16LE using a Node.js library (e.g. `fluent-ffmpeg` or WASM-based decoder), or block implementation on MP3 support? |
| OQ2 | Duration estimation for `speak()` return value: read MP3 frame headers for exact duration, or estimate from byte count + bitrate? |
| OQ3 | Should the avatar app be a free-floating window or docked (e.g. pinned to a corner of the chat view)? |
| OQ4 | One avatar session per BOS process (matching avatar server's single-session limit) — acceptable for the multi-user bastion deployment, or should session contention be surfaced to the user explicitly? |
