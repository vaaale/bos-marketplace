import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

// Workflow Manager — e2e coverage for the 002 scope-add's event integration:
//
//   US17 / FR-044-045  `workflow_event_types` — event-type discovery
//   US18 / FR-046-048  the `event` output type — a node that emits a BOS event
//   US16 / FR-039-043  event-TRIGGERED runs — a workflow's `triggers` array
//   FR-049             the three app surfaces: the Triggers panel, the event
//                      node config form, and the run-provenance block
//
// SCOPE & DETERMINISM — same contract as 001 and 002 (read 001's header
// first). Every assertion below is black-box against surfaces that need no
// model call at all, which is what makes an event test cheap:
//
//   1. `services/http-bridge.js` (the installed item) exposes each tool as a
//      plain REST route on the service's own bound port — including this
//      scope-add's `GET /event-types`, the app-facing face of
//      `workflow_event_types`.
//   2. BOS's own event API (`/api/events`, `/api/events/handlers`) is the
//      other side of the same conversation: the test emits the triggering
//      event through it and reads back the event an `event` node emitted.
//   3. Every workflow here is built from `ag-ui` and `event` nodes ONLY —
//      neither delegates, so no sub-agent (and no LLM) is ever spawned.
//
// PLATFORM DEPENDENCY (US16). A workflow triggers on events it does not own:
// `com.bos.e2e.workflow-trigger` is outside this item's `com.bos.workflows.*`
// root. Registering a handler for it only works because 037 resolves a
// service's statically-granted `eventNamespaces` (service.json grants
// `com.bos.*`) in `src/lib/events/api.ts` `resolveGrantedNamespaces`. 037 is
// on this same branch, so the subscription test below is expected to pass —
// but if it ever fails with a namespace/permission error, check 037 first,
// not this item.
//
// The whole file runs `serial`: it shares ONE live "workflows" service
// singleton, the real VFS `/Workflows/` folder, and the process-wide event
// kernel (see the 034 e2e lesson — parallel specs race on both).

test.describe.configure({ mode: "serial" });

const SERVICE_ID = "workflows";

