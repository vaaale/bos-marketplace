// E2E for the installed OKF Knowledge Base item (the redesign).
//
// Runs against a BOS branch preview with the item installed and its service
// running — the established convention for an installed item, mirroring
// follow-the-money/e2e/follow-the-money.spec.ts:
//
//   BOS_PREVIEW_URL=http://localhost:8090 npx playwright test e2e/okf-knowledge-base.spec.ts
//
// THE PORT MATTERS. 8090 is the SUPERVISOR's origin. `httpPath`
// (/__supervisor/services/<id>/) is routed only there — on a Next.js port
// (3000 = base, 300x = a branch preview) that path is simply unrouted, so
// Next's trailing-slash normalisation answers 308 and then 404s with its HTML
// shell. A previous run read that as "the supervisor proxy is redirect-looping
// POSTs" and spent twenty messages on a component it had never contacted,
// before proposing to bypass the proxy entirely. The proxy is fine; the origin
// was wrong. To exercise a BRANCH build rather than base, keep this origin and
// pin the branch with the `bos_pin=<urlencoded-branch>` cookie.
//
// Two surfaces are exercised, both reached WITHOUT hardcoding a port (the
// service's `port` config is 0 — OS-assigned, so there is no stable default):
//
//   • the SERVICE's own REST bridge — resolved exactly the way the app
//     resolves it, via GET /api/services/okf-knowledge-base/config, taking
//     `httpPath` when the Supervisor fronts the service and the bound
//     `runtime.port` otherwise (services.md §11). This is where the tool
//     surface, the derived index, search determinism, the auto-trigger
//     contract, the job reaper and graph derivation are asserted.
//   • the APP, launched from the BOS shell the way a user launches it, and
//     driven inside its iframe by testid.
//
// Fixtures are created through the service itself and torn down after, so the
// suite never depends on a particular bundle already existing.
//
// TWO TESTS HAVE SIDE EFFECTS beyond the fixture bundles, and say so where
// they are: the lifecycle test performs a REAL headless agent run (on a tiny
// source), and the reaper test RESTARTS the service (re-resolving the base
// afterwards, because the port is OS-assigned and can move).

