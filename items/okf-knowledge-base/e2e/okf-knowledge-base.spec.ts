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

/** The 19 declared tools (spec FR-037 / SC-007 + okf_list_jobs). */
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
  "okf_add_link",
  "okf_backlinks",
  "okf_lint",
  "okf_stale_report",
].sort();

/** The 16 removed BY NAME (FR-037). None may still be declared.
 *
 *  The net change is 31 -> 19, i.e. 12 fewer, because four were added
 *  (okf_search, okf_read_toc, okf_merge_concepts, okf_list_jobs) alongside
 *  these sixteen removals. Asserting all sixteen names are gone is the
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

// ── service reachability (never a hardcoded port) ────────────────────────

let api: APIRequestContext;
let serviceBase: string;

async function resolveServiceBase(shell: APIRequestContext): Promise<string> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const res = await shell.get(`${BASE}/api/services/${SERVICE_ID}/config`);
    if (res.ok()) {
      const cfg = await res.json();
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
};

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
  const shell = await request.newContext();
  serviceBase = await resolveServiceBase(shell);
  await shell.dispose();
  api = await request.newContext({ baseURL: serviceBase });
  for (const b of Object.values(B)) await del(b);
  await seedMain();
  await seedRules();
});

test.afterAll(async () => {
  for (const b of Object.values(B)) await del(b);
  await api.dispose();
});

// ════════════════════════════════════════════════════════════════════════
//  SC-007 / FR-037 / FR-038 — the tool surface is exactly 19
// ════════════════════════════════════════════════════════════════════════

test("SC-007: the service declares exactly the 19 okf_* tools and none of the 16 removed", async () => {
  const res = await api.get("tools");
  expect(res.ok()).toBeTruthy();
  const { count, tools } = await res.json();

  // The badge in the app and this assertion both read the service's OWN
  // declaration list — neither hardcodes the number anywhere but here.
  expect(count).toBe(19);
  expect(tools.length).toBe(19);
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
  const terms = detail.conceptIndex.map((t: { name: string }) => t.name).sort();
  expect(terms).toEqual(["api-design", "deployment", "monitoring", "naming", "rollback", "versioning"]);
  // 6 terms covering 4 chapters across 2 documents, and one term covers two
  // chapters — the table is keyed by term, not by chapter
  const apiDesign = detail.conceptIndex.find((t: { name: string }) => t.name === "api-design");
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

  const before = await (await api.get(`bundles/${B.merge}`)).json();
  expect(before.conceptIndex.map((t: { name: string }) => t.name).sort()).toEqual(["rate-limit", "rate-limiting"]);

  // the real merge — the same core.mergeConcepts() okf_merge_concepts runs
  const merged = await (await api.post(`bundles/${B.merge}/merge`, { data: { from: "rate-limit", to: "rate-limiting" } })).json();
  expect(merged.chaptersRewritten).toEqual(["limits/quotas"]);
  expect(merged.fromTermRemaining).toBe(false);
  expect(merged.tocsRebuilt).toContain("limits");

  // the concept index consolidates to ONE canonical entry covering the union
  const after = await (await api.get(`bundles/${B.merge}`)).json();
  expect(after.conceptIndex.map((t: { name: string }) => t.name)).toEqual(["rate-limiting"]);
  expect(after.conceptIndex[0].count).toBe(2);

  // every affected chapter's frontmatter was rewritten
  const quotas = await (await api.get(`bundles/${B.merge}/concept/limits/quotas`)).json();
  expect(quotas.frontmatter.concepts).toEqual(["rate-limiting"]);

  // and the stored document TOC followed
  const toc = await (await api.get(`bundles/${B.merge}/toc/limits`)).json();
  expect(toc.chapters.every((c: { concepts: string[] }) => c.concepts.includes("rate-limiting"))).toBe(true);
  expect(toc.chapters.some((c: { concepts: string[] }) => c.concepts.includes("rate-limit"))).toBe(false);

  // US6 AS2: a query that previously matched EITHER term now routes through
  // the single canonical term to the union of the chapters
  const q = await (await api.get(`bundles/${B.merge}/search?query=rate-limiting`)).json();
  expect(q.rows.map((r: { chId: string }) => r.chId).sort()).toEqual(["bursts", "quotas"]);
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
  await app.getByTestId("merge-target-rate-limit").selectOption("rate-limiting");
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
  const contains = g.edges.find((e: { kind: string; to: string }) => e.kind === "containment" && e.to === "deployment/canary");
  expect(contains.from).toBe("deployment");
  expect(contains.label).toBe("contains");

  // coverage runs chapter -> concept term, from the index
  const covers = g.edges.find((e: { kind: string; from: string; to: string }) => e.kind === "coverage" && e.from === "deployment/canary" && e.to === "rollback");
  expect(covers.label).toBe("covers");

  // every edge is directed and labelled, and never dangles
  const ids = new Set(g.nodes.map((n: { id: string }) => n.id));
  for (const e of g.edges) {
    expect(e.from && e.to && e.label).toBeTruthy();
    expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  }

  // concept-term nodes carry their coverage count (it drives the node radius)
  const term = g.nodes.find((n: any) => n.type === "concept" && n.id === "api-design");
  expect(term.count).toBe(2);
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
});

test("FR-044/SC-011: the LAUNCHER writes the terminal state — completed with a summary, or failed with an error", async () => {
  // NOTE: this performs a REAL headless agent run against whatever provider
  // the preview is configured with. The source is deliberately tiny. The
  // assertion is about the CONTRACT, not about the agent's judgement: either
  // terminal state is a pass, because what is under test is that the service
  // — which launched the run and watched its stream — records an honest
  // outcome instead of leaving the job hanging.
  await api.post(`bundles/${B.main}/import`, {
    data: { files: [{ path: "raw/e2e-lifecycle.md", content: "# Lifecycle Probe\n\n## One\n\nFirst section.\n\n## Two\n\nSecond section.\n" }] },
  });
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
});

test("FR-049: a run orphaned by a restart is reaper-marked failed(stale), not left spinning", async () => {
  // The reaper's job is the one case driveRun cannot cover: the process dying
  // mid-run. Rather than wait out the 30-minute window, seed a job record
  // that is already days old directly into the persisted store, then restart
  // the service — the STARTUP SWEEP is the half of the reaper that exists
  // precisely for this event, and it runs before the service serves a
  // request.
  const shell = await request.newContext();
  const cfg = await (await shell.get(`${BASE}/api/services/${SERVICE_ID}/config`)).json();
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
  api = await request.newContext({ baseURL: serviceBase });

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
  expect(count).toBe(19);
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
  await expect(app.getByTestId("ingest-started")).toBeVisible({ timeout: 20000 });
  await expect(app.getByTestId("ingest-started")).toContainText(/Run run-\d+ started/);

  // the run is real: it exists on the service, and the Jobs tab shows it
  const after = (await (await api.get("jobs")).json()).jobs as { id: string; source: string }[];
  const created = after.find((j) => !before.has(j.id));
  expect(created, "the modal must create a job, not just describe one").toBeTruthy();
  expect(created!.source).toBe("raw/e2e-from-app.md");

  await app.getByTestId("modal-ingest").getByRole("button", { name: "Close" }).click();
  await app.getByTestId("tab-jobs").click();
  await expect(app.getByTestId(`job-${created!.id}`)).toBeVisible({ timeout: 15000 });
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

test("FR-043/US9 AS2: the shared search reflects in BOTH views — Table filters, Graph highlights and dims", async ({ page }) => {
  const app = await openApp(page);
  await app.getByTestId("tab-query").click();
  await app.getByTestId("query-bundle-select").selectOption(B.main);
  await expect(app.getByTestId("graph-svg")).toBeVisible({ timeout: 15000 });

  const totalNodes = await app.locator(".g-node").count();
  await app.getByTestId("query-search").fill("rollback");

  // the search really ran okf_search — the matched concept is named
  await expect(app.getByTestId("matched-concepts")).toContainText("rollback", { timeout: 10000 });

  // GRAPH: matching nodes highlighted, the rest dimmed
  await expect(app.locator(".g-node.match").first()).toBeVisible();
  const matched = await app.locator(".g-node.match").count();
  const dimmed = await app.locator(".g-node.dimmed").count();
  expect(matched).toBeGreaterThan(0);
  expect(dimmed).toBeGreaterThan(0);
  expect(matched + dimmed).toBe(totalNodes);

  // TABLE: the same query filters the rows
  await app.getByTestId("view-table").click();
  await expect(app.getByTestId("table-view")).toBeVisible();
  await expect(app.getByTestId("table-count")).toContainText("rollback");
  const tableRows = await app.locator('[data-testid^="table-row-"]').count();
  expect(tableRows).toBe(matched);
  await expect(app.getByTestId("table-row-chap-deployment/canary")).toBeVisible();

  // clearing restores both views
  await app.getByTestId("query-clear").click();
  await expect(app.getByTestId("table-count")).not.toContainText("rollback");
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
  await app.getByTestId("query-search").fill("naming");
  await expect(app.getByTestId("matched-concepts")).toBeVisible({ timeout: 10000 });
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