/** Outside this item's owned root on purpose — see the 037 note above. */
const TRIGGER_TYPE = "com.bos.e2e.workflow-trigger";
/** Same namespace, deliberately NOT a trigger of anything (negative case). */
const NON_TRIGGER_TYPE = "com.bos.e2e.workflow-nontrigger";
/** ADR-14/FR-048b: a workflow may only EMIT under `com.bos.workflows.*`. */
const EMIT_TYPE = "com.bos.workflows.e2e.test";
/** The type the UI test adds as a trigger through the Triggers panel. */
const UI_TRIGGER_TYPE = "com.bos.e2e.ui-trigger";

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// Service lifecycle + HTTP-bridge helpers (identical to 001/002)
// ---------------------------------------------------------------------------

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
async function svcDelete(request: APIRequestContext, base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await request.delete(new URL(path, base).toString());
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

// ---------------------------------------------------------------------------
// Node builders — only the two node types that never delegate
// ---------------------------------------------------------------------------

/** `ag-ui` never delegates (executor.js returns `node.input` directly). */
function agUiNode(id: string, dependencies: string[] = [], input: unknown = { ok: true }) {
  return { id, outputType: "ag-ui", input, dependencies };
}

/** US18/FR-046 — an event node: no agentSource, `config` is its definition. */
function eventNode(id: string, eventType: string, value: Record<string, unknown>, dependencies: string[] = []) {
  return { id, outputType: "event", dependencies, config: { eventType, payload: { mode: "static", value } } };
}

// ---------------------------------------------------------------------------
// Run + event polling helpers
// ---------------------------------------------------------------------------

async function pollRunUntilTerminal(request: APIRequestContext, base: string, workflowId: string, runId: string, timeoutMs = 20000): Promise<any> {
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

/** The event kernel's grouped handler registry (contract §9) — the same shape
 *  `workflow_event_types` reads. */
async function registeredTypes(request: APIRequestContext): Promise<string[]> {
  const res = await request.get("/api/events/handlers");
  if (!res.ok()) return [];
  return Object.keys((await res.json()) as Record<string, unknown>);
}

/** Waits until the service has actually declared its handler for `type` —
 *  `handler_declare` is an async Worker→Main IPC hop after the workflow write,
 *  so emitting before it lands would dispatch to nobody. */
async function waitForSubscription(request: APIRequestContext, type: string, timeout = 20000): Promise<void> {
  await expect.poll(async () => (await registeredTypes(request)).includes(type), { timeout, intervals: [200, 400, 800] }).toBe(true);
}

async function emitEvent(request: APIRequestContext, type: string, payload: Record<string, unknown>): Promise<string> {
  const res = await request.post("/api/events", { data: { type, payload, source: { appId: "e2e", name: "Workflows e2e" } } });
  expect(res.status(), `emitting ${type}`).toBe(201);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBeTruthy();
  return body.id;
}

async function getEvent(request: APIRequestContext, id: string): Promise<any> {
  const res = await request.get(`/api/events/${encodeURIComponent(id)}`);
  expect(res.ok(), `reading event ${id}`).toBe(true);
  return res.json();
}

async function openWorkflowInApp(page: Page, name: string): Promise<void> {
  await page.goto("/apps/workflows/");
  await expect(page.getByText("Workflow Manager", { exact: true })).toBeVisible({ timeout: 15000 });
  await page.locator(".wf-card", { hasText: name }).click({ timeout: 15000 });
}

// ===========================================================================

test.describe.serial("Workflow Manager — event integration (US16-US18, FR-049)", () => {
  const createdWorkflowIds: string[] = [];
  /** Handlers this spec caused the service to declare, unregistered on teardown. */
  const subscribedTypes = new Set<string>();
  let base = "";

  test.beforeAll(async ({ request, baseURL }) => {
    await ensureServiceRunning(request);
    base = await serviceBaseUrl(request, baseURL || "http://localhost:3000");
  });

  test.afterAll(async ({ request }) => {
    // Delete through the SERVICE first: `workflow_delete` reconciles the
    // subscription set, which is what unregisters the headless handlers this
    // spec caused to be declared. The /api/fs delete below is the safety net
    // for the case where the service is unreachable (it may have been
    // restarted onto a new port by another spec), but it bypasses reconcile —
    // hence the explicit unregister loop after it.
    for (const id of createdWorkflowIds) {
      await svcDelete(request, base, `workflows/${id}`).catch(() => {});
      await request.post("/api/fs", { data: { op: "delete", path: `/Workflows/${id}-workflow.json` } }).catch(() => {});
      await request.post("/api/fs", { data: { op: "delete", path: `/Workflows/.runs/${id}` } }).catch(() => {});
    }
    for (const type of subscribedTypes) {
      await request
        .post("/api/events/unregister", { data: { handlerId: `${SERVICE_ID}:${type}`, ownerId: SERVICE_ID, eventType: type } })
        .catch(() => {});
    }
    // NOTE: emitted events themselves are NOT deleted — 034's kernel is an
    // append-only log with no delete route by design. Every type this spec
    // emits is namespaced `…e2e…` so the residue is identifiable and inert.
  });

  // -------------------------------------------------------------------------
  // US17 — event-type discovery (FR-044/FR-045)
  // -------------------------------------------------------------------------
  test.describe("US17 — workflow_event_types", () => {
    test("returns the registered event types as [{ type, handlerCount, displayName }]", async ({ request }) => {
      const { status, body } = await svcGet(request, base, "event-types");
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);

      // FR-045: an empty registry is a legitimate empty list, not an error —
      // so the shape contract is asserted per entry, not on a minimum count.
      for (const entry of body as any[]) {
        expect(Object.keys(entry).sort()).toEqual(["displayName", "handlerCount", "type"]);
        expect(typeof entry.type).toBe("string");
        expect(entry.type).toMatch(/^[a-z0-9]+(\.[a-z0-9_-]+)+$/);
        expect(typeof entry.handlerCount).toBe("number");
        expect(entry.handlerCount).toBeGreaterThan(0);
        expect(entry.displayName === null || typeof entry.displayName === "string").toBe(true);
      }

      // One entry per type, sorted by type (handlers.js sorts before it
      // returns). Deliberately NOT compared set-wise against
      // /api/events/handlers: another spec registering between the two reads
      // would make that flaky. US16 below asserts the agreement on a type
      // this spec itself owns, which is deterministic.
      const types = (body as any[]).map((e) => e.type);
      expect(new Set(types).size).toBe(types.length);
      expect(types).toEqual([...types].sort((a, b) => a.localeCompare(b)));
    });
  });

  // -------------------------------------------------------------------------
  // US18 — a node that emits a BOS event (FR-046/047/048)
  // -------------------------------------------------------------------------
  test.describe("US18 — the `event` output type", () => {
    test("an event node emits its configured event and the run completes", async ({ request }) => {
      const name = uniqueName("US18 emit workflow");
      const marker = uniqueName("marker");
      const created = await svcPost(request, base, "workflows", {
        workflow: { name, steps: [eventNode("announce", EMIT_TYPE, { marker, status: "done" })] },
      });
      expect(created.status).toBe(200);
      expect(created.body.validation?.ok).toBe(true);
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      const ran = await svcPost(request, base, `workflows/${id}/run`);
      const runId = ran.body.runId as string;
      expect(runId).toBeTruthy();

      const run = await pollRunUntilTerminal(request, base, id, runId);
      expect(run.state).toBe("completed");
      expect(run.steps?.announce?.status).toBe("completed");

      // The node's output names the event it actually emitted.
      const output = run.steps.announce.outputs ?? run.steps.announce.output;
      expect(output?.emitted).toBe(true);
      expect(output?.eventId).toBeTruthy();

      // FR-046/047: that event really is in BOS's event log, with the right
      // type, the configured payload, and the `_wf` provenance envelope.
      const event = await getEvent(request, output.eventId as string);
      expect(event.type).toBe(EMIT_TYPE);
      expect(event.payload.marker).toBe(marker);
      expect(event.payload.status).toBe("done");
      expect(event.payload._wf).toMatchObject({ workflowId: id, runId, nodeId: "announce" });
    });

    test("FR-048b: an event node emitting outside com.bos.workflows.* fails validation", async ({ request }) => {
      const { status, body } = await svcPost(request, base, "workflows", {
        workflow: { name: uniqueName("US18 bad namespace"), steps: [eventNode("nope", "com.bos.files.created", { a: 1 })] },
      });
      expect(status).toBe(200);
      const id = body.workflow_id as string;
      createdWorkflowIds.push(id);
      // The write itself is not rejected (the service saves what it is told),
      // but validation reports the namespace violation as an ERROR.
      expect(body.validation.ok).toBe(false);
      expect(body.validation.errors.join(" ")).toMatch(/com\.bos\.workflows\./);
    });
  });

  // -------------------------------------------------------------------------
  // US16 — event-TRIGGERED runs (FR-039/040/041/043)
  //
  // Depends on 037's `eventNamespaces` grant resolution — see the header note.
  // -------------------------------------------------------------------------
  test.describe("US16 — a workflow triggered by an event", () => {
    let triggeredWorkflowId = "";

    test("declaring `triggers` subscribes the service to that event type", async ({ request }) => {
      const name = uniqueName("US16 triggered workflow");
      const created = await svcPost(request, base, "workflows", {
        workflow: { name, triggers: [TRIGGER_TYPE], steps: [agUiNode("handle", [], { handled: true })] },
      });
      expect(created.status).toBe(200);
      expect(created.body.validation?.ok).toBe(true);
      // FR-039: the create result echoes the normalized trigger list back.
      expect(created.body.triggers).toEqual([TRIGGER_TYPE]);
      triggeredWorkflowId = created.body.workflow_id as string;
      createdWorkflowIds.push(triggeredWorkflowId);
      subscribedTypes.add(TRIGGER_TYPE);

      await waitForSubscription(request, TRIGGER_TYPE);

      // ...and the newly-declared handler is discoverable through the very
      // tool an author would use to find it (US17 closing the loop on US16).
      const { body } = await svcGet(request, base, "event-types");
      expect((body as any[]).map((e) => e.type)).toContain(TRIGGER_TYPE);
    });

    test("emitting the trigger type starts a run with `startSource: \"event\"`", async ({ request }) => {
      const payload = { invoice: uniqueName("inv"), amount: 42 };
      const eventId = await emitEvent(request, TRIGGER_TYPE, payload);

      // FR-040/041: a run appears, tagged with the event that caused it.
      // The poll captures the winning snapshot so the assertions below read
      // the SAME response the poll succeeded on (a second GET could race a
      // later run).
      let status: any;
      await expect
        .poll(
          async () => {
            status = (await svcGet(request, base, `workflows/${triggeredWorkflowId}/status`)).body;
            return status?.startSource;
          },
          { timeout: 20000, intervals: [250, 500, 1000] },
        )
        .toBe("event");

      expect(status.startSource).toBe("event");
      expect(status.triggerEventType).toBe(TRIGGER_TYPE);
      expect(status.triggerEventId).toBe(eventId);
      // FR-042: the triggering payload travels with the run.
      expect(status.eventContext).toMatchObject(payload);

      await pollRunUntilTerminal(request, base, triggeredWorkflowId, status.runId);

      // The provenance is durable, not just live — workflow_run_list replays
      // it from the persisted run record.
      const runList = await svcGet(request, base, `workflows/${triggeredWorkflowId}/runs`);
      const entry = (runList.body as any[]).find((r) => r.runId === status.runId);
      expect(entry).toMatchObject({ startSource: "event", triggerEventType: TRIGGER_TYPE, triggerEventId: eventId });
    });

    test("an event type nothing triggers on starts no run", async ({ request }) => {
      const before = ((await svcGet(request, base, `workflows/${triggeredWorkflowId}/runs`)).body as any[]).length;

      await emitEvent(request, NON_TRIGGER_TYPE, { ignore: true });

      // Give the kernel the same dispatch budget the positive case needed, then
      // assert nothing happened. `expect.poll(...).toBe(before)` would pass on
      // the first tick, so the wait has to be explicit.
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const after = ((await svcGet(request, base, `workflows/${triggeredWorkflowId}/runs`)).body as any[]).length;
      expect(after).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  // FR-049 — the app's three event surfaces
  // -------------------------------------------------------------------------
  test.describe("FR-049 — Triggers panel, event node config, run provenance", () => {
    test("a trigger added in the Triggers panel persists across a reload", async ({ page, request }) => {
      const name = uniqueName("FR049 triggers workflow");
      const created = await svcPost(request, base, "workflows", {
        workflow: { name, steps: [agUiNode("only", [], { ok: true })] },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);
      subscribedTypes.add(UI_TRIGGER_TYPE);

      await openWorkflowInApp(page, name);

      const panel = page.getByTestId("wf-triggers");
      await expect(panel).toBeVisible({ timeout: 15000 });
      await expect(panel).toContainText("No triggers");

      // Free-text add — the panel persists it straight through workflow_modify.
      await panel.getByLabel("New trigger event type").fill(UI_TRIGGER_TYPE);
      await panel.getByRole("button", { name: "+ Add trigger" }).click();
      await expect(panel.getByTestId("wf-trigger-chip")).toContainText(UI_TRIGGER_TYPE, { timeout: 10000 });

      // It is a real write, not local state: the service has it too.
      await expect
        .poll(async () => (await svcGet(request, base, `workflows/${id}`)).body.triggers, { timeout: 10000 })
        .toEqual([UI_TRIGGER_TYPE]);

      // ...and it survives a full reload of the app.
      await openWorkflowInApp(page, name);
      await expect(page.getByTestId("wf-triggers").getByTestId("wf-trigger-chip")).toContainText(UI_TRIGGER_TYPE, { timeout: 15000 });

      // "Browse" reads the live registry (workflow_event_types) — by now the
      // service has declared a handler for the type we just added.
      await waitForSubscription(request, UI_TRIGGER_TYPE);
      await page.getByRole("button", { name: /^Browse/ }).click();
      const list = page.getByTestId("wf-event-type-list");
      await expect(list).toBeVisible({ timeout: 10000 });
      await expect(list).toContainText(UI_TRIGGER_TYPE, { timeout: 10000 });

      // Removing it writes the empty array back.
      await page.getByTestId("wf-triggers").getByRole("button", { name: `Remove trigger ${UI_TRIGGER_TYPE}` }).click();
      await expect.poll(async () => (await svcGet(request, base, `workflows/${id}`)).body.triggers, { timeout: 10000 }).toEqual([]);
    });

    test("an event node configured in the editor persists its type and payload", async ({ page, request }) => {
      const name = uniqueName("FR049 event node workflow");
      const created = await svcPost(request, base, "workflows", {
        workflow: { name, steps: [agUiNode("seed", [], { ok: true })] },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);

      await openWorkflowInApp(page, name);
      await page.getByRole("button", { name: /^Edit / }).click();
      await page.getByRole("button", { name: "+ Add step" }).click();

      // Switching outputType to "event" swaps the agent form for the event
      // config form (the select is the only one carrying an `event` option).
      await page.locator('select:has(option[value="event"])').selectOption("event");
      const form = page.getByTestId("wf-event-config");
      await expect(form).toBeVisible();

      // Live validation: a type outside com.bos.workflows.* is refused inline.
      await form.getByLabel("Event type").fill("com.bos.files.created");
      await expect(form.getByTestId("wf-event-type-error")).toContainText("com.bos.workflows.");

      // A malformed static payload is refused inline too.
      await form.getByLabel("Static event payload").fill("{not json");
      await expect(form.getByTestId("wf-event-payload-error")).toBeVisible();

      // Now configure it properly and save.
      await form.getByLabel("Event type").fill(EMIT_TYPE);
      await expect(form.getByTestId("wf-event-type-error")).toHaveCount(0);
      await form.getByLabel("Static event payload").fill('{"from": "ui"}');
      await expect(form.getByTestId("wf-event-payload-error")).toHaveCount(0);
      await page.getByRole("button", { name: "Save", exact: true }).click();

      // Persisted into the workflow JSON in exactly the service's own shape
      // (node-model.js `normalizeEventConfig`).
      let saved: any;
      await expect
        .poll(
          async () => {
            saved = (await svcGet(request, base, `workflows/${id}`)).body;
            return (saved?.steps || []).length;
          },
          { timeout: 10000 },
        )
        .toBe(2);
      const eventStep = (saved.steps as any[]).find((s) => s.outputType === "event");
      expect(eventStep).toBeTruthy();
      expect(eventStep.config).toEqual({ eventType: EMIT_TYPE, payload: { mode: "static", value: { from: "ui" } } });

      // The graph marks it as an event node (FR-049 §4) and it survives a reload.
      await openWorkflowInApp(page, name);
      const node = page.locator(".wf-node-event");
      await expect(node).toBeVisible({ timeout: 15000 });
      await expect(node).toContainText(EMIT_TYPE);
    });

    test("an event-triggered run shows its provenance, a user run shows a minimal label", async ({ page, request }) => {
      const name = uniqueName("FR049 provenance workflow");
      const provenanceTrigger = `${TRIGGER_TYPE}-ui`;
      const created = await svcPost(request, base, "workflows", {
        workflow: { name, triggers: [provenanceTrigger], steps: [agUiNode("handle", [], { handled: true })] },
      });
      const id = created.body.workflow_id as string;
      createdWorkflowIds.push(id);
      subscribedTypes.add(provenanceTrigger);

      await waitForSubscription(request, provenanceTrigger);
      const eventId = await emitEvent(request, provenanceTrigger, { reason: "provenance ui check" });

      let runId = "";
      await expect
        .poll(
          async () => {
            const body = (await svcGet(request, base, `workflows/${id}/status`)).body;
            runId = body?.runId || "";
            return body?.startSource;
          },
          { timeout: 20000, intervals: [250, 500, 1000] },
        )
        .toBe("event");
      await pollRunUntilTerminal(request, base, id, runId);

      // The historical-replay card carries the provenance block.
      await openWorkflowInApp(page, name);
      await page.locator(".wf-run-chip", { hasText: runId.slice(4, 12) }).click({ timeout: 15000 });
      const provenance = page.getByTestId("wf-run-provenance");
      await expect(provenance).toBeVisible({ timeout: 10000 });
      await expect(provenance).toContainText("Triggered by event");
      await expect(provenance.getByTestId("wf-provenance-type")).toHaveText(provenanceTrigger);
      // The truncated event id expands to the payload that was injected.
      await page.getByRole("button", { name: "Show payload" }).click();
      await expect(provenance).toContainText("provenance ui check");
      expect(eventId).toBeTruthy();

      // A run the USER started gets the one-line label instead of the block.
      await page.getByRole("button", { name: "Exit replay" }).click();
      await page.getByRole("button", { name: /^▶ Run/ }).click();
      const liveProvenance = page.getByTestId("wf-run-provenance");
      await expect(liveProvenance).toBeVisible({ timeout: 15000 });
      await expect(liveProvenance).toContainText("Started from the app");
    });
  });
});
