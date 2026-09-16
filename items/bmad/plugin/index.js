// 048 T005/T014 — the BMAD pack's plugin facet.
//
// Loaded by BOS's existing bos-plugin loader (`loadAllPlugins()`), which
// discovers it through the ONE installed-item scan. No new loader (ADR-5).
//
// WHAT THIS DOES NOT DO: it does not project BMAD's agents. The shipped cast is
// authored upstream and adapted by hand into `method/modules/bmm/agents/`
// (FR-011a), so those are ordinary directory roots that BOS discovers without
// any code running. This facet exists for the parts that genuinely need code —
// currently only the version check below.
//
// The provider mechanism (045/048 M1) is deliberately NOT used here. See
// docs/dev/method-packs.md, "Agents are discovered; skills are copied": a pack
// whose cast is checked in needs no provider, and using one would trade a
// reviewable file for a function nobody can diff.

const SUPPORTED = "6.13";

module.exports = {
  async activate(ctx) {
    // The pack pins an upstream BMAD minor. FR-008a: this is the UPSTREAM
    // version, entirely separate from the descriptor's `schemaVersion` — a BOS
    // descriptor change and a BMAD release are unrelated events, and conflating
    // them makes one look like the other's problem.
    ctx.log.info(
      `BMAD pack active (upstream ${SUPPORTED}.x). Personas and workflows are adapted content, ` +
        `not a live mirror of upstream — re-adapt after a BMAD release.`,
    );
  },
};
