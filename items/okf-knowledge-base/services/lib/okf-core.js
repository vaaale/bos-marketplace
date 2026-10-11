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
  if (await vfs.exists(bDir)) throw new Error(`bundle already exists: ${name}`);
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

  if (Array.isArray(files)) {
    for (const f of files) {
      if (!f || typeof f.path !== "string" || typeof f.content !== "string") continue;
      await vfs.writeText(safeJoin(bDir, f.path), f.content); // /api/fs write creates missing parents
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
  const model = rebuild ? await rebuildDerived(bundleRoot, name) : { terms: [], needsRegeneration: true, builtAt: null };
  await appendLog(bundleRoot, name, { event: "bundle_import", message: `imported ${imported} file(s)` });
  const health = await bundleHealth(bundleRoot, name, { allowRebuild: rebuild });
  return {
    ...health,
    imported,
    indexNeedsRegeneration: model.needsRegeneration,
    note: model.needsRegeneration
      ? "Imported. The derived index was rebuilt BEST-EFFORT: some chapters lack `parent`/`concepts`/`summary` frontmatter, so routing for those is partial. Nothing was dropped or overwritten — re-ingest the sources, or upsert the missing frontmatter, to complete the index."
      : "Imported. The two-level derived index was rebuilt in full from the imported chapter frontmatter.",
  };
}

async function deleteBundle(bundleRoot, name) {
  const bDir = bundleDir(bundleRoot, name);
  if (!(await vfs.exists(bDir))) throw new Error(`bundle not found: ${name}`);
  await vfs.remove(bDir);
  graphCache.delete(bDir);
  derivedCache.delete(bDir);
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
async function upsertConcept(bundleRoot, bundleName, id, { title, body, frontmatter } = {}) {
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

  const finalBody = body !== undefined ? body : existing ? existing.body : `# ${merged.title || id}\n`;
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
  return readConcept(bundleRoot, bundleName, id);
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
  const existing = await readConceptRaw(bDir, id);
  if (!existing) throw new Error(`concept not found: ${bundleName}/${id}`);
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
async function addRawSource(bundleRoot, bundleName, { filename, content, sourcePath, conceptId, title, originUrl } = {}) {
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

  const docId = conceptId || base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "source";
  const ledgerEntry = await recordSource(bDir, originUrl || sourcePath || `raw/${finalName}`, {
    rawFile: `raw/${finalName}`,
    docId,
    originUrl: originUrl || (sourcePath && /^https?:\/\//i.test(sourcePath) ? sourcePath : null),
    ingestedAt: nowIso(),
  });
  await appendLog(bundleRoot, bundleName, { event: "raw_add", message: `added raw source "${finalName}"` });

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
  return {
    rawFile: `raw/${finalName}`,
    bytes: content.length,
    stored: true,
    docId,
    provenance: ledgerEntry,
    concept,
    note: concept
      ? `Source stored (${content.length} chars) and the document stub "${concept.id}" created. Next: okf_ingest({bundle, source: "raw/${finalName}"}).`
      : `Source stored (${content.length} chars). concept:null is expected — no conceptId was requested, and chapters are written later by the okf-ingest agent. Do NOT re-import the content. Next: okf_ingest({bundle, source: "raw/${finalName}"}).`,
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

  const name = path.basename(filename || sourcePath || originUrl || "asset").split("?")[0].replace(/[^A-Za-z0-9._-]+/g, "-");
  const relPath = `raw/assets/${docId}/${name}`;
  const dest = safeJoin(bDir, relPath);

  const alreadyThere = await vfs.exists(dest);
  if (!alreadyThere) {
    if (!sourcePath) {
      throw new Error(
        `asset not present at ${relPath} and no sourcePath given — have the ingest agent web_fetch it with output_path="${dest}" first`,
      );
    }
    const staged = safeJoin("/", sourcePath);
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

async function loadJobs(bundleRoot) {
  if (jobsState) return jobsState;
  const raw = await vfs.readText(jobsPath(bundleRoot)).catch(() => null);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.jobs)) {
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

async function createJob(bundleRoot, { bundleId, source, maxDepth, maxWorkers }) {
  const state = await loadJobs(bundleRoot);
  state.seq++;
  const job = {
    id: `run-${state.seq}`,
    status: "queued",
    bundleId,
    source,
    maxDepth: maxDepth ?? null,
    maxWorkers: maxWorkers ?? null,
    queuedAt: nowIso(),
    startedAt: null,
    endedAt: null,
    durationMs: null,
    progress: null,
    summary: null,
    error: null,
  };
  state.jobs.unshift(job);
  await persistJobs(bundleRoot);
  return job;
}

async function listJobs(bundleRoot, { bundleId, status, limit } = {}) {
  const state = await loadJobs(bundleRoot);
  let jobs = state.jobs;
  if (bundleId) jobs = jobs.filter((j) => j.bundleId === bundleId);
  if (status) jobs = jobs.filter((j) => j.status === status);
  return Number.isFinite(limit) && limit > 0 ? jobs.slice(0, limit) : jobs;
}

async function getJob(bundleRoot, id) {
  const state = await loadJobs(bundleRoot);
  return state.jobs.find((j) => j.id === id) || null;
}

const TERMINAL = new Set(["completed", "failed"]);
const JOB_STATUSES = ["queued", "running", "completed", "failed"];

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

  const staged = `/workspace/okf-staged-${stagedName(source)}`;
  const steps = [];
  if (isUrl) {
    steps.push({ tool: "web_fetch", args: { url: source, output_path: staged } });
  } else if (CONVERTIBLE.test(source)) {
    steps.push({ tool: "file_to_markdown", args: { path: source, output_path: staged } });
  }
  const sourcePath = steps.length ? staged : source;
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
function buildIngestTask({ jobId, bundle, source, maxDepth, maxWorkers }) {
  const steps = acquisitionFirstSteps(bundle, source);
  const acquisition = steps.length
    ? `## Step 0 — acquire the source (do this FIRST, exactly as written)\n\n${renderSteps(steps)}\n\n` +
      `Run those calls verbatim. \`output_path\` is pinned on purpose: with it the source streams to disk and the tool ` +
      `returns a receipt, so the document never passes through your context. Do NOT drop it and paste the content into ` +
      `\`okf_add_raw_source({content})\` instead — that re-emits the entire document as output tokens for no benefit. ` +
      `\`okf_add_raw_source\` returns the \`rawFile\` path; that file is what you decompose.\n\n`
    : `## Step 0 — the source is already in the bundle\n\nIt is at \`${source}\`. Read it from there with \`file_read\`; ` +
      `do not expect it inline and do not re-fetch it.\n\n`;

  return (
    `Ingest \`${source}\` into the OKF bundle "${bundle}" as organized chapters.\n\n` +
    `jobId: ${jobId}\nbundle: ${bundle}\nsource: ${source}\nmaxDepth: ${maxDepth}\nmaxWorkers: ${maxWorkers}\n\n` +
    acquisition +
    `## Then do the whole job\n\n` +
    `Decompose the source at its natural heading structure into chapters (\`concepts/<docId>/<chId>.md\`, ` +
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
    `Follow at most ${maxDepth} hop(s) of references beyond this seed source, at most ${maxWorkers} at a time, each ` +
    `nested reference via its own \`okf_ingest\` call (it becomes its own job). Skip anything already in the bundle's ` +
    `provenance ledger.\n\n` +
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

/**
 * THE single auto-trigger path. Shared by the `okf_ingest` tool and the app's
 * `POST /jobs` route — one capability, two surfaces, so a run a user starts
 * from the Ingest modal and a run an agent starts are literally the same
 * record produced by the same code.
 *
 * Returns IMMEDIATELY with `{jobId, status: "queued"}`. The run proceeds in
 * the background; watch it via `okf_list_jobs` / `GET /jobs`.
 */
async function triggerIngest(bundleRoot, { bundle, source, maxDepth, maxWorkers, defaults } = {}) {
  const src = String(source || "").trim();
  if (!bundle) throw new Error("bundle is required");
  if (!src) throw new Error("source is required — an http(s) URL, an absolute VFS path, or a raw/ path in the bundle");

  const depth = Number.isFinite(maxDepth) ? maxDepth : (defaults && defaults.maxDepth) ?? 1;
  const workers = Number.isFinite(maxWorkers) ? maxWorkers : (defaults && defaults.maxWorkers) ?? 3;

  const bDir = bundleDir(bundleRoot, bundle);
  if (!(await vfs.exists(bDir))) {
    throw new Error(`bundle not found: ${bundle} — create it first with okf_init_bundle({name: "${bundle}"})`);
  }

  // FR-018 dedup. A source already in the provenance ledger is NOT run
  // again: the existing docId comes back and no job is created, so a repeat
  // call is cheap and idempotent rather than a duplicate document.
  if (!src.startsWith("raw/")) {
    const known = await findSource(bundleRoot, bundle, src).catch(() => null);
    if (known) {
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
          `okf_read_toc({bundle: "${bundle}", docId: "${known.docId}"}). Re-ingest only if the source genuinely changed — ` +
          "pass its raw/ path directly to do that.",
      };
    }
  }

  const job = await createJob(bundleRoot, { bundleId: bundle, source: src, maxDepth: depth, maxWorkers: workers });
  const task = buildIngestTask({ jobId: job.id, bundle, source: src, maxDepth: depth, maxWorkers: workers });

  // Detached on purpose — see consequence (1) in this section's header. The
  // caller gets {jobId} back before the first token of the run.
  void driveRun(bundleRoot, job.id, task);

  return {
    status: "queued",
    jobId: job.id,
    bundle,
    source: src,
    maxDepth: depth,
    maxWorkers: workers,
    job,
    note:
      `Run ${job.id} started. It is running now in the bundled okf-ingest agent — there is nothing for you to run. ` +
      `Check on it with okf_list_jobs({}) (or the app's Jobs tab); it ends as completed with a summary, or failed with ` +
      `an error.`,
  };
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
    });

    if (run.ok) {
      await updateJob(bundleRoot, jobId, {
        status: "completed",
        summary: summaryFromOutput(run.output, run.toolCalls),
      });
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
 */
function summaryFromOutput(output, toolCalls) {
  const text = String(output || "").trim();
  if (!text) return { chapters: 0, concepts: 0, assets: 0, refsSkipped: 0, refsFailed: 0, written: [], text: "", toolCalls };

  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : 0;
  };
  return {
    chapters: num(/(\d+)\s+chapters?\b/i),
    concepts: num(/(\d+)\s+concepts?\s*(?:terms?)?\b/i),
    assets: num(/(\d+)\s+assets?\b/i),
    refsSkipped: num(/(\d+)\s+(?:references?|refs?)\s+skipped/i),
    refsFailed: num(/(\d+)\s+(?:references?|refs?)\s+failed/i),
    written: [],
    text,
    toolCalls,
  };
}

/**
 * THE STALE REAPER (FR-049 / ADR-006).
 *
 * `driveRun` writes a terminal state on every path it controls. What it
 * cannot cover is the process dying mid-run: a worker restart, a BOS reload,
 * a killed Next.js. Those leave a job sitting in `queued`/`running` forever,
 * and a Jobs tab with a permanently-spinning row is worse than one that says
 * plainly that the run was lost.
 *
 * So: any job still non-terminal and older than `staleJobMs` is marked
 * `failed` with an honest "stale" reason. Run on a timer AND as a sweep on
 * (re)start, because a restart is exactly the event that orphans jobs and
 * waiting a full interval to admit it is the wrong default.
 */
async function reapStaleJobs(bundleRoot, staleJobMs) {
  const cutoffMs = Number.isFinite(staleJobMs) && staleJobMs > 0 ? staleJobMs : 30 * 60 * 1000;
  const state = await loadJobs(bundleRoot);
  const now = Date.now();
  const reaped = [];

  for (const job of state.jobs) {
    if (job.status !== "queued" && job.status !== "running") continue;
    const since = Date.parse(job.startedAt || job.queuedAt || "");
    if (Number.isNaN(since)) continue;
    const ageMs = now - since;
    if (ageMs < cutoffMs) continue;
    const minutes = Math.round(ageMs / 60000);
    await updateJob(bundleRoot, job.id, {
      status: "failed",
      error:
        `stale: the run was still "${job.status}" ${minutes} minute(s) after it started, past the ${Math.round(cutoffMs / 60000)}-minute ` +
        `limit. The service did not see it finish — most likely BOS restarted while it was running. Anything it managed to write is ` +
        `already in the bundle (writes are atomic and the derived index rebuilds from content); re-run okf_ingest to finish the job.`,
    }).catch(() => {});
    reaped.push(job.id);
  }
  return { reaped, count: reaped.length, cutoffMs };
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
  getJob,
  updateJob,
  reapStaleJobs,
  // the auto-trigger (THE single ingest path)
  triggerIngest,
  acquisitionFirstSteps,
  buildIngestTask,
  // internals exposed for the bridge, the tools layer and tests
  appendLog,
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
