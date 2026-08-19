# Feature Specification: Agentic Text Editor

**Feature Branch**: `agentic-text-editor`

**App Type**: Marketplace (data/user-apps/items/agentic-text-editor/)

**Created**: 2026-05-21

**Status**: Draft

**Input**: User description: "An app to edit text and markdown documents with an embedded AI chat. Left pane is a tabbed document list, right pane is the chat. The agent can write/edit/update document contents. Agent edits the internal buffer — content is not persisted until the user explicitly saves."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Open and edit a document manually (Priority: P1)

The user opens the app, opens a file via the file picker, edits its content directly, switches between edit and preview modes, and saves it.

**Why this priority**: This is the core editing workflow. Without this, the app is just a chat window with no editing capability.

**Independent Test**: Open the app → click Open → select a markdown file → edit content in text mode → toggle to preview → verify rendered output → click Save → verify file is persisted to disk.

**Acceptance Scenarios**:

1. **Given** the app is open with no tabs, **When** the user clicks the "Open" button and selects a markdown or plain text file, **Then** a new tab opens with the file content rendered in preview mode and the filename displayed in the tab.
2. **Given** a document is open in the left pane, **When** the user clicks the Edit/Preview toggle, **Then** the content switches between editable text mode and rendered markdown/preview mode.
3. **Given** the user has made changes to a document in text or preview mode, **When** the user clicks Save, **Then** the changes are persisted to the file on disk.
4. **Given** the user has unsaved changes, **When** the user opens a new file, **Then** a "Save changes?" dialog appears with Yes/No/Cancel options.

---

### User Story 2 - Agent edits a document via chat (Priority: P1)

The user opens a document, then uses the chat to ask the agent to add, modify, or remove content. The agent updates the document's internal buffer immediately.

**Why this priority**: This is the defining feature — the "agentic" part. Without it, the app is just a text editor.

**Independent Test**: Open a markdown file → ask the agent "add a paragraph about X" → verify the content appears in the document immediately → toggle to preview → verify rendered output.

**Acceptance Scenarios**:

1. **Given** a document is open and active, **When** the user asks the agent "add a paragraph about Y", **Then** the agent appends the requested content to the document's internal buffer and the change appears immediately in the left pane.
2. **Given** a document has content, **When** the user says "elaborate on paragraph two", **Then** the agent identifies the active document's second paragraph and adds elaboration content.
3. **Given** a document has content, **When** the user says "delete the first paragraph", **Then** the agent removes the first paragraph from the document's internal buffer.
4. **Given** the agent has made edits, **When** the user does not explicitly save, **Then** the changes remain in the internal buffer and are NOT persisted to disk.
5. **Given** the agent has made edits, **When** the user says "save" or clicks the Save button, **Then** the document is persisted to disk with all changes.

---

### User Story 3 - Agent opens/saves/creates files (Priority: P1)

The user can use the agent to open files, save files, create new documents, and search within documents — all without using the UI directly.

**Why this priority**: Enables the assistant to control the app as a Tier 1 tool — the agent can work on documents even when the user isn't actively interacting.

**Independent Test**: Ask the agent "open file /docs/notes.md" → verify a new tab opens → ask "create a new document called draft" → verify a new untitled tab appears → ask "save all" → verify files are persisted.

**Acceptance Scenarios**:

1. **Given** the agent receives a tool call to open a file, **When** the file exists, **Then** a new tab opens with the file content.
2. **Given** the agent receives a tool call to create a new document, **When** a name is provided, **Then** a new untitled tab is created.
3. **Given** the agent receives a tool call to save a document, **When** the document has unsaved changes, **Then** the changes are persisted to disk.
4. **Given** the agent receives a search request, **When** the search has a query and a document, **Then** the agent returns matching content snippets from the document.

---

### User Story 4 - Multiple documents and tab management (Priority: P2)

The user can open multiple documents (1-5 typical), switch between them, and the chat always operates on the active document.

**Why this priority**: Real users will work with multiple documents simultaneously. Tab management is fundamental to the workflow.

**Independent Test**: Open 3 files → switch tabs → verify content changes → ask agent about content in a specific tab → verify agent targets the correct document.

**Acceptance Scenarios**:

