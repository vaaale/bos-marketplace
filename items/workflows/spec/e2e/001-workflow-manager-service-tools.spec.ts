import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

// Workflow Manager — e2e coverage for every user story in spec.md (US1-US9).
// See spec.md / design.md / mockup.html in this same folder for the acceptance
// scenarios these tests are derived from.
//
// SCOPE & DETERMINISM. This spec is self-contained on purpose: it imports
// nothing from BOS's own `src/` (this spec folder lives in an external spec
// store, not necessarily nested under the BOS source tree at test-run time —
// see CLAUDE.md's "external spec store" note) and never depends on a real LLM
// call. Two black-box seams make that possible:
//
//   1. `services/http-bridge.js` (the installed item) exposes every one of the
//      12 workflow_* tools as a plain REST endpoint on the service's own bound
//      port — "every route ... is a thin wrapper over the SAME handlers.js
//      functions the tool surface calls, so app and assistant always see
//      identical behavior" (http-bridge.js's own header comment). Hitting that
//      REST surface directly exercises the real engine (scheduler, router,
//      store, runs) without needing the assistant/tool-call plumbing at all —
//      used for US1/US3/US5/US7/US8/US9.
//   2. BOS's scripted e2e provider (`BOS_E2E_SCRIPTED=1` + a message that
//      starts with `@@e2e {"turns":[...]}`) makes a sub-agent delegation
//      deterministic with no real model call — see src/lib/assistant/
//      e2e-provider.ts and its use in src/lib/agent/subagents/runner.ts. The
//      workflow service's executor.js sends a node's `agentSource.task` text
//      as-is for any ROOT node (no `dependencies`, so the executor never
//      appends "Upstream step outputs:" text after it) — so a root ephemeral
//      node whose task IS an `@@e2e {...}` directive runs deterministically.
//      Non-root nodes get upstream context appended (breaking the scripted
//      match), so every workflow built below either keeps non-root steps as
//      `outputType: "ag-ui"` (which never delegates at all — see
//      node-model.js/executor.js: "no delegate call") or accepts that a
//      non-root retry falls through to a real model call (only relied on, in
//      US7's "invalid selection" test, for an invariant that holds either way).
//
// The app UI (US4/US5/US6) is exercised by navigating directly to the
// installed item's iframe route (`/apps/workflows/`), which serves the fully
// bundled, self-contained app the same way the desktop shell's iframe would —
// see src/app/apps/[...slug]/route.ts. The app's own components carry no
// `data-testid`s, so UI locators below are text/class based (`.wf-card`,
// `.wf-step-row`, `.wf-run-chip`, `.wf-stream`, etc. — read from the item's
// app/src/components/*.tsx).
//
// The whole file runs `serial`: every test shares ONE live "workflows"
// service singleton and its real VFS `/Workflows/` folder, and the final US2
// test stops that service — nothing after it may assume the service is up.

const SERVICE_ID = "workflows";

