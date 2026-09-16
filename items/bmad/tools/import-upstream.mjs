#!/usr/bin/env node
// 048 T022 / FR-022 — vendor BMAD's published skills into this pack.
//
//   node tools/import-upstream.mjs 6.12.0
//
// ONE REPEATABLE OPERATION, which is the requirement. The pack reached 4 skills
// where upstream publishes 30 because its content was hand-written: a hand merge
// drifts the moment either side changes, and nobody notices, because a missing
// skill looks exactly like a skill that was never wanted.
//
// So this reads the PUBLISHED PACKAGE — `npm pack bmad-method@<version>` — and
// copies from it. Re-running against a newer version is the upgrade path, and
// the only thing a human then has to review is the diff.
//
// WHAT IS DELIBERATELY NOT IMPORTED
//
//   v6-shims/    upstream's own compatibility aliases for pre-v6 skill names
//                (bmad-create-prd -> bmad-prd, and 15 more). They exist so
//                someone's muscle memory keeps working across BMAD's own major
//                version. BOS has no users of those names — importing them would
//                add 16 skills that alias skills nobody here has ever called.
//   tests/       pytest suites for the Python. They declare a pytest dependency
//                and are upstream's CI, not runtime.
//   __pycache__/ byte-cache. Present in the published tarball because it was
//                built from a working tree; it is not content.
//
// Everything else is copied verbatim, assets and customize.toml included.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const METHOD = path.join(PACK, "method");
const SKIP_DIRS = new Set(["__pycache__", "tests", "v6-shims"]);

// Optional module packages. bmb and cis are SEPARATE npm packages, not part of
// bmad-method — the pack used to declare them while shipping neither.
//
// They are not in the same shape as each other, which the importer has to say
// rather than paper over:
//   bmad-builder  ships real SKILL.md files and imports directly.
//   cis           ships `bmad-skill-manifest.yaml` ONLY — persona metadata that
//                 BMAD's own installer renders into a SKILL.md. There is no
//                 content to copy, so importing it here would place YAML where
//                 BOS expects a skill and register nothing.
// Anything with no SKILL.md is REPORTED and skipped, never copied as if it were
// content.
const MODULE_PACKAGES = {
  bmb: { npm: "bmad-builder", dir: "src/skills" },
  cis: { npm: "bmad-creative-intelligence-suite", dir: "src/skills" },
};

const version = process.argv[2];
const wanted = process.argv.slice(3).filter((a) => MODULE_PACKAGES[a]);
if (!version) {
  console.error("usage: node tools/import-upstream.mjs <bmad-method version> [module…]\n" +
    "       e.g. node tools/import-upstream.mjs 6.12.0 bmb cis\n" +
    `       modules: ${Object.keys(MODULE_PACKAGES).join(", ")}`);
  process.exit(2);
}

/** Copy a directory, dropping build output and upstream's own test suites. */
function copyClean(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyClean(src, dst);
    else if (e.isFile()) cpSync(src, dst);
  }
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

