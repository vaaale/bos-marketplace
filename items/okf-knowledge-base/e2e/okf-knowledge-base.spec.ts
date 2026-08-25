import { test, expect, request, type APIRequestContext } from '@playwright/test';

/**
 * e2e tests for the OKF Knowledge Base marketplace item (spec 040).
 *
 * These tests exercise the SERVICE's own HTTP bridge directly (the same
 * bridge the config-app iframe talks to via `fetch(httpPath + ...)` — see
 * design.md "Browser -> worker bridge"), rather than going through the
 * Supervisor's `/__supervisor/services/<id>/` proxy path, which only
 * resolves inside a live BOS session and 502s otherwise. Talking to the
 * worker's bound port directly gives a stable target for CI/e2e.
 *
 * BASE_URL must point at the okf-knowledge-base service's own bound HTTP
 * port (services.md §11 / design.md ADR-004): under plain `npm run dev`
 * (no Supervisor) that port is read from the service's `runtime.json` via
 * `GET /api/services/<id>/config`; set OKF_KB_URL to that `http://127.0.0.1:<port>`
 * before running this suite. The value below is a placeholder only —
 * `port: 0` (OS-assigned, per plan.md) means there is no fixed default.
 *
 * Route contract (services/lib/http-bridge.js, verified against the running
 * service after the 2026-08-15 convergence pass — GAP 1/2/3 below closed the
 * graph-view, raw-source-add, and loopback-auth gaps that an earlier draft
 * of this file had documented as missing):
 *   GET  /bundles                       -> [ bundleStatus, ... ]
 *   POST /bundles                       -> { name, title?, description? } -> bundleStatus
 *   GET  /bundles/<name>                -> bundleStatus + { concepts: [{ id, title, status, verified, staleAfter, updatedAt }, ...] }
 *   GET  /bundles/<name>/health         -> bundleStatus (does NOT 404 for an unknown name — see SC-003 below)
 *   GET  /bundles/<name>/export         -> { name, files: [{ path, content }] } (404s if the bundle dir doesn't exist)
 *   GET  /bundles/<name>/concepts/<id>  -> single concept read { id, frontmatter, body, links } (GAP 1)
 *   GET  /bundles/<name>/links?concept=<id>     -> { id, links: [...] } outbound (GAP 1)
 *   GET  /bundles/<name>/backlinks?concept=<id> -> { id, backlinks: [...] } inbound (GAP 1)
 *   GET  /bundles/<name>/neighbors?concept=<id> -> { id, neighbors: [{id, distance}, ...] } (GAP 1)
 *   POST /bundles/<name>/raw            -> { path, content } -> { path, added } append-only; 409 on overwrite (GAP 2)
 *   POST /bundles/<name>/import         -> { files: [{ path, content }] } -> bundleStatus
 *   POST /bundles/<name>/concepts       -> { id, title?, body?, frontmatter? } -> { id, frontmatter, body, links } (the
 *                                           full post-write concept, including graph edges extracted from `body`)
 *
 * Loopback-scoped auth (FR-006 / 039 FR-009, GAP 3): the bridge binds
 * 127.0.0.1 only and additionally rejects (403) any request whose
 * `X-Forwarded-For`/`X-Real-IP` header names a non-loopback address — the
 * one signal a same-host proxy hop could carry a spoofed/forwarded
 * non-loopback origin through, since a genuine off-host peer can never
 * reach a 127.0.0.1-bound socket directly.
 */
const BASE_URL = process.env.OKF_KB_URL || 'http://127.0.0.1:4173';

function uniqueBundleName(prefix: string): string {
  // Date.now()/Math.random() are avoided per harness convention; the worker
  // index/test id gives enough uniqueness across a single test run.
  return `${prefix}-${test.info().workerIndex}-${test.info().repeatEachIndex}-${test.info().retry}`;
}