import { expect, request, test, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";

// Default to the Supervisor, not a Next port — see the note above.
const BASE = process.env.BOS_PREVIEW_URL || "http://localhost:8090";
const SERVICE_ID = "okf-knowledge-base";

/** The 21 declared tools (spec FR-037 / SC-007 + okf_list_jobs + the
 *  job-control pair okf_cancel_job / okf_delete_job). */
const EXPECTED_TOOLS = [
  "okf_search",
  "okf_read_toc",
  "okf_read_concept",
  "okf_list_concepts",
  "okf_upsert_concept",
  "okf_delete_concept",
  "okf_merge_concepts",
  "okf_list_bundles",
  "okf_init_bundle",
  "okf_import_bundle",
  "okf_export_bundle",
  "okf_delete_bundle",
  "okf_ingest",
  "okf_add_raw_source",
  "okf_list_jobs",
  "okf_cancel_job",
  "okf_delete_job",
  "okf_add_link",
  "okf_backlinks",
  "okf_lint",
  "okf_stale_report",
].sort();

/** The 16 removed BY NAME (FR-037). None may still be declared.
 *
 *  The net change is 31 -> 21, i.e. 10 fewer, because six were added
 *  (okf_search, okf_read_toc, okf_merge_concepts, okf_list_jobs,
 *  okf_cancel_job, okf_delete_job) alongside these sixteen removals. Asserting all sixteen names are gone is the
 *  stronger check, and the one that catches a tool quietly surviving the
 *  rework. */
const REMOVED_TOOLS = [
  "okf_bundle_status",
  "okf_find_concepts",
  "okf_read_index",
  "okf_read_bundle_schema",
  "okf_append_log",
  "okf_get_as_of",
  "okf_set_status",
  "okf_set_trust",
  "okf_add_source",
  "okf_attest",
  "okf_provenance",
  "okf_remove_link",
  "okf_list_links",
  "okf_neighbors",
  "okf_shortest_path",
  "okf_export_graph",
];

const READ_ONLY_TOOLS = [
  "okf_search",
  "okf_read_toc",
  "okf_read_concept",
  "okf_list_concepts",
  "okf_list_bundles",
  "okf_export_bundle",
  "okf_list_jobs",
  "okf_backlinks",
  "okf_lint",
  "okf_stale_report",
];

// ── the branch pin ───────────────────────────────────────────────────────
//
// The Supervisor serves a request from the version its `bos_pin` cookie names,
// and from BASE without one. buildstudio_run_tests passes the branch under
// test as BOS_PIN_BRANCH; every request this suite makes carries it, or the
// suite would exercise base's service while reporting on the branch.
const PIN = process.env.BOS_PIN_BRANCH;
const PIN_HEADERS: Record<string, string> = PIN ? { cookie: `bos_pin=${encodeURIComponent(PIN)}` } : {};

// Two different "config" endpoints, and they are easy to confuse:
//   ${BASE}/api/services/<id>/config  — BOS's: config FILES, the runtime.json
//                                       port record, and `httpPath`. Used only
//                                       to find the service (resolveServiceBase).
//   api.get("config")                  — the SERVICE's own GET /config: its
//                                       effective settings under `runtime`
//                                       (bundleRoot, jobFinalizeTimeoutMs,
//                                       maxConcurrentRuns, …).
// Reading `runtime.bundleRoot` from BOS's endpoint always fell back to the
// default, and `runtime.jobFinalizeTimeoutMs` was always undefined there.
/** request.newContext, pinned to the branch under test. */
function pinnedContext(opts: { baseURL?: string } = {}): Promise<APIRequestContext> {
  return request.newContext({ ...opts, extraHTTPHeaders: PIN_HEADERS });
}

// ── service reachability (never a hardcoded port) ────────────────────────

let api: APIRequestContext;
let serviceBase: string;
/** Set by the job-control fixtures, which pause the run queue; run in afterAll. */
let restoreRunQueue: (() => Promise<void>) | null = null;

async function resolveServiceBase(shell: APIRequestContext): Promise<string> {
  if (process.env.OKF_SERVICE_BASE) return process.env.OKF_SERVICE_BASE;
  for (let attempt = 0; attempt < 15; attempt++) {
    const res = await shell.get(`${BASE}/api/services/${SERVICE_ID}/config`);
    if (res.ok()) {
      const cfg = await res.json();
      // The Supervisor's own route to the service. It resolves the service's
      // CURRENT port on every request, so a restart mid-suite does not
      // strand this base — and with the pin cookie it is the PINNED
      // version's service, not base's.
      if (cfg.httpPath) return new URL(cfg.httpPath, BASE).toString();
      if (cfg.port) return `http://127.0.0.1:${cfg.port}/`;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `The ${SERVICE_ID} service never reported a bound port. Start it (Settings → Plugins) before running this suite.`,
  );
}

const B = {
  // one bundle per concern, so a failure in one test can't cascade
  main: "e2e-okf-main",
  rules: "e2e-okf-rules",
  legacy: "e2e-okf-legacy",
  copy: "e2e-okf-copy",
  merge: "e2e-okf-merge",
  // the person-kind scope-add (ADR-011): one bundle WITH persons, one
  // deliberately without — the backward-compat guard needs a clean one
  person: "e2e-okf-person",
  noPerson: "e2e-okf-no-person",
  // the ingest-chunking scope-add (ADR-012): raw sources get registered and
  // pre-split here, so nothing else's raw/ or .chunks/ is disturbed
  chunk: "e2e-okf-chunk",
  // the ingest-efficiency scope-add (ADR-014): sources registered here are
  // sliced into chapters by the service, and the verbatim-slice invariant
  // (SC-019) is asserted against their raw/ bytes
  efficiency: "e2e-okf-efficiency",
  // retrieval at scale (US14): full-text search, the paged bundle TOC, and
  // freshness after a change made outside the service
  scale: "e2e-okf-scale",
};

/**
 * A bundle's WHOLE vocabulary, paged through okf_list_concepts' route (ADR-019)
 * — the bundle detail carries counts only since 2026-10-14 (ADR-021). Shaped
 * like the old detail.conceptIndex rows (covers: at most 5 per term).
 */
async function vocabulary(bundle: string): Promise<{ name: string; kind: string; count: number; covers: { docId: string; chId: string }[] }[]> {
  const out: { name: string; kind: string; count: number; covers: { docId: string; chId: string }[] }[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await (await api.get(`bundles/${bundle}/concepts?offset=${offset}&limit=500`)).json();
    out.push(...page.terms.map((t: { term: string; kind: string; count: number; covers: { docId: string; chId: string }[] }) => ({ name: t.term, kind: t.kind, count: t.count, covers: t.covers })));
    if (offset + page.terms.length >= page.total) return out;
  }
}

/** A bundle's every document, paged through okf_read_toc({bundle})'s route. */
async function documentsOf(bundle: string): Promise<{ id: string; title: string; chapters: number }[]> {
  const out: { id: string; title: string; chapters: number }[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await (await api.get(`bundles/${bundle}/toc?offset=${offset}&limit=200`)).json();
    out.push(...page.documents);
    if (offset + page.documents.length >= page.total) return out;
  }
}

async function del(bundle: string): Promise<void> {
  await api.delete(`bundles/${bundle}`).catch(() => undefined);
}

/** Build a fixture bundle as a spec-conformant OKF manifest and import it. */
function chapter(
  docId: string,
  chId: string,
  title: string,
  summary: string,
  concepts: string[],
  extra: Record<string, string> = {},
  bodyText = "",
): { path: string; content: string } {
  const fm = [
    `id: ${docId}/${chId}`,
    "type: section",
    `parent: ${docId}`,
    `title: ${title}`,
    `concepts: [${concepts.join(", ")}]`,
    `summary: ${JSON.stringify(summary)}`,
    "status: stable",
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    "created_at: 2026-08-01T00:00:00.000Z",
    "updated_at: 2026-08-01T00:00:00.000Z",
  ].join("\n");
  return { path: `concepts/${docId}/${chId}.md`, content: `---\n${fm}\n---\n\n${bodyText || `## ${title}\n\nBody text.\n`}` };
}

function document(docId: string, title: string, summary: string, uri: string): { path: string; content: string } {
  const fm = [
    `id: ${docId}`,
    "type: document",
    `title: ${title}`,
    `summary: ${JSON.stringify(summary)}`,
    "sources:",
    `  - id: ${docId}.md`,
    `    uri: ${uri}`,
    "created_at: 2026-08-01T00:00:00.000Z",
    "updated_at: 2026-08-01T00:00:00.000Z",
  ].join("\n");
  return { path: `concepts/${docId}.md`, content: `---\n${fm}\n---\n\n# ${title}\n` };
}

const ASSET_BLOCK =
  "## Policy\n\n- Ship to a **5% canary** for at least 30 minutes.\n\n" +
  "![Canary rollout console](raw/assets/deployment/canary-demo.mp4)\n\n" +
  "> **Interpretation (LLM, at ingest):** Screen-capture of the deploy console: the canary pod set is " +
  "bumped 0 to 5%, error-rate and p99 sparklines render live, and when the 5xx threshold trips an " +
  "'Auto-rollback armed' banner appears and pods drain back to 0%.\n\n" +
  "Full rollout proceeds only after the canary window passes clean.\n";

async function seedMain(): Promise<void> {
  const files = [
    { path: "index.md", content: "# E2E Main\n" },
    { path: "raw/api-design.md", content: "# API Design Rules\n\nraw source\n" },
    { path: "raw/assets/deployment/canary-demo.mp4", content: "FAKE-MP4-BYTES" },
    document("api-design", "API Design Rules", "How we shape HTTP APIs.", "https://engineering.example.com/handbook/api-design"),
    chapter("api-design", "endpoint-naming", "Endpoint Naming Conventions", "REST resource naming: plural nouns, no verbs, versioned paths.", ["api-design", "naming"], { custom_e2e_key: "KEEP-ME" }),
    chapter("api-design", "versioning", "Versioning Strategy", "URL-path versioning; additive-only changes.", ["api-design", "versioning"], { status: "deprecated" }),
    document("deployment", "Deployment Checklist", "Shipping safely.", "raw/deployment.md"),
    chapter("deployment", "canary", "Canary and Rollback", "5% canary for 30m; auto-rollback on p99 / 5xx thresholds.", ["deployment", "rollback", "monitoring"], { stale_after: "2020-01-01" }, ASSET_BLOCK),
    chapter("deployment", "pre-deploy", "Pre-Deploy Gate", "CI green, migrations reviewed, and a documented rollback plan.", ["deployment"]),
  ];
  const res = await api.post(`bundles/${B.main}/import`, { data: { files } });
  expect(res.ok()).toBeTruthy();
}

async function seedRules(): Promise<void> {
  const files = [
    { path: "index.md", content: "# E2E Rules\n" },
    document("security", "Security Policy", "Rules for production access.", "https://policies.example.net/security"),
    chapter("security", "mfa", "MFA Requirements", "MFA is mandatory for production access, VPN and the secrets manager.", ["security", "rollback"]),
  ];
  const res = await api.post(`bundles/${B.rules}/import`, { data: { files } });
  expect(res.ok()).toBeTruthy();
}

// ── app helpers ──────────────────────────────────────────────────────────

async function openApp(page: Page): Promise<FrameLocator> {
  if (PIN) await page.context().addCookies([{ name: "bos_pin", value: encodeURIComponent(PIN), url: BASE }]);
  await page.goto(BASE);
  // Launch from the DOCK, not the desktop icon. `getByText(name).first()`
  // resolves to the desktop icon's label, and a desktop icon only binds
  // onDoubleClick (src/components/desktop/Desktop.tsx) — a single click on it
  // is a silent no-op, so the window never opened and every app test timed out
  // waiting for an iframe that was never created. The dock button launches on a
  // SINGLE click and merely focuses an already-open window
  // (src/components/desktop/Dock.tsx), which is what this helper wants: it runs
  // once per test against a serial, shared page.
  await page.getByTestId(`dock-${SERVICE_ID}`).click();
  const frame = page.frameLocator(`iframe[src*="${SERVICE_ID}"]`);
  await expect(frame.getByTestId("okf-app")).toBeVisible({ timeout: 30000 });
  return frame;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const shell = await pinnedContext();
  serviceBase = await resolveServiceBase(shell);
  await shell.dispose();
  api = await pinnedContext({ baseURL: serviceBase });
  for (const b of Object.values(B)) await del(b);
  await seedMain();
  await seedRules();
});

test.afterAll(async () => {
  for (const b of Object.values(B)) await del(b);
  await api.dispose();
  if (restoreRunQueue) await restoreRunQueue();
});

// ════════════════════════════════════════════════════════════════════════
//  SC-007 / FR-037 / FR-038 — the tool surface is exactly 21
// ════════════════════════════════════════════════════════════════════════

test("SC-007: the service declares exactly the 21 okf_* tools and none of the 16 removed", async () => {
  const res = await api.get("tools");
  expect(res.ok()).toBeTruthy();
  const { count, tools } = await res.json();

  // The badge in the app and this assertion both read the service's OWN
  // declaration list — neither hardcodes the number anywhere but here.
  expect(count).toBe(21);
  expect(tools.length).toBe(21);
  expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(EXPECTED_TOOLS);

  const names = new Set(tools.map((t: { name: string }) => t.name));
  for (const removed of REMOVED_TOOLS) expect(names.has(removed), `${removed} must no longer be declared`).toBe(false);
});

test("FR-038: every declared tool carries a validatable JSON schema; read-only tools are parallelSafe", async () => {
  const { tools } = await (await api.get("tools")).json();
  for (const t of tools) {
    expect(t.description, `${t.name} needs a description`).toBeTruthy();
    expect(t.inputSchema, `${t.name} needs an inputSchema`).toBeTruthy();
    expect(t.inputSchema.type).toBe("object");
    expect(typeof t.inputSchema.properties).toBe("object");
  }
  const parallel = tools.filter((t: { parallelSafe: boolean }) => t.parallelSafe).map((t: { name: string }) => t.name).sort();
  expect(parallel).toEqual([...READ_ONLY_TOOLS].sort());
});

// ════════════════════════════════════════════════════════════════════════
//  US2 / FR-007–009 / SC-002 — the two-level derived index
// ════════════════════════════════════════════════════════════════════════

test("US2/FR-007: the bundle-level concept index is a stored .md artifact, regenerable and stamped", async () => {
  const ex = await (await api.get(`bundles/${B.main}/export`)).json();
  const index = ex.files.find((f: { path: string }) => f.path === "concept-index.md");
  expect(index, "concept-index.md must be a real file in the bundle").toBeTruthy();
  expect(index.content).toContain("type: concept-index");
  expect(index.content).toContain("index_generated_at:");
  // human-readable body, not just frontmatter (NFR-001)
  expect(index.content).toContain("# Concept Index");
  expect(index.content).toContain("Derived from chapter frontmatter");
});

test("US2 AS2/FR-008: every ingested document has a stored TOC listing chapters, descriptions and terms", async () => {
  const ex = await (await api.get(`bundles/${B.main}/export`)).json();
  expect(ex.tocsIncluded).toBe(2);
  const toc = ex.files.find((f: { path: string }) => f.path === "toc/api-design.md");
  expect(toc).toBeTruthy();
  expect(toc.content).toContain("type: toc");

  const read = await (await api.get(`bundles/${B.main}/toc/api-design`)).json();
  expect(read.artifact).toBe("toc/api-design.md");
  expect(read.chapters).toHaveLength(2);
  const naming = read.chapters.find((c: { id: string }) => c.id === "endpoint-naming");
  expect(naming.summary).toContain("plural nouns");
  expect(naming.concepts).toEqual(expect.arrayContaining(["api-design", "naming"]));
});

test("FR-011/SC-006: the index is O(V) — sized by distinct terms, not by documents or chapters", async () => {
  const detail = await (await api.get(`bundles/${B.main}`)).json();
  const vocab = await vocabulary(B.main);
  const terms = vocab.map((t) => t.name).sort();
  expect(terms).toEqual(["api-design", "deployment", "monitoring", "naming", "rollback", "versioning"]);
  // 6 terms covering 4 chapters across 2 documents, and one term covers two
  // chapters — the table is keyed by term, not by chapter
  const apiDesign = vocab.find((t) => t.name === "api-design")!;
  expect(apiDesign.count).toBe(2);
  expect(detail.health.conceptTerms).toBe(6);
});

test("FR-009/NFR-004/SC-010: a corrupted index is detected as drift and REBUILT from content", async () => {
  // overwrite the derived artifact with a lie
  const corrupt = {
    path: "concept-index.md",
    content: "---\ntype: concept-index\nbundle: e2e\nterms: []\nindex_generated_at: 2000-01-01T00:00:00.000Z\n---\n\n# corrupted\n",
  };
  expect((await api.post(`bundles/${B.main}/import`, { data: { files: [corrupt], rebuild: false } })).ok()).toBeTruthy();

  const lint = await (await api.get(`bundles/${B.main}/lint`)).json();
  expect(lint.checks.conceptIndexDrift).toBeGreaterThan(0);
  expect(lint.rebuilt).toBe(true);

  // and it is genuinely repaired — search works again against real rows
  const after = await (await api.get(`bundles/${B.main}/search?query=rollback`)).json();
  expect(after.rows.length).toBeGreaterThan(0);
});

test("SC-005: unknown frontmatter keys survive the write/read round-trip", async () => {
  const concept = await (await api.get(`bundles/${B.main}/concept/api-design/endpoint-naming`)).json();
  expect(concept.frontmatter.custom_e2e_key).toBe("KEEP-ME");
});

// ════════════════════════════════════════════════════════════════════════
//  US1 / FR-001–005 / SC-001 — deterministic concept-anchored retrieval
// ════════════════════════════════════════════════════════════════════════

test("US1 AS1/FR-001: a natural-language query returns concept-anchored TOC rows", async () => {
  const res = await (await api.get(`bundles/${B.main}/search?query=${encodeURIComponent("what is our rollback policy")}`)).json();
  expect(res.rows.length).toBeGreaterThan(0);
  const row = res.rows[0];
  expect(row).toMatchObject({ docId: "deployment", chId: "canary", matchedConcept: "rollback" });
  expect(row.docTitle).toBe("Deployment Checklist");
  expect(row.chTitle).toBe("Canary and Rollback");
  expect(row.description).toContain("canary");
});

test("FR-002: the match is deterministic — the same query returns identical rows every time", async () => {
  const runs = await Promise.all(
    [0, 1, 2].map(async () => (await (await api.get(`bundles/${B.main}/search?query=rollback+canary`)).json()).rows),
  );
  expect(JSON.stringify(runs[1])).toBe(JSON.stringify(runs[0]));
  expect(JSON.stringify(runs[2])).toBe(JSON.stringify(runs[0]));
});

test("FR-036/FR-043: the app's search route returns rows identical to the okf_search tool's", async () => {
  // Same core.search(), two surfaces — the GET the app uses and the POST form
  // must agree byte-for-byte with each other and with the tool's `rows`.
  const viaGet = await (await api.get(`bundles/${B.main}/search?query=rollback`)).json();
  const viaPost = await (await api.post(`bundles/${B.main}/search`, { data: { query: "rollback" } })).json();
  expect(JSON.stringify(viaPost.rows)).toBe(JSON.stringify(viaGet.rows));
  expect(viaPost.count).toBe(viaGet.rows.length);
});

test("FR-002: a paraphrase that only hits a stored description still routes, anchored to its term", async () => {
  const res = await (await api.get(`bundles/${B.main}/search?query=${encodeURIComponent("migrations reviewed")}`)).json();
  expect(res.rows.length).toBeGreaterThan(0);
  expect(res.rows[0].chId).toBe("pre-deploy");
  expect(res.rows[0].matchedConcept).toBe("deployment");
});

test("Edge case: a query matching no concept term returns empty — never an invented row", async () => {
  const res = await (await api.get(`bundles/${B.main}/search?query=${encodeURIComponent("quantum chromodynamics")}`)).json();
  expect(res.rows).toEqual([]);
  expect(res.count).toBe(0);
});

test("US1 AS2/FR-003/SC-001: reading a chapter returns its ENTIRE body, not a snippet", async () => {
  const c = await (await api.get(`bundles/${B.main}/concept/deployment/canary`)).json();
  // every part of the stored body is present — beginning, asset block, and end
  expect(c.body).toContain("## Policy");
  expect(c.body).toContain("![Canary rollout console](raw/assets/deployment/canary-demo.mp4)");
  expect(c.body).toContain("Full rollout proceeds only after the canary window passes clean.");
  expect(c.body.length).toBeGreaterThan(300);
});

test("US1 AS4: reading a document id returns the document itself", async () => {
  const d = await (await api.get(`bundles/${B.main}/concept/api-design`)).json();
  expect(d.type).toBe("document");
  expect(d.frontmatter.title).toBe("API Design Rules");
});

test("US3 AS1/AS2: search is scoped to the named bundle only", async () => {
  // both bundles carry the term `rollback`; a scoped query must not cross over
  const main = await (await api.get(`bundles/${B.main}/search?query=rollback`)).json();
  const rules = await (await api.get(`bundles/${B.rules}/search?query=rollback`)).json();
  expect(main.rows.every((r: { docId: string }) => r.docId === "deployment")).toBe(true);
  expect(rules.rows.every((r: { docId: string }) => r.docId === "security")).toBe(true);
  expect(rules.rows.map((r: { chId: string }) => r.chId)).toContain("mfa");

  const full = await (await api.get(`bundles/${B.rules}/concept/security/mfa`)).json();
  expect(full.body).toContain("MFA Requirements");
});

// ════════════════════════════════════════════════════════════════════════
//  US4 / FR-020–023 / SC-003 — inline assets
// ════════════════════════════════════════════════════════════════════════

test("US4 AS3/FR-023/SC-003: a chapter carries its asset link AND the interpretation stored at ingest", async () => {
  const c = await (await api.get(`bundles/${B.main}/concept/deployment/canary`)).json();
  expect(c.assets).toHaveLength(1);
  const asset = c.assets[0];
  expect(asset.path).toBe("raw/assets/deployment/canary-demo.mp4");
  expect(asset.kind).toBe("video");
  expect(asset.interpretationAvailable).toBe(true);
  expect(asset.interpretation).toContain("Auto-rollback armed");
  // the interpretation is STORED TEXT in the body — retrieval carries the
  // asset's knowledge with no vision call at query time
  expect(c.body).toContain("**Interpretation (LLM, at ingest):**");
});

test("FR-023: re-reading a chapter is byte-identical — nothing is re-interpreted at query time", async () => {
  const first = await (await api.get(`bundles/${B.main}/concept/deployment/canary`)).json();
  const second = await (await api.get(`bundles/${B.main}/concept/deployment/canary`)).json();
  expect(second.body).toBe(first.body);
  expect(JSON.stringify(second.assets)).toBe(JSON.stringify(first.assets));
});

test("FR-020: the stored asset is served as real bytes with a content type", async () => {
  const res = await api.get(`bundles/${B.main}/assets/deployment/canary-demo.mp4`);
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["content-type"]).toBe("video/mp4");
  expect((await res.body()).toString()).toBe("FAKE-MP4-BYTES");
});

test("FR-022: an http(s) link in a chapter body is a remote reference, not a stored asset", async () => {
  const files = [
    document("links-doc", "Links Doc", "A doc with a plain hyperlink.", "https://example.com/links"),
    chapter("links-doc", "refs", "References", "Points at an external page and nothing is downloaded.", ["linking"], {},
      "See [the upstream spec](https://example.com/spec) and ![remote](https://example.com/pic.png).\n"),
  ];
  expect((await api.post(`bundles/${B.main}/import`, { data: { files } })).ok()).toBeTruthy();
  const c = await (await api.get(`bundles/${B.main}/concept/links-doc/refs`)).json();
  expect(c.assets).toEqual([]); // neither the hyperlink nor the remote image is a stored asset
  const lint = await (await api.get(`bundles/${B.main}/lint`)).json();
  expect(lint.checks.brokenInlineAssets).toBe(0); // and the remote image is not reported as broken
});

test("SC-010: lint detects a broken inline-asset link", async () => {
  const files = [
    document("broken-doc", "Broken Doc", "Has a missing asset.", "raw/broken.md"),
    chapter("broken-doc", "fig", "Figure", "References an asset that is not in raw/.", ["figures"], {},
      "![Missing](raw/assets/broken-doc/nope.png)\n\n> **Interpretation (LLM, at ingest):** A diagram.\n"),
  ];
  expect((await api.post(`bundles/${B.main}/import`, { data: { files } })).ok()).toBeTruthy();
  const lint = await (await api.get(`bundles/${B.main}/lint`)).json();
  expect(lint.checks.brokenInlineAssets).toBeGreaterThan(0);
  expect(lint.errors.some((e: { check: string }) => e.check === "inline-asset")).toBe(true);
});

// ════════════════════════════════════════════════════════════════════════
//  US6 / FR-026 / SC-008 — concept-term curation
// ════════════════════════════════════════════════════════════════════════

test("US6 AS1/SC-008: merging terms consolidates the index, every affected TOC and every chapter's frontmatter", async () => {
  await del(B.merge);
  const files = [
    { path: "index.md", content: "# merge fixture\n" },
    document("limits", "Rate Limits", "Quotas and throttling.", "https://example.com/limits"),
    chapter("limits", "quotas", "Per-tier Quotas", "429 plus Retry-After; quotas per tier.", ["rate-limit"]),
    chapter("limits", "bursts", "Burst Allowance", "A small burst absorbs spiky but legitimate traffic.", ["rate-limiting"]),
  ];
  expect((await api.post(`bundles/${B.merge}/import`, { data: { files } })).ok()).toBeTruthy();

  expect((await vocabulary(B.merge)).map((t) => t.name).sort()).toEqual(["rate-limit", "rate-limiting"]);

  // the real merge — the same core.mergeConcepts() okf_merge_concepts runs
  const merged = await (await api.post(`bundles/${B.merge}/merge`, { data: { from: "rate-limit", to: "rate-limiting" } })).json();
  expect(merged.chaptersRewritten).toEqual(["limits/quotas"]);
  expect(merged.fromTermRemaining).toBe(false);
  expect(merged.tocsRebuilt).toContain("limits");

  // the concept index consolidates to ONE canonical entry covering the union
  const after = await vocabulary(B.merge);
  expect(after.map((t) => t.name)).toEqual(["rate-limiting"]);
  expect(after[0].count).toBe(2);

  // every affected chapter's frontmatter was rewritten
  const quotas = await (await api.get(`bundles/${B.merge}/concept/limits/quotas`)).json();
  expect(quotas.frontmatter.concepts).toEqual(["rate-limiting"]);

  // and the stored document TOC followed
  const toc = await (await api.get(`bundles/${B.merge}/toc/limits`)).json();
  expect(toc.chapters.every((c: { concepts: string[] }) => c.concepts.includes("rate-limiting"))).toBe(true);
  expect(toc.chapters.some((c: { concepts: string[] }) => c.concepts.includes("rate-limit"))).toBe(false);

  // US6 AS2: a query that previously matched EITHER term now routes through
  // the single canonical term to the union of the chapters
  // (the document itself, titled "Rate Limits", is also a hit since documents
  // are searched too — FR-068 — but the two chapters matching EVERY word rank
  // above it)
  const q = await (await api.get(`bundles/${B.merge}/search?query=rate-limiting`)).json();
  expect(q.rows.filter((r: { chId: string }) => r.chId).map((r: { chId: string }) => r.chId).sort()).toEqual(["bursts", "quotas"]);
  expect(q.rows.slice(0, 2).every((r: { chId: string }) => r.chId)).toBe(true);
});

test("US6: merging is reachable from the app's Concept Index", async ({ page }) => {
  await del(B.merge);
  await api.post(`bundles/${B.merge}/import`, {
    data: {
      files: [
        { path: "index.md", content: "# merge ui fixture\n" },
        document("limits", "Rate Limits", "Quotas and throttling.", "https://example.com/limits"),
        chapter("limits", "quotas", "Per-tier Quotas", "429 plus Retry-After; quotas per tier.", ["rate-limit"]),
        chapter("limits", "bursts", "Burst Allowance", "A small burst absorbs spiky traffic.", ["rate-limiting"]),
      ],
    },
  });

  const app = await openApp(page);
  await app.getByTestId(`bundle-row-${B.merge}`).click();
  await expect(app.getByTestId("term-rate-limit")).toBeVisible();

  await app.getByTestId("merge-term-rate-limit").click();
  // the canonical term is TYPED (a type-ahead over the vocabulary): a select of
  // every term would not fit a large bundle, and a page of them hides the right one
  await app.getByTestId("merge-target-rate-limit").fill("rate-limiting");
  await app.getByTestId("merge-confirm-rate-limit").click();

  await expect(app.getByTestId("term-rate-limit")).toHaveCount(0);
  await expect(app.getByTestId("term-rate-limiting")).toBeVisible();
  await expect(app.getByTestId("term-head-rate-limiting")).toContainText("2 chapters");
});

// ════════════════════════════════════════════════════════════════════════
//  US5 / FR-027–030 / SC-004 — bundles, import/export, health
// ════════════════════════════════════════════════════════════════════════

test("US5 AS1/FR-028: creating a bundle produces the conformant OKF layout", async () => {
  await del(B.copy);
  const created = await api.post("bundles", { data: { name: B.copy, title: "Copy" } });
  expect(created.status()).toBe(201);

  const ex = await (await api.get(`bundles/${B.copy}/export`)).json();
  const paths = ex.files.map((f: { path: string }) => f.path);
  for (const expected of ["index.md", "log.md", "concept-index.md", "links.json", "raw/sources.json"]) {
    expect(paths, `a new bundle must contain ${expected}`).toContain(expected);
  }
});

test("US5 AS3/SC-004: an export carries the index and every TOC, and re-importing reproduces a queryable bundle", async () => {
  const ex = await (await api.get(`bundles/${B.main}/export`)).json();
  expect(ex.conceptIndexIncluded).toBe(true);
  expect(ex.tocsIncluded).toBeGreaterThan(0);

  await del(B.copy);
  const imported = await (await api.post(`bundles/${B.copy}/import`, { data: { files: ex.files } })).json();
  expect(imported.indexNeedsRegeneration).toBe(false);

  const copyRows = await (await api.get(`bundles/${B.copy}/search?query=rollback`)).json();
  const mainRows = await (await api.get(`bundles/${B.main}/search?query=rollback`)).json();
  expect(copyRows.rows.map((r: { chId: string }) => r.chId)).toEqual(mainRows.rows.map((r: { chId: string }) => r.chId));

  const chapter = await (await api.get(`bundles/${B.copy}/concept/deployment/canary`)).json();
  expect(chapter.assets).toHaveLength(1);
});

test("design Risk #9: a pre-redesign bundle imports with a BEST-EFFORT index, reported not hidden", async () => {
  await del(B.legacy);
  const legacy = [
    { path: "index.md", content: "# Legacy\n" },
    {
      path: "concepts/ai/attention.md",
      content: "---\nid: ai/attention\ntitle: Attention\nstatus: stable\nverified: unverified\nlegacy_key: PRESERVED\n---\n\nAttention weights inputs by relevance.\n",
    },
    { path: "concepts/ai/transformers.md", content: "---\nid: ai/transformers\ntitle: Transformers\n---\n\nTransformers build on attention.\n" },
  ];
  const res = await (await api.post(`bundles/${B.legacy}/import`, { data: { files: legacy } })).json();

  expect(res.indexNeedsRegeneration).toBe(true);
  expect(res.note).toContain("BEST-EFFORT");
  // nothing dropped: the legacy chapters are classified and readable in full
  expect(res.chapters).toBe(2);
  expect(res.docs).toBe(1);
  const c = await (await api.get(`bundles/${B.legacy}/concept/ai/attention`)).json();
  expect(c.frontmatter.legacy_key).toBe("PRESERVED");
  expect(c.body).toContain("weights inputs by relevance");

  // the health surface reports the partial routing rather than pretending
  const bundles = await (await api.get("bundles")).json();
  const h = bundles.bundles.find((b: { name: string }) => b.name === B.legacy);
  expect(h.indexNeedsRegeneration).toBe(true);
});

test("US7 AS3/FR-027: per-bundle health reports documents, chapters, terms and stale items", async () => {
  const bundles = await (await api.get("bundles")).json();
  const h = bundles.bundles.find((b: { name: string }) => b.name === B.main);
  expect(h.docs).toBeGreaterThanOrEqual(2);
  expect(h.chapters).toBeGreaterThanOrEqual(4);
  expect(h.conceptTerms).toBeGreaterThanOrEqual(6);
  expect(h.stale).toBeGreaterThan(0); // deployment/canary is past stale_after
  expect(h.deprecated).toBeGreaterThan(0); // api-design/versioning
  expect(h.status).toBe("attention");
});

test("FR-034: the stale report names the chapters past their lifecycle threshold", async () => {
  const { stale } = await (await api.get(`bundles/${B.main}/stale`)).json();
  const canary = stale.find((s: { id: string }) => s.id === "deployment/canary");
  expect(canary.reason).toBe("past stale_after");
  expect(canary.daysStale).toBeGreaterThan(0);
  expect(stale.some((s: { id: string; status: string }) => s.id === "api-design/versioning" && s.status === "deprecated")).toBe(true);
});

test("US5 AS4/FR-030: deleting a bundle removes only that bundle's directory", async () => {
  await del(B.copy);
  expect((await api.post("bundles", { data: { name: B.copy } })).status()).toBe(201);
  expect((await api.delete(`bundles/${B.copy}`)).ok()).toBeTruthy();

  const bundles = await (await api.get("bundles")).json();
  const names = bundles.bundles.map((b: { name: string }) => b.name);
  expect(names).not.toContain(B.copy);
  expect(names).toContain(B.main); // the neighbour is untouched
});

// ════════════════════════════════════════════════════════════════════════
//  FR-045 — graph derivation
// ════════════════════════════════════════════════════════════════════════

test("FR-045: the knowledge graph is derived on read — 3 node types, 3 typed directed labelled edge kinds", async () => {
  const g = await (await api.get(`bundles/${B.main}/graph`)).json();

  const types = new Set(g.nodes.map((n: { type: string }) => n.type));
  expect(types).toEqual(new Set(["doc", "chap", "concept"]));

  const kinds = new Set(g.edges.map((e: { kind: string }) => e.kind));
  expect(kinds.has("containment")).toBe(true);
  expect(kinds.has("coverage")).toBe(true);

  // containment runs document -> chapter, from `parent`
  // node ids are namespaced by kind (FR-073(f)) — `doc:`, `chap:`, `concept:`
  const contains = g.edges.find((e: { kind: string; to: string }) => e.kind === "containment" && e.to === "chap:deployment/canary");
  expect(contains.from).toBe("doc:deployment");
  expect(contains.label).toBe("contains");

  // coverage runs chapter -> concept term, from the index
  const covers = g.edges.find((e: { kind: string; from: string; to: string }) => e.kind === "coverage" && e.from === "chap:deployment/canary" && e.to === "concept:rollback");
  expect(covers.label).toBe("covers");

  // every edge is directed and labelled, and never dangles
  const ids = new Set(g.nodes.map((n: { id: string }) => n.id));
  for (const e of g.edges) {
    expect(e.from && e.to && e.label).toBeTruthy();
    expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  }

  // concept-term nodes carry their coverage count (it drives the node radius)
  const term = g.nodes.find((n: any) => n.type === "concept" && n.id === "concept:api-design");
  expect(term.count).toBe(2);
  expect(term.term).toBe("api-design");
  // the document "deployment" and the concept term "deployment" are TWO nodes
  expect(g.nodes.filter((n: any) => n.id === "doc:deployment").length).toBe(1);
  expect(g.nodes.filter((n: any) => n.id === "concept:deployment").length).toBe(1);
});

// ════════════════════════════════════════════════════════════════════════
//  US8 / FR-041 / FR-044 / FR-049 / SC-011 — the AUTO-TRIGGER contract
// ════════════════════════════════════════════════════════════════════════
//
// okf_ingest used to be a dispatcher: it returned `acquisition_required` or
// `delegation_required` with an instruction block the CALLER had to execute.
// It is now an auto-trigger: the service starts the run itself over BOS's
// loopback /api/subagents/delegate endpoint and returns {jobId} at once.
//
// These tests assert the three halves of that contract: the SHAPE of the
// response (a jobId, and crucially NO instruction block), the LIFECYCLE
// (the launcher writes a terminal state derived from the run's own signal),
// and the REAPER (a run orphaned by a restart is admitted to be lost rather
// than spinning forever).
//
// Every run these tests start is REAL — a headless agent run against the
// preview's provider — and the service runs at most `maxConcurrentRuns` (2)
// at once; the rest wait queued. A test that starts a run only to check the
// trigger must therefore stop it: left running, two such runs held both slots
// for minutes, FR-044's run sat queued behind them, and its "did not
// transition to running" poll blamed the stream for a full queue
// (production, 2026-10-14).

/** Stop a run this test started and does not need. 409 = already terminal. */
async function stopRun(id: string): Promise<void> {
  const res = await api.post(`jobs/${id}/cancel`);
  expect([200, 409], `could not stop ${id}: ${res.status()} ${await res.text()}`).toContain(res.status());
}

/**
 * Wait until a new run would START rather than queue: fewer running than the
 * cap, nobody queued ahead. A queue busy with someone else's runs is reported
 * as exactly that, not as a launcher that does not consume its stream.
 */
async function waitForFreeRunSlot(): Promise<void> {
  const cfg = await (await api.get("config")).json();
  const cap = Number(cfg.runtime && cfg.runtime.maxConcurrentRuns);
  expect(cap, "the run queue is paused (maxConcurrentRuns 0) — no run can start").toBeGreaterThan(0);
  let busy: string[] = [];
  await expect
    .poll(
      async () => {
        const { jobs } = await (await api.get("jobs")).json();
        const active = (jobs as { id: string; status: string }[]).filter((j) => j.status === "running" || j.status === "queued");
        busy = active.map((j) => `${j.id} (${j.status})`);
        return active.filter((j) => j.status === "running").length < cap && !active.some((j) => j.status === "queued");
      },
      { message: `the run queue never had a free slot (cap ${cap}); still active: ${busy.join(", ")}`, timeout: 300_000, intervals: [2000] },
    )
    .toBe(true);
}

test("FR-016: okf_ingest auto-triggers — it returns {jobId} with NO instruction block", async () => {
  await api.post(`bundles/${B.main}/import`, { data: { files: [{ path: "raw/e2e-trigger.md", content: "# trigger source\n\nShort body.\n" }] } });

  const res = await api.post("jobs", { data: { bundle: B.main, source: "raw/e2e-trigger.md" } });
  expect(res.ok()).toBeTruthy();
  const started = await res.json();

  // the WHOLE response shape: a queued job, nothing to go and do
  expect(started.status).toBe("queued");
  expect(started.jobId).toMatch(/^run-\d+$/);
  expect(started.bundle).toBe(B.main);

  // the dispatcher's instruction block is GONE. Any of these reappearing
  // means the caller is being asked to perform the run again.
  expect(started.steps, "acquisition steps must not come back to the caller").toBeUndefined();
  expect(started.delegate, "a delegation block must not come back to the caller").toBeUndefined();
  expect(started.callbacks, "sub-agent lifecycle callback URLs are gone").toBeUndefined();
  expect(JSON.stringify(started)).not.toContain("acquisition_required");
  expect(JSON.stringify(started)).not.toContain("delegation_required");
  expect(JSON.stringify(started)).not.toContain("agent_delegate");

  // and the job exists immediately, visible to both surfaces
  const job = await (await api.get(`jobs/${started.jobId}`)).json();
  expect(job.id).toBe(started.jobId);
  expect(["queued", "running", "completed", "failed"]).toContain(job.status);
  expect(job.bundleId).toBe(B.main);

  // the shape is what is under test, not the run
  await stopRun(started.jobId);
});

test("the trigger returns before the run does — the caller's turn is not held open", async () => {
  await api.post(`bundles/${B.main}/import`, { data: { files: [{ path: "raw/e2e-fast-return.md", content: "# fast\n\nbody\n" }] } });
  const t0 = Date.now();
  const res = await api.post("jobs", { data: { bundle: B.main, source: "raw/e2e-fast-return.md" } });
  const elapsed = Date.now() - t0;
  expect(res.ok()).toBeTruthy();
  // An agent run is tens of seconds at best. Anything under a few seconds
  // proves the response is not waiting for it.
  expect(elapsed, "POST /jobs must return without awaiting the agent run").toBeLessThan(5000);

  // the return time is what is under test, not the run
  await stopRun((await res.json()).jobId);
});

test("FR-044/SC-011: the LAUNCHER writes the terminal state — completed with a summary, or failed with an error", async () => {
  // NOTE: this performs a REAL headless agent run against whatever provider
  // the preview is configured with. The source is deliberately tiny. The
  // assertion is about the CONTRACT, not about the agent's judgement: either
  // terminal state is a pass, because what is under test is that the service
  // — which launched the run and watched its stream — records an honest
  // outcome instead of leaving the job hanging.
  //
  // Its own timeout: a free slot (up to 5 min), the start (30 s) and the run
  // itself (up to 10 min). Under the default 30 s, Phase 2's poll could never
  // have waited for a real run.
  test.setTimeout(16 * 60_000);
  await api.post(`bundles/${B.main}/import`, {
    data: { files: [{ path: "raw/e2e-lifecycle.md", content: "# Lifecycle Probe\n\n## One\n\nFirst section.\n\n## Two\n\nSecond section.\n" }] },
  });
  // Phase 1 below is "it starts within 30s", which only holds with a free slot.
  await waitForFreeRunSlot();
  const started = await (await api.post("jobs", { data: { bundle: B.main, source: "raw/e2e-lifecycle.md" } })).json();
  const id = started.jobId;

  // the list surface sees it as active while it runs
  const listed = await (await api.get("jobs")).json();
  expect(listed.jobs.some((j: { id: string }) => j.id === id)).toBe(true);

  // Phase 1: the worker accepts the delegate request and the agent starts —
  // the job transitions from queued to running within 30s. This proves the
  // worker is actively consuming the NDJSON stream (not just queuing it).
  await expect
    .poll(
      async () => (await (await api.get(`jobs/${id}`)).json()).status as string,
      {
        message: `run ${id} did not transition to running — the worker is not consuming the stream`,
        timeout: 30_000,
        intervals: [1000],
      },
    )
    .toBe("running");

  // Phase 2: the worker reaches a terminal state — completed with a summary,
  // or failed with an error. This is the core assertion of FR-044: the
  // launcher (the worker) writes the terminal state from the run's own signal,
  // not the sub-agent, not the calling assistant, not the reaper (that's FR-049).
  let job: Record<string, unknown> = {};
  await expect
    .poll(
      async () => {
        job = await (await api.get(`jobs/${id}`)).json();
        return job.status as string;
      },
      {
        message: `run ${id} never reached a terminal state — the launcher is not writing one`,
        timeout: 600_000,
        intervals: [5000],
      },
    )
    .toMatch(/^(completed|failed)$/);

  // the launcher consumed the run's stream to a terminal signal — if the run
  // completed it must have seen at least one tool call (the stream was live)
  if (job.status === "completed") {
    const summary = job.summary as Record<string, unknown>;
    expect(
      (summary.toolCalls as number) ?? 0,
      "a completed run should have seen at least one tool call (the stream was live)",
    ).toBeGreaterThanOrEqual(1);
  }

  expect(job.endedAt).toBeTruthy();
  expect(job.durationMs).not.toBeNull();
  expect(job.progress, "progress is cleared on a terminal transition").toBeNull();

  if (job.status === "completed") {
    expect(job.summary, "a completed run must carry a summary").toBeTruthy();
    const summary = job.summary as Record<string, unknown>;
    for (const key of ["chapters", "concepts", "assets", "refsSkipped", "refsFailed"]) {
      expect(typeof summary[key], `summary.${key} must be a number`).toBe("number");
    }
  } else {
    expect(job.error, "a failed run must say why").toBeTruthy();
    expect(String(job.error).length).toBeGreaterThan(0);
  }
});

test("ADR-006: a terminal run is final — it cannot be resurrected or re-declared", async () => {
  const { jobs } = await (await api.get("jobs")).json();
  const terminal = jobs.find((j: { status: string }) => j.status === "completed" || j.status === "failed");
  expect(terminal, "the lifecycle test above left a terminal run on record").toBeTruthy();

  // Terminal state belongs to the launcher. The one remaining POST route
  // takes progress and nothing else — a status field is a 400, which is what
  // stops an agent (or anything else) declaring a run finished.
  const rejected = await api.post(`jobs/${terminal.id}`, { data: { status: "running" } });
  expect(rejected.status()).toBe(400);
  expect(JSON.stringify(await rejected.json())).toMatch(/owned by the service that launched the run/i);

  expect((await (await api.get(`jobs/${terminal.id}`)).json()).status).toBe(terminal.status);
});

test("the sub-agent may enrich progress on a live run, and nothing more", async () => {
  await api.post(`bundles/${B.main}/import`, { data: { files: [{ path: "raw/e2e-progress.md", content: "# progress probe\n" }] } });
  const started = await (await api.post("jobs", { data: { bundle: B.main, source: "raw/e2e-progress.md" } })).json();

  // An agent can only report progress once its run is RUNNING; until then the
  // launcher owns the field (it writes "starting the okf-ingest agent" itself).
  // Posting before that raced the launcher's own update.
  for (let i = 0; i < 100; i++) {
    const j = await (await api.get(`jobs/${started.jobId}`)).json();
    if (j.status !== "queued" && j.progress !== "starting the okf-ingest agent") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const ok = await api.post(`jobs/${started.jobId}`, { data: { progress: "writing 3 of 6 chapters" } });
  // either it took the progress, or the run already finished (terminal states
  // clear progress) — both are correct; a 500 would not be
  expect([200, 400, 404]).toContain(ok.status());
  if (ok.status() === 200) {
    const job = await ok.json();
    if (job.status === "running" || job.status === "queued") expect(job.progress).toBe("writing 3 of 6 chapters");
  }

  const missing = await api.post(`jobs/${started.jobId}`, { data: {} });
  expect(missing.status()).toBe(400);

  await stopRun(started.jobId);
});

test("FR-049: a run orphaned by a restart is reaper-marked failed(stale), not left spinning", async () => {
  // The reaper's job is the one case driveRun cannot cover: the process dying
  // mid-run. Rather than wait out the 30-minute window, seed a job record
  // that is already days old directly into the persisted store, then restart
  // the service — the STARTUP SWEEP is the half of the reaper that exists
  // precisely for this event, and it runs before the service serves a
  // request.
  const shell = await pinnedContext();
  const cfg = await (await api.get("config")).json();
  const bundleRoot = (cfg.runtime && cfg.runtime.bundleRoot) || "/KnowledgeBase";
  const jobsFile = `${bundleRoot}/.jobs/jobs.json`;

  const existing = await shell.get(`${BASE}/api/fs?op=read&path=${encodeURIComponent(jobsFile)}`);
  const store = existing.ok() ? JSON.parse((await existing.json()).content) : { jobs: [], seq: 1000 };

  const staleId = `run-e2e-stale-${Date.now()}`;
  const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  store.jobs.unshift({
    id: staleId,
    status: "running",
    bundleId: B.main,
    source: "raw/e2e-orphaned.md",
    maxDepth: 1,
    maxWorkers: 3,
    queuedAt: longAgo,
    startedAt: longAgo,
    endedAt: null,
    durationMs: null,
    progress: "writing 2 of 9 chapters",
    summary: null,
    error: null,
  });
  const wrote = await shell.post(`${BASE}/api/fs`, { data: { op: "write", path: jobsFile, content: JSON.stringify(store, null, 2) + "\n" } });
  expect(wrote.ok(), "could not seed the job store").toBeTruthy();

  const restarted = await shell.post(`${BASE}/api/services/${SERVICE_ID}`, { data: { action: "restart", reason: "e2e reaper check" } });
  expect(restarted.ok()).toBeTruthy();

  // the port is OS-assigned, so a restart can move it — re-resolve, never reuse
  await api.dispose();
  serviceBase = await resolveServiceBase(shell);
  api = await pinnedContext({ baseURL: serviceBase });

  let reaped: Record<string, unknown> = {};
  await expect
    .poll(
      async () => {
        const res = await api.get(`jobs/${staleId}`);
        if (!res.ok()) return "unreachable";
        reaped = await res.json();
        return reaped.status as string;
      },
      { message: "the startup sweep never reaped the orphaned run", timeout: 60_000, intervals: [1000] },
    )
    .toBe("failed");

  expect(String(reaped.error)).toMatch(/stale/i);
  expect(reaped.endedAt).toBeTruthy();
  expect(reaped.progress, "a reaped run stops pretending to be in progress").toBeNull();

  await shell.dispose();
});

test("FR-018: re-ingesting a source already in the provenance ledger starts no run", async () => {
  const url = "https://engineering.example.com/handbook/dedup-probe";

  // register it, which writes the provenance ledger entry
  await api.post(`bundles/${B.main}/import`, { data: { files: [{ path: "raw/dedup-probe.md", content: "# probe\n" }] } });
  await api.post(`bundles/${B.main}/import`, {
    data: {
      files: [{
        path: "raw/sources.json",
        content: JSON.stringify({ sources: { [url]: { rawFile: "raw/dedup-probe.md", docId: "dedup-probe", ingestedAt: "2026-10-09T00:00:00.000Z" } } }, null, 2),
      }],
    },
  });

  const before = (await (await api.get("jobs")).json()).jobs.length;
  const again = await (await api.post("jobs", { data: { bundle: B.main, source: url } })).json();
  expect(again.status).toBe("already_ingested");
  expect(again.docId).toBe("dedup-probe");
  expect(again.jobId, "a deduped source must not create a job").toBeNull();
  expect((await (await api.get("jobs")).json()).jobs.length).toBe(before);
});

test("an unknown job is a clean 404, not a 500", async () => {
  const res = await api.get("jobs/run-does-not-exist");
  expect(res.status()).toBe(404);
});

test("POST /jobs validates its input rather than starting a run it cannot describe", async () => {
  expect((await api.post("jobs", { data: { source: "raw/x.md" } })).status()).toBe(400);
  expect((await api.post("jobs", { data: { bundle: B.main } })).status()).toBe(400);
  expect((await api.post("jobs", { data: { bundle: "e2e-okf-does-not-exist", source: "raw/x.md" } })).status()).toBeGreaterThanOrEqual(400);
});

// ════════════════════════════════════════════════════════════════════════
//  NFR-006 — path safety
// ════════════════════════════════════════════════════════════════════════

test("NFR-006: a traversal attempt is rejected on every path-taking route", async () => {
  expect((await api.get(`bundles/${B.main}/concept/..%2F..%2Fetc%2Fpasswd`)).status()).toBeGreaterThanOrEqual(400);
  expect((await api.get(`bundles/${B.main}/assets/..%2F..%2F..%2Fetc%2Fpasswd`)).status()).toBeGreaterThanOrEqual(400);
  expect((await api.post("bundles", { data: { name: "../escape" } })).status()).toBeGreaterThanOrEqual(400);
});

// ════════════════════════════════════════════════════════════════════════
//  US7 / US8 / US9 — the app's three tabs
// ════════════════════════════════════════════════════════════════════════

test("FR-035: the app is a standalone master-detail app with Overview / Jobs / Query", async ({ page }) => {
  const app = await openApp(page);
  await expect(app.getByTestId("tab-overview")).toBeVisible();
  await expect(app.getByTestId("tab-jobs")).toBeVisible();
  await expect(app.getByTestId("tab-query")).toBeVisible();
  // The badge reports the service's REAL declared count — and this asserts
  // it against GET /tools rather than a literal, so the two can only agree
  // by actually agreeing.
  const { count } = await (await api.get("tools")).json();
  await expect(app.getByTestId("tool-badge")).toContainText(`${count} okf_* tools`);
  expect(count).toBe(21);
});

test("US7 AS1/AS2/AS3: Overview browses health, the concept index, a document TOC and a full chapter", async ({ page }) => {
  const app = await openApp(page);
  await app.getByTestId("tab-overview").click();

  // bundle list with per-bundle health
  await expect(app.getByTestId(`bundle-row-${B.main}`)).toBeVisible({ timeout: 15000 });
  await app.getByTestId(`bundle-row-${B.main}`).click();

  // US7 AS3 — health stat cards
  await expect(app.getByTestId("health-cards")).toBeVisible();
  await expect(app.getByTestId("stat-terms")).not.toHaveText("0");

  // US7 AS1 — the concept index: term -> (doc, chapter) with descriptions
  await expect(app.getByTestId("concept-index")).toBeVisible();
  await app.getByTestId("term-head-rollback").click();
  const cover = app.getByTestId("cover-deployment-canary");
  await expect(cover).toBeVisible();
  await expect(cover).toContainText("Deployment Checklist");
  await expect(cover).toContainText("auto-rollback");

  // US7 AS2 — the stored document TOC
  await app.getByTestId("detail-tab-documents").click();
  await app.getByTestId("doc-row-api-design").click();
  await expect(app.getByTestId("toc-view")).toContainText("toc/api-design.md");
  await expect(app.getByTestId("toc-item-endpoint-naming")).toContainText("plural nouns");

  // the full chapter, with the raw .md toggle showing what the tool returns
  await app.getByTestId("toc-item-endpoint-naming").click();
  await expect(app.getByTestId("chapter-body")).toBeVisible();
  await expect(app.getByTestId("chapter-frontmatter")).toContainText("api-design");
  await app.getByTestId("view-source-toggle").check();
  await expect(app.getByTestId("chapter-source")).toBeVisible();
});

test("SC-003: the Overview chapter view renders the inline-asset block with its stored interpretation", async ({ page }) => {
  const app = await openApp(page);
  await app.getByTestId(`bundle-row-${B.main}`).click();
  await app.getByTestId("detail-tab-documents").click();
  await app.getByTestId("doc-row-deployment").click();
  await app.getByTestId("toc-item-canary").click();

  await expect(app.getByTestId("asset-block")).toBeVisible();
  await expect(app.getByTestId("asset-interpretation")).toContainText("Auto-rollback armed");
  await expect(app.getByTestId("asset-block")).toContainText("raw/assets/deployment/canary-demo.mp4");
});

test("US8/SC-011: the Jobs tab lists runs with their lifecycle status and expands to a detail", async ({ page }) => {
  const app = await openApp(page);
  await app.getByTestId("tab-jobs").click();

  // the auto-trigger tests above ran first (serial file), so runs exist
  await expect(app.getByTestId("jobs-list")).toBeVisible({ timeout: 15000 });
  await expect(app.getByTestId("jobs-badge")).toBeVisible();

  const rows = app.locator('[data-testid^="job-row-"]');
  expect(await rows.count()).toBeGreaterThan(0);
  const first = rows.first();
  const id = (await first.getAttribute("data-testid"))!.replace("job-row-", "");
  await expect(app.getByTestId(`job-status-${id}`)).toHaveText(/queued|running|completed|failed/);

  await first.click();
  await expect(app.getByTestId(`job-detail-${id}`)).toBeVisible();
  // whichever lifecycle state it is in, the detail shows that state's panel
  // `.innerText()` returns RENDERED text, and `.job-status` is
  // `text-transform: uppercase` (app/src/index.css) — so this reads "FAILED",
  // not the "failed" the lookup below is keyed by. (The regex assertion above
  // does not catch it: toHaveText compares textContent, which is untransformed.)
  // Without the fold, the lookup returned undefined and the assertion died with
  // "toBeVisible can be only used with Locator object".
  const status = (await app.getByTestId(`job-status-${id}`).innerText()).trim().toLowerCase();
  const panel = {
    completed: app.getByTestId(`job-summary-${id}`).or(app.getByTestId(`job-detail-${id}`)),
    failed: app.getByTestId(`job-error-${id}`),
    running: app.getByTestId(`job-progress-${id}`),
    queued: app.getByTestId(`job-queued-${id}`),
  }[status as "completed" | "failed" | "running" | "queued"];
  expect(panel, `unexpected job status rendered: ${status}`).toBeDefined();
  await expect(panel).toBeVisible();
});

test("FR-041: the Jobs tab shows exactly the records core.listJobs returns — the same ones okf_list_jobs reads", async ({ page }) => {
  // okf_list_jobs, GET /jobs and the Jobs tab are one capability on three
  // surfaces: the tool and the route both call core.listJobs(), and the tab
  // renders the route's response. So asserting the tab against GET /jobs
  // asserts it against what the agent sees too — they cannot disagree
  // without one of them growing its own source of records.
  const { jobs } = await (await api.get("jobs")).json();
  expect(jobs.length, "earlier tests left runs on record").toBeGreaterThan(0);

  const app = await openApp(page);
  await app.getByTestId("tab-jobs").click();
  await expect(app.getByTestId("jobs-list")).toBeVisible({ timeout: 15000 });

  for (const job of jobs.slice(0, 5)) {
    await expect(app.getByTestId(`job-${job.id}`)).toBeVisible();
    await expect(app.getByTestId(`job-status-${job.id}`)).toHaveText(job.status);
  }
  await expect(app.getByTestId("jobs-count")).toContainText(`${jobs.length} run`);
});

test("FR-016: the app's Ingest modal starts a real run and it appears in the Jobs tab", async ({ page }) => {
  await api.post(`bundles/${B.main}/import`, { data: { files: [{ path: "raw/e2e-from-app.md", content: "# from the app\n\nbody\n" }] } });
  const before = new Set<string>(
    (await (await api.get("jobs")).json()).jobs.map((j: { id: string }) => j.id),
  );

  const app = await openApp(page);
  await expect(app.getByTestId(`bundle-row-${B.main}`)).toBeVisible({ timeout: 15000 });
  await app.getByTestId(`bundle-row-${B.main}`).click();
  await app.getByTestId("ingest-btn").click();
  await expect(app.getByTestId("modal-ingest")).toBeVisible();

  // the modal no longer tells the user to go and ask an assistant
  await expect(app.getByTestId("modal-ingest")).not.toContainText("agent_delegate");
  await expect(app.getByTestId("modal-ingest")).not.toContainText("Copy call");

  await app.getByTestId("ingest-source").fill("raw/e2e-from-app.md");
  await app.getByTestId("start-ingest").click();

  // the dialog gets out of the way once the run is started: there is nothing
  // left to read in it, and the run is watched in the Jobs tab — which the
  // shell switches to, so the user lands on the thing they just started
  await expect(app.getByTestId("modal-ingest")).toHaveCount(0, { timeout: 20000 });
  await expect(app.getByTestId("view-jobs")).not.toHaveClass(/hidden/);

  // the run is real: it exists on the service, and the Jobs tab shows it
  const after = (await (await api.get("jobs")).json()).jobs as { id: string; source: string }[];
  const created = after.find((j) => !before.has(j.id));
  expect(created, "the modal must create a job, not just describe one").toBeTruthy();
  expect(created!.source).toBe("raw/e2e-from-app.md");

  await expect(app.getByTestId(`job-${created!.id}`)).toBeVisible({ timeout: 15000 });

  // that the modal starts the run is under test, not the run
  await stopRun(created!.id);
});

test("US9/FR-042: the Query tab's Graph fills its pane with category-coloured nodes and labelled edges", async ({ page }) => {
  const app = await openApp(page);
  await app.getByTestId("tab-query").click();
  await app.getByTestId("query-bundle-select").selectOption(B.main);

  await expect(app.getByTestId("graph-legend")).toBeVisible();
  const svg = app.getByTestId("graph-svg");
  await expect(svg).toBeVisible({ timeout: 15000 });

  // the viewBox comes from the REAL container size — the graph fills its pane
  const stageBox = await app.getByTestId("graph-stage").boundingBox();
  const viewBox = await svg.getAttribute("viewBox");
  expect(viewBox).toBeTruthy();
  const [, , vbW, vbH] = viewBox!.split(" ").map(Number);
  expect(Math.abs(vbW - stageBox!.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(vbH - stageBox!.height)).toBeLessThanOrEqual(2);
  expect(vbW).toBeGreaterThan(200);

  // all three node categories are rendered
  await expect(app.locator(".g-node.doc").first()).toBeVisible();
  await expect(app.locator(".g-node.chap").first()).toBeVisible();
  await expect(app.locator(".g-node.concept").first()).toBeVisible();

  // directed, labelled edges of all three kinds
  await expect(app.locator(".g-edge.contain").first()).toBeVisible();
  await expect(app.locator(".g-edge.cover").first()).toBeVisible();
  expect(await app.locator(".g-elbl").filter({ hasText: "contains" }).count()).toBeGreaterThan(0);
  expect(await app.locator(".g-elbl").filter({ hasText: "covers" }).count()).toBeGreaterThan(0);
  // directed = every edge carries an arrow marker
  expect(await app.locator('.g-edge[marker-end]').count()).toBe(await app.locator(".g-edge").count());
});

test("FR-043/US9 AS2: the shared search reflects in BOTH views — Table shows the hits, Graph focuses on them", async ({ page }) => {
  const app = await openApp(page);
  await app.getByTestId("tab-query").click();
  await app.getByTestId("query-bundle-select").selectOption(B.main);
  await expect(app.getByTestId("graph-svg")).toBeVisible({ timeout: 15000 });

  const totalNodes = await app.locator(".g-node").count();
  await app.getByTestId("query-search").fill("rollback");

  // the search really ran okf_search — the matched term is named
  await expect(app.getByTestId("matched-concepts")).toContainText("rollback", { timeout: 10000 });

  // GRAPH (FR-073 e): the hits light up, everything else fades
  await expect(app.locator(".g-node.match").first()).toBeVisible();
  const matched = await app.locator(".g-node.match").count();
  const faded = await app.locator(".g-node.faded").count();
  expect(matched).toBeGreaterThan(0);
  expect(faded).toBeGreaterThan(0);
  expect(matched + faded).toBe(totalNodes);
  await expect(app.getByTestId("graph-hint")).toContainText("match");

  // TABLE: the ranked hits, each saying what matched
  await app.getByTestId("view-table").click();
  await expect(app.getByTestId("search-hits")).toBeVisible();
  await expect(app.getByTestId("hit-deployment-canary")).toBeVisible();
  await expect(app.getByTestId("hit-deployment-canary").getByTestId("hit-kind")).toHaveText("concept");

  // a full-text-only word: found, with the sentence it is in
  // ("sparklines" is only in the canary chapter's stored asset interpretation)
  await app.getByTestId("query-search").fill("sparklines");
  await expect(app.locator('[data-testid="hit-excerpt"]').first()).toContainText("sparklines", { timeout: 10000 });

  // clearing restores the node table
  await app.getByTestId("query-clear").click();
  await expect(app.getByTestId("table-view")).toBeVisible();
});

test("US9 AS3/SC-012: selecting a node opens the full chapter in the resizable pane with a working Open source", async ({ page }) => {
  const app = await openApp(page);
  await app.getByTestId("tab-query").click();
  await app.getByTestId("query-bundle-select").selectOption(B.main);
  await expect(app.getByTestId("graph-svg")).toBeVisible({ timeout: 15000 });

  // from the Table (a stable click target), open a chapter
  await app.getByTestId("view-table").click();
  await app.getByTestId("table-row-chap-deployment/canary").click();

  // the FULL chapter renders in the pane, inline asset and all
  await expect(app.getByTestId("pane-chapter")).toBeVisible();
  await expect(app.getByTestId("pane-chapter-title")).toContainText("Canary and Rollback");
  await expect(app.getByTestId("asset-interpretation")).toContainText("Auto-rollback armed");
  await app.getByTestId("pane-raw-toggle").click();
  await expect(app.getByTestId("chapter-source")).toBeVisible();

  // SC-012 — "Open source" targets the document's ORIGINAL ingested URL
  const link = app.getByTestId("open-source-link");
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", /^raw\/deployment\.md$|^https?:\/\//);

  // a document ingested from a URL shows that URL
  await app.getByTestId("table-row-doc-api-design").click();
  await expect(app.getByTestId("pane-doc")).toBeVisible();
  await expect(app.getByTestId("open-source-link")).toHaveAttribute(
    "href",
    "https://engineering.example.com/handbook/api-design",
  );
});

test("FR-043: the reader pane is mouse-resizable and the graph re-lays-out to the new width", async ({ page }) => {
  const app = await openApp(page);
  await app.getByTestId("tab-query").click();
  await app.getByTestId("query-bundle-select").selectOption(B.main);
  await expect(app.getByTestId("graph-svg")).toBeVisible({ timeout: 15000 });

  const paneBefore = (await app.getByTestId("reader-pane").boundingBox())!;
  const stageBefore = (await app.getByTestId("graph-stage").boundingBox())!;
  const handle = (await app.getByTestId("pane-resizer").boundingBox())!;

  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 140, handle.y + handle.height / 2, { steps: 12 });
  await page.mouse.up();

  const paneAfter = (await app.getByTestId("reader-pane").boundingBox())!;
  expect(paneAfter.width).toBeGreaterThan(paneBefore.width + 80);

  // the graph re-fit itself: the viewBox tracks the (now narrower) stage
  const stageAfter = (await app.getByTestId("graph-stage").boundingBox())!;
  expect(stageAfter.width).toBeLessThan(stageBefore.width - 80);
  const [, , vbW] = (await app.getByTestId("graph-svg").getAttribute("viewBox"))!.split(" ").map(Number);
  expect(Math.abs(vbW - stageAfter.width)).toBeLessThanOrEqual(2);
});

test("US9 AS1: selecting a concept-term node opens its covering chapters in the pane", async ({ page }) => {
  const app = await openApp(page);
  await app.getByTestId("tab-query").click();
  await app.getByTestId("query-bundle-select").selectOption(B.main);
  await expect(app.getByTestId("graph-svg")).toBeVisible({ timeout: 15000 });

  await app.getByTestId("view-table").click();
  await app.getByTestId("table-row-doc-api-design").click(); // the DOCUMENT row opens its TOC
  await expect(app.getByTestId("pane-doc")).toBeVisible();

  // the concept-term node routes to the chapters it covers
  // with no query the Table lists every node, the concept term among them
  await app.getByTestId("table-row-concept-naming").click();
  await expect(app.getByTestId("pane-concept")).toBeVisible();
  await expect(app.getByTestId("pane-term")).toHaveText("naming");
  await expect(app.getByTestId("pane-cover-api-design-endpoint-naming")).toBeVisible();
});

test("the app renders live service data, not a built-in fixture", async ({ page }) => {
  // The mockup ships sample bundles; the app must not. Everything on screen
  // comes from the running service — so a bundle this suite created is
  // present, and the mockup's fixtures are not.
  const app = await openApp(page);
  await expect(app.getByTestId(`bundle-row-${B.main}`)).toBeVisible({ timeout: 15000 });
  await expect(app.getByTestId("service-error")).toHaveCount(0);
  await expect(app.getByTestId("bundle-row-engineering")).toHaveCount(0);
  await expect(app.getByTestId("bundle-row-employee-handbook")).toHaveCount(0);
});

// ════════════════════════════════════════════════════════════════════════
//  FR-053 / FR-054 / US10 / SC-016 — PERSON-KIND TERMS (ADR-011)
// ════════════════════════════════════════════════════════════════════════
//
// A salient person (the author, a named key figure) is NOT a new entity: it
// is an ordinary term in the SAME derived concept index, carrying
// `kind: "person"`, derived from a `person_terms` frontmatter array that sits
// parallel to `concepts`. So these tests assert exactly three things:
//
//   1. writing `person_terms` is all it takes — the rebuild derives the kind
//      (O2), and the write path preserves the array verbatim (NFR-005);
//   2. every surface copies that kind through — search rows, the vocabulary,
//      the graph's 4th node type, the app (O1/O3);
//   3. nothing that worked before changed — a bundle with no `person_terms`
//      is all-`topic` with a 3-type graph, and the tool surface is untouched
//      (O4/O5).
//
// The tool handlers themselves have no HTTP face (the 039 surface is reached
// through the assistant, not over REST), so — as elsewhere in this file —
// each tool-level claim is asserted as its DECLARATION plus the shared core
// behind it, driven through the REST route that calls the very same
// `core.*` function the tool does.

/** A document stub carrying `person_terms` — the AUTHOR, at document level. */
function personDocument(
  docId: string,
  title: string,
  summary: string,
  uri: string,
  persons: string[],
): { path: string; content: string } {
  const fm = [
    `id: ${docId}`,
    "type: document",
    `title: ${title}`,
    `summary: ${JSON.stringify(summary)}`,
    "person_terms:",
    ...persons.map((p) => `  - ${p}`),
    "sources:",
    `  - id: ${docId}.md`,
    `    uri: ${uri}`,
    "created_at: 2026-08-01T00:00:00.000Z",
    "updated_at: 2026-08-01T00:00:00.000Z",
  ].join("\n");
  return { path: `concepts/${docId}.md`, content: `---\n${fm}\n---\n\n# ${title}\n` };
}

/** The author "Diego Córdoba" on the document stub, the key figure
 *  "María Quispe" on one chapter — the shape §7.4 of the skill prescribes. */
async function seedPerson(): Promise<void> {
  await del(B.person);
  const files = [
    { path: "index.md", content: "# E2E Person\n" },
    personDocument(
      "water-rights",
      "Water Rights in the Andes",
      "Andean water governance and its contested history.",
      "https://example.org/water-rights",
      ["Diego Córdoba"],
    ),
    chapter(
      "water-rights",
      "history",
      "A Contested History",
      "Colonial allocation, modern conflict, and who the water was taken from.",
      ["water-rights", "andean-history"],
      // a chapter-level key figure, written EXACTLY as the source spells it
      { person_terms: "[María Quispe]" },
    ),
    chapter("water-rights", "law", "The Legal Frame", "The statutes that govern allocation today.", [
      "water-rights",
      "law",
    ]),
  ];
  expect((await api.post(`bundles/${B.person}/import`, { data: { files } })).ok()).toBeTruthy();
}

test("O1/US10/SC-016: a person is found by the EXISTING okf_search — full name, first name, surname", async () => {
  await seedPerson();

  // the SAME /search route the okf_search tool's core.search() backs. No
  // person branch anywhere in it: a name is an ordinary term-name hit.
  for (const query of ["Diego Córdoba", "Diego", "Córdoba", "quispe"]) {
    const res = await api.get(`bundles/${B.person}/search?query=${encodeURIComponent(query)}`);
    expect(res.ok()).toBeTruthy();
    const { rows } = await res.json();
    expect(rows.length, `"${query}" returned no rows`).toBeGreaterThan(0);
    const personRows = rows.filter((r: { kind: string }) => r.kind === "person");
    expect(personRows.length, `"${query}" returned no kind:'person' row`).toBeGreaterThan(0);
    // every row names the covering document, and a chapter when it has one
    for (const r of personRows) expect(r.docId).toBe("water-rights");
  }

  // the author covers the DOCUMENT (an empty chId) and the chapter that also
  // names them; the key figure covers only her chapter
  const diego = await (await api.get(`bundles/${B.person}/search?query=${encodeURIComponent("Córdoba")}`)).json();
  expect(diego.rows.some((r: { chId: string }) => r.chId === "")).toBe(true);
  const quispe = await (await api.get(`bundles/${B.person}/search?query=Quispe`)).json();
  expect(quispe.rows.map((r: { chId: string }) => r.chId)).toEqual(["history"]);

  // a topic hit still reports kind:'topic' — the field is additive, not a mode
  const topic = await (await api.get(`bundles/${B.person}/search?query=statutes`)).json();
  expect(topic.rows.length).toBeGreaterThan(0);
  expect(topic.rows.every((r: { kind: string }) => r.kind === "topic")).toBe(true);
});

test("O1/FR-054: the vocabulary reports a kind per term, and okf_list_concepts declares the kind filter", async () => {
  const terms = await vocabulary(B.person);

  // every term carries a kind — never undefined, on any bundle
  expect(terms.every((t) => t.kind === "topic" || t.kind === "person")).toBe(true);

  const persons = terms.filter((t) => t.kind === "person").map((t) => t.name).sort();
  expect(persons).toEqual(["Diego Córdoba", "María Quispe"]);
  // S1: the DISPLAY name keeps the case the source wrote, while the match is
  // case-insensitive (asserted by the search test above)
  expect(persons).not.toContain("diego córdoba");
  expect(terms.find((t) => t.name === "water-rights")!.kind).toBe("topic");
  // the author's coverage is the DOCUMENT he wrote — one row, empty chId
  expect(terms.find((t) => t.name === "Diego Córdoba")!.count).toBe(1);
  expect(terms.find((t) => t.name === "Diego Córdoba")!.covers[0].chId).toBe("");
  expect(terms.find((t) => t.name === "María Quispe")!.count).toBe(1);

  // the tool-level filter: no HTTP face to invoke, so assert the DECLARATION
  // (the handler forwards it straight to the same core.listConcepts() this
  // route reads) — `kind` is optional, so `bundle` stays the only requirement
  const { tools } = await (await api.get("tools")).json();
  const list = tools.find((t: { name: string }) => t.name === "okf_list_concepts");
  expect(list.inputSchema.properties.kind.enum.sort()).toEqual(["all", "person", "topic"]);
  expect(list.inputSchema.required).toEqual(["bundle"]);

  // what that filter filters is this, client-side-equivalent:
  expect(terms.filter((t) => t.kind === "person")).toHaveLength(2);
  expect(terms.filter((t) => t.kind === "topic").length).toBe(terms.length - 2);
});

test("O2/FR-053: writing person_terms is the whole mechanism — the rebuild derives kind:'person'", async () => {
  // NFR-005 — the array the ingest agent writes with okf_upsert_concept
  // round-trips VERBATIM through the shallow frontmatter merge: no writer
  // change was needed for this scope-add, and that is what makes the
  // derivation trustworthy.
  const stub = await (await api.get(`bundles/${B.person}/concept/water-rights`)).json();
  expect(stub.frontmatter.person_terms).toEqual(["Diego Córdoba"]);
  const ch = await (await api.get(`bundles/${B.person}/concept/water-rights/history`)).json();
  expect(ch.frontmatter.person_terms).toEqual(["María Quispe"]);
  // and the name is NOT smuggled into `concepts` — parallel arrays
  expect(ch.frontmatter.concepts).toEqual(["water-rights", "andean-history"]);
  expect(ch.frontmatter.concepts).not.toContain("maría quispe");

  // write ANOTHER chapter naming a new key figure; the index re-derives
  const files = [
    chapter(
      "water-rights",
      "today",
      "The Dispute Today",
      "The 2026 arbitration and the communities it affects.",
      ["water-rights"],
      { person_terms: "[María Quispe, Ana Flores]" },
    ),
  ];
  expect((await api.post(`bundles/${B.person}/import`, { data: { files } })).ok()).toBeTruthy();

  const byName = Object.fromEntries((await vocabulary(B.person)).map((t) => [t.name, t]));
  expect(byName["Ana Flores"].kind).toBe("person");
  // the SAME person named by two chapters consolidates into ONE term
  expect(byName["María Quispe"].kind).toBe("person");
  expect(byName["María Quispe"].count).toBe(2);
  expect(
    byName["María Quispe"].covers.map((c: { chId: string }) => c.chId).sort(),
  ).toEqual(["history", "today"]);
});

test("O3/FR-054: the derived graph gains a 4th node type — person", async () => {
  const g = await (await api.get(`bundles/${B.person}/graph`)).json();

  const types = new Set(g.nodes.map((n: { type: string }) => n.type));
  expect(types).toEqual(new Set(["doc", "chap", "concept", "person"]));

  // the node: lowercased id, ORIGINAL-CASE label, count-driven radius input
  const diego = g.nodes.find((n: { type: string; label: string }) => n.type === "person" && n.label === "Diego Córdoba");
  expect(diego).toBeTruthy();
  expect(diego.id).toBe("person:diego córdoba");
  expect(diego.key).toBe("person:diego córdoba");
  expect(diego.term).toBe("Diego Córdoba");
  expect(diego.count).toBe(1);

  // coverage edges to a person are the SAME edge kind as topic coverage —
  // the author's runs from the DOCUMENT, a key figure's from her chapter
  const authored = g.edges.find((e: { to: string; from: string }) => e.to === "person:diego córdoba" && e.from === "doc:water-rights");
  expect(authored.kind).toBe("coverage");
  expect(authored.label).toBe("covers");
  const subject = g.edges.find((e: { to: string; from: string }) => e.to === "person:maría quispe" && e.from === "chap:water-rights/history");
  expect(subject.kind).toBe("coverage");

  // no edge dangles, exactly as for the three original types
  const ids = new Set(g.nodes.map((n: { id: string }) => n.id));
  for (const e of g.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
});

test("O4: the backward-compat guard — a bundle with NO person_terms is unchanged in every surface", async () => {
  await del(B.noPerson);
  const files = [
    { path: "index.md", content: "# E2E No Person\n" },
    document("api-design", "API Design Rules", "How we shape HTTP APIs.", "https://example.com/api-design"),
    chapter("api-design", "endpoint-naming", "Endpoint Naming", "Plural nouns, no verbs, versioned paths.", [
      "api-design",
      "naming",
    ]),
  ];
  expect((await api.post(`bundles/${B.noPerson}/import`, { data: { files } })).ok()).toBeTruthy();

  // the vocabulary is all-topic: no 'person', and no undefined
  const noPersonVocab = await vocabulary(B.noPerson);
  expect(noPersonVocab.length).toBeGreaterThan(0);
  expect(noPersonVocab.every((t) => t.kind === "topic")).toBe(true);
  expect(noPersonVocab.some((t) => t.kind === undefined)).toBe(false);

  // the graph is the ORIGINAL three node types — the 4th appears only when
  // the bundle actually has a person
  const g = await (await api.get(`bundles/${B.noPerson}/graph`)).json();
  expect(new Set(g.nodes.map((n: { type: string }) => n.type))).toEqual(new Set(["doc", "chap", "concept"]));
  expect(g.nodes.some((n: { type: string }) => n.type === "person")).toBe(false);
  expect(g.nodes.every((n: { type: string }) => n.type !== undefined)).toBe(true);

  // search still works, and reports kind:'topic' rather than nothing
  const { rows } = await (await api.get(`bundles/${B.noPerson}/search?query=naming`)).json();
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r: { kind: string }) => r.kind === "topic")).toBe(true);

  // export -> import round-trips, and the re-imported bundle is still
  // all-topic (the kind is re-derived from content, never carried as state)
  const exported = await (await api.get(`bundles/${B.noPerson}/export`)).json();
  await del(B.copy);
  expect(
    (await api.post(`bundles/${B.copy}/import`, { data: { files: exported.files } })).ok(),
  ).toBeTruthy();
  const copy = await vocabulary(B.copy);
  expect(copy.map((t) => t.name).sort()).toEqual(noPersonVocab.map((t) => t.name).sort());
  expect(copy.every((t) => t.kind === "topic")).toBe(true);

  // and the PERSON bundle survives the same round-trip with its kinds intact
  const pExport = await (await api.get(`bundles/${B.person}/export`)).json();
  await del(B.copy);
  expect((await api.post(`bundles/${B.copy}/import`, { data: { files: pExport.files } })).ok()).toBeTruthy();
  const pCopy = await vocabulary(B.copy);
  expect(pCopy.filter((t) => t.kind === "person").map((t) => t.name).sort()).toEqual(["Ana Flores", "Diego Córdoba", "María Quispe"]);
  await del(B.copy);
});

