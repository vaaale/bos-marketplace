// okf-core.js — dependency-free storage engine for the Open Knowledge Format
// (OKF): a directory of Markdown files with YAML frontmatter. No npm
// dependencies — only Node built-ins (path) plus BOS's own VFS loopback
// bridge (./vfs-bridge). Every path this module operates on is a BOS VFS
// path (e.g. "/KnowledgeBase/my-bundle/concepts/foo.md"), never a host
// filesystem path — storage itself is delegated entirely to vfs-bridge's
// calls into /api/fs, which is the only sanctioned way an unbundled
// worker-thread service can reach the VFS (docs/dev/os-shell/
// virtual-file-system.md; seed/skills/build-studio/references/
// target-marketplace-item.md, "Reaching the VFS from a service"). This
// module used to mkdir/readFile/writeFile directly against a host path
// derived from the service's own config directory — which silently stored
// every bundle under BOS's internal system/config tree instead of the real,
// user-visible VFS root, so nothing ever showed up in the Files app at
// /KnowledgeBase despite the config UI and okf_* tools appearing to work.
//
// Bundle layout (<bundleRoot>/<bundleName>/):
//   index.md        curated entry point (human-written, links to concepts)
//   log.md          append-only event log (also backs point-in-time reads)
//   schema.md       frontmatter/linking conventions for this bundle
//   raw/            immutable source documents (append-only, never edited)
//   concepts/       one Markdown+frontmatter file per concept, may be nested
//
// Frontmatter is parsed into a plain object and merged shallowly on every
// write (`{ ...existing, ...patch }`), so any key this module doesn't know
// about survives untouched. It is not a byte-for-byte round trip (there is no
// external YAML library here) — comments/formatting/quoting style in
// hand-edited frontmatter are not preserved, but every key and value is.

const path = require("path").posix;
const vfs = require("./vfs-bridge");

// ── path safety ──────────────────────────────────────────────────────────

function safeJoin(root, ...segments) {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, ...segments);
  if (target !== rootResolved && !target.startsWith(rootResolved + "/")) {
    throw new Error(`path escapes root: ${segments.join("/")}`);
  }
  return target;
}

function validateBundleName(name) {
  if (!name || typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`invalid bundle name: ${JSON.stringify(name)}`);
  }
}

function validateConceptId(id) {
  if (
    !id ||
    typeof id !== "string" ||
    id.includes("..") ||
    id.startsWith("/") ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id)
  ) {
    throw new Error(`invalid concept id: ${JSON.stringify(id)}`);
  }
}

function isNotFoundError(err) {
  return /ENOENT|not found/i.test(err.message || "");
}

function nowIso() {
  return new Date().toISOString();
}

// ── tiny dependency-free YAML-lite parser/serializer (frontmatter only) ───

function getIndent(line) {
  return line.length - line.trimStart().length;
}

function findColon(str) {
  const idx = str.indexOf(": ");
  if (idx !== -1) return idx;
  if (str.endsWith(":")) return str.length - 1;
  return -1;
}

function splitFlow(inner) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== "") parts.push(cur.trim());
  return parts;
}

function parseScalar(raw) {
  const str = raw.trim();
  if (str === "" || str === "~" || /^null$/i.test(str)) return null;
  if (/^true$/i.test(str)) return true;
  if (/^false$/i.test(str)) return false;
  if (/^-?\d+$/.test(str)) return parseInt(str, 10);
  if (/^-?\d+\.\d+$/.test(str)) return parseFloat(str);
  if (str.startsWith('"') && str.endsWith('"')) {
    try {
      return JSON.parse(str);
    } catch {
      /* fall through */
    }
  }
  if (str.startsWith("'") && str.endsWith("'") && str.length >= 2) {
    return str.slice(1, -1).replace(/''/g, "'");
  }
  if (str.startsWith("[") && str.endsWith("]")) {
    const inner = str.slice(1, -1).trim();
    return inner ? splitFlow(inner).map(parseScalar) : [];
  }
  if (str.startsWith("{") && str.endsWith("}")) {
    const inner = str.slice(1, -1).trim();
    const obj = {};
    if (inner) {
      for (const part of splitFlow(inner)) {
        const idx = findColon(part);
        if (idx >= 0) obj[part.slice(0, idx).trim()] = parseScalar(part.slice(idx + 1));
      }
    }
    return obj;
  }
  return str;
}

function parseNode(lines, pos) {
  if (pos.i >= lines.length) return {};
  const trimmed = lines[pos.i].trim();
  if (trimmed === "-" || trimmed.startsWith("- ")) {
    return parseList(lines, pos, getIndent(lines[pos.i]));
  }
  return parseMap(lines, pos, getIndent(lines[pos.i]));
}

