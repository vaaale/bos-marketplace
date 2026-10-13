// okf-core.js — dependency-free storage engine + derived-index layer for the
// Open Knowledge Format (OKF): a directory of Markdown files with YAML
// frontmatter. No npm dependencies — only Node built-ins (path) plus BOS's
// own VFS loopback bridge (./vfs-bridge). Every path this module operates on
// is a BOS VFS path (e.g. "/KnowledgeBase/my-bundle/concepts/foo.md"), never
// a host filesystem path — storage is delegated entirely to vfs-bridge's
// calls into /api/fs, which is the only sanctioned way an unbundled
// worker-thread service can reach the VFS (docs/dev/os-shell/
// virtual-file-system.md; seed/skills/build-studio/references/
// target-marketplace-item.md, "Reaching the VFS from a service").
//
// ── What this module owns (the redesign, design.md §5–§6) ───────────────
//
// CANONICAL CONTENT (the source of truth):
//   concepts/<docId>.md          document stub   {type: document, ...}
//   concepts/<docId>/<chId>.md   chapter         {type: section, parent,
//                                                 concepts[], summary, ...}
//   raw/**                       immutable sources + downloaded inline assets
//
// DERIVED ARTIFACTS (regenerable; never the sole source of truth — NFR-004):
//   concept-index.md             Level 1 — the O(V) routing table:
//                                  term -> covering (doc, chapter, description)
//   toc/<docId>.md               Level 2 — one document's chapter listing
//
// Both are rebuilt from chapter frontmatter on EVERY write that can change
// them, and stamped `index_generated_at`. Staleness is detected by comparing
// that stamp against the newest chapter `updated_at`, so a hand-edited bundle
// (git pull, editor, another tool) repairs itself on the next read instead of
// silently serving a rotten index.
//
// Bundle layout (<bundleRoot>/<bundleName>/):
//   index.md           curated entry point + a derived "concepts covered" list
//   log.md             append-only event log
//   concept-index.md   DERIVED level-1 routing table
//   toc/<docId>.md     DERIVED level-2 document tables of contents
//   links.json         machine-readable okf_add_link edges (graph sidecar)
//   raw/               immutable sources (append-only, never edited)
//   raw/sources.json   provenance ledger (dedup + the "Open source" target)
//   raw/assets/<docId>/  downloaded non-HTML inline assets (immutable)
//   concepts/          document stubs + nested chapter files
//
// Frontmatter is parsed into a plain object and merged shallowly on every
// write (`{ ...existing, ...patch }`), so any key this module doesn't know
// about survives untouched (NFR-005 / SC-005). It is not a byte-for-byte
// round trip (there is no external YAML library here) — comments/formatting/
// quoting style in hand-edited frontmatter are not preserved, but every key
// and value is.

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
        // A list item's fields sit at indent+4 ("  - " is four columns wide),
        // and the first field carries the dash. Serializing each field with
        // the SAME serializeValue used everywhere else is what makes a value
        // that is itself an array work — the concept index's `terms[].covers`
        // is exactly that shape. (The pre-redesign version special-cased
        // nested values with serializeMapBody, which turned a nested ARRAY
        // into `0:`/`1:` keys: the index then re-parsed as garbage, and
        // nothing downstream could tell. The round-trip is asserted in
        // okf_lint's drift check, which is how that would surface now.)
        entries.forEach(([k, v], idx) => {
          const sub = [];
          serializeValue(k, v, indent + 4, sub);
          if (idx === 0) sub[0] = `${pad}  - ${sub[0].trimStart()}`;
          lines.push(...sub);
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

// ── in-memory link graph (backlinks) + derived-view cache ────────────────
//
// Two caches, both invalidated by the SAME write path. `graphCache` is the
// retained markdown-link backlink index. `derivedCache` is new: it holds the
// parsed concept index / TOC / knowledge graph so a search or a graph render
// doesn't re-walk every chapter file. Both are read-through — a dirty or
// absent entry rebuilds once, on demand (design.md §5.3 "read-through cache").

const graphCache = new Map(); // bDir -> { forward: Map, backlinks: Map, dirty }
const derivedCache = new Map(); // bDir -> { model, builtAt }

function markGraphDirty(bDir) {
  graphCache.set(bDir, { dirty: true });
  derivedCache.delete(bDir);
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

// ── log.md (append-only operational history, internal — no okf_append_log) ─

async function appendLog(bundleRoot, bundleName, { event, message, conceptId, at, data }) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const ts = at || nowIso();
  const subject = conceptId || "-";
  let entry = `\n## ${ts} — ${event} — ${subject}\n\n${message || ""}\n`;
  if (data !== undefined) entry += `\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
  const p = safeJoin(bDir, "log.md");
  const current = await vfs.readText(p).catch(() => "# Log\n");
  await vfs.writeText(p, current + entry);
  return { ok: true, at: ts };
}

// ── lifecycle helpers ────────────────────────────────────────────────────

const STATUSES = ["draft", "stable", "deprecated"];
const TRUST_LEVELS = ["unverified", "machine-confirmed", "human-reviewed"];

function isStale(frontmatter, nowMs) {
  if (!frontmatter || !frontmatter.stale_after) return false;
  const t = Date.parse(frontmatter.stale_after);
  if (Number.isNaN(t)) return false;
  return nowMs >= t;
}

function firstProse(body) {
  for (const line of String(body || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith(">") || t.startsWith("---") || t.startsWith("!")) continue;
    return t.replace(/[*`_]/g, "").slice(0, 160);
  }
  return "";
}

// ── inline-asset blocks (ADR-008 / FR-020–023) ───────────────────────────
//
// The canonical stored form inside a chapter body is a markdown image link
// whose target is BUNDLE-RELATIVE (`raw/assets/<docId>/<file>`), immediately
// followed by a blockquote whose first line starts `**Interpretation`:
//
//   ![Canary rollout console](raw/assets/deployment/canary-demo.mp4)
//
//   > **Interpretation (LLM, at ingest):** Screen-capture of the deploy
//   > console: the canary pod set is bumped 0→5% …
//
// `okf_read_concept` returns both the link and the stored interpretation, so
// an agent gets the asset's knowledge WITHOUT re-running vision at query time
// (FR-023 / SC-003). A `../../raw/assets/...` form (written relative to the
// chapter file rather than the bundle) is accepted on read and normalised.

const ASSET_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", pdf: "application/pdf",
};
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv"]);

function assetContentType(p) {
  const ext = String(p).split(".").pop().toLowerCase();
  return ASSET_EXT[ext] || "application/octet-stream";
}

function assetKind(p) {
  const ext = String(p).split(".").pop().toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (ext === "mp3" || ext === "wav") return "audio";
  return "image";
}

/** Normalise an in-body asset target to a bundle-relative `raw/...` path. */
function normalizeAssetTarget(raw) {
  let t = String(raw || "").trim().split(/\s+/)[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null; // remote reference — NOT a stored asset (FR-022)
  t = t.replace(/^\.\//, "").replace(/(\.\.\/)+/g, "").replace(/^\/+/, "");
  if (!t.startsWith("raw/")) return null;
  return t;
}

/**
 * Extract every stored inline-asset block from a chapter body.
 * Returns [{ path, caption, kind, interpretation, interpretationAvailable }].
 */
function extractAssets(body) {
  const out = [];
  const lines = String(body || "").split("\n");
  const imgRe = /!\[([^\]]*)\]\(\s*([^)]+?)\s*\)/;
  for (let i = 0; i < lines.length; i++) {
    const m = imgRe.exec(lines[i]);
    if (!m) continue;
    const target = normalizeAssetTarget(m[2]);
    if (!target) continue;
    // the interpretation is the next blockquote run, blank lines allowed between
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    const quote = [];
    while (j < lines.length && /^\s*>/.test(lines[j])) {
      quote.push(lines[j].replace(/^\s*>\s?/, ""));
      j++;
    }
    const text = quote.join(" ").trim();
    const isInterp = /^\*\*Interpretation/i.test(text);
    const interpretation = isInterp ? text.replace(/^\*\*Interpretation[^*]*\*\*:?\s*/i, "").trim() : "";
    out.push({
      path: target,
      caption: m[1] || path.basename(target),
      kind: assetKind(target),
      interpretation,
      interpretationAvailable: !!interpretation && !/^interpretation unavailable/i.test(interpretation),
    });
  }
  return out;
}

/** The canonical block an ingest agent writes into a chapter (FR-021). */
function assetBlockMarkdown({ assetPath, caption, interpretation }) {
  const text = interpretation && interpretation.trim()
    ? interpretation.trim().replace(/\n+/g, " ")
    : "Interpretation unavailable — the asset could not be downloaded or interpreted at ingest.";
  return `![${caption || path.basename(assetPath)}](${assetPath})\n\n> **Interpretation (LLM, at ingest):** ${text}\n`;
}

// ════════════════════════════════════════════════════════════════════════
//  THE DERIVED LAYER (T005): classify -> model -> concept-index.md + toc/
// ════════════════════════════════════════════════════════════════════════

/**
 * The `person_terms` frontmatter array (ADR-011) — a PARALLEL sibling of
 * `concepts`, same shape (an array of strings), read from the very same
 * chapter/document-stub files the concept terms are read from. Two
 * differences from `concepts`:
 *
 *   • ORIGINAL CASE SURVIVES. A person's name is a display name ("Diego
 *     Córdoba"); only the derivation key and the search match are
 *     lowercased, so the index can show the name as the source wrote it.
 *   • It is never written by this module. The shallow-merge write path
 *     preserves it verbatim (NFR-005) — ingest authors it, `rebuildIndex`
 *     derives `kind` from it, and nothing in between rewrites it (the one
 *     exception is `mergeConcepts`, which canonicalizes names).
 */
function personTermList(fm) {
  const byKey = new Map();
  for (const raw of Array.isArray(fm.person_terms) ? fm.person_terms : []) {
    const name = String(raw).trim();
    if (!name) continue;
    if (!byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  }
  return Array.from(byKey.values());
}

/**
 * Walk every concept file once and classify it into documents + chapters.
 *
 * Redesigned bundles are unambiguous: `type: document` is a document stub,
 * `type: section` (or anything carrying `parent`) is a chapter.
 *
 * PRE-REDESIGN bundles (design.md Risk #9 / plan.md "Upgrade path") carry
 * none of `parent`/`concepts`/`summary` — the old model stored
 * `title`/`status`/`verified`/`sources`. Those are handled BEST-EFFORT and
 * NON-DESTRUCTIVELY: a legacy concept nested under a prefix (`ai/attention`)
 * is read as a chapter of the document `ai`; a flat legacy concept is read as
 * a document with no chapters. Its concept terms come from whatever the file
 * actually has (`concepts`, else `tags`, else `topics`), its description from
 * `summary`, else `description`, else the first line of prose. Nothing is
 * rewritten, and `needsRegeneration` is reported so the Health tab can say
 * "this index is partial — re-ingest or upsert to complete it" instead of
 * pretending the bundle is fully routed.
 */
async function classifyBundle(bDir) {
  const ids = await listConceptIds(bDir);
  const now = Date.now();
  const documents = new Map();
  const chapters = [];
  const parsedById = new Map();
  let legacyChapters = 0;

  for (const id of ids) {
    const parsed = await readConceptRaw(bDir, id);
    if (!parsed) continue;
    parsedById.set(id, parsed);
  }

  // pass 1 — explicit document stubs
  for (const [id, parsed] of parsedById) {
    if (parsed.frontmatter.type === "document") {
      documents.set(id, {
        id,
        title: parsed.frontmatter.title || id,
        summary: parsed.frontmatter.summary || firstProse(parsed.body),
        sources: Array.isArray(parsed.frontmatter.sources) ? parsed.frontmatter.sources : [],
        updatedAt: parsed.frontmatter.updated_at || null,
        // the AUTHOR rides here (ADR-011): a document-level person term
        personTerms: personTermList(parsed.frontmatter),
        frontmatter: parsed.frontmatter,
        legacy: false,
      });
    }
  }

  // pass 2 — chapters (explicit, then best-effort legacy)
  for (const [id, parsed] of parsedById) {
    const fm = parsed.frontmatter;
    if (fm.type === "document") continue;

    const explicit = fm.type === "section" || typeof fm.parent === "string";
    const slashIdx = id.lastIndexOf("/");
    const inferredParent = slashIdx > 0 ? id.slice(0, slashIdx) : null;
    const docId = typeof fm.parent === "string" && fm.parent ? fm.parent : inferredParent;
    const legacy = !explicit;

    if (!docId) {
      // a flat, typeless legacy concept: it IS the document, with no chapters
      if (!documents.has(id)) {
        documents.set(id, {
          id,
          title: fm.title || id,
          summary: fm.summary || fm.description || firstProse(parsed.body),
          sources: Array.isArray(fm.sources) ? fm.sources : [],
          updatedAt: fm.updated_at || null,
          personTerms: personTermList(fm),
          frontmatter: fm,
          legacy: true,
        });
      }
      continue;
    }

    if (legacy) legacyChapters++;
    const terms = (Array.isArray(fm.concepts) ? fm.concepts : Array.isArray(fm.tags) ? fm.tags : Array.isArray(fm.topics) ? fm.topics : [])
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean);
    const summary = fm.summary || fm.description || firstProse(parsed.body);

    chapters.push({
      id,
      docId,
      chId: id.slice(docId.length + 1) || id,
      title: fm.title || id,
      summary,
      concepts: Array.from(new Set(terms)),
      // named key figures the chapter is ABOUT (ADR-011) — parallel to
      // `concepts`, never merged into it
      personTerms: personTermList(fm),
      status: fm.status || "draft",
      stale: isStale(fm, now),
      updatedAt: fm.updated_at || null,
      sources: Array.isArray(fm.sources) ? fm.sources : [],
      legacy,
      frontmatter: fm,
      body: parsed.body,
    });

    // a chapter whose document stub is missing still gets a synthetic document
    // (never written to disk) so the TOC and graph are not silently incomplete
    if (!documents.has(docId)) {
      documents.set(docId, {
        id: docId, title: docId, summary: "", sources: [], updatedAt: null,
        personTerms: [], frontmatter: {}, legacy: true, synthetic: true,
      });
    }
  }

  const needsRegeneration = chapters.some((c) => c.legacy || !c.concepts.length || !c.summary);
  return { documents, chapters, legacyChapters, needsRegeneration, ids };
}

/**
 * Level 1 — the O(V) routing table, keyed by DISTINCT TERM (FR-011/SC-006).
 *
 * Every term carries a `kind` (ADR-011): `person` iff its lowercased name
 * appears in ANY `person_terms` array in the bundle — a chapter stub's (a
 * named key figure) or a document stub's (the author) — else `topic`. The
 * kind is DERIVED here on every rebuild and nowhere else, so it cannot rot
 * out of sync with the frontmatter it comes from (NFR-004). A person term is
 * an ordinary term in every other respect: same row, same `covers`, same
 * search path (SC-016 — `okf_search` has no person case at all).
 */
function buildConceptIndex(classified) {
  // lowercased key -> original-case display name. First spelling seen wins,
  // so "Diego Córdoba" survives the rebuild as written (S1).
  const personNames = new Map();
  const registerPersons = (names) => {
    for (const name of names || []) {
      const key = name.toLowerCase();
      if (!personNames.has(key)) personNames.set(key, name);
    }
  };
  for (const doc of classified.documents.values()) registerPersons(doc.personTerms);
  for (const ch of classified.chapters) registerPersons(ch.personTerms);

  const byTerm = new Map(); // lowercased key -> covers[]
  const seenCover = new Map(); // lowercased key -> Set("<docId>/<chId>")
  const addCover = (rawTerm, cover) => {
    const key = String(rawTerm).toLowerCase();
    if (!byTerm.has(key)) {
      byTerm.set(key, []);
      seenCover.set(key, new Set());
    }
    const coverKey = `${cover.docId}/${cover.chId}`;
    // a name listed in BOTH `concepts` and `person_terms` covers once
    if (seenCover.get(key).has(coverKey)) return;
    seenCover.get(key).add(coverKey);
    byTerm.get(key).push(cover);
  };

  for (const ch of classified.chapters) {
    const doc = classified.documents.get(ch.docId);
    const cover = {
      docId: ch.docId,
      docTitle: (doc && doc.title) || ch.docId,
      chId: ch.chId,
      chTitle: ch.title,
      description: ch.summary || "",
      status: ch.status,
      stale: ch.stale,
    };
    for (const term of ch.concepts) addCover(term, cover);
    // a chapter's key figures are covered EXACTLY like its topics
    for (const person of ch.personTerms || []) addCover(person, cover);
  }

  // The author is registered on the DOCUMENT stub, so their coverage is the
  // document itself — an empty `chId` marks a document-level row, which is
  // what `core.graph` turns into the `doc -> person` coverage edge.
  for (const doc of classified.documents.values()) {
    for (const person of doc.personTerms || []) {
      addCover(person, {
        docId: doc.id,
        docTitle: doc.title,
        chId: "",
        chTitle: doc.title,
        description: doc.summary || "",
        status: "stable",
        stale: false,
      });
    }
  }

  return Array.from(byTerm.keys())
    .sort()
    .map((key) => {
      const covers = byTerm.get(key).sort((a, b) => (a.docId + a.chId).localeCompare(b.docId + b.chId));
      const person = personNames.has(key);
      return {
        name: person ? personNames.get(key) : key,
        kind: person ? "person" : "topic",
        count: covers.length,
        covers,
        stale: covers.some((c) => c.stale || c.status === "deprecated"),
      };
    });
}

/** Level 2 — one document's chapter listing. */
function buildToc(classified, docId) {
  const doc = classified.documents.get(docId);
  const chapters = classified.chapters
    .filter((c) => c.docId === docId)
    .sort((a, b) => a.chId.localeCompare(b.chId))
    .map((c) => ({ id: c.chId, title: c.title, summary: c.summary || "", concepts: c.concepts, status: c.status }));
  return { docId, docTitle: (doc && doc.title) || docId, chapters };
}

function conceptIndexMarkdown(bundleName, terms, stampIso) {
  const fm = { type: "concept-index", bundle: bundleName, terms, index_generated_at: stampIso };
  const lines = [
    `# Concept Index — ${bundleName}`,
    "",
    "*Derived from chapter frontmatter. Regenerable; **not** the source of truth —",
    "rebuild it any time with `okf_lint` or any concept write.*",
    "",
  ];
  if (!terms.length) {
    lines.push("_No concept terms yet. Ingest a document, or upsert a chapter with a `concepts` array._");
  }
  for (const t of terms) {
    lines.push(`- **${t.name}** — ${t.count} chapter${t.count === 1 ? "" : "s"}`);
    for (const c of t.covers) {
      lines.push(`  - \`${c.docTitle}\` › *${c.chTitle}* — ${c.description || "_no description_"}`);
    }
  }
  return stringifyDocument(fm, lines.join("\n") + "\n");
}

function tocMarkdown(toc, stampIso) {
  const fm = {
    type: "toc",
    document: toc.docId,
    title: toc.docTitle,
    index_generated_at: stampIso,
    updated: stampIso,
    chapters: toc.chapters,
  };
  const lines = [`# ${toc.docTitle} — Contents`, ""];
  if (!toc.chapters.length) lines.push("_This document has no chapters yet._");
  toc.chapters.forEach((c, i) => {
    const tags = c.concepts.length ? " · " + c.concepts.map((t) => `\`${t}\``).join(" ") : "";
    lines.push(`${i + 1}. **${c.title}** — ${c.summary || "_no description_"}${tags}`);
  });
  return stringifyDocument(fm, lines.join("\n") + "\n");
}

function bundleIndexMarkdown(bundleName, title, description, classified, terms) {
  const lines = [`# ${title || bundleName}`, ""];
  if (description) lines.push(description, "");
  lines.push("## Documents", "");
  if (!classified.documents.size) lines.push("_No documents yet._");
  for (const doc of classified.documents.values()) {
    const n = classified.chapters.filter((c) => c.docId === doc.id).length;
    lines.push(`- [${doc.title}](concepts/${doc.id}.md) — ${n} chapter${n === 1 ? "" : "s"}${doc.summary ? ` · ${doc.summary}` : ""}`);
  }
  lines.push("", "## Concepts covered", "");
  lines.push(terms.length ? terms.map((t) => `\`${t.name}\``).join(" · ") : "_No concept terms yet._");
  lines.push("", "*The authoritative routing table is [`concept-index.md`](concept-index.md); this overview is derived from it.*");
  return lines.join("\n") + "\n";
}

/**
 * Rebuild BOTH derived levels from canonical content and write them to disk.
 * Called from every write path that can change them (upsert/delete/merge/
 * link/import) and from the read-through cache when drift is detected, so
 * neither artifact can silently rot (FR-009 / NFR-004).
 */