test("O5/SC-007: the person scope-add declares NO new tool — the surface is untouched", async () => {
  const { count, tools } = await (await api.get("tools")).json();
  const names = tools.map((t: { name: string }) => t.name).sort();

  // pinned against this file's own expectation list, which this scope-add
  // does not touch: person extraction rides on the tools that already exist
  expect(count).toBe(EXPECTED_TOOLS.length);
  expect(names).toEqual(EXPECTED_TOOLS);
  expect(names.some((n: string) => /person/i.test(n))).toBe(false);

  // the two tools that gained a field still declare the same requirements
  const search = tools.find((t: { name: string }) => t.name === "okf_search");
  expect(search.inputSchema.required).toEqual(["bundle", "query"]);
  expect(search.parallelSafe).toBe(true);
});

test("O3/N2–N5: the app paints the 4th category teal — graph, legend, table, pane", async ({ page }) => {
  const app = await openApp(page);
  await app.getByTestId("tab-query").click();
  await app.getByTestId("query-bundle-select").selectOption(B.person);
  await expect(app.getByTestId("graph-svg")).toBeVisible({ timeout: 15000 });

  // the 4th legend entry and the teal node itself
  await expect(app.getByTestId("legend-person")).toContainText("Person");
  await expect(app.locator(".g-node.person").first()).toBeVisible();
  expect(await app.locator(".g-node.person").count()).toBe(3);

  // the shared search highlights a person node like any other node
  await app.getByTestId("query-search").fill("Córdoba");
  await expect(app.getByTestId("matched-concepts")).toContainText("Diego Córdoba", { timeout: 10000 });
  await expect(app.getByTestId("matched-concepts")).toContainText("matched person");
  await expect(app.locator(".g-node.person.match").first()).toBeVisible();
  await app.getByTestId("query-clear").click();

  // the Table's Kind column, and the Person row it labels
  await app.getByTestId("view-table").click();
  const row = app.getByTestId("table-row-person-diego córdoba");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Person");
  await expect(app.getByTestId("table-kind-person-diego córdoba")).toHaveText("person");

  // opening a person opens the SAME term view, labeled "Person"
  await row.click();
  await expect(app.getByTestId("pane-concept")).toBeVisible();
  await expect(app.getByTestId("pane-term")).toHaveText("Diego Córdoba");
  await expect(app.getByTestId("pane-term-kind")).toContainText("Person");

  // and the Overview concept index gives the term a teal `person` pill
  await app.getByTestId("tab-overview").click();
  await app.getByTestId(`bundle-row-${B.person}`).click();
  await expect(app.getByTestId("concept-index")).toBeVisible();
  await expect(app.getByTestId("term-kind-Diego Córdoba")).toHaveText("person");
  await expect(app.getByTestId("term-kind-water-rights")).toHaveText("concept");
});

