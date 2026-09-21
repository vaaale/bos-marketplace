"use strict";
// Shared provider HTTP layer (NFR-003). One fetch wrapper: caller-supplied
// headers, 10 s timeout, and structured ProviderError mapping — never an
// unstructured throw. Also exports sleep() and a per-adapter pacing helper
// (a serialized queue per provider id: no two concurrent calls to the same
// adapter, minimum spacing between calls).

class ProviderError extends Error {
  // code: RATE_LIMITED | NOT_FOUND | INVALID_KEY | UNAUTHORIZED | NO_KEY | TRANSIENT | UNKNOWN
  //
  // NO_KEY and INVALID_KEY are distinct (Fix A): NO_KEY means the key slot is
  // EMPTY (checked before any request is sent) — "data source not configured".
  // INVALID_KEY means a key WAS sent and the provider rejected it (HTTP 401/403)
  // — the user has a key but it is expired/rotated/typo'd. Collapsing the two
  // into one label is exactly the silence that hid the expired-key incident.
  constructor(code, retryable, extra) {
    super((extra && extra.cause) || code);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = Boolean(retryable);
    if (extra && extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
    if (extra && extra.cause !== undefined) this.cause = extra.cause;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(res, bodyText) {
  const h = res.headers && res.headers.get && res.headers.get("retry-after");
  if (h) {
    const n = Number(h);
    if (!Number.isNaN(n)) return Math.max(0, n) * 1000;
  }
  // some providers put a retry-after hint in the JSON body
  try {
    const j = JSON.parse(bodyText);
    const v = j && (j["retry-after"] || j.retryAfter || j.retry_after);
    const n = Number(v);
    if (v !== undefined && !Number.isNaN(n)) return Math.max(0, n) * 1000;
  } catch (err) { /* not JSON */ }
  return undefined;
}

// Returns { status, text, json() } on 2xx; throws ProviderError otherwise.
async function httpRequest(url, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { headers: o.headers || {}, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new ProviderError("TRANSIENT", true, { cause: "network: " + String((err && err.message) || err) });
  }
  clearTimeout(timer);
  let text = "";
  try { text = await res.text(); } catch (err) { text = ""; }

  if (res.status === 429) {
    throw new ProviderError("RATE_LIMITED", true, {
      retryAfterMs: parseRetryAfterMs(res, text),
      cause: "HTTP 429"
    });
  }
  // A present-but-rejected key is INVALID_KEY, not NO_KEY (Fix A). 401 and 403
  // both mean "the key you sent is not accepted" — the user must re-enter or
  // rotate it, NOT "configure a data source that isn't there".
  if (res.status === 401) throw new ProviderError("INVALID_KEY", false, { cause: "HTTP 401 — key invalid or expired" });
  if (res.status === 403) throw new ProviderError("INVALID_KEY", false, { cause: "HTTP 403 — key forbidden or expired" });
  if (res.status >= 500) throw new ProviderError("TRANSIENT", true, { cause: "HTTP " + res.status });
  if (res.status === 404) throw new ProviderError("NOT_FOUND", false, { cause: "HTTP 404" });
  if (res.status >= 400) throw new ProviderError("UNKNOWN", false, { cause: "HTTP " + res.status });

  return {
    status: res.status,
    text,
    json() {
      try { return JSON.parse(text); } catch (err) { return null; }
    }
  };
}

// Serialized per-adapter pacing gate: run(fn) queues fn behind all previous
// calls for the same pacer and enforces `intervalMs` between call starts.
function makePacer(intervalMs) {
  let chain = Promise.resolve();
  let lastStart = 0;
  return function paced(fn) {
    const run = chain.then(async () => {
      const now = Date.now();
      const wait = lastStart + intervalMs - now;
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      return fn();
    });
    chain = run.then(() => undefined, () => undefined); // errors don't break the queue
    return run;
  };
}

module.exports = { ProviderError, sleep, httpRequest, makePacer };
