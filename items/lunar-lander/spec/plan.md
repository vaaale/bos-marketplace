# Implementation Plan: Lunar Lander Game

**Branch**: `lunar-lander` | **Date**: 2026-01-09 | **Spec**: `user-specs/lunar-lander/spec.md`

**Input**: Feature specification from `/specs/user-specs/lunar-lander/spec.md`

## Summary

Build a classic Lunar Lander game for BrowserOS featuring 2D physics simulation, real-time HUD display, and interactive gameplay. The game will be implemented as a standalone web application using HTML5 Canvas for rendering and vanilla JavaScript for game logic, providing an authentic retro gaming experience within the BrowserOS environment.

## Technical Context

**Language/Version**: TypeScript 5.x (compiled to ES2020)

**Primary Dependencies**: 
- React 18+ (UI framework for HUD and menus)
- HTML5 Canvas API (game rendering)
- CSS3 (styling for game window and overlays)

**Storage**: Browser localStorage (for high score persistence)

**Testing**: Jest + React Testing Library (unit tests), Playwright (E2E gameplay tests)

**Target Platform**: Modern web browsers (Chrome, Firefox, Safari, Edge - last 2 versions)

**Project Type**: desktop-app (standalone game application within BrowserOS)

**Performance Goals**: 
- 60 FPS rendering target
- Input latency < 16ms
- Game loop tick every 16.67ms (60Hz)

**Constraints**: 
- Single browser tab, no external network calls during gameplay
- Max memory footprint: 50MB
- Must work with keyboard controls (Arrow keys/WASD for thrust/rotation)

**Scale/Scope**: Single-player game with difficulty levels, score tracking, and restart functionality

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Based on BrowserOS constitution principles:

- ✅ **Spec-first development**: Feature spec exists at `user-specs/lunar-lander/spec.md`
- ✅ **Modular design**: Game logic, rendering, and UI separated into distinct modules
- ✅ **User value focused**: Primary user stories define clear gameplay experience
- ✅ **Testable requirements**: All functional requirements have acceptance criteria
- ✅ **Measurable success criteria**: Performance targets (60 FPS, <16ms latency) defined
- ✅ **No implementation leakage in spec**: Spec focuses on WHAT, not HOW

**Gates passed**: 6/6 - Ready for Phase 0 research

## Project Structure

### Documentation (this feature)

```text
user-specs/lunar-lander/
├── spec.md              # Feature specification (already created)
├── plan.md              # This file (implementation plan)
├── tasks.md             # Task breakdown (created by speckit.tasks)
└── discrepancies.md     # Spec/code drift tracking (if needed)
```

### Source Code (BrowserOS apps directory)

```text
src/apps/lunar-lander/
├── package.json                 # Dependencies and scripts
├── tsconfig.json               # TypeScript configuration
├── vite.config.ts              # Build configuration
├── index.html                  # Entry HTML file
├── src/
│   ├── main.tsx                # Application entry point
│   ├── App.tsx                 # Root component
│   ├── game/
│   │   ├── engine/
│   │   │   ├── GameLoop.ts     # Main game loop (60 FPS)
│   │   │   ├── Physics.ts      # 2D physics simulation
│   │   │   └── GameState.ts    # State management
│   │   ├── entities/
│   │   │   ├── Lander.ts       # Player-controlled lander
│   │   │   ├── LandingPad.ts   # Landing zone definition
│   │   │   └── Terrain.ts      # Ground surface with pad
│   │   ├── systems/
│   │   │   ├── InputSystem.ts  # Keyboard event handling
│   │   │   ├── RenderSystem.ts # Canvas drawing logic
│   │   │   └── CollisionSystem.ts # Landing/crash detection
│   │   └── utils/
│   │       ├── Vector2.ts      # 2D vector math
│   │       └── Constants.ts    # Game balance parameters
│   ├── components/
│   │   ├── GameCanvas.tsx      # Canvas wrapper component
│   │   ├── HUD.tsx             # Heads-up display (altitude, velocity, fuel)
│   │   ├── GameOver.tsx        # End-game screen (success/failure)
│   │   └── Menu.tsx            # Main menu with difficulty selection
│   ├── hooks/
│   │   ├── useGameLoop.ts      # React hook for game loop management
│   │   └── useKeyboardInput.ts # Input state management hook
│   └── styles/
│       └── game.css            # Game-specific styling
├── public/
│   └── assets/                 # Static assets (if any)
└── tests/
    ├── unit/
    │   ├── physics.test.ts     # Physics calculations
    │   ├── lander.test.ts      # Lander behavior
    │   └── collision.test.ts   # Landing validation logic
    ├── integration/
    │   └── game-flow.test.ts   # End-to-end gameplay scenarios
    └── e2e/
        └── gameplay.spec.ts    # Playwright E2E tests
```