// ════════════════════════════════════════════════════════════════════════
//  FR-050 / FR-051 / FR-052 / SC-007 — JOB CONTROL (cancel & delete)
// ════════════════════════════════════════════════════════════════════════
//
// The scope-add on top of the auto-trigger: a run you started can be STOPPED
// (into a distinct `cancelled` terminal state, not a failure), and a run that
// has finished can be CLEARED (the record only — never bundle content).
//
// WHY THESE DRIVE THE REST ROUTES. `okf_cancel_job` / `okf_delete_job` are
// 039 tools dispatched over worker IPC; there is no HTTP face to call them
// from a test. `POST /jobs/<id>/cancel` and `DELETE /jobs/<id>` run the SAME
// core.cancelJob / core.deleteJob those tools call (ADR-003), so exercising
// the routes exercises the tools' worker logic exactly; the tool DECLARATIONS
// are asserted separately against GET /tools (C3).
//
// WHY THE FIXTURES ARE SEEDED. A `queued` job is a window a real run leaves
// in milliseconds, and cancelling a real run would burn a live provider call
// for a state machine assertion. So the records are written straight into the
// persisted store and the service restarted — the same seam the reaper test
// uses. The seeded jobs are minutes old, well inside the 30-minute staleness
// window, so the startup sweep leaves them alone.