function parseList(lines, pos, indent) {
  const arr = [];
  while (pos.i < lines.length && getIndent(lines[pos.i]) === indent) {
    const trimmed = lines[pos.i].trim();
    if (!trimmed.startsWith("-")) break;
    const rest = trimmed === "-" ? "" : trimmed.slice(1).trim();
    pos.i++;
    if (rest === "") {
      arr.push(pos.i < lines.length && getIndent(lines[pos.i]) > indent ? parseNode(lines, pos) : null);
      continue;
    }
    const colonIdx = findColon(rest);
    if (colonIdx === -1) {
      arr.push(parseScalar(rest));
      continue;
    }
    const itemIndent = indent + 2; // continuation fields align under the dash
    const obj = {};
    const key = rest.slice(0, colonIdx).trim();
    const valStr = rest.slice(colonIdx + 1).trim();
    obj[key] = valStr === "" ? (pos.i < lines.length && getIndent(lines[pos.i]) > indent ? parseNode(lines, pos) : null) : parseScalar(valStr);
    while (pos.i < lines.length && getIndent(lines[pos.i]) === itemIndent) {
      const l2 = lines[pos.i].trim();
      const c2 = findColon(l2);
      if (c2 === -1) break;
      const k2 = l2.slice(0, c2).trim();
      const v2raw = l2.slice(c2 + 1).trim();
      pos.i++;
      obj[k2] = v2raw === "" ? (pos.i < lines.length && getIndent(lines[pos.i]) > itemIndent ? parseNode(lines, pos) : null) : parseScalar(v2raw);
    }
    arr.push(obj);
  }
  return arr;
}

function parseMap(lines, pos, indent) {
  const obj = {};
  while (pos.i < lines.length && getIndent(lines[pos.i]) === indent) {
    const trimmed = lines[pos.i].trim();
    if (trimmed.startsWith("-")) break;
    const colonIdx = findColon(trimmed);
    if (colonIdx === -1) {
      pos.i++;
      continue;
    }
    const key = trimmed.slice(0, colonIdx).trim();
    const valStr = trimmed.slice(colonIdx + 1).trim();
    pos.i++;
    obj[key] = valStr === "" ? (pos.i < lines.length && getIndent(lines[pos.i]) > indent ? parseNode(lines, pos) : null) : parseScalar(valStr);
  }
  return obj;
}

function parseFrontmatter(raw) {
  const lines = raw.split(/\r\n|\r|\n/);
  if ((lines[0] || "").trim() !== "---") return { frontmatter: {}, body: raw };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: {}, body: raw };
  const fmLines = lines.slice(1, end).filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  const frontmatter = fmLines.length ? parseMap(fmLines, { i: 0 }, getIndent(fmLines[0])) : {};
  let body = lines.slice(end + 1).join("\n");
  if (body.startsWith("\n")) body = body.slice(1);
  return { frontmatter, body };
}

function scalarToYaml(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (v === "") return '""';
    if (/^\s|\s$/.test(v) || /[:#[\]{}",]/.test(v) || /^(true|false|null|~)$/i.test(v) || /^-?\d+(\.\d+)?$/.test(v)) {
      return JSON.stringify(v);
    }
    return v;
  }
  return JSON.stringify(v);
}

