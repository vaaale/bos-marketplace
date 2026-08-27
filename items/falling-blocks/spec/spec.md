# Feature Specification: Falling Blocks

**Feature Branch**: n/a — marketplace item (flat id: `falling-blocks`)

**Created**: 2026-08-27

**Status**: Draft

**App Target**: marketplace-item

**Input**: User description: "Create a complete falling-blocks puzzle game in a single self-contained HTML file. No external libraries, no internet resources, no images: everything inline (HTML, CSS, JavaScript, canvas rendering, etc). 10×20 playfield on a canvas; seven 4-square pieces each with its own color; left/right move, up rotate, down soft-drop, space hard-drop; rotation respects walls and stacked blocks (no clipping); completed rows clear and rows above fall, multi-line clears score more; score/lines/level displayed, speed increases with level; next-piece preview; game over when the stack reaches the top with a visible game-over state and a restart key; clean readable dark visual style."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Play a complete game of falling blocks (Priority: P1)

The player opens the app and immediately sees a 10×20 dark playfield with a first tetromino already falling. They steer it with the arrow keys, rotate it against the walls and the growing stack, and clear completed rows — all with responsive, no-clip mechanics.

**Why this priority**: This is the entire reason the app exists — the core, playable loop. Without it there is no game.

**Independent Test**: Can be fully tested by launching the app, moving/rotating/dropping several pieces, filling a row, and observing it clear and the rows above fall.

**Acceptance Scenarios**:

1. **Given** the app is open, **When** it loads, **Then** a 10-wide × 20-tall playfield is rendered on a canvas with the first piece already present and descending.
2. **Given** a piece is falling, **When** the player presses Left/Right, **Then** the piece shifts one column in that direction without leaving the playfield or overlapping existing blocks.
3. **Given** a piece is falling, **When** the player presses Up, **Then** the piece rotates 90° and never ends up overlapping a wall or a stacked block (the move is rejected or kicked to a valid position).
4. **Given** a piece is falling, **When** the player presses Down, **Then** the piece moves one row down immediately (soft drop).
5. **Given** a piece is falling, **When** the player presses Space, **Then** the piece instantly falls to its lowest valid position and locks (hard drop).
6. **Given** a piece locks in place, **When** it completes a full horizontal row, **Then** that row clears and every row above it shifts down by one.
7. **Given** a newly locked piece, **When** it does not complete a row, **Then** it remains in the grid and the next piece spawns at the top.

---

### User Story 2 - Score, level, and speed progress (Priority: P2)

The player sees a live HUD (score, lines cleared, level) and a next-piece preview. Clearing more rows at once scores disproportionately more, and as the level rises the pieces fall faster, ramping up difficulty.

**Why this priority**: Progression and feedback are what turn the core loop into a game with stakes; they build directly on the P1 loop.

**Independent Test**: Can be tested by clearing single, double, triple, and quad lines and confirming the score, line count, and level update, and that a higher level drops pieces faster.

**Acceptance Scenarios**:

1. **Given** a row clears, **When** the clear is confirmed, **Then** the score increases and the lines-cleared counter increments.
2. **Given** the player clears multiple rows in a single lock, **When** compared to clearing the same rows one at a time, **Then** the multi-line clear awards more total points.
3. **Given** the lines-cleared total passes a level threshold, **When** the level increases, **Then** the piece fall speed increases.
4. **Given** the next piece is known, **When** the player looks at the preview box, **Then** the upcoming tetromino is shown there before it spawns.

---

### User Story 3 - Game over and restart (Priority: P3)

When the stack reaches the top and a new piece cannot spawn, the game ends in a clearly visible game-over state, and the player can start a fresh game with a single key press.

**Why this priority**: Terminal state handling completes the game arc; it depends on the P1 grid and P2 progression but is a distinct, testable slice.

**Independent Test**: Can be tested by letting the stack reach the top (or forcing it), confirming a visible game-over state appears, and pressing the restart key to get a clean fresh board.

