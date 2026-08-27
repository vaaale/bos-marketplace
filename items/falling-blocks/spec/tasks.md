# Tasks: Falling Blocks

**Input**: `spec.md` (user stories), `plan.md` (structure), `design.md` (component map + ADRs), `mockup.html` (binding UI contract)
**Deliverable**: ONE file — `item-falling-blocks/app/index.html` (all HTML/CSS/JS inline)

> Because the deliverable is a single self-contained file, most tasks edit the
> same file and are inherently sequential; `[P]` is marked only where a task is
> genuinely independent. The spec requests no test framework, so there are no
> test tasks — validation lives in the final phase, keyed to the spec's
> `SC-001`…`SC-009`. Each section of `index.html`'s inline `<script>` follows the
> 10-section map in `design.md` §4.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the file skeleton and theme so every later task has a home.

- [ ] T001 Create `item-falling-blocks/app/index.html` — single `<!doctype html>` document with `<head>` (meta, title "Falling Blocks"), an inline `<style>` block, and one inline `<script>` block with 10 labelled section markers (config / tetromino table / high-score store / state model / movement-rotation engine / input / scoring-level / rendering / game loop / bootstrap) per `design.md` §4.
- [ ] T002 [P] In `app/index.html` `<style>`: port the theme tokens + layout from `mockup.html` (`:root` dark palette, the 7 `--p*` piece colours, `--mono`/`--sans`) and the layout CSS (`.window` 672px, title bar, 3-col `.body`, `.panel`/`.ph`, `.stat`, `.hs` list, `.ctrl`/`.key`, `.playfield-wrap`, `.overlay`/`.go-card`, the `@keyframes pulse`) — NFR-003, FR-018.
- [ ] T003 [P] In `app/index.html` `<body>`: build the static DOM matching `mockup.html` — stage → window → title bar → `.body` with left column (Next canvas `#next` + Controls legend), center column (board canvas `#board` + `.overlay` with `#hsGo`), right column (Status HUD with `#score`/`#lines`/`#level` + High Scores `#hsSide`). Omit the mockup-only "Playing / Game Over" switcher (not part of the app).

**Checkpoint**: Page loads to the correct dark layout with empty canvases and no console errors (foundation for SC-001).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The core engine every story depends on — constants, pieces, grid, collision, and the tick loop.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T004 In `app/index.html` §1 CONFIG: define `COLS=10`, `ROWS=20`, `CELL=22` (board canvas 220×440, next canvas 88×88, DPR-scaled per mockup `setupCanvas`), the `COLORS` map (I `#22d3ee`, O `#fde047`, T `#c084fc`, S `#4ade80`, Z `#f87171`, J `#60a5fa`, L `#fb923c`), the scoring table `{1:100, 2:300, 3:500, 4:800}`, `LINES_PER_LEVEL=10`, `HS_KEY`, `HS_MAX=10`.
- [ ] T005 In `app/index.html` §2 TETROMINO TABLE: define the 7 shapes as `{ color, rotations: [4 rotations × 4 [row,col] offsets] }` — I in a 4×4 box, O in a 2×2 box (identical across all 4 rotations = no-op), T/S/Z/J/L in 3×3 boxes; generate remaining rotations by 90°-rotating the offset set within the box (reference: T in `design.md` §3.1). FR-002, SC-002.
- [ ] T006 In `app/index.html` §4 STATE MODEL: define the `state` object (`grid` ROWS×COLS of `null`|colourKey, `active {shape, rot, x, y}`, `next`, `score`, `lines`, `level`, `phase`, derived `fallMs`) and implement `reset()`, `collides(shape, rot, x, y)` (test every offset `(x+c, y+r)` against bounds + grid), and `spawn()` (place a uniform-random piece from the 7 at top-centre, `rot=0`; if it collides at the start position, transition to game-over). FR-001, FR-008, FR-015.
- [ ] T007 In `app/index.html` §9 GAME LOOP + §10 BOOTSTRAP: implement the `requestAnimationFrame` fixed-timestep accumulator — each frame `acc += (now − last)`, `while (acc >= fallMs) { gravityStep(); acc -= fallMs; }`, render unconditionally; bootstrap initialises canvases, loads high scores, calls `reset()`, and starts the loop. ADR-6, NFR-002.

**Checkpoint**: A random piece falls under gravity, collides correctly against walls and itself-merged cells, and the loop runs at display rate with wall-clock-deterministic speed.

---

## Phase 3: User Story 1 — Play a complete game of falling blocks (Priority: P1) 🎯 MVP

**Goal**: The core, playable loop — steer, rotate (no clip), drop, clear lines.

**Independent Test**: Launch, move/rotate/drop several pieces, fill a row, watch it clear and the rows above fall — no clipping anywhere.