async function rebuildDerived(bundleRoot, bundleName) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const classified = await classifyBundle(bDir);
  const terms = buildConceptIndex(classified);
  const stamp = nowIso();

  await vfs.writeText(safeJoin(bDir, "concept-index.md"), conceptIndexMarkdown(bundleName, terms, stamp));

  const tocDir = safeJoin(bDir, "toc");
  const tocByDoc = new Map();
  for (const docId of classified.documents.keys()) {
    const toc = buildToc(classified, docId);
    tocByDoc.set(docId, toc);
    await vfs.writeText(safeJoin(tocDir, `${docId}.md`), tocMarkdown(toc, stamp));
  }
  // prune TOC files for documents that no longer exist (a derived artifact
  // must never outlive its content — the "dangling row" okf_lint reports)
  const stale = await vfs.list(tocDir).catch(() => []);
  for (const e of stale) {
    if (e.type === "dir" || !e.name.endsWith(".md")) continue;
    const docId = e.name.slice(0, -3);
    if (!tocByDoc.has(docId)) await vfs.remove(path.join(tocDir, e.name)).catch(() => {});
  }

  // index.md stays a human entry point, refreshed from the same pass
  const existingIndex = await vfs.readText(safeJoin(bDir, "index.md")).catch(() => "");
  const titleMatch = /^#\s+(.+)$/m.exec(existingIndex);
  await vfs.writeText(
    safeJoin(bDir, "index.md"),
    bundleIndexMarkdown(bundleName, titleMatch ? titleMatch[1] : bundleName, "", classified, terms),
  );

  const model = {
    bundle: bundleName,
    terms,
    tocByDoc,
    classified,
    indexGeneratedAt: stamp,
    needsRegeneration: classified.needsRegeneration,
  };
  derivedCache.set(bDir, { model, builtAt: Date.now() });
  return model;
}

/** Newest chapter `updated_at` in the bundle — the staleness comparison point. */
function newestChapterStamp(classified) {
  let newest = 0;
  for (const c of classified.chapters) {
    const t = Date.parse(c.updatedAt || "");
    if (!Number.isNaN(t) && t > newest) newest = t;
  }
  return newest;
}

/**
 * Read-through access to the derived model.
 *
 * Order: in-memory cache -> the stored `concept-index.md` (if its
 * `index_generated_at` is not older than the newest chapter write) -> a full
 * rebuild. A pre-redesign bundle with no `concept-index.md` at all lands in
 * the rebuild branch, which is exactly the self-healing upgrade path.
 */
async function getModel(bundleRoot, bundleName, { allowRebuild = true } = {}) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const cached = derivedCache.get(bDir);
  if (cached) return cached.model;

  const raw = await vfs.readText(safeJoin(bDir, "concept-index.md")).catch(() => null);
  if (raw) {
    const { frontmatter } = parseFrontmatter(raw);
    const stamp = Date.parse(frontmatter.index_generated_at || "");
    if (frontmatter.type === "concept-index" && !Number.isNaN(stamp)) {
      const classified = await classifyBundle(bDir);
      if (newestChapterStamp(classified) <= stamp) {
        const tocByDoc = new Map();
        for (const docId of classified.documents.keys()) tocByDoc.set(docId, buildToc(classified, docId));
        // Trust the stored terms only if they actually survived the
        // round-trip in the shape search depends on; otherwise derive. A
        // hand-edited or third-party-written index can't mis-route queries.
        const storedTerms = Array.isArray(frontmatter.terms) ? frontmatter.terms : null;
        const usable =
          storedTerms !== null &&
          storedTerms.every((t) => t && typeof t.name === "string" && Array.isArray(t.covers));
        const model = {
          bundle: bundleName,
          // A pre-person-kind index carries no `kind` on its terms. Default
          // it to `topic` right here (ADR-011 S4) so a legacy bundle is
          // served correctly off the fast path — no migration, no forced
          // rebuild, and nothing downstream ever sees `kind: undefined`.
          terms: usable ? storedTerms.map((t) => ({ ...t, kind: t.kind || "topic" })) : buildConceptIndex(classified),
          tocByDoc,
          classified,
          indexGeneratedAt: frontmatter.index_generated_at,
          needsRegeneration: classified.needsRegeneration,
        };
        derivedCache.set(bDir, { model, builtAt: Date.now() });
        return model;
      }
    }
  }
  if (!allowRebuild) {
    const classified = await classifyBundle(bDir);
    const tocByDoc = new Map();
    for (const docId of classified.documents.keys()) tocByDoc.set(docId, buildToc(classified, docId));
    return {
      bundle: bundleName,
      terms: buildConceptIndex(classified),
      tocByDoc,
      classified,
      indexGeneratedAt: null,
      needsRegeneration: classified.needsRegeneration,
    };
  }
  return rebuildDerived(bundleRoot, bundleName);
}

// ════════════════════════════════════════════════════════════════════════
//  RETRIEVAL (T006) — okf_search: ONE deterministic function, two surfaces
// ════════════════════════════════════════════════════════════════════════

function tokenize(query) {
  return String(query || "").toLowerCase().split(/[^\w-]+/).filter(Boolean);
}

/**
 * Concept-anchored search over the Level-1 index (design.md §6.1).
 *
 * NO LLM IS IN THIS MATCH. It is a lookup: tokenize, match tokens against
 * concept-term names and the one-line descriptions the index carries, collect
 * the covering chapters, rank, return TOC rows. The LLM does the *routing*
 * (deciding what to ask) and the *synthesis* (reading the full chapters it
 * then fetches) — this is the deterministic bridge between the two.
 *
 * Because the pass is over `terms` (distinct vocabulary), its cost is bounded
 * by V, not by the document or chapter count (NFR-011 / SC-006).
 *
 * The SAME function backs the `okf_search` tool and the app's
 * `/bundles/<b>/search` route, so the two can never diverge (FR-036/FR-043).
 * Ranking is fully deterministic — ties break on (docId, chId) — so the same
 * query against an unchanged bundle always returns byte-identical rows.
 */
function searchIndex(terms, query, limit = 25) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const rows = [];
  const seen = new Map(); // docId/chId -> row index (a chapter appears once)

  for (const term of terms) {
    const name = String(term.name || "").toLowerCase();
    const termTokens = tokens.filter((tok) => name.includes(tok));
    const termHit = termTokens.length > 0;
    for (const cov of term.covers || []) {
      const desc = String(cov.description || "").toLowerCase();
      const descTokens = tokens.filter((tok) => desc.includes(tok));
      if (!termHit && !descTokens.length) continue;
      const key = `${cov.docId}/${cov.chId}`;
      const matchedTokens = new Set([...termTokens, ...descTokens]);
      const candidate = {
        docId: cov.docId,
        docTitle: cov.docTitle,
        chId: cov.chId,
        chTitle: cov.chTitle,
        description: cov.description || "",
        matchedConcept: term.name,
        // additive (ADR-011): WHICH KIND of term matched. The algorithm
        // above is untouched — a person's name is an ordinary term-name hit.
        kind: term.kind || "topic",
        status: cov.status || "draft",
        stale: !!cov.stale,
        _tier: termHit ? 0 : 1, // a term-name match outranks a description-only match
        _tokens: matchedTokens.size,
      };
      if (!seen.has(key)) {
        seen.set(key, rows.length);
        rows.push(candidate);
      } else {
        // the same chapter reached via a second term: keep the stronger match,
        // so `matchedConcept` always names the reason the row ranks where it does
        const existing = rows[seen.get(key)];
        if (candidate._tier < existing._tier || (candidate._tier === existing._tier && candidate._tokens > existing._tokens)) {
          rows[seen.get(key)] = candidate;
        }
      }
    }
  }

  rows.sort((a, b) => {
    if (a._tier !== b._tier) return a._tier - b._tier;
    if (a._tokens !== b._tokens) return b._tokens - a._tokens;
    if (a.docId !== b.docId) return a.docId < b.docId ? -1 : 1;
    return a.chId < b.chId ? -1 : a.chId > b.chId ? 1 : 0;
  });

  const n = Number.isFinite(limit) && limit > 0 ? limit : 25;
  // Empty is a valid answer (spec Edge Cases): never invent a row.
  return rows.slice(0, n).map(({ _tier, _tokens, ...row }) => row);
}

async function search(bundleRoot, bundleName, query, limit) {
  const model = await getModel(bundleRoot, bundleName);
  return searchIndex(model.terms, query, limit);
}

// ── derived read views (design.md §6.2) ──────────────────────────────────

async function readToc(bundleRoot, bundleName, docId) {
  validateConceptId(docId);
  const model = await getModel(bundleRoot, bundleName);
  const toc = model.tocByDoc.get(docId);
  if (!toc) throw new Error(`document not found: ${bundleName}/${docId}`);
  return { ...toc, indexGeneratedAt: model.indexGeneratedAt, artifact: `toc/${docId}.md` };
}

/**
 * Full read of one concept — document stub or chapter (FR-003/FR-005).
 * Returns the ENTIRE body. There is no truncation, no snippet, no chunk
 * anywhere on this path; `assets` surfaces the stored inline-asset blocks
 * (link + interpretation) the body already carries, so the caller gets the
 * asset's knowledge without re-running vision (FR-023).
 */
async function readConcept(bundleRoot, bundleName, id) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const parsed = await readConceptRaw(bDir, id);
  if (!parsed) throw new Error(`concept not found: ${bundleName}/${id}`);
  const fm = parsed.frontmatter;
  const type = fm.type === "document" ? "document" : fm.type === "section" || fm.parent ? "section" : "concept";
  return {
    id,
    type,
    frontmatter: fm,
    body: parsed.body, // FULL text — never a snippet (NFR-003 / SC-001)
    links: extractLinks(parsed.body),
    assets: extractAssets(parsed.body),
    source: documentSource(fm),
  };
}

/** The honest "where did this come from" target (FR-043): URL, else raw/ path. */
function documentSource(frontmatter) {
  const sources = Array.isArray(frontmatter && frontmatter.sources) ? frontmatter.sources : [];
  for (const s of sources) {
    if (s && typeof s.uri === "string" && /^https?:\/\//i.test(s.uri)) return { kind: "url", target: s.uri };
    if (s && typeof s.url === "string" && /^https?:\/\//i.test(s.url)) return { kind: "url", target: s.url };
  }
  for (const s of sources) {
    if (s && typeof s.uri === "string" && s.uri) return { kind: "raw", target: s.uri };
  }
  return null;
}

/** The concept VOCABULARY with per-term chapter counts (FR-006). */
async function listConcepts(bundleRoot, bundleName, { type, status, kind } = {}) {
  const model = await getModel(bundleRoot, bundleName);
  // `kind` is an OPTIONAL filter (ADR-011): "topic" | "person" | "all"
  // (anything else, including the default, means all).
  const wantKind = kind === "topic" || kind === "person" ? kind : null;
  let terms = model.terms
    .filter((t) => !wantKind || (t.kind || "topic") === wantKind)
    .map((t) => ({
      term: t.name,
      kind: t.kind || "topic",
      count: t.count,
      covers: t.covers
        .filter((c) => !status || c.status === status)
        .map((c) => ({ docId: c.docId, chId: c.chId, title: c.chTitle, description: c.description, status: c.status })),
    }));
  if (status) terms = terms.map((t) => ({ ...t, count: t.covers.length })).filter((t) => t.count > 0);

  const documents = Array.from(model.classified.documents.values()).map((d) => ({
    id: d.id,
    title: d.title,
    summary: d.summary,
    chapters: model.classified.chapters.filter((c) => c.docId === d.id).length,
  }));
  const chapters = model.classified.chapters
    .filter((c) => !status || c.status === status)
    .map((c) => ({ id: c.id, docId: c.docId, title: c.title, summary: c.summary, concepts: c.concepts, status: c.status, stale: c.stale }));

  if (type === "document") return { terms: [], documents, chapters: [] };
  if (type === "section" || type === "chapter") return { terms: [], documents: [], chapters };
  return { terms, documents, chapters, indexGeneratedAt: model.indexGeneratedAt, needsRegeneration: model.needsRegeneration };
}

// ── graph derivation (ADR-004) — computed ON READ, never stored ──────────

async function readLinksSidecar(bDir) {
  const raw = await vfs.readText(safeJoin(bDir, "links.json")).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => e && e.from && e.to) : [];
  } catch {
    return [];
  }
}

async function writeLinksSidecar(bDir, edges) {
  await vfs.writeText(safeJoin(bDir, "links.json"), JSON.stringify(edges, null, 2) + "\n");
}

/**
 * The bundle's knowledge graph (FR-042/FR-045): nodes for documents,
 * chapters and concept terms; typed DIRECTED edges for containment
 * (document -> chapter, from `parent`), coverage (chapter -> concept term,
 * from the concept index) and explicit links (okf_add_link).
 *
 * Nothing here is stored. Deriving on read is what keeps the graph from
 * becoming the second thing you have to keep in sync (the problem NFR-004
 * exists to kill) — it walks the same frontmatter the index already read.
 */
async function graph(bundleRoot, bundleName) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const model = await getModel(bundleRoot, bundleName);
  const nodes = [];
  const edges = [];
  const present = new Set();

  for (const doc of model.classified.documents.values()) {
    nodes.push({ id: doc.id, key: `doc:${doc.id}`, type: "doc", label: doc.title, description: doc.summary || "" });
    present.add(doc.id);
  }
  for (const ch of model.classified.chapters) {
    nodes.push({ id: ch.id, key: `chap:${ch.id}`, type: "chap", label: ch.title, description: ch.summary || "", docId: ch.docId, chId: ch.chId, status: ch.status });
    present.add(ch.id);
    edges.push({ from: ch.docId, to: ch.id, kind: "containment", label: "contains" });
  }
  for (const term of model.terms) {
    // The 4th node category (ADR-011/FR-054): a person-kind term is its own
    // type so the renderer can colour it, but it is NOT a new shape — same
    // count-driven radius, same `coverage` edge kind as a topic term. Its
    // `id` is the lowercased name (the app's maps key on it); its `label`
    // keeps the original case for display.
    const person = term.kind === "person";
    const type = person ? "person" : "concept";
    const id = person ? String(term.name).toLowerCase() : term.name;
    nodes.push({
      id,
      key: `${type}:${id}`,
      type,
      label: term.name,
      count: term.count,
      description: `${person ? "person · covers" : "covers"} ${term.count} chapter${term.count === 1 ? "" : "s"}`,
    });
    present.add(id);
    for (const cov of term.covers) {
      // an empty `chId` is a DOCUMENT-level cover (the author) — the edge
      // then runs doc -> person instead of chap -> person
      edges.push({ from: cov.chId ? `${cov.docId}/${cov.chId}` : cov.docId, to: id, kind: "coverage", label: "covers" });
    }
  }
  for (const e of await readLinksSidecar(bDir)) {
    edges.push({ from: e.from, to: e.to, kind: "link", label: e.label || "related" });
  }

  return {
    bundle: bundleName,
    nodes,
    edges: edges.filter((e) => present.has(e.from) && present.has(e.to)),
    indexGeneratedAt: model.indexGeneratedAt,
  };
}

// ════════════════════════════════════════════════════════════════════════
//  BUNDLES
// ════════════════════════════════════════════════════════════════════════

/**
 * Create the conformant layout (FR-028 / T012). Note what is NOT here:
 * `schema.md`. Bundle conventions now live in the item's `okf-bundle-schema`
 * SKILL (ADR-007), so there is no per-bundle convention file to drift and no
 * `okf_read_bundle_schema` tool. A bundle MAY still carry its own schema.md
 * — the skill says the bundle's voice wins — it just isn't created here.
 */
async function initBundle(bundleRoot, name, opts = {}) {
  const bDir = bundleDir(bundleRoot, name);
  if (await vfs.exists(bDir)) {
    // A directory with neither `index.md` nor `concepts/` is not a bundle —
    // `listBundles` uses exactly that test to decide what counts, and never
    // lists it. It is the husk of a failed delete or a half-finished init, so
    // clear it and carry on: a name the user just deleted must be reusable.
    // A real bundle still refuses — deleting it stays the user's explicit call.
    const populated =
      (await vfs.exists(path.join(bDir, "index.md"))) || (await vfs.exists(path.join(bDir, "concepts")));
    if (populated) throw new Error(`bundle already exists: ${name}`);
    await vfs.remove(bDir);
    graphCache.delete(bDir);
    derivedCache.delete(bDir);
    if (await vfs.exists(bDir)) {
      throw new Error(`incomplete bundle directory could not be removed — retry: ${name}`);
    }
  }
  const title = opts.title || name;
  const description = opts.description || "";
  await vfs.mkdir(path.join(bDir, "raw"));
  await vfs.mkdir(path.join(bDir, "raw", "assets"));
  await vfs.mkdir(path.join(bDir, "concepts"));
  await vfs.mkdir(path.join(bDir, "toc"));
  await vfs.writeText(path.join(bDir, "index.md"), `# ${title}\n\n${description}\n\n## Documents\n\n_No documents yet._\n`);
  await vfs.writeText(path.join(bDir, "log.md"), `# Log — ${title}\n`);
  await writeLinksSidecar(bDir, []);
  await vfs.writeText(path.join(bDir, "raw", "sources.json"), JSON.stringify({ sources: {} }, null, 2) + "\n");
  markGraphDirty(bDir);
  await rebuildDerived(bundleRoot, name);
  await appendLog(bundleRoot, name, { event: "bundle_init", message: `bundle "${name}" created` });
  return bundleHealth(bundleRoot, name);
}

/** Per-bundle health (FR-027): the Overview stat cards + the list row. */
async function bundleHealth(bundleRoot, name, { allowRebuild = true } = {}) {
  const model = await getModel(bundleRoot, name, { allowRebuild });
  const chapters = model.classified.chapters;
  const stale = chapters.filter((c) => c.stale).length;
  const deprecated = chapters.filter((c) => c.status === "deprecated").length;
  return {
    name,
    docs: model.classified.documents.size,
    chapters: chapters.length,
    conceptTerms: model.terms.length,
    stale,
    deprecated,
    status: stale + deprecated === 0 ? "healthy" : "attention",
    indexGeneratedAt: model.indexGeneratedAt,
    indexNeedsRegeneration: model.needsRegeneration,
    checkedAt: nowIso(),
  };
}

async function listBundles(bundleRoot) {
  await vfs.mkdir(bundleRoot).catch(() => {});
  const entries = await vfs.list(bundleRoot).catch(() => []);
  const bundles = [];
  for (const e of entries) {
    if (e.type !== "dir" || e.name.startsWith(".")) continue;
    const bDir = path.join(bundleRoot, e.name);
    if (!(await vfs.exists(path.join(bDir, "index.md"))) && !(await vfs.exists(path.join(bDir, "concepts")))) continue;
    bundles.push(await bundleHealth(bundleRoot, e.name));
  }
  return bundles;
}

/** Bundle detail for the app's Overview tab (design.md §8.3). */
async function bundleDetail(bundleRoot, name) {
  const model = await getModel(bundleRoot, name);
  const health = await bundleHealth(bundleRoot, name);
  const documents = Array.from(model.classified.documents.values()).map((d) => {
    const chs = model.classified.chapters.filter((c) => c.docId === d.id);
    return {
      id: d.id,
      title: d.title,
      summary: d.summary,
      chapters: chs.length,
      conceptRefs: chs.reduce((n, c) => n + c.concepts.length, 0),
      updated: d.updatedAt || (chs.map((c) => c.updatedAt).filter(Boolean).sort().pop() || null),
      needsAttention: chs.some((c) => c.stale || c.status === "deprecated"),
      source: documentSource(d.frontmatter),
    };
  });
  return { health, documents, conceptIndex: model.terms, indexGeneratedAt: model.indexGeneratedAt };
}

/**
 * Export a spec-conformant OKF bundle (FR-029 / SC-004). The derived
 * artifacts are rebuilt first and then included, so the export always carries
 * a CORRECT concept-index.md and every toc/<docId>.md — re-importing it
 * reproduces a fully queryable bundle with no regeneration step.
 *
 * Binary inline assets under raw/assets/ are listed with their path and byte
 * size but not inlined into the JSON manifest (a base64 video in a REST
 * response would be the wrong shape); the directory itself is part of the
 * on-disk bundle and travels with a directory/tarball copy.
 */
async function exportBundle(bundleRoot, name) {
  const bDir = bundleDir(bundleRoot, name);
  if (!(await vfs.exists(bDir))) throw new Error(`bundle not found: ${name} — create it first with okf_init_bundle({name: "${name}"})`);
  await rebuildDerived(bundleRoot, name);
  const files = [];
  const assets = [];
  async function walk(dir, rel) {
    const entries = await vfs.list(dir).catch(() => []);
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.type === "dir") {
        // .chunks/ is OPERATIONAL (ADR-012), like .jobs/: a mechanical
        // pre-split of a source that is already in raw/ byte-exact. Exporting
        // it would double the size of every export for nothing and would
        // re-import as content.
        if (!rel && e.name === CHUNKS_DIR) continue;
        await walk(abs, relPath);
        continue;
      }
      if (relPath.startsWith("raw/assets/")) {
        assets.push({ path: relPath, bytes: e.size || null, contentType: assetContentType(relPath) });
        continue;
      }
      files.push({ path: relPath, content: await vfs.readText(abs) });
    }
  }
  await walk(bDir, "");
  const hasIndex = files.some((f) => f.path === "concept-index.md");
  const tocCount = files.filter((f) => f.path.startsWith("toc/")).length;
  return { name, files, assets, conformant: hasIndex, conceptIndexIncluded: hasIndex, tocsIncluded: tocCount };
}

/** The concept id a bundle-relative file path will be LISTED under, else null. */
function conceptIdForRelPath(relPath) {
  const rel = String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!rel.startsWith("concepts/") || !rel.endsWith(".md")) return null;
  return rel.slice("concepts/".length, -3) || null;
}

// How long an import waits for its own writes to become listable. Ten tries
// at 75ms is ~0.7s worst case on a bundle that never converges, and zero
// extra wait on the normal path (attempt 1 already sees everything).
const LISTING_SETTLE_ATTEMPTS = 10;
const LISTING_SETTLE_DELAY_MS = 75;