**Acceptance Scenarios**:

1. **Given** the stack reaches the top such that a newly spawned piece cannot fit, **When** the game detects this, **Then** a clearly visible game-over state is shown (e.g. an overlay) and the loop stops.
2. **Given** the game-over state is shown, **When** the player presses the restart key, **Then** the board, score, lines, and level reset and a fresh game begins.

---

### User Story 4 - High score list (Priority: P3)

The player's best runs are recorded in a top-10 high score list that persists between sessions, shown in a visible panel and on the game-over screen.

**Why this priority**: Leaderboards add replay incentive and are explicitly requested, but they layer on top of the completed game loop and terminal state, so they form a distinct, independently testable slice.

**Independent Test**: Can be tested by playing to a score that qualifies for the top 10, confirming it appears in the list, reloading the page, and confirming it persists; and by watching the list re-sort and cap at 10.

**Acceptance Scenarios**:

1. **Given** a completed game with a score that ranks in the top 10, **When** the game ends, **Then** the score is added to the high score list.
2. **Given** the high score list is displayed, **When** the player views it, **Then** entries are ordered from highest to lowest score and at most 10 entries are shown.
3. **Given** the list already holds 10 entries, **When** a new qualifying score arrives, **Then** the lowest entry is dropped to keep the list at 10.
4. **Given** a high score was recorded, **When** the page is reloaded, **Then** the list still contains it (persisted across sessions).

---

### Edge Cases

- What happens when a rotation is blocked by a wall/stack on all sides — the piece stays in its last valid orientation (no clipping).
- What happens when a hard drop lands the piece in a column whose top row is already occupied — game over triggers.
- How does the system handle holding a movement key (auto-repeat) vs. a single press — movement must not be so fast pieces clip through blocks.
- What happens if multiple rows clear simultaneously — only one next-piece is consumed, score uses the multi-line bonus.
- What happens when the app loses keyboard focus — the game should not keep advancing silently (pause or at minimum not register stray keys).
- What happens when the player's final score ties an existing high score entry — the entry is accepted and inserted in a stable, deterministic order.
- What happens when the list already has 10 entries and a new qualifying score arrives — exactly one lowest entry is dropped so the list stays capped at 10.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST render a 10-column × 20-row playfield on an HTML `<canvas>`.
- **FR-002**: System MUST use exactly seven tetromino shapes, each composed of four square cells, each rendered in its own distinct, recognizable color.
- **FR-003**: System MUST move the active piece one column left on Left-arrow input, within bounds.
- **FR-004**: System MUST move the active piece one column right on Right-arrow input, within bounds.
- **FR-005**: System MUST rotate the active piece 90° on Up-arrow input.
- **FR-006**: System MUST move the active piece one row down (soft drop) on Down-arrow input.
- **FR-007**: System MUST drop the active piece to its lowest valid position and lock it immediately on Spacebar input (hard drop).
- **FR-008**: System MUST reject or resolve any move/rotation that would cause the active piece to overlap a wall or an existing block — pieces MUST never clip through the board boundary or stacked blocks.
- **FR-009**: System MUST clear every fully-filled horizontal row when a piece locks, and shift all rows above each cleared row downward.
- **FR-010**: System MUST award points when lines clear, and clearing more than one line in a single lock MUST award more total points than the same rows cleared individually [NEEDS CLARIFICATION: exact point values / formula for 1/2/3/4-line clears, and whether soft/hard drops grant bonus points — default: single=100, double=300, triple=500, quad=800; soft-drop +1/row, hard-drop +2/row].
- **FR-011**: System MUST display the current score, total lines cleared, and current level in a visible HUD.
- **FR-012**: System MUST increase the piece fall speed as the level rises.
- **FR-013**: System MUST increase the level when the lines-cleared total crosses a threshold [NEEDS CLARIFICATION: lines per level — default: 10 lines per level, level = floor(lines/10) + 1].
- **FR-014**: System MUST show a next-piece preview box displaying the upcoming tetromino (shape and color) before it spawns.
- **FR-015**: System MUST end the game when the stack reaches the top such that a newly spawned piece cannot be placed (game over).
- **FR-016**: System MUST present a clearly visible game-over state (e.g. a full-board or panel overlay) when the game ends, halting the play loop.
- **FR-017**: System MUST restart the game from the game-over state (and reset score/lines/level/board) on a dedicated restart key [NEEDS CLARIFICATION: which key — default: Enter].
- **FR-018**: System MUST present a clean, readable dark visual style (dark background, legible piece colors, readable HUD text).
- **FR-019**: System MUST maintain a high score list of the top 10 scores, persisted in the browser's `localStorage` so it survives page reloads.
- **FR-020**: System MUST display the high score list in a visible panel (and again on the game-over screen) [NEEDS CLARIFICATION: name entries — default: score-only list of the top 10, no player names/initials].
- **FR-021**: System MUST insert the player's final score at game over if it ranks within the top 10, re-sort the list in descending order, and drop the lowest entry when the list is already full.
- **FR-022**: System MUST handle an unavailable or disabled `localStorage` gracefully (fall back to an in-memory list for the current session) without throwing errors.