let jobFixtures: { queued: string; completed: string; running: string } | null = null;

async function seedJobControlFixtures(): Promise<{ queued: string; completed: string; running: string }> {
  if (jobFixtures) return jobFixtures;

  const shell = await pinnedContext();
  const cfg = await (await api.get("config")).json();
  const bundleRoot = (cfg.runtime && cfg.runtime.bundleRoot) || "/KnowledgeBase";
  const jobsFile = `${bundleRoot}/.jobs/jobs.json`;

  const existing = await shell.get(`${BASE}/api/fs?op=read&path=${encodeURIComponent(jobsFile)}`);
  const store = existing.ok() ? JSON.parse((await existing.json()).content) : { jobs: [], seq: 1000 };

  const stamp = Date.now();
  const ids = {
    queued: `run-e2e-cancel-queued-${stamp}`,
    completed: `run-e2e-terminal-${stamp}`,
    running: `run-e2e-running-${stamp}`,
  };
  const now = new Date().toISOString();
  const base = {
    bundleId: B.main,
    source: "raw/e2e-job-control.md",
    maxDepth: 1,
    maxWorkers: 3,
    queuedAt: now,
    startedAt: null as string | null,
    endedAt: null as string | null,
    durationMs: null as number | null,
    progress: null as string | null,
    summary: null as unknown,
    error: null as string | null,
    runId: null as string | null,
    cancelRequested: false,
  };

  store.jobs.unshift(
    { ...base, id: ids.queued, status: "queued" },
    {
      ...base,
      id: ids.completed,
      status: "completed",
      startedAt: now,
      endedAt: now,
      durationMs: 1234,
      summary: { chapters: 2, concepts: 3, assets: 0, refsSkipped: 0, refsFailed: 0, written: [], text: "2 chapters written.", toolCalls: 7 },
    },
    { ...base, id: ids.running, status: "running", startedAt: now, progress: "writing 2 of 5 chapters" },
  );

  const wrote = await shell.post(`${BASE}/api/fs`, {
    data: { op: "write", path: jobsFile, content: JSON.stringify(store, null, 2) + "\n" },
  });
  expect(wrote.ok(), "could not seed the job store").toBeTruthy();

  // PAUSE the run queue (maxConcurrentRuns 0) across this restart. On startup
  // the service starts every queued job — so the seeded `queued` fixture would
  // otherwise launch a real ingest agent run instead of waiting to be
  // cancelled. Restored in afterAll.
  const cfgNow = await (await api.get("config")).json();
  const priorCap = cfgNow.runtime && cfgNow.runtime.maxConcurrentRuns;
  const paused = await shell.patch(`${BASE}/api/services/${SERVICE_ID}/config`, {
    data: { file: SERVICE_ID, patch: { maxConcurrentRuns: 0 } },
  });
  expect(paused.ok(), "could not pause the run queue for the fixtures").toBeTruthy();
  restoreRunQueue = async () => {
    const s2 = await pinnedContext();
    await s2.patch(`${BASE}/api/services/${SERVICE_ID}/config`, {
      data: { file: SERVICE_ID, patch: { maxConcurrentRuns: Number.isFinite(priorCap) ? priorCap : 2 } },
    });
    await s2.post(`${BASE}/api/services/${SERVICE_ID}`, { data: { action: "restart", reason: "e2e: unpause the run queue" } });
    await s2.dispose();
  };

  const restarted = await shell.post(`${BASE}/api/services/${SERVICE_ID}`, {
    data: { action: "restart", reason: "e2e job-control fixtures" },
  });
  expect(restarted.ok()).toBeTruthy();

  // the port is OS-assigned, so a restart can move it — re-resolve, never reuse
  await api.dispose();
  serviceBase = await resolveServiceBase(shell);
  api = await pinnedContext({ baseURL: serviceBase });
  await shell.dispose();

  jobFixtures = ids;
  return ids;
}