function serializeValue(key, value, indent, lines) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}${key}: []`);
      return;
    }
    lines.push(`${pad}${key}:`);
    for (const item of value) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) {
          lines.push(`${pad}  -`);
          continue;
        }
        entries.forEach(([k, v], idx) => {
          const prefix = idx === 0 ? `${pad}  - ` : `${pad}    `;
          if (v !== null && typeof v === "object") {
            lines.push(`${prefix}${k}:`);
            serializeMapBody(v, indent + 4, lines);
          } else {
            lines.push(`${prefix}${k}: ${scalarToYaml(v)}`);
          }
        });
      } else {
        lines.push(`${pad}  - ${scalarToYaml(item)}`);
      }
    }
  } else if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      lines.push(`${pad}${key}: {}`);
      return;
    }
    lines.push(`${pad}${key}:`);
    serializeMapBody(value, indent + 2, lines);
  } else {
    lines.push(`${pad}${key}: ${scalarToYaml(value)}`);
  }
}

function serializeMapBody(obj, indent, lines) {
  for (const [k, v] of Object.entries(obj)) serializeValue(k, v, indent, lines);
}

function serializeFrontmatter(obj) {
  const lines = [];
  serializeMapBody(obj, 0, lines);
  return lines.join("\n");
}

function stringifyDocument(frontmatter, body) {
  return `---\n${serializeFrontmatter(frontmatter)}\n---\n\n${(body || "").replace(/^\n+/, "")}`;
}

// ── link extraction ──────────────────────────────────────────────────────

function normalizeLinkTarget(raw) {
  let t = raw.trim();
  const spaceIdx = t.search(/\s/);
  if (spaceIdx !== -1) t = t.slice(0, spaceIdx); // drop a trailing "title"
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null; // external scheme (http:, mailto:, ...)
  if (t.startsWith("#")) return null; // in-page anchor
  t = t.split("#")[0].split("?")[0];
  t = t.replace(/^\.\//, "").replace(/^\/+/, "");
  if (!t.endsWith(".md")) return null; // only concept-to-concept links are graph edges
  t = t.slice(0, -3);
  return t || null;
}

function extractLinks(body) {
  const links = new Set();
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(body))) {
    const target = normalizeLinkTarget(m[1]);
    if (target) links.add(target);
  }
  return Array.from(links);
}

// ── bundle/concept path helpers ──────────────────────────────────────────

function bundleDir(bundleRoot, name) {
  validateBundleName(name);
  return safeJoin(bundleRoot, name);
}

function conceptFilePath(bDir, id) {
  validateConceptId(id);
  return safeJoin(bDir, "concepts", `${id}.md`);
}

async function listConceptIds(bDir) {
  const conceptsDir = path.join(bDir, "concepts");
  const ids = [];
  async function walk(dir, rel) {
    const entries = await vfs.list(dir).catch(() => []);
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.type === "dir") {
        await walk(abs, rel ? `${rel}/${e.name}` : e.name);
      } else if (e.name.endsWith(".md")) {
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        ids.push(relPath.slice(0, -3));
      }
    }
  }
  await walk(conceptsDir, "");
  return ids;
}

async function readConceptRaw(bDir, id) {
  const p = conceptFilePath(bDir, id);
  let raw;
  try {
    raw = await vfs.readText(p);
  } catch (e) {
    if (isNotFoundError(e)) return null;
    throw e;
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  return { frontmatter, body, path: p, raw };
}

// ── in-memory backlink/graph index (rebuilt lazily on-change) ────────────

const graphCache = new Map(); // bDir -> { forward: Map, backlinks: Map, dirty }

function markGraphDirty(bDir) {
  graphCache.set(bDir, { dirty: true });
}

async function ensureGraph(bDir) {
  const cached = graphCache.get(bDir);
  if (cached && !cached.dirty) return cached;
  const ids = await listConceptIds(bDir);
  const forward = new Map();
  const backlinks = new Map();
  for (const id of ids) {
    const parsed = await readConceptRaw(bDir, id);
    const links = parsed ? extractLinks(parsed.body) : [];
    forward.set(id, new Set(links));
    for (const t of links) {
      if (!backlinks.has(t)) backlinks.set(t, new Set());
      backlinks.get(t).add(id);
    }
  }
  const graph = { forward, backlinks, dirty: false, builtAt: Date.now() };
  graphCache.set(bDir, graph);
  return graph;
}

// ── log.md (append-only; also backs point-in-time reads) ─────────────────

async function appendLog(bundleRoot, bundleName, { event, message, conceptId, at, snapshot, data }) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const ts = at || nowIso();
  const subject = conceptId || "-";
  let entry = `\n## ${ts} — ${event} — ${subject}\n\n${message || ""}\n`;
  if (data !== undefined) entry += `\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
  if (snapshot !== undefined) entry += `\n\`\`\`okf-snapshot\n${snapshot}\n\`\`\`\n`;
  const p = safeJoin(bDir, "log.md");
  const current = await vfs.readText(p).catch(() => "# Log\n");
  await vfs.writeText(p, current + entry);
  return { ok: true, at: ts };
}