1. **Given** multiple tabs are open, **When** the user clicks a tab, **Then** that tab becomes active and its content is displayed in the left pane.
2. **Given** multiple tabs are open, **When** the user closes a tab, **Then** the tab is removed and another tab becomes active.
3. **Given** the agent knows which tabs are open, **When** the user says "add to file B" or the agent needs to target a specific document, **Then** the agent addresses the request to the correct tab.
4. **Given** a tab is active, **When** the user sends a message to the chat, **Then** the agent interprets it as relating to the active document by default.

---

### User Story 5 - User-configurable appearance settings (Priority: P2)

The user can configure fonts, font sizes, and colors for markdown elements through the app's settings.

**Why this priority**: Makes the editor personalized and usable for different preferences and document types.

**Independent Test**: Open settings → change font to monospace, size to 14 → verify the document editor reflects the change → change heading color → verify rendered preview reflects the new color.

**Acceptance Scenarios**:

1. **Given** the user opens the settings panel, **When** the user selects a font family, **Then** the document editor and preview reflect the new font.
2. **Given** the user opens the settings panel, **When** the user sets a font size, **Then** all text in the editor and preview scales accordingly.
3. **Given** the user opens the settings panel, **When** the user configures colors for specific markdown elements (headings, code blocks, links, etc.), **Then** the rendered preview and edit mode reflect those colors.
4. **Given** settings have been configured, **When** the app restarts, **Then** the previous settings are restored.

---

### Assistant Tools

The app exposes the following assistant tools (Tier 1 — installed-app tools). All tool names are prefixed with `agentic_editor_`.

#### File Operations

| Tool ID | Description | Parameters |
|---------|-------------|------------|
| `agentic_editor_open_file` | Opens a file by path in a new tab. If the file is already open, brings that tab to the front. | `path` (string): Absolute path in the BrowserOS VFS (e.g. `/Documents/notes.md`). Paths are relative to the user's VFS root, which acts as the user's home directory. |
| `agentic_editor_create_document` | Creates a new untitled document (or named if filename provided). | `filename` (string, optional): Suggested filename; defaults to "Untitled" |
| `agentic_editor_save_document` | Saves the specified document to disk. If no documentId is given, saves the active document. | `documentId` (string, optional): Target document; defaults to active |
| `agentic_editor_save_all` | Saves all open documents that have unsaved changes. | None |

#### Document Editing

| Tool ID | Description | Parameters |
|---------|-------------|------------|
| `agentic_editor_add_content` | Appends content to a document. The content is inserted at the end of the document's internal buffer. | `documentId` (string, optional): Target document; defaults to active; `content` (string): Content to append |
| `agentic_editor_modify_content` | Replaces existing content in a document. The agent specifies the text to find and the replacement text. | `documentId` (string, optional): Target document; defaults to active; `find` (string): Text to find; `replace` (string): Replacement text |
| `agentic_editor_remove_content` | Removes content from a document. The agent specifies the text to find and remove. | `documentId` (string, optional): Target document; defaults to active; `find` (string): Text to find and remove |
| `agentic_editor_set_active_document` | Switches the active tab to the specified document. | `documentId` (string): Target document |

#### Document Query

| Tool ID | Description | Parameters |
|---------|-------------|------------|
| `agentic_editor_list_documents` | Lists all currently open documents with their filenames, paths, and dirty state. | None |
| `agentic_editor_get_active_document` | Returns the currently active document's id, filename, and first N characters of content (for context). | None |
| `agentic_editor_get_document_content` | Returns the full content of a specific document. | `documentId` (string): Target document |
| `agentic_editor_search_document` | Searches within a document for a query string. Returns matching line numbers and surrounding context. | `documentId` (string): Target document; `query` (string): Search text |

#### Context Awareness

The agent always receives the following context automatically (not a tool call, but available in the system prompt):

- **Open tabs**: List of all open documents (filename, path, id, isActive, isDirty)
- **Active document**: Which tab is currently selected
- **Document format**: The format handler for each open document (markdown, plaintext, etc.)

## UI Design

### Layout Structure

The app uses a **two-pane layout**:

- **Left Pane (45% width, resizable)**: Document editor with tabs
- **Right Pane (55% width, resizable)**: Chat interface with agent

The divider between panes is draggable (25%-60% left pane range) with a violet highlight on hover.

### Left Pane: Document Editor

**Toolbar** (top, shrink-0):
- "Open" button (folder icon) — opens file picker
- "Save" button (floppy disk icon) — persists internal buffer to disk
- Edit/Preview toggle — pill-shaped toggle switching between edit and preview modes

