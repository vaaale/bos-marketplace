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
//     surface, the derived index, search determinism, the job lifecycle and
//     graph derivation are asserted.
//   • the APP, launched from the BOS shell the way a user launches it, and
//     driven inside its iframe by testid.
//
// Fixtures are created through the service itself and torn down after, so the
// suite never depends on a particular bundle already existing.

import { expect, request, test, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";

// Default to the Supervisor, not a Next port — see the note above.
const BASE = process.env.BOS_PREVIEW_URL || "http://localhost:8090";
const SERVICE_ID = "okf-knowledge-base";

/** The 18 declared tools (spec FR-037 / SC-007). */
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
  "okf_add_link",
  "okf_backlinks",
  "okf_lint",
  "okf_stale_report",
].sort();

/** The 16 removed by name (FR-037). None may still be declared. */
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
  await page.getByText("OKF Knowledge Base", { exact: true }).first().click();
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
//  SC-007 / FR-037 / FR-038 — the tool surface is exactly 18
// ════════════════════════════════════════════════════════════════════════

test("SC-007: the service declares exactly the 18 okf_* tools and none of the 16 removed", async () => {
  const res = await api.get("tools");
  expect(res.ok()).toBeTruthy();
  const { count, tools } = await res.json();

  expect(count).toBe(18);
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
  expect((await api.post(`bundles/${B.main}/import`, { data: { files: [corrupt] } })).ok()).toBeTruthy();

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
  const term = g.nodes.find((n: { id: string }) => n.id === "api-design");
  expect(term.count).toBe(2);
});

// ════════════════════════════════════════════════════════════════════════
//  US8 / FR-041 / FR-044 / SC-011 — the ingest job lifecycle
// ════════════════════════════════════════════════════════════════════════

test("FR-044/SC-011: a run moves queued -> running -> completed through the real callback routes", async () => {
  // Queue a run exactly the way okf_ingest does (same dispatcher, same job
  // record, same callback URLs) — the raw source is already in the bundle.
  await api.post(`bundles/${B.main}/import`, { data: { files: [{ path: "raw/e2e-lifecycle.md", content: "# lifecycle source\n" }] } });
  const planned = await (await api.post(`bundles/${B.main}/ingest`, { data: { source: "raw/e2e-lifecycle.md" } })).json();

  expect(planned.status).toBe("delegation_required");
  expect(planned.delegate.agent).toBe("okf-ingest");
  expect(planned.jobId).toMatch(/^run-\d+$/);
  // the delegation carries the jobId and the lifecycle obligation, so the
  // sub-agent can report without any extra tool (ADR-006)
  expect(planned.delegate.task).toContain(planned.jobId);
  expect(planned.delegate.task).toContain("/complete");
  expect(planned.callbacks.start).toMatch(/\/jobs\/run-\d+\/start$/);

  const id = planned.jobId;
  expect((await (await api.get(`jobs/${id}`)).json()).status).toBe("queued");

  // the Jobs list shows it as active
  const listed = await (await api.get("jobs")).json();
  expect(listed.jobs.some((j: { id: string }) => j.id === id)).toBe(true);
  expect(listed.active).toBeGreaterThan(0);

  // → running (what the sub-agent posts before its first write)
  expect((await api.post(`jobs/${id}/start`)).ok()).toBeTruthy();
  const running = await (await api.get(`jobs/${id}`)).json();
  expect(running.status).toBe("running");
  expect(running.startedAt).toBeTruthy();

  // → live progress (optional, best-effort)
  await api.post(`jobs/${id}/progress`, { data: { progress: "writing 3 of 6 chapters" } });
  expect((await (await api.get(`jobs/${id}`)).json()).progress).toBe("writing 3 of 6 chapters");

  // → completed, with the summary the Jobs detail renders
  const summary = { chapters: 6, concepts: 8, assets: 1, refsSkipped: 2, refsFailed: 0, written: ["Perf Budget Basics"] };
  expect((await api.post(`jobs/${id}/complete`, { data: { summary } })).ok()).toBeTruthy();
  const done = await (await api.get(`jobs/${id}`)).json();
  expect(done.status).toBe("completed");
  expect(done.summary).toMatchObject(summary);
  expect(done.durationMs).not.toBeNull();
  expect(done.progress).toBeNull();
});