function parseLogEntries(logRaw) {
  const chunks = logRaw.split(/\n(?=## )/).filter((c) => c.trim().startsWith("## "));
  const entries = [];
  const headerRe = /^##\s+(\S+)\s+—\s+(\S+)\s+—\s+(.+)$/;
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const m = headerRe.exec(lines[0].trim());
    if (!m) continue;
    const [, at, event, subject] = m;
    const snapshotMatch = /```okf-snapshot\n([\s\S]*?)\n```/.exec(chunk);
    entries.push({ at, event, subject, snapshot: snapshotMatch ? snapshotMatch[1] : null });
  }
  return entries;
}

// ── bundle-level operations ────────────────────────────────────────────

function schemaTemplate(name, title) {
  return `# Schema — ${title}

Every concept file under \`concepts/\` is a Markdown document with YAML frontmatter:

\`\`\`yaml
---
id: concept-id
title: Human-readable title
status: draft | stable | deprecated
stale_after: 2026-01-01   # optional ISO date; concept is "stale" once passed
verified: unverified | machine-confirmed | human-reviewed
sources:
  - id: source-id
    uri: raw/source-file.md
    note: optional note
attestations:
  - by: reviewer-name
    at: 2026-01-01T00:00:00.000Z
    note: optional note
created_at: 2026-01-01T00:00:00.000Z
updated_at: 2026-01-01T00:00:00.000Z
---
\`\`\`

Links to other concepts are plain Markdown links to another concept's path
(relative to \`concepts/\`) with a \`.md\` extension, e.g.
\`[Other Concept](other-concept.md)\` or \`[Nested](area/nested.md)\` — these
are extracted as graph edges. Everything under \`raw/\` is an immutable source
document; concept files cite it via \`sources\`, never edit it in place.
`;
}

function isStale(frontmatter, nowMs) {
  if (!frontmatter || !frontmatter.stale_after) return false;
  const t = Date.parse(frontmatter.stale_after);
  if (Number.isNaN(t)) return false;
  return nowMs >= t;
}

async function initBundle(bundleRoot, name, opts = {}) {
  const bDir = bundleDir(bundleRoot, name);
  if (await vfs.exists(bDir)) throw new Error(`bundle already exists: ${name}`);
  await vfs.mkdir(path.join(bDir, "raw"));
  await vfs.mkdir(path.join(bDir, "concepts"));
  const title = opts.title || name;
  const description = opts.description || "";
  await vfs.writeText(
    path.join(bDir, "index.md"),
    `# ${title}\n\n${description}\n\n## Concepts\n\n_No concepts yet — add one to see it listed here._\n`,
  );
  await vfs.writeText(path.join(bDir, "schema.md"), schemaTemplate(name, title));
  await vfs.writeText(path.join(bDir, "log.md"), `# Log — ${title}\n`);
  await appendLog(bundleRoot, name, { event: "bundle_init", message: `bundle "${name}" created` });
  return bundleStatus(bundleRoot, name);
}

async function bundleStatus(bundleRoot, name) {
  const bDir = bundleDir(bundleRoot, name);
  const ids = await listConceptIds(bDir);
  const statusCounts = {};
  let staleCount = 0;
  let humanReviewedCount = 0;
  const now = Date.now();
  for (const id of ids) {
    const parsed = await readConceptRaw(bDir, id);
    const fm = parsed ? parsed.frontmatter : {};
    const st = fm.status || "draft";
    statusCounts[st] = (statusCounts[st] || 0) + 1;
    if (fm.verified === "human-reviewed") humanReviewedCount++;
    if (isStale(fm, now)) staleCount++;
  }
  return {
    name,
    conceptCount: ids.length,
    staleCount,
    humanReviewedCount,
    statusCounts,
    checkedAt: nowIso(),
  };
}

async function listBundles(bundleRoot) {
  await vfs.mkdir(bundleRoot);
  const entries = await vfs.list(bundleRoot).catch(() => []);
  const bundles = [];
  for (const e of entries) {
    if (e.type !== "dir") continue;
    const bDir = path.join(bundleRoot, e.name);
    if (!(await vfs.exists(path.join(bDir, "index.md"))) && !(await vfs.exists(path.join(bDir, "concepts")))) continue;
    bundles.push(await bundleStatus(bundleRoot, e.name));
  }
  return bundles;
}

async function exportBundle(bundleRoot, name) {
  const bDir = bundleDir(bundleRoot, name);
  if (!(await vfs.exists(bDir))) throw new Error(`bundle not found: ${name} — create it first with okf_init_bundle({bundle: "${name}"})`);
  const files = [];
  async function walk(dir, rel) {
    const entries = await vfs.list(dir).catch(() => []);
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.type === "dir") await walk(abs, relPath);
      else files.push({ path: relPath, content: await vfs.readText(abs) });
    }
  }
  await walk(bDir, "");
  return { name, files };
}

async function importBundle(bundleRoot, name, { files } = {}) {
  if (!Array.isArray(files)) throw new Error("files array is required");
  const bDir = bundleDir(bundleRoot, name);
  await vfs.mkdir(bDir);
  for (const f of files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") continue;
    const dest = safeJoin(bDir, f.path);
    await vfs.writeText(dest, f.content); // /api/fs's write op creates any missing parent dir
  }
  await vfs.mkdir(path.join(bDir, "raw"));
  await vfs.mkdir(path.join(bDir, "concepts"));
  markGraphDirty(bDir);
  await appendLog(bundleRoot, name, { event: "bundle_import", message: `imported ${files.length} file(s)` });
  return bundleStatus(bundleRoot, name);
}

async function addRawSource(bundleRoot, bundleName, relPath, content) {
  if (!relPath || typeof relPath !== "string") throw new Error("path is required");
  if (content === undefined || content === null) throw new Error("content is required");
  const bDir = bundleDir(bundleRoot, bundleName);
  if (!(await vfs.exists(bDir))) throw new Error(`bundle not found: ${bundleName} — create it first with okf_init_bundle({bundle: "${bundleName}"})`);
  const rawDir = path.join(bDir, "raw");
  const dest = safeJoin(rawDir, relPath); // throws on path traversal outside raw/
  if (await vfs.exists(dest)) throw new Error(`raw source already exists (append-only, never overwritten): ${relPath}`);
  await vfs.writeText(dest, content);
  await appendLog(bundleRoot, bundleName, { event: "raw_add", message: `added raw source "${relPath}"` });
  return { path: `raw/${relPath}`, added: true };
}

async function readIndex(bundleRoot, name) {
  const bDir = bundleDir(bundleRoot, name);
  return vfs.readText(safeJoin(bDir, "index.md"));
}