test("C1 (FR-051/FR-050): a queued run cancels into the distinct `cancelled` state; terminal is 409, unknown is 404", async () => {
  const ids = await seedJobControlFixtures();

  // the fixture is really there, and really queued
  expect((await (await api.get(`jobs/${ids.queued}`)).json()).status).toBe("queued");

  const res = await api.post(`jobs/${ids.queued}/cancel`);
  expect(res.ok(), "cancelling a queued run must succeed").toBeTruthy();
  const cancelled = await res.json();

  // the WHOLE point of the state: cancelled, terminal, and NOT an error
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.error, "a cancel is an intentional stop — it carries no error").toBeNull();
  expect(cancelled.endedAt).toBeTruthy();
  expect(cancelled.durationMs).not.toBeNull();
  expect(cancelled.progress, "a terminal transition clears progress").toBeNull();

  // ADR-010 S4: no runId had been captured yet, so the intent is recorded for
  // the launcher to act on the moment `run_started` arrives
  expect(cancelled.runId).toBeNull();
  expect(cancelled.cancelRequested).toBe(true);

  // it persisted, and the list surface (what okf_list_jobs reads) shows it
  const after = await (await api.get(`jobs/${ids.queued}`)).json();
  expect(after.status).toBe("cancelled");
  expect(after.error).toBeNull();
  const { jobs, active } = await (await api.get("jobs")).json();
  const listed = jobs.find((j: { id: string }) => j.id === ids.queued);
  expect(listed, "a cancelled run stays listed — cancel is not delete").toBeTruthy();
  expect(listed.status).toBe("cancelled");
  expect(
    jobs.filter((j: { status: string }) => j.status === "running" || j.status === "queued").length,
  ).toBe(active);

  // cancelling something that already ended is a 409, and changes nothing
  const onTerminal = await api.post(`jobs/${ids.completed}/cancel`);
  expect(onTerminal.status()).toBe(409);
  expect(JSON.stringify(await onTerminal.json())).toMatch(/already completed/i);
  expect((await (await api.get(`jobs/${ids.completed}`)).json()).status).toBe("completed");

  // including the one just cancelled — terminal is terminal
  expect((await api.post(`jobs/${ids.queued}/cancel`)).status()).toBe(409);

  // an unknown job is a clean 404, not a 500
  expect((await api.post("jobs/run-does-not-exist/cancel")).status()).toBe(404);
});

test("C2 (FR-052/FR-051): a finished run's record deletes; a running one is 409; an unknown one is 404", async () => {
  const ids = await seedJobControlFixtures();

  const before = { ...(await (await api.get(`bundles/${B.main}`)).json()), documents: await documentsOf(B.main), conceptIndex: await vocabulary(B.main) };

  const res = await api.delete(`jobs/${ids.completed}`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.deleted).toBe(true);
  expect(body.jobId).toBe(ids.completed);

  // gone from BOTH surfaces — the record, and the list okf_list_jobs reads
  expect((await api.get(`jobs/${ids.completed}`)).status()).toBe(404);
  const { jobs } = await (await api.get("jobs")).json();
  expect(jobs.some((j: { id: string }) => j.id === ids.completed)).toBe(false);

  // and the bundle it ran against is untouched: deleting a job never deletes
  // knowledge (FR-051)
  const after = { ...(await (await api.get(`bundles/${B.main}`)).json()), documents: await documentsOf(B.main), conceptIndex: await vocabulary(B.main) };
  expect(after.documents.length).toBe(before.documents.length);
  expect(after.conceptIndex.length).toBe(before.conceptIndex.length);
  expect(after.health.chapters).toBe(before.health.chapters);

  // a still-running run is refused — cancel it first
  const onRunning = await api.delete(`jobs/${ids.running}`);
  expect(onRunning.status()).toBe(409);
  expect(JSON.stringify(await onRunning.json())).toMatch(/cancel it first/i);
  expect((await (await api.get(`jobs/${ids.running}`)).json()).status).toBe("running");

  // an unknown job is a clean 404
  expect((await api.delete("jobs/run-does-not-exist")).status()).toBe(404);

  // cancel → delete is the sequence the 409 asks for, and it works (this also
  // clears the fixtures this block seeded)
  expect((await api.post(`jobs/${ids.running}/cancel`)).ok()).toBeTruthy();
  expect((await (await api.get(`jobs/${ids.running}`)).json()).status).toBe("cancelled");
  expect((await api.delete(`jobs/${ids.running}`)).ok()).toBeTruthy();
  expect((await api.delete(`jobs/${ids.queued}`)).ok(), "a cancelled run is terminal, so it is deletable").toBeTruthy();

  const left = (await (await api.get("jobs")).json()).jobs;
  for (const id of Object.values(ids)) expect(left.some((j: { id: string }) => j.id === id)).toBe(false);
});

test("C3 (SC-007): the tool surface is exactly 21 — the job-control pair is declared, and is not parallelSafe", async () => {
  const { count, tools } = await (await api.get("tools")).json();
  expect(count).toBe(21);
  expect(tools.length).toBe(21);
  expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(EXPECTED_TOOLS);

  const byName = new Map(tools.map((t: { name: string }) => [t.name, t]));
  for (const name of ["okf_cancel_job", "okf_delete_job"]) {
    const tool = byName.get(name) as { inputSchema: { required: string[]; properties: Record<string, unknown> }; parallelSafe: boolean };
    expect(tool, `${name} must be declared`).toBeTruthy();
    expect(tool.inputSchema.required).toContain("jobId");
    expect(tool.parallelSafe, `${name} mutates the job store — it must not be parallelSafe`).toBe(false);
  }

  // the job-control pair added NOTHING to the read-only set (FR-038's
  // parallelSafe contract still describes exactly the readers)
  const parallel = tools.filter((t: { parallelSafe: boolean }) => t.parallelSafe).map((t: { name: string }) => t.name).sort();
  expect(parallel).toEqual([...READ_ONLY_TOOLS].sort());
});

// ════════════════════════════════════════════════════════════════════════
//  INGEST CHUNKING — FR-055 / FR-056 / SC-017 (ADR-012)
// ════════════════════════════════════════════════════════════════════════
//
// Chunking happens inside the `okf_add_raw_source` handler, in the worker, at
// the moment the run hands the service the acquired bytes — NOT in
// `okf_ingest` (the worker is a plain Node thread outside Next.js: no
// `web_fetch`, so it cannot stage a URL source itself).
//
// The okf_* tools have no HTTP face (039 dispatches them over worker IPC), so
// these drive `POST /bundles/<b>/raw`, which runs the very same
// `core.addRawSource` the tool runs — one capability, two surfaces (ADR-003).
// The tool DECLARATION is asserted separately, against GET /tools.

/** The service's own effective config, as GET /config reports it. */
async function serviceConfig(): Promise<{ runtime?: { bundleRoot?: string; maxChunkSize?: number }; maxChunkSize?: number }> {
  const res = await api.get("config");
  expect(res.ok(), "GET /config must answer").toBeTruthy();
  return res.json();
}

async function readVfs(shell: APIRequestContext, vfsPath: string): Promise<string | null> {
  const res = await shell.get(`${BASE}/api/fs?op=read&path=${encodeURIComponent(vfsPath)}`);
  if (!res.ok()) return null;
  return (await res.json()).content as string;
}

/** The body of a chunk file, with its `---` frontmatter block stripped. */
function chunkBody(raw: string): string {
  const m = /^---\n([\s\S]*?)\n---\n*/.exec(raw);
  return m ? raw.slice(m[0].length) : raw;
}

function chunkFrontmatter(raw: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  return m ? m[1] : "";
}

test("U3 (FR-056): GET /config reports maxChunkSize, defaulting to 32000", async () => {
  const cfg = await serviceConfig();
  const maxChunkSize = cfg.runtime?.maxChunkSize ?? cfg.maxChunkSize;
  expect(typeof maxChunkSize, "maxChunkSize must be exposed on /config").toBe("number");
  // the shipped default (config/okf-knowledge-base.json + the service.json
  // configSchema both say 32000, ~8K tokens)
  expect(maxChunkSize).toBe(32000);
});

test("U1 (FR-055/SC-017): a large source is pre-split into bounded chunks, on disk and in the response", async () => {
  const shell = await pinnedContext();
  const cfg = await serviceConfig();
  const bundleRoot = cfg.runtime?.bundleRoot || "/KnowledgeBase";
  const maxChunkSize = (cfg.runtime?.maxChunkSize ?? cfg.maxChunkSize) as number;

  expect((await api.post(`bundles`, { data: { name: B.chunk, title: "E2E Chunking" } })).ok()).toBeTruthy();

  // a genuinely oversized source: several headings, each section itself well
  // over the bound, so BOTH the heading split and the paragraph/sentence
  // split inside a section are exercised
  const paragraph = (n: number) =>
    `Paragraph ${n} of this section states a complete thought. It continues with a second sentence for the sentence splitter to find. ` .repeat(12).trim();
  const section = (title: string, level: number, count: number) =>
    `${"#".repeat(level)} ${title}\n\n${Array.from({ length: count }, (_, i) => paragraph(i)).join("\n\n")}\n`;
  const content =
    section("Part I: Foundations", 1, 40) +
    "\n" +
    section("Section 1: Definitions", 2, 40) +
    "\n" +
    section("Part II: Numerical Methods", 1, 40) +
    "\n" +
    section("Section 4: Spectral Methods", 2, 40);
  expect(content.length, "the fixture must exceed the bound or there is nothing to split").toBeGreaterThan(maxChunkSize);

  const res = await api.post(`bundles/${B.chunk}/raw`, { data: { filename: "numerical-methods.md", content } });
  expect(res.ok(), "registering a raw source must succeed").toBeTruthy();
  const body = await res.json();

  // the registration contract is unchanged — raw/ still holds the source
  expect(body.stored).toBe(true);
  expect(body.rawFile).toBe("raw/numerical-methods.md");
  expect(body.docId).toBe("numerical-methods");
  expect(body.maxChunkSize).toBe(maxChunkSize);

  // ...and it now also carries the chunk paths the agent reads one at a time
  expect(Array.isArray(body.chunks)).toBe(true);
  expect(body.chunks.length, "an oversized source must split into more than one chunk").toBeGreaterThan(1);
  const total = body.chunks.length;
  body.chunks.forEach((c: { path: string; ordinal: number; total: number }, i: number) => {
    expect(c.ordinal).toBe(i + 1);
    expect(c.total).toBe(total);
    expect(c.path).toBe(`.chunks/numerical-methods/${String(i + 1).padStart(3, "0")}.md`);
  });

  // every chunk really exists, carries its frontmatter, and respects the bound
  for (const c of body.chunks as { path: string; ordinal: number; total: number }[]) {
    const raw = await readVfs(shell, `${bundleRoot}/${B.chunk}/${c.path}`);
    expect(raw, `${c.path} must exist in the VFS`).toBeTruthy();
    const fm = chunkFrontmatter(raw!);
    expect(fm).toContain(`chunk: ${c.ordinal}`);
    expect(fm).toContain(`total: ${total}`);
    expect(fm).toContain("headingPath");
    expect(chunkBody(raw!).length, `${c.path} must be within maxChunkSize`).toBeLessThanOrEqual(maxChunkSize);
  }

  // headingPath is positional context: the deepest heading open at that point
  const first = await readVfs(shell, `${bundleRoot}/${B.chunk}/${body.chunks[0].path}`);
  expect(chunkFrontmatter(first!)).toContain("Part I: Foundations");
  const last = await readVfs(shell, `${bundleRoot}/${B.chunk}/${body.chunks[total - 1].path}`);
  expect(chunkFrontmatter(last!)).toContain("Section 4: Spectral Methods");

  // .chunks/ is OPERATIONAL — derived staging, not provenance and not content
  const exported = await (await api.get(`bundles/${B.chunk}/export`)).json();
  expect(exported.files.filter((f: { path: string }) => f.path.startsWith(".chunks/")).length).toBe(0);
  expect(exported.files.some((f: { path: string }) => f.path === "raw/numerical-methods.md")).toBe(true);

  await shell.dispose();
});