/**
 * Wait until `concepts/` LISTS every concept file the caller just wrote.
 *
 * A bulk import writes N files through /api/fs and then classifies the
 * bundle by LISTING that directory (classifyBundle -> listConceptIds). The
 * write and the listing are two different operations over the VFS HTTP API,
 * and immediately after a burst of writes the listing can still be missing
 * just-written entries — so the rebuild classifies a SUBSET of the bundle
 * and stores a concept-index.md that is permanently short of the document
 * stubs it never saw (their `person_terms` with it).
 *
 * This is not a blind retry of a failed call and not a fixed sleep: it polls
 * the SAME listing path classifyBundle uses until the listing is a superset
 * of the known-written set, which is a verifiable snapshot-consistency
 * condition. On the normal path it costs exactly one extra list; it exits the
 * instant the listing agrees with the writes.
 */
async function settleConceptListing(bDir, expectedIds, {
  attempts = LISTING_SETTLE_ATTEMPTS,
  delayMs = LISTING_SETTLE_DELAY_MS,
} = {}) {
  if (!expectedIds || !expectedIds.size) return { settled: true, attempts: 0, missing: [] };
  let missing = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const listed = new Set(await listConceptIds(bDir));
    missing = Array.from(expectedIds).filter((id) => !listed.has(id));
    if (!missing.length) return { settled: true, attempts: attempt, missing: [] };
    if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { settled: false, attempts, missing };
}

/**
 * Import a bundle (FR-029). Two vectors, both of which the worker can
 * actually perform (design.md Risk #7 is resolved here):
 *   • `files`      — a flat {path, content} manifest (what the app POSTs and
 *                    what okf_export_bundle produces: a clean round-trip).
 *   • `sourcePath` — a VFS directory already on disk, which this walks.
 * Git/tarball acquisition is the calling assistant's job (it has the tools;
 * the worker has no shell) — it stages the directory, then imports by path.
 *
 * Whatever arrives, the derived index is rebuilt BEST-EFFORT afterwards and
 * the result reports `indexNeedsRegeneration` when the imported chapters
 * don't carry enough frontmatter for a full two-level index (a pre-redesign
 * bundle). Non-destructive and reported — never a silent overwrite, never a
 * silent partial index.
 */
async function importBundle(bundleRoot, name, { files, sourcePath, rebuild = true } = {}) {
  const bDir = bundleDir(bundleRoot, name);
  await vfs.mkdir(bDir);
  let imported = 0;
  // every concept file this import writes, by the id `listConceptIds` will
  // report it under — the settle condition below is checked against this
  const expectedConceptIds = new Set();
  const expectConcept = (relPath) => {
    const id = conceptIdForRelPath(relPath);
    if (id) expectedConceptIds.add(id);
  };

  if (Array.isArray(files)) {
    for (const f of files) {
      if (!f || typeof f.path !== "string" || typeof f.content !== "string") continue;
      await vfs.writeText(safeJoin(bDir, f.path), f.content); // /api/fs write creates missing parents
      expectConcept(f.path);
      imported++;
    }
  } else if (typeof sourcePath === "string" && sourcePath) {
    async function copy(dir, rel) {
      const entries = await vfs.list(dir).catch(() => []);
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.type === "dir") {
          await copy(abs, relPath);
        } else if (relPath.startsWith("raw/assets/")) {
          const { buffer, contentType } = await vfs.readRaw(abs);
          await vfs.writeBinary(safeJoin(bDir, relPath), buffer, contentType);
          imported++;
        } else {
          await vfs.writeText(safeJoin(bDir, relPath), await vfs.readText(abs));
          expectConcept(relPath);
          imported++;
        }
      }
    }
    if (!(await vfs.exists(sourcePath))) throw new Error(`import source not found: ${sourcePath}`);
    await copy(sourcePath, "");
  } else {
    throw new Error("import needs either a `files` manifest or a `sourcePath` directory");
  }

  await vfs.mkdir(path.join(bDir, "raw"));
  await vfs.mkdir(path.join(bDir, "concepts"));
  markGraphDirty(bDir);
  // The rebuild below runs ONCE and is authoritative, so it has to see the
  // whole import. Make the directory listing agree with the writes first.
  const settle = rebuild
    ? await settleConceptListing(bDir, expectedConceptIds)
    : { settled: true, attempts: 0, missing: [] };
  const model = rebuild ? await rebuildDerived(bundleRoot, name) : { terms: [], needsRegeneration: true, builtAt: null };
  if (!settle.settled) {
    // Best-effort: the index was built from a listing we KNOW was short, so
    // drop the cached model and report it as needing regeneration rather
    // than serving a partial index as if it were complete.
    markGraphDirty(bDir);
  }
  const needsRegeneration = model.needsRegeneration || !settle.settled;
  await appendLog(bundleRoot, name, {
    event: "bundle_import",
    message: settle.settled
      ? `imported ${imported} file(s)`
      : `imported ${imported} file(s); concepts/ listing never caught up (missing ${settle.missing.length} after ${settle.attempts} attempts: ${settle.missing.slice(0, 5).join(", ")})`,
  });
  const health = await bundleHealth(bundleRoot, name, { allowRebuild: rebuild });
  return {
    ...health,
    imported,
    indexNeedsRegeneration: needsRegeneration,
    note: !settle.settled
      ? `Imported, but the bundle's concepts/ listing never caught up with the ${imported} file(s) written (still missing ${settle.missing.length} after ${settle.attempts} attempts). The derived index was rebuilt BEST-EFFORT from an incomplete view and is reported as needing regeneration — re-run the rebuild to complete it.`
      : model.needsRegeneration
        ? "Imported. The derived index was rebuilt BEST-EFFORT: some chapters lack `parent`/`concepts`/`summary` frontmatter, so routing for those is partial. Nothing was dropped or overwritten — re-ingest the sources, or upsert the missing frontmatter, to complete the index."
        : "Imported. The two-level derived index was rebuilt in full from the imported chapter frontmatter.",
  };
}

async function deleteBundle(bundleRoot, name) {
  const bDir = bundleDir(bundleRoot, name);
  if (!(await vfs.exists(bDir))) throw new Error(`bundle not found: ${name}`);
  await vfs.remove(bDir);
  // Caches go first, in both outcomes: whatever is left on disk, the in-memory
  // model of it is stale either way.
  graphCache.delete(bDir);
  derivedCache.delete(bDir);
  // /api/fs's `delete` op can answer 200 without the directory actually being
  // gone (a racing writer, a mount boundary). Verify it, so a half-done delete
  // surfaces as an error the caller can retry rather than a `{deleted:true}`
  // that leaves a husk behind in the bundle root.
  if (await vfs.exists(bDir)) throw new Error(`bundle directory still exists after delete — retry: ${name}`);
  return { name, deleted: true };
}

// ════════════════════════════════════════════════════════════════════════
//  CONCEPTS (documents + chapters)
// ════════════════════════════════════════════════════════════════════════

/**
 * Create or update a concept file (FR-024). Frontmatter is MERGED ON FIELDS:
 * `{...existing, ...patch}`, so unknown keys survive every write verbatim
 * (NFR-005 / SC-005).
 *
 * This is also where lifecycle, trust and provenance are set. The redesign
 * removed `okf_set_status` / `okf_set_trust` / `okf_add_source` /
 * `okf_attest` / `okf_provenance` / `okf_get_as_of` as separate tools — their
 * CAPABILITY lives here, as ordinary frontmatter on this one call
 * (design.md §8.2 "removed"). `sources` and `attestations` are the two
 * array-valued fields where a naive shallow merge would silently discard
 * history, so they are merged by identity rather than replaced wholesale.
 *
 * Every successful write rebuilds the derived index + TOCs, so the routing
 * table can never lag the content that backs it (FR-015).
 */
async function upsertConcept(bundleRoot, bundleName, id, { title, body, frontmatter, sourceRange, interpretations } = {}) {
  const bDir = bundleDir(bundleRoot, bundleName);
  if (!(await vfs.exists(bDir))) throw new Error(`bundle not found: ${bundleName} — create it first with okf_init_bundle({name: "${bundleName}"})`);
  const existing = await readConceptRaw(bDir, id);
  const now = nowIso();
  const base = existing ? { ...existing.frontmatter } : { id, type: "section", title: title || id, status: "draft", created_at: now };
  const patch = { ...(frontmatter || {}) };
  if (title !== undefined) patch.title = title;

  if (Array.isArray(patch.sources) && Array.isArray(base.sources)) {
    const byKey = new Map(base.sources.filter(Boolean).map((s) => [s.id || s.uri, s]));
    for (const s of patch.sources) if (s) byKey.set(s.id || s.uri, { ...(byKey.get(s.id || s.uri) || {}), ...s });
    patch.sources = Array.from(byKey.values());
  }
  if (Array.isArray(patch.attestations) && Array.isArray(base.attestations)) {
    patch.attestations = [...base.attestations, ...patch.attestations];
  }
  if (Array.isArray(patch.concepts)) {
    patch.concepts = Array.from(new Set(patch.concepts.map((t) => String(t).trim().toLowerCase()).filter(Boolean)));
  }
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw new Error(`invalid status: ${patch.status} (expected ${STATUSES.join(" | ")})`);
  if (patch.verified !== undefined && patch.verified !== null && !TRUST_LEVELS.includes(patch.verified)) {
    throw new Error(`invalid verified value: ${patch.verified} (expected ${TRUST_LEVELS.join(" | ")})`);
  }

  const merged = { ...base, ...patch, id, updated_at: now };
  if (!merged.type) merged.type = merged.parent ? "section" : "document";
  if (merged.created_at === undefined) merged.created_at = base.created_at || now;

  // ── the body (ADR-014 D4 precedence) ─────────────────────────────────
  //
  //   sourceRange present -> the SERVICE extracts the body from raw/
  //                          (FR-060: the agent never re-emits the source);
  //   otherwise            -> `body` exactly as given (the original path,
  //                          untouched and still the whole contract for
  //                          every caller that does not pass a range).
  //
  // A range that cannot be resolved THROWS rather than falling back to the
  // passed body: silently writing a half-right chapter is the one outcome
  // worse than a failed write the agent can retry.
  let extraction = null;
  if (sourceRange) {
    const docId = String(id).split("/")[0];
    extraction = await chapterFromSourceRange(bDir, docId, sourceRange, interpretations, undefined);
  }

  const finalBody = extraction ? extraction.body : body !== undefined ? body : existing ? existing.body : `# ${merged.title || id}\n`;
  const raw = stringifyDocument(merged, finalBody);
  await vfs.writeText(conceptFilePath(bDir, id), raw);
  markGraphDirty(bDir);
  await rebuildDerived(bundleRoot, bundleName);
  await appendLog(bundleRoot, bundleName, {
    event: existing ? "concept_update" : "concept_create",
    conceptId: id,
    message: `${existing ? "updated" : "created"} ${merged.type} "${id}"`,
    at: now,
  });
  const written = await readConcept(bundleRoot, bundleName, id);
  // Say what was extracted, so the agent can SEE that the body it did not
  // send is the body that got written (and the e2e can assert the slice).
  return extraction
    ? {
        ...written,
        extraction: {
          sourceFile: extraction.sourceFile,
          start: extraction.start,
          end: extraction.end,
          chars: extraction.end - extraction.start,
          interpretations: extraction.placements,
        },
      }
    : written;
}

/**
 * Delete a concept file (FR-025). Non-destructive by default: only the file
 * itself goes; backlinking chapters are left exactly as they were, so a
 * delete never silently rewrites content the caller didn't ask to touch.
 * With `rewriteBacklinks`, every linker is rewritten to drop the reference.
 * The derived artifacts are rebuilt either way — a deleted chapter's rows
 * disappear from the index and its document's TOC with no hand-sync.
 */
async function deleteConcept(bundleRoot, bundleName, id, { rewriteBacklinks = false } = {}) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const p = conceptFilePath(bDir, id);
  if (!(await vfs.exists(p))) throw new Error(`concept not found: ${bundleName}/${id}`);
  await vfs.remove(p);
  markGraphDirty(bDir);

  let linkers = [];
  if (rewriteBacklinks) {
    const g = await ensureGraph(bDir);
    linkers = Array.from(g.backlinks.get(id) || []);
    for (const linkerId of linkers) await removeLinkFromBody(bundleRoot, bundleName, linkerId, id);
    const sidecar = (await readLinksSidecar(bDir)).filter((e) => e.from !== id && e.to !== id);
    await writeLinksSidecar(bDir, sidecar);
  }

  await rebuildDerived(bundleRoot, bundleName);
  await appendLog(bundleRoot, bundleName, {
    event: "concept_delete",
    conceptId: id,
    message: `deleted concept "${id}"${linkers.length ? ` and rewrote ${linkers.length} backlinking concept(s)` : ""}`,
  });
  return { id, deleted: true, rewroteBacklinks: rewriteBacklinks, backlinksRewritten: linkers };
}

/** Replace `fromKey` (a lowercased name) with `toDisplay` in a person_terms
 *  array, de-duplicating case-insensitively and preserving order. */
function rewritePersonTerms(list, fromKey, toDisplay) {
  const out = [];
  const seen = new Set();
  for (const p of list || []) {
    const next = p.toLowerCase() === fromKey ? toDisplay : p;
    const key = next.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}

/**
 * Merge concept term `from` into canonical term `to` (FR-026 / US6 / SC-008).
 *
 * A concept TERM is not a file — it's a key in the Level-1 index, derived
 * from chapter frontmatter. So the merge rewrites the one place terms are
 * actually authored: every chapter's `concepts` array — and, since ADR-011,
 * every chapter's and document stub's parallel `person_terms` array, because
 * a person term is a term too and its kind is derived from that array. The
 * concept index and every affected document TOC then follow from the rebuild,
 * which is the whole point of them being derived. A query that previously
 * matched either term now routes through the single canonical term to the
 * union of chapters.
 */
async function mergeConcepts(bundleRoot, bundleName, from, to) {
  const fromTerm = String(from || "").trim().toLowerCase();
  const toTerm = String(to || "").trim().toLowerCase();
  if (!fromTerm || !toTerm) throw new Error("both `from` and `to` concept terms are required");
  if (fromTerm === toTerm) throw new Error("`from` and `to` are the same term — nothing to merge");

  const bDir = bundleDir(bundleRoot, bundleName);
  const before = await getModel(bundleRoot, bundleName);
  // a person term's stored name keeps its original case, so the lookup (and
  // every comparison below) is on the lowercased key
  if (!before.terms.some((t) => String(t.name).toLowerCase() === fromTerm)) {
    throw new Error(`concept term not found in ${bundleName}: ${fromTerm}`);
  }

  // What to WRITE into a rewritten `person_terms`: the canonical term's own
  // display name when it already exists as a person, else the caller's `to`
  // spelling. (`concepts` stays lowercased, as it always was.)
  const toExisting = before.terms.find((t) => String(t.name).toLowerCase() === toTerm);
  const toDisplay = toExisting && toExisting.kind === "person" ? toExisting.name : String(to).trim();

  const rewritten = [];
  for (const ch of before.classified.chapters) {
    const hitsConcepts = ch.concepts.includes(fromTerm);
    // ADR-011 S3: a person term IS a term, so canonicalizing has to clear the
    // from-name out of the PARALLEL `person_terms` array as well — otherwise
    // the next rebuild would re-derive `kind: person` for a name nothing
    // routes to any more.
    const hitsPersons = (ch.personTerms || []).some((p) => p.toLowerCase() === fromTerm);
    if (!hitsConcepts && !hitsPersons) continue;
    const parsed = await readConceptRaw(bDir, ch.id);
    const merged = { ...parsed.frontmatter, updated_at: nowIso() };
    if (hitsConcepts) merged.concepts = Array.from(new Set(ch.concepts.map((t) => (t === fromTerm ? toTerm : t))));
    if (hitsPersons) merged.person_terms = rewritePersonTerms(ch.personTerms, fromTerm, toDisplay);
    await vfs.writeText(conceptFilePath(bDir, ch.id), stringifyDocument(merged, parsed.body));
    rewritten.push(ch.id);
  }
  // the author rides on the document stub, which carries `person_terms` too
  for (const doc of before.classified.documents.values()) {
    if (doc.synthetic) continue;
    if (!(doc.personTerms || []).some((p) => p.toLowerCase() === fromTerm)) continue;
    const parsed = await readConceptRaw(bDir, doc.id);
    if (!parsed) continue;
    const merged = {
      ...parsed.frontmatter,
      person_terms: rewritePersonTerms(doc.personTerms, fromTerm, toDisplay),
      updated_at: nowIso(),
    };
    await vfs.writeText(conceptFilePath(bDir, doc.id), stringifyDocument(merged, parsed.body));
    rewritten.push(doc.id);
  }

  markGraphDirty(bDir);
  const after = await rebuildDerived(bundleRoot, bundleName);
  await appendLog(bundleRoot, bundleName, {
    event: "concepts_merge",
    message: `merged concept term "${fromTerm}" into "${toTerm}" across ${rewritten.length} chapter(s)`,
  });
  const canonical = after.terms.find((t) => String(t.name).toLowerCase() === toTerm);
  return {
    from: fromTerm,
    to: toTerm,
    chaptersRewritten: rewritten,
    tocsRebuilt: Array.from(new Set(rewritten.map((id) => id.split("/")[0]))),
    canonicalTerm: canonical ? { name: canonical.name, kind: canonical.kind || "topic", count: canonical.count } : null,
    fromTermRemaining: after.terms.some((t) => String(t.name).toLowerCase() === fromTerm),
  };
}

// ── links (FR-031/FR-032) ────────────────────────────────────────────────

/** "concepts/qwen3/attention-sinks" -> "Attention Sinks" — a stub's title. */
function conceptTitleFromId(id) {
  const leaf = String(id).split("/").filter(Boolean).pop() || String(id);
  return leaf.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() || String(id);
}

function ensureLinksSection(body) {
  if (/^##\s+Links\s*$/m.test(body)) return body;
  return `${body.replace(/\n+$/, "\n")}\n## Links\n`;
}

async function removeLinkFromBody(bundleRoot, bundleName, id, targetId) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const existing = await readConceptRaw(bDir, id);
  if (!existing) return;
  const kept = existing.body.split("\n").filter((line) => {
    const m = /\[[^\]]*\]\(([^)]+)\)/.exec(line);
    return !m || normalizeLinkTarget(m[1]) !== targetId;
  });
  await vfs.writeText(conceptFilePath(bDir, id), stringifyDocument({ ...existing.frontmatter, updated_at: nowIso() }, kept.join("\n")));
  markGraphDirty(bDir);
}

/**
 * Add an explicit "related" edge (FR-031). Written TWICE, deliberately: as a
 * markdown link in the body (human-readable, OKF-portable, survives a git
 * clone with no tooling) and as an entry in links.json (so graph derivation
 * doesn't have to re-parse every body). okf_lint reconciles the two.
 */
async function addLink(bundleRoot, bundleName, id, targetId, { label } = {}) {
  const bDir = bundleDir(bundleRoot, bundleName);
  let existing = await readConceptRaw(bDir, id);
  if (!existing) {
    // The source concept does not exist YET. The ingest agent builds graph
    // structure while it decomposes chunks, so it routinely links out of a
    // chapter it has not written the body for — and throwing here turned
    // that ordinary ordering into a cascade of errors that lost the edge.
    // Write a minimal stub instead and record the link. The stub is
    // idempotent: a later okf_upsert_concept on the same id merges onto it
    // field-by-field (NFR-005), keeping created_at and this link's body.
    const stubTitle = conceptTitleFromId(id);
    existing = {
      frontmatter: { id, type: "section", title: stubTitle, status: "draft", created_at: nowIso(), updated_at: nowIso() },
      body: `# ${stubTitle}\n`,
    };
    await vfs.writeText(conceptFilePath(bDir, id), stringifyDocument(existing.frontmatter, existing.body));
  }
  validateConceptId(targetId);

  if (!extractLinks(existing.body).includes(targetId)) {
    const body = `${ensureLinksSection(existing.body).replace(/\n+$/, "\n")}- [${label || targetId}](${targetId}.md)\n`;
    await vfs.writeText(conceptFilePath(bDir, id), stringifyDocument({ ...existing.frontmatter, updated_at: nowIso() }, body));
  }
  const sidecar = await readLinksSidecar(bDir);
  if (!sidecar.some((e) => e.from === id && e.to === targetId)) sidecar.push({ from: id, to: targetId, label: label || "related" });
  await writeLinksSidecar(bDir, sidecar);

  markGraphDirty(bDir);
  await rebuildDerived(bundleRoot, bundleName);
  return readConcept(bundleRoot, bundleName, id);
}

async function backlinks(bundleRoot, bundleName, id) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const g = await ensureGraph(bDir);
  const fromBodies = Array.from(g.backlinks.get(id) || []);
  const fromSidecar = (await readLinksSidecar(bDir)).filter((e) => e.to === id).map((e) => e.from);
  return Array.from(new Set([...fromBodies, ...fromSidecar])).sort();
}

// ════════════════════════════════════════════════════════════════════════
//  raw/ — immutable sources, inline assets, and the provenance ledger
// ════════════════════════════════════════════════════════════════════════

function normalizeSourceKey(source) {
  const s = String(source || "").trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      u.hash = "";
      return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
    } catch {
      return s.toLowerCase();
    }
  }
  return s;
}

async function readLedger(bDir) {
  const raw = await vfs.readText(safeJoin(bDir, "raw", "sources.json")).catch(() => null);
  if (!raw) return { sources: {} };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.sources === "object" && parsed.sources ? parsed : { sources: {} };
  } catch {
    return { sources: {} };
  }
}

async function writeLedger(bDir, ledger) {
  await vfs.writeText(safeJoin(bDir, "raw", "sources.json"), JSON.stringify(ledger, null, 2) + "\n");
}