async function readBundleSchema(bundleRoot, name) {
  const bDir = bundleDir(bundleRoot, name);
  return vfs.readText(safeJoin(bDir, "schema.md"));
}

// ── concept CRUD ─────────────────────────────────────────────────────────

async function readConcept(bundleRoot, bundleName, id) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const parsed = await readConceptRaw(bDir, id);
  if (!parsed) throw new Error(`concept not found: ${bundleName}/${id}`);
  return { id, frontmatter: parsed.frontmatter, body: parsed.body, links: extractLinks(parsed.body) };
}

async function upsertConcept(bundleRoot, bundleName, id, { title, body, frontmatter } = {}) {
  const bDir = bundleDir(bundleRoot, bundleName);
  if (!(await vfs.exists(bDir))) throw new Error(`bundle not found: ${bundleName} — create it first with okf_init_bundle({bundle: "${bundleName}"})`);
  const existing = await readConceptRaw(bDir, id);
  const now = nowIso();
  const base = existing
    ? { ...existing.frontmatter }
    : { id, title: title || id, status: "draft", verified: "unverified", created_at: now };
  const patch = { ...(frontmatter || {}) };
  if (title !== undefined) patch.title = title;
  const merged = { ...base, ...patch, id, updated_at: now };
  if (merged.created_at === undefined) merged.created_at = base.created_at || now;
  const finalBody = body !== undefined ? body : existing ? existing.body : `# ${merged.title}\n`;
  const raw = stringifyDocument(merged, finalBody);
  await vfs.writeText(conceptFilePath(bDir, id), raw);
  markGraphDirty(bDir);
  await appendLog(bundleRoot, bundleName, {
    event: existing ? "concept_update" : "concept_create",
    conceptId: id,
    message: `${existing ? "updated" : "created"} concept "${id}"`,
    at: now,
    snapshot: raw,
  });
  return readConcept(bundleRoot, bundleName, id);
}

// Default (rewriteBacklinks: false) is a minimal, non-destructive delete:
// only the concept file itself is removed — backlinking concepts, index.md,
// and log.md are left exactly as they were, so deleting a concept never
// silently rewrites content the caller didn't ask to touch. Only when
// rewriteBacklinks is true does this also rewrite every backlinker (via the
// existing addLink/removeLink body-patch path, which already preserves
// unknown frontmatter keys through upsertConcept's shallow merge), strip any
// index.md line linking to the deleted concept, and record the deletion in
// log.md. Deleting the last concept in a bundle only removes that concept's
// file — the bundle directory itself is untouched either way; use
// deleteBundle to remove a whole bundle.
async function deleteConcept(bundleRoot, bundleName, id, { rewriteBacklinks = false } = {}) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const p = conceptFilePath(bDir, id);
  if (!(await vfs.exists(p))) throw new Error(`concept not found: ${bundleName}/${id}`);
  await vfs.remove(p);
  markGraphDirty(bDir);

  if (!rewriteBacklinks) {
    return { id, deleted: true, rewroteBacklinks: false };
  }

  // Rebuilt now (markGraphDirty above forces this), so it reflects the
  // concept's file already being gone — but backlinks.get(id) is populated
  // from the *other* concepts' bodies, which still contain the link.
  const graph = await ensureGraph(bDir);
  const linkers = Array.from(graph.backlinks.get(id) || []);
  for (const linkerId of linkers) {
    await removeLink(bundleRoot, bundleName, linkerId, id);
  }

  // index.md sits at the bundle root, so its links to a concept are written
  // relative to *that* (e.g. "concepts/foo.md"), not relative to concepts/
  // like concept-to-concept links ("foo.md") — strip that prefix before
  // comparing against the bare concept id.
  const indexPath = safeJoin(bDir, "index.md");
  const indexRaw = await vfs.readText(indexPath).catch(() => null);
  if (indexRaw !== null) {
    const filtered = indexRaw
      .split("\n")
      .filter((line) => {
        const m = /\[[^\]]*\]\(([^)]+)\)/.exec(line);
        if (!m) return true;
        const target = normalizeLinkTarget(m[1]);
        if (target === null) return true;
        const bare = target.startsWith("concepts/") ? target.slice("concepts/".length) : target;
        return bare !== id;
      })
      .join("\n");
    if (filtered !== indexRaw) await vfs.writeText(indexPath, filtered);
  }

  await appendLog(bundleRoot, bundleName, {
    event: "concept_delete",
    conceptId: id,
    message: `deleted concept "${id}"${linkers.length ? ` and rewrote ${linkers.length} backlinking concept(s): ${linkers.join(", ")}` : ""}`,
  });

  return { id, deleted: true, rewroteBacklinks: true, backlinksRewritten: linkers };
}

