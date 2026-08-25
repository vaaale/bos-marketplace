// http-bridge.js — a small loopback REST server the Workflow Manager APP
// talks to directly (list/read/create/modify/run/status/cancel/delete/
// export/validate/run_list/run_get), bound on the service's own configurable
// port (config/workflows.json's `port`, default 0). This is separate from
// the 039 tool_call/worker-IPC path the assistant uses — the app is not the
// assistant, so it needs an ordinary HTTP surface, mirroring the
// okf-knowledge-base config-app's http-bridge.js pattern. Every route below
// is a thin wrapper over the SAME handlers.js functions the tool surface
// calls, so app and assistant always see identical behavior.

const { URL } = require("url");

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function createRequestHandler({ handlers, getRuntime }) {
  return async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, "http://internal");
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (parts.length === 1 && parts[0] === "health" && req.method === "GET") {
        return send(res, 200, { ok: true, ...getRuntime() });
      }

      if (parts.length === 1 && parts[0] === "workflows") {
        if (req.method === "GET") return send(res, 200, await handlers.workflow_list());
        if (req.method === "POST") {
          const body = await readBody(req);
          return send(res, 200, await handlers.workflow_create(body));
        }
        return send(res, 405, { error: "method not allowed" });
      }

      if (parts.length === 2 && parts[0] === "workflows") {
        const workflowId = decodeURIComponent(parts[1]);
        if (req.method === "GET") return send(res, 200, await handlers.workflow_read({ workflowId }));
        if (req.method === "PATCH") {
          const body = await readBody(req);
          return send(res, 200, await handlers.workflow_modify({ workflowId, changes: body.changes ?? body }));
        }
        if (req.method === "DELETE") return send(res, 200, await handlers.workflow_delete({ workflowId }));
        return send(res, 405, { error: "method not allowed" });
      }

      if (parts.length === 3 && parts[0] === "workflows") {
        const workflowId = decodeURIComponent(parts[1]);
        const action = parts[2];
        if (action === "run" && req.method === "POST") {
          const body = await readBody(req);
          return send(res, 200, await handlers.workflow_run({ workflowId, ...body }));
        }
        if (action === "cancel" && req.method === "POST") return send(res, 200, await handlers.workflow_cancel({ workflowId }));
        if (action === "status" && req.method === "GET") return send(res, 200, await handlers.workflow_status({ workflowId }));
        if (action === "export" && req.method === "GET") return send(res, 200, JSON.parse(await handlers.workflow_export({ workflowId })));
        if (action === "validate" && req.method === "POST") return send(res, 200, await handlers.workflow_validate({ workflowId }));
        if (action === "runs" && req.method === "GET") return send(res, 200, await handlers.workflow_run_list({ workflowId }));
        return send(res, 404, { error: `no such route: ${req.method} ${url.pathname}` });
      }

      if (parts.length === 4 && parts[0] === "workflows" && parts[2] === "runs" && req.method === "GET") {
        const workflowId = decodeURIComponent(parts[1]);
        const runId = decodeURIComponent(parts[3]);
        return send(res, 200, await handlers.workflow_run_get({ workflowId, runId }));
      }

      return send(res, 404, { error: `no such route: ${req.method} ${url.pathname}` });
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  };
}

module.exports = { createRequestHandler };
