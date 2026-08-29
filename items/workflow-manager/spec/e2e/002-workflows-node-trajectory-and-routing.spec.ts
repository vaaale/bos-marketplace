import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

// Workflow Manager — e2e coverage for the US10-US15 scope-add:
//
//   US10  the node trajectory panel (agent-debug surface, live + historical)
//   US11  branch routing: structured selection, Option A propagation, the
//         zero-executed-leaves guard, and candidate-topology validation
//   US12  an ephemeral node's declared tools really are granted to its agent,
//         and fan-out outputs are consumed as structured data (no file handoff)
//   US13  live per-step run state (status/attempt/current action/sub-agents/
//         agent trace) through the tools AND the service's GET /run/<runId>
//   US14  dry-run/fixture mode
//   US15  per-step timeout fail-fast
//
// SCOPE & DETERMINISM — same contract as 001 (read its header first). Three
// black-box seams keep this file free of any real model call:
//
//   1. `services/http-bridge.js` exposes every tool as REST on the service's
//      own bound port, so the real engine runs without the assistant.
//   2. BOS's scripted e2e provider (`BOS_E2E_SCRIPTED=1` + a task that STARTS
//      with `@@e2e {...}`) makes one delegation deterministic. Only ROOT nodes
//      (no dependencies, no routing instruction appended) keep the directive
//      as the exact task text, so only root nodes are scripted here.
//   3. Dry-run FIXTURES (US14/FR-037) substitute a node's output with no
//      delegation at all — including a routing node's structured
//      `select_branch` signal. This is how every routing assertion below stays
//      deterministic now that a routing node's task carries an appended
//      selection instruction (which would break the `@@e2e` prefix match).
//
// The whole file runs `serial`: it shares ONE live "workflows" service
// singleton and the real VFS `/Workflows/` folder.

const SERVICE_ID = "workflows";