- [ ] T008 In `app/index.html` §5 MOVEMENT/ROTATION ENGINE: implement `move(dx)` (left/right, within bounds) and `rotate()` using the ordered rotation-kick set `[ (0,0),(0,−1),(0,+1),(0,−2),(0,+2),(−1,0),(+1,0) ]` — apply rotation, keep the first offset that passes `collides()`, else reject; O is a no-op. Each mutates `state.active` only when valid → no clipping. FR-003, FR-004, FR-005, FR-008, SC-003.
- [ ] T009 In `app/index.html` §5: implement `softDrop()` (move down one row) and `hardDrop()` (fall to the lowest valid row, then lock). FR-006, FR-007.
- [ ] T010 In `app/index.html` §4 + §5: implement `mergeActive()` (write the locked piece into `grid`), `clearFullRows()` (remove full rows, shift rows above down, return count cleared), and the lock→clear→spawn sequence. FR-009.
- [ ] T011 In `app/index.html` §6 INPUT: wire `keydown`/`keyup` for ←/→/↑/↓/Space, add held-key DAS (170ms delay, 40ms repeat) stepped off the rAF clock so no path can clip, and `preventDefault` on handled keys. ADR-4.
- [ ] T012 In `app/index.html` §8 RENDERING: implement `renderBoard()` — locked cells (bevelled blocks via the mockup `drawBlock`/`rr` helpers) → faint grid → drop-ghost (active piece at its rest position, dashed outline) → active piece (with glow). Re-render each frame.

**Checkpoint**: User Story 1 is fully playable on its own — move, rotate against walls/stack without clipping, soft/hard drop, and clear completed lines (SC-001, SC-002, SC-003).

---

## Phase 4: User Story 2 — Score, level, and speed progress (Priority: P2)

**Goal**: Live HUD, next-piece preview, multi-line scoring bonus, and level-driven speed.

**Independent Test**: Clear single/double/triple/quad lines; confirm score, lines, level update, quad beats four singles, and higher levels fall faster.

- [ ] T013 In `app/index.html` §7 SCORING/LEVEL: implement `addLineScore(n)` using the `{1:100,2:300,3:500,4:800}` table (multi-line strictly beats the same rows solo), plus soft-drop +1/row and hard-drop +2/row awarded per row actually dropped (the move delta, not per keypress). FR-010, SC-004.
- [ ] T014 In `app/index.html` §7 + §1: implement `recomputeLevel()` = `floor(lines / 10) + 1` and derive `fallMs = max(80, 800 − (level−1)·60)` (level ≥ 13 holds the 80ms floor). FR-012, FR-013, SC-005.
- [ ] T015 In `app/index.html` §8: implement `renderHUD()` — update `#score` (via `toLocaleString`), `#lines`, `#level` from state on every change. FR-011.
- [ ] T016 In `app/index.html` §8: implement `renderNext()` — centre the `state.next` shape in the 88×88 `#next` canvas in its spawn orientation; refresh it after each lock when `next` is promoted. FR-014, SC-006.

**Checkpoint**: US1 + US2 both work — progression (score/lines/level), next preview, and speed ramp are live and independently verifiable (SC-004, SC-005, SC-006).

---

## Phase 5: User Story 3 — Game over and restart (Priority: P3)

**Goal**: Terminal state with a visible overlay and a one-key restart.

**Independent Test**: Let the stack top out (or force it), confirm a visible game-over state halts the loop, then press Enter for a clean fresh board.

- [ ] T017 In `app/index.html` §4 + §7: implement game-over detection (`spawn()` collision, already scaffolded in T006) → set `phase='gameover'`, stop stepping gravity, commit the final score to the high-score store via `record(finalScore)`, and show the overlay. FR-015, FR-016.
- [ ] T018 In `app/index.html` §8: implement `renderOverlay(show)` — the `.go-card` over the piled board with "Game Over", final score, the re-sorted top-10 (`.new`-highlight the just-recorded entry if it made the cut), and a pulsing "Enter Restart" prompt; "★ New high score" badge iff `record()` returned rank 0..9. FR-016.
- [ ] T019 In `app/index.html` §6 INPUT: make Enter restart from the game-over state — call `reset()` (clear grid, zero score/lines, level=1, re-randomise active + next, phase→playing, hide overlay). FR-017, SC-007.

**Checkpoint**: All three user stories work independently — game over shows a visible state, restart resets cleanly (SC-007).

---

## Phase 6: User Story 4 — High score list (Priority: P3)

**Goal**: Persisted top-10 leaderboard shown in a side panel and on the game-over overlay.

