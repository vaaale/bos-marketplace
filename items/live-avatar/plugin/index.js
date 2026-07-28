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
  const fs = require("fs");
  const path = require("path");
  const APP_DIR = path.join(__dirname, "app");

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

  // ── Voice engine ───────────────────────────────────────────────────────────

  registerVoiceEngine({
    id: PLUGIN_ID,
    displayName: "Live Avatar (AVTR-1)",
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
      if (!activeWs || activeWs.readyState !== 1 /* OPEN */) {
        return { durationMs: 0 };
      }

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
        body: JSON.stringify({ text, _bypassEngine: "openai-compatible" }),
      });

      if (!ttsRes.ok) throw new Error(`TTS fetch failed: ${ttsRes.status}`);
      const ttsResult = await ttsRes.json();
      if (!ttsResult.audioUrl) {
        // Engine had no audio to send (misconfigured TTS) — return silence.
        return { durationMs: ttsResult.durationMs ?? 0 };
      }

      const base64 = ttsResult.audioUrl.split(",")[1];
      const mp3Buffer = Buffer.from(base64, "base64");
      const durationMs = ttsResult.durationMs ?? Math.round((mp3Buffer.length * 8 / 128000) * 1000);

      activeWs.send(JSON.stringify({ type: "turn_start" }));
      const CHUNK = 8192;
      for (let offset = 0; offset < mp3Buffer.length; offset += CHUNK) {
        activeWs.send(mp3Buffer.slice(offset, offset + CHUNK));
      }
      activeWs.send(JSON.stringify({ type: "turn_end" }));

      return { durationMs };
    },

    async interrupt(_sessionId) {
      if (activeWs && activeWs.readyState === 1) {
        activeWs.send(JSON.stringify({ type: "interrupt" }));
      }
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
      return Response.json({ ...avatars, ...ice });
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

      ws.send(JSON.stringify({ type: "session_start", sample_rate: 24000 }));
      activeWs = ws;

      ws.on("close", () => { if (activeWs === ws) activeWs = null; });
      ws.on("error", (err) => console.error("[live-avatar] WS error:", err.message));

      return Response.json(answer);
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  });

  registerRoute(PLUGIN_ID, "POST", "/interrupt", async () => {
    if (activeWs && activeWs.readyState === 1) activeWs.send(JSON.stringify({ type: "interrupt" }));
    return Response.json({ ok: true });
  });

  // Static app routes — served same-origin via the catch-all plugin route.
  function serveFile(filePath) {
    if (!fs.existsSync(filePath)) return new Response("Not found", { status: 404 });
    const mimeTypes = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css" };
    const mimeType = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    return new Response(fs.readFileSync(filePath), { headers: { "Content-Type": mimeType } });
  }

  registerRoute(PLUGIN_ID, "GET", "/app",           () => serveFile(path.join(APP_DIR, "index.html")));
  registerRoute(PLUGIN_ID, "GET", "/app/bundle.js", () => serveFile(path.join(APP_DIR, "bundle.js")));
  registerRoute(PLUGIN_ID, "GET", "/app/styles.css",() => serveFile(path.join(APP_DIR, "styles.css")));

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
