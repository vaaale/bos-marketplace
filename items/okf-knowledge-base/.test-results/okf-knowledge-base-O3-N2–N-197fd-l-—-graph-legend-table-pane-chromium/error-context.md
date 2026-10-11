# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: okf-knowledge-base.spec.ts >> O3/N2–N5: the app paints the 4th category teal — graph, legend, table, pane
- Location: e2e/okf-knowledge-base.spec.ts:1507:5

# Error details

```
Test timeout of 300000ms exceeded.
```

```
Error: locator.selectOption: Test timeout of 300000ms exceeded.
Call log:
  - waiting for locator('iframe[src*="okf-knowledge-base"]').contentFrame().getByTestId('query-bundle-select')

```

# Test source

```ts
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
  1426 |   const authored = g.edges.find((e: { to: string; from: string }) => e.to === "diego córdoba" && e.from === "water-rights");
  1427 |   expect(authored.kind).toBe("coverage");
  1428 |   expect(authored.label).toBe("covers");
  1429 |   const subject = g.edges.find((e: { to: string; from: string }) => e.to === "maría quispe" && e.from === "water-rights/history");
  1430 |   expect(subject.kind).toBe("coverage");
  1431 | 
  1432 |   // no edge dangles, exactly as for the three original types
  1433 |   const ids = new Set(g.nodes.map((n: { id: string }) => n.id));
  1434 |   for (const e of g.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  1435 | });
  1436 | 
  1437 | test("O4: the backward-compat guard — a bundle with NO person_terms is unchanged in every surface", async () => {
  1438 |   await del(B.noPerson);
  1439 |   const files = [
  1440 |     { path: "index.md", content: "# E2E No Person\n" },
  1441 |     document("api-design", "API Design Rules", "How we shape HTTP APIs.", "https://example.com/api-design"),
  1442 |     chapter("api-design", "endpoint-naming", "Endpoint Naming", "Plural nouns, no verbs, versioned paths.", [
  1443 |       "api-design",
  1444 |       "naming",
  1445 |     ]),
  1446 |   ];
  1447 |   expect((await api.post(`bundles/${B.noPerson}/import`, { data: { files } })).ok()).toBeTruthy();
  1448 | 
  1449 |   // the vocabulary is all-topic: no 'person', and no undefined
  1450 |   const detail = await (await api.get(`bundles/${B.noPerson}`)).json();
  1451 |   expect(detail.conceptIndex.length).toBeGreaterThan(0);
  1452 |   expect(detail.conceptIndex.every((t: { kind: string }) => t.kind === "topic")).toBe(true);
  1453 |   expect(detail.conceptIndex.some((t: { kind: unknown }) => t.kind === undefined)).toBe(false);
  1454 | 
  1455 |   // the graph is the ORIGINAL three node types — the 4th appears only when
  1456 |   // the bundle actually has a person
  1457 |   const g = await (await api.get(`bundles/${B.noPerson}/graph`)).json();
  1458 |   expect(new Set(g.nodes.map((n: { type: string }) => n.type))).toEqual(new Set(["doc", "chap", "concept"]));
  1459 |   expect(g.nodes.some((n: { type: string }) => n.type === "person")).toBe(false);
  1460 |   expect(g.nodes.every((n: { type: string }) => n.type !== undefined)).toBe(true);
  1461 | 
  1462 |   // search still works, and reports kind:'topic' rather than nothing
  1463 |   const { rows } = await (await api.get(`bundles/${B.noPerson}/search?query=naming`)).json();
  1464 |   expect(rows.length).toBeGreaterThan(0);
  1465 |   expect(rows.every((r: { kind: string }) => r.kind === "topic")).toBe(true);
  1466 | 
  1467 |   // export -> import round-trips, and the re-imported bundle is still
  1468 |   // all-topic (the kind is re-derived from content, never carried as state)
  1469 |   const exported = await (await api.get(`bundles/${B.noPerson}/export`)).json();
  1470 |   await del(B.copy);
  1471 |   expect(
  1472 |     (await api.post(`bundles/${B.copy}/import`, { data: { files: exported.files } })).ok(),
  1473 |   ).toBeTruthy();
  1474 |   const copy = await (await api.get(`bundles/${B.copy}`)).json();
  1475 |   expect(copy.conceptIndex.map((t: { name: string }) => t.name).sort()).toEqual(
  1476 |     detail.conceptIndex.map((t: { name: string }) => t.name).sort(),
  1477 |   );
  1478 |   expect(copy.conceptIndex.every((t: { kind: string }) => t.kind === "topic")).toBe(true);
  1479 | 
  1480 |   // and the PERSON bundle survives the same round-trip with its kinds intact
  1481 |   const pExport = await (await api.get(`bundles/${B.person}/export`)).json();
  1482 |   await del(B.copy);
  1483 |   expect((await api.post(`bundles/${B.copy}/import`, { data: { files: pExport.files } })).ok()).toBeTruthy();
  1484 |   const pCopy = await (await api.get(`bundles/${B.copy}`)).json();
  1485 |   expect(
  1486 |     pCopy.conceptIndex.filter((t: { kind: string }) => t.kind === "person").map((t: { name: string }) => t.name).sort(),
  1487 |   ).toEqual(["Ana Flores", "Diego Córdoba", "María Quispe"]);
  1488 |   await del(B.copy);
  1489 | });
  1490 | 
  1491 | test("O5/SC-007: the person scope-add declares NO new tool — the surface is untouched", async () => {
  1492 |   const { count, tools } = await (await api.get("tools")).json();
  1493 |   const names = tools.map((t: { name: string }) => t.name).sort();
  1494 | 
  1495 |   // pinned against this file's own expectation list, which this scope-add
  1496 |   // does not touch: person extraction rides on the tools that already exist
  1497 |   expect(count).toBe(EXPECTED_TOOLS.length);
  1498 |   expect(names).toEqual(EXPECTED_TOOLS);
  1499 |   expect(names.some((n: string) => /person/i.test(n))).toBe(false);
  1500 | 
  1501 |   // the two tools that gained a field still declare the same requirements
  1502 |   const search = tools.find((t: { name: string }) => t.name === "okf_search");
  1503 |   expect(search.inputSchema.required).toEqual(["bundle", "query"]);
  1504 |   expect(search.parallelSafe).toBe(true);
  1505 | });
  1506 | 
  1507 | test("O3/N2–N5: the app paints the 4th category teal — graph, legend, table, pane", async ({ page }) => {
  1508 |   const app = await openApp(page);
  1509 |   await app.getByTestId("tab-query").click();
> 1510 |   await app.getByTestId("query-bundle-select").selectOption(B.person);
       |                                                ^ Error: locator.selectOption: Test timeout of 300000ms exceeded.
  1511 |   await expect(app.getByTestId("graph-svg")).toBeVisible({ timeout: 15000 });
  1512 | 
  1513 |   // the 4th legend entry and the teal node itself
  1514 |   await expect(app.getByTestId("legend-person")).toContainText("Person");
  1515 |   await expect(app.locator(".g-node.person").first()).toBeVisible();
  1516 |   expect(await app.locator(".g-node.person").count()).toBe(3);
  1517 | 
  1518 |   // the shared search highlights a person node like any other node
  1519 |   await app.getByTestId("query-search").fill("Córdoba");
  1520 |   await expect(app.getByTestId("matched-concepts")).toContainText("Diego Córdoba", { timeout: 10000 });
  1521 |   await expect(app.getByTestId("matched-concepts")).toContainText("matched person");
  1522 |   await expect(app.locator(".g-node.person.match").first()).toBeVisible();
  1523 |   await app.getByTestId("query-clear").click();
  1524 | 
  1525 |   // the Table's Kind column, and the Person row it labels
  1526 |   await app.getByTestId("view-table").click();
  1527 |   const row = app.getByTestId("table-row-person-diego córdoba");
  1528 |   await expect(row).toBeVisible();
  1529 |   await expect(row).toContainText("Person");
  1530 |   await expect(app.getByTestId("table-kind-person-diego córdoba")).toHaveText("person");
  1531 | 
  1532 |   // opening a person opens the SAME term view, labeled "Person"
  1533 |   await row.click();
  1534 |   await expect(app.getByTestId("pane-concept")).toBeVisible();
  1535 |   await expect(app.getByTestId("pane-term")).toHaveText("Diego Córdoba");
  1536 |   await expect(app.getByTestId("pane-term-kind")).toContainText("Person");
  1537 | 
  1538 |   // and the Overview concept index gives the term a teal `person` pill
  1539 |   await app.getByTestId("tab-overview").click();
  1540 |   await app.getByTestId(`bundle-row-${B.person}`).click();
  1541 |   await expect(app.getByTestId("concept-index")).toBeVisible();
  1542 |   await expect(app.getByTestId("term-kind-Diego Córdoba")).toHaveText("person");
  1543 |   await expect(app.getByTestId("term-kind-water-rights")).toHaveText("concept");
  1544 | });
  1545 | 
```