// Removes the whole bundle directory (recursively). bundleDir() already
// validates the name and scopes the resulting path under bundleRoot via
// safeJoin, so a traversal attempt (e.g. "../other") throws before any
// filesystem call is made, exactly like every other bundle-scoped operation
// in this module.
async function deleteBundle(bundleRoot, name) {
  const bDir = bundleDir(bundleRoot, name);
  if (!(await vfs.exists(bDir))) throw new Error(`bundle not found: ${name} — create it first with okf_init_bundle({bundle: "${name}"})`);
  await vfs.remove(bDir);
  graphCache.delete(bDir);
  return { name, deleted: true };
}

async function listConcepts(bundleRoot, bundleName, { status, trust } = {}) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const ids = await listConceptIds(bDir);
  const out = [];
  for (const id of ids) {
    const parsed = await readConceptRaw(bDir, id);
    const fm = parsed.frontmatter;
    if (status && fm.status !== status) continue;
    if (trust && fm.verified !== trust) continue;
    out.push({
      id,
      title: fm.title || id,
      status: fm.status || "draft",
      verified: fm.verified || "unverified",
      staleAfter: fm.stale_after || null,
      updatedAt: fm.updated_at || null,
    });
  }
  return out;
}

async function findConcepts(bundleRoot, bundleName, { query, limit = 20 } = {}) {
  if (!query) return [];
  const bDir = bundleDir(bundleRoot, bundleName);
  const ids = await listConceptIds(bDir);
  const q = String(query).toLowerCase();
  const scored = [];
  for (const id of ids) {
    const parsed = await readConceptRaw(bDir, id);
    const haystack = `${parsed.frontmatter.title || ""}\n${id}\n${parsed.body}`.toLowerCase();
    let score = 0;
    let idx = haystack.indexOf(q);
    while (idx !== -1) {
      score++;
      idx = haystack.indexOf(q, idx + q.length);
    }
    if (score > 0) scored.push({ id, title: parsed.frontmatter.title || id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ── links / graph ────────────────────────────────────────────────────────

async function patchConceptBody(bundleRoot, bundleName, id, mutateBody) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const existing = await readConceptRaw(bDir, id);
  if (!existing) throw new Error(`concept not found: ${bundleName}/${id}`);
  const newBody = mutateBody(existing.body);
  return upsertConcept(bundleRoot, bundleName, id, { body: newBody });
}

function ensureLinksSection(body) {
  if (/^##\s+Links\s*$/m.test(body)) return body;
  return `${body.replace(/\n+$/, "\n")}\n## Links\n`;
}

async function addLink(bundleRoot, bundleName, id, targetId, { label } = {}) {
  return patchConceptBody(bundleRoot, bundleName, id, (body) => {
    const existingLinks = extractLinks(body);
    if (existingLinks.includes(targetId)) return body;
    const withSection = ensureLinksSection(body);
    return `${withSection.replace(/\n+$/, "\n")}- [${label || targetId}](${targetId}.md)\n`;
  });
}

async function removeLink(bundleRoot, bundleName, id, targetId) {
  return patchConceptBody(bundleRoot, bundleName, id, (body) => {
    const lines = body.split("\n");
    const kept = lines.filter((line) => {
      const m = /\[[^\]]*\]\(([^)]+)\)/.exec(line);
      if (!m) return true;
      return normalizeLinkTarget(m[1]) !== targetId;
    });
    return kept.join("\n");
  });
}

async function listLinks(bundleRoot, bundleName, id) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const parsed = await readConceptRaw(bDir, id);
  if (!parsed) throw new Error(`concept not found: ${bundleName}/${id}`);
  return extractLinks(parsed.body);
}

async function backlinks(bundleRoot, bundleName, id) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const graph = await ensureGraph(bDir);
  return Array.from(graph.backlinks.get(id) || []);
}

async function neighbors(bundleRoot, bundleName, id, { depth = 1 } = {}) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const graph = await ensureGraph(bDir);
  const visited = new Map([[id, 0]]);
  let frontier = [id];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    for (const cur of frontier) {
      const outs = graph.forward.get(cur) || new Set();
      const ins = graph.backlinks.get(cur) || new Set();
      for (const n of new Set([...outs, ...ins])) {
        if (!visited.has(n)) {
          visited.set(n, d);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  visited.delete(id);
  return Array.from(visited.entries()).map(([nid, distance]) => ({ id: nid, distance }));
}

async function shortestPath(bundleRoot, bundleName, fromId, toId) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const graph = await ensureGraph(bDir);
  if (fromId === toId) return { path: [fromId], length: 0 };
  const visited = new Set([fromId]);
  const queue = [[fromId]];
  while (queue.length) {
    const path_ = queue.shift();
    const cur = path_[path_.length - 1];
    const outs = graph.forward.get(cur) || new Set();
    const ins = graph.backlinks.get(cur) || new Set();
    for (const n of new Set([...outs, ...ins])) {
      if (visited.has(n)) continue;
      const nextPath = [...path_, n];
      if (n === toId) return { path: nextPath, length: nextPath.length - 1 };
      visited.add(n);
      queue.push(nextPath);
    }
  }
  return { path: null, length: -1 };
}

async function exportGraph(bundleRoot, bundleName) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const graph = await ensureGraph(bDir);
  const ids = await listConceptIds(bDir);
  const nodes = [];
  for (const id of ids) {
    const parsed = await readConceptRaw(bDir, id);
    nodes.push({ id, title: parsed.frontmatter.title || id, status: parsed.frontmatter.status || "draft" });
  }
  const edges = [];
  for (const [from, targets] of graph.forward.entries()) {
    for (const to of targets) edges.push({ from, to });
  }
  return { nodes, edges };
}