const work = mkdtempSync(path.join(tmpdir(), "bmad-import-"));
try {
  console.log(`  fetching bmad-method@${version} …`);
  execFileSync("npm", ["pack", `bmad-method@${version}`], { cwd: work, stdio: ["ignore", "pipe", "inherit"] });
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("npm pack produced no tarball");
  execFileSync("tar", ["xzf", tgz], { cwd: work });
  const src = path.join(work, "package", "src");
  if (!existsSync(src)) throw new Error(`bmad-method@${version} has no src/ — the package layout changed, and this importer needs updating rather than working around it`);

  // ---- skills -------------------------------------------------------------
  // Flattened into `method/skills/<id>/`, which is where BOS's pack seeding
  // looks. Upstream's grouping (core / agents / plan / ship) is navigational and
  // the skill id is already globally unique — `bmad-` prefixed, by convention
  // upstream states.
  const skillsOut = path.join(METHOD, "skills");
  const groups = [
    ["core-skills", ""],
    ["bmm-skills", "agents"],
    ["bmm-skills", "plan"],
    ["bmm-skills", "ship"],
  ];
  const imported = [];
  for (const [mod, sub] of groups) {
    const base = sub ? path.join(src, mod, sub) : path.join(src, mod);
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      if (!existsSync(path.join(base, e.name, "SKILL.md"))) continue;
      const dest = path.join(skillsOut, e.name);
      rmSync(dest, { recursive: true, force: true });
      copyClean(path.join(base, e.name), dest);
      imported.push(e.name);
    }
  }

  // ---- the shared Python runtime -----------------------------------------
  // Installed into `{project-root}/_bmad/` by BOS at the user's request (FR-026,
  // project-runtime.ts) — NOT into BOS's data dir, because the skills resolve
  // these paths against the project and BMAD's own CLI expects them there.
  const runtimeOut = path.join(METHOD, "runtime");
  rmSync(runtimeOut, { recursive: true, force: true });
  copyClean(path.join(src, "scripts"), path.join(runtimeOut, "scripts"));
  // `custom/` is the user's — created empty so the directory exists and is
  // listed in `preserve`, so a later re-import never writes over a team's
  // committed overrides.
  mkdirSync(path.join(runtimeOut, "custom"), { recursive: true });
  writeFileSync(path.join(runtimeOut, "custom", ".gitkeep"), "");

  // ---- optional module packages -------------------------------------------
  const modules = {};
  for (const code of wanted) {
    const { npm, dir } = MODULE_PACKAGES[code];
    console.log(`  fetching ${npm} …`);
    const mwork = mkdtempSync(path.join(tmpdir(), `bmad-${code}-`));
    try {
      execFileSync("npm", ["pack", npm], { cwd: mwork, stdio: ["ignore", "pipe", "inherit"] });
      const mt = readdirSync(mwork).find((f) => f.endsWith(".tgz"));
      execFileSync("tar", ["xzf", mt], { cwd: mwork });
      const mver = JSON.parse(readFileSync(path.join(mwork, "package", "package.json"), "utf8")).version;
      const base = path.join(mwork, "package", dir);
      if (!existsSync(base)) throw new Error(`${npm}@${mver} has no ${dir}`);

      const took = [], skipped = [];
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
        if (!existsSync(path.join(base, e.name, "SKILL.md"))) { skipped.push(e.name); continue; }
        const dest = path.join(skillsOut, e.name);
        rmSync(dest, { recursive: true, force: true });
        copyClean(path.join(base, e.name), dest);
        took.push(e.name);
        imported.push(e.name);
      }
      modules[code] = { npm, version: mver, skills: took.sort(), notRendered: skipped.sort() };
      console.log(`  ${code}: ${took.length} skills imported` +
        (skipped.length ? `, ${skipped.length} SKIPPED — manifest only, no SKILL.md: ${skipped.join(", ")}` : ""));
    } finally {
      rmSync(mwork, { recursive: true, force: true });
    }
  }

  // ---- provenance ---------------------------------------------------------
  // What this content IS, so an upgrade is a diff rather than an archaeology
  // exercise. Deliberately a file rather than a field in method.json: the
  // descriptor's own `version` is the PACK's, and 048 FR-008a says the two must
  // never be conflated.
  writeFileSync(
    path.join(METHOD, "upstream.json"),
    JSON.stringify(
      { package: "bmad-method", version, skills: imported.sort(), modules, importedBy: "tools/import-upstream.mjs" },
      null,
      2,
    ) + "\n",
  );

  console.log(`  imported ${imported.length} skills, ${countFiles(skillsOut)} files`);
  console.log(`  runtime:  ${countFiles(runtimeOut)} files -> method/runtime/`);
  console.log(`  recorded: method/upstream.json @ ${version}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