**Structure Decision**: Single React application with clear separation of concerns:
- **Game engine** (`src/game/`) handles pure game logic, physics, and state
- **React components** (`src/components/`) handle UI rendering (HUD, menus)
- **Custom hooks** (`src/hooks/`) bridge React lifecycle with game loop
- **Tests organized by level**: unit (logic), integration (flows), E2E (playability)

## Research Artifacts

### Phase 0: Technology Decisions

**Decision**: HTML5 Canvas vs WebGL
- **Chosen**: HTML5 Canvas (2D context)
- **Rationale**: Simpler for 2D sprite-based rendering, sufficient performance for single lander + terrain, smaller bundle size
- **Alternatives considered**: PixiJS (overkill for simple 2D), Three.js (unnecessary 3D overhead)

**Decision**: Game loop implementation
- **Chosen**: `requestAnimationFrame` with delta time calculation
- **Rationale**: Native browser optimization, smooth 60 FPS when possible, gracefully degrades on slow devices
- **Alternatives considered**: `setInterval` (less precise), Web Workers (unnecessary complexity)

**Decision**: State management approach
- **Chosen**: Immutable state with Redux-like pattern (no external library)
- **Rationale**: Predictable state transitions for game logic, easy time-travel debugging potential, minimal bundle overhead
- **Alternatives considered**: Mutable state (harder to debug), Zustand/Redux (unnecessary for single-player game)

**Decision**: Physics simulation approach
- **Chosen**: Custom 2D physics with constant gravity and thrust vectors
- **Rationale**: Authentic Lunar Lander mechanics, deterministic behavior, educational value
- **Alternatives considered**: Matter.js (overkill for simple gravity), Box2D (too heavy)

### Phase 1: Data Model & Contracts

#### Data Model (`data-model.md`)

```markdown
# Lunar Lander Data Model

## Key Entities

### Lander
**Purpose**: Player-controlled spacecraft
**State**:
- `position: Vector2` - Current x,y coordinates (pixels from top-left)
- `velocity: Vector2` - Current vx,vy in pixels/second
- `fuel: number` - Remaining fuel (0-100 percentage)
- `angle: number` - Rotation in degrees (-180 to 180, 0 = upright)
- `thrusting: boolean` - Whether thrust is currently active

**Lifecycle**: Created at spawn position → Updated each frame → Destroyed on landing/crash

### LandingPad
**Purpose**: Target zone for successful landing
**State**:
- `x: number` - Left edge x-coordinate
- `width: number` - Pad width in pixels
- `y: number` - Ground level y-coordinate (fixed)
- `angleRange: [min, max]` - Acceptable approach angles

**Lifecycle**: Static throughout game session

### GameState
**Purpose**: Overall game state machine
**States**:
- `MENU` - Waiting at main menu
- `PLAYING` - Active descent in progress
- LANDED` - Successful landing completed
- `CRASHED` - Failed landing (speed or position)
- `GAME_OVER` - Post-game screen showing results

**Transitions**:
- MENU → PLAYING (on game start)
- PLAYING → LANDED (valid touchdown)
- PLAYING → CRASHED (invalid touchdown)
- LANDED → GAME_OVER (after delay)
- CRASHED → GAME_OVER (after delay)
- GAME_OVER → MENU (on restart)

## Validation Rules

### Landing Success Criteria
```typescript
function isValidLanding(state: GameState): boolean {
  return (
    lander.position.x >= pad.x && 
    lander.position.x <= pad.x + pad.width &&
    Math.abs(lander.velocity.y) <= MAX_LANDING_VELOCITY &&
    Math.abs(lander.angle) <= MAX_LANDING_ANGLE
  );
}
```

### Crash Conditions
```typescript
function isCrash(state: GameState): boolean {
  const onGround = lander.position.y >= GROUND_LEVEL;
  return (
    onGround && (
      !isWithinPad(lander, pad) || 
      Math.abs(lander.velocity.y) > MAX_LANDING_VELOCITY
    )
  );
}
```

## Game Balance Constants (`Constants.ts`)

