# Implementation Plan: Agentic Text Editor

**Branch**: `[###-agentic-text-editor]` | **Date**: 2026-05-21 | **Spec**: `user-specs/agentic-text-editor/spec.md`

**Input**: Feature specification from `user-specs/agentic-text-editor/spec.md`

## Summary

A two-pane marketplace app for editing text/markdown documents with an embedded AI chat that can read, write, and modify document contents directly. Left pane: tabbed document editor with Edit/Preview toggle. Right pane: global chat with the agent. Agent edits modify an internal buffer — content persists to disk only on explicit save. Extensible format architecture for future document types.

## Technical Context

**Language/Version**: TypeScript 5.x, React 18 (marketplace app)

**Primary Dependencies**: BrowserOS OS store (`useOSStore`), VFS file system API, assistant capabilities registry

**Storage**: BrowserOS VFS for file persistence. Internal buffer is client-side Zustand/React state. Settings stored in config namespace.

**Testing**: BOS standard: `npx tsc --noEmit` and `npm run lint`. Playwright e2e tests in `e2e/agentic-text-editor.spec.ts`.

**Target Platform**: BrowserOS marketplace app — served from `data/user-apps/items/agentic-text-editor/` as a separate HTTP process, not compiled into the BOS bundle.

**Project Type**: Marketplace app (not built-in).

**Performance Goals**: Live agent edits reflect in editor within 1 second. Tab switching feels instant. Scroll at 60fps.

**Constraints**: 
- Must follow BOS style guide (dark-only, opacity palette, inline Tailwind, lucide-react icons)
- Must follow marketplace app anatomy (`app.json` + `index.tsx`)
- No external UI libraries
- Internal buffer is not persisted until explicit save
- Chat is global (one conversation per app instance)

**Scale/Scope**: Single app window. Unlimited tabs. 1-5 typical. Format handlers are pluggable.

## Constitution Check

*GATE: Must pass before implementation. Re-check after implementation.*

- **Dark-only theme**: The app uses the BOS opacity palette exclusively. No light mode. ✓
- **Marketplace app anatomy**: Will follow `data/user-apps/items/<id>/app.json` + `index.tsx` pattern. ✓
- **No external UI libraries**: Only lucide-react icons and inline Tailwind utilities. ✓
- **SSR/hydration**: All interactive components marked `"use client"`. No client-only initial state. ✓
- **OS state via selectors**: Uses `useOSStore` selectors for window management and settings. ✓
- **Tool registration**: Assistant tools registered via capabilities registry. ✓
- **Config namespace**: Editor settings stored in a config namespace. ✓

## Project Structure

### Documentation (this feature)

```text
user-specs/agentic-text-editor/
├── spec.md              # Feature specification
├── plan.md              # This file (implementation plan)
├── tasks.md             # Task list (generated next)
├── ui-mockup.html       # Interactive HTML mockup (visual reference)
└── quickstart.md        # Validation guide
```

### Source Code (marketplace item)

```text
data/user-apps/items/agentic-text-editor/
├── app.json              # App manifest (id, name, icon, size, singleton)
├── index.tsx            # Main app component (two-pane layout)
├── types.ts           # Shared types (Document, Tab, ChatMessage, EditorSettings)
├── state/
│   └── document-store.ts    # Client-side store for documents, tabs, chat messages
├── components/
│   ├── editor/
│   │   ├── toolbar.tsx          # Open/Save buttons, Edit/Preview toggle
│   │   ├── tab-bar.tsx          # Horizontal scrollable tab list
│   │   ├── edit-view.tsx        # Monospace textarea with line numbers
│   │   ├── preview-view.tsx     # Rendered markdown preview
│   │   └── status-bar.tsx       # File info, cursor position, change status
│   ├── chat/
│   │   ├── chat-header.tsx      # "Chat with Agent" title + status dot
│   │   ├── chat-messages.tsx    # Scrollable message list
│   │   ├── chat-input.tsx       # Text input + send button
│   │   └── message-bubble.tsx   # User/agent message bubble
│   └── resizer.tsx              # Draggable pane divider
├── services/
│   ├── file-service.ts        # VFS file open/save operations
│   └── format-service.ts      # Document format handler registry
├── tools/
│   └── assistant-tools.ts     # Tier 1 assistant tool declarations + handlers
└── config/
    └── editor-config.ts       # Config namespace registration for editor settings
```

**Structure Decision**: Marketplace app with clean component separation. The editor and chat are independent surfaces sharing a single state store. Format handlers are pluggable via a registry pattern. Assistant tools are registered as Tier 1 capabilities.

## Design Notes

### State Management
- **DocumentStore**: Zustand store holding documents array, active document ID, chat messages, and editor settings.
- **Internal buffer**: Each document has a `content` field in the store. Changes are live — no intermediate save.
- **Chat messages**: Global per-app instance. Each message optionally references a document ID.
- **Settings**: Persisted via config namespace. Loaded on app mount.

### Format Architecture
- **FormatHandler interface**: `{ id, name, extensions, render(content), edit(content) }`
- **Registry**: `formatService` maintains a map of handlers, keyed by ID.
- **Markdown handler**: Default handler for `.md` files. Uses a simple markdown renderer.
- **Plaintext handler**: Default handler for `.txt` files. No rendering needed.
- **Extending**: Add a new handler by registering it with `formatService.register()`. No core changes needed.

### Agent Context
The agent always receives:
- List of open documents (filename, path, isActive, isDirty)
- Active document ID
- Content preview of active document (first 2000 chars)
- Format of each document

### Tool Architecture
- All tools prefixed with `agentic_editor_`
- Default-to-active-document pattern: most editing tools accept optional `documentId`
- Tier 1 tools: registered in capabilities registry, permissioned per agent
- Runtime surface tools (optional): if the app window is open, additional tools available

### Edit/Preview Toggle
- **Edit mode**: `<textarea>` with monospace font, line numbers on left, raw markdown visible
- **Preview mode**: Rendered markdown with styled headings, code blocks, lists, bold/italic
- Toggle is a state switch — no re-render of the entire app, just the content area
- Settings (font family, size, colors) apply to both modes

### Resizable Panes
- Draggable divider between editor and chat panes
- CSS `cursor: col-resize` during drag
- Violet highlight on hover/active
- Clamped between 25% and 60% for left pane
- Minimum widths: 300px (editor), 400px (chat)

### File Persistence
- **Open**: User clicks Open → file picker → VFS read → content loaded into internal buffer
- **Save**: User clicks Save → VFS write → buffer content written to disk → `isDirty` reset to false
- **Agent save**: `agentic_editor_save_document` tool triggers same VFS write path
- **Unsaved changes**: Status bar shows amber indicator, tab shows amber dot

### Edge Case Handling
- **Close tab with unsaved changes**: Prompt "Save changes?" with Yes/No/Cancel
- **Agent edits closed document**: Agent should open the document first, then edit
- **Concurrent edits (user typing + agent editing)**: Both write to same internal buffer — last write wins (TBD: could implement merge in future)
- **Missing paragraph reference**: Agent gracefully reports what it found instead of failing

## Complexity Tracking

No complexity violations. This is a single marketplace app with standard BOS patterns.