test("U2 (FR-055): a source within maxChunkSize comes back as a single chunk — the unchanged path", async () => {
  const res = await api.post(`bundles/${B.chunk}/raw`, {
    data: { filename: "short-note.md", content: "# Short Note\n\nThis one fits comfortably inside the bound.\n" },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();

  expect(body.chunks).toHaveLength(1);
  expect(body.chunks[0].total).toBe(1);
  expect(body.chunks[0].ordinal).toBe(1);
  expect(body.chunks[0].path).toBe(".chunks/short-note/001.md");
  // and nothing else about the response changed
  expect(body.stored).toBe(true);
  expect(body.rawFile).toBe("raw/short-note.md");
  expect(body.docId).toBe("short-note");
});

test("U1b (FR-055): re-registering a changed source CLEARS the previous split (.chunks/ is a cache, raw/ is not)", async () => {
  const shell = await pinnedContext();
  const cfg = await serviceConfig();
  const bundleRoot = cfg.runtime?.bundleRoot || "/KnowledgeBase";

  const long = `# Rewritten\n\n${"A sentence that is repeated to make this long enough to split. ".repeat(900)}`;
  const first = await (await api.post(`bundles/${B.chunk}/raw`, { data: { filename: "rewritten.md", content: long } })).json();
  expect(first.chunks.length).toBeGreaterThan(1);
  const lastPath = first.chunks[first.chunks.length - 1].path;
  expect(await readVfs(shell, `${bundleRoot}/${B.chunk}/${lastPath}`)).toBeTruthy();

  // same docId, much shorter content: the old split's tail must NOT survive
  const second = await (
    await api.post(`bundles/${B.chunk}/raw`, { data: { filename: "rewritten.md", conceptId: "rewritten", content: "# Rewritten\n\nMuch shorter now.\n" } })
  ).json();
  expect(second.docId).toBe("rewritten");
  expect(second.chunks).toHaveLength(1);
  expect(
    await readVfs(shell, `${bundleRoot}/${B.chunk}/${lastPath}`),
    "a stale chunk from the previous, longer split must be gone",
  ).toBeNull();

  // raw/ is still APPEND-ONLY — the first version was not overwritten
  expect(second.rawFile).toBe("raw/rewritten.v2.md");
  expect(await readVfs(shell, `${bundleRoot}/${B.chunk}/raw/rewritten.md`)).toBe(long);

  await shell.dispose();
});

// ════════════════════════════════════════════════════════════════════════
//  JOB TRAJECTORY — FR-057 / FR-058 / SC-018 (ADR-013)
// ════════════════════════════════════════════════════════════════════════
//
// WHY THE FIXTURES ARE SEEDED, same as the job-control block above. Capturing
// a trajectory from a REAL run means a live provider call, and the shape under
// test is what the launcher STORED, not whether a model behaves. The capture
// itself — the delegate bridge reading an NDJSON stream and appending every
// line — is exercised offline against a mock delegate in
// tests/job-trajectory.test.mjs (`OKF_DELEGATE_URL` is the seam; it is read by
// the worker process, which a browser-side test cannot set).
//
// So these records are written straight into the persisted store and the
// service restarted — the same seam the reaper and job-control tests use —
// and they assert the two things that are this item's: that `GET /jobs/<id>`
// returns the captured array intact, and that the app renders it. They are
// seeded with the trajectory INLINE, the shape an earlier service wrote; the
// restarted service moves each one to `.jobs/trajectories/<id>.json` when it
// loads the store, so this also covers that migration against the real
// /api/fs (tests/job-store-memory.test.mjs AP4 covers it offline).

const TRAJECTORY_FIXTURE = [
  { type: "run_started", runId: "headless-okf-ingest-e2e", agent: "okf-ingest", at: "2026-10-12T09:00:00Z" },
  { type: "tool", tool: "web_fetch", input: { url: "https://example.test/e2e-doc", output_path: "/workspace/okf-staged-e2e.md" } },
  { type: "tool_result", result: { bytes: 4210, savedTo: "/workspace/okf-staged-e2e.md" } },
  // captured like everything else, but NOT rendered: v1 omits the narration
  // lines so the tool calls stay the debug surface (ADR-013)
  { type: "reasoning_delta", text: "weighing the chapter boundaries" },
  { type: "tool", tool: "okf_upsert_concept", input: { bundle: "e2e-okf-main", id: "e2e-doc/first-chapter", title: "First Chapter" } },
  { type: "tool_result", result: { id: "e2e-doc/first-chapter", created: true } },
  { type: "done", text: "Ingested: 2 chapters, 3 concepts, 0 assets, 0 refs skipped, 0 refs failed.", result: { endedReason: "completed" } },
];

let trajFixtures: { withTrajectory: string; noTrajectory: string } | null = null;

async function seedTrajectoryFixtures(): Promise<{ withTrajectory: string; noTrajectory: string }> {
  if (trajFixtures) return trajFixtures;

  const shell = await pinnedContext();
  const cfg = await (await api.get("config")).json();
  const bundleRoot = (cfg.runtime && cfg.runtime.bundleRoot) || "/KnowledgeBase";
  const jobsFile = `${bundleRoot}/.jobs/jobs.json`;

  const existing = await shell.get(`${BASE}/api/fs?op=read&path=${encodeURIComponent(jobsFile)}`);
  const store = existing.ok() ? JSON.parse((await existing.json()).content) : { jobs: [], seq: 1000 };

  const stamp = Date.now();
  const ids = { withTrajectory: `run-e2e-traj-${stamp}`, noTrajectory: `run-e2e-notraj-${stamp}` };
  const now = new Date().toISOString();
  const base = {
    bundleId: B.main,
    source: "https://example.test/e2e-doc",
    maxDepth: 1,
    maxWorkers: 3,
    queuedAt: now,
    startedAt: now,
    endedAt: now,
    durationMs: 4200,
    progress: null as string | null,
    summary: null as unknown,
    error: null as string | null,
    runId: "headless-okf-ingest-e2e",
    cancelRequested: false,
  };

  store.jobs.unshift(
    {
      ...base,
      id: ids.withTrajectory,
      status: "completed",
      summary: { chapters: 2, concepts: 3, assets: 0, refsSkipped: 0, refsFailed: 0, written: [], text: "2 chapters written.", toolCalls: 2 },
      trajectory: TRAJECTORY_FIXTURE,
    },
    {
      // the "crashed before producing events" case: zero events captured
      ...base,
      id: ids.noTrajectory,
      status: "failed",
      runId: null,
      error: "the sub-agent stream ended without a terminal line — the run was interrupted",
      trajectory: [],
    },
  );

  const wrote = await shell.post(`${BASE}/api/fs`, {
    data: { op: "write", path: jobsFile, content: JSON.stringify(store, null, 2) + "\n" },
  });
  expect(wrote.ok(), "could not seed the job store").toBeTruthy();

  const restarted = await shell.post(`${BASE}/api/services/${SERVICE_ID}`, {
    data: { action: "restart", reason: "e2e trajectory fixtures" },
  });
  expect(restarted.ok()).toBeTruthy();

  // the port is OS-assigned, so a restart can move it — re-resolve, never reuse
  await api.dispose();
  serviceBase = await resolveServiceBase(shell);
  api = await pinnedContext({ baseURL: serviceBase });
  await shell.dispose();

  trajFixtures = ids;
  return ids;
}

test("U4 (FR-057): GET /jobs/<id> returns the captured trajectory — every event, in order, verbatim", async () => {
  const ids = await seedTrajectoryFixtures();

  const res = await api.get(`jobs/${ids.withTrajectory}`);
  expect(res.ok()).toBeTruthy();
  const job = await res.json();

  expect(Array.isArray(job.trajectory), "the detail read must carry the trajectory").toBe(true);
  expect(job.trajectory).toEqual(TRAJECTORY_FIXTURE);
  expect(job.trajectory.map((e: { type: string }) => e.type)).toEqual([
    "run_started",
    "tool",
    "tool_result",
    "reasoning_delta",
    "tool",
    "tool_result",
    "done",
  ]);

  // the wire type for a tool call is `tool` — NOT `tool_call` (ADR-013), and
  // the pairing with its result is POSITIONAL: no callId correlates them
  expect(job.trajectory[1].type).toBe("tool");
  expect(job.trajectory[1].tool).toBe("web_fetch");
  expect(job.trajectory[1].input.url).toContain("example.test");
  expect(job.trajectory[1].callId).toBeUndefined();
  expect(job.trajectory[2].callId).toBeUndefined();
  // the terminal `done` carries its endedReason
  expect(job.trajectory[6].result.endedReason).toBe("completed");

  // a run that produced nothing has an EMPTY array, not a missing field — the
  // only case the app's "No trajectory captured" note describes
  const empty = await (await api.get(`jobs/${ids.noTrajectory}`)).json();
  expect(empty.trajectory).toEqual([]);

  // the LIST reports the count instead: it is polled every few seconds, and a
  // run's events are tens of kilobytes
  const { jobs } = await (await api.get("jobs")).json();
  const row = jobs.find((j: { id: string }) => j.id === ids.withTrajectory);
  expect(row.trajectory, "a list row must not carry the events").toBeUndefined();
  expect(row.trajectoryEvents).toBe(TRAJECTORY_FIXTURE.length);
});

test("U5 (FR-058/SC-018): the Jobs tab renders the trajectory as collapsible tool-call cards", async ({ page }) => {
  const ids = await seedTrajectoryFixtures();
  const app = await openApp(page);
  await app.getByTestId("tab-jobs").click();

  const row = app.getByTestId(`job-row-${ids.withTrajectory}`);
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect(app.getByTestId(`job-detail-${ids.withTrajectory}`)).toBeVisible();

  // the section, headed with the event count
  const header = app.getByTestId(`traj-header-${ids.withTrajectory}`);
  await expect(header).toBeVisible({ timeout: 15000 });
  await expect(header).toContainText("Run trajectory");
  await expect(header).toContainText(`${TRAJECTORY_FIXTURE.length} events`);

  const list = app.getByTestId(`traj-list-${ids.withTrajectory}`);
  await expect(list).toBeVisible();

  // run_started is a static header card; the two tool/tool_result pairs are
  // ONE card each (positional pairing), so the list holds 4 cards, not 6
  await expect(app.getByTestId(`traj-card-${ids.withTrajectory}-run_started`)).toBeVisible();
  await expect(list.locator('[data-testid^="traj-card-"]')).toHaveCount(4);
  await expect(app.getByTestId(`traj-tool-${ids.withTrajectory}-1`)).toHaveText("web_fetch");
  await expect(app.getByTestId(`traj-tool-${ids.withTrajectory}-2`)).toHaveText("okf_upsert_concept");

  // collapsed: no body. Expanding shows the full input AND the paired result.
  await expect(app.getByTestId(`traj-body-${ids.withTrajectory}-1`)).toHaveCount(0);
  await app.getByTestId(`traj-toggle-${ids.withTrajectory}-1`).click();
  await expect(app.getByTestId(`traj-body-${ids.withTrajectory}-1`)).toBeVisible();
  await expect(app.getByTestId(`traj-input-${ids.withTrajectory}-1`)).toContainText("https://example.test/e2e-doc");
  await expect(app.getByTestId(`traj-result-${ids.withTrajectory}-1`)).toContainText("savedTo");

  // the terminal card, with its endedReason
  await expect(app.getByTestId(`traj-card-${ids.withTrajectory}-done`)).toBeVisible();
  await expect(app.getByTestId(`traj-endedreason-${ids.withTrajectory}`)).toHaveText("completed");

  // reasoning_delta / final_text are CAPTURED (they are in the record, and in
  // the event count above) but omitted from the v1 rendering
  await expect(list).not.toContainText("weighing the chapter boundaries");
});

test("U5b (FR-058): a run that captured no events shows the 'No trajectory' note, not an empty list", async ({ page }) => {
  const ids = await seedTrajectoryFixtures();
  const app = await openApp(page);
  await app.getByTestId("tab-jobs").click();

  const row = app.getByTestId(`job-row-${ids.noTrajectory}`);
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();

  const note = app.getByTestId(`traj-empty-${ids.noTrajectory}`);
  await expect(note).toBeVisible({ timeout: 15000 });
  await expect(note).toContainText("No trajectory captured");
  await expect(app.getByTestId(`traj-list-${ids.noTrajectory}`)).toHaveCount(0);
});

test("U6 (SC-007): neither scope-add touched the tool surface — it is still exactly 21", async () => {
  const { count, tools } = await (await api.get("tools")).json();
  expect(count).toBe(21);
  expect(tools.length).toBe(21);
  expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(EXPECTED_TOOLS);

  // chunking lives INSIDE okf_add_raw_source and trajectory is a job-record
  // field — neither is a tool, and no okf_read_chunk / okf_get_trajectory was
  // ever added (both were explicitly rejected: ADR-012 option (c), ADR-013
  // option (c))
  const names = new Set(tools.map((t: { name: string }) => t.name));
  for (const rejected of ["okf_read_chunk", "okf_get_trajectory", "okf_chunk_source"]) {
    expect(names.has(rejected), `${rejected} must not exist`).toBe(false);
  }

  // the declaration tells the agent about the chunks it now gets back
  const addRaw = tools.find((t: { name: string }) => t.name === "okf_add_raw_source");
  expect(addRaw.description).toContain("chunks");
  expect(addRaw.parallelSafe, "okf_add_raw_source writes — it is not parallelSafe").toBe(false);
});

// ════════════════════════════════════════════════════════════════════════
//  INGEST EFFICIENCY — FR-059 / FR-060 / SC-019 (ADR-014)
// ════════════════════════════════════════════════════════════════════════
//
// Two contracts, one root cause (the model re-emitting source it could have
// left on disk):
//
//   FR-060 — the agent writes METADATA; the SERVICE slices the body out of
//            raw/. The invariant: the stored body, with the inserted
//            interpretations removed, is byte-for-byte a contiguous slice of
//            `raw/<source>.md` (SC-019).
//   FR-059 — the reaper is an INACTIVITY bound (plus a total-runtime
//            backstop), both configurable and both honestly reported.
//
// The okf_* tools have no HTTP face (they are IPC-dispatched through the
// worker's parentPort), so the write is driven through `POST
// /bundles/<b>/concept` — the REST face of the SAME core.upsertConcept the
// tool handler calls (ADR-003). What is asserted is the bytes the running
// service actually wrote into the bundle.

/** The source the slices are taken from — structure, nesting and an asset. */
const EFF_SOURCE =
  "Preamble before any heading.\n" +
  "\n" +
  "# Rollout Handbook\n" +
  "\n" +
  "Written for service owners.\n" +
  "\n" +
  "## Canary\n" +
  "\n" +
  "Ship to a 5% canary for at least 30 minutes.\n" +
  "\n" +
  "![Canary rollout console](https://cdn.example.test/media/canary-demo.mp4)\n" +
  "\n" +
  "Watch error rate and p99 against the baseline.\n" +
  "\n" +
  "### Thresholds\n" +
  "\n" +
  "Auto-rollback trips at 1% 5xx or a 2x p99 regression.\n" +
  "\n" +
  "## Promote\n" +
  "\n" +
  "Promote only after a clean bake window.\n" +
  "\n" +
  "## Rollback\n" +
  "\n" +
  "Drain the canary pods and re-point the router.\n";

// index: 0 "# Rollout Handbook"(1) 1 "## Canary"(2) 2 "### Thresholds"(3)
//        3 "## Promote"(2)         4 "## Rollback"(2)

const INTERP_PREFIX = "> **Interpretation (LLM, at ingest):**";
const INTERP_ASSET_MARK = "<!-- interpretation-asset -->";

/**
 * The INVERSE of what the service inserts: drop the interpretation
 * blockquote, the local asset link the service added beneath the source's
 * own line, and the unmatched-asset marker. What is left must be the
 * verbatim slice — that is the whole of SC-019.
 */
function stripInterpretations(body: string): string {
  return body
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith(INTERP_PREFIX) &&
        !/^<!--\s*interpretation:[\s\S]*-->\s*$/.test(line) &&
        !(line.includes(INTERP_ASSET_MARK) && /^!\[[^\]]*\]\(\s*raw\/assets\//.test(line)),
    )
    .join("\n");
}

type Heading = { index: number; level: number; text: string; start: number; end: number };
type HeadingMap = { sourceFile: string; sourceLength: number; headings: Heading[] };

let effFixture: { docId: string; rawFile: string; map: HeadingMap; bundleRoot: string } | null = null;

/** Register EFF_SOURCE once; every slice test reads back the same raw/ bytes. */
async function seedEfficiencySource(): Promise<NonNullable<typeof effFixture>> {
  if (effFixture) return effFixture;
  const shell = await pinnedContext();
  const cfg = await (await api.get("config")).json();
  const bundleRoot = (cfg.runtime && cfg.runtime.bundleRoot) || "/KnowledgeBase";

  expect((await api.post("bundles", { data: { name: B.efficiency, title: "Efficiency" } })).ok()).toBeTruthy();
  const reg = await (
    await api.post(`bundles/${B.efficiency}/raw`, {
      data: { filename: "rollout.md", conceptId: "rollout", content: EFF_SOURCE, maxChunkSize: 180 },
    })
  ).json();
  expect(reg.stored).toBe(true);
  expect(reg.chunks.length, "the fixture must actually be chunked").toBeGreaterThan(1);

  const mapRaw = await readVfs(shell, `${bundleRoot}/${B.efficiency}/.chunks/${reg.docId}/headings.json`);
  expect(mapRaw, "okf_add_raw_source must write the heading map beside the chunks").toBeTruthy();
  await shell.dispose();

  effFixture = { docId: reg.docId, rawFile: reg.rawFile, map: JSON.parse(mapRaw as string) as HeadingMap, bundleRoot };
  return effFixture;
}

test("AA1 (FR-060/SC-019): the heading map is written at chunk time, with global indices on every chunk", async () => {
  const { docId, map, bundleRoot } = await seedEfficiencySource();
  const shell = await pinnedContext();

  expect(map.sourceFile).toBe("raw/rollout.md");
  expect(map.sourceLength).toBe(EFF_SOURCE.length);
  expect(map.headings.map((h) => h.text)).toEqual(["Rollout Handbook", "Canary", "Thresholds", "Promote", "Rollback"]);
  expect(map.headings.map((h) => h.level)).toEqual([1, 2, 3, 2, 2]);
  // every offset really is that heading's own "#"
  for (const h of map.headings) {
    expect(EFF_SOURCE.slice(h.start, h.start + h.level + 1)).toBe(`${"#".repeat(h.level)} `);
  }
  // the raw/ bytes are untouched by any of it
  expect(await readVfs(shell, `${bundleRoot}/${B.efficiency}/${map.sourceFile}`)).toBe(EFF_SOURCE);

  // and every chunk can name the headings it is allowed to reference
  const chunk1 = await readVfs(shell, `${bundleRoot}/${B.efficiency}/.chunks/${docId}/001.md`);
  expect(chunkFrontmatter(chunk1 as string)).toMatch(/headings:/);
  await shell.dispose();
});

test("AA1 (FR-060/SC-019): nextSameOrHigher — the stored body minus interpretations is a BYTE-IDENTICAL slice of raw/", async () => {
  const { docId, map } = await seedEfficiencySource();

  // "## Canary" (1) — ends at "## Promote" (3); the nested "### Thresholds"
  // stays inside, and the asset's interpretation is inserted, not authored.
  const res = await api.post(`bundles/${B.efficiency}/concept`, {
    data: {
      id: `${docId}/canary`,
      sourceRange: { startHeading: 1 },
      interpretations: [
        {
          assetLine: "![Canary rollout console](https://cdn.example.test/media/canary-demo.mp4)",
          interpretation: "Deploy console mid-canary: 5% of traffic on the new build, error rate flat against the baseline.",
        },
      ],
      frontmatter: { type: "section", parent: docId, title: "Canary", concepts: ["canary release"], summary: "The 5% canary window." },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  const stored = await (await api.get(`bundles/${B.efficiency}/concept/${docId}/canary`)).json();
  const expected = EFF_SOURCE.slice(map.headings[1].start, map.headings[3].start);

  expect(stripInterpretations(stored.body)).toBe(expected);
  expect(stored.body).toContain("### Thresholds");
  expect(stored.body).not.toContain("## Promote");
  // the interpretation IS there — it is added, never substituted for the slice
  expect(stored.body).toContain(`${INTERP_PREFIX} Deploy console mid-canary`);
  expect(stored.body).toContain(`raw/assets/${docId}/canary-demo.mp4`);
  expect(stored.frontmatter.summary).toBe("The 5% canary window.");
});

test("AA1 (FR-060/SC-019): toHeading merges two sections into one chapter — still one contiguous slice", async () => {
  const { docId, map } = await seedEfficiencySource();

  const res = await api.post(`bundles/${B.efficiency}/concept`, {
    data: {
      id: `${docId}/promote-and-rollback`,
      sourceRange: { startHeading: 3, toHeading: 5 },
      frontmatter: { type: "section", parent: docId, title: "Promote and Rollback", concepts: ["rollback"], summary: "Promoting, and backing out." },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  const stored = await (await api.get(`bundles/${B.efficiency}/concept/${docId}/promote-and-rollback`)).json();
  expect(stored.body).toBe(EFF_SOURCE.slice(map.headings[3].start));
  expect(stored.body).toContain("## Promote");
  expect(stored.body).toContain("## Rollback");
});

test("AA1 (FR-060/SC-019): whole:true and startHeading:-1 — the no-heading source and the preamble", async () => {
  const { docId, map } = await seedEfficiencySource();

  // the preamble: everything before the first heading
  await api.post(`bundles/${B.efficiency}/concept`, {
    data: {
      id: `${docId}/preamble`,
      sourceRange: { startHeading: -1 },
      frontmatter: { type: "section", parent: docId, title: "Preamble", concepts: ["rollback"], summary: "The front matter." },
    },
  });
  const preamble = await (await api.get(`bundles/${B.efficiency}/concept/${docId}/preamble`)).json();
  expect(preamble.body).toBe(EFF_SOURCE.slice(0, map.headings[0].start));

  // a source with NO headings at all is one chapter, whole:true
  const plain = "A note with no headings at all.\n\nTwo paragraphs, one chapter.\n";
  const reg = await (
    await api.post(`bundles/${B.efficiency}/raw`, { data: { filename: "note.md", conceptId: "note", content: plain } })
  ).json();
  expect(reg.chunks).toHaveLength(1);

  await api.post(`bundles/${B.efficiency}/concept`, {
    data: {
      id: `${reg.docId}/all`,
      sourceRange: { whole: true },
      frontmatter: { type: "section", parent: reg.docId, title: "The Note", concepts: ["rollback"], summary: "The whole note." },
    },
  });
  const whole = await (await api.get(`bundles/${B.efficiency}/concept/${reg.docId}/all`)).json();
  expect(whole.body).toBe(plain);
});

test("AA1 (FR-060): an unresolvable sourceRange fails the write loudly — it never mis-slices", async () => {
  const { docId } = await seedEfficiencySource();

  const bad = await api.post(`bundles/${B.efficiency}/concept`, {
    data: { id: `${docId}/nope`, sourceRange: { startHeading: 99 }, frontmatter: { type: "section", parent: docId } },
  });
  expect(bad.ok()).toBeFalsy();
  expect(JSON.stringify(await bad.json())).toMatch(/out of range/);
  expect((await api.get(`bundles/${B.efficiency}/concept/${docId}/nope`)).ok(), "nothing was written").toBeFalsy();
});

test("AA2 (FR-060): a chapter written from a sourceRange carries NO source body in the call", async () => {
  const { docId, map } = await seedEfficiencySource();

  // The call the ingest agent makes: metadata only. No `body` key at all —
  // the source text is never an output token.
  const call = {
    id: `${docId}/thresholds`,
    sourceRange: { startHeading: 2 },
    frontmatter: { type: "section", parent: docId, title: "Thresholds", concepts: ["monitoring"], summary: "When auto-rollback trips." },
  };
  expect(Object.keys(call), "the per-chapter call carries no body").not.toContain("body");
  expect(JSON.stringify(call)).not.toContain("Auto-rollback trips at");

  const res = await api.post(`bundles/${B.efficiency}/concept`, { data: call });
  expect(res.ok()).toBeTruthy();
  const written = await res.json();

  // ...and the service reports exactly which bytes it took
  expect(written.extraction.sourceFile).toBe("raw/rollout.md");
  expect(written.extraction.start).toBe(map.headings[2].start);
  expect(written.extraction.end).toBe(map.headings[3].start);

  const stored = await (await api.get(`bundles/${B.efficiency}/concept/${docId}/thresholds`)).json();
  expect(stored.body).toBe(EFF_SOURCE.slice(map.headings[2].start, map.headings[3].start));
  expect(stored.body).toContain("Auto-rollback trips at");

  // the tool the agent calls advertises the protocol it must follow
  const { tools } = await (await api.get("tools")).json();
  const upsert = tools.find((t: { name: string }) => t.name === "okf_upsert_concept");
  expect(Object.keys(upsert.inputSchema.properties)).toEqual(expect.arrayContaining(["sourceRange", "interpretations"]));
  expect(upsert.inputSchema.properties.sourceRange.properties.startHeading).toBeTruthy();
  expect(upsert.inputSchema.properties.sourceRange.properties.toHeading).toBeTruthy();
  expect(upsert.inputSchema.properties.sourceRange.properties.whole).toBeTruthy();
  expect(upsert.inputSchema.properties.sourceId, "the service resolves the source itself — it is not an agent input").toBeUndefined();
  expect(upsert.description).toMatch(/do NOT re-type the chapter's body|One call per chapter/i);
});

test("AA2 (FR-060): a body passed WITHOUT a sourceRange is still written verbatim — the old path is untouched", async () => {
  const { docId } = await seedEfficiencySource();
  const authored = "# Synthesis\n\nA chapter the agent genuinely wrote itself.\n";
  await api.post(`bundles/${B.efficiency}/concept`, {
    data: {
      id: `${docId}/synthesis`,
      body: authored,
      frontmatter: { type: "section", parent: docId, title: "Synthesis", concepts: ["rollback"], summary: "Authored, not extracted." },
    },
  });
  const stored = await (await api.get(`bundles/${B.efficiency}/concept/${docId}/synthesis`)).json();
  expect(stored.body).toBe(authored);
});

test("AA4 (FR-059/US13 AS3): GET /config exposes BOTH reaper bounds", async () => {
  const cfg = await (await api.get("config")).json();
  for (const source of [cfg, cfg.runtime]) {
    expect(typeof source.jobFinalizeTimeoutMs, "the inactivity bound is reported").toBe("number");
    expect(typeof source.maxTotalTimeoutMs, "the total-runtime backstop is reported").toBe("number");
  }
  // the inactivity bound is the one the reaper actually uses, under either name
  expect(cfg.runtime.jobFinalizeTimeoutMs).toBe(cfg.runtime.staleJobMs);
  expect(cfg.runtime.maxTotalTimeoutMs).toBeGreaterThan(cfg.runtime.jobFinalizeTimeoutMs);
});

test("AA3 (FR-059/US13 AS2): the reaper fires on INACTIVITY and on the TOTAL backstop — and spares a live run", async () => {
  // Same seam as the FR-049 reaper test: write the records straight into the
  // persisted store and restart, because the startup sweep is the half of the
  // reaper this models (and waiting out a real 30-minute window is not a test).
  const shell = await pinnedContext();
  const cfg = await (await api.get("config")).json();
  const bundleRoot = (cfg.runtime && cfg.runtime.bundleRoot) || "/KnowledgeBase";
  const inactivityMs = cfg.runtime.jobFinalizeTimeoutMs as number;
  const jobsFile = `${bundleRoot}/.jobs/jobs.json`;

  const existing = await shell.get(`${BASE}/api/fs?op=read&path=${encodeURIComponent(jobsFile)}`);
  const store = existing.ok() ? JSON.parse((await existing.json()).content) : { jobs: [], seq: 1000 };

  const stamp = Date.now();
  const ago = (ms: number) => new Date(stamp - ms).toISOString();
  const base = {
    status: "running",
    bundleId: B.efficiency,
    source: "raw/rollout.md",
    maxDepth: 1,
    maxWorkers: 3,
    endedAt: null,
    durationMs: null,
    progress: "writing 4 of 11 chapters",
    summary: null,
    error: null,
    trajectory: [],
  };
  const ids = {
    silent: `run-e2e-silent-${stamp}`,
    live: `run-e2e-live-${stamp}`,
    endless: `run-e2e-endless-${stamp}`,
  };
  store.jobs.unshift(
    // went quiet an hour ago, but only started 70 minutes ago -> INACTIVITY
    { ...base, id: ids.silent, queuedAt: ago(70 * 60_000), startedAt: ago(70 * 60_000), lastEventAt: ago(inactivityMs + 10 * 60_000) },
    // running far longer than the inactivity bound but still talking -> LIVE
    { ...base, id: ids.live, queuedAt: ago(5 * 60 * 60_000), startedAt: ago(5 * 60 * 60_000), lastEventAt: ago(30_000) },
    // talking, but 8 hours in -> the TOTAL backstop
    { ...base, id: ids.endless, queuedAt: ago(8 * 60 * 60_000), startedAt: ago(8 * 60 * 60_000), lastEventAt: ago(60_000) },
  );
  expect((await shell.post(`${BASE}/api/fs`, { data: { op: "write", path: jobsFile, content: JSON.stringify(store, null, 2) + "\n" } })).ok()).toBeTruthy();

  expect((await shell.post(`${BASE}/api/services/${SERVICE_ID}`, { data: { action: "restart", reason: "e2e inactivity reaper" } })).ok()).toBeTruthy();
  await api.dispose();
  serviceBase = await resolveServiceBase(shell);
  api = await pinnedContext({ baseURL: serviceBase });

  const statusOf = async (id: string) => {
    const res = await api.get(`jobs/${id}`);
    return res.ok() ? ((await res.json()).status as string) : "unreachable";
  };

  await expect
    .poll(() => statusOf(ids.silent), { message: "the silent run was never reaped", timeout: 60_000, intervals: [1000] })
    .toBe("failed");

  const silent = await (await api.get(`jobs/${ids.silent}`)).json();
  expect(String(silent.error)).toMatch(/no progress \(no trajectory event\)/);
  expect(String(silent.error)).toMatch(/alive but silent/);
  // the restart is listed as ONE possible cause, not asserted as the cause
  expect(String(silent.error)).toMatch(/a long model generation, a provider stall, or a BOS restart/);
  expect(String(silent.error)).not.toMatch(/most likely BOS restarted/);

  await expect
    .poll(() => statusOf(ids.endless), { message: "the endless run was never reaped", timeout: 60_000, intervals: [1000] })
    .toBe("failed");
  const endless = await (await api.get(`jobs/${ids.endless}`)).json();
  expect(String(endless.error)).toMatch(/exceeded the maximum total runtime/);
  expect(String(endless.error)).toMatch(/active but not progressing/);

  // and the run that kept talking is left alone, 5 hours in
  expect(await statusOf(ids.live), "a run still producing events is not stale").toBe("running");

  await shell.dispose();
});

test("AA5 (SC-007): the efficiency scope-add adds NO tools — the surface is still exactly 21", async () => {
  const { count, tools } = await (await api.get("tools")).json();
  expect(count).toBe(21);
  expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(EXPECTED_TOOLS);

  // the body extraction lives INSIDE okf_upsert_concept as optional fields —
  // no okf_write_chapter, no batched variant (ADR-014 D4/D5 rejected both)
  const names = new Set(tools.map((t: { name: string }) => t.name));
  for (const rejected of ["okf_write_chapter", "okf_write_chapters", "okf_extract_body", "okf_heading_map"]) {
    expect(names.has(rejected), `${rejected} must not exist`).toBe(false);
  }
});

test("AA6: every prior scope-add still stands — chunking, trajectory, cancel/delete, person-kind", async () => {
  const { docId } = await seedEfficiencySource();

  // chunking (ADR-012): the source was split, and the heading map rides with it
  const reg = await (
    await api.post(`bundles/${B.efficiency}/raw`, {
      data: { filename: "still-chunks.md", conceptId: "still-chunks", content: EFF_SOURCE, maxChunkSize: 200 },
    })
  ).json();
  expect(reg.chunks.length).toBeGreaterThan(1);

  // person-kind (ADR-011): person_terms still rides through a write untouched
  await api.post(`bundles/${B.efficiency}/concept`, {
    data: {
      id: `${docId}/owners`,
      sourceRange: { startHeading: 0, toHeading: 1 },
      frontmatter: { type: "section", parent: docId, title: "Owners", concepts: ["rollback"], person_terms: ["Diego Córdoba"], summary: "Who owns the rollout." },
    },
  });
  const owners = await (await api.get(`bundles/${B.efficiency}/concept/${docId}/owners`)).json();
  expect(owners.frontmatter.person_terms).toEqual(["Diego Córdoba"]);
  const persons = await vocabulary(B.efficiency);
  expect(persons.filter((t) => t.kind === "person").map((t) => t.name)).toContain("Diego Córdoba");

  // trajectory + job control (ADR-013/ADR-010): the routes still answer
  expect((await api.get("jobs")).ok()).toBeTruthy();
  expect((await api.post("jobs/run-does-not-exist/cancel")).status()).toBe(404);
  expect((await api.delete("jobs/run-does-not-exist")).status()).toBe(404);

  // and the derived layer still rebuilds from the extracted chapters
  const lint = await (await api.get(`bundles/${B.efficiency}/lint`)).json();
  expect(lint.checks.headingMapDrift, "no document's heading map disagrees with its raw/ bytes").toBe(0);
  expect(lint.chapters).toBeGreaterThan(3);
});

// ════════════════════════════════════════════════════════════════════════
//  US14 / FR-068–FR-073 / SC-020–SC-024 — retrieval at scale (2026-10-14)
// ════════════════════════════════════════════════════════════════════════

/** A test-owned bundle of `n` documents, each with one chapter; document i is
 *  added i hours after the first, and document 3's chapter body (only) names a
 *  person no term or summary mentions. Written through the service's import. */
async function seedScale(n: number): Promise<void> {
  await del(B.scale);
  const files: { path: string; content: string }[] = [{ path: "index.md", content: "# scale fixture\n" }];
  const sources: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const docId = `doc-${String(i).padStart(3, "0")}`;
    const url = `https://example.com/scale/${docId}`;
    files.push(document(docId, `Document ${i}`, `Notes number ${i}.`, url));
    files.push(
      chapter(docId, "body", `Body ${i}`, `Chapter of document ${i}.`, ["scale-topic"], {}, i === 3 ? "## Origin\n\nThe method was first sketched by Ingrid Haavardsholm in a memo.\n" : "## Text\n\nOrdinary text.\n"),
    );
    sources[url] = { sourceKey: url, rawFile: `raw/${docId}.md`, docId, originUrl: url, ingestedAt: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString() };
  }
  files.push({ path: "raw/sources.json", content: JSON.stringify({ sources }, null, 2) + "\n" });
  expect((await api.post(`bundles/${B.scale}/import`, { data: { files } })).ok()).toBeTruthy();
}

test("SC-020: a name that is only in a chapter body is found, as full text, with the sentence it is in", async () => {
  await seedScale(8);
  const res = await (await api.get(`bundles/${B.scale}/search?query=${encodeURIComponent("Haavardsholm")}`)).json();
  expect(res.rows[0]).toMatchObject({ docId: "doc-003", chId: "body", matchKind: "text" });
  expect(res.rows[0].excerpt).toContain("Ingrid Haavardsholm");
  expect(res.searched).toEqual(["terms", "titles", "summaries", "full text"]);
  // accents and case fold both ways
  const folded = await (await api.get(`bundles/${B.scale}/search?query=haavardsholm`)).json();
  expect(folded.rows[0].docId).toBe("doc-003");
});

test("SC-021: the bundle TOC pages every document, newest first, with no vocabulary in it", async () => {
  await seedScale(120);
  const first = await (await api.get(`bundles/${B.scale}/toc`)).json();
  expect(first.total).toBe(120);
  expect(first.limit).toBe(50);
  expect(first.documents[0].id).toBe("doc-119");
  expect(first.documents[0]).toMatchObject({ title: "Document 119", chapters: 1, summary: "Notes number 119." });
  expect(first).not.toHaveProperty("terms");
  const all = await documentsOf(B.scale);
  expect(all.map((d) => d.id)).toEqual(Array.from({ length: 120 }, (_, i) => `doc-${String(119 - i).padStart(3, "0")}`));
  const vocab = await (await api.get(`bundles/${B.scale}/concepts?query=scale`)).json();
  expect(vocab.terms[0]).toMatchObject({ term: "scale-topic", coversTotal: 120 });
  expect(vocab.terms[0].covers.length).toBe(5);
});

test("SC-022: a chapter changed outside the service is seen by the next search", async () => {
  await seedScale(8);
  const shell = await pinnedContext();
  const cfg = await (await api.get("config")).json();
  const bundleRoot = (cfg.runtime && cfg.runtime.bundleRoot) || "/KnowledgeBase";
  const path = `${bundleRoot}/${B.scale}/concepts/doc-005/body.md`;
  const current = (await (await shell.get(`${BASE}/api/fs?op=read&path=${encodeURIComponent(path)}`)).json()).content as string;
  const wrote = await shell.post(`${BASE}/api/fs`, { data: { op: "write", path, content: current.replace("Ordinary text.", "Ordinary text, now about quokkas.") } });
  expect(wrote.ok()).toBeTruthy();
  await shell.dispose();

  const res = await (await api.get(`bundles/${B.scale}/search?query=quokkas`)).json();
  expect(res.rows.map((r: { docId: string }) => r.docId)).toEqual(["doc-005"]);
});

test("SC-023: a search writes nothing", async () => {
  await seedScale(8);
  const exportBefore = await (await api.get(`bundles/${B.scale}/export`)).json();
  for (const q of ["Haavardsholm", "scale topic", "nothing matches this"]) await api.get(`bundles/${B.scale}/search?query=${encodeURIComponent(q)}`);
  const exportAfter = await (await api.get(`bundles/${B.scale}/export`)).json();
  expect(exportAfter.files.map((f: { path: string }) => f.path).sort()).toEqual(exportBefore.files.map((f: { path: string }) => f.path).sort());
});

test("SC-024: a document and a concept term with the same name are two graph nodes, each with its own edges", async () => {
  const g = await (await api.get(`bundles/${B.main}/graph`)).json();
  const ids = g.nodes.map((n: { id: string }) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain("doc:deployment");
  expect(ids).toContain("concept:deployment");
  expect(g.edges.some((e: { kind: string; to: string }) => e.kind === "coverage" && e.to === "concept:deployment")).toBe(true);
  expect(g.edges.some((e: { kind: string; to: string }) => e.kind === "coverage" && e.to === "doc:deployment")).toBe(false);
});