/** Dedup lookup for FR-018: has this source already been ingested? */
async function findSource(bundleRoot, bundleName, source) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const ledger = await readLedger(bDir);
  return ledger.sources[normalizeSourceKey(source)] || null;
}

async function recordSource(bDir, source, entry) {
  const ledger = await readLedger(bDir);
  const key = normalizeSourceKey(source);
  ledger.sources[key] = { ...(ledger.sources[key] || {}), ...entry, sourceKey: key };
  await writeLedger(bDir, ledger);
  return ledger.sources[key];
}

// ── INGEST CHUNKING (FR-055/FR-056, ADR-012) ─────────────────────────────
//
// A large source kills a run before it starts: the agent `file_read`s the
// whole staged document into its context and a 351KB source is ~1.4M tokens
// against a 524K limit. The fix is MECHANICAL and lives here, on the worker
// side of `okf_add_raw_source` — the one moment the service already holds the
// acquired bytes (it is writing them into raw/). The agent then reads one
// bounded chunk at a time via `file_read`, which it already has. No new tool
// (the surface stays 21, SC-007), no LLM in the split.
//
// `chunkSource` is a PURE function: no VFS, no I/O, no clock. All the I/O is
// in `writeChunks` and in `addRawSource` below it. That split is what makes
// the algorithm testable without a running BOS.

/** Default bound on one chunk, in characters (~8K tokens). Config: maxChunkSize. */
const DEFAULT_MAX_CHUNK_SIZE = 32000;
/** Operational staging for the mechanical pre-split — sibling of .jobs/, NOT raw/. */
const CHUNKS_DIR = ".chunks";
/**
 * The chunk-time heading map (ADR-014 D1/D2): `{sourceFile, sourceLength,
 * headings:[{index,level,text,start,end}]}`, written beside the chunks it
 * was computed from. Char offsets into `raw/<sourceFile>` — the UN-chunked
 * original — are what let the write path slice a chapter body verbatim
 * instead of having the agent re-emit it (FR-060).
 */
const HEADINGS_FILE = "headings.json";

/** A markdown ATX heading line: `#` to `######` followed by whitespace. */
const HEADING_LINE = /^(#{1,6})\s+(.*)$/;

/**
 * Sentence boundaries: `. ` / `! ` / `? ` (with any closing quote/bracket)
 * followed by whitespace and then a capital, a digit, a markdown marker, or
 * the end of the text. The lookahead is what keeps "v1.2 of the spec" and
 * "e.g. this" from being read as two sentences.
 */
function splitSentences(text) {
  const parts = [];
  const re = /[.!?]["'’”)\]]*\s+/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const next = m.index + m[0].length;
    const ch = text[next];
    if (ch === undefined || /[A-Z0-9"'“([#*\-_>`]/.test(ch)) {
      parts.push(text.slice(last, next));
      last = next;
    }
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}

/** Pack sentences up to `max`. A single sentence longer than `max` is hard-cut
 *  — at that point there is no smaller boundary left to respect. */
function packSentences(text, max) {
  const out = [];
  let cur = "";
  for (const sentence of splitSentences(text)) {
    if ((cur + sentence).length <= max) {
      cur += sentence;
      continue;
    }
    if (cur) {
      out.push(cur);
      cur = "";
    }
    if (sentence.length <= max) {
      cur = sentence;
      continue;
    }
    let rest = sentence;
    while (rest.length > max) {
      out.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    cur = rest;
  }
  if (cur) out.push(cur);
  return out.length ? out : [text];
}

/**
 * Bound one heading-delimited section: paragraphs first (double newline),
 * then sentences inside a paragraph that is itself oversized.
 *
 * Runs of blank lines collapse to exactly one in the rejoin. A chunk is
 * DERIVED staging — `raw/<source>.md` is the byte-exact provenance — so
 * normalising whitespace here costs nothing anyone can lose.
 */
function splitToSize(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = "";
  const flush = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (const para of text.split(/\n{2,}/)) {
    if (!para) continue;
    const candidate = cur ? `${cur}\n\n${para}` : para;
    if (candidate.length <= max) {
      cur = candidate;
      continue;
    }
    if (para.length <= max) {
      flush();
      cur = para;
      continue;
    }
    // The paragraph alone busts the bound — go down to sentences. Whatever is
    // already in `cur` goes INTO that sentence packing rather than being
    // flushed first: a section whose heading line is followed immediately by
    // an oversized paragraph would otherwise emit the heading as a chunk of
    // its own. The tail stays in `cur` so the next paragraph packs behind it.
    const pieces = packSentences(cur ? `${cur}\n\n${para}` : para, max);
    cur = "";
    for (let i = 0; i < pieces.length - 1; i++) out.push(pieces[i]);
    cur = pieces[pieces.length - 1];
  }
  flush();
  return out.length ? out : [text];
}

// ── Headings of a source that has no Markdown headings ─────────────────────
//
// A PDF converted to markdown arrives with NO `#` lines — its section titles
// are plain lines ("2 Model Architecture", "2.1 Attention") — so a heading map
// built from Markdown headings alone is empty, `sourceRange` can express
// nothing but `whole: true`, and the agent's only way to write chapters is to
// re-type the document. On production it did exactly that: all 130K characters
// of a technical report, with `#` markers inserted, after first reaching for
// file_write to do it.
//
// So when a source has no Markdown heading at all, its structure is read from
// the two conventions such documents actually use, and nothing else:
//
//   • a NUMBERED section title — "2", "2.1", "2.1.1" then a Capitalised title
//     — accepted only as the valid NEXT entry of an outline (a child, a
//     sibling, or the next sibling of an ancestor). The outline rule is what
//     rejects the numbers that litter a converted PDF: page numbers ("9"),
//     figure labels ("80 Block 16"), table values ("1"). pdfminer often puts
//     the number and the title on separate lines ("1" / blank / "Introduction");
//     that pair is one heading, starting at the number line.
//   • a CONVENTIONAL unnumbered title (Abstract, References, …) alone on its
//     line.
//
// Both must stand alone — the line before is blank or ends a sentence or a
// table row, never a mid-sentence wrap — and be short, not ending like a
// sentence or a table-of-contents entry (a trailing page number). Offsets are into the untouched source, so a chapter body is still a
// verbatim slice of raw/ (SC-019). A source with ANY Markdown heading is read
// exactly as before — the fallback never mixes in.

const SECTION_NUMBER = /^(\d{1,2}(?:\.\d{1,2}){0,4})\.?$/;
const NUMBERED_TITLE = /^(\d{1,2}(?:\.\d{1,2}){0,4})\.?\s+(\S.*)$/;
const CONVENTIONAL_TITLES = new Set([
  "abstract", "introduction", "background", "related work", "conclusion", "conclusions", "discussion",
  "acknowledgements", "acknowledgments", "references", "bibliography", "appendix", "appendices", "summary",
]);
const MAX_TITLE_LENGTH = 90;
const MAX_TITLE_WORDS = 14;

/** A line that can be a section title's TEXT: capitalised, short, and not a
 *  sentence or a TOC entry. */
function isTitleText(text) {
  const t = text.trim();
  if (!t || t.length > MAX_TITLE_LENGTH || t.split(/\s+/).length > MAX_TITLE_WORDS) return false;
  if (!/^[A-Z]/.test(t)) return false;
  if (/[.;:,]$/.test(t)) return false; // a sentence or a run-in label, not a title
  if (/\s\d+$/.test(t)) return false; // "Method 7" — a table-of-contents line
  return true;
}

/** Is `next` (parts of a section number) the valid next entry after `prev`? */
function isNextSection(prev, next) {
  if (!prev.length) return next.length === 1 && next[0] === 1;
  if (next.length === prev.length + 1 && next[next.length - 1] === 1 && prev.every((n, i) => next[i] === n)) return true;
  if (next.length > prev.length) return false;
  for (let i = 0; i < next.length - 1; i++) if (next[i] !== prev[i]) return false;
  return next[next.length - 1] === prev[next.length - 1] + 1;
}

/**
 * Every heading of a source as `{line, level, text}` (line = 0-based index) —
 * THE one heading reader, shared by buildHeadingMap and chunkSource so the
 * chunks the agent reads and the map its `sourceRange` resolves against can
 * never disagree.
 */
function sourceHeadings(lines) {
  const atx = [];
  lines.forEach((line, i) => {
    const m = HEADING_LINE.exec(line);
    if (m) atx.push({ line: i, level: m[1].length, text: m[2].trim() });
  });
  if (atx.length) return atx;

  const found = [];
  let outline = [];
  // A title starts its own line of thought: the line before it is blank, or
  // ENDS something — a sentence, a table row, a parenthetical. pdfminer often
  // sets a title directly under the last line of the previous paragraph, but a
  // line that merely wraps mid-sentence ("…trained on" / "2 Trillion Tokens")
  // never qualifies.
  const standsAlone = (i) => i === 0 || !lines[i - 1].trim() || /[.!?:|)\]]\s*$/.test(lines[i - 1]);
  const consumed = new Set(); // title lines already used by a split "1" / "Introduction" heading
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || consumed.has(i) || !standsAlone(i)) continue;

    if (CONVENTIONAL_TITLES.has(line.toLowerCase()) && /^[A-Z]/.test(line)) {
      found.push({ line: i, level: 1, text: line });
      continue;
    }

    let number = null;
    let title = null;
    let titleLine = null;
    const numbered = NUMBERED_TITLE.exec(line);
    if (numbered && isTitleText(numbered[2])) {
      number = numbered[1];
      title = numbered[2].trim();
    } else if (SECTION_NUMBER.test(line)) {
      // "1" / blank / "Introduction": the title is the next non-blank line
      let j = i + 1;
      while (j < lines.length && !lines[j].trim() && j - i <= 2) j++;
      if (j < lines.length && j - i <= 2 && !NUMBERED_TITLE.test(lines[j].trim()) && isTitleText(lines[j])) {
        number = SECTION_NUMBER.exec(line)[1];
        title = lines[j].trim();
        titleLine = j;
      }
    }
    if (!number) continue;
    const parts = number.split(".").map(Number);
    if (!isNextSection(outline, parts)) continue;
    outline = parts;
    if (titleLine !== null) consumed.add(titleLine);
    found.push({ line: i, level: parts.length, text: `${number} ${title}` });
  }
  return found;
}

/**
 * Walk a source ONCE and record every heading with its char offset
 * (ADR-014 D1). PURE — no I/O, no LLM, deterministic: the same bytes always
 * produce the same map, which is the whole basis of the verbatim-slice
 * invariant (SC-019).
 *
 * `start` is the offset of the heading's own `#` character; `end` is the
 * start of the NEXT heading, or `sourceLength` for the last one. A chapter
 * body is therefore a contiguous `[start, end)` slice of `raw/<source>.md` —
 * the full original, never the chunk files, which are a read-cache for the
 * agent and not the storage substrate (D2).
 *
 * @param {string} content
 * @returns {{headings:{index:number,level:number,text:string,start:number,end:number}[], sourceLength:number}}
 */
function buildHeadingMap(content) {
  const text = String(content == null ? "" : content);
  const lines = text.split("\n");
  const lineStart = [];
  let offset = 0;
  for (const line of lines) {
    lineStart.push(offset);
    offset += line.length + 1; // + the "\n" that split() consumed
  }
  const headings = sourceHeadings(lines).map((h, index) => ({
    index,
    level: h.level,
    text: h.text,
    start: lineStart[h.line],
    end: 0,
  }));
  for (let i = 0; i < headings.length; i++) {
    headings[i].end = i + 1 < headings.length ? headings[i + 1].start : text.length;
  }
  return { headings, sourceLength: text.length };
}

/**
 * Split a markdown source into bounded chunks (ADR-012). PURE — no I/O.
 *
 * 1. A source that already fits in `maxChunkSize` is ONE chunk, untouched,
 *    with an empty `headingPath`: the small-source path must cost nothing and
 *    must behave exactly as it did before chunking existed.
 * 2. Otherwise split on heading boundaries (`/^#{1,6}\s/`) — one chunk per
 *    heading-delimited section, each carrying the stack of headings open at
 *    that point (deepest last). Content before the first heading, and a
 *    source with no headings at all, carries an empty `headingPath`.
 * 3. A section over the bound is split again at paragraph boundaries, and a
 *    paragraph over the bound at sentence boundaries.
 *
 * 4. Every chunk ALSO carries `headings` (ADR-014 D1): the GLOBAL indices
 *    (into `buildHeadingMap(content).headings`) of the headings visible in
 *    that chunk, PLUS the one heading that comes immediately after the
 *    chunk's content — the boundary heading. The agent references a chapter
 *    by one of those integers instead of re-typing heading text, and the
 *    boundary entry is what makes a `toHeading` merge always expressible
 *    from the chunk in hand.
 *
 * @param {string} content
 * @param {number} [maxChunkSize]
 * @returns {{chunk:number,total:number,headingPath:string[],headings:number[],content:string}[]}
 *          Always at least one chunk; `chunk` is 1-based and `total` is the
 *          same on every element.
 */
function chunkSource(content, maxChunkSize) {
  const text = String(content == null ? "" : content);
  const max =
    Number.isFinite(maxChunkSize) && maxChunkSize > 0 ? Math.floor(maxChunkSize) : DEFAULT_MAX_CHUNK_SIZE;
  const { headings: allHeadings } = buildHeadingMap(text);

  // The whole source in one chunk: every heading in it is an in-chunk
  // heading, and there is no heading after it to be a boundary.
  if (text.length <= max) {
    return [{ chunk: 1, total: 1, headingPath: [], headings: allHeadings.map((h) => h.index), content: text }];
  }

  const sections = [];
  const stack = []; // {level, text} — the headings open at this point
  let sectionLines = [];
  let sectionPath = [];
  // The GLOBAL index of the heading that opened the current section; -1
  // while we are still in the headingless preamble.
  let headingIndex = -1;
  let headingsSeen = 0;
  const closeSection = () => {
    const body = sectionLines.join("\n");
    if (body.trim()) sections.push({ headingPath: sectionPath.slice(), content: body, headingIndex });
  };

  const lines = text.split("\n");
  const headingAt = new Map(sourceHeadings(lines).map((h) => [h.line, h]));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = headingAt.get(i);
    if (!heading) {
      sectionLines.push(line);
      continue;
    }
    closeSection();
    const level = heading.level;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text: heading.text });
    sectionPath = stack.map((h) => h.text);
    sectionLines = [line];
    headingIndex = headingsSeen;
    headingsSeen++;
  }
  closeSection();
  if (!sections.length) sections.push({ headingPath: [], content: text, headingIndex: -1 });

  const pieces = [];
  for (const section of sections) {
    const split = splitToSize(section.content, max);
    split.forEach((piece, ordinal) => {
      // Only the FIRST piece of a section carries that section's heading
      // line (splitToSize packs it with the content that follows it); a
      // continuation piece has no heading of its own, but its boundary is
      // still the next heading after the section it belongs to.
      const inChunk = ordinal === 0 && section.headingIndex >= 0 ? [section.headingIndex] : [];
      const boundary = section.headingIndex + 1;
      pieces.push({
        headingPath: section.headingPath,
        headings: boundary < allHeadings.length ? [...inChunk, boundary] : inChunk,
        content: piece,
      });
    });
  }
  const total = pieces.length;
  return pieces.map((p, i) => ({ chunk: i + 1, total, headingPath: p.headingPath, headings: p.headings, content: p.content }));
}

/**
 * Write the chunks of one document to `.chunks/<docId>/NNN.md` — plus the
 * heading map to `.chunks/<docId>/headings.json` (ADR-014 W2) — and return
 * the chunk paths the tool response hands the agent.
 *
 * CLEAR-THEN-REWRITE. `.chunks/` is a derived cache, not provenance: the
 * append-only rule (NFR-006) covers `raw/`, where the full source already
 * lives byte-exact. Re-ingesting a changed source must not leave the tail of
 * the previous, longer split lying around for the agent to read as part of
 * the new document.
 */
async function writeChunks(bDir, docId, chunks, headingMap) {
  validateConceptId(docId);
  const docDir = safeJoin(bDir, CHUNKS_DIR, docId);
  const headingsPath = safeJoin(docDir, HEADINGS_FILE);
  // ONE clear-then-write window for the chunks AND the heading map they were
  // computed from (ADR-014 Risk #2). Removing the directory already takes
  // the old headings.json with it; the explicit unlink below is what keeps
  // that true if the remove above is ever relaxed to a per-file clear — a
  // stale map is worse than a missing one, because it mis-slices silently
  // instead of failing loud.
  if (await vfs.exists(docDir)) await vfs.remove(docDir);
  await vfs.mkdir(safeJoin(bDir, CHUNKS_DIR)).catch(() => {});
  await vfs.mkdir(docDir).catch(() => {});
  if (await vfs.exists(headingsPath)) await vfs.remove(headingsPath).catch(() => {});

  const written = [];
  for (const chunk of chunks) {
    const name = `${String(chunk.chunk).padStart(3, "0")}.md`;
    const frontmatter = {
      chunk: chunk.chunk,
      total: chunk.total,
      headingPath: Array.isArray(chunk.headingPath) ? chunk.headingPath : [],
      // The global heading indices this chunk can reference (ADR-014 D1) —
      // the agent's whole vocabulary for `sourceRange.startHeading`.
      headings: Array.isArray(chunk.headings) ? chunk.headings : [],
    };
    await vfs.writeText(safeJoin(docDir, name), stringifyDocument(frontmatter, chunk.content));
    written.push({ path: `${CHUNKS_DIR}/${docId}/${name}`, ordinal: chunk.chunk, total: chunk.total });
  }

  if (headingMap) {
    await vfs.writeText(
      headingsPath,
      JSON.stringify(
        {
          sourceFile: headingMap.sourceFile,
          sourceLength: headingMap.sourceLength,
          headings: headingMap.headings,
        },
        null,
        2,
      ) + "\n",
    );
  }
  return written;
}

// ════════════════════════════════════════════════════════════════════════
//  THE BODY-EXTRACTION WRITE PATH (FR-060 / SC-019, ADR-014 Part A)
// ════════════════════════════════════════════════════════════════════════
//
// The agent used to re-emit each chapter's body as output tokens — bytes
// that were already on disk at `raw/<source>.md`. Now it emits only what it
// AUTHORS (frontmatter + asset interpretations) plus a `sourceRange` of
// integers, and THIS code assembles the body: a verbatim char slice of the
// un-chunked original, with the authored interpretations inserted at their
// asset lines.
//
// THE INVARIANT (SC-019): the stored body, with the inserted interpretation
// lines removed (`stripInterpretations`), is byte-for-byte the slice. Every
// placement below — exact match, filename match, appended fallback — only
// ADDS removable lines around the slice; nothing rewrites a byte of it.

/** The one line shape every inserted interpretation has — and the one thing
 *  `stripInterpretations` removes. Changing it changes both. */
const INTERPRETATION_PREFIX = "> **Interpretation (LLM, at ingest):**";

/** A markdown image/asset link anywhere in a line. */
const ASSET_LINK = /!\[([^\]]*)\]\(\s*([^)]+?)\s*\)/;

/** The marker that makes an inserted link REMOVABLE without guesswork. An
 *  HTML comment renders as nothing, and no source can contain this line —
 *  which is what lets `stripInterpretations` be exact rather than heuristic
 *  about a `raw/assets/…` link that was in the source to begin with. */
const INTERPRETATION_ASSET_MARK = "<!-- interpretation-asset -->";

/** A line that is NOTHING BUT a link this module inserted to a stored asset. */
const LOCAL_ASSET_LINE = new RegExp(`^!\\[[^\\]]*\\]\\(\\s*raw/assets/[^)\\s]+\\s*\\)\\s*${INTERPRETATION_ASSET_MARK}\\s*$`);

/** The stored filename `addRawAsset` gives a downloaded asset. Shared, so a
 *  rewritten link and the file it points at can never disagree. */