**Independent Test**: Record a qualifying score, confirm it appears, reload, confirm it persists; watch the list re-sort and cap at 10.

- [ ] T020 In `app/index.html` §3 HIGH-SCORE STORE: implement the capability-probed store (ADR-3) — one-shot `setItem`/`getItem`/`removeItem` round-trip in try/catch to pick `localStorage` or an in-memory array backing; never throws. FR-022, SC-009.
- [ ] T021 In `app/index.html` §3: implement `record(score)` — push, stable sort descending (insert-after-existing-equal for ties), cap at `HS_MAX=10`, return the 0-based rank if it made the top-10 else −1, persist; and `list()` returning the descending array or `[]` when empty. FR-019, FR-021, SC-008.
- [ ] T022 In `app/index.html` §8: implement `renderHighScores()` — render `list()` into both `#hsSide` and `#hsGo` with `.top` (rank 1) and `.new` highlighting, **all keyed off the single `record()` rank** so the two lists stay in sync; empty state renders an empty list or one muted "No scores yet" placeholder with no badge. FR-020, FR-021, SC-008.

**Checkpoint**: The leaderboard records, re-sorts, caps at 10, persists across reload (SC-008), and degrades to in-memory without errors when storage is unavailable (SC-009).

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases and end-to-end validation against the spec's success criteria.

- [ ] T023 In `app/index.html` §6 INPUT: handle focus loss as **pause** — on `window.blur` / `visibilitychange` (hidden), stop gravity and ignore keys; resume on refocus. (Spec edge case; design.md §7.)
- [ ] T024 In `app/index.html`: handle remaining edge cases — rotation blocked on all sides leaves the piece in its last valid orientation; multiple simultaneous rows clear consumes only one next-piece and applies the multi-line bonus; a score tying an existing entry is inserted in stable order (deterministic).
- [ ] T025 Validate end-to-end against the spec's success criteria in `spec.md` — SC-001 (loads, zero console errors, no network requests), SC-002 (all 7 colours appear), SC-003 (no clipping), SC-004 (strictly increasing clear deltas, quad > 4 singles), SC-005 (faster at higher level), SC-006 (preview matches spawn), SC-007 (game over + restart), SC-008 (leaderboard persist/re-sort/cap), SC-009 (localStorage-unavailable fallback).
- [ ] T026 Verify the **implementation-time** items from `plan.md` / `design.md` §7: (a) the installed app's iframe is same-origin so the top-10 persists across a reload (SC-008) — if opaque-origin, the in-memory fallback is the expected non-buggy outcome (SC-009); (b) drop bonuses are per row actually dropped, not per keypress.

**Checkpoint**: All success criteria pass; the single-file game is complete and install-ready.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — starts immediately.
- **Foundational (Phase 2)**: depends on Setup — **blocks all user stories** (constants, pieces, grid, collision, loop).
- **User Stories (Phases 3–6)**: all depend on Phase 2.
  - US1 (P1) is the MVP and needs no other story.
  - US2 (P2) builds on US1's lock/clear (scoring + HUD + preview).
  - US3 (P3) builds on the state machine + `record()` hook from Phase 2.
  - US4 (P3) is the high-score store + list rendering; US3's overlay badge depends on US4's `record()`, so US4's store (T020/T021) should land before or alongside US3's overlay (T018). In a single file this is handled by completing Phases 3→6 in order.
- **Polish (Phase 7)**: depends on all stories complete.

### Within Each User Story

- Engine/state before input before rendering (foundational → US1 → HUD/preview).
- Core implementation before integration (e.g. `record()` before the overlay badge).
- A story is complete before moving to the next priority.

### Parallel Opportunities

- Limited by the single-file deliverable: T002 and T003 (theme vs. body DOM) are the only independent `[P]` tasks (separate `<style>` vs `<body>` regions). All other tasks touch shared `<script>` logic and are sequential.

---

## Implementation Strategy

The developer produces the single `item-falling-blocks/app/index.html` in one pass
following Phases 1→7; `app_install` then installs it. The MVP (User Story 1) is
reached at the end of Phase 3 — a fully playable, no-clip, line-clearing game — and
US2/US3/US4 layer progression, terminal state, and the leaderboard on top.

---

## Notes

- One deliverable file: `item-falling-blocks/app/index.html`; `app.json` is written by `app_install`, never hand-authored.
- `[P]` = independent region/no dependency; rare here because it is one file.
- The `mockup.html` is the binding visual contract for layout, the 7 piece colours, the dark theme, the drop-ghost, and the game-over overlay.
- No test framework is requested; validation is manual against `SC-001`…`SC-009` (Phase 7).
- Every move/rotation/drop goes through `collides()`, so clipping is structurally impossible (FR-008, SC-003).