function scripted(turns: Array<{ text?: string; deltas?: number; delayMs?: number; tools?: Array<{ name: string; args?: unknown }> }>): string {
  return `@@e2e ${JSON.stringify({ turns })}`;
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function ensureServiceRunning(request: APIRequestContext): Promise<void> {
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

async function serviceBaseUrl(request: APIRequestContext, baseURL: string): Promise<string> {
  const cfg = await (await request.get(`/api/services/${SERVICE_ID}/config`)).json();
  if (cfg.httpPath) return new URL(cfg.httpPath, baseURL).toString();
  if (cfg.runtime?.port) return `http://127.0.0.1:${cfg.runtime.port}/`;
  throw new Error("workflows service has no bound port/httpPath — is it running?");
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function svcGet(request: APIRequestContext, base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await request.get(new URL(path, base).toString());
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}
async function svcPost(request: APIRequestContext, base: string, path: string, data?: unknown): Promise<{ status: number; body: any }> {
  const res = await request.post(new URL(path, base).toString(), { data: data ?? {} });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

function ephemeralNode(
  id: string,
  opts: {
    task: string;
    dependencies?: string[];
    candidates?: Array<{ id: string; description?: string }>;
    tools?: string[];
    skills?: string[];
    timeout?: number;
    retryLimit?: number;
  },
) {
  return {
    id,
    outputType: "delegate",
    agentSource: { kind: "ephemeral", task: opts.task, tools: opts.tools ?? [], skills: opts.skills ?? [] },
    dependencies: opts.dependencies ?? [],
    ...(opts.candidates ? { candidates: opts.candidates } : {}),
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
    ...(opts.retryLimit ? { retryLimit: opts.retryLimit } : {}),
  };
}

function agUiNode(id: string, dependencies: string[], input: unknown = { ok: true }) {
  return { id, outputType: "ag-ui", input, dependencies };
}

async function pollRunUntilTerminal(request: APIRequestContext, base: string, workflowId: string, runId: string, timeoutMs = 25000): Promise<any> {
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

async function openWorkflowInApp(page: Page, name: string): Promise<void> {
  await page.goto("/apps/workflows/");
  await expect(page.getByText("Workflow Manager", { exact: true })).toBeVisible({ timeout: 15000 });
  await page.locator(".wf-card", { hasText: name }).click({ timeout: 15000 });
}

test.describe.serial("Workflow Manager — node trajectory, routing, live state (US10-US15)", () => {
  const createdWorkflowIds: string[] = [];
  let base = "";

  test.beforeAll(async ({ request, baseURL }) => {
    await ensureServiceRunning(request);
    base = await serviceBaseUrl(request, baseURL || "http://localhost:3000");
  });

  test.afterAll(async ({ request }) => {
    // Clean up straight through the real VFS bridge (the service may have been
    // restarted onto a new port by another spec by now).
    for (const id of createdWorkflowIds) {
      await request.post("/api/fs", { data: { op: "delete", path: `/Workflows/${id}-workflow.json` } }).catch(() => {});
      await request.post("/api/fs", { data: { op: "delete", path: `/Workflows/.runs/${id}` } }).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // US13 — live per-step state (this also seeds the fixtures US10's UI tests
  // read, so it runs first).
  // -------------------------------------------------------------------------
  test.describe("US13 — live run progress is observable", () => {
    test("workflow_status returns a populated per-step map with attempts, current action, sub-agents and agent trace", async ({ request }) => {
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: uniqueName("US13 live status"),
          steps: [
            // A root node that streams slowly, so the run is genuinely
            // in-progress while we poll (12 deltas x 400ms ≈ 5s).
            ephemeralNode("slow", { task: scripted([{ text: "working through the analysis", deltas: 12, delayMs: 400 }]) }),
            {
              id: "fanout",
              outputType: "research",
              dependencies: [],
              researchAgents: [
                { task: scripted([{ text: "FAST FINDING", deltas: 1 }]) },
                { task: scripted([{ text: "SLOW FINDING", deltas: 10, delayMs: 400 }]) },
              ],
            },
            agUiNode("done", ["slow", "fanout"]),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const ran = await svcPost(request, base, `workflows/${id}/run`);
      const runId = ran.body.runId as string;

      // FR-036: NEVER `steps: {}` — the live map is populated from the start.
      let live: any;
      await expect
        .poll(
          async () => {
            const { body } = await svcGet(request, base, `workflows/${id}/status`);
            live = body;
            return Boolean(body?.steps?.slow?.status === "running" && body?.steps?.fanout?.subAgents);
          },
          { timeout: 20000, intervals: [200, 300] },
        )
        .toBe(true);

      expect(live.running).toBe(true);
      expect(live.runId).toBe(runId);
      expect(Object.keys(live.steps).sort()).toEqual(["done", "fanout", "slow"]);
      expect(live.steps.slow.attempt).toBe(1);
      expect(typeof live.steps.slow.currentAction).toBe("string");
      expect(live.steps.slow.currentAction.length).toBeGreaterThan(0);
      expect(live.steps.done.status).toBe("pending");

      // The executed prompt is live too (US10 scenario 6 / FR-026).
      expect(String(live.steps.slow.agentTrace?.prompt)).toContain("working through the analysis");

      // Per-sub-agent fan-out status identifies the straggler (FR-022).
      const subAgents = Object.values(live.steps.fanout.subAgents) as any[];
      expect(subAgents.length).toBe(2);
      expect(subAgents.every((sa) => ["pending", "running", "completed", "failed"].includes(sa.status))).toBe(true);

      // The service's own live endpoint returns the SAME projection, and
      // `?since=` tails only the newer events (this is what the app polls).
      const direct = await svcGet(request, base, `run/${runId}`);
      expect(direct.status).toBe(200);
      expect(direct.body.runId).toBe(runId);
      expect(Object.keys(direct.body.steps).length).toBe(3);
      const tail = await svcGet(request, base, `run/${runId}?since=${direct.body.seq}`);
      expect(tail.body.events.every((e: any) => e.seq > direct.body.seq)).toBe(true);
      expect(Object.keys(tail.body.steps).length).toBe(3);

      const finalRun = await pollRunUntilTerminal(request, base, id, runId, 30000);
      expect(finalRun.state).toBe("completed");
      const finishedSubAgents = Object.values(finalRun.steps.fanout.subAgents) as any[];
      expect(finishedSubAgents.every((sa) => sa.status === "completed")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // US11 — routing is correct, structured and safe
  // -------------------------------------------------------------------------
  test.describe("US11 — branch routing", () => {
    test("Option A: a shared step between the branch point and the leaves runs; only the selected leaf executes", async ({ request }) => {
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: uniqueName("US11 option A"),
          steps: [
            ephemeralNode("classify", {
              task: "Classify the signal and select the matching branch.",
              candidates: [{ id: "alarm", description: "raise an alarm" }, { id: "quiet", description: "stay quiet" }],
            }),
            // `render` depends on the routing node but is NOT a candidate — it
            // must run regardless of the selection (the exact node that used to
            // block the whole downstream graph).
            agUiNode("render", ["classify"], { rendered: true }),
            agUiNode("alarm", ["render"], { alarm: true }),
            agUiNode("quiet", ["render"], { quiet: true }),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const ran = await svcPost(request, base, `workflows/${id}/run`, {
        dryRun: true,
        fixtures: { classify: { select_branch: { selected: ["alarm"] } } },
      });
      const finalRun = await pollRunUntilTerminal(request, base, id, ran.body.runId);

      expect(finalRun.state).toBe("completed");
      expect(finalRun.steps.render.status).toBe("completed");
      expect(finalRun.steps.alarm.status).toBe("completed");
      expect(finalRun.steps.quiet.status).toBe("skipped");
      expect(finalRun.steps.quiet.reason).toBe("branch-not-selected");
      expect(finalRun.selected.classify).toEqual(["alarm"]);
      expect(finalRun.events.some((e: any) => e.type === "step.skip" && e.stepId === "quiet")).toBe(true);
    });

    test("a selected branch that executes zero leaves reports completed_with_warnings, never a plain completed", async ({ request }) => {
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: uniqueName("US11 zero leaves"),
          steps: [
            ephemeralNode("classify", { task: "Classify and select.", candidates: [{ id: "first" }, { id: "second" }] }),
            agUiNode("first", ["classify"], { first: true }),
            // `second` was selected but can only run after `first`, which the
            // same selection skipped — so the branch performs nothing at all.
            agUiNode("second", ["first"], { second: true }),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const ran = await svcPost(request, base, `workflows/${id}/run`, {
        dryRun: true,
        fixtures: { classify: { select_branch: { selected: ["second"] } } },
      });
      const finalRun = await pollRunUntilTerminal(request, base, id, ran.body.runId);

      expect(finalRun.state).toBe("completed_with_warnings");
      expect(finalRun.steps.first.status).toBe("skipped");
      expect(finalRun.steps.second.status).toBe("neutral");
      const warning = finalRun.events.find((e: any) => e.type === "workflow.branch.skipped");
      expect(warning).toBeTruthy();
      expect(warning.stepId).toBe("classify");
      expect(warning.selected).toEqual(["second"]);
    });

    test("workflow_validate reports candidate-topology errors (FR-033)", async ({ request }) => {
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: uniqueName("US11 topology"),
          steps: [
            ephemeralNode("classify", { task: "classify", candidates: [{ id: "alarm" }, { id: "quiet" }] }),
            agUiNode("alarm", ["classify"]),
            agUiNode("quiet", ["classify"]),
            // `publish` is ungated yet depends on a gated leaf — silently
            // blocked whenever `alarm` is not selected.
            agUiNode("publish", ["alarm"]),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const validation = await svcPost(request, base, `workflows/${id}/validate`, {});
      expect(validation.body.ok).toBe(false);
      expect(validation.body.errors.join(" ")).toContain("ambiguously both a gated candidate leaf");

      // …and a run of it is refused before any work happens.
      const refused = await svcPost(request, base, `workflows/${id}/run`);
      expect(refused.status).toBe(400);
      expect(String(refused.body.error)).toContain("failed validation");
    });
  });

  // -------------------------------------------------------------------------
  // US12 — ephemeral tool fidelity + structured fan-out handoff
  // -------------------------------------------------------------------------
  test.describe("US12 — declared tools and structured hand-off", () => {
    test("an ephemeral node's declared tool is genuinely granted to the spawned agent", async ({ request }) => {
      // `file_edit` is a server-executable VFS tool, so it survives the
      // headless delegation path end to end — proving the node's declared
      // allowlist really reaches the spawned agent's gate. (file_read /
      // file_write travel the same declared-allowlist path; executor.test.js
      // asserts the exact tools/deferredTools/skills forwarding for them.)
      const path = `/Documents/wf-tool-fidelity-${Date.now().toString(36)}.md`;
      await request.post("/api/fs", { data: { op: "write", path, content: "BEFORE" } });

      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: uniqueName("US12 tool fidelity"),
          steps: [
            ephemeralNode("edit", {
              task: scripted([{ text: "editing the file", tools: [{ name: "file_edit", args: { path, find: "BEFORE", replace: "AFTER" } }] }, { text: "done" }]),
              tools: ["file_edit"],
            }),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const ran = await svcPost(request, base, `workflows/${id}/run`);
      const finalRun = await pollRunUntilTerminal(request, base, id, ran.body.runId, 30000);
      expect(finalRun.state).toBe("completed");

      // The tool really executed — the file changed, with no run_command fallback.
      const read = await request.get(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
      expect((await read.json()).content).toBe("AFTER");

      // …and the call is visible in the node's agent trace (FR-028).
      const toolCalls = finalRun.steps.edit.agentTrace?.toolCalls ?? [];
      expect(toolCalls.some((c: any) => c.name === "file_edit")).toBe(true);

      await request.post("/api/fs", { data: { op: "delete", path } }).catch(() => {});
    });

    test("fan-out outputs are handed to a dependent step as structured data — no file handoff required", async ({ request }) => {
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: uniqueName("US12 structured handoff"),
          steps: [
            { id: "research", outputType: "research", dependencies: [], researchAgents: [{ task: "investigate A" }, { task: "investigate B" }] },
            ephemeralNode("merge", { task: "Merge the research findings into one report.", dependencies: ["research"] }),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const ran = await svcPost(request, base, `workflows/${id}/run`, {
        dryRun: true,
        fixtures: {
          research: [
            { label: "A", output: "FINDING-ALPHA" },
            { label: "B", output: "FINDING-BETA" },
          ],
          merge: "merged report",
        },
      });
      const finalRun = await pollRunUntilTerminal(request, base, id, ran.body.runId);

      expect(finalRun.state).toBe("completed");
      // The fan-out output is stored as first-class structured data…
      expect(Array.isArray(finalRun.steps.research.outputs)).toBe(true);
      expect(finalRun.steps.research.outputs).toHaveLength(2);
      // …and reaches the dependent node INLINE in its executed prompt.
      const mergePrompt = String(finalRun.steps.merge.agentTrace?.prompt ?? "");
      expect(mergePrompt).toContain("FINDING-ALPHA");
      expect(mergePrompt).toContain("FINDING-BETA");
      expect(mergePrompt).toContain("2 result(s)");
    });
  });

  // -------------------------------------------------------------------------
  // US14 / US15 — dry run + timeouts
  // -------------------------------------------------------------------------
  test.describe("US14/US15 — fast iteration and fail-fast", () => {
    test("a dry run evaluates the whole graph in seconds and leaves default behavior untouched", async ({ request }) => {
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: uniqueName("US14 dry run"),
          steps: [
            // Real execution of this node would stream for ~20s.
            ephemeralNode("expensive", { task: scripted([{ text: "a long investigation", deltas: 40, delayMs: 500 }]) }),
            agUiNode("after", ["expensive"], { ok: true }),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const startedAt = Date.now();
      const ran = await svcPost(request, base, `workflows/${id}/run`, { dryRun: true, fixtures: { expensive: "CANNED FINDING" } });
      expect(ran.body.dryRun).toBe(true);
      const finalRun = await pollRunUntilTerminal(request, base, id, ran.body.runId, 15000);
      const elapsed = Date.now() - startedAt;

      expect(finalRun.state).toBe("completed");
      expect(finalRun.steps.expensive.outputs).toBe("CANNED FINDING");
      expect(finalRun.steps.after.status).toBe("completed");
      expect(elapsed).toBeLessThan(10000); // NFR-006: a small fraction of the real run
    });

    test("a step that exceeds its per-step timeout fails fast with a timeout reason", async ({ request }) => {
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: uniqueName("US15 step timeout"),
          steps: [
            // Streams for ~20s against a 2s per-step timeout.
            ephemeralNode("hangs", { task: scripted([{ text: "never finishing", deltas: 40, delayMs: 500 }]), timeout: 2, retryLimit: 1 }),
            agUiNode("after", ["hangs"]),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const startedAt = Date.now();
      const ran = await svcPost(request, base, `workflows/${id}/run`);
      const finalRun = await pollRunUntilTerminal(request, base, id, ran.body.runId, 20000);

      expect(finalRun.state).toBe("failed");
      expect(finalRun.steps.hangs.status).toBe("failed");
      expect(String(finalRun.steps.hangs.error)).toMatch(/timed out after 2s/);
      expect(finalRun.steps.hangs.timedOut).toBe(true);
      expect(finalRun.steps.after.status).toBe("neutral");
      expect(Date.now() - startedAt).toBeLessThan(15000);
      const failEvent = finalRun.events.find((e: any) => e.type === "step.fail" && e.stepId === "hangs");
      expect(failEvent.reason).toBe("step-timeout");
    });
  });

  // -------------------------------------------------------------------------
  // US10 — the node trajectory panel
  // -------------------------------------------------------------------------
  test.describe("US10 — node trajectory panel", () => {
    const name = uniqueName("US10 trajectory workflow");
    let workflowId = "";
    let historicalRunId = "";

    test.beforeAll(async ({ request }) => {
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name,
          steps: [
            ephemeralNode("ingest", { task: scripted([{ text: "raw.csv (12,480 rows)" }]) }),
            agUiNode("clean", ["ingest"], { cleaned: true }),
            ephemeralNode("classify", { task: "Classify and select a branch.", dependencies: ["clean"], candidates: [{ id: "alarm" }, { id: "quiet" }] }),
            agUiNode("alarm", ["classify"], { alarm: true }),
            agUiNode("quiet", ["classify"], { quiet: true }),
          ],
        },
      });
      workflowId = created.body.workflow_id as string;
      createdWorkflowIds.push(workflowId);

      const ran = await svcPost(request, base, `workflows/${workflowId}/run`, {
        dryRun: true,
        fixtures: { classify: { select_branch: { selected: ["alarm"] } } },
      });
      historicalRunId = ran.body.runId as string;
      await pollRunUntilTerminal(request, base, workflowId, historicalRunId, 30000);
    });

    test("clicking a node in a HISTORICAL run opens the panel with that node's replayed trajectory", async ({ page }) => {
      await openWorkflowInApp(page, name);

      const chip = page.locator(".wf-run-chip", { hasText: historicalRunId.slice(4, 12) });
      await expect(chip).toBeVisible({ timeout: 15000 });
      await chip.click();
      await expect(page.getByText("Graph — final outcome")).toBeVisible();
      await expect(page.getByText("click a node to debug it")).toBeVisible();

      // The panel is closed until a node is clicked (FR-025).
      await expect(page.locator(".wf-traj-panel")).toHaveCount(0);

      await page.locator('[title^="ingest:"]').click();
      const panel = page.locator(".wf-traj-panel");
      await expect(panel).toBeVisible();
      await expect(panel.getByText("Node trajectory")).toBeVisible();
      await expect(panel.getByText("agent debug")).toBeVisible();
      await expect(panel).toContainText("ingest");
      // Replayed agent execution: the executed prompt, the response, and the
      // ordered lifecycle events with timestamps (FR-026/FR-028).
      await expect(panel.getByText("Executed prompt")).toBeVisible();
      await expect(panel.getByText("Agent response")).toBeVisible();
      await expect(panel.getByText("Lifecycle events")).toBeVisible();
      await expect(panel).toContainText("step.start");
      await expect(panel).toContainText("step.complete");
      await expect(panel.getByText("Output / artifact")).toBeVisible();

      // Clicking a different node switches the panel (scenario 3)…
      await page.locator('[title^="classify:"]').click();
      await expect(panel).toContainText("classify");
      await expect(panel.getByText("Selected branch")).toBeVisible();
      await expect(panel).toContainText("alarm");

      // …a never-ran node shows that it has no events (scenario 4)…
      await page.locator('[title^="quiet:"]').click();
      await expect(panel).toContainText("skipped");

      // …and the panel is dismissible, then re-openable by clicking a node.
      await panel.getByTitle("Close").click();
      await expect(page.locator(".wf-traj-panel")).toHaveCount(0);
      await page.locator('[title^="ingest:"]').click();
      await expect(page.locator(".wf-traj-panel")).toBeVisible();
    });

    test("the divider resizes the panel horizontally within its 260-680px bounds", async ({ page }) => {
      await openWorkflowInApp(page, name);
      await page.locator(".wf-run-chip", { hasText: historicalRunId.slice(4, 12) }).click();
      await page.locator('[title^="ingest:"]').click();

      const panel = page.locator(".wf-traj-panel");
      await expect(panel).toBeVisible();
      const before = (await panel.boundingBox())!.width;

      const handle = page.locator(".wf-resize-handle");
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();

      const after = (await panel.boundingBox())!.width;
      expect(after).toBeGreaterThan(before); // dragging left widens the panel
      expect(after).toBeGreaterThanOrEqual(260);
      expect(after).toBeLessThanOrEqual(680);
    });

    test("the panel updates live during a run, and the redundant per-step status list is gone", async ({ page, request }) => {
      const liveName = uniqueName("US10 live trajectory");
      const created = await svcPost(request, base, "workflows", {
        workflow: {
          name: liveName,
          steps: [
            ephemeralNode("slow", { task: scripted([{ text: "streaming the answer", deltas: 16, delayMs: 400 }]) }),
            agUiNode("after", ["slow"]),
          ],
        },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      await openWorkflowInApp(page, liveName);
      await page.getByRole("button", { name: /Run/ }).first().click();
      await expect(page.getByText(/run run-/)).toBeVisible({ timeout: 15000 });

      // FR-027: no per-step status list under the graph any more.
      await expect(page.locator(".wf-step-row")).toHaveCount(0);
      await expect(page.getByText("click a node to debug it")).toBeVisible();

      await page.locator('[title^="slow:"]').click();
      const panel = page.locator(".wf-traj-panel");
      await expect(panel).toBeVisible();
      // Live: the running status, a current-action line, and the executed
      // prompt are all visible WHILE the agent is still working (scenario 7).
      await expect(panel.locator(".wf-chip-running")).toBeVisible({ timeout: 10000 });
      await expect(panel.getByText("currently")).toBeVisible();
      await expect(panel.getByText("Executed prompt")).toBeVisible();
      await expect(panel).toContainText("streaming the answer");

      // It then settles into the completed trajectory without any reload.
      await expect(panel.locator(".wf-chip-completed")).toBeVisible({ timeout: 30000 });
      await expect(panel.getByText("Lifecycle events")).toBeVisible();
    });
  });
});