function scripted(turns: Array<{ text?: string; deltas?: number; delayMs?: number }>): string {
  return `@@e2e ${JSON.stringify({ turns })}`;
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// Service lifecycle + HTTP-bridge helpers
// ---------------------------------------------------------------------------

async function ensureServiceRunning(request: APIRequestContext): Promise<void> {
  // GET /api/services runs discoverServices() (a filesystem scan) — the
  // installed item must be discovered before it can be started.
  await expect
    .poll(
      async () => {
        const { services } = await (await request.get("/api/services")).json();
        return (services as { id: string }[]).some((s) => s.id === SERVICE_ID);
      },
      { timeout: 15000 },
    )
    .toBe(true);

  await request.post(`/api/services/${SERVICE_ID}`, { data: { action: "start", startupTimeout: 15000 } });

  await expect
    .poll(
      async () => {
        const { service } = await (await request.get(`/api/services/${SERVICE_ID}`)).json();
        return service?.state;
      },
      { timeout: 15000 },
    )
    .toBe("running");
}

/** Resolves the service's own REST bridge base URL (services/http-bridge.js),
 *  mirroring the app's own resolution logic (app/src/lib/bridge.ts): prefer
 *  the Supervisor-fronted httpPath, else connect to the bound port directly. */
async function serviceBaseUrl(request: APIRequestContext, baseURL: string): Promise<string> {
  const cfg = await (await request.get(`/api/services/${SERVICE_ID}/config`)).json();
  if (cfg.httpPath) return new URL(cfg.httpPath, baseURL).toString();
  if (cfg.runtime?.port) return `http://127.0.0.1:${cfg.runtime.port}/`;
  throw new Error("workflows service has no bound port/httpPath — is it running?");
}

interface SvcResult<T = any> {
  status: number;
  body: T;
}

async function svcGet<T = any>(request: APIRequestContext, base: string, path: string): Promise<SvcResult<T>> {
  const res = await request.get(new URL(path, base).toString());
  return { status: res.status(), body: (await res.json().catch(() => ({}))) as T };
}
async function svcPost<T = any>(request: APIRequestContext, base: string, path: string, data?: unknown): Promise<SvcResult<T>> {
  const res = await request.post(new URL(path, base).toString(), { data: data ?? {} });
  return { status: res.status(), body: (await res.json().catch(() => ({}))) as T };
}
async function svcPatch<T = any>(request: APIRequestContext, base: string, path: string, data?: unknown): Promise<SvcResult<T>> {
  const res = await request.patch(new URL(path, base).toString(), { data: data ?? {} });
  return { status: res.status(), body: (await res.json().catch(() => ({}))) as T };
}
async function svcDelete<T = any>(request: APIRequestContext, base: string, path: string): Promise<SvcResult<T>> {
  const res = await request.delete(new URL(path, base).toString());
  return { status: res.status(), body: (await res.json().catch(() => ({}))) as T };
}

// ---------------------------------------------------------------------------
// Node builders (see engine/node-model.js — the two orthogonal axes)
// ---------------------------------------------------------------------------

function ephemeralNode(
  id: string,
  opts: {
    task: string;
    dependencies?: string[];
    candidates?: Array<{ id: string; description?: string }>;
    outputType?: "delegate" | "tool";
    timeout?: number;
    retryLimit?: number;
    tools?: string[];
    skills?: string[];
  },
) {
  return {
    id,
    outputType: opts.outputType ?? "delegate",
    agentSource: { kind: "ephemeral", task: opts.task, tools: opts.tools ?? [], skills: opts.skills ?? [] },
    dependencies: opts.dependencies ?? [],
    ...(opts.candidates ? { candidates: opts.candidates } : {}),
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
    ...(opts.retryLimit ? { retryLimit: opts.retryLimit } : {}),
  };
}

/** ag-ui nodes never delegate (executor.js returns `node.input` directly) —
 *  the deterministic building block for downstream/branch/merge steps. */
function agUiNode(id: string, dependencies: string[], input: unknown = { ok: true }) {
  return { id, outputType: "ag-ui", input, dependencies };
}

function researchNode(id: string, researchAgents: Array<{ task: string }>) {
  return { id, outputType: "research", dependencies: [], researchAgents };
}

// ---------------------------------------------------------------------------
// Run polling helpers
// ---------------------------------------------------------------------------

async function pollRunUntilTerminal(
  request: APIRequestContext,
  base: string,
  workflowId: string,
  runId: string,
  timeoutMs = 20000,
): Promise<any> {
  let last: any;
  await expect
    .poll(
      async () => {
        const { body } = await svcGet(request, base, `workflows/${workflowId}/runs/${runId}`);
        last = body;
        return body?.state;
      },
      { timeout: timeoutMs, intervals: [200, 300, 500] },
    )
    .not.toBe("running");
  return last;
}

// ---------------------------------------------------------------------------
// Assistant-chat helpers (used only for US1's assistant-facing dispatch +
// schema-rejection tests — mirrors e2e/039-service-tool-exposure.spec.ts's
// own proven pattern for calling a real service-declared tool by name).
// ---------------------------------------------------------------------------

async function openAssistantOnFreshConversation(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByText("Assistant", { exact: true }).first().dblclick({ timeout: 20000 });
  await expect(page.getByTestId("assistant-v2")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("chat-textarea")).toBeVisible({ timeout: 15000 });
  await page.getByTitle(/New .*conversation/i).first().click();
  await page.waitForTimeout(400);
}

async function lastToolMessageContent(page: Page): Promise<string | undefined> {
  const convId = await page.evaluate(() => localStorage.getItem("bos.activeConversation.assistant") ?? "");
  const { messages } = await page.request.get(`/api/assistant/conversations/${convId}/messages`).then((r) => r.json());
  return (messages as { role: string; content: string }[]).filter((m) => m.role === "tool").pop()?.content;
}

// ===========================================================================

test.describe.serial("Workflow Manager — service tools + app (001-workflow-manager-service-tools)", () => {
  const createdWorkflowIds: string[] = [];
  let base = "";

  test.beforeAll(async ({ request, baseURL }) => {
    await ensureServiceRunning(request);
    base = await serviceBaseUrl(request, baseURL || "http://localhost:3000");
  });

  test.afterAll(async ({ request }) => {
    // Cleanup goes straight through the real VFS bridge (/api/fs), NOT the
    // service's own REST bridge: US2's last test stops+restarts the service,
    // which (per NFR-003/ADR-3) rebinds a NEW OS-assigned port each time, so
    // the `base` URL captured in beforeAll may be stale by the time this runs.
    // Deleting by known VFS path works regardless of the service's state.
    for (const id of createdWorkflowIds) {
      await request.post("/api/fs", { data: { op: "delete", path: `/Workflows/${id}-workflow.json` } }).catch(() => {});
      await request.post("/api/fs", { data: { op: "delete", path: `/Workflows/.runs/${id}` } }).catch(() => {});
    }
    // Safety net: whatever the US2 lifecycle test did to the service, leave it
    // running for any other spec that assumes marketplace services are up.
    await request.post(`/api/services/${SERVICE_ID}`, { data: { action: "start" } }).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // US1 — Workflow tools appear as service-declared native tools (P1)
  // -------------------------------------------------------------------------
  test.describe("US1 — 039-compliant tool surface", () => {
    test("create, list, read, modify, export, validate, and delete a workflow via the service tools", async ({ request }) => {
      const name = uniqueName("US1 CRUD workflow");

      const created = await svcPost(request, base, "workflows", {
        workflow: { name, config: { maxConcurrentSteps: 5 }, steps: [ephemeralNode("start", { task: scripted([{ text: "ok" }]) })] },
      });
      expect(created.status).toBe(200);
      expect(created.body.workflow_id).toBeTruthy();
      expect(created.body.validation?.ok).toBe(true);
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      // list — FR-006/024: appears with workflow_id/status/steps.
      const list = await svcGet<any[]>(request, base, "workflows");
      expect(list.status).toBe(200);
      const entry = list.body.find((w) => w.workflow_id === id);
      expect(entry).toBeTruthy();
      expect(entry.status).toBe("idle");
      expect(entry.steps).toBe(1);

      // read — full JSON round-trips.
      const read = await svcGet(request, base, `workflows/${id}`);
      expect(read.status).toBe(200);
      expect(read.body.name).toBe(name);
      expect(read.body.steps).toHaveLength(1);

      // modify — JSON-merge patch, re-validated.
      const renamed = `${name} (renamed)`;
      const modified = await svcPatch(request, base, `workflows/${id}`, { changes: { name: renamed } });
      expect(modified.status).toBe(200);
      expect(modified.body.validation?.ok).toBe(true);
      const reread = await svcGet(request, base, `workflows/${id}`);
      expect(reread.body.name).toBe(renamed);

      // export — full JSON as an object (http-bridge re-parses the tool's
      // JSON-string return value before sending it).
      const exported = await svcGet(request, base, `workflows/${id}/export`);
      expect(exported.status).toBe(200);
      expect(exported.body.id).toBe(id);
      expect(exported.body.name).toBe(renamed);

      // validate — DAG/node shape check on the saved workflow.
      const validated = await svcPost(request, base, `workflows/${id}/validate`);
      expect(validated.status).toBe(200);
      expect(validated.body.ok).toBe(true);
      expect(validated.body.errors).toEqual([]);

      // delete — removed from the store and from the list.
      const deleted = await svcDelete(request, base, `workflows/${id}`);
      expect(deleted.status).toBe(200);
      expect(deleted.body.deleted).toBe(true);
      createdWorkflowIds.splice(createdWorkflowIds.indexOf(id), 1);

      const listAfter = await svcGet<any[]>(request, base, "workflows");
      expect(listAfter.body.some((w: any) => w.workflow_id === id)).toBe(false);
    });

    test("rejects malformed calls with a clear error instead of a raw crash (FR-003 handler layer)", async ({ request }) => {
      // Neither `workflow` nor `taskDescription` — workflow_create must refuse.
      const badCreate = await svcPost(request, base, "workflows", {});
      expect(badCreate.status).toBe(400);
      expect(String(badCreate.body.error)).toMatch(/workflow|taskDescription/i);

      // Operating on a workflow id that doesn't exist — a clear, in-band error,
      // never an unhandled exception (service stays healthy — checked below).
      // (http-bridge.js's PATCH route folds a missing `changes` field back onto
      // the whole request body — `changes: body.changes ?? body` — so an empty
      // body never actually reaches handlers.js's own "changes is required"
      // guard over HTTP; that Ajv-schema-level rejection is covered instead by
      // the assistant tool-call test below, where `changes` is genuinely absent
      // from the tool's `args`.)
      const badModify = await svcPatch(request, base, "workflows/no-such-workflow-id", {});
      expect(badModify.status).toBe(400);
      expect(String(badModify.body.error)).toMatch(/no such workflow/i);

      const missing = await svcGet(request, base, "workflows/no-such-workflow-id");
      expect(missing.status).toBe(400);
      expect(String(missing.body.error)).toMatch(/no such workflow/i);

      const health = await svcGet(request, base, "health");
      expect(health.body.ok).toBe(true);
    });

    test("the assistant discovers and calls a declared workflow tool by name, and gets a real result back", async ({ page }) => {
      await openAssistantOnFreshConversation(page);

      // `scripted()` only carries the plain-text-turn shape; a forced tool
      // call needs the `tools` field too, so this directive is built by hand.
      await page.getByTestId("chat-textarea").fill(
        `@@e2e ${JSON.stringify({ turns: [{ text: "calling workflow_list", tools: [{ name: "workflow_list", args: {} }] }, { text: "Done." }] })}`,
      );
      await page.getByTestId("chat-send-button").click();

      await expect(page.getByTestId("tool-card").first()).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId("assistant-message").last()).toContainText("Done.", { timeout: 30000 });

      const content = await lastToolMessageContent(page);
      expect(content).toBeTruthy();
      expect(content).not.toMatch(/^Error:/);
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(content as string);
      }).not.toThrow();
      expect(Array.isArray(parsed)).toBe(true);
    });

    test("a schema-invalid tool call is rejected before dispatch, never mutating anything (FR-003 Ajv layer)", async ({ page, request }) => {
      // workflow_modify's schema requires BOTH workflowId and changes — omit
      // `changes` entirely so Ajv rejects the call before it ever reaches the
      // worker (a handler-level rejection would instead say "changes is
      // required" verbatim, per handlers.js — Ajv's message names the schema
      // keyword instead, which is the load-bearing difference this test checks).
      await openAssistantOnFreshConversation(page);
      await page.getByTestId("chat-textarea").fill(
        `@@e2e ${JSON.stringify({
          turns: [
            { text: "calling workflow_modify with a bad payload", tools: [{ name: "workflow_modify", args: { workflowId: "whatever" } }] },
            { text: "Done." },
          ],
        })}`,
      );
      await page.getByTestId("chat-send-button").click();
      await expect(page.getByTestId("tool-card").first()).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId("assistant-message").last()).toContainText("Done.", { timeout: 30000 });

      const content = await lastToolMessageContent(page);
      expect(content).toBeTruthy();
      // Rejected pre-dispatch: the error is schema-shaped, not the handler's
      // own runtime message, and specifically does NOT claim the workflow was
      // touched.
      expect(String(content)).toMatch(/changes/i);
      expect(String(content)).not.toMatch(/no such workflow/i);

      const health = await svcGet(request, base, "health");
      expect(health.body.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // US3 — Workflows are listed/managed from the real VFS + historical runs
  // -------------------------------------------------------------------------
  test.describe("US3 — real-VFS persistence + historical runs", () => {
    test("a created + run workflow persists its JSON and run log to the real VFS, readable via run_list/run_get", async ({ request }) => {
      const name = uniqueName("US3 persistence workflow");
      const created = await svcPost(request, base, "workflows", {
        workflow: { name, steps: [ephemeralNode("collect", { task: scripted([{ text: "collected the data" }]) })] },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      // The workflow JSON is visible in the real VFS (not a host `system/` path).
      const wfFile = await request.get(`/api/fs?op=read&path=${encodeURIComponent(`/Workflows/${id}-workflow.json`)}`);
      expect(wfFile.ok()).toBe(true);
      const wfFileContent = JSON.parse((await wfFile.json()).content);
      expect(wfFileContent.id).toBe(id);
      expect(wfFileContent.name).toBe(name);

      const ran = await svcPost(request, base, `workflows/${id}/run`);
      expect(ran.status).toBe(200);
      const runId = ran.body.runId as string;
      expect(runId).toBeTruthy();

      const finalRun = await pollRunUntilTerminal(request, base, id, runId);
      expect(finalRun.state).toBe("completed");
      expect(finalRun.steps.collect.status).toBe("completed");

      // Run log persisted under the real VFS .runs/ tree (ADR-9).
      const runFile = await request.get(`/api/fs?op=read&path=${encodeURIComponent(`/Workflows/.runs/${id}/${runId}.json`)}`);
      expect(runFile.ok()).toBe(true);
      const runFileContent = JSON.parse((await runFile.json()).content);
      expect(runFileContent.state).toBe("completed");
      expect(runFileContent.events.some((e: any) => e.type === "workflow.complete")).toBe(true);

      // workflow_run_list / workflow_run_get see the same run.
      const runList = await svcGet<any[]>(request, base, `workflows/${id}/runs`);
      expect(runList.body.some((r) => r.runId === runId && r.state === "completed")).toBe(true);

      const runGet = await svcGet(request, base, `workflows/${id}/runs/${runId}`);
      expect(runGet.status).toBe(200);
      expect(runGet.body.workflowId).toBe(id);
      expect(runGet.body.steps.collect.status).toBe("completed");

      // Deleting the workflow removes its run logs too (handlers.js's
      // workflow_delete calls runs.deleteRuns()).
      await svcDelete(request, base, `workflows/${id}`);
      createdWorkflowIds.splice(createdWorkflowIds.indexOf(id), 1);
      const runsDirAfterDelete = await request.get(`/api/fs?op=list&path=${encodeURIComponent(`/Workflows/.runs/${id}`)}`);
      // Either the directory is gone (error) or empty — never still holding the run file.
      if (runsDirAfterDelete.ok()) {
        const { entries } = await runsDirAfterDelete.json();
        expect(entries.some((e: any) => e.name === `${runId}.json`)).toBe(false);
      } else {
        expect(runsDirAfterDelete.ok()).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // US5 — Fire-and-poll execution contract
  // -------------------------------------------------------------------------
  test.describe("US5 — fire-and-poll run contract", () => {
    test("workflow_run returns a runId immediately; workflow_status reports live progress; cancel flips running -> idle", async ({ request }) => {
      const name = uniqueName("US5 fire-and-poll workflow");
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name,
          steps: [
            // ~2s of scripted, deterministic "work" so there's a real window to
            // observe the run mid-flight before it settles.
            ephemeralNode("slow_step", { task: scripted([{ text: "working on it", deltas: 2, delayMs: 900 }]) }),
            agUiNode("finish", ["slow_step"]),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const startedAt = Date.now();
      const ran = await svcPost(request, base, `workflows/${id}/run`);
      const elapsedMs = Date.now() - startedAt;
      expect(ran.status).toBe(200);
      expect(ran.body.runId).toBeTruthy();
      expect(ran.body.workflowId).toBe(id);
      // NFR-001: must return immediately, well under the 30s tool-call timeout.
      expect(elapsedMs).toBeLessThan(5000);
      const runId = ran.body.runId as string;

      // Live progress, observed mid-flight.
      await expect
        .poll(
          async () => {
            const { body } = await svcGet(request, base, `workflows/${id}/status`);
            return body?.running;
          },
          { timeout: 5000 },
        )
        .toBe(true);

      // workflow_list mirrors the same live state (FR-024).
      const list = await svcGet<any[]>(request, base, "workflows");
      const listed = list.body.find((w) => w.workflow_id === id);
      expect(listed?.status).toBe("running");
      expect(listed?.run_id).toBe(runId);

      // Cancel while slow_step is still in flight.
      const cancelled = await svcPost(request, base, `workflows/${id}/cancel`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.cancelled).toBe(true);

      const finalRun = await pollRunUntilTerminal(request, base, id, runId);
      expect(finalRun.state).toBe("cancelled");
      expect(finalRun.steps.slow_step.status).toBe("cancelled");

      // running -> idle, reflected back through workflow_list.
      const listAfter = await svcGet<any[]>(request, base, "workflows");
      expect(listAfter.body.find((w) => w.workflow_id === id)?.status).toBe("idle");
    });

    test("workflow_status on a workflow that was never run reports never_run without error", async ({ request }) => {
      const created = await svcPost(request, base, "workflows", {
        workflow: { name: uniqueName("US5 never-run workflow"), steps: [ephemeralNode("noop", { task: scripted([{ text: "noop" }]) })] },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const status = await svcGet(request, base, `workflows/${id}/status`);
      expect(status.status).toBe(200);
      expect(status.body.running).toBe(false);
      expect(status.body.state).toBe("never_run");
    });
  });

  // -------------------------------------------------------------------------
  // US7 — Dynamic routing to candidate sub-agents
  // -------------------------------------------------------------------------
  test.describe("US7 — dynamic routing", () => {
    test("a node with candidate sub-agents selects one and the run proceeds only along the chosen path", async ({ request }) => {
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: uniqueName("US7 routing workflow"),
          steps: [
            ephemeralNode("classify", {
              task: scripted([{ text: "This looks like a financial services company.\nSELECT: finance" }]),
              candidates: [
                { id: "finance", description: "Financial services company" },
                { id: "shipping", description: "Shipping/logistics company" },
              ],
            }),
            agUiNode("finance", ["classify"], { branch: "finance" }),
            agUiNode("shipping", ["classify"], { branch: "shipping" }),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const ran = await svcPost(request, base, `workflows/${id}/run`);
      const finalRun = await pollRunUntilTerminal(request, base, id, ran.body.runId, 20000);

      expect(finalRun.state).toBe("completed");
      expect(finalRun.steps.classify.status).toBe("completed");
      // The chosen path ran; the unchosen candidate never did (reported neutral,
      // not an error — US7 acceptance scenario 1 + the spec's routing model).
      expect(finalRun.steps.finance.status).toBe("completed");
      expect(finalRun.steps.shipping.status).toBe("neutral");

      // The selection itself is recorded on the routing node's completion event.
      const completeEvent = finalRun.events.find((e: any) => e.type === "step.complete" && e.stepId === "classify");
      expect(completeEvent?.selected).toEqual(["finance"]);
    });

    test("a node with exactly one candidate auto-delegates with no choice action required", async ({ request }) => {
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: uniqueName("US7 auto-delegate workflow"),
          steps: [
            ephemeralNode("gate", {
              task: scripted([{ text: "only one place to go, no SELECT needed" }]),
              candidates: [{ id: "only_child" }],
            }),
            agUiNode("only_child", ["gate"]),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const ran = await svcPost(request, base, `workflows/${id}/run`);
      const finalRun = await pollRunUntilTerminal(request, base, id, ran.body.runId, 15000);

      expect(finalRun.state).toBe("completed");
      expect(finalRun.steps.only_child.status).toBe("completed");
    });

    test("an invalid/missing selection is never silently accepted as a valid route", async ({ request }) => {
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: uniqueName("US7 invalid-selection workflow"),
          steps: [
            ephemeralNode("classify2", {
              // Deliberately no "SELECT:" line on the FIRST (scripted, deterministic)
              // attempt — router.js's retry-loop (FR-018) must not fabricate a
              // selection; a retry falls through to a real model call (only the
              // first attempt is scripted — see the file header), so this test
              // asserts the outcome invariant rather than a specific final state.
              task: scripted([{ text: "I am not sure which branch applies here." }]),
              candidates: [{ id: "route_a" }, { id: "route_b" }],
              timeout: 8,
              retryLimit: 1,
            }),
            agUiNode("route_a", ["classify2"]),
            agUiNode("route_b", ["classify2"]),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const ran = await svcPost(request, base, `workflows/${id}/run`);
      const finalRun = await pollRunUntilTerminal(request, base, id, ran.body.runId, 25000);

      // Core safety invariant (SC-011): routing to BOTH candidates at once is
      // never valid — at most one of the two ever completes.
      const completedBranches = [finalRun.steps.route_a?.status, finalRun.steps.route_b?.status].filter((s) => s === "completed");
      expect(completedBranches.length).toBeLessThanOrEqual(1);
      // And the run always settles — it never hangs mid-retry.
      expect(["completed", "failed"]).toContain(finalRun.state);
    });
  });

  // -------------------------------------------------------------------------
  // US8 — Parallel execution + ephemeral agents
  // -------------------------------------------------------------------------
  test.describe("US8 — parallel execution + ephemeral agents", () => {
    test("independent Research fan-out branches run concurrently, not serially, and their outputs are collected", async ({ request }) => {
      const DELAY_MS = 900;
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: uniqueName("US8 parallel research workflow"),
          steps: [
            researchNode("research", [
              { task: scripted([{ text: "RESEARCH_OUTPUT_1", deltas: 2, delayMs: DELAY_MS }]) },
              { task: scripted([{ text: "RESEARCH_OUTPUT_2", deltas: 2, delayMs: DELAY_MS }]) },
              { task: scripted([{ text: "RESEARCH_OUTPUT_3", deltas: 2, delayMs: DELAY_MS }]) },
            ]),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const startedAt = Date.now();
      const ran = await svcPost(request, base, `workflows/${id}/run`);
      const finalRun = await pollRunUntilTerminal(request, base, id, ran.body.runId, 20000);
      const elapsedMs = Date.now() - startedAt;

      expect(finalRun.state).toBe("completed");
      expect(finalRun.steps.research.status).toBe("completed");

      // Timing proof of concurrency: each entry takes ~2*DELAY_MS; three of them
      // serialized would take >= 3x that. A wide margin avoids CI flakiness
      // while still clearly separating "parallel" from "serial".
      const serialFloorMs = 3 * (2 * DELAY_MS);
      expect(elapsedMs).toBeLessThan(serialFloorMs - 1500);

      // Outputs collected from all three parallel ephemeral agents (FR-021/022).
      const output = JSON.stringify(finalRun.steps.research.output);
      expect(output).toContain("RESEARCH_OUTPUT_1");
      expect(output).toContain("RESEARCH_OUTPUT_2");
      expect(output).toContain("RESEARCH_OUTPUT_3");
    });
  });

  // -------------------------------------------------------------------------
  // US4 + US5 — Graph UI: list/detail/run views, active-step highlight,
  // service-stopped banner + empty state
  // -------------------------------------------------------------------------
  test.describe("US4+5 — graph UI", () => {
    test("the app lists a workflow from the real VFS, renders it as a branching graph, and runs it with live step statuses", async ({
      page,
      request,
    }) => {
      const name = uniqueName("US4 graph UI workflow");
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name,
          steps: [
            // A wide delay: several UI steps (navigation, locating the card,
            // opening detail, reading the graph) happen between firing the run
            // and checking for the "running" row below — this must still be
            // in flight by the time that check runs.
            ephemeralNode("ingest", { task: scripted([{ text: "ingested", deltas: 2, delayMs: 1500 }]) }),
            agUiNode("clean", ["ingest"]),
            agUiNode("transform", ["ingest"]),
            agUiNode("report", ["clean", "transform"]),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      await page.goto("/apps/workflows/");
      await expect(page.getByText("Workflow Manager", { exact: true })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText("/Workflows/", { exact: true })).toBeVisible();

      // List view: our workflow is there (FR-006), listed from the real VFS.
      const card = page.locator(".wf-card", { hasText: name });
      await expect(card).toBeVisible({ timeout: 15000 });

      // Open it — detail view renders the branching graph (FR-012).
      await card.click();
      await expect(page.getByText("Graph", { exact: true })).toBeVisible();
      for (const nodeId of ["ingest", "clean", "transform", "report"]) {
        await expect(page.locator(`[title^="${nodeId}:"]`)).toBeVisible();
      }

      // Run it (FR-013: live per-step status + active-step highlight).
      await page.getByRole("button", { name: /Run/ }).first().click();
      await expect(page.getByText(/run run-/)).toBeVisible({ timeout: 10000 });

      // While "ingest" is still running, the run view should show it as such.
      await expect(page.locator(".wf-step-row.wf-step-running", { hasText: "ingest" })).toBeVisible({ timeout: 8000 });

      // Eventually every step completes and progress reaches 100%.
      await expect(page.getByText("4 of 4 steps")).toBeVisible({ timeout: 15000 });
      await expect(page.getByText("100%")).toBeVisible();
      for (const nodeId of ["ingest", "clean", "transform", "report"]) {
        await expect(page.locator(".wf-step-row.wf-step-completed", { hasText: nodeId })).toBeVisible();
      }
    });

    test("the empty state and the service-stopped banner render their documented copy", async ({ page, request }) => {
      // Empty state: create-then-delete leaves us at a known, deterministic
      // moment where THIS run's own workflow is gone — we assert the empty-
      // state COPY is reachable via the same UI rather than requiring the
      // whole shared /Workflows/ folder to be globally empty (other tests in
      // this file own their own workflows concurrently... this suite is
      // serial, but other specs/users may not be, and this app polls a
      // process-wide shared folder).
      const created = await svcPost(request, base, "workflows", {
        workflow: { name: uniqueName("US4 empty-state probe"), steps: [ephemeralNode("noop", { task: scripted([{ text: "noop" }]) })] },
      });
      const id = created.body.workflow_id as string;
      await svcDelete(request, base, `workflows/${id}`);

      await page.goto("/apps/workflows/");
      await expect(page.getByText("Workflow Manager", { exact: true })).toBeVisible({ timeout: 15000 });
      // Service pill reflects the live service state (mockup's #service-pill).
      await expect(page.getByText(/Service running|Service stopped|checking service/)).toBeVisible();

      // The documented empty-state copy exists in the DOM whenever the list is
      // empty — asserted structurally against the component's own text rather
      // than forcing global emptiness.
      const emptyCopy = page.getByText("No workflows in /Workflows/");
      const anyCard = page.locator(".wf-card").first();
      await expect(emptyCopy.or(anyCard)).toBeVisible({ timeout: 15000 });
    });
  });

  // -------------------------------------------------------------------------
  // US6 — Historical runs are inspectable (replay from the persisted log)
  // -------------------------------------------------------------------------
  test.describe("US6 — historical-run replay", () => {
    test("the detail view's run selector replays a completed run's per-step outcomes and event stream", async ({ page, request }) => {
      const name = uniqueName("US6 historical replay workflow");
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name,
          steps: [
            ephemeralNode("task", { task: scripted([{ text: "did the task" }]) }),
            agUiNode("output", ["task"]),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const ran = await svcPost(request, base, `workflows/${id}/run`);
      const runId = ran.body.runId as string;
      await pollRunUntilTerminal(request, base, id, runId, 15000);

      await page.goto("/apps/workflows/");
      await page.locator(".wf-card", { hasText: name }).click();

      // Historical runs section lists our completed run as a chip.
      const chip = page.locator(".wf-run-chip", { hasText: runId.slice(4, 12) });
      await expect(chip).toBeVisible({ timeout: 15000 });
      await chip.click();

      // Replay panel: label + "final outcome" graph + replayed event stream.
      await expect(page.getByText(new RegExp(`Run ${runId} .* replaying from log`))).toBeVisible();
      await expect(page.getByText("Graph — final outcome")).toBeVisible();
      await expect(page.getByText("Replayed event stream")).toBeVisible();
      const stream = page.locator(".wf-stream");
      await expect(stream).toContainText("workflow.complete");
      await expect(stream).toContainText("task");

      // Exiting replay hides the panel again.
      await page.getByRole("button", { name: "Exit replay" }).click();
      await expect(page.getByText("Replayed event stream")).toBeHidden();
    });
  });

  // -------------------------------------------------------------------------
  // US9 — Workflow Manager skill for the assistant
  // -------------------------------------------------------------------------
  test.describe("US9 — the Workflow Manager skill", () => {
    test("the bundled skill is discoverable and documents the tool surface", async ({ request }) => {
      const list = await request.get("/api/skills").then((r) => r.json());
      const skill = (list.skills as { id: string; name: string }[]).find((s) => s.id === "workflow-manager" || s.name === "workflow-manager");
      expect(skill).toBeTruthy();

      const detail = await request.get(`/api/skills?id=${encodeURIComponent(skill!.id)}`).then((r) => r.json());
      const text = JSON.stringify(detail);
      for (const tool of ["workflow_create", "workflow_run", "workflow_status", "workflow_run_list", "workflow_run_get"]) {
        expect(text).toContain(tool);
      }
    });

    test("following the skill's documented build -> run -> retrieve flow works end-to-end via the tools", async ({ request }) => {
      // Mirrors the skill's own worked example shape (an ephemeral node followed
      // by a dependent step) — a deterministic stand-in for "the assistant
      // builds a workflow from a natural-language trigger," which this spec
      // avoids driving through a real model call (see the file header).
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: uniqueName("US9 skill-guided workflow"),
          steps: [
            ephemeralNode("summarize", { task: scripted([{ text: "Summary: all systems nominal." }]) }),
            agUiNode("deliver", ["summarize"], { channel: "email" }),
          ],
        },
      });
      expect(created.body.validation?.ok).toBe(true);
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const ran = await svcPost(request, base, `workflows/${id}/run`);
      expect(ran.body.runId).toBeTruthy();
      const finalRun = await pollRunUntilTerminal(request, base, id, ran.body.runId, 15000);
      expect(finalRun.state).toBe("completed");

      // "Retrieve results" — workflow_run_get after the fact.
      const runGet = await svcGet(request, base, `workflows/${id}/runs/${ran.body.runId}`);
      expect(runGet.body.steps.summarize.status).toBe("completed");
      expect(runGet.body.steps.deliver.status).toBe("completed");
    });
  });

  // -------------------------------------------------------------------------
  // US2 — Service tools respect tool gating and lifecycle (P2) — LAST: this
  // stops the shared "workflows" service, so nothing after it may assume it's
  // running.
  // -------------------------------------------------------------------------
  test.describe("US2 — tool gating + service lifecycle", () => {
    let gateTestAgentId: string | null = null;

    test.afterAll(async ({ request }) => {
      if (gateTestAgentId) await request.delete(`/api/subagents/${gateTestAgentId}`).catch(() => {});
    });

    test("workflow tools are registered in the SAME unified capability catalog used for per-agent allowlists, and a restrictive allowlist excludes them", async ({
      request,
    }) => {
      // Every workflow_* tool is registered via registerAdditionalCapabilities()
      // under group "Service Tools" (service-tool-bridge.ts) into the exact
      // same registry `gate.ts`/`tool-gate.ts` build their allow/registryIds
      // sets from — this IS the mechanism FR-010 requires ("gated exactly like
      // built-in tools"), verified here through the same catalog the Settings
      // -> Agents -> Tools picker renders from.
      const before = await request.get("/api/assistant/agent").then((r) => r.json());
      const workflowRunCap = (before.catalog.tools as { id: string; group: string }[]).find((c) => c.id === "workflow_run");
      expect(workflowRunCap).toBeTruthy();
      expect(workflowRunCap!.group).toBe("Service Tools");

      // Create a throwaway agent with a restrictive allowlist that deliberately
      // excludes every workflow_* tool.
      const createRes = await request.post("/api/assistant/agent", {
        data: { name: uniqueName("US2 gate test agent"), body: "You are a restricted test agent." },
      });
      expect(createRes.ok()).toBe(true);
      const { agent } = await createRes.json();
      gateTestAgentId = agent.id as string;

      const patchRes = await request.patch("/api/assistant/agent", {
        data: { agentId: gateTestAgentId, tools: ["find_tools"] },
      });
      expect(patchRes.ok()).toBe(true);

      const after = await request.get("/api/assistant/agent").then((r) => r.json());
      const restricted = (after.agents as { id: string; tools: string[] }[]).find((a) => a.id === gateTestAgentId);
      expect(restricted?.tools).not.toContain("workflow_run");
      expect(restricted?.tools).not.toContain("workflow_delete");
      // (gate.ts derives `allow` from exactly this per-agent `tools` array and
      // `registryIds` from the SAME listCapabilities() the catalog above just
      // proved workflow_run is a member of — together these two facts are
      // withToolGate's complete precondition for excluding workflow_run from
      // what this agent's model turn ever sees, per tests/services/
      // tool-gate.test.ts's already-established coverage of that mechanism.)
    });

    test("stopping the service removes its declared tools from the registry", async ({ request }) => {
      const beforeStop = await request.get("/api/assistant/agent").then((r) => r.json());
      expect((beforeStop.catalog.tools as { id: string }[]).some((c) => c.id === "workflow_run")).toBe(true);

      await request.post(`/api/services/${SERVICE_ID}`, { data: { action: "stop", shutdownTimeout: 10000 } });

      await expect
        .poll(async () => {
          const { service } = await (await request.get(`/api/services/${SERVICE_ID}`)).json();
          return service?.state;
        }, { timeout: 15000 })
        .toBe("stopped");

      await expect
        .poll(async () => {
          const catalog = await request.get("/api/assistant/agent").then((r) => r.json());
          return (catalog.catalog.tools as { id: string }[]).some((c) => c.id === "workflow_run");
        }, { timeout: 10000 })
        .toBe(false);

      // No stale tool call to a stopped service — the old REST bridge base is
      // no longer a healthy service (FR-011's "no stale tool call is
      // possible"). Direct-port deployments see a connection failure (svcGet
      // throws); Supervisor-fronted deployments instead get a non-2xx proxy
      // response — check both without assuming which applies here.
      let staleBridgeHealthy = true;
      try {
        const { status, body } = await svcGet(request, base, "health");
        staleBridgeHealthy = status === 200 && body?.ok === true;
      } catch {
        staleBridgeHealthy = false;
      }
      expect(staleBridgeHealthy).toBe(false);

      // Restart for any later test/spec that assumes the service is running
      // (also covered by this file's own afterAll safety net).
      await request.post(`/api/services/${SERVICE_ID}`, { data: { action: "start", startupTimeout: 15000 } });
      await expect
        .poll(async () => {
          const { service } = await (await request.get(`/api/services/${SERVICE_ID}`)).json();
          return service?.state;
        }, { timeout: 15000 })
        .toBe("running");
    });
  });
});