### Non-Functional Requirements

- **NFR-001**: The entire game MUST be delivered as a single self-contained HTML file with all HTML, CSS, and JavaScript inline — no external libraries, no CDNs, no network calls, no image assets.
- **NFR-002**: The game loop MUST run smoothly (target ~60 fps) with responsive, lag-free keyboard controls on a desktop browser.
- **NFR-003**: The HUD, playfield, and preview box MUST remain legible at the default layout size without scrolling.

### Key Entities *(include if feature involves data)*

- **Playfield Grid**: 10×20 2D array of cell states (empty or a tetromino color).
- **Active Piece**: current tetromino — shape id, color, column, row, and rotation state.
- **Tetromino Set**: the seven fixed shapes (I, O, T, S, Z, J, L), each with a defined set of 4-cell coordinates per rotation and a unique color.
- **Game State**: score, lines cleared, level, current/next piece id, and run state (playing / game-over).
- **Next Piece**: the tetromino id queued to spawn after the current piece locks.
- **High Score Table**: ordered list of up to 10 recorded scores, persisted in `localStorage`; each entry is a score (and optionally a player name/initials).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The app loads to a playable state with zero console errors and no external network requests.
- **SC-002**: All seven tetromino shapes appear over a full play session, each in a distinct color.
- **SC-003**: No move or rotation ever produces a piece that overlaps the board boundary or a stacked block (verified by visual inspection across wall/stack edges).
- **SC-004**: A single, double, triple, and quad line clear each produce a strictly increasing score delta, with the quad exceeding the sum of four single clears.
- **SC-005**: Reaching a higher level produces a measurably faster fall speed than the previous level.
- **SC-006**: The next-piece preview always matches the piece that actually spawns.
- **SC-007**: Letting the stack reach the top produces a visible game-over state; pressing the restart key yields a clean, fresh board.
- **SC-008**: A qualifying score is recorded into the top 10, the list re-sorts descending, the lowest entry is dropped beyond 10, and the list persists across page reloads.
- **SC-009**: When `localStorage` is unavailable, the game still runs and keeps an in-memory high score list without throwing errors.

## Assumptions

- Single-player, local, keyboard-only desktop experience; no multiplayer, no touch/mobile controls, no sound (all out of scope for v1). The high score list is the one persistence feature: it lives in the player's browser (`localStorage`), not on a server, so there is no cross-device leaderboard.
- Rotation uses standard collision detection with wall/stack kicks so the piece always resolves to a valid position when one exists.
- Pieces spawn at the top of the playfield and the next piece is drawn from a uniform random bag of the seven tetrominoes.
- Defaults for the open clarifications: scoring single=100 / double=300 / triple=500 / quad=800 with small soft/hard-drop bonuses; 10 lines per level; restart key = Enter; high score list is score-only (no player names).