// ── lifecycle: status, trust, provenance, point-in-time reads ────────────

const STATUSES = ["draft", "stable", "deprecated"];
const TRUST_LEVELS = ["unverified", "machine-confirmed", "human-reviewed"];

async function setStatus(bundleRoot, bundleName, id, status, { staleAfter } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
  const patch = { status };
  if (staleAfter !== undefined) patch.stale_after = staleAfter;
  return upsertConcept(bundleRoot, bundleName, id, { frontmatter: patch });
}

async function setTrust(bundleRoot, bundleName, id, trust) {
  if (!TRUST_LEVELS.includes(trust)) throw new Error(`invalid trust level: ${trust}`);
  return upsertConcept(bundleRoot, bundleName, id, { frontmatter: { verified: trust } });
}

async function addSource(bundleRoot, bundleName, id, source) {
  if (!source || !source.id) throw new Error("source.id is required");
  const bDir = bundleDir(bundleRoot, bundleName);
  const existing = await readConceptRaw(bDir, id);
  const sources = existing && Array.isArray(existing.frontmatter.sources) ? [...existing.frontmatter.sources] : [];
  const idx = sources.findIndex((s) => s && s.id === source.id);
  const entry = { id: source.id, uri: source.uri || null, note: source.note || "", addedAt: nowIso() };
  if (idx >= 0) sources[idx] = entry;
  else sources.push(entry);
  return upsertConcept(bundleRoot, bundleName, id, { frontmatter: { sources } });
}

async function attest(bundleRoot, bundleName, id, { by, note } = {}) {
  if (!by) throw new Error("by is required");
  const bDir = bundleDir(bundleRoot, bundleName);
  const existing = await readConceptRaw(bDir, id);
  const attestations = existing && Array.isArray(existing.frontmatter.attestations) ? [...existing.frontmatter.attestations] : [];
  attestations.push({ by, note: note || "", at: nowIso() });
  return upsertConcept(bundleRoot, bundleName, id, { frontmatter: { attestations } });
}

async function provenance(bundleRoot, bundleName, id) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const parsed = await readConceptRaw(bDir, id);
  if (!parsed) throw new Error(`concept not found: ${bundleName}/${id}`);
  const fm = parsed.frontmatter;
  return {
    id,
    verified: fm.verified || "unverified",
    sources: fm.sources || [],
    attestations: fm.attestations || [],
    createdAt: fm.created_at || null,
    updatedAt: fm.updated_at || null,
  };
}

async function staleReport(bundleRoot, bundleName) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const ids = await listConceptIds(bDir);
  const now = Date.now();
  const stale = [];
  for (const id of ids) {
    const parsed = await readConceptRaw(bDir, id);
    if (isStale(parsed.frontmatter, now)) {
      const staleAt = Date.parse(parsed.frontmatter.stale_after);
      stale.push({
        id,
        title: parsed.frontmatter.title || id,
        staleAfter: parsed.frontmatter.stale_after,
        daysStale: Math.max(0, Math.floor((now - staleAt) / (24 * 60 * 60 * 1000))),
      });
    }
  }
  return stale;
}

async function getAsOf(bundleRoot, bundleName, id, asOf) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const logRaw = await vfs.readText(safeJoin(bDir, "log.md")).catch(() => "");
  const entries = parseLogEntries(logRaw).filter(
    (e) => e.subject === id && ["concept_create", "concept_update", "concept_delete"].includes(e.event) && Date.parse(e.at) <= Date.parse(asOf),
  );
  if (!entries.length) return null;
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latest = entries[entries.length - 1];
  if (latest.event === "concept_delete") return { id, deleted: true, at: latest.at };
  if (!latest.snapshot) return null;
  const { frontmatter, body } = parseFrontmatter(latest.snapshot);
  return { id, frontmatter, body, links: extractLinks(body), at: latest.at };
}

// ── ingest / lint (the mechanical half of the LLM ingest/lint flow) ───────

