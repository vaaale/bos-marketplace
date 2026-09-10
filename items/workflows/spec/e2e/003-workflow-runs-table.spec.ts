import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

// Workflow Manager — e2e coverage for the US19 scope-add: the detail view's
// historical runs as a datetime-descending TABLE with per-row + select-all
// selection and a bulk delete of the persisted run logs, backed by the new
// `workflow_run_delete` tool (one handler, two invoke faces — the 039
// tool_call for the assistant and POST /workflows/<id>/runs/delete on the
// service's own REST bridge for the app).
//
// Acceptance scenarios covered (US19 1–6):
//   1. terminal runs render as a table sorted by datetime descending, with
//      datetime / run id / final-state columns
//   2. a row checkbox toggles just that run (and never opens the replay)
//   3. the header select-all selects all rows; a second click deselects all
//   4. Delete removes exactly the selected run logs from the REAL VFS, leaves
//      the workflow definition byte-identical, drops the rows from the table,
//      and closes the replay view if the inspected run was among them
//   5. with nothing selected, Delete is disabled
//   6. `workflow_run_delete` called directly against the service removes the
//      log and returns { workflowId, deleted, results[] } (idempotently)
//
// SCOPE & DETERMINISM — same contract as 001/002 (read 001's header first).
// Every workflow here is ag-ui-only, so runs settle in milliseconds with no
// model call and no delegate mock. The file runs `serial`: it shares ONE live
// "workflows" service singleton and the real VFS /Workflows/ folder.

const SERVICE_ID = "workflows";

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

function runLogPath(workflowId: string, runId: string): string {
  return `/Workflows/.runs/${workflowId}/${runId}.json`;
}

/** stat over the REAL VFS — the run-log existence oracle scenario 4/6 need. */
async function vfsFileExists(request: APIRequestContext, path: string): Promise<boolean> {
  const res = await request.get(`/api/fs?op=stat&path=${encodeURIComponent(path)}`);
  return res.status() === 200;
}

async function readDefinition(request: APIRequestContext, workflowId: string): Promise<string> {
  const res = await request.get(`/api/fs?op=read&path=${encodeURIComponent(`/Workflows/${workflowId}-workflow.json`)}`);
  expect(res.status()).toBe(200);
  return String((await res.json()).content);
}

/** Run to a PERSISTED terminal log: the run log is written strictly after the
 *  run settles, so once stat succeeds the next sequential run can start (the
 *  single-active-run guard is already clear) and the table/VFS agree. */
async function runToPersisted(request: APIRequestContext, base: string, workflowId: string): Promise<string> {
  const ran = await svcPost(request, base, `workflows/${workflowId}/run`);
  expect(ran.status).toBe(200);
  const runId = ran.body.runId as string;
  await expect.poll(() => vfsFileExists(request, runLogPath(workflowId, runId)), { timeout: 15000, intervals: [100, 200, 300] }).toBe(true);
  // Distinct startedAt milliseconds keep the datetime-desc order assertable.
  await new Promise((r) => setTimeout(r, 30));
  return runId;
}

async function openWorkflowInApp(page: Page, name: string): Promise<void> {
  await page.goto("/apps/workflows/");
  await expect(page.getByText("Workflow Manager", { exact: true })).toBeVisible({ timeout: 15000 });
  await page.locator(".wf-card", { hasText: name }).click({ timeout: 15000 });
}

