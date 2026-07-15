# Feature Specification: <Your App> (BOS app starter)

**Status**: Template — adopt, rename, and fill in.

**Input**: "Describe the app you want in one paragraph: who it's for, the single
job it does, and what 'done' looks like."

> Adopt this into your `user-specs` store, then drive it through Build Studio
> (specify → clarify → plan → tasks → implement). The Developer builds the app as
> a sandboxed installed app; you never write BOS source directly.

## What you're building

A **sandboxed installed app** (an iframe app served from GitFS). It reaches
BrowserOS only through the granted-capability SDK (`window.__bos`): `fs:*`,
`settings:read`, `notify`, `window:title`, `storage`. Persist state with
`localStorage` (BOS backs it per-app when `storage` is granted). Assume it may run
opaque-origin — talk to BOS via the SDK, not direct `fetch`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — <primary job> (Priority: P1)

<As a … I want … so that …>

**Independent Test**: <how to verify this story alone.>

**Acceptance Scenarios**:
1. **Given** <state>, **When** <action>, **Then** <observable result>.
2. **Given** <state>, **When** <action>, **Then** <observable result>.

## Requirements *(mandatory)*

- **FR-001**: The app MUST <capability>.
- **FR-002**: The app MUST <capability>.
- **FR-003**: State MUST persist across reloads via `localStorage` (or `__bos.storage`).

## Capabilities requested

List the BOS SDK capabilities the app needs (granted at install):
`storage` · `fs:read` · `fs:write` · `settings:read` · `notify` · `window:title`.
Request the minimum set.

## Success Criteria *(mandatory)*

- **SC-001**: <measurable outcome, e.g. "a user completes <task> in < N seconds">.
- **SC-002**: <measurable outcome>.

## Out of scope

- <explicitly excluded for v1>