// Register bytes into raw/. Content arrives EITHER inline (`content`, for small
// pasted text) OR by reference (`sourcePath`, a VFS path something else already
// staged — e.g. web_fetch/file_to_markdown output). sourcePath is what keeps a
// large source out of the calling model's context entirely: the caller passes a
// path, not the document. sourcePath wins if both are given.
async function ingestRaw(bundleRoot, bundleName, { filename, content, sourcePath, conceptId, title } = {}) {
  if (sourcePath) {
    content = await vfs.readText(sourcePath);
    if (!filename) filename = path.basename(sourcePath);
  }
  if (!filename || content === undefined) {
    throw new Error("filename and one of content/sourcePath are required");
  }
  const bDir = bundleDir(bundleRoot, bundleName);
  if (!(await vfs.exists(bDir))) throw new Error(`bundle not found: ${bundleName} — create it first with okf_init_bundle({bundle: "${bundleName}"})`);
  const safeName = path.basename(filename);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  let finalName = safeName;
  let n = 1;
  // raw/ is append-only — never overwrite an existing source, version it instead
  while (await vfs.exists(safeJoin(bDir, "raw", finalName))) {
    n++;
    finalName = `${base}.v${n}${ext}`;
  }
  const rawPath = safeJoin(bDir, "raw", finalName);
  await vfs.writeText(rawPath, content);
  await appendLog(bundleRoot, bundleName, { event: "raw_ingest", message: `ingested raw source "${finalName}"` });

  let concept = null;
  if (conceptId) {
    const existing = await readConceptRaw(bDir, conceptId);
    const sources = existing && Array.isArray(existing.frontmatter.sources) ? [...existing.frontmatter.sources] : [];
    sources.push({ id: finalName, uri: `raw/${finalName}`, note: "ingested raw source", addedAt: nowIso() });
    concept = await upsertConcept(bundleRoot, bundleName, conceptId, {
      title,
      body: existing ? undefined : `# ${title || conceptId}\n\n_Drafted from ingested source \`raw/${finalName}\` — flesh out via okf_upsert_concept._\n`,
      frontmatter: { sources },
    });
  }
  // Be explicit that the source IS stored and that a null concept is normal.
  // A bare `{rawFile, concept: null}` reads as a partial failure: an agent once
  // took it to mean the content had not been saved, "fixed" that by overwriting
  // raw/ with a placeholder string, and destroyed the correct state it had just
  // created. The return value has to say what happened, not leave it inferable.
  return {
    rawFile: `raw/${finalName}`,
    bytes: content.length,
    stored: true,
    concept,
    note: concept
      ? `Source stored (${content.length} chars) and concept "${concept.id}" stubbed. Next: okf_ingest({bundle, source: "raw/${finalName}"}).`
      : `Source stored (${content.length} chars). concept:null is expected — no conceptId was requested, and concepts are written later by the okf-ingest agent. Do NOT re-import the content. Next: okf_ingest({bundle, source: "raw/${finalName}"}).`,
  };
}

async function lintBundle(bundleRoot, bundleName) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const ids = await listConceptIds(bDir);
  const idSet = new Set(ids);
  const graph = await ensureGraph(bDir);
  const errors = [];
  const warnings = [];
  const referencedRaw = new Set();

  for (const id of ids) {
    const parsed = await readConceptRaw(bDir, id);
    const fm = parsed.frontmatter;
    if (!fm.title) errors.push({ conceptId: id, issue: "missing title" });
    if (!fm.status) warnings.push({ conceptId: id, issue: "missing status (defaults to draft)" });
    if (fm.verified && !TRUST_LEVELS.includes(fm.verified)) errors.push({ conceptId: id, issue: `invalid verified value: ${fm.verified}` });
    for (const target of graph.forward.get(id) || []) {
      if (!idSet.has(target)) warnings.push({ conceptId: id, issue: `broken link to "${target}"` });
    }
    if ((graph.backlinks.get(id) || new Set()).size === 0) warnings.push({ conceptId: id, issue: "orphan concept — no backlinks" });
    if (isStale(fm, Date.now())) warnings.push({ conceptId: id, issue: "stale (past stale_after)" });
    for (const s of fm.sources || []) {
      if (s && s.uri) referencedRaw.add(path.basename(String(s.uri)));
    }
  }

  const rawEntries = await vfs.list(safeJoin(bDir, "raw")).catch(() => []);
  for (const e of rawEntries) {
    if (e.type === "dir") continue;
    if (!referencedRaw.has(e.name)) warnings.push({ issue: `raw file "${e.name}" is not referenced by any concept's sources` });
  }

  return { bundle: bundleName, conceptCount: ids.length, errors, warnings };
}

module.exports = {
  // bundles
  listBundles,
  initBundle,
  bundleStatus,
  importBundle,
  exportBundle,
  addRawSource,
  readIndex,
  readBundleSchema,
  deleteBundle,
  // concepts
  upsertConcept,
  readConcept,
  deleteConcept,
  listConcepts,
  findConcepts,
  // graph
  addLink,
  removeLink,
  listLinks,
  backlinks,
  neighbors,
  shortestPath,
  exportGraph,
  // lifecycle
  setStatus,
  getAsOf,
  staleReport,
  setTrust,
  addSource,
  attest,
  provenance,
  // ingest/lint
  ingestRaw,
  lintBundle,
  appendLog,
  // exposed for tests/tooling
  extractLinks,
  normalizeLinkTarget,
  parseFrontmatter,
  stringifyDocument,
  safeJoin,
};