function assetFileName(locator) {
  return path.basename(String(locator || "")).split("?")[0].replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** The asset's filename AS THE SOURCE SPELLS IT — percent-escapes and all.
 *  This is the matching key, deliberately NOT `assetFileName`: the stored
 *  name is sanitized (`canary%20run.mp4` -> `canary-20run.mp4`), so matching
 *  on it would never find the source line it came from. */
function sourceFileName(locator) {
  return path.basename(String(locator || "").split(/[?#]/)[0]);
}

/** The target inside a markdown asset link, if the line has one. */
function assetTargetOf(line) {
  const m = ASSET_LINK.exec(String(line || ""));
  return m ? { caption: m[1], target: String(m[2]).split(/\s+/)[0] } : null;
}

/** One line of prose — an interpretation is inserted as a single blockquote
 *  line, so an embedded newline would silently end the quote. */
function oneLine(text) {
  return String(text == null ? "" : text).trim().replace(/\s*\n+\s*/g, " ");
}

/**
 * Read + VALIDATE a document's chunk-time heading map.
 *
 * Fail loud, never silently mis-slice (ADR-014 Risk #2). A map that
 * disagrees with the bytes it claims to describe would hand back a slice
 * taken at the wrong offsets — a corrupted chapter that looks fine. Both
 * disagreements it can detect (byte length, heading count) therefore throw,
 * and `okf_lint` reports the same drift before a write ever hits it.
 */
async function readHeadingMap(bDir, docId, { sourceFile } = {}) {
  validateConceptId(docId);
  const mapPath = safeJoin(bDir, CHUNKS_DIR, docId, HEADINGS_FILE);
  const raw = await vfs.readText(mapPath).catch(() => null);
  if (raw == null) {
    throw new Error(
      `no heading map at ${CHUNKS_DIR}/${docId}/${HEADINGS_FILE} — a chapter can only be written from a sourceRange for a document registered by okf_add_raw_source (which writes it). Re-register the source, or pass the chapter body in \`body\`.`,
    );
  }
  let map;
  try {
    map = JSON.parse(raw);
  } catch (err) {
    throw new Error(`heading map ${CHUNKS_DIR}/${docId}/${HEADINGS_FILE} is not valid JSON: ${err.message}`);
  }
  const file = sourceFile || (map && map.sourceFile);
  if (!file) throw new Error(`heading map ${CHUNKS_DIR}/${docId}/${HEADINGS_FILE} names no sourceFile`);
  if (!Array.isArray(map.headings)) throw new Error(`heading map ${CHUNKS_DIR}/${docId}/${HEADINGS_FILE} has no headings array`);
  if (!Number.isFinite(map.sourceLength)) {
    throw new Error(`heading map ${CHUNKS_DIR}/${docId}/${HEADINGS_FILE} records no sourceLength — it cannot be checked against ${file}`);
  }

  const text = await vfs.readText(safeJoin(bDir, file)).catch(() => null);
  if (text == null) throw new Error(`heading map ${CHUNKS_DIR}/${docId}/${HEADINGS_FILE} points at ${file}, which is not in the bundle`);
  if (text.length !== map.sourceLength) {
    throw new Error(
      `heading map drift: ${CHUNKS_DIR}/${docId}/${HEADINGS_FILE} was built for a ${map.sourceLength}-char ${file}, which is now ${text.length} chars. Re-register the source with okf_add_raw_source so the map and the bytes agree.`,
    );
  }
  const fresh = buildHeadingMap(text);
  if (fresh.headings.length !== map.headings.length) {
    throw new Error(
      `heading map drift: ${CHUNKS_DIR}/${docId}/${HEADINGS_FILE} records ${map.headings.length} heading(s), ${file} has ${fresh.headings.length}. Re-register the source with okf_add_raw_source.`,
    );
  }
  return { ...map, sourceFile: file, text };
}

/**
 * Resolve a `sourceRange` to a `[start, end)` char range (ADR-014 D1/D6).
 * PURE — offsets in, offsets out.
 *
 * Accepts the flat shape the tool schema declares (`{startHeading,
 * toHeading, whole}`) and the nested `endRule` spelling ADR-014 writes
 * (`{startHeading, endRule:{toHeading}}`) — same semantics either way, so an
 * agent that read the ADR and an agent that read the schema both work.
 */
function resolveSourceSlice(sourceRange, headings, sourceLength) {
  const range = sourceRange || {};
  const endRule = range.endRule && typeof range.endRule === "object" ? range.endRule : {};
  if (range.whole === true || endRule.whole === true) return { start: 0, end: sourceLength };

  const startHeading = range.startHeading;
  if (!Number.isInteger(startHeading)) {
    throw new Error("sourceRange needs an integer `startHeading` (or `whole: true`) — the global heading index from the chunk's `headings:` frontmatter");
  }
  // The headingless preamble: from the very start of the source to just
  // before the first heading (D6). A source with no headings at all has no
  // preamble boundary, so -1 means the whole thing.
  if (startHeading === -1) return { start: 0, end: headings.length ? headings[0].start : sourceLength };

  if (startHeading < 0 || startHeading >= headings.length) {
    throw new Error(`sourceRange.startHeading ${startHeading} is out of range — the source has ${headings.length} heading(s) (0..${headings.length - 1})`);
  }
  const start = headings[startHeading].start;

  const toHeading = Number.isInteger(range.toHeading) ? range.toHeading : Number.isInteger(endRule.toHeading) ? endRule.toHeading : null;
  if (toHeading !== null) {
    if (toHeading <= startHeading || toHeading > headings.length) {
      throw new Error(`sourceRange.toHeading ${toHeading} must be a later heading than startHeading ${startHeading} (and at most ${headings.length})`);
    }
    // `toHeading === headings.length` is the legal "to the end" spelling.
    return { start, end: toHeading === headings.length ? sourceLength : headings[toHeading].start };
  }

  // The default end rule: the next heading of the SAME or a HIGHER level —
  // the natural "one heading = one chapter" boundary. Resolved globally, so
  // it terminates a section whose content runs past the chunk it was read
  // in (D2) without the agent knowing where the chunk boundary fell.
  const level = headings[startHeading].level;
  for (let i = startHeading + 1; i < headings.length; i++) {
    if (headings[i].level <= level) return { start, end: headings[i].start };
  }
  return { start, end: sourceLength };
}

/**
 * Insert the agent's authored interpretations into a verbatim body slice
 * (ADR-014 D3). Three deterministic placements, tried in order:
 *
 *   1. the line containing `assetLine` as an exact substring;
 *   2. the line containing the asset's FILENAME (whitespace/encoding drift
 *      between the two readers of the same VFS file — Risk #1);
 *   3. appended at the end behind an `<!-- interpretation: … -->` marker
 *      `okf_lint` can flag.
 *
 * The asset-URL rewrite (ADR-008/§7.5) is ADDITIVE here, not in-place: the
 * source's own asset line is left byte-exact and the stored local copy is
 * referenced by an inserted `![…](raw/assets/<docId>/<name>)` line directly
 * above the blockquote. Rewriting the URL in place would edit the slice and
 * break SC-019 — the invariant the whole protocol exists to guarantee —
 * while the inserted line renders the stored asset just the same, and
 * `extractAssets` reads the pair exactly as it reads an agent-written block.
 */
function insertInterpretations(body, interpretations, docId) {
  const list = Array.isArray(interpretations) ? interpretations : [];
  if (!list.length) return { body, placements: [] };

  const lines = String(body == null ? "" : body).split("\n");
  const placements = [];

  const blockFor = (matchedLine, interpretation) => {
    const out = [];
    const link = assetTargetOf(matchedLine);
    // Already a stored `raw/…` path? Then there is nothing to rewrite and a
    // second link would just be noise.
    if (link && !normalizeAssetTarget(link.target)) {
      const name = assetFileName(link.target);
      if (name) out.push(`![${link.caption || name}](raw/assets/${docId}/${name}) ${INTERPRETATION_ASSET_MARK}`);
    }
    out.push(`${INTERPRETATION_PREFIX} ${oneLine(interpretation) || "Interpretation unavailable — the asset could not be downloaded or interpreted at ingest."}`);
    return out;
  };

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const assetLine = String(item.assetLine == null ? "" : item.assetLine).trim();
    const interpretation = item.interpretation;

    let at = -1;
    let how = "exact";
    if (assetLine) at = lines.findIndex((l) => l.includes(assetLine));
    if (at === -1 && assetLine) {
      // Fallback: the filename as the SOURCE spells it (Risk #1 — the agent
      // read the line through one VFS reader, this matches it through
      // another, and the two can differ by whitespace or a re-typed caption).
      const link = assetTargetOf(assetLine);
      const name = sourceFileName(link ? link.target : assetLine);
      if (name) {
        at = lines.findIndex((l) => ASSET_LINK.test(l) && l.includes(name));
        how = "filename";
      }
    }

    if (at === -1) {
      // Appended, marked, and still removable — the slice underneath is
      // untouched, so the invariant holds here too.
      const marker = `<!-- interpretation: ${assetLine.replace(/\s+/g, " ").replace(/--+>/g, "--&gt;")} (appended — asset line not matched verbatim) -->`;
      lines.push(marker, ...blockFor(assetLine, interpretation));
      placements.push({ assetLine, placement: "appended" });
      continue;
    }
    lines.splice(at + 1, 0, ...blockFor(lines[at], interpretation));
    placements.push({ assetLine, placement: how, line: at });
  }
  return { body: lines.join("\n"), placements };
}

/**
 * THE INVERSE of `insertInterpretations` — remove every line this module
 * inserts, leaving the verbatim slice. Exported because it is how SC-019 is
 * CHECKED (by the tests, and by anyone auditing a stored chapter against
 * `raw/`): a chapter body that does not strip back to a byte-exact slice of
 * its source is a bug in the write path, and the check needs the removal
 * rule to live next to the insertion rule rather than be re-guessed.
 *
 * A `raw/assets/…` link is removed ONLY when it carries the
 * `<!-- interpretation-asset -->` mark this module writes on the links IT
 * inserts — never on a `raw/assets/…` link that was in the source to begin
 * with (a re-ingested bundle export is exactly such a source).
 */
function stripInterpretations(body) {
  const lines = String(body == null ? "" : body).split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(INTERPRETATION_PREFIX)) continue;
    if (/^<!--\s*interpretation:[\s\S]*-->\s*$/.test(line)) continue;
    if (LOCAL_ASSET_LINE.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Assemble a chapter's body from the SOURCE (ADR-014 W3) — the write path
 * `okf_upsert_concept({sourceRange})` runs instead of taking a body the
 * agent re-typed.
 *
 * Reads `.chunks/<docId>/headings.json` + `raw/<sourceFile>` and returns the
 * assembled string. Writes NOTHING: the caller (`upsertConcept`) owns the
 * write, so this stays a pure, unit-testable function over the VFS reads.
 *
 * @param {string} bDir             the bundle directory
 * @param {string} docId            the document id (front half of `<docId>/<chId>`)
 * @param {object} sourceRange      {startHeading|whole, toHeading?}
 * @param {object[]} [interpretations] [{assetLine, interpretation}]
 * @param {string} [sourceFile]     overrides the map's own `sourceFile`
 * @returns {Promise<{body:string, sourceFile:string, start:number, end:number, slice:string, placements:object[]}>}
 */
async function chapterFromSourceRange(bDir, docId, sourceRange, interpretations, sourceFile) {
  const map = await readHeadingMap(bDir, docId, { sourceFile });
  const { start, end } = resolveSourceSlice(sourceRange, map.headings, map.sourceLength);
  const slice = map.text.slice(start, end);
  const { body, placements } = insertInterpretations(slice, interpretations, docId);
  return { body, slice, sourceFile: map.sourceFile, start, end, placements };
}

/** The pipeline's own staging prefix (see `acquisitionFirstSteps`) — never part of a document id. */
const STAGED_PREFIX = /^okf-staged-/i;

/** A trailing extension worth dropping: `.pdf`, `.md` — but not the `.2` of `v1.2`. */
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * Lowercase, hyphen-joined slug, safe as a concept id. The leading
 * non-alphanumerics go because validateConceptId (and therefore
 * `.chunks/<docId>/`) requires an alphanumeric first character — "_internal.md"
 * must not fail the write.
 */
function slugifyDocId(text) {
  return String(text || "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** The document-naming part of one locator (a URL or a path), or "" if it has none. */
function docNameFromLocator(locator) {
  const s = String(locator || "").trim();
  if (!s) return "";
  let name;
  if (s.includes("://")) {
    let u;
    try {
      u = new URL(s);
    } catch {
      return ""; // a malformed URL names nothing — let the next locator answer
    }
    const segment = u.pathname.split("/").filter(Boolean).pop();
    // A bare host ("https://example.com/") still names its own source.
    if (!segment) return slugifyDocId((u.hostname || u.pathname).replace(/^www\./i, ""));
    try {
      name = decodeURIComponent(segment);
    } catch {
      name = segment;
    }
  } else {
    name = path.basename(s.replace(/[?#].*$/, "").replace(/\/+$/, ""));
  }
  return slugifyDocId(name.replace(STAGED_PREFIX, "").replace(FILE_EXTENSION, ""));
}

/**
 * The docId a source maps to — the ONE derivation, so the id the chunk
 * directory is named for, the id the ledger records and the id the response
 * reports are the same string by construction rather than three copies of the
 * same expression.
 *
 * `originUrl` WINS over the path the bytes happen to sit at, because by the
 * time `okf_add_raw_source` is called that path is almost always
 * `/workspace/okf-staged-….md` — a pipeline-internal staging name. Deriving
 * from it produced ids like "okf-staged-tech_report", which no agent would
 * ever write a document stub under, so the agent invented its own id and the
 * document's chunks, ledger entry and TOC ended up keyed three different ways.
 *
 * Pure and deterministic: the same source yields the same id on every run,
 * which is what lets a re-ingest reconcile onto the existing document instead
 * of forking a second one. (Nothing agent-authored — a title, say — feeds it,
 * for exactly that reason.)
 */
function docIdForSource(source, { originUrl } = {}) {
  return docNameFromLocator(originUrl) || docNameFromLocator(source) || "source";
}

/**
 * Register bytes into raw/ (FR-017). Content arrives EITHER inline
 * (`content`, for short already-in-context text) OR by reference
 * (`sourcePath`, a VFS path `web_fetch`/`file_to_markdown` already staged).
 * sourcePath is the mechanism that keeps a large source out of the calling
 * model's context entirely: the caller passes a path, not the document.
 *
 * raw/ is APPEND-ONLY (NFR-006). A re-registered name is versioned to
 * `<base>.v2.<ext>`, never overwritten — a changed source gets a new version
 * and the old bytes stay exactly as they were.
 */
async function addRawSource(bundleRoot, bundleName, { filename, content, sourcePath, conceptId, title, originUrl, maxChunkSize } = {}) {
  const bDir = bundleDir(bundleRoot, bundleName);
  if (!(await vfs.exists(bDir))) throw new Error(`bundle not found: ${bundleName} — create it first with okf_init_bundle({name: "${bundleName}"})`);

  if (sourcePath) {
    content = await vfs.readText(sourcePath);
    if (!filename) filename = path.basename(sourcePath);
  }
  if (!filename || content === undefined) throw new Error("filename and one of content/sourcePath are required");

  const safeName = path.basename(filename);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  let finalName = safeName;
  let n = 1;
  while (await vfs.exists(safeJoin(bDir, "raw", finalName))) {
    n++;
    finalName = `${base}.v${n}${ext}`;
  }
  await vfs.writeText(safeJoin(bDir, "raw", finalName), content);

  // The document's real origin, when there is one — the id, the ledger's
  // record of it and the ledger key are all derived from this ONE value.
  const origin = originUrl || (sourcePath && /^https?:\/\//i.test(sourcePath) ? sourcePath : null);
  const docId = conceptId || docIdForSource(safeName, { originUrl: origin });
  const ledgerEntry = await recordSource(bDir, origin || sourcePath || `raw/${finalName}`, {
    rawFile: `raw/${finalName}`,
    docId,
    originUrl: origin,
    ingestedAt: nowIso(),
  });
  await appendLog(bundleRoot, bundleName, { event: "raw_add", message: `added raw source "${finalName}"` });

  // ── the mechanical pre-split (ADR-012, FR-055) ─────────────────────────
  //
  // THIS is where chunking happens — not in `okf_ingest`. The worker is a
  // plain Node thread outside Next.js: it has no `web_fetch`, so it cannot
  // stage a URL source itself and cannot chunk one before the run. By the
  // time the run calls `okf_add_raw_source` the bytes are here, which is why
  // a URL source is chunkable at all.
  //
  // Best-effort: a chunking failure must NOT fail a registration that already
  // succeeded. raw/ holds the source either way, and the agent's fallback is
  // the pre-chunking path (read rawFile directly).
  const chunkBound = Number.isFinite(maxChunkSize) && maxChunkSize > 0 ? Math.floor(maxChunkSize) : DEFAULT_MAX_CHUNK_SIZE;
  let chunks = [];
  let chunkError = null;
  try {
    // The heading map rides the SAME pass and the same write window as the
    // chunks (ADR-014 D1/D2): the source is already in memory and already
    // being walked for heading boundaries, so recording the char offsets
    // costs nothing — and it is what lets the write path slice a chapter
    // body out of raw/ instead of having the agent re-emit it (FR-060).
    const headingMap = { sourceFile: `raw/${finalName}`, ...buildHeadingMap(content) };
    chunks = await writeChunks(bDir, docId, chunkSource(content, chunkBound), headingMap);
  } catch (err) {
    chunkError = err.message;
  }

  let concept = null;
  if (conceptId) {
    const existing = await readConceptRaw(bDir, conceptId);
    concept = await upsertConcept(bundleRoot, bundleName, conceptId, {
      title,
      body: existing ? undefined : `# ${title || conceptId}\n\n_Ingested from \`raw/${finalName}\` — chapters are written by the okf-ingest agent._\n`,
      frontmatter: {
        type: "document",
        sources: [{ id: finalName, uri: originUrl || `raw/${finalName}`, note: originUrl ? `ingested from ${originUrl}` : "ingested raw source" }],
      },
    });
  }

  // Be explicit that the source IS stored and that a null concept is normal.
  // A bare `{rawFile, concept: null}` reads as a partial failure: an agent once
  // took it to mean the content had not been saved, "fixed" that by overwriting
  // raw/ with a placeholder, and destroyed the correct state it had just made.
  const chunkNote =
    chunks.length > 1
      ? ` The source was split into ${chunks.length} chunks of at most ${chunkBound} chars under .chunks/${docId}/ — read them ONE AT A TIME with file_read, in order (chunks[0].path first), and decompose each into chapters before reading the next. Never file_read the whole rawFile.`
      : chunks.length === 1
        ? ` It fits in one chunk (${chunks[0].path}) — read the chunk or the rawFile, either is the whole source.`
        : chunkError
          ? ` Chunking did not run (${chunkError}) — read rawFile directly.`
          : "";

  // The id is ASSIGNED here, not negotiated. Everything this call already
  // wrote — .chunks/<docId>/, the ledger entry — is keyed to it, so a caller
  // that coins its own id for the stub/chapters/TOC splits one document in
  // two and leaves the TOC empty. Say the id, and say what to do with it.
  const docIdNote =
    ` This document's id is "${docId}" — use EXACTLY that: the stub at concepts/${docId}.md, every chapter as "${docId}/<chId>" with parent: ${docId}, and the TOC under ${docId}. Do not derive or invent a different one.`;

  return {
    rawFile: `raw/${finalName}`,
    bytes: content.length,
    stored: true,
    docId,
    provenance: ledgerEntry,
    concept,
    // ADR-012 / FR-055. A source within maxChunkSize yields exactly one entry,
    // so the agent's protocol is identical either way — there is no "chunked"
    // and "unchunked" branch for it to get wrong.
    chunks,
    maxChunkSize: chunkBound,
    ...(chunkError ? { chunkError } : {}),
    note: concept
      ? `Source stored (${content.length} chars) and the document stub "${concept.id}" created.${docIdNote}${chunkNote} Next: okf_ingest({bundle, source: "raw/${finalName}"}).`
      : `Source stored (${content.length} chars). concept:null is expected — no conceptId was requested, and chapters are written later by the okf-ingest agent. Do NOT re-import the content.${docIdNote}${chunkNote} Next: okf_ingest({bundle, source: "raw/${finalName}"}).`,
  };
}

/**
 * Register a downloaded non-HTML inline asset into raw/assets/<docId>/
 * (FR-020). The normal ingest path has the okf-ingest agent `web_fetch` the
 * asset straight to its final `output_path`, so the bytes never pass through
 * this worker at all — in that case `sourcePath` already IS the destination
 * and this call just records the ledger entry. When the asset was staged
 * elsewhere, the bytes are copied through the VFS raw channel.
 * raw/assets is immutable: an existing asset is never overwritten.
 */
async function addRawAsset(bundleRoot, bundleName, { docId, filename, sourcePath, originUrl } = {}) {
  if (!docId) throw new Error("docId is required for an inline asset (it scopes raw/assets/<docId>/)");
  validateConceptId(docId);
  const bDir = bundleDir(bundleRoot, bundleName);
  if (!(await vfs.exists(bDir))) throw new Error(`bundle not found: ${bundleName}`);

  const name = assetFileName(filename || sourcePath || originUrl || "asset");
  const relPath = `raw/assets/${docId}/${name}`;
  const dest = safeJoin(bDir, relPath);

  const alreadyThere = await vfs.exists(dest);
  if (!alreadyThere) {
    if (!sourcePath) {
      throw new Error(
        `asset not present at ${relPath} and no sourcePath given — have the ingest agent web_fetch it with output_path="${dest}" first`,
      );
    }
    // The SOURCE is a read, and reads are not scoped to the bundle: the
    // agent stages assets to /workspace via web_fetch({output_path}), so a
    // path outside the bundle root is the normal case, not an attack. Only
    // `dest` — which is built from safeJoin(bDir, …) above — is guarded.
    // This used to be safeJoin("/", sourcePath), which threw
    // `path escapes root: /workspace/…` on every absolute path it was ever
    // given: with a root of "/", safeJoin's containment test compares the
    // target against the prefix "//", and no real path starts with that.
    // path.resolve is what the line actually wanted — normalize to an
    // absolute path so the "already staged at the destination" comparison
    // below is comparing like with like.
    const staged = path.resolve("/", sourcePath);
    if (staged !== dest) {
      const { buffer, contentType } = await vfs.readRaw(staged);
      await vfs.writeBinary(dest, buffer, contentType);
    }
  }

  const entry = await recordSource(bDir, originUrl || relPath, {
    rawFile: relPath,
    docId,
    kind: "asset",
    assetKind: assetKind(relPath),
    originUrl: originUrl || null,
    ingestedAt: nowIso(),
  });
  await appendLog(bundleRoot, bundleName, { event: "asset_add", message: `registered inline asset "${relPath}"` });
  return {
    assetPath: relPath,
    stored: true,
    kind: assetKind(relPath),
    contentType: assetContentType(relPath),
    provenance: entry,
    blockTemplate: assetBlockMarkdown({ assetPath: relPath, caption: name, interpretation: "" }),
    note: "Now call view_image (image) or video_keyframes (video) on the stored copy, and write the link + the interpretation blockquote into the owning chapter via okf_upsert_concept. The interpretation is written ONCE, at ingest — retrieval must never need to re-run vision.",
  };
}

/** Serve an inline asset's bytes (the app's asset-proxy route, ADR-008). */
async function readAsset(bundleRoot, bundleName, assetPath) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const rel = String(assetPath || "").replace(/^\/+/, "");
  if (!rel.startsWith("raw/")) throw new Error(`not an asset path: ${assetPath}`);
  const abs = safeJoin(bDir, rel); // throws on traversal outside the bundle
  const { buffer, contentType } = await vfs.readRaw(abs);
  return { buffer, contentType: contentType === "application/octet-stream" ? assetContentType(rel) : contentType };
}

// ── health: stale report + lint (FR-033/FR-034) ──────────────────────────

async function staleReport(bundleRoot, bundleName) {
  const model = await getModel(bundleRoot, bundleName);
  const now = Date.now();
  const out = [];
  for (const ch of model.classified.chapters) {
    const deprecated = ch.status === "deprecated";
    if (!ch.stale && !deprecated) continue;
    const staleAt = Date.parse(ch.frontmatter.stale_after || "");
    out.push({
      id: ch.id,
      docId: ch.docId,
      title: ch.title,
      docTitle: (model.classified.documents.get(ch.docId) || {}).title || ch.docId,
      status: ch.status,
      reason: ch.stale ? "past stale_after" : "deprecated",
      staleAfter: ch.frontmatter.stale_after || null,
      daysStale: Number.isNaN(staleAt) ? null : Math.max(0, Math.floor((now - staleAt) / 86400000)),
    });
  }
  return out;
}

/**
 * Lint (FR-033 / SC-010). Because both index levels are DERIVED, drift is
 * reported and then REBUILT — never hand-patched. The checks are exactly the
 * four failure modes the derived model can have, plus the sidecar/body
 * reconciliation that okf_add_link's double write makes possible.
 */
async function lintBundle(bundleRoot, bundleName) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const model = await getModel(bundleRoot, bundleName, { allowRebuild: false });
  const errors = [];
  const warnings = [];

  // 1. concept-index / document-TOC drift against the underlying content
  const storedIndexRaw = await vfs.readText(safeJoin(bDir, "concept-index.md")).catch(() => null);
  const storedIndex = storedIndexRaw ? parseFrontmatter(storedIndexRaw).frontmatter : null;
  const freshTerms = buildConceptIndex(model.classified);
  const storedTerms = storedIndex && Array.isArray(storedIndex.terms) ? storedIndex.terms : [];
  const indexStamp = Date.parse((storedIndex && storedIndex.index_generated_at) || "");
  const newestWrite = newestChapterStamp(model.classified);
  let indexDrift = 0;
  if (!storedIndexRaw) {
    warnings.push({ check: "concept-index", issue: "no concept-index.md — it will be generated on the next read (derived artifact)" });
    indexDrift = freshTerms.length;
  } else {
    if (!Number.isNaN(indexStamp) && newestWrite > indexStamp) {
      warnings.push({ check: "concept-index", issue: `index_generated_at (${storedIndex.index_generated_at}) is older than the newest chapter write — stale, rebuild pending` });
    }
    const storedKeys = new Set(storedTerms.map((t) => `${t.name}:${(t.covers || []).length}`));
    const freshKeys = new Set(freshTerms.map((t) => `${t.name}:${t.covers.length}`));
    for (const k of freshKeys) if (!storedKeys.has(k)) indexDrift++;
    for (const k of storedKeys) if (!freshKeys.has(k)) indexDrift++;
    if (indexDrift) warnings.push({ check: "concept-index", issue: `${indexDrift} term row(s) drifted from chapter frontmatter — rebuilt, not patched` });
  }

  let tocDrift = 0;
  for (const [docId, toc] of model.tocByDoc) {
    const raw = await vfs.readText(safeJoin(bDir, "toc", `${docId}.md`)).catch(() => null);
    if (!raw) {
      tocDrift++;
      warnings.push({ check: "document-toc", docId, issue: `no toc/${docId}.md — will be generated on the next read` });
      continue;
    }
    const stored = parseFrontmatter(raw).frontmatter;
    if (!Array.isArray(stored.chapters) || stored.chapters.length !== toc.chapters.length) {
      tocDrift++;
      warnings.push({ check: "document-toc", docId, issue: `toc/${docId}.md lists ${Array.isArray(stored.chapters) ? stored.chapters.length : 0} chapter(s), content has ${toc.chapters.length}` });
    }
  }
  const tocFiles = await vfs.list(safeJoin(bDir, "toc")).catch(() => []);
  for (const e of tocFiles) {
    if (e.type === "dir" || !e.name.endsWith(".md")) continue;
    const docId = e.name.slice(0, -3);
    if (!model.tocByDoc.has(docId)) {
      tocDrift++;
      warnings.push({ check: "document-toc", docId, issue: `toc/${e.name} points at a document that no longer exists — dangling` });
    }
  }

  // 2. broken inline-asset links
  let brokenAssets = 0;
  for (const ch of model.classified.chapters) {
    for (const a of extractAssets(ch.body)) {
      if (!(await vfs.exists(safeJoin(bDir, a.path)))) {
        brokenAssets++;
        errors.push({ check: "inline-asset", conceptId: ch.id, issue: `broken inline-asset link: ${a.path} is not in raw/` });
      } else if (!a.interpretationAvailable) {
        warnings.push({ check: "inline-asset", conceptId: ch.id, issue: `asset ${a.path} has no usable stored interpretation — retrieval cannot carry its knowledge` });
      }
    }
  }

  // 3. orphan chapters (no parent document) + partial routing frontmatter
  let orphans = 0;
  for (const ch of model.classified.chapters) {
    const doc = model.classified.documents.get(ch.docId);
    if (!doc || doc.synthetic) {
      orphans++;
      errors.push({ check: "orphan-chapter", conceptId: ch.id, issue: `chapter has no document stub at concepts/${ch.docId}.md` });
    }
    if (!ch.concepts.length) warnings.push({ check: "routing", conceptId: ch.id, issue: "no `concepts` terms — this chapter is unreachable by okf_search" });
    if (!ch.summary) warnings.push({ check: "routing", conceptId: ch.id, issue: "no `summary` — its index row has no description to match against" });
  }

  // 4. links.json vs. markdown-link drift (okf_add_link writes both)
  const sidecar = await readLinksSidecar(bDir);
  const g = await ensureGraph(bDir);
  let linkDrift = 0;
  const allIds = new Set(model.classified.ids);
  for (const e of sidecar) {
    const inBody = (g.forward.get(e.from) || new Set()).has(e.to);
    if (!inBody) {
      linkDrift++;
      warnings.push({ check: "links", issue: `links.json has ${e.from} → ${e.to} but the chapter body does not` });
    }
    if (!allIds.has(e.to)) {
      linkDrift++;
      warnings.push({ check: "links", issue: `links.json edge ${e.from} → ${e.to} points at a concept that does not exist` });
    }
  }
  for (const [from, targets] of g.forward) {
    for (const to of targets) {
      if (!allIds.has(to)) warnings.push({ check: "links", conceptId: from, issue: `broken markdown link to "${to}"` });
    }
  }

  // 5. heading-map drift (ADR-014 Risk #2). The extractor fails LOUD on a
  //    map that disagrees with the bytes it describes — which is right at
  //    write time, but means the first symptom is a failed chapter write in
  //    the middle of a run. Lint reports it up front instead, per document.
  let headingMapDrift = 0;
  const chunkDocs = await vfs.list(safeJoin(bDir, CHUNKS_DIR)).catch(() => []);
  for (const e of chunkDocs) {
    if (e.type !== "dir") continue;
    const probe = await readHeadingMap(bDir, e.name).then(() => null, (err) => err);
    if (!probe) continue;
    // A document whose chunks pre-date the heading map simply has no map —
    // that is the pre-ADR-014 state, not drift, and the body path still
    // works for it. Only a map that CONTRADICTS raw/ is a finding.
    if (/^no heading map at /.test(probe.message)) continue;
    headingMapDrift++;
    warnings.push({
      check: "heading-map",
      docId: e.name,
      issue: `${probe.message} Until it is rebuilt, okf_upsert_concept({sourceRange}) will refuse to write chapters for this document.`,
    });
  }

  if (indexDrift || tocDrift) await rebuildDerived(bundleRoot, bundleName);

  return {
    bundle: bundleName,
    documents: model.classified.documents.size,
    chapters: model.classified.chapters.length,
    conceptTerms: freshTerms.length,
    checks: {
      conceptIndexDrift: indexDrift,
      documentTocDrift: tocDrift,
      brokenInlineAssets: brokenAssets,
      orphanChapters: orphans,
      linksDrift: linkDrift,
      headingMapDrift,
    },
    rebuilt: !!(indexDrift || tocDrift),
    indexNeedsRegeneration: model.needsRegeneration,
    errors,
    warnings,
    checkedAt: nowIso(),
  };
}

// ════════════════════════════════════════════════════════════════════════
//  JOBS (T007 / ADR-006) — global ingest-run records
// ════════════════════════════════════════════════════════════════════════
//
// Jobs are SERVICE-LEVEL, not bundle-level (plan.md open item #2): the app's
// Jobs tab is global, a single user runs one service, and a run's job must
// survive the bundle it targets being deleted mid-flight. They live in one
// `jobs.json` under the bundle root's `.jobs/` directory — operational state,
// deliberately NOT part of the OKF content contract, so it is never included
// in an export (design.md Risk #2, resolved: exclude).
//
// The lifecycle crosses a thread boundary the service cannot see across. The
// worker mints the job when `okf_ingest` is called; the okf-ingest sub-agent
// runs in the MAIN Next.js process and reports back over this service's own
// loopback HTTP bridge (start/complete/fail). The calling assistant's
// safety-net closes the gap if the sub-agent dies without reporting.

const JOBS_DIR = ".jobs";
const JOBS_FILE = "jobs.json";
const JOB_HISTORY_LIMIT = 200;

let jobsState = null; // { jobs: [...], seq: n } — hot map, mirrored to disk

function jobsPath(bundleRoot) {
  return safeJoin(bundleRoot, JOBS_DIR, JOBS_FILE);
}

/**
 * Drop the hot map so the next `loadJobs` reads from disk again.
 *
 * The cache is module-level and NOT keyed by bundleRoot, so it has to be
 * dropped whenever the root it was loaded for stops being the current one —
 * a config change, or a test that wants a cold store. Nothing is lost:
 * every mutation persists through `persistJobs` before this can matter.
 */
function resetJobStore() {
  jobsState = null;
}

async function loadJobs(bundleRoot) {
  if (jobsState) return jobsState;
  const raw = await vfs.readText(jobsPath(bundleRoot)).catch(() => null);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.jobs)) {
        // `trajectory` round-trips as a plain JSON array (FR-057). A record
        // written before the field existed — or by a service that failed
        // mid-write — comes back without it, and every reader downstream
        // (GET /jobs/<id>, the app) is entitled to an array, not undefined.
        for (const job of parsed.jobs) {
          if (!Array.isArray(job.trajectory)) job.trajectory = [];
          // A store written before reasoning was merged holds one event per
          // token (8.4 MB on production); compact it on the way in.
          else if (job.trajectory.some((e) => e && e.type === "reasoning_delta")) {
            const compacted = [];
            for (const e of job.trajectory) pushTrajectoryEvent(compacted, e);
            job.trajectory = compacted;
          }
          // The reaper's inactivity clock (FR-059) must survive a restart —
          // it is persisted with the rest of the record, but a record
          // written before the field existed comes back without it. Null,
          // not undefined: the reaper falls back to startedAt/queuedAt.
          if (job.lastEventAt === undefined) job.lastEventAt = null;
        }
        jobsState = { jobs: parsed.jobs, seq: Number(parsed.seq) || parsed.jobs.length };
        return jobsState;
      }
    } catch {
      /* corrupt file: start clean rather than refusing to run ingests */
    }
  }
  jobsState = { jobs: [], seq: 1000 };
  return jobsState;
}

async function persistJobs(bundleRoot) {
  if (!jobsState) return;
  if (jobsState.jobs.length > JOB_HISTORY_LIMIT) jobsState.jobs = jobsState.jobs.slice(0, JOB_HISTORY_LIMIT);
  await vfs.writeText(jobsPath(bundleRoot), JSON.stringify(jobsState, null, 2) + "\n").catch(() => {
    /* best effort — a job record must never fail the ingest it describes */
  });
}

// Trajectory events arrive one per NDJSON line and `persistJobs` rewrites the
// whole store, so the two together would mean a full-file write per line of a
// live run. These coalesce instead: write immediately when the store has been
// quiet, otherwise schedule ONE trailing write for the end of the window. A
// restart can therefore lose at most the last quarter-second of a trajectory,
// which is the point of persisting incrementally in the first place — the
// terminal transition always persists synchronously through updateJob.
const TRAJECTORY_PERSIST_MS = 250;
let persistPending = null;
let lastPersistAt = 0;

function schedulePersistJobs(bundleRoot) {
  const now = Date.now();
  const waited = now - lastPersistAt;
  if (waited >= TRAJECTORY_PERSIST_MS) {
    lastPersistAt = now;
    return persistJobs(bundleRoot);
  }
  if (persistPending) return persistPending;
  persistPending = new Promise((resolve) => {
    setTimeout(() => {
      persistPending = null;
      lastPersistAt = Date.now();
      void persistJobs(bundleRoot).then(resolve, resolve);
    }, TRAJECTORY_PERSIST_MS - waited);
  });
  return persistPending;
}

async function createJob(bundleRoot, { bundleId, source, maxDepth, maxWorkers, parentJobId, reingestDocId }) {
  const state = await loadJobs(bundleRoot);
  state.seq++;
  const job = {
    id: `run-${state.seq}`,
    status: "queued",
    bundleId,
    source,
    maxDepth: maxDepth ?? null,
    maxWorkers: maxWorkers ?? null,
    // The job whose run started this one by following a reference — null for
    // an ingest a user or an outside agent asked for. See triggerIngest.
    parentJobId: parentJobId ?? null,
    // Set for a RE-ingest: the document this run replaces. It is cleared when
    // the run STARTS (not when it is queued), then rewritten under the same id.
    reingestDocId: reingestDocId ?? null,
    queuedAt: nowIso(),
    startedAt: null,
    // Last captured trajectory event (FR-049): the reaper's staleness clock.
    // Null until the run produces its first event — `startedAt` covers that
    // window, so a run that never says anything is still reapable.
    lastEventAt: null,
    endedAt: null,
    durationMs: null,
    progress: null,
    summary: null,
    error: null,
    // The handle the cancel path needs (FR-052): captured from the run's own
    // `run_started` line by the launcher, so it is null for exactly as long
    // as the run has not started. `cancelRequested` covers that window — a
    // cancel arriving before the runId exists is remembered, and the launcher
    // fires the abort the moment it learns the id (ADR-010 S4).
    runId: null,
    cancelRequested: false,
    // The run's NDJSON stream, captured verbatim and in order by the launcher
    // (FR-057, ADR-013). Empty for a run that produced no events at all —
    // which is the ONLY case the app's "No trajectory captured" note covers.
    trajectory: [],
  };
  state.jobs.unshift(job);
  await persistJobs(bundleRoot);
  return job;
}

/**
 * A job as a LIST row: the whole record except the trajectory, which is
 * replaced by its length.
 *
 * The trajectory is per-run debug detail measured in tens of kilobytes. The
 * list is polled by the app every few seconds and returned wholesale by
 * `okf_list_jobs`, so shipping every run's events on every list call would
 * put megabytes through a 3-second poll and through an agent's context, to
 * render a column nobody asked for. `GET /jobs/<id>` — the detail read, one
 * run at a time — is where the full trajectory lives (ADR-013).
 */
function jobListView(job) {
  const { trajectory, ...rest } = job;
  return { ...rest, trajectoryEvents: Array.isArray(trajectory) ? trajectory.length : 0 };
}

async function listJobs(bundleRoot, { bundleId, status, limit, includeTrajectory = false } = {}) {
  const state = await loadJobs(bundleRoot);
  let jobs = state.jobs;
  if (bundleId) jobs = jobs.filter((j) => j.bundleId === bundleId);
  if (status) jobs = jobs.filter((j) => j.status === status);
  if (Number.isFinite(limit) && limit > 0) jobs = jobs.slice(0, limit);
  return includeTrajectory ? jobs : jobs.map(jobListView);
}

async function getJob(bundleRoot, id) {
  const state = await loadJobs(bundleRoot);
  return state.jobs.find((j) => j.id === id) || null;
}

/**
 * Append ONE captured stream event to a job's trajectory (FR-057, ADR-013).
 *
 * The event is stored exactly as it came off the wire — `{type:"tool", tool,
 * input}`, `{type:"tool_result", …}`, `{type:"done", result}` and the rest —
 * because the whole value of an audit log is that nothing on the way in got
 * to decide what mattered.
 *
 * It does NOT go through `updateJob`: a trajectory event is not a lifecycle
 * transition, and a terminal job must still be allowed to record the `done`
 * line that made it terminal.
 */
/**
 * Append one stream event to a trajectory — THE rule for what a trajectory
 * holds, shared by the live launcher (appendJobTrajectory) and the cold load
 * (loadJobs), so a store written by an older service converges on it.
 *
 * Reasoning arrives one TOKEN per line. Stored as-is the trajectory became a
 * token log — 33,089 of one run's 33,186 events — and the job store grew until
 * the worker hit its heap limit. A run of consecutive reasoning lines is kept
 * as ONE event with the joined text: the same words in the same place in the
 * sequence, and any other event ends the run, so the tool / tool_result pairing
 * the Jobs tab renders is untouched.
 */
function pushTrajectoryEvent(trajectory, event) {
  const last = trajectory[trajectory.length - 1];
  if (event && event.type === "reasoning_delta" && last && last.type === "reasoning_delta") {
    for (const key of ["delta", "text"]) {
      if (typeof event[key] === "string") last[key] = (typeof last[key] === "string" ? last[key] : "") + event[key];
    }
    return;
  }
  // a copy: a later merge must never write into the caller's event object
  trajectory.push(event && event.type === "reasoning_delta" ? { ...event } : event);
}

async function appendJobTrajectory(bundleRoot, id, event) {
  if (!event || typeof event !== "object") return null;
  const state = await loadJobs(bundleRoot);
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return null;
  if (!Array.isArray(job.trajectory)) job.trajectory = [];
  pushTrajectoryEvent(job.trajectory, event);
  // THE LIVENESS STAMP the stale reaper reads (FR-049). An event is the only
  // honest evidence that the run is still alive, so it is recorded here, at
  // the one place every event passes through. It rides the SAME coalesced
  // write as the trajectory it belongs to — `schedulePersistJobs` already
  // caps the store at one write per TRAJECTORY_PERSIST_MS, so stamping each
  // event costs no additional I/O, and the terminal transition flushes it
  // synchronously through `updateJob`'s own `persistJobs`.
  job.lastEventAt = nowIso();
  await schedulePersistJobs(bundleRoot);
  return job;
}

// `cancelled` is TERMINAL and is NOT a failure (FR-050): an intentional stop
// carries `error: null`, because writing a reason into `error` would make the
// Jobs tab render a red failure card for something the user asked for. The
// stale reaper never sees a cancelled job for the same reason it never sees a
// completed one — it only reaps what is still non-terminal.
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const JOB_STATUSES = ["queued", "running", "completed", "failed", "cancelled"];

/**
 * Apply a lifecycle transition. Terminal states are FINAL: a late callback
 * (the sub-agent reporting after the assistant's safety-net already failed
 * the run, or vice-versa) is recorded as a no-op rather than resurrecting a
 * finished run — which is what makes it safe for BOTH paths to report.
 */
async function updateJob(bundleRoot, id, patch = {}) {
  const state = await loadJobs(bundleRoot);
  const job = state.jobs.find((j) => j.id === id);
  if (!job) throw new Error(`job not found: ${id}`);

  if (patch.status !== undefined && !JOB_STATUSES.includes(patch.status)) {
    throw new Error(`invalid job status: ${patch.status} (expected ${JOB_STATUSES.join(" | ")})`);
  }
  if (TERMINAL.has(job.status) && patch.status && patch.status !== job.status) {
    return { ...job, ignored: true, reason: `job is already ${job.status}; a terminal state is final` };
  }

  if (patch.progress !== undefined) job.progress = patch.progress;
  if (patch.summary !== undefined) job.summary = patch.summary;
  if (patch.error !== undefined) job.error = patch.error;
  if (patch.runId !== undefined) job.runId = patch.runId;
  if (patch.cancelRequested !== undefined) job.cancelRequested = !!patch.cancelRequested;
  if (patch.trajectory !== undefined) job.trajectory = Array.isArray(patch.trajectory) ? patch.trajectory : [];
  if (!Array.isArray(job.trajectory)) job.trajectory = [];
  // A cancellation is not an error — whatever a late stream signal would have
  // written, a cancelled job's `error` stays null (FR-050).
  if (patch.status === "cancelled") job.error = null;

  if (patch.status === "running" && job.status !== "running") {
    job.status = "running";
    job.startedAt = job.startedAt || nowIso();
  } else if (patch.status && TERMINAL.has(patch.status)) {
    job.status = patch.status;
    job.startedAt = job.startedAt || job.queuedAt;
    job.endedAt = nowIso();
    const started = Date.parse(job.startedAt);
    job.durationMs = Number.isNaN(started) ? null : Date.parse(job.endedAt) - started;
    job.progress = null;
  } else if (patch.status) {
    job.status = patch.status;
  }

  await persistJobs(bundleRoot);
  return job;
}

// ── JOB CONTROL: cancel & delete (FR-050 / FR-051) ───────────────────────
//
// Both live HERE, in the core, and not in the tools layer or the HTTP
// bridge — because both of those surfaces drive them (ADR-003: one
// capability, two surfaces). `okf_cancel_job` and `POST /jobs/<id>/cancel`
// are the same function called from two places, exactly like okf_search and
// `GET /bundles/<b>/search`.
//
// The status codes travel ON the error (`err.statusCode`), so the REST
// bridge answers 404/409 without pattern-matching message text, and the tool
// surface — which has no HTTP — still gets a message that names the reason.

function jobError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * Cancel a queued or running ingest run (FR-050).
 *
 * The run itself lives in the main Next.js process; this worker only holds
 * its `runId`, so the abort goes through the platform's generic
 * `POST /api/subagents/<runId>/abort` route (FR-052) over loopback.
 *
 * Two windows, both covered:
 *   • the runId IS captured  -> abort it now;
 *   • the runId is NOT yet captured (the job is queued, or running but the
 *     `run_started` line has not arrived) -> record `cancelRequested`, and
 *     the launcher fires the abort the instant it learns the id.
 *
 * Either way the job goes `cancelled` IMMEDIATELY: the user asked for a stop
 * and the record must say so, rather than waiting on a round trip to a run
 * that may already be gone. A late terminal signal from the stream cannot
 * undo it — terminal states are final (ADR-006).
 */
async function cancelJob(bundleRoot, id) {
  const delegate = require("./delegate-bridge");
  const state = await loadJobs(bundleRoot);
  const job = state.jobs.find((j) => j.id === id);
  if (!job) throw jobError(`job not found: ${id}`, 404);
  if (TERMINAL.has(job.status)) {
    throw jobError(
      `job ${id} is already ${job.status} — a terminal state is final, so there is nothing to cancel`,
      409,
    );
  }

  let aborted = false;
  let abortError = null;

  if (job.runId) {
    try {
      const result = await delegate.abortRun(job.runId);
      aborted = !!(result && result.aborted);
      if (!aborted) abortError = (result && result.error) || "the platform reported no live run for that runId";
    } catch (err) {
      // The abort call failing does NOT make the cancel fail: the user's
      // intent is recorded either way, and a run whose abort we could not
      // deliver still ends — it just ends on its own terms. Saying the job
      // is still running would be the bigger lie.
      abortError = err.message;
    }
  } else {
    job.cancelRequested = true;
    await persistJobs(bundleRoot);
  }

  const updated = await updateJob(bundleRoot, id, { status: "cancelled", error: null, progress: null });
  return {
    ...updated,
    cancelled: true,
    aborted,
    abortError,
    runId: job.runId || null,
    cancelRequested: !!job.cancelRequested,
    note: job.runId
      ? aborted
        ? `Run ${id} was aborted and the job is now cancelled. Anything the run already wrote is still in the bundle — a cancel never removes content.`
        : `Job ${id} is cancelled. The abort could not be confirmed (${abortError}); the run had most likely already ended.`
      : `Job ${id} is cancelled before its run reported a runId. The launcher aborts the run the moment it learns the id.`,
  };
}

/**
 * Delete a TERMINAL ingest run's record (FR-051).
 *
 * This removes the job record and nothing else — never a chapter, never the
 * index, never raw/. An active job is refused rather than silently orphaning
 * a live run: cancel it first, which is the whole reason cancel exists.
 */
async function deleteJob(bundleRoot, id) {
  const state = await loadJobs(bundleRoot);
  const index = state.jobs.findIndex((j) => j.id === id);
  if (index === -1) throw jobError(`job not found: ${id}`, 404);

  const job = state.jobs[index];
  if (!TERMINAL.has(job.status)) {
    throw jobError(`job ${id} is still ${job.status} — cancel it first, then delete it`, 409);
  }

  // Out of the hot map AND out of the file it is mirrored to: persistJobs
  // rewrites jobs.json from this array, so one splice covers both.
  state.jobs.splice(index, 1);
  await persistJobs(bundleRoot);

  return {
    deleted: true,
    jobId: id,
    status: job.status,
    bundleId: job.bundleId,
    note: "The run record is gone. Bundle content the run wrote (chapters, index, TOCs, raw/) is untouched — deleting a job never deletes knowledge.",
  };
}

// ════════════════════════════════════════════════════════════════════════
//  THE AUTO-TRIGGER (core.triggerIngest) + THE STALE REAPER
// ════════════════════════════════════════════════════════════════════════
//
// ── What changed, and why ────────────────────────────────────────────────
//
// `okf_ingest` used to be a DISPATCHER: it validated the source, minted a
// job, and returned an instruction block — `acquisition_required` with steps
// to run, or `delegation_required` with an agent_delegate call to issue. The
// caller then had to execute that ritual correctly, three calls deep, and the
// job's terminal state depended on the sub-agent remembering to POST its own
// lifecycle callbacks.
//
// That shape existed for one reason: the worker thread has no agent loop, so
// it could not start a run. But BOS exposes `/api/subagents/delegate` over
// plain loopback HTTP — the same transport this module already uses to reach
// `/api/fs`. The worker CAN start a run; it just wasn't asking.
//
// So `okf_ingest` is now an AUTO-TRIGGER:
//
//   okf_ingest({bundle, source})  ->  {jobId, status: "queued"}   [returns NOW]
//                                      \
//                                       `- the run proceeds in the background
//
// Three consequences worth naming:
//
//  1. **The caller is freed.** triggerIngest returns as soon as the job is
//     created. The delegate stream is consumed by a detached async task, so
//     the invoking assistant's turn is not held open for a multi-minute run.
//     This is why there is no `await` on `driveRun()` below — that is
//     deliberate, not an oversight.
//
//  2. **The LAUNCHER owns the terminal state**, derived from the run's own
//     signal (`result.endedReason`), not from the agent's good manners. An
//     agent that dies, loops, or forgets to report still gets an honest job
//     record. The agent's only job-facing duty is its final summary text.
//
//  3. **Acquisition moved into the task, not the caller.** The per-source
//     first steps (web_fetch / file_to_markdown / okf_add_raw_source) are
//     written into the sub-agent's task, each pinning `output_path`. That
//     parameter is still the whole mechanism — it is what makes the source
//     stream to disk instead of being re-emitted as output tokens — but it
//     is now pinned by the service, where it cannot be forgotten, instead of
//     by whoever reads the instruction block.

const CONVERTIBLE = /\.(pdf|docx|pptx|xlsx|doc|ppt|xls)$/i;

/**
 * A URL's path, with query and fragment removed, so an extension test can be
 * anchored at the end of it: `…/report.pdf?raw=true` is still a PDF.
 */
function stripUrlSuffix(source) {
  return String(source).replace(/[?#].*$/, "").replace(/\/+$/, "");
}

/** Filesystem-safe slug for the staged copy's filename. */
function stagedName(source) {
  const base =
    String(source)
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean)
      .pop() || "source";
  const slug = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "source";
  return slug.replace(CONVERTIBLE, "") + ".md";
}

/**
 * The acquisition FIRST STEPS for a source, as literal tool calls for the
 * sub-agent's task. Returns [] when the source is already in the bundle's
 * raw/ (nothing to acquire).
 *
 * Every step pins `output_path`. Without it the acquisition tool returns the
 * document as a tool result and the only way to store it is for the model to
 * re-emit the whole thing — the exact cost this pipeline exists to remove.
 */
function acquisitionFirstSteps(bundle, source) {
  const isUrl = /^https?:\/\//i.test(source);
  const isAbsPath = source.startsWith("/");
  if (!isUrl && !isAbsPath) return []; // a raw/ path — already in the bundle

  const steps = [];
  let sourcePath;

  if (isUrl) {
    const convertible = CONVERTIBLE.test(stripUrlSuffix(source));
    // A convertible URL (PDF, DOCX, …) downloads as BINARY. The download path
    // must keep the source's REAL extension so file_to_markdown can detect the
    // format from the file — a .pdf saved as .md is treated as already-markdown
    // and returned unconverted (raw PDF bytes → garbage chunks). Non-convertible
    // URLs (HTML/MD) keep the .md staging name.
    const mdName = stagedName(source).replace(/\.md$/i, ""); // slug without .md
    const ext = convertible ? stripUrlSuffix(source).match(CONVERTIBLE)[0].toLowerCase() : ".md";
    const staged = `/workspace/okf-staged-${mdName}${ext}`;
    steps.push({ tool: "web_fetch", args: { url: source, output_path: staged } });
    if (convertible) {
      const converted = `/workspace/okf-staged-${mdName}.md`;
      steps.push({ tool: "file_to_markdown", args: { path: staged, output_path: converted } });
      sourcePath = converted;
    } else {
      sourcePath = staged;
    }
  } else if (CONVERTIBLE.test(source)) {
    const staged = `/workspace/okf-staged-${stagedName(source)}`;
    steps.push({ tool: "file_to_markdown", args: { path: source, output_path: staged } });
    sourcePath = staged;
  } else {
    sourcePath = source;
  }

  steps.push({
    tool: "okf_add_raw_source",
    args: { bundle, sourcePath, ...(isUrl ? { originUrl: source } : {}) },
  });
  return steps;
}

function renderSteps(steps) {
  return steps.map((s, i) => `${i + 1}. \`${s.tool}(${JSON.stringify(s.args)})\``).join("\n");
}

/** The sub-agent task for one ingest run. Embeds jobId / bundle / source. */
function buildIngestTask({ jobId, bundle, source, maxDepth, maxWorkers, prepared }) {
  const steps = acquisitionFirstSteps(bundle, source);
  const acquisition = steps.length
    ? `## Step 0 — acquire the source (do this FIRST, exactly as written)\n\n${renderSteps(steps)}\n\n` +
      `Run those calls verbatim. \`output_path\` is pinned on purpose: with it the source streams to disk and the tool ` +
      `returns a receipt, so the document never passes through your context. Do NOT drop it and paste the content into ` +
      `\`okf_add_raw_source({content})\` instead — that re-emits the entire document as output tokens for no benefit. ` +
      `\`okf_add_raw_source\` returns the \`rawFile\` path, a \`docId\` AND a \`chunks\` array — see "The document id" ` +
      `and "Chunk processing" below; the chunks are what you decompose, not the whole \`rawFile\`.\n\n`
    : prepared
      ? `## Step 0 — the source is already in the bundle, and already split\n\nIt is \`${source}\`. Do NOT ` +
        `\`okf_add_raw_source\` it again and do not re-fetch it: the service has already split it for this run. Its ` +
        `\`docId\` is \`${prepared.docId}\`, and its chunks are, in order:\n\n` +
        prepared.chunks.map((c) => `- \`${c.path}\``).join("\n") +
        `\n\nRead them ONE AT A TIME with \`file_read\` (see "Chunk processing"); their \`headings\` lists are the ` +
        `indices your \`sourceRange\` refers to.\n\n`
      : `## Step 0 — the source is already in the bundle\n\nIt is at \`${source}\`. Read it from there with \`file_read\`; ` +
        `do not expect it inline and do not re-fetch it. Its \`docId\` is \`${docIdForSource(source)}\` — unless ` +
        `\`raw/sources.json\` already records a different one for this file, in which case that recorded id wins.\n\n`;

  return (
    `Ingest \`${source}\` into the OKF bundle "${bundle}" as organized chapters.\n\n` +
    `jobId: ${jobId}\nbundle: ${bundle}\nsource: ${source}\nmaxDepth: ${maxDepth}\nmaxWorkers: ${maxWorkers}\n\n` +
    acquisition +
    `## The document id — ONE id, and you do not choose it\n\n` +
    `\`okf_add_raw_source\`'s response carries a \`docId\`. That string is the document's id, already assigned: the ` +
    `chunk directory (\`.chunks/<docId>/\`) and the provenance ledger entry are keyed to it before you see it. Use ` +
    `**that exact \`docId\`**, verbatim, for ALL of:\n\n` +
    `- the document stub — \`okf_upsert_concept({id: "<docId>"})\` → \`concepts/<docId>.md\`\n` +
    `- every chapter — \`id: "<docId>/<chId>"\` and \`parent: "<docId>"\` in its frontmatter\n` +
    `- the document TOC — \`toc/<docId>.md\`, and any \`okf_read_toc({docId})\`\n` +
    `- any inline asset — \`okf_add_raw_source({asset: true, docId, …})\` → \`raw/assets/<docId>/\`\n\n` +
    `Do NOT derive, prettify or invent an id of your own — not from the document's title, not from the URL. An id you ` +
    `coin keys the stub and the TOC to one document while the chunks and the ledger stay keyed to another, and the ` +
    `TOC of the document you just wrote comes out EMPTY. If the returned \`docId\` looks wrong, use it anyway and say ` +
    `so in your summary.\n\n` +
    `## Chunk processing (ADR-012)\n\n` +
    `\`okf_add_raw_source\`'s response carries \`chunks\`: \`[{path, ordinal, total}]\`, the source already split ` +
    `mechanically into pieces of at most \`maxChunkSize\` characters. Process them SEQUENTIALLY — \`file_read\` ` +
    `\`chunks[0].path\`, decompose THAT chunk into chapters and write them with \`okf_upsert_concept\`, then read ` +
    `\`chunks[1].path\`, and so on to the last. Each chunk's \`headingPath\` frontmatter tells you where in the ` +
    `document you are. Write the DOCUMENT STUB after the first chunk; write the TOC and let the index rebuild after ` +
    `the LAST chunk. Do NOT \`file_read\` the whole \`rawFile\` when \`total > 1\` — reading a large source in one ` +
    `call is what exhausts the context before anything is written. A chunk is a context window, not a chapter: a ` +
    `section split across two chunks is still ONE chapter. With \`total: 1\` this is exactly the ordinary path.\n\n` +
    `## Then do the whole job\n\n` +
    `\`<docId>\` below is always the id from the \`okf_add_raw_source\` response (see "The document id"), never one ` +
    `of your own making. Decompose the source at its natural heading structure into chapters (\`concepts/<docId>/<chId>.md\`, ` +
    `\`type: section\`), each carrying \`parent\`, the \`concepts\` terms it covers and a one-line \`summary\` — those ` +
    `three fields are what the concept index and the document TOC are derived from. Upsert the document stub ` +
    `(\`concepts/<docId>.md\`, \`type: document\`) with the original URL in \`sources[].uri\` so the app's "Open source" ` +
    `link has a target. Check \`okf_list_concepts\` before coining a term: extend before you create.\n\n` +
    `For every NON-HTML asset in a chapter's scope: \`web_fetch\` it with \`output_path\` into ` +
    `\`raw/assets/<docId>/\`, register it with \`okf_add_raw_source({asset:true, docId, sourcePath})\`, interpret it ` +
    `with \`view_image\` or \`video_keyframes\`, and write the stored link plus a ` +
    `\`> **Interpretation (LLM, at ingest):** …\` blockquote directly beneath it in the chapter body. Ordinary HTML ` +
    `hyperlinks stay remote references — do not download them. A failed asset is marked unavailable and does not fail ` +
    `the document.\n\n` +
    (maxDepth > 0
      ? `Follow at most ${maxDepth} hop(s) of references beyond this seed source, at most ${maxWorkers} at a time, each ` +
        `nested reference via its own \`okf_ingest\` call (it becomes its own job, one hop shallower than this one). ` +
        `Skip anything already in the bundle's provenance ledger.\n\n`
      : `Do NOT follow any references: this run is at the depth limit. List the references you found as skipped ` +
        `(over-depth) in your summary — an \`okf_ingest\` call from this run is refused.\n\n`) +
    `## Finishing\n\n` +
    `You do NOT finalize this job. The service launched this run and writes its terminal state from the run's own ` +
    `signal — there are no lifecycle callbacks for you to POST. Your one job-facing duty is your final message: a ` +
    `compact, honest summary of chapters written, concept terms assigned, assets interpreted, references skipped and ` +
    `references failed. Never echo the source text.`
  );
}

/** Human-readable progress line from a tool-call tick. */
function progressFor(tool, index) {
  if (tool === "okf_upsert_concept") return `writing chapters · ${index} tool calls so far`;
  if (tool === "view_image" || tool === "video_keyframes") return `interpreting an inline asset · ${index} tool calls so far`;
  if (tool === "web_fetch" || tool === "file_to_markdown") return `acquiring the source · ${index} tool calls so far`;
  if (tool === "okf_add_raw_source") return `registering a source into raw/ · ${index} tool calls so far`;
  return `${tool} · ${index} tool calls so far`;
}

/** The job whose run has this id, or null — the run is not one of ours (a
 *  user's chat, another agent) or no run id was given. */
async function jobForRun(bundleRoot, runId) {
  if (!runId) return null;
  const state = await loadJobs(bundleRoot);
  return state.jobs.find((j) => j.runId === runId) || null;
}

/**
 * THE single auto-trigger path. Shared by the `okf_ingest` tool and the app's
 * `POST /jobs` route — one capability, two surfaces, so a run a user starts
 * from the Ingest modal and a run an agent starts are literally the same
 * record produced by the same code.
 *
 * Returns IMMEDIATELY with `{jobId, status: "queued"}`. The run proceeds in
 * the background; watch it via `okf_list_jobs` / `GET /jobs`.
 */
async function triggerIngest(bundleRoot, { bundle, source, maxDepth, maxWorkers, defaults, caller, reingest } = {}) {
  const src = String(source || "").trim();
  if (!bundle) throw new Error("bundle is required");
  if (!src) throw new Error("source is required — an http(s) URL, an absolute VFS path, or a raw/ path in the bundle");

  // A NESTED ingest — a reference followed from inside one of this service's
  // own runs — is bounded by the run that is calling, identified by the
  // `caller.runId` BOS passes with every tool call and the `runId` each job
  // records. It gets ONE hop less than its parent and nothing the model passes
  // can raise that; at zero it is refused. Without this every child restarted
  // at the default depth, and one PDF became seven concurrent runs.
  const parent = await jobForRun(bundleRoot, caller && caller.runId);
  let depth;
  let workers;
  if (parent) {
    const remaining = (Number.isFinite(parent.maxDepth) ? parent.maxDepth : 0) - 1;
    if (remaining < 0) {
      return {
        status: "over_depth",
        jobId: null,
        bundle,
        source: src,
        parentJobId: parent.id,
        note:
          `Not started: your run (${parent.id}) is at its reference-depth limit, so it cannot ingest further ` +
          `references. Report this one as skipped (over-depth) in your summary.`,
      };
    }
    depth = Number.isFinite(maxDepth) ? Math.min(maxDepth, remaining) : remaining;
    const parentWorkers = Number.isFinite(parent.maxWorkers) ? parent.maxWorkers : (defaults && defaults.maxWorkers) ?? 3;
    workers = Number.isFinite(maxWorkers) ? Math.min(maxWorkers, parentWorkers) : parentWorkers;
  } else {
    depth = Number.isFinite(maxDepth) ? maxDepth : (defaults && defaults.maxDepth) ?? 1;
    workers = Number.isFinite(maxWorkers) ? maxWorkers : (defaults && defaults.maxWorkers) ?? 3;
  }

  const bDir = bundleDir(bundleRoot, bundle);
  if (!(await vfs.exists(bDir))) {
    throw new Error(`bundle not found: ${bundle} — create it first with okf_init_bundle({name: "${bundle}"})`);
  }

  // FR-018 dedup. A source already in the provenance ledger is NOT run
  // again unless the caller asks for a RE-ingest: the existing docId comes
  // back and no job is created, so a repeat call is cheap and idempotent
  // rather than a duplicate document. A re-ingest is the user's (or the
  // assistant's) decision — never one a nested reference-follow can make, so
  // a call from inside an ingest run always gets the ordinary answer.
  let runSource = src;
  let reingestDocId = null;
  if (!src.startsWith("raw/")) {
    const known = await findSource(bundleRoot, bundle, src).catch(() => null);
    if (known && (!reingest || parent)) {
      return {
        status: "already_ingested",
        bundle,
        source: src,
        docId: known.docId,
        rawFile: known.rawFile,
        ingestedAt: known.ingestedAt,
        jobId: null,
        note:
          "This source is already in the bundle's provenance ledger, so no run was started. Read what is there with " +
          `okf_read_toc({bundle: "${bundle}", docId: "${known.docId}"}). To replace it with a fresh ingest of the same ` +
          `source, call okf_ingest again with reingest: true — the document is rewritten under the same id.`,
      };
    }
    if (known) {
      reingestDocId = known.docId;
      // Re-acquire from the ORIGIN: the source may have changed, and a fresh
      // acquisition is what gives the run new chunks and a new heading map.
      if (known.originUrl) runSource = known.originUrl;
    }
  }

  const job = await createJob(bundleRoot, {
    bundleId: bundle,
    source: runSource,
    maxDepth: depth,
    maxWorkers: workers,
    parentJobId: parent ? parent.id : null,
    reingestDocId,
  });

  // Detached on purpose — see consequence (1) in this section's header. The
  // caller gets {jobId} back before the first token of the run; the run itself
  // starts when the queue has a free slot (pumpQueue).
  void pumpQueue(bundleRoot);

  return {
    status: "queued",
    jobId: job.id,
    bundle,
    source: runSource,
    maxDepth: depth,
    maxWorkers: workers,
    ...(reingestDocId ? { reingestOf: reingestDocId } : {}),
    job,
    note:
      `Run ${job.id} is queued and starts as soon as the run queue has a free slot` +
      (reingestDocId ? ` — it replaces document "${reingestDocId}", which is cleared when the run starts` : "") +
      `. There is nothing for you to run. Check on it with okf_list_jobs({}) (or the app's Jobs tab); it ends as ` +
      `completed with a summary, or failed with an error.`,
  };
}

// ── THE RUN QUEUE ─────────────────────────────────────────────────────────
//
// Every ingest used to start its run the moment it was requested. One PDF
// that followed its references became seven concurrent runs competing for one
// model, until the service ran out of heap (2026-10-13). A bundle-wide
// re-ingest would have been one run per document, all at once. So every run —
// requested, nested, re-ingest — is queued, and at most `maxConcurrentRuns`
// (service config, default 2) run at a time, oldest first.
//
// The count is of runs THIS process launched. A `running` job inherited from
// before a restart has no live stream behind it, and the startup sweep reaps
// it; a `queued` one is still waiting and is pumped on startup.

const DEFAULT_MAX_CONCURRENT_RUNS = 2;
let maxConcurrentRuns = DEFAULT_MAX_CONCURRENT_RUNS;
const activeRuns = new Set();
let pumping = Promise.resolve();

/** `0` PAUSES the queue: runs are accepted and wait queued until the cap is
 *  raised — for when the model server is down or overloaded, without losing
 *  the queued work. Anything that is not a non-negative number is the default. */
function setMaxConcurrentRuns(n) {
  maxConcurrentRuns = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_CONCURRENT_RUNS;
}

function getMaxConcurrentRuns() {
  return maxConcurrentRuns;
}

/** Start queued jobs, oldest first, while there are free slots. Serialised, so
 *  two triggers arriving together can never both take the last slot. */
function pumpQueue(bundleRoot) {
  pumping = pumping.then(async () => {
    const state = await loadJobs(bundleRoot);
    const waiting = state.jobs.filter((j) => j.status === "queued" && !j.cancelRequested && !activeRuns.has(j.id)).reverse();
    while (activeRuns.size < maxConcurrentRuns && waiting.length) {
      const job = waiting.shift();
      activeRuns.add(job.id);
      void runJob(bundleRoot, job).finally(() => {
        activeRuns.delete(job.id);
        void pumpQueue(bundleRoot);
      });
    }
  }).catch((err) => {
    // The queue must survive a bad pass — the next trigger or finish re-pumps.
    console.error(`[okf] run queue pump failed: ${err && err.stack ? err.stack : err}`);
  });
  return pumping;
}

/** Everything that happens when a queued job's turn comes. */
async function runJob(bundleRoot, job) {
  let prepared = null;
  try {
    if (job.reingestDocId) await clearDocument(bundleRoot, job.bundleId, job.reingestDocId);
    if (String(job.source).startsWith("raw/")) prepared = await prepareRawSource(bundleRoot, job.bundleId, job.source);
  } catch (err) {
    await updateJob(bundleRoot, job.id, { status: "failed", error: `could not prepare the run: ${err.message}` }).catch(() => {});
    return;
  }
  const task = buildIngestTask({
    jobId: job.id,
    bundle: job.bundleId,
    source: job.source,
    maxDepth: job.maxDepth,
    maxWorkers: job.maxWorkers,
    prepared,
  });
  await driveRun(bundleRoot, job.id, task);
}

/**
 * Remove a document's DERIVED content so a re-ingest rewrites it under the
 * same id: the stub, every chapter, the chunk cache. raw/ (append-only, the
 * provenance) and the ledger stay; the index and TOC follow from the rebuild.
 */
async function clearDocument(bundleRoot, bundleName, docId) {
  validateConceptId(docId);
  const bDir = bundleDir(bundleRoot, bundleName);
  for (const target of [conceptFilePath(bDir, docId), safeJoin(bDir, "concepts", docId), safeJoin(bDir, CHUNKS_DIR, docId)]) {
    if (await vfs.exists(target)) await vfs.remove(target);
  }
  markGraphDirty(bDir);
  await rebuildDerived(bundleRoot, bundleName);
  await appendLog(bundleRoot, bundleName, {
    event: "document_clear",
    conceptId: docId,
    message: `cleared document "${docId}" for a re-ingest (raw/ kept)`,
  });
}

/**
 * A run over a source ALREADY in raw/ gets the same chunks and heading map an
 * acquisition would have produced — written by the service before the agent
 * starts. Without them the agent was told to file_read the whole source and
 * could only re-type it.
 */
async function prepareRawSource(bundleRoot, bundleName, rawPath) {
  const bDir = bundleDir(bundleRoot, bundleName);
  const content = await vfs.readText(safeJoin(bDir, rawPath));
  const ledger = await readLedger(bDir);
  const entry = Object.values(ledger.sources).find((e) => e && e.rawFile === rawPath && e.kind !== "asset");
  const docId = (entry && entry.docId) || docIdForSource(path.basename(rawPath));
  const headingMap = { sourceFile: rawPath, ...buildHeadingMap(content) };
  const chunks = await writeChunks(bDir, docId, chunkSource(content, DEFAULT_MAX_CHUNK_SIZE), headingMap);
  return { docId, chunks };
}

/** The newest ledger entry for each DOCUMENT (assets are part of their
 *  document, not documents of their own). */
function documentEntries(ledger) {
  const byDoc = new Map();
  for (const entry of Object.values(ledger.sources)) {
    if (!entry || entry.kind === "asset" || !entry.docId) continue;
    const prev = byDoc.get(entry.docId);
    if (!prev || String(entry.ingestedAt || "") > String(prev.ingestedAt || "")) byDoc.set(entry.docId, entry);
  }
  return byDoc;
}

/**
 * Re-ingest ONE document, by id, from what the provenance ledger recorded
 * about it — re-acquired from its origin when it has one, else from its
 * original file if that still exists, else from its newest raw/ version.
 * Queued like every run; the document is cleared when the run starts.
 */
async function reingestDocument(bundleRoot, bundleName, docId, { defaults } = {}) {
  const bDir = bundleDir(bundleRoot, bundleName);
  if (!(await vfs.exists(bDir))) throw jobError(`bundle not found: ${bundleName}`, 404);
  const entry = documentEntries(await readLedger(bDir)).get(docId);
  if (!entry) {
    throw jobError(
      `document "${docId}" has no recorded source in ${bundleName}'s provenance ledger, so there is nothing to re-ingest it from`,
      404,
    );
  }
  let source = entry.originUrl || null;
  if (!source && entry.sourceKey && entry.sourceKey.startsWith("/") && (await vfs.exists(entry.sourceKey))) source = entry.sourceKey;
  if (source) {
    const res = await triggerIngest(bundleRoot, { bundle: bundleName, source, reingest: true, defaults });
    return { docId, jobId: res.jobId, source: res.source, status: res.status };
  }
  if (!entry.rawFile) throw jobError(`document "${docId}" has neither an origin nor a raw/ copy to re-ingest from`, 409);
  return { ...(await queueReingestFromRaw(bundleRoot, bundleName, docId, entry.rawFile, defaults)), status: "queued" };
}

/**
 * Re-ingest every document in a bundle — reingestDocument for each, all
 * through the run queue, so a large bundle never becomes that many concurrent
 * runs.
 */
async function reingestBundle(bundleRoot, bundleName, { defaults } = {}) {
  const bDir = bundleDir(bundleRoot, bundleName);
  if (!(await vfs.exists(bDir))) throw jobError(`bundle not found: ${bundleName}`, 404);
  const jobs = [];
  for (const docId of documentEntries(await readLedger(bDir)).keys()) {
    jobs.push(await reingestDocument(bundleRoot, bundleName, docId, { defaults }));
  }
  return { bundle: bundleName, jobs, note: `${jobs.length} document(s) queued for re-ingest.` };
}

/** Queue a re-ingest of one document from its raw/ copy — for a document
 *  whose original source can no longer be re-acquired. */
async function queueReingestFromRaw(bundleRoot, bundleName, docId, rawFile, defaults) {
  const job = await createJob(bundleRoot, {
    bundleId: bundleName,
    source: rawFile,
    maxDepth: (defaults && defaults.maxDepth) ?? 1,
    maxWorkers: (defaults && defaults.maxWorkers) ?? 3,
    parentJobId: null,
    reingestDocId: docId,
  });
  void pumpQueue(bundleRoot);
  return { docId, jobId: job.id, source: rawFile };
}

/**
 * Consume one delegated run to its end and write the job's terminal state.
 * Every exit path writes a terminal status — a job this function started can
 * never be left hanging by this function, only by the process dying under it
 * (which is what the stale reaper is for).
 */
async function driveRun(bundleRoot, jobId, task) {
  const delegate = require("./delegate-bridge");
  try {
    await updateJob(bundleRoot, jobId, { status: "running", progress: "starting the okf-ingest agent" });
  } catch {
    /* the job vanished (bundle deleted mid-flight) — the run can still proceed */
  }

  try {
    const run = await delegate.runIngestAgent({
      task,
      onTool: ({ tool, index }) => {
        void updateJob(bundleRoot, jobId, { progress: progressFor(tool, index) }).catch(() => {});
      },
      // FR-057 / ADR-013: every line of the stream, verbatim and in order, on
      // the job record. The launcher is the only thing that ever sees this
      // stream, so if it does not capture it here nothing can.
      onEvent: (event) => {
        void appendJobTrajectory(bundleRoot, jobId, event).catch(() => {});
      },
      // FR-052: the run's own `run_started` line is the ONLY place the runId
      // exists — the delegate POST returns a stream, not an id. Storing it on
      // the job is what makes `okf_cancel_job` able to abort anything at all.
      onRunStarted: async ({ runId }) => {
        await updateJob(bundleRoot, jobId, { runId }).catch(() => {});
        // ADR-010 S4 — the queued window: a cancel that arrived before this
        // id existed only recorded the intent. Now that the handle is here,
        // honour it immediately rather than leaving a "cancelled" job with a
        // run still burning tokens behind it.
        const job = await getJob(bundleRoot, jobId).catch(() => null);
        if (job && (job.cancelRequested || job.status === "cancelled")) {
          await delegate.abortRun(runId).catch(() => {});
        }
      },
    });

    if (run.ok) {
      await updateJob(bundleRoot, jobId, {
        status: "completed",
        summary: summaryFromOutput(run.output, run.toolCalls),
      });
    } else if (run.endedReason === "cancelled") {
      // An aborted run is NOT a failed run (FR-050). The stream's own
      // endedReason is what distinguishes the two, so the derivation reads
      // it rather than treating every not-ok ending as an error.
      await updateJob(bundleRoot, jobId, { status: "cancelled", error: null });
    } else {
      await updateJob(bundleRoot, jobId, {
        status: "failed",
        error: run.error || `the run ended as "${run.endedReason || "unknown"}"`,
      });
    }
  } catch (err) {
    // The stream itself broke. We do not know the run succeeded, so it did not.
    await updateJob(bundleRoot, jobId, {
      status: "failed",
      error: `could not drive the okf-ingest run: ${err.message}`,
    }).catch(() => {});
  }
}

/**
 * Turn the agent's final message into the job summary the Jobs tab renders.
 *
 * The agent writes prose, not JSON — asking it for a machine-readable block
 * and then trusting the shape is how you get a summary card full of NaN. So
 * the counts are read out of the prose where they are stated plainly, and
 * anything not stated stays 0 rather than being guessed at. The full text is
 * always kept verbatim in `text`, which is what the detail view falls back to.
 *
 * Two passes, in this order. AGENT.md mandates a literal `Ingested: …` line
 * as the last line of the final message, so that exact template is tried
 * first and read positionally — no ambiguity about which number is which.
 * Only when it is absent do the per-field prose patterns run, and those are
 * WIDE on purpose: a run that reported "6 sections, 8 topics, 1 image" used
 * to read as all zeros, because the narrow patterns only knew the words
 * "chapters", "concepts" and "assets". A summary card of zeros next to a run
 * that plainly did the work is worse than an approximate count, so each
 * field carries the synonyms the agent actually reaches for, first match
 * wins. A field with no match still stays 0 — guessing is not the fallback.
 */
function summaryFromOutput(output, toolCalls) {
  const text = String(output || "").trim();
  if (!text) return { chapters: 0, concepts: 0, assets: 0, refsSkipped: 0, refsFailed: 0, written: [], text: "", toolCalls };

  // Primary: the literal "Ingested:" template line (AGENT.md mandates it)
  const ingested = text.match(/Ingested:\s*(\d+)\s+chapters?,\s*(\d+)\s+concepts?,\s*(\d+)\s+assets?,\s*(\d+)\s+refs?\s+skipped,\s*(\d+)\s+refs?\s+failed/i);
  if (ingested) {
    return {
      chapters: Number(ingested[1]),
      concepts: Number(ingested[2]),
      assets: Number(ingested[3]),
      refsSkipped: Number(ingested[4]),
      refsFailed: Number(ingested[5]),
      written: [],
      text,
      toolCalls,
    };
  }

  // Fallback: widened prose patterns (per-field, first match wins)
  const COUNT_PATTERNS = {
    chapters: [/(\d+)\s+chapters?\b/i, /(\d+)\s+sections?\b/i, /(\d+)\s+parts?\b/i],
    concepts: [/(\d+)\s+concepts?\s*(?:terms?)?\b/i, /(\d+)\s+topics?\b/i],
    assets: [/(\d+)\s+assets?\b/i, /(\d+)\s+images?\b/i, /(\d+)\s+figures?\b/i, /(\d+)\s+media\b/i, /(\d+)\s+videos?\b/i, /(\d+)\s+interpretations?\b/i],
    refsSkipped: [/(\d+)\s+(?:references?|refs?)\s+skipped/i, /skipped\s+(\d+)\s+(?:references?|refs?)/i],
    refsFailed: [/(\d+)\s+(?:references?|refs?)\s+failed/i, /failed\s+(\d+)\s+(?:references?|refs?)/i],
  };
  const num = (patterns) => {
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return Number(m[1]);
    }
    return 0;
  };
  return {
    chapters: num(COUNT_PATTERNS.chapters),
    concepts: num(COUNT_PATTERNS.concepts),
    assets: num(COUNT_PATTERNS.assets),
    refsSkipped: num(COUNT_PATTERNS.refsSkipped),
    refsFailed: num(COUNT_PATTERNS.refsFailed),
    written: [],
    text,
    toolCalls,
  };
}

/** 30 minutes of SILENCE (FR-059/ADR-014 B1) — not 30 minutes of running. */
const DEFAULT_INACTIVITY_MS = 30 * 60 * 1000;
/** 6 hours of total runtime, whatever the run is doing (ADR-014 B3). */
const DEFAULT_MAX_TOTAL_MS = 6 * 60 * 60 * 1000;

/** "90 minute(s)" / "6 hour(s)" — the bound, in the unit a human would say it in. */
function humanBound(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 90) return `${minutes} minute(s)`;
  const hours = ms / 3600000;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour(s)`;
}

/**
 * THE STALE REAPER (FR-049 / FR-059, ADR-006 + ADR-014 Part B).
 *
 * `driveRun` writes a terminal state on every path it controls. What it
 * cannot cover is a run that stops reporting: the process dying mid-run (a
 * worker restart, a BOS reload, a killed Next.js), a provider socket that
 * went quiet, or a run that is alive but getting nowhere. Those leave a job
 * sitting in `queued`/`running` forever, and a Jobs tab with a permanently-
 * spinning row is worse than one that says plainly that the run was lost.
 *
 * TWO bounds, because one cannot catch both failure shapes:
 *
 *   • INACTIVITY (`jobFinalizeTimeoutMs`/`staleJobMs`, default 30 min) —
 *     `now - lastEventAt`. Catches a run that went SILENT. Measured from the
 *     last trajectory event, never from `startedAt`: a 51-chunk ingest
 *     legitimately runs for 60-100 minutes, and an age-based bound killed it
 *     at 30 while it was still emitting tool calls.
 *   • TOTAL RUNTIME (`maxTotalTimeoutMs`, default 6 h) — `now - startedAt`.
 *     Catches the shape inactivity CANNOT see: a run that keeps emitting
 *     events (so `lastEventAt` keeps refreshing) while making no progress —
 *     a slow-repeating failure, two minutes per failed step, forever.
 *
 * Either bound tripping reaps the job, and the `error` says WHICH — the two
 * observations are different facts about the run, and a message that guesses
 * the wrong one sends the user looking in the wrong place.
 *
 * Only `queued`/`running` jobs are candidates — a `cancelled` job is already
 * terminal and is never reaped (nor re-described as a failure, which is the
 * point of the state). Run on a timer AND as a sweep on (re)start, because a
 * restart is exactly the event that orphans jobs and waiting a full interval
 * to admit it is the wrong default.
 *
 * @param {string} bundleRoot
 * @param {number|{inactivityMs?:number,maxTotalMs?:number}} [bounds]
 *        A bare number is the inactivity bound (the pre-ADR-014 signature,
 *        still used by every existing caller).
 */
async function reapStaleJobs(bundleRoot, bounds) {
  const opts = typeof bounds === "object" && bounds !== null ? bounds : { inactivityMs: bounds };
  const positive = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);
  const cutoffMs = positive(opts.inactivityMs, DEFAULT_INACTIVITY_MS);
  const maxTotalMs = positive(opts.maxTotalMs, DEFAULT_MAX_TOTAL_MS);
  const state = await loadJobs(bundleRoot);
  const now = Date.now();
  const reaped = [];

  for (const job of state.jobs) {
    // Only a RUNNING job has a run that can die unseen. A queued one is waiting
    // its turn behind the run queue's cap — however long that takes, there is
    // nothing stale about it, and a restart re-pumps it (pumpQueue).
    if (job.status !== "running") continue;
    // `lastEventAt` is the liveness stamp `appendJobTrajectory` writes per
    // captured event; `startedAt` covers the window before the run's first
    // event, and `queuedAt` the window before it started at all.
    const since = Date.parse(job.lastEventAt || job.startedAt || job.queuedAt || "");
    const began = Date.parse(job.startedAt || job.queuedAt || "");
    const idleMs = Number.isNaN(since) ? null : now - since;
    const totalMs = Number.isNaN(began) ? null : now - began;

    let error = null;
    if (idleMs !== null && idleMs >= cutoffMs) {
      error =
        `stale: the run was still "${job.status}" but made no progress (no trajectory event) for ${humanBound(idleMs)}, past the ` +
        `${humanBound(cutoffMs)} inactivity limit. The run was alive but silent — a long model generation, a provider stall, or a BOS restart ` +
        `that dropped the stream. The last captured event is in the trajectory; a run still producing events is not stale. Anything it managed ` +
        `to write is already in the bundle (writes are atomic and the derived index rebuilds from content); re-run okf_ingest to finish the job.`;
    } else if (totalMs !== null && totalMs >= maxTotalMs) {
      error =
        `stale: the run was still "${job.status}" after ${humanBound(totalMs)} — it exceeded the maximum total runtime (${humanBound(maxTotalMs)}) ` +
        `without reaching a terminal state. The run was active but not progressing (likely a slow or repeating failure); its trajectory shows what ` +
        `it kept doing. Anything it managed to write is already in the bundle; re-run okf_ingest to finish the job.`;
    }
    if (!error) continue;

    await updateJob(bundleRoot, job.id, { status: "failed", error }).catch(() => {});
    reaped.push(job.id);
  }
  return { reaped, count: reaped.length, cutoffMs, maxTotalMs };
}

module.exports = {
  // bundles
  listBundles,
  initBundle,
  bundleHealth,
  bundleDetail,
  importBundle,
  exportBundle,
  deleteBundle,
  // retrieval (the redesign's core)
  search,
  searchIndex,
  readToc,
  readConcept,
  listConcepts,
  // derived index
  rebuildDerived,
  getModel,
  classifyBundle,
  buildConceptIndex,
  buildToc,
  graph,
  // concepts
  upsertConcept,
  deleteConcept,
  mergeConcepts,
  // organization
  addLink,
  backlinks,
  // raw / assets / provenance
  addRawSource,
  addRawAsset,
  chunkSource,
  writeChunks,
  docIdForSource,
  DEFAULT_MAX_CHUNK_SIZE,
  CHUNKS_DIR,
  // the body-extraction write path (FR-060/SC-019, ADR-014 Part A) —
  // exported for the unit tests that hold the verbatim-slice invariant
  buildHeadingMap,
  readHeadingMap,
  resolveSourceSlice,
  insertInterpretations,
  stripInterpretations,
  chapterFromSourceRange,
  HEADINGS_FILE,
  INTERPRETATION_PREFIX,
  INTERPRETATION_ASSET_MARK,
  readAsset,
  findSource,
  normalizeSourceKey,
  assetBlockMarkdown,
  extractAssets,
  // health
  lintBundle,
  staleReport,
  // jobs
  createJob,
  listJobs,
  jobListView,
  getJob,
  updateJob,
  appendJobTrajectory,
  cancelJob,
  deleteJob,
  reapStaleJobs,
  resetJobStore,
  DEFAULT_INACTIVITY_MS,
  DEFAULT_MAX_TOTAL_MS,
  // the auto-trigger (THE single ingest path)
  triggerIngest,
  acquisitionFirstSteps,
  buildIngestTask,
  // the run queue, re-ingest
  pumpQueue,
  setMaxConcurrentRuns,
  getMaxConcurrentRuns,
  DEFAULT_MAX_CONCURRENT_RUNS,
  reingestBundle,
  reingestDocument,
  clearDocument,
  // internals exposed for the bridge, the tools layer and tests
  appendLog,
  // the launcher's prose->counts reader; tests/summary-from-output.test.mjs
  // has always required it and the export was simply missing
  summaryFromOutput,
  extractLinks,
  normalizeLinkTarget,
  parseFrontmatter,
  stringifyDocument,
  tokenize,
  safeJoin,
  assetContentType,
  STATUSES,
  TRUST_LEVELS,
  JOB_STATUSES,
};
