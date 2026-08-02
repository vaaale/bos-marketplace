"use strict";

// Live Avatar BOS Plugin — factory-function pattern.
// The BOS loader calls this with the SDK object; no require("#bos-plugin-sdk") needed.

module.exports = function createPlugin(sdk) {
  const {
    registerRoute, unregisterRoutes,
    registerVoiceEngine, unregisterVoiceEngine,
    registerSettingsPanel, unregisterSettingsPanel,
    readConfig,
  } = sdk;

  const PLUGIN_ID = "live-avatar";
  /** Wire format declared to the avatar server — BOS TTS engines emit mp3. */
  const AUDIO_FORMAT = "mp3";
  const fs = require("fs");
  const path = require("path");
  const SURFACE_DIR = path.join(__dirname, "surface");

  // ── Helpers ─────────────────────────────────────────────────────────────────

  async function getCfg() {
    return readConfig(PLUGIN_ID);
  }

  async function getAvatarServerUrl() {
    const cfg = await getCfg();
    return (cfg.avatarServerUrl || process.env.LIVE_AVATAR_SERVER_URL || "").replace(/\/+$/, "");
  }

  async function getAgentApiToken() {
    const cfg = await getCfg();
    return cfg.agentApiToken || process.env.LIVE_AVATAR_AGENT_API_TOKEN || "";
  }

  // ── Session state ──────────────────────────────────────────────────────────

  let activeWs = null;

  function closeWs() {
    if (activeWs) { try { activeWs.close(); } catch {} activeWs = null; }
  }

  /** The avatar is streaming only while the agent-audio socket is open. */
  function wsOpen() {
    return !!activeWs && activeWs.readyState === 1;
  }

  /** Push one utterance to the avatar as a turn of chunked audio frames. The
   *  server decodes them as AUDIO_FORMAT (declared in session_start), so audio
   *  in any other format renders as noise — reject it loudly instead. */
  function sendTurn(audio) {
    if (!/^audio\/(mpeg|mp3)$/.test(audio.mime)) {
      throw new Error(
        `Live Avatar streams mp3, but the TTS engine returned "${audio.mime || "unknown"}" — ` +
        "set the TTS output format to mp3 in Settings → Voice.",
      );
    }
    activeWs.send(JSON.stringify({ type: "turn_start" }));
    const CHUNK = 8192;
    for (let offset = 0; offset < audio.buffer.length; offset += CHUNK) {
      activeWs.send(audio.buffer.slice(offset, offset + CHUNK));
    }
    activeWs.send(JSON.stringify({ type: "turn_end" }));
  }

  function parseDataUrl(dataUrl) {
    const [header, base64] = dataUrl.split(",");
    const mime = (/^data:([^;]+)/.exec(header) || [])[1] || "";
    return { mime, buffer: Buffer.from(base64 ?? "", "base64") };
  }

  function estimateDurationMs(audioBuffer) {
    return Math.round((audioBuffer.length * 8 / 128000) * 1000);
  }

  // ── Voice engine ───────────────────────────────────────────────────────────

  registerVoiceEngine({
    id: PLUGIN_ID,
    displayName: "Live Avatar (AVTR-1)",
    // BOS hosts this in its presence window and drives its lifecycle (036): the
    // page auto-connects when told to, reports its aspect ratio and whether it is
    // really playing, and carries no controls of its own.
    surface: { url: `/api/plugin/${PLUGIN_ID}/surface`, label: "Live Avatar" },
    configSchema: {
      type: "object",
      properties: {
        avatarServerUrl:     { type: "string", description: "Base URL of the AVTR-1 server (e.g. http://192.168.1.10:7861)." },
        agentApiToken:       { type: "string", description: "AGENT_API_TOKEN from the avatar server .env." },
        defaultAvatarId:     { type: "string", description: "Default avatar id." },
        defaultBackgroundId: { type: "string", description: "Default background id." },
      },
    },

    async onSessionStart(sessionId) {
      console.log(`[live-avatar] session start: ${sessionId}`);
    },

    async onSessionEnd(sessionId) {
      console.log(`[live-avatar] session end: ${sessionId}`);
      closeWs();
    },

    async speak(text, _config, _sessionId) {
      if (!wsOpen()) return { durationMs: 0 };

      const baseUrl = await getAvatarServerUrl();
      if (!baseUrl) throw new Error("Live Avatar: avatarServerUrl is not configured.");

      // Call BOS's own TTS route — but we need to avoid infinite recursion
      // since live-avatar IS the selected engine. We POST directly to the
      // openai-compatible engine's upstream by calling it as an internal fetch.
      // BOS listens on port 3000 by default; adapt if NEXT_PORT is set.
      const bosPort = process.env.NEXT_PORT || process.env.PORT || "3000";
      const ttsRes = await fetch(`http://localhost:${bosPort}/api/voice/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, _bypassEngine: true }),
      });

      if (!ttsRes.ok) throw new Error(`TTS fetch failed: ${ttsRes.status}`);
      const ttsResult = await ttsRes.json();
      if (!ttsResult.audioUrl) {
        // Engine had no audio to send (misconfigured TTS) — return silence.
        return { durationMs: ttsResult.durationMs ?? 0 };
      }

      const audio = parseDataUrl(ttsResult.audioUrl);
      sendTurn(audio);
      return { durationMs: ttsResult.durationMs ?? estimateDurationMs(audio.buffer) };
    },

    // Audio sink: while the avatar is connected it speaks every utterance,
    // whichever TTS engine the user has selected.
    isSinkActive() {
      return wsOpen();
    },

    async playAudio(audio, _sessionId) {
      if (!wsOpen()) return;
      sendTurn(parseDataUrl(audio.dataUrl));
    },

    async interrupt(_sessionId) {
      if (wsOpen()) activeWs.send(JSON.stringify({ type: "interrupt" }));
    },
  });

  // ── Routes ─────────────────────────────────────────────────────────────────

  registerRoute(PLUGIN_ID, "GET", "/session", async () => {
    const baseUrl = await getAvatarServerUrl();
    if (!baseUrl) {
      return Response.json({ error: "avatarServerUrl is not configured. Set it in Settings → Live Avatar." }, { status: 503 });
    }
    try {
      const [avatarsRes, iceRes] = await Promise.all([
        fetch(`${baseUrl}/avatars`),
        fetch(`${baseUrl}/ice-servers`),
      ]);
      if (!avatarsRes.ok) throw new Error(`/avatars: ${avatarsRes.status}`);
      if (!iceRes.ok) throw new Error(`/ice-servers: ${iceRes.status}`);
      const [avatars, ice] = await Promise.all([avatarsRes.json(), iceRes.json()]);
      // Defaults travel with the session so the surface never has to ask the user
      // which face to wear — that is configuration (Settings → Live Avatar).
      const cfg = await getCfg();
      return Response.json({
        ...avatars,
        ...ice,
        defaultAvatarId: cfg.defaultAvatarId || "",
        defaultBackgroundId: cfg.defaultBackgroundId || "",
      });
    } catch (err) {
      return Response.json({ error: `Avatar server error: ${err.message}` }, { status: 502 });
    }
  });

  registerRoute(PLUGIN_ID, "POST", "/offer", async (req) => {
    const body = await req.json();
    const baseUrl = await getAvatarServerUrl();
    const token = await getAgentApiToken();
    if (!baseUrl) return Response.json({ error: "avatarServerUrl not configured." }, { status: 503 });

    try {
      const offerRes = await fetch(`${baseUrl}/offer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine: { type: "external_agent" },
          sdp: body.sdp,
          type: body.type ?? "offer",
          avatar_id: body.avatarId,
          background_id: body.backgroundId,
        }),
      });
      if (!offerRes.ok) {
        const text = await offerRes.text().catch(() => String(offerRes.status));
        return Response.json({ error: `Avatar server rejected offer: ${text}` }, { status: offerRes.status });
      }
      const answer = await offerRes.json();

      closeWs();
      const WebSocket = require("ws");
      const wsUrl = baseUrl.replace(/^http/, "ws") + "/agent/audio";
      const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });

      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
        setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
      });

      // The server decodes binary frames as pcm16 unless told otherwise, which
      // turns BOS's mp3 stream into static. sample_rate is ignored for mp3 —
      // the stream is self-describing.
      ws.send(JSON.stringify({ type: "session_start", format: AUDIO_FORMAT }));
      activeWs = ws;

      ws.on("close", () => { if (activeWs === ws) activeWs = null; });
      ws.on("error", (err) => console.error("[live-avatar] WS error:", err.message));

      return Response.json(answer);
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  });

  // Static surface files — served same-origin via the catch-all plugin route.
  function serveFile(filePath) {
    if (!fs.existsSync(filePath)) return new Response("Not found", { status: 404 });
    const mimeTypes = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css" };
    const mimeType = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    return new Response(fs.readFileSync(filePath), { headers: { "Content-Type": mimeType } });
  }

  registerRoute(PLUGIN_ID, "GET", "/surface", () => serveFile(path.join(SURFACE_DIR, "index.html")));

  // ── Settings panel ─────────────────────────────────────────────────────────

  registerSettingsPanel({
    pluginId: PLUGIN_ID,
    label: "Live Avatar",
    icon: "Video",
    order: 50,
    configSchema: {
      type: "object",
      properties: {
        avatarServerUrl:     { type: "string", description: "Base URL of the AVTR-1 server, e.g. http://192.168.1.10:7861." },
        agentApiToken:       { type: "string", description: "AGENT_API_TOKEN from the avatar server .env." },
        defaultAvatarId:     { type: "string", description: "Default avatar id (leave blank to pick in the app)." },
        defaultBackgroundId: { type: "string", description: "Default background id (leave blank to pick in the app)." },
      },
      required: ["avatarServerUrl", "agentApiToken"],
    },
    secretFields: ["agentApiToken"],
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  return {
    async activate(ctx) {
      ctx.log.info("live-avatar plugin activated");
    },
    async deactivate(ctx) {
      closeWs();
      unregisterRoutes(PLUGIN_ID);
      unregisterVoiceEngine(PLUGIN_ID);
      unregisterSettingsPanel(PLUGIN_ID);
      ctx.log.info("live-avatar plugin deactivated");
    },
  };
};
