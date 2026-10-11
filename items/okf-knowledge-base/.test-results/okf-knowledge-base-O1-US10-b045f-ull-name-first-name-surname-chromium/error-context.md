# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: okf-knowledge-base.spec.ts >> O1/US10/SC-016: a person is found by the EXISTING okf_search — full name, first name, surname
- Location: e2e/okf-knowledge-base.spec.ts:1314:5

# Error details

```
Error: "Diego Córdoba" returned no kind:'person' row

expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0
```

# Test source

```ts
  1225 | 
  1226 | test("the app renders live service data, not a built-in fixture", async ({ page }) => {
  1227 |   // The mockup ships sample bundles; the app must not. Everything on screen
  1228 |   // comes from the running service — so a bundle this suite created is
  1229 |   // present, and the mockup's fixtures are not.
  1230 |   const app = await openApp(page);
  1231 |   await expect(app.getByTestId(`bundle-row-${B.main}`)).toBeVisible({ timeout: 15000 });
  1232 |   await expect(app.getByTestId("service-error")).toHaveCount(0);
  1233 |   await expect(app.getByTestId("bundle-row-engineering")).toHaveCount(0);
  1234 |   await expect(app.getByTestId("bundle-row-employee-handbook")).toHaveCount(0);
  1235 | });
  1236 | 
  1237 | // ════════════════════════════════════════════════════════════════════════
  1238 | //  FR-053 / FR-054 / US10 / SC-016 — PERSON-KIND TERMS (ADR-011)
  1239 | // ════════════════════════════════════════════════════════════════════════
  1240 | //
  1241 | // A salient person (the author, a named key figure) is NOT a new entity: it
  1242 | // is an ordinary term in the SAME derived concept index, carrying
  1243 | // `kind: "person"`, derived from a `person_terms` frontmatter array that sits
  1244 | // parallel to `concepts`. So these tests assert exactly three things:
  1245 | //
  1246 | //   1. writing `person_terms` is all it takes — the rebuild derives the kind
  1247 | //      (O2), and the write path preserves the array verbatim (NFR-005);
  1248 | //   2. every surface copies that kind through — search rows, the vocabulary,
  1249 | //      the graph's 4th node type, the app (O1/O3);
  1250 | //   3. nothing that worked before changed — a bundle with no `person_terms`
  1251 | //      is all-`topic` with a 3-type graph, and the tool surface is untouched
  1252 | //      (O4/O5).
  1253 | //
  1254 | // The tool handlers themselves have no HTTP face (the 039 surface is reached
  1255 | // through the assistant, not over REST), so — as elsewhere in this file —
  1256 | // each tool-level claim is asserted as its DECLARATION plus the shared core
  1257 | // behind it, driven through the REST route that calls the very same
  1258 | // `core.*` function the tool does.
  1259 | 
  1260 | /** A document stub carrying `person_terms` — the AUTHOR, at document level. */
  1261 | function personDocument(
  1262 |   docId: string,
  1263 |   title: string,
  1264 |   summary: string,
  1265 |   uri: string,
  1266 |   persons: string[],
  1267 | ): { path: string; content: string } {
  1268 |   const fm = [
  1269 |     `id: ${docId}`,
  1270 |     "type: document",
  1271 |     `title: ${title}`,
  1272 |     `summary: ${JSON.stringify(summary)}`,
  1273 |     "person_terms:",
  1274 |     ...persons.map((p) => `  - ${p}`),
  1275 |     "sources:",
  1276 |     `  - id: ${docId}.md`,
  1277 |     `    uri: ${uri}`,
  1278 |     "created_at: 2026-08-01T00:00:00.000Z",
  1279 |     "updated_at: 2026-08-01T00:00:00.000Z",
  1280 |   ].join("\n");
  1281 |   return { path: `concepts/${docId}.md`, content: `---\n${fm}\n---\n\n# ${title}\n` };
  1282 | }
  1283 | 
  1284 | /** The author "Diego Córdoba" on the document stub, the key figure
  1285 |  *  "María Quispe" on one chapter — the shape §7.4 of the skill prescribes. */
  1286 | async function seedPerson(): Promise<void> {
  1287 |   await del(B.person);
  1288 |   const files = [
  1289 |     { path: "index.md", content: "# E2E Person\n" },
  1290 |     personDocument(
  1291 |       "water-rights",
  1292 |       "Water Rights in the Andes",
  1293 |       "Andean water governance and its contested history.",
  1294 |       "https://example.org/water-rights",
  1295 |       ["Diego Córdoba"],
  1296 |     ),
  1297 |     chapter(
  1298 |       "water-rights",
  1299 |       "history",
  1300 |       "A Contested History",
  1301 |       "Colonial allocation, modern conflict, and who the water was taken from.",
  1302 |       ["water-rights", "andean-history"],
  1303 |       // a chapter-level key figure, written EXACTLY as the source spells it
  1304 |       { person_terms: "[María Quispe]" },
  1305 |     ),
  1306 |     chapter("water-rights", "law", "The Legal Frame", "The statutes that govern allocation today.", [
  1307 |       "water-rights",
  1308 |       "law",
  1309 |     ]),
  1310 |   ];
  1311 |   expect((await api.post(`bundles/${B.person}/import`, { data: { files } })).ok()).toBeTruthy();
  1312 | }
  1313 | 
  1314 | test("O1/US10/SC-016: a person is found by the EXISTING okf_search — full name, first name, surname", async () => {
  1315 |   await seedPerson();
  1316 | 
  1317 |   // the SAME /search route the okf_search tool's core.search() backs. No
  1318 |   // person branch anywhere in it: a name is an ordinary term-name hit.
  1319 |   for (const query of ["Diego Córdoba", "Diego", "Córdoba", "quispe"]) {
  1320 |     const res = await api.get(`bundles/${B.person}/search?query=${encodeURIComponent(query)}`);
  1321 |     expect(res.ok()).toBeTruthy();
  1322 |     const { rows } = await res.json();
  1323 |     expect(rows.length, `"${query}" returned no rows`).toBeGreaterThan(0);
  1324 |     const personRows = rows.filter((r: { kind: string }) => r.kind === "person");
> 1325 |     expect(personRows.length, `"${query}" returned no kind:'person' row`).toBeGreaterThan(0);
       |                                                                           ^ Error: "Diego Córdoba" returned no kind:'person' row
  1326 |     // every row names the covering document, and a chapter when it has one
  1327 |     for (const r of personRows) expect(r.docId).toBe("water-rights");
  1328 |   }
  1329 | 
  1330 |   // the author covers the DOCUMENT (an empty chId) and the chapter that also
  1331 |   // names them; the key figure covers only her chapter
  1332 |   const diego = await (await api.get(`bundles/${B.person}/search?query=${encodeURIComponent("Córdoba")}`)).json();
  1333 |   expect(diego.rows.some((r: { chId: string }) => r.chId === "")).toBe(true);
  1334 |   const quispe = await (await api.get(`bundles/${B.person}/search?query=Quispe`)).json();
  1335 |   expect(quispe.rows.map((r: { chId: string }) => r.chId)).toEqual(["history"]);
  1336 | 
  1337 |   // a topic hit still reports kind:'topic' — the field is additive, not a mode
  1338 |   const topic = await (await api.get(`bundles/${B.person}/search?query=statutes`)).json();
  1339 |   expect(topic.rows.length).toBeGreaterThan(0);
  1340 |   expect(topic.rows.every((r: { kind: string }) => r.kind === "topic")).toBe(true);
  1341 | });
  1342 | 
  1343 | test("O1/FR-054: the vocabulary reports a kind per term, and okf_list_concepts declares the kind filter", async () => {
  1344 |   const detail = await (await api.get(`bundles/${B.person}`)).json();
  1345 |   const terms: { name: string; kind: string; count: number; covers: { chId: string }[] }[] = detail.conceptIndex;
  1346 | 
  1347 |   // every term carries a kind — never undefined, on any bundle
  1348 |   expect(terms.every((t) => t.kind === "topic" || t.kind === "person")).toBe(true);
  1349 | 
  1350 |   const persons = terms.filter((t) => t.kind === "person").map((t) => t.name).sort();
  1351 |   expect(persons).toEqual(["Diego Córdoba", "María Quispe"]);
  1352 |   // S1: the DISPLAY name keeps the case the source wrote, while the match is
  1353 |   // case-insensitive (asserted by the search test above)
  1354 |   expect(persons).not.toContain("diego córdoba");
  1355 |   expect(terms.find((t) => t.name === "water-rights")!.kind).toBe("topic");
  1356 |   // the author's coverage is the DOCUMENT he wrote — one row, empty chId
  1357 |   expect(terms.find((t) => t.name === "Diego Córdoba")!.count).toBe(1);
  1358 |   expect(terms.find((t) => t.name === "Diego Córdoba")!.covers[0].chId).toBe("");
  1359 |   expect(terms.find((t) => t.name === "María Quispe")!.count).toBe(1);
  1360 | 
  1361 |   // the tool-level filter: no HTTP face to invoke, so assert the DECLARATION
  1362 |   // (the handler forwards it straight to the same core.listConcepts() this
  1363 |   // route reads) — `kind` is optional, so `bundle` stays the only requirement
  1364 |   const { tools } = await (await api.get("tools")).json();
  1365 |   const list = tools.find((t: { name: string }) => t.name === "okf_list_concepts");
  1366 |   expect(list.inputSchema.properties.kind.enum.sort()).toEqual(["all", "person", "topic"]);
  1367 |   expect(list.inputSchema.required).toEqual(["bundle"]);
  1368 | 
  1369 |   // what that filter filters is this, client-side-equivalent:
  1370 |   expect(terms.filter((t) => t.kind === "person")).toHaveLength(2);
  1371 |   expect(terms.filter((t) => t.kind === "topic").length).toBe(terms.length - 2);
  1372 | });
  1373 | 
  1374 | test("O2/FR-053: writing person_terms is the whole mechanism — the rebuild derives kind:'person'", async () => {
  1375 |   // NFR-005 — the array the ingest agent writes with okf_upsert_concept
  1376 |   // round-trips VERBATIM through the shallow frontmatter merge: no writer
  1377 |   // change was needed for this scope-add, and that is what makes the
  1378 |   // derivation trustworthy.
  1379 |   const stub = await (await api.get(`bundles/${B.person}/concept/water-rights`)).json();
  1380 |   expect(stub.frontmatter.person_terms).toEqual(["Diego Córdoba"]);
  1381 |   const ch = await (await api.get(`bundles/${B.person}/concept/water-rights/history`)).json();
  1382 |   expect(ch.frontmatter.person_terms).toEqual(["María Quispe"]);
  1383 |   // and the name is NOT smuggled into `concepts` — parallel arrays
  1384 |   expect(ch.frontmatter.concepts).toEqual(["water-rights", "andean-history"]);
  1385 |   expect(ch.frontmatter.concepts).not.toContain("maría quispe");
  1386 | 
  1387 |   // write ANOTHER chapter naming a new key figure; the index re-derives
  1388 |   const files = [
  1389 |     chapter(
  1390 |       "water-rights",
  1391 |       "today",
  1392 |       "The Dispute Today",
  1393 |       "The 2026 arbitration and the communities it affects.",
  1394 |       ["water-rights"],
  1395 |       { person_terms: "[María Quispe, Ana Flores]" },
  1396 |     ),
  1397 |   ];
  1398 |   expect((await api.post(`bundles/${B.person}/import`, { data: { files } })).ok()).toBeTruthy();
  1399 | 
  1400 |   const after = await (await api.get(`bundles/${B.person}`)).json();
  1401 |   const byName = Object.fromEntries(after.conceptIndex.map((t: { name: string }) => [t.name, t]));
  1402 |   expect(byName["Ana Flores"].kind).toBe("person");
  1403 |   // the SAME person named by two chapters consolidates into ONE term
  1404 |   expect(byName["María Quispe"].kind).toBe("person");
  1405 |   expect(byName["María Quispe"].count).toBe(2);
  1406 |   expect(
  1407 |     byName["María Quispe"].covers.map((c: { chId: string }) => c.chId).sort(),
  1408 |   ).toEqual(["history", "today"]);
  1409 | });
  1410 | 
  1411 | test("O3/FR-054: the derived graph gains a 4th node type — person", async () => {
  1412 |   const g = await (await api.get(`bundles/${B.person}/graph`)).json();
  1413 | 
  1414 |   const types = new Set(g.nodes.map((n: { type: string }) => n.type));
  1415 |   expect(types).toEqual(new Set(["doc", "chap", "concept", "person"]));
  1416 | 
  1417 |   // the node: lowercased id, ORIGINAL-CASE label, count-driven radius input
  1418 |   const diego = g.nodes.find((n: { type: string; label: string }) => n.type === "person" && n.label === "Diego Córdoba");
  1419 |   expect(diego).toBeTruthy();
  1420 |   expect(diego.id).toBe("diego córdoba");
  1421 |   expect(diego.key).toBe("person:diego córdoba");
  1422 |   expect(diego.count).toBe(1);
  1423 | 
  1424 |   // coverage edges to a person are the SAME edge kind as topic coverage —
  1425 |   // the author's runs from the DOCUMENT, a key figure's from her chapter
```