**Tab Bar** (below toolbar, shrink-0):
- Horizontal scrollable tabs for open documents
- Active tab: white text, violet bottom border
- Inactive tabs: muted text
- Close button (X) on each tab (appears on hover)
- Unsaved indicator: amber dot on tabs with unsaved changes

**Document Content Area** (flex-1, scrollable):

**Edit Mode**:
- Monospace font (`SF Mono`, `Fira Code`, or `Consolas`)
- Line numbers on left (gray, right-aligned)
- Raw markdown text with visible syntax
- Purple accent on inline code highlights
- Placeholder text in light gray

**Preview Mode**:
- Rendered markdown with proper typography
- Styled headings (purple bottom border on h1, purple left border on h2)
- Code blocks with dark background and bordered boxes
- Formatted lists with disc markers
- Bold text in white, italic in gray
- Links styled in violet with underline

**Status Bar** (bottom, shrink-0, violet background):
- Left: Current filename, change status indicator ("No changes" / "Unsaved changes" with amber dot)
- Right: Cursor position (Ln X, Col Y), encoding (UTF-8), format (Markdown)

### Right Pane: Chat Interface

**Chat Header** (top, shrink-0):
- "Chat with Agent" title
- Green status dot (agent online indicator)

**Chat Messages Area** (flex-1, scrollable):
- User messages: right-aligned, violet background with border
- Agent messages: left-aligned, light background with border
- Timestamps below each message (small, muted text)
- Empty state: centered chat icon, "No messages yet" title, helpful placeholder text

**Chat Input** (bottom, shrink-0):
- Text input field with rounded border
- Placeholder: "Type your message..."
- Send button (arrow icon) with violet background
- Focus state: violet border highlight

### Design System

**Colors** (BOS opacity palette):
- Primary text: `#e0e0e0`
- Secondary text: `#a0a0b0`
- Muted text: `rgba(255,255,255,0.3)`
- Borders: `rgba(255,255,255,0.08)`
- Backgrounds: `#1a1c24`, `#15171e`, `#1e2028`
- Accent: `#8b5cf6` (violet) for agent surfaces, toggle states, active indicators
- Success: `#22c55e` (green) for status dots
- Warning: `#f59e0b` (amber) for unsaved indicators

**Typography**:
- Default: 11-13px (dense UI)
- Code: 12-13px monospace
- Headings (preview): 19-26px
- Status bar: 10.5px

**Spacing**: Tight (gap-1 to gap-2 equivalent, 4-12px)

**Interactions**:
- Hover states: background lightens, borders highlight
- Active states: violet accent background
- Focus states: violet border with glow
- Transitions: 0.15-0.2s for smooth interactions
- Drag resize: cursor changes to `col-resize`, violet highlight on divider

### Responsive Behavior

- Minimum left pane width: 300px
- Minimum right pane width: 400px
- Both panes scroll independently when content overflows
- Status bar and toolbar remain fixed at edges

### Visual Reference

An interactive HTML mockup is available at `user-specs/agentic-text-editor/ui-mockup.html`. This file is a self-contained, styled HTML page that demonstrates the exact layout, colors, typography, and interactions. The Developer should use it as the visual source of truth when building the app. Key things to match:

- Two-pane resizable layout (45% / 55%)
- Edit vs Preview mode toggle and visual difference
- Tab bar with active/inactive states and close buttons
- Status bar with file info, cursor position, and change indicators
- Chat pane with message bubbles, input field, and send button
- Violet accent (#8b5cf6) for agent surfaces, toggle states, active indicators
- BOS opacity palette for backgrounds, borders, and muted text

Open the file in a browser to inspect exact styles, spacing, and hover/focus states.

### Edge Cases

- What happens when the user closes a tab that has unsaved changes? → Prompt to save or discard.
- What happens when the agent is editing and the user starts typing manually at the same time? → Both edits go to the same internal buffer; last write wins (or merge, TBD).
- What happens when a file is modified externally while the app has it open? → Detect and prompt user (overwritten externally — keep local changes? overwrite? merge?).
- What happens when the agent tries to edit a file that has been closed? → Agent should only edit open (tabbed) documents; if the file isn't open, the agent should open it first.
- What happens when the user asks the agent to edit content that doesn't exist in the document? → Agent gracefully handles the request (e.g., "I can't find paragraph 2 because the document only has 1 paragraph" — or appends if the user means "add to end").

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The app MUST display a two-pane layout: a left pane for document tabs and a right pane for the chat interface.
- **FR-002**: The left pane MUST support an unlimited number of document tabs, with the ability to open, close, and switch between them.
- **FR-003**: Each tab MUST display the content of its associated document.
- **FR-004**: The app MUST support an Edit/Preview toggle that switches the left pane between editable text mode and rendered markdown/preview mode.
- **FR-005**: The app MUST support opening files via a file picker dialog.
- **FR-006**: The app MUST support saving files to disk, persisting the internal buffer state.
- **FR-007**: The app MUST support creating new untitled documents.
- **FR-008**: The right pane MUST contain a chat interface where the user can communicate with an AI agent.
- **FR-009**: The chat MUST be global across all tabs — one conversation per app instance.
- **FR-010**: The agent MUST receive context about all open document tabs, including their filenames, content, and which tab is currently active.
- **FR-011**: Agent edits MUST modify the internal document buffer in real-time (live update) without requiring user confirmation.
- **FR-012**: The internal buffer MUST NOT be persisted to disk until the user explicitly saves (via Save button or explicit agent save command).
- **FR-013**: The agent MUST be able to add, modify, and remove content in any open document.
- **FR-014**: The agent MUST be able to open, create, and save files.
- **FR-015**: The agent MUST be able to search within open documents.
- **FR-016**: The app MUST expose assistant tools (Tier 1) for file operations, document editing, and search.
- **FR-017**: The app MUST support an extensible document format architecture that allows adding new format handlers (e.g., HTML, YAML) without restructuring the core app.
- **FR-018**: The app MUST provide a settings panel where users can configure font family, font size, and colors for markdown elements.
- **FR-019**: Settings MUST persist across app restarts.
- **FR-020**: Tabs and their content MUST survive app restarts (reloaded from disk on startup).
- **FR-021**: Chat history MUST persist across app restarts.
- **FR-022**: The app MUST prompt the user when closing a tab with unsaved changes.

### Key Entities

- **Document**: Represents an open file or new untitled document. Attributes: id (unique), filename, path (if from disk), content (internal buffer), format (markdown, plaintext, or extensible), isDirty (has unsaved changes), lastSaved (timestamp), isActive (current tab).
- **Tab**: UI representation of a document in the left pane. Attributes: document reference, visibleName, index.
- **ChatMessage**: A message in the global chat. Attributes: id, role (user/agent), content, timestamp, relatedDocumentId (optional, for messages that reference a specific document).
- **DocumentFormatHandler**: Pluggable format handler for rendering and editing different document types. Attributes: id, name, extensions, renderer (for preview), editor (for edit mode).
- **EditorSettings**: User-configurable appearance settings. Attributes: fontFamily, fontSize, headingColors, codeBlockBackground, codeBlockForeground, linkColor, etc.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can open a file from disk, edit it in text mode, toggle to preview mode, and save it back to disk with all changes persisted correctly.
- **SC-002**: Users can ask the agent to add, modify, or remove content and see the changes reflected in the document immediately (within 1 second of agent response).
- **SC-003**: Users can work with multiple documents (5+ simultaneously) and switch between tabs without performance degradation.
- **SC-004**: The agent can open, create, save, and edit files via assistant tool calls without the app window being the active UI surface.
- **SC-005**: Users can configure font family, size, and element colors in settings and see changes reflected immediately in both edit and preview modes.
- **SC-006**: All app state (tabs, content, chat history, settings) is preserved across app restarts with no data loss.
- **SC-007**: The document format architecture supports adding a new format handler (e.g., HTML) as a single pluggable module without modifying core app code.

## Assumptions

- The assistant/agent infrastructure already exists in BrowserOS and can be integrated with a custom app.
- File persistence uses the BrowserOS VFS (virtual file system) — not native OS file paths.
- The chat interface follows existing BrowserOS chat conventions (message bubbles, scroll-to-bottom).
- The file picker uses BrowserOS's existing file selection mechanism.
- The internal buffer is a client-side state in the app component — not persisted to disk until explicitly saved.
- The Edit/Preview toggle is a simple switch: in edit mode, content is shown as raw editable text; in preview mode, content is rendered as HTML.
- Auto-save is NOT in scope — only explicit save (user click or explicit agent command).
- External file modification detection (file changed on disk) is not in scope for v1 — handled as a stretch goal.
- Undo/redo functionality is not explicitly specified but may be expected by users — to be addressed in design.