| Parameter | Value | Purpose |
|-----------|-------|---------|
| GRAVITY | 9.8 pixels/s² | Downward acceleration |
| THRUST_POWER | 15 pixels/s² | Upward acceleration when firing |
| ROTATION_SPEED | 2 degrees/frame | Turn rate |
| MAX_LANDING_VELOCITY | 20 pixels/s | Vertical speed limit for safe landing |
| MAX_LANDING_ANGLE | 15 degrees | Orientation tolerance |
| INITIAL_FUEL | 100% | Starting fuel capacity |
| FUEL_CONSUMPTION | 0.5%/frame | Fuel burn rate when thrusting |
| SPAWN_HEIGHT | 600 pixels | Initial lander altitude |
| DIFFICULTY_MODIFIERS | { Easy: 0.8, Normal: 1.0, Hard: 1.3 } | Gravity/pad size multipliers |
```

#### Interface Contracts (`contracts/`)

**Contract**: Game Input Interface
```typescript
interface InputState {
  thrust: boolean;      // Up arrow / W key
  rotateLeft: boolean;  // Left arrow / A key  
  rotateRight: boolean; // Right arrow / D key
  restart: boolean;     // Enter / R key (only in GAME_OVER)
}
```

**Contract**: HUD Data Interface
```typescript
interface HUDData {
  altitude: number;        // Distance to ground (pixels)
  verticalVelocity: number; // vy component (pixels/s)
  horizontalVelocity: number; // vx component (pixels/s)
  fuelPercentage: number;   // 0-100
  gameState: GameState;     // Current state enum
}
```

**Contract**: Score Calculation
```typescript
interface ScoreResult {
  success: boolean;        // Was landing valid?
  baseScore: number;       // Points for successful landing
  fuelBonus: number;       // Bonus for remaining fuel
  precisionBonus: number;  // Bonus for precise alignment
  totalScore: number;      // Final score
}

function calculateScore(landingData: LandingData): ScoreResult;
```

#### Quickstart Guide (`quickstart.md`)

```markdown
# Lunar Lander - Quickstart Validation

## Prerequisites
- Node.js 18+ installed
- BrowserOS development environment set up
- npm or yarn package manager

## Setup & Run

```bash
# Navigate to the game directory
cd src/apps/lunar-lander

# Install dependencies
npm install

# Start development server (hot-reload enabled)
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

## Validation Scenarios

### Scenario 1: Basic Launch and Control
**Prerequisites**: Dev server running, game window open

**Steps**:
1. Press "Start Game" on main menu
2. Observe lander appears at top of screen
3. Press ↑ (Up Arrow) or W key
4. Verify lander accelerates upward
5. Check fuel gauge decreases

**Expected Outcome**: Lander moves up, fuel depletes proportionally to thrust duration

### Scenario 2: Successful Landing
**Prerequisites**: Game in PLAYING state

**Steps**:
1. Use ↑/↓ arrows to control descent rate
2. Use ←/→ arrows to align horizontally with landing pad
3. Touch down on pad with vertical velocity < 20 pixels/s
4. Observe game state change

**Expected Outcome**: 
- HUD shows "Landing Successful" message
- Score displayed based on remaining fuel and precision
- Game transitions to GAME_OVER state

### Scenario 3: Crash Detection
**Prerequisites**: Game in PLAYING state

**Steps**:
1. Descend with vertical velocity > 20 pixels/s
2. Touch down (regardless of pad alignment)

**Expected Outcome**:
- HUD shows "Crash - Excessive Speed" message
- Game transitions to GAME_OVER state

### Scenario 4: Restart Functionality
**Prerequisites**: Game in GAME_OVER state

**Steps**:
1. Press Enter or R key
2. Verify main menu returns
3. Start new game

**Expected Outcome**: 
- Lander resets to spawn position
- Fuel restored to 100%
- Previous score preserved in high score display

### Scenario 5: HUD Updates
**Prerequisites**: Game in PLAYING state

**Steps**:
1. Observe HUD during descent
2. Apply varying thrust levels
3. Monitor altitude, velocity, and fuel displays

**Expected Outcome**: 
- All values update at ≥30 FPS
- Fuel decreases only when thrusting
- Velocity reflects physics simulation accurately
```

## Complexity Tracking

> **No violations found** - The chosen architecture aligns with BrowserOS conventions for standalone apps.

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| Framework | React 18+ | Consistent with other BrowserOS apps, leverages existing patterns |
| State Management | Custom immutable pattern | Lightweight, predictable, no external dependencies needed |
| Rendering | HTML5 Canvas | Native browser API, sufficient for 2D game, zero bundle overhead |
| Testing Strategy | Jest + Playwright | Standard stack for unit + E2E testing in BrowserOS ecosystem |

## Next Steps

1. **Run `__SPECKIT_COMMAND_TASKS__`** to generate detailed task breakdown
2. **Delegate to Developer** via `__SPECKIT_COMMAND_IMPLEMENT__` with this plan and spec
3. **Review implementation** against acceptance criteria in spec.md
