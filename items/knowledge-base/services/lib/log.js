"use strict";

// Logging for this worker-thread service. ServiceManager.ts spawns the worker
// with `stdout: true, stderr: true` and pipes both streams into
// dataDir()/logs/services/knowledge-base.log (tailed by ServiceLogViewer.tsx,
// readable via GET /api/services/knowledge-base/logs) — so plain console.*
// calls ARE the service's log channel; nothing fancier is needed. Every
// swallowed error (a `.catch(() => ...)` or empty `catch {}`) must go through
// one of these so it's never silently dropped (BOS policy — no error may be
// swallowed without at least a log line).

function fmt(level, message, extra) {
  const suffix = extra !== undefined ? ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}` : "";
  return `[knowledge-base] [${level}] ${message}${suffix}`;
}

function debug(message, extra) {
  console.log(fmt("debug", message, extra));
}

function info(message, extra) {
  console.log(fmt("info", message, extra));
}

function warn(message, extra) {
  console.warn(fmt("warn", message, extra));
}

function error(message, err) {
  const extra = err instanceof Error ? err.message : err;
  console.error(fmt("error", message, extra));
}

module.exports = { debug, info, warn, error };