test.describe.serial("Workflow Manager — historical runs table + bulk delete (US19)", () => {
  const createdWorkflowIds: string[] = [];
  let base = "";
  const name = uniqueName("US19 runs table");
  let workflowId = "";
  // Oldest → newest; the table must render them newest-first.
  let run1 = "";
  let run2 = "";
  let run3 = "";

  test.beforeAll(async ({ request, baseURL }) => {
    await ensureServiceRunning(request);
    base = await serviceBaseUrl(request, baseURL || "http://localhost:3000");

    const created = await svcPost(request, base, "workflows", {
      workflow: { name, steps: [{ id: "a", outputType: "ag-ui", input: { ok: true }, dependencies: [] }] },
    });
    workflowId = created.body.workflow_id as string;
    createdWorkflowIds.push(workflowId);

    run1 = await runToPersisted(request, base, workflowId);
    run2 = await runToPersisted(request, base, workflowId);
    run3 = await runToPersisted(request, base, workflowId);
  });

  test.afterAll(async ({ request }) => {
    // Clean up straight through the real VFS bridge (the service may have been
    // restarted onto a new port by another spec by now).
    for (const id of createdWorkflowIds) {
      await request.post("/api/fs", { data: { op: "delete", path: `/Workflows/${id}-workflow.json` } }).catch(() => {});
      await request.post("/api/fs", { data: { op: "delete", path: `/Workflows/.runs/${id}` } }).catch(() => {});
    }
  });

  test("scenario 1 — completed runs render as a datetime-descending table with datetime, run id and final-state columns", async ({ page }) => {
    await openWorkflowInApp(page, name);

    const rows = page.locator(".wf-runs-row");
    await expect(rows).toHaveCount(3, { timeout: 15000 });

    // Newest first: run3, run2, run1.
    await expect(rows.nth(0)).toHaveAttribute("data-run-id", run3);
    await expect(rows.nth(1)).toHaveAttribute("data-run-id", run2);
    await expect(rows.nth(2)).toHaveAttribute("data-run-id", run1);

    // Column headers per the mockup contract.
    const table = page.locator(".wf-runs-table");
    await expect(table.getByText("Datetime")).toBeVisible();
    await expect(table.getByText("Run", { exact: true })).toBeVisible();
    await expect(table.getByText("Final state")).toBeVisible();
    await expect(table.getByText("Duration")).toBeVisible();

    // Row content: relative + absolute datetime, the run id, a state chip, and
    // a derived duration (never a persisted field).
    const first = rows.nth(0);
    await expect(first.locator(".wf-runs-when")).toContainText(/ago/);
    await expect(first.locator(".wf-runs-id")).toContainText(`#${run3.slice(4, 12)}`);
    await expect(first.locator(".wf-pill")).toHaveText("completed");
  });

  test("scenario 2 — a row checkbox toggles just that run, without opening the replay", async ({ page }) => {
    await openWorkflowInApp(page, name);
    const rows = page.locator(".wf-runs-row");
    await expect(rows).toHaveCount(3, { timeout: 15000 });

    const target = page.locator(`.wf-runs-row[data-run-id="${run2}"] .wf-runs-row-checkbox`);
    await target.check();
    await expect(target).toBeChecked();
    await expect(page.locator(`.wf-runs-row[data-run-id="${run1}"] .wf-runs-row-checkbox`)).not.toBeChecked();
    await expect(page.locator(`.wf-runs-row[data-run-id="${run3}"] .wf-runs-row-checkbox`)).not.toBeChecked();
    await expect(page.locator(".wf-runs-delete-btn")).toHaveText(/Delete \(1\)/);

    // The checkbox cell stops propagation — no replay opened.
    await expect(page.locator(".wf-card-history")).toHaveCount(0);

    // A partial selection puts the header checkbox into the native
    // indeterminate (mixed) state.
    await expect
      .poll(() => page.locator(".wf-runs-select-all").evaluate((el) => (el as HTMLInputElement).indeterminate))
      .toBe(true);

    await target.uncheck();
    await expect(target).not.toBeChecked();
    await expect(page.locator(".wf-runs-delete-btn")).toHaveText(/Delete \(0\)/);
  });

  test("scenario 3 — the header select-all selects every row; a second click deselects all", async ({ page }) => {
    await openWorkflowInApp(page, name);
    await expect(page.locator(".wf-runs-row")).toHaveCount(3, { timeout: 15000 });

    const all = page.locator(".wf-runs-select-all");
    await all.check();
    for (const id of [run1, run2, run3]) {
      await expect(page.locator(`.wf-runs-row[data-run-id="${id}"] .wf-runs-row-checkbox`)).toBeChecked();
    }
    await expect(page.locator(".wf-runs-delete-btn")).toHaveText(/Delete \(3\)/);
    await expect.poll(() => all.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(false);

    await all.uncheck();
    for (const id of [run1, run2, run3]) {
      await expect(page.locator(`.wf-runs-row[data-run-id="${id}"] .wf-runs-row-checkbox`)).not.toBeChecked();
    }
    await expect(page.locator(".wf-runs-delete-btn")).toHaveText(/Delete \(0\)/);
  });

  test("scenario 5 — with nothing selected, Delete is disabled", async ({ page }) => {
    await openWorkflowInApp(page, name);
    await expect(page.locator(".wf-runs-row")).toHaveCount(3, { timeout: 15000 });
    const btn = page.locator(".wf-runs-delete-btn");
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute("title", /workflow definition untouched/);
  });

  test("scenario 4 — Delete removes exactly the selected run logs from the real VFS, leaves the definition unchanged, and drops the rows", async ({ page, request }) => {
    const defBefore = await readDefinition(request, workflowId);

    await openWorkflowInApp(page, name);
    await expect(page.locator(".wf-runs-row")).toHaveCount(3, { timeout: 15000 });

    // Inspect run1 first — its replay must close when run1 is deleted.
    await page.locator(`.wf-runs-row[data-run-id="${run1}"]`).click();
    await expect(page.locator(".wf-card-history")).toBeVisible();
    await expect(page.locator(`.wf-runs-row[data-run-id="${run1}"]`)).toHaveClass(/wf-runs-row-inspected/);

    await page.locator(`.wf-runs-row[data-run-id="${run1}"] .wf-runs-row-checkbox`).check();
    await page.locator(`.wf-runs-row[data-run-id="${run2}"] .wf-runs-row-checkbox`).check();
    // Delete acts immediately — no confirm modal.
    await page.locator(".wf-runs-delete-btn").click();

    // The post-delete flash states the blast radius.
    await expect(page.locator(".wf-runs-flash")).toContainText("workflow definition untouched", { timeout: 15000 });
    await expect(page.locator(".wf-runs-flash")).toContainText("Deleted 2 run log(s)");

    // Exactly the selected rows disappeared; the replay of a deleted run closed.
    await expect(page.locator(".wf-runs-row")).toHaveCount(1);
    await expect(page.locator(`.wf-runs-row[data-run-id="${run3}"]`)).toBeVisible();
    await expect(page.locator(".wf-card-history")).toHaveCount(0);
    await expect(page.locator(".wf-runs-delete-btn")).toBeDisabled();

    // The REAL VFS agrees: the two logs are gone, the third survives…
    expect(await vfsFileExists(request, runLogPath(workflowId, run1))).toBe(false);
    expect(await vfsFileExists(request, runLogPath(workflowId, run2))).toBe(false);
    expect(await vfsFileExists(request, runLogPath(workflowId, run3))).toBe(true);
    // …and the workflow definition file is byte-identical.
    expect(await readDefinition(request, workflowId)).toBe(defBefore);

    // The service's run list no longer resurrects the deleted runs (the
    // in-memory live map was purged too, not just the disk listing).
    const list = await svcGet(request, base, `workflows/${workflowId}/runs`);
    expect(list.body.map((r: any) => r.runId)).toEqual([run3]);
  });

  test("scenario 6 — workflow_run_delete called directly via the service removes the log and returns { workflowId, deleted, results[] }", async ({ page, request }) => {
    const del = await svcPost(request, base, `workflows/${workflowId}/runs/delete`, { runIds: [run3] });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({
      workflowId,
      deleted: 1,
      results: [{ runId: run3, status: "deleted" }],
    });
    expect(await vfsFileExists(request, runLogPath(workflowId, run3))).toBe(false);

    // Idempotent: the same call again reports not_found without aborting.
    const again = await svcPost(request, base, `workflows/${workflowId}/runs/delete`, { runIds: [run3] });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({
      workflowId,
      deleted: 0,
      results: [{ runId: run3, status: "not_found" }],
    });

    // With every run gone, the app shows the empty table state.
    await openWorkflowInApp(page, name);
    await expect(page.locator(".wf-runs-table").getByText("No runs yet")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".wf-runs-delete-btn")).toBeDisabled();
  });
});