test.describe('OKF Knowledge Base — service HTTP bridge', () => {
  let api: APIRequestContext;

  test.beforeAll(async () => {
    api = await request.newContext({ baseURL: BASE_URL });
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  // SC-001 / US1 AS1: create a bundle with no external tool-server config —
  // the bridge is the service's own native HTTP surface.
  test('SC-001/US1: POST /bundles creates a spec-conformant bundle skeleton', async () => {
    const bundle = uniqueBundleName('engineering-docs');

    const res = await api.post('/bundles', { data: { name: bundle } });
    expect(res.ok()).toBeTruthy();

    const health = await api.get(`/bundles/${bundle}/health`);
    expect(health.ok()).toBeTruthy();
    const body = await health.json();
    expect(body).toMatchObject({ conceptCount: 0 });
  });

  // SC-002 / SC-003 (US1 AS2, US2 AS1): tools return results for valid
  // invocations against a healthy service. There is no GET .../concepts
  // route — the concept list comes back embedded in GET /bundles/<name>,
  // as an array of summary objects (id/title/status/...), not bare ids.
  test('SC-002: POST /bundles/<name>/concepts adds a concept and it is listed', async () => {
    const bundle = uniqueBundleName('kb-concepts');
    await api.post('/bundles', { data: { name: bundle } });

    const upsert = await api.post(`/bundles/${bundle}/concepts`, {
      data: {
        id: 'concepts/ai/attention',
        frontmatter: { type: 'concept', status: 'stable' },
        body: 'Attention is a mechanism... [Read more](transformers.md).',
      },
    });
    expect(upsert.ok()).toBeTruthy();

    const get = await api.get(`/bundles/${bundle}`);
    expect(get.ok()).toBeTruthy();
    const { concepts } = await get.json();
    expect(concepts.map((c: { id: string }) => c.id)).toContain('concepts/ai/attention');
  });

  // US1 AS3: a Markdown link between two concepts is extracted as a graph
  // edge. The bridge has no /links or neighbors/backlinks route — the only
  // real surface for this is the `links` field the bridge already returns
  // on POST .../concepts (upsert response = the full post-write concept),
  // plus GET .../export to prove the link text is durably persisted to
  // disk, not just echoed back transiently.
  test('US1: a Markdown link between concepts is extracted and durably stored', async () => {
    const bundle = uniqueBundleName('kb-graph');
    await api.post('/bundles', { data: { name: bundle } });

    const upsert = await api.post(`/bundles/${bundle}/concepts`, {
      data: {
        id: 'concepts/ai/attention',
        frontmatter: { type: 'concept' },
        body: 'See also [Transformers](concepts/ai/transformers.md).',
      },
    });
    expect(upsert.ok()).toBeTruthy();
    const upsertBody = await upsert.json();
    expect(upsertBody.links).toContain('concepts/ai/transformers');

    await api.post(`/bundles/${bundle}/concepts`, {
      data: {
        id: 'concepts/ai/transformers',
        frontmatter: { type: 'concept' },
        body: 'Transformers build on attention.',
      },
    });

    // Round-trip through storage: export the bundle and confirm the
    // attention concept's file on disk still carries the link.
    const exportRes = await api.get(`/bundles/${bundle}/export`);
    expect(exportRes.ok()).toBeTruthy();
    const { files } = await exportRes.json();
    const attentionFile = files.find((f: { path: string }) => f.path.endsWith('ai/attention.md'));
    expect(attentionFile).toBeTruthy();
    expect(attentionFile.content).toContain('[Transformers](concepts/ai/transformers.md)');
  });

  // SC-004 (FR-009/NFR-003): unknown frontmatter keys are preserved verbatim
  // across a write/read round-trip — the OKF spec's hard invariant. There is
  // no GET .../concepts/<id> route; POST .../concepts already returns the
  // full post-write concept (id/frontmatter/body/links), which is the real
  // and only way to read a concept back, so the update response itself is
  // the round-trip check.
  test('SC-004: unknown frontmatter keys survive an upsert round-trip', async () => {
    const bundle = uniqueBundleName('kb-frontmatter');
    await api.post('/bundles', { data: { name: bundle } });

    const conceptId = 'concepts/custom/widget';
    const initial = await api.post(`/bundles/${bundle}/concepts`, {
      data: {
        id: conceptId,
        frontmatter: {
          type: 'concept',
          status: 'stable',
          // unknown, service-agnostic keys that must be preserved verbatim
          x_custom_field: 'keep-me',
          x_owner_team: 'platform-eng',
        },
        body: 'Initial body.',
      },
    });
    expect(initial.ok()).toBeTruthy();

    // Merge-on-fields: update only `status`, leaving unknown keys untouched.
    const update = await api.post(`/bundles/${bundle}/concepts`, {
      data: {
        id: conceptId,
        frontmatter: { status: 'deprecated' },
      },
    });
    expect(update.ok()).toBeTruthy();
    const { frontmatter } = await update.json();
    expect(frontmatter.status).toBe('deprecated');
    expect(frontmatter.x_custom_field).toBe('keep-me');
    expect(frontmatter.x_owner_team).toBe('platform-eng');

    // Cross-check against durable storage too, not just the response.
    const exportRes = await api.get(`/bundles/${bundle}/export`);
    const { files } = await exportRes.json();
    const widgetFile = files.find((f: { path: string }) => f.path.endsWith('custom/widget.md'));
    expect(widgetFile.content).toContain('x_custom_field: keep-me');
    expect(widgetFile.content).toContain('x_owner_team: platform-eng');
    expect(widgetFile.content).toContain('status: deprecated');
  });

  // SC-005 (US3 AS1/AS2): import/export round-trips a spec-conformant OKF
  // bundle — concepts and frontmatter intact. There is no POST .../export
  // route (export is a GET) and no "import from path" shape — import takes
  // the same `{ files }` shape export returns, so the real round-trip is
  // export -> import the same files into a fresh bundle -> export again.
  test('SC-005: export then re-import a bundle preserves concepts and frontmatter', async () => {
    const bundle = uniqueBundleName('kb-portability');
    await api.post('/bundles', { data: { name: bundle } });
    await api.post(`/bundles/${bundle}/concepts`, {
      data: {
        id: 'concepts/portable/example',
        frontmatter: { type: 'concept', trust: 'human-reviewed', sources: ['raw/source-a.md'] },
        body: 'Portable content.',
      },
    });

    const exportRes = await api.get(`/bundles/${bundle}/export`);
    expect(exportRes.ok()).toBeTruthy();
    const { files } = await exportRes.json();
    expect(files.length).toBeGreaterThan(0);

    const reimportedBundle = uniqueBundleName('kb-portability-reimport');
    await api.post('/bundles', { data: { name: reimportedBundle } });
    const importRes = await api.post(`/bundles/${reimportedBundle}/import`, {
      data: { files },
    });
    expect(importRes.ok()).toBeTruthy();
    const importedStatus = await importRes.json();
    expect(importedStatus.conceptCount).toBe(1);

    const reexportRes = await api.get(`/bundles/${reimportedBundle}/export`);
    const { files: reexportedFiles } = await reexportRes.json();
    const exampleFile = reexportedFiles.find((f: { path: string }) =>
      f.path.endsWith('portable/example.md'),
    );
    expect(exampleFile).toBeTruthy();
    expect(exampleFile.content).toContain('type: concept');
    expect(exampleFile.content).toContain('trust: human-reviewed');
    expect(exampleFile.content).toContain('source-a.md');
    expect(exampleFile.content).toContain('Portable content.');
  });

  // SC-008 (US2 AS4): LLM-style retrieval over OKF structure — concepts and
  // their links form a traversable structure. This test asserts the
  // *structure* the retrieval flow depends on is present and consistent,
  // not that an LLM was invoked (the service hosts no model — NFR-010).
  // There is no /index or /links route, so structure is verified via
  // GET /bundles/<name> (concept listing) and the `links` field returned
  // by POST .../concepts (graph edges extracted from the body).
  test('SC-008: concepts and their extracted links form a traversable structure', async () => {
    const bundle = uniqueBundleName('kb-retrieval');
    await api.post('/bundles', { data: { name: bundle } });

    const rootUpsert = await api.post(`/bundles/${bundle}/concepts`, {
      data: {
        id: 'concepts/topic/root',
        frontmatter: { type: 'concept', trust: 'human-reviewed' },
        body: 'Root topic. See [Detail](concepts/topic/detail.md).',
      },
    });
    expect(rootUpsert.ok()).toBeTruthy();
    const rootBody = await rootUpsert.json();
    expect(rootBody.links).toContain('concepts/topic/detail');

    await api.post(`/bundles/${bundle}/concepts`, {
      data: {
        id: 'concepts/topic/detail',
        frontmatter: { type: 'concept', trust: 'unverified' },
        body: 'Supporting detail for the root topic.',
      },
    });

    const get = await api.get(`/bundles/${bundle}`);
    const { concepts } = await get.json();
    expect(concepts.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining(['concepts/topic/root', 'concepts/topic/detail']),
    );
  });

  // SC-003 / NFR-005 (039 FR-007): a tool error inside the service is
  // reported gracefully — not a crash — for both a missing bundle and a
  // malformed request. Note: GET .../health does NOT 404 for an unknown
  // bundle name (bundleStatus tolerates a missing directory and reports
  // conceptCount: 0), so the "missing bundle" case is exercised against a
  // route that actually checks existence — GET .../export and the concept
  // upsert route both do.
  test('SC-003: errors from missing/invalid bundles are reported gracefully, not as a crash', async () => {
    const missingBundle = 'does-not-exist-bundle';

    const exportMissing = await api.get(`/bundles/${missingBundle}/export`);
    expect(exportMissing.status()).toBeGreaterThanOrEqual(400);
    expect(exportMissing.status()).toBeLessThan(500);

    const upsertMissingBundle = await api.post(`/bundles/${missingBundle}/concepts`, {
      data: { id: 'concepts/x', frontmatter: { type: 'concept' } },
    });
    expect(upsertMissingBundle.status()).toBeGreaterThanOrEqual(400);
    expect(upsertMissingBundle.status()).toBeLessThan(500);

    // Malformed payload (missing required `id`) must be rejected as a
    // structured error, never a 5xx crash of the bridge.
    const bundle = uniqueBundleName('kb-error-handling');
    await api.post('/bundles', { data: { name: bundle } });
    const malformed = await api.post(`/bundles/${bundle}/concepts`, {
      data: { frontmatter: { type: 'concept' } }, // missing required `id`
    });
    expect(malformed.status()).toBeGreaterThanOrEqual(400);
    expect(malformed.status()).toBeLessThan(500);

    // The service itself must still be reachable after the errors above —
    // proof that a tool-execution error did not crash the worker/BOS.
    const stillHealthy = await api.post('/bundles', {
      data: { name: uniqueBundleName('kb-still-alive') },
    });
    expect(stillHealthy.ok()).toBeTruthy();
  });

  // Edge case (spec.md): a write targeting a path outside the configured
  // bundle root must be rejected (path-traversal guard, FR-016/NFR-004).
  test('NFR-004: path traversal outside the bundle root is rejected', async () => {
    const bundle = uniqueBundleName('kb-path-guard');
    await api.post('/bundles', { data: { name: bundle } });

    const traversal = await api.post(`/bundles/${bundle}/concepts`, {
      data: {
        id: '../../etc/passwd',
        frontmatter: { type: 'concept' },
        body: 'should never be written',
      },
    });
    expect(traversal.ok()).toBeFalsy();
    expect(traversal.status()).toBeGreaterThanOrEqual(400);
    expect(traversal.status()).toBeLessThan(500);
  });

  // GAP 1 (design.md §5 "Graph view"): the config-app's graph view has no
  // backing HTTP route without these — verify each is wired to the same
  // okf-core graph functions the okf_list_links/okf_backlinks/okf_neighbors
  // tools use.
  test('GAP1: links/backlinks/neighbors/concepts routes back the graph view', async () => {
    const bundle = uniqueBundleName('kb-graph-routes');
    await api.post('/bundles', { data: { name: bundle } });

    await api.post(`/bundles/${bundle}/concepts`, {
      data: {
        id: 'concepts/graph/root',
        frontmatter: { type: 'concept' },
        body: 'Root. See [Detail](concepts/graph/detail.md).',
      },
    });
    await api.post(`/bundles/${bundle}/concepts`, {
      data: { id: 'concepts/graph/detail', frontmatter: { type: 'concept' }, body: 'Detail page.' },
    });

    const links = await api.get(`/bundles/${bundle}/links?concept=${encodeURIComponent('concepts/graph/root')}`);
    expect(links.ok()).toBeTruthy();
    expect((await links.json()).links).toContain('concepts/graph/detail');

    const backlinks = await api.get(`/bundles/${bundle}/backlinks?concept=${encodeURIComponent('concepts/graph/detail')}`);
    expect(backlinks.ok()).toBeTruthy();
    expect((await backlinks.json()).backlinks).toContain('concepts/graph/root');

    const neighbors = await api.get(`/bundles/${bundle}/neighbors?concept=${encodeURIComponent('concepts/graph/root')}`);
    expect(neighbors.ok()).toBeTruthy();
    const neighborIds = (await neighbors.json()).neighbors.map((n: { id: string }) => n.id);
    expect(neighborIds).toContain('concepts/graph/detail');

    const single = await api.get(`/bundles/${bundle}/concepts/concepts/graph/root`);
    expect(single.ok()).toBeTruthy();
    const singleBody = await single.json();
    expect(singleBody.id).toBe('concepts/graph/root');
    expect(singleBody.links).toContain('concepts/graph/detail');
  });

  // GAP 2 (design.md Risk #7): okf_ingest reads from raw/ but nothing wrote
  // INTO raw/ — verify the append-only add path exists and enforces
  // immutability (rejects overwrite) and the path-traversal guard.
  test('GAP2: POST /bundles/<name>/raw adds an immutable source, rejects overwrite and traversal', async () => {
    const bundle = uniqueBundleName('kb-raw-add');
    await api.post('/bundles', { data: { name: bundle } });

    const added = await api.post(`/bundles/${bundle}/raw`, {
      data: { path: 'source-a.md', content: '# Source A\n\nSome raw content.' },
    });
    expect(added.ok()).toBeTruthy();
    expect((await added.json()).path).toBe('raw/source-a.md');

    const exportRes = await api.get(`/bundles/${bundle}/export`);
    const { files } = await exportRes.json();
    const rawFile = files.find((f: { path: string }) => f.path === 'raw/source-a.md');
    expect(rawFile).toBeTruthy();
    expect(rawFile.content).toContain('Some raw content.');

    // append-only: re-adding the same path must be rejected, never overwritten
    const overwrite = await api.post(`/bundles/${bundle}/raw`, {
      data: { path: 'source-a.md', content: 'clobbered' },
    });
    expect(overwrite.ok()).toBeFalsy();
    expect(overwrite.status()).toBeGreaterThanOrEqual(400);
    expect(overwrite.status()).toBeLessThan(500);

    const traversal = await api.post(`/bundles/${bundle}/raw`, {
      data: { path: '../../etc/passwd', content: 'should never be written' },
    });
    expect(traversal.ok()).toBeFalsy();
    expect(traversal.status()).toBeGreaterThanOrEqual(400);
    expect(traversal.status()).toBeLessThan(500);
  });

  // GAP 3 (FR-006 / 039 FR-009): tool invocations — and, for this HTTP
  // bridge, the config-app's own requests — MUST use the loopback-scoped
  // trust boundary. A genuine off-host peer can never reach a
  // 127.0.0.1-bound socket directly, so the one signal a same-host proxy
  // hop could carry a spoofed/forwarded non-loopback origin through is a
  // forwarding header; assert the bridge rejects that and accepts a normal
  // (or explicitly loopback-forwarded) request.
  test('GAP3: a non-loopback-presenting request is rejected while a loopback request succeeds', async () => {
    const nonLoopback = await api.get('/bundles', {
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(nonLoopback.ok()).toBeFalsy();
    expect(nonLoopback.status()).toBe(403);

    const nonLoopbackRealIp = await api.get('/bundles', {
      headers: { 'X-Real-IP': '198.51.100.23' },
    });
    expect(nonLoopbackRealIp.ok()).toBeFalsy();
    expect(nonLoopbackRealIp.status()).toBe(403);

    const plainLoopback = await api.get('/bundles');
    expect(plainLoopback.ok()).toBeTruthy();

    const explicitLoopback = await api.get('/bundles', {
      headers: { 'X-Forwarded-For': '127.0.0.1' },
    });
    expect(explicitLoopback.ok()).toBeTruthy();
  });
});
