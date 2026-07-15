# Feature Specification: Welcome (sample)

**Status**: Sample

**Input**: "A minimal spec you can adopt from the marketplace to see how the flow
works: adopting forks this folder into your own `user-specs` store, where you own
and evolve it via Build Studio."

## Why this exists

This is a demonstration item for the BrowserOS Marketplace. Adopting a spec copies
it into your writable user spec store with no ongoing link to the marketplace —
from that point it's yours to edit, branch, and promote.

## User Scenarios

### User Story 1 — Adopt and edit (Priority: P1)

A user browses the marketplace, clicks **Adopt spec** on this item, and the folder
appears in their own spec store. Opening Build Studio, they can edit it on a
feature branch like any spec they authored.

**Acceptance Scenarios**:
1. **Given** this item in the marketplace, **When** the user adopts it, **Then** a
   copy lands in `user-specs/` (de-duplicated id) and is committed.
2. **Given** the adopted spec, **When** the user edits it in Build Studio, **Then**
   it behaves exactly like a user-authored spec (no marketplace coupling remains).
