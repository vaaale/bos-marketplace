# Tasks: Lunar Lander Game

**Input**: Design documents from `/specs/user-specs/lunar-lander/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), data-model.md, contracts/, quickstart.md

**Tests**: Unit tests included (Jest), E2E tests included (Playwright)

**Organization**: Tasks grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Includes exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [ ] T001 Create project directory structure at `src/apps/lunar-lander/` per implementation plan
- [ ] T002 Initialize TypeScript + React project with Vite bundler in `src/apps/lunar-lander/`
- [ ] T003 [P] Configure ESLint and Prettier for TypeScript/React in `src/apps/lunar-lander/.eslintrc.json` and `.prettierrc`
- [ ] T004 Install dependencies: react, react-dom, typescript, vite, @types/react, @types/react-dom

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core game infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T005 Create `src/apps/lunar-lander/src/game/utils/Vector2.ts` with 2D vector math operations (add, subtract, scale, magnitude, normalize)
- [ ] T006 Create `src/apps/lunar-lander/src/game/utils/Constants.ts` with game balance parameters (GRAVITY, THRUST_POWER, MAX_LANDING_VELOCITY, etc.)
- [ ] T007 Create `src/apps/lunar-lander/src/hooks/useGameLoop.ts` React hook for requestAnimationFrame-based game loop management
- [ ] T008 Create `src/apps/lunar-lander/src/hooks/useKeyboardInput.ts` React hook for keyboard input state management

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Play Basic Lunar Lander Game (Priority: P1) 🎯 MVP

**Goal**: Core gameplay loop with physics simulation, thrust control, and landing validation

**Independent Test**: Can be fully tested by launching the game window and attempting to land on a designated pad, measuring success rate based on landing criteria.

### Tests for User Story 1 ⚠️

- [ ] T009 [P] [US1] Unit test for Vector2 operations in `src/apps/lunar-lander/tests/unit/Vector2.test.ts`
- [ ] T010 [P] [US1] Unit test for Physics calculations in `src/apps/lunar-lander/tests/unit/Physics.test.ts`
- [ ] T011 [P] [US1] Unit test for collision detection in `src/apps/lunar-lander/tests/unit/CollisionSystem.test.ts`
- [ ] T012 [P] [US1] E2E test for successful landing scenario in `src/apps/lunar-lander/tests/e2e/successful-landing.spec.ts`
- [ ] T013 [P] [US1] E2E test for crash detection (excessive speed) in `src/apps/lunar-lander/tests/e2e/crash-speed.spec.ts`
- [ ] T014 [P] [US1] E2E test for crash detection (missed pad) in `src/apps/lunar-lander/tests/e2e/crash-pad.spec.ts`

### Implementation for User Story 1

- [ ] T015 [P] [US1] Create `src/apps/lunar-lander/src/game/entities/Lander.ts` with position, velocity, fuel, angle state and update logic
- [ ] T016 [P] [US1] Create `src/apps/lunar-lander/src/game/entities/LandingPad.ts` with pad geometry and validation methods
- [ ] T017 [P] [US1] Create `src/apps/lunar-lander/src/game/entities/Terrain.ts` with ground surface rendering logic
- [ ] T018 [US1] Create `src/apps/lunar-lander/src/game/engine/Physics.ts` implementing gravity, thrust acceleration, and velocity integration
- [ ] T019 [US1] Create `src/apps/lunar-lander/src/game/engine/GameState.ts` with state machine (MENU, PLAYING, LANDED, CRASHED, GAME_OVER)
- [ ] T020 [US1] Create `src/apps/lunar-lander/src/game/systems/InputSystem.ts` handling keyboard events and mapping to thrust/rotation actions
- [ ] T021 [US1] Create `src/apps/lunar-lander/src/game/systems/CollisionSystem.ts` implementing landing validation (position + velocity checks)
- [ ] T022 [US1] Create `src/apps/lunar-lander/src/game/engine/GameLoop.ts` orchestrating update cycle with delta time
- [ ] T023 [P] [US1] Create `src/apps/lunar-lander/src/components/GameCanvas.tsx` as Canvas wrapper component
- [ ] T024 [US1] Create `src/apps/lunar-lander/src/game/systems/RenderSystem.ts` implementing Canvas drawing for lander, terrain, and effects

**Checkpoint**: At this point, User Story 1 should be fully functional - player can control lander, descend, and achieve valid or invalid landings

---

## Phase 4: User Story 2 - View Game HUD and Feedback (Priority: P1)

**Goal**: Real-time display of altitude, velocity, fuel, and game state feedback

**Independent Test**: Can be tested by launching the game and verifying all HUD elements display correct, updating values throughout a descent sequence.

### Tests for User Story 2 ⚠️

- [ ] T025 [P] [US2] Unit test for score calculation in `src/apps/lunar-lander/tests/unit/ScoreSystem.test.ts`
- [ ] T026 [P] [US2] Integration test for HUD updates at 30+ FPS in `src/apps/lunar-lander/tests/integration/hud-performance.test.ts`

### Implementation for User Story 2

- [ ] T027 [P] [US2] Create `src/apps/lunar-lander/src/components/HUD.tsx` displaying altitude, vertical velocity, horizontal velocity, and fuel
- [ ] T028 [P] [US2] Create `src/apps/lunar-lander/src/components/GameOver.tsx` showing success/failure messages with score
- [ ] T029 [US2] Create `src/apps/lunar-lander/src/game/systems/ScoreSystem.ts` calculating base score, fuel bonus, and precision bonus
- [ ] T030 [US2] Update `src/apps/lunar-lander/src/components/GameCanvas.tsx` to integrate HUD overlay rendering
- [ ] T031 [US2] Update `src/apps/lunar-lander/src/game/engine/GameState.ts` to include score tracking and high score persistence with localStorage

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently - gameplay is complete with full visual feedback

---

## Phase 5: User Story 3 - Restart After Game Over (Priority: P2)

**Goal**: Game restart functionality without closing the application

**Independent Test**: Can be tested by completing one game (success or failure) and pressing restart, then verifying a fresh game state begins.

### Tests for User Story 3 ⚠️

- [ ] T032 [P] [US3] Integration test for restart flow in `src/apps/lunar-lander/tests/integration/restart-flow.test.ts`

### Implementation for User Story 3

- [ ] T033 [P] [US3] Create `src/apps/lunar-lander/src/components/Menu.tsx` with main menu and difficulty selection UI
- [ ] T034 [US3] Update `src/apps/lunar-lander/src/game/engine/GameState.ts` to handle restart transitions (GAME_OVER → MENU → PLAYING)
- [ ] T035 [US3] Update `src/apps/lunar-lander/src/hooks/useKeyboardInput.ts` to detect Enter/R key for restart in GAME_OVER state
- [ ] T036 [US3] Update `src/apps/lunar-lander/src/game/engine/GameLoop.ts` to reset game state on restart command

**Checkpoint**: At this point, User Stories 1, 2, AND 3 should all work independently - full gameplay loop with restart capability

---

## Phase 6: User Story 4 - Adjust Game Difficulty (Priority: P3)

**Goal**: Difficulty selection affecting gravity and landing pad size

**Independent Test**: Can be tested by selecting each difficulty level and verifying landing pad size, gravity strength change accordingly.

### Tests for User Story 4 ⚠️

- [ ] T037 [P] [US4] Unit test for difficulty modifiers in `src/apps/lunar-lander/tests/unit/Difficulty.test.ts`
- [ ] T038 [P] [US4] E2E test for Easy difficulty (larger pad, weaker gravity) in `src/apps/lunar-lander/tests/e2e/difficulty-easy.spec.ts`
- [ ] T039 [P] [US4] E2E test for Hard difficulty (smaller pad, stronger gravity) in `src/apps/lunar-lander/tests/e2e/difficulty-hard.spec.ts`

### Implementation for User Story 4

- [ ] T040 [P] [US4] Update `src/apps/lunar-lander/src/game/utils/Constants.ts` to include DIFFICULTY_MODIFIERS object
- [ ] T041 [US4] Update `src/components/Menu.tsx` to include difficulty selection buttons (Easy/Normal/Hard)
- [ ] T042 [US4] Update `src/apps/lunar-lander/src/game/engine/GameState.ts` to store and apply selected difficulty
- [ ] T043 [US4] Update `src/apps/lunar-lander/src/game/systems/Physics.ts` to apply difficulty modifiers to gravity calculation
- [ ] T044 [US4] Update `src/apps/lunar-lander/src/game/entities/Terrain.ts` to generate landing pad with difficulty-based width

**Checkpoint**: All user stories should now be independently functional - complete game with adjustable difficulty

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T045 [P] Create `src/apps/lunar-lander/src/styles/game.css` with game-specific styling (HUD layout, menu styling, overlays)
- [ ] T046 [P] Update `src/apps/lunar-lander/index.html` with proper meta tags and canvas container
- [ ] T047 [US1-US4] Add visual particle effects for thrust exhaust in `src/apps/lunar-lander/src/game/systems/RenderSystem.ts`
- [ ] T048 [US1-US4] Implement smooth camera follow to keep lander centered during descent
- [ ] T049 Run quickstart.md validation scenarios and document results
- [ ] T050 [P] Add JSDoc comments to all game logic files for documentation
- [ ] T051 Code cleanup: Refactor any duplicated logic across systems
- [ ] T052 Performance optimization: Profile and optimize render loop if FPS drops below 60

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-6)**: All depend on Foundational phase completion
  - US1 (P1) must complete before US2 can fully integrate (HUD needs game state)
  - US2 can start after Foundational but benefits from US1 progress
  - US3 depends on US2 (needs GameOver component to exist)
  - US4 depends on US3 (Menu must exist for difficulty selection)
- **Polish (Phase 7)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P1)**: Can start after Foundational (Phase 2), but HUD integration requires US1's GameCanvas and GameState to exist
- **User Story 3 (P2)**: Depends on US2 completion (GameOver component must exist)
- **User Story 4 (P3)**: Depends on US3 completion (Menu component must exist)

### Within Each User Story

- Tests (if included) SHOULD be written first, ensure they FAIL before implementation
- Entities before systems
- Systems before game loop integration
- Core implementation before UI integration
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel (T003)
- All Foundational tasks marked [P] can run in parallel (T005, T006, T007, T008 - different files)
- Within US1: 
  - Tests T009-T014 can all run in parallel
  - Entities T015, T016, T017 can run in parallel
  - After entities complete, systems T020, T021 can run in parallel
- Within US2: Tests T025, T026 can run in parallel; HUD components T027, T028 can run in parallel
- Within US3: Test T032 and component T033 can run in parallel
- Within US4: Tests T037-T039 can run in parallel; Constants update T040 independent of other tasks

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Unit test for Vector2 operations in src/apps/lunar-lander/tests/unit/Vector2.test.ts"
Task: "Unit test for Physics calculations in src/apps/lunar-lander/tests/unit/Physics.test.ts"
Task: "Unit test for collision detection in src/apps/lunar-lander/tests/unit/CollisionSystem.test.ts"
Task: "E2E test for successful landing scenario in src/apps/lunar-lander/tests/e2e/successful-landing.spec.ts"
Task: "E2E test for crash detection (excessive speed) in src/apps/lunar-lander/tests/e2e/crash-speed.spec.ts"
Task: "E2E test for crash detection (missed pad) in src/apps/lunar-lander/tests/e2e/crash-pad.spec.ts"

# Launch all entities for User Story 1 together:
Task: "Create Lander entity in src/apps/lunar-lander/src/game/entities/Lander.ts"
Task: "Create LandingPad entity in src/apps/lunar-lander/src/game/entities/LandingPad.ts"
Task: "Create Terrain entity in src/apps/lunar-lander/src/game/entities/Terrain.ts"

# After entities complete, launch systems in parallel:
Task: "Create InputSystem in src/apps/lunar-lander/src/game/systems/InputSystem.ts"
Task: "Create CollisionSystem in src/apps/lunar-lander/src/game/systems/CollisionSystem.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1 (basic gameplay with physics and landing)
4. **STOP and VALIDATE**: Test US1 independently using E2E tests T012-T014
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Run E2E tests → MVP gameplay working!
3. Add User Story 2 → Verify HUD updates correctly → Full visual feedback
4. Add User Story 3 → Test restart flow → Complete game loop
5. Add User Story 4 → Validate difficulty changes → Enhanced replayability
6. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together (T001-T008)
2. Once Foundational is done, parallel workstreams:
   - Developer A: User Story 1 (core gameplay)
   - Developer B: User Story 2 (HUD components) - can start after T015-T017 complete
3. After US1 + US2 complete:
   - Developer A or B: User Story 3 (restart functionality)
4. Finally:
   - Any developer: User Story 4 (difficulty levels)

---

## Notes

- [P] tasks = different files, no dependencies on other incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify E2E tests fail before implementing corresponding features
- Commit after each task or logical group (entities, systems)
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
- Performance target: 60 FPS with all rendering and logic complete