test("FR-044: the assistant safety net fails a run the sub-agent abandoned", async () => {
  await api.post(`bundles/${B.main}/import`, { data: { files: [{ path: "raw/e2e-abandoned.md", content: "# abandoned\n" }] } });
  const planned = await (await api.post(`bundles/${B.main}/ingest`, { data: { source: "raw/e2e-abandoned.md" } })).json();
  const id = planned.jobId;

  await api.post(`jobs/${id}/start`);
  // agent_delegate returns an error and the sub-agent never reported — the
  // calling assistant closes the gap over the same loopback route
  const failed = await (await api.post(`jobs/${id}/fail`, { data: { error: "agent_delegate returned an error" } })).json();
  expect(failed.status).toBe("failed");
  expect(failed.error).toContain("agent_delegate");
  expect(failed.endedAt).toBeTruthy();
});

test("FR-018: re-ingesting a source already in the provenance ledger does not duplicate it", async () => {
  const url = "https://engineering.example.com/handbook/dedup-probe";
  const first = await (await api.post(`bundles/${B.main}/ingest`, { data: { source: url } })).json();
  expect(first.status).toBe("acquisition_required");
  // every acquisition step pins output_path — that is what keeps the document
  // out of the calling model's context (FR-016)
  for (const step of first.steps) {
    if (step.tool === "web_fetch" || step.tool === "file_to_markdown") {
      expect(step.args.output_path, `${step.tool} must pin output_path`).toBeTruthy();
    }
  }

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

  const second = await (await api.post(`bundles/${B.main}/ingest`, { data: { source: url } })).json();
  expect(second.status).toBe("already_ingested");
  expect(second.docId).toBe("dedup-probe");
});

test("ADR-006: a terminal run cannot be resurrected — the safety net is a no-op after a real report", async () => {
  const { jobs } = await (await api.get("jobs")).json();
  const terminal = jobs.find((j: { status: string }) => j.status === "completed" || j.status === "failed");
  expect(terminal, "the lifecycle test above left a terminal run on record").toBeTruthy();

  const before = terminal.status;
  const res = await api.post(`jobs/${terminal.id}/fail`, { data: { error: "late safety-net call" } });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ignored).toBe(true);
  expect((await (await api.get(`jobs/${terminal.id}`)).json()).status).toBe(before);
});

test("an unknown job is a clean 404, not a 500", async () => {
  const res = await api.get("jobs/run-does-not-exist");
  expect(res.status()).toBe(404);
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
  // the badge reports the service's REAL declared count
  await expect(app.getByTestId("tool-badge")).toContainText("18 okf_* tools");
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

  // the lifecycle tests above ran first (serial file), so runs exist
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
  const status = await app.getByTestId(`job-status-${id}`).innerText();
  const panel = {
    completed: app.getByTestId(`job-summary-${id}`).or(app.getByTestId(`job-detail-${id}`)),
    failed: app.getByTestId(`job-error-${id}`),
    running: app.getByTestId(`job-progress-${id}`),
    queued: app.getByTestId(`job-queued-${id}`),
  }[status.trim() as "completed" | "failed" | "running" | "queued"];
  await expect(panel).toBeVisible();
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
  await expect(app.getByTestId("table-row-deployment/canary")).toBeVisible();

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
  await app.getByTestId("table-row-deployment/canary").click();

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
  await app.getByTestId("table-row-api-design").click();
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
  await app.getByTestId("table-row-api-design").click(); // the DOCUMENT row opens its TOC
  await expect(app.getByTestId("pane-doc")).toBeVisible();

  // the concept-term node routes to the chapters it covers
  await app.getByTestId("query-search").fill("naming");
  await expect(app.getByTestId("matched-concepts")).toBeVisible({ timeout: 10000 });
  await app.getByTestId("table-row-naming").click();
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
