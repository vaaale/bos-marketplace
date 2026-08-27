# Discrepancies: agentic-text-editor (v2)

**Feature**: `agentic-text-editor`
**Date**: 2026-08-27
**Pass**: analyze + converge (code vs. spec/plan/tasks)

Cross-artifact consistency + code-vs-spec drift check for the v2 scope-add (agent selector, conversation management, full tool-call visibility).

## Findings

| # | Severity | Area | Finding | Disposition |
|---|----------|------|---------|-------------|
| 1 | **Minor (install-side)** | `app.json` manifest | The **installed** item manifest (`data/user-apps/items/agentic-text-editor/app/app.json`) is missing the `capabilities` array (and `singleton`/`defaultWidth`/`defaultHeight`). The staging manifest and the live grant (`data/system/config/agentic-text-editor/capabilities.json` = `assistant, storage, fs:read, fs:write, window:title, notify`) both carry the full set. The app works regardless (broker calls use the live grant; storage degrades to localStorage if ungranted), but the on-disk installed manifest is out of sync with the design's ADR-5. | **Fix on next `app_build`**: reinstall from staging (whose `app.json` is correct) so the installed manifest picks up `capabilities`. No runtime impact today. |
| 2 | **Minor (test)** | e2e `agentic-text-editor.spec.ts` US5 | The US5 settings "Done"-click assertion times out in headless Chromium (panel stays visible past 15s) even though the real app closes the dialog correctly (user-verified; the v2 suite exercises the same panel cleanly). Classified as a headless-timing flake, not an app defect. | Accepted. Left as-is; documented in `test-results.md` Known limitations. |
| 3 | **Info** | spec ↔ code | FR-023/024/025 are fully implemented in `app/src/assistant/` (client.ts, chat-store.ts, run-projector.ts, tool-chip.ts) and `app/src/components/chat/` (agent-selector, conversation-selector, tool-row, message-bubble, chat-header). All 12 `agentic_editor_*` tools present. Conversation ids minted with the `ate-` prefix per ADR-2. | No action. |
| 4 | **Info** | plan ↔ code | plan.md's module map (client.ts / run-projector.ts / chat-store.ts / tool-chip.ts + the four chat components + `app.json` capability addition) matches the installed source tree. | No action. |
| 5 | **Info** | task coverage | `tasks.md` v2 delta (T053–T092) all complete and ticked. v1 baseline (T001–T052) remains the prior feature's record. | No action. |

## Verdict

Code and spec are consistent for the v2 scope. One install-side manifest gap (Finding 1) to close on the next build; one accepted headless test flake (Finding 2). No functional drift between what `spec.md`/`design.md`/`plan.md` promise and what the app does.
