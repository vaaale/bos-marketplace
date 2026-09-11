# Feature Specification: Agentic Text Editor

**Feature Branch**: `agentic-text-editor`

**App Type**: Marketplace (data/user-apps/items/agentic-text-editor/)

**Created**: 2026-05-21

**Status**: Installed — incremental v3 in progress: (1) register the Editor as a file handler for markdown + text (in addition to HTML); (2) fix markdown table rendering in preview; (3) support pandoc fenced-div custom styles. Builds on v1 (document tabs + agentic chat) and v2 (agent/conversation management + tool-call visibility).

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

#### User Story 6 - Choose which agent to talk to (Priority: P1)

The user picks which BrowserOS agent drives the chat from a dropdown in the chat header. The default is the agent the chat is currently bound to (the Main Assistant). Switching agents routes subsequent messages to the selected agent.

**Why this priority**: The value of the editor's chat is the agent doing the work. Locking it to a single agent removes a core flexibility users expect from BOS's multi-agent model.

**Independent Test**: Open the app → open the agent dropdown in the chat header → confirm it lists the BrowserOS agents with the active one marked → select a different agent → send a message → confirm it is handled by that agent.

**Acceptance Scenarios**:

1. **Given** the app is open, **When** the user opens the agent dropdown in the chat header, **Then** it lists the agents available in BrowserOS, with the currently active agent marked.
2. **Given** the active agent is the Main Assistant, **When** the user selects a different agent, **Then** the next message sent is processed by that agent.
3. **Given** the user has selected an agent, **When** the app is restarted, **Then** the last selected agent is restored.

---

### User Story 7 - Start a new conversation or switch to an existing one (Priority: P1)

The user can start a fresh conversation and select from previously-started conversations. Each conversation keeps its own transcript and is associated with the agent that ran it.

**Why this priority**: A single ever-growing thread (today's behavior) makes it impossible to start a clean task or return to an earlier one — fundamental to real use.

**Independent Test**: Open the app → send a couple of messages → click "New conversation" → confirm the transcript is empty → send a message → open the conversation dropdown → confirm both conversations are listed → select the first → confirm its transcript (and agent) is restored.

**Acceptance Scenarios**:

1. **Given** the user has an active conversation, **When** they click "New conversation", **Then** a fresh empty conversation becomes active and the previous one is retained.
2. **Given** multiple conversations exist, **When** the user opens the conversation dropdown, **Then** it lists them (most recent first), with the active one marked.
3. **Given** the user selects an existing conversation from the dropdown, **Then** its transcript — and the agent it runs on — is restored into the chat.
4. **Given** a conversation has messages, **When** the app is restarted, **Then** the conversation, including its transcript and agent, is restored and selectable.
5. **Given** multiple tabs are open, **When** the user switches the active conversation, **Then** every tab reflects the newly-active conversation's transcript (the chat is still global across tabs).

---

### User Story 8 - See every tool call the agent makes (Priority: P2)

The chat already renders the wired-in editor tool calls as chips under each agent reply. The user wants every other tool call the agent executes shown too, rendered in a distinct color so it is visually separable from the editor tools. The existing editor-tool rendering is unchanged.

**Why this priority**: Full transparency into what the agent did — especially when it calls non-editor tools (search, file, memory, etc.) — without changing the established editor-tool chips.

**Independent Test**: Ask the agent something that triggers a non-editor tool (e.g. "search the web for …") → confirm the agent reply's tool row now shows that tool in the alternate color, alongside any editor tools.

**Acceptance Scenarios**:

1. **Given** an agent reply invoked an editor tool, **When** the reply renders, **Then** the editor tool chip is shown in the existing style (unchanged).
2. **Given** an agent reply invoked a non-editor tool, **When** the reply renders, **Then** that tool is also shown in the same tool row, in a distinct color that clearly separates it from the editor tools.
3. **Given** an agent reply invoked both editor and non-editor tools, **When** the reply renders, **Then** both appear in the row — editor tools in the existing style, the others in the alternate color.

---

### User Story 9 - Open markdown and text files from the Files app (Priority: P1)

The Editor registers itself as a file-type handler for markdown (`.md` → `text/markdown`) and plain text (`.txt` → `text/plain`) in addition to the HTML handling it already supports, so a user double-clicking such a file in the Files app — or choosing "Open with Editor" — opens it directly in the Editor.

**Why this priority**: An editor that can't be reached by double-clicking the files it edits is one extra step for every document. HTML already routes to the Editor; markdown and text should too.

**Independent Test**: In the Files app, double-click a `.md` file → it opens in the Editor in preview mode with correctly rendered markdown (tables per US10, custom styles per US11); double-click a `.txt` file → it opens as plain text; right-click a `.md`/`.txt`/`.html` file → "Open with Editor" is present and works.

**Acceptance Scenarios**:

1. **Given** the Editor is installed, **When** the user double-clicks a `.md` file in the Files app, **Then** it opens in the Editor (the Editor is the selected handler for `text/markdown`).
2. **Given** the Editor is installed, **When** the user double-clicks a `.txt` file, **Then** it opens in the Editor (the Editor is the selected handler for `text/plain`).
3. **Given** a `.md`, `.txt`, or `.html` file is right-clicked in the Files app, **When** the user opens the context menu, **Then** "Open with Editor" is present, and choosing it opens the file in the Editor.
4. **Given** the Editor receives the open-file launch parameters (`{ path, action }`) for a markdown file with `action: "open"`, **When** it launches, **Then** the file opens in a tab and preview mode is shown (the same open-file launch contract it already uses for HTML).
5. **Given** the Editor is the registered handler for `text/markdown` and `text/plain`, **When** it registers, **Then** it declares `render` and `edit` capabilities for both types (per the 036 `AppManifest.fileHandlers` mechanism).

---

### User Story 10 - Markdown tables render correctly in preview (Priority: P1)

The markdown renderer in preview mode correctly renders GitHub-Flavored-Markdown tables. Today tables do not render correctly — this is the headline rendering defect. Enabling full GFM table rendering (the expected mechanism is the `remark-gfm` table support) fixes it.

**Why this priority**: Broken tables make the editor unusable for real documents (specs, docs, and reports all use tables) — the user's explicit complaint.

**Independent Test**: Open a `.md` file containing a basic table, an aligned table (`:---`/`:---:`/`---:`), a multi-line-cell table, a table with an escaped pipe (`\|`), and a table nested in a list → preview → verify each renders as a proper table with correct structure and alignment, and none falls back to literal pipe text.

**Acceptance Scenarios**:

1. **Given** a GFM table with a header row and body rows, **When** it renders in preview, **Then** it produces a `<table>` with a `<thead>` (header cells) and `<tbody>` (body cells) matching the source.
2. **Given** a table whose delimiter row specifies alignment (`:---` left, `:---:` center, `---:` right), **When** it renders, **Then** the corresponding cells are left-, center-, or right-aligned.
3. **Given** a table cell containing an escaped pipe (`\|`) or inline markdown (bold, inline code, a link), **When** it renders, **Then** the pipe is literal and the inline markdown is rendered.
4. **Given** a table nested inside a list item, or immediately adjacent to a paragraph, **When** it renders, **Then** it is rendered as a table, not as literal pipe text.
5. **Given** the same document in edit mode, **When** the user views it, **Then** the raw markdown source — including the pipe table — is shown unmodified.

---

### User Story 11 - Pandoc fenced-div custom styles render from a named style registry (Priority: P1)

The markdown renderer supports pandoc `fenced_div` syntax — `::: {custom-style="Name"} … :::` (and the equivalent class form `::: {.Name} … :::`) — rendering the enclosed block as a styled container. The appearance is defined by a **style registry** that maps a style name to a CSS definition: a built-in set of named styles ships with the Editor, and the user can add/edit named styles in Settings. Nested fenced divs are supported.

**Why this priority**: The user's explicit "custom styles" ask — it lets documents carry semantic, consistently-styled callouts/boxes (the `RuleBox` example: a thin-outline, light-blue background) without per-document CSS.

**Independent Test**: Open a `.md` file containing `::: {custom-style="Note"} This text … :::` → preview → the block renders as a styled callout box (per the built-in Note definition). Then define a new style `PinkBox` in Settings (name + CSS) → add `::: {custom-style="PinkBox"} … :::` → it renders with the user's CSS. Use a name that is neither built-in nor user-defined (e.g. a document's `RuleBox`) → the block still renders in a neutral container.

**Acceptance Scenarios**:

1. **Given** a fenced div `::: {custom-style="Note"} … :::` and "Note" in the built-in style registry, **When** it renders in preview, **Then** the block is wrapped in a container styled by the "Note" CSS definition (one of the shipped built-in callout styles).
2. **Given** a fenced div in the class form `::: {.RuleBox} … :::`, **When** it renders, **Then** it applies the same "RuleBox" style as the `custom-style="RuleBox"` form.
3. **Given** a fenced div whose style name is **not** in the registry (typo, or a document authored elsewhere), **When** it renders, **Then** the block still renders as a neutral generic styled container — the content is never dropped and no error is thrown.
4. **Given** nested fenced divs (an outer `::: {custom-style="A"} … :::` containing an inner `::: {custom-style="B"} … :::`), **When** they render, **Then** both the outer and inner containers render with their respective styles.
5. **Given** the user creates a named style (e.g. "Note2") with specific CSS in the Settings "Custom Styles" section, **When** a document uses `::: {custom-style="Note2"} … :::` and is rendered, **Then** the block renders per the user's CSS, and the definition persists across app restarts.
6. **Given** a fenced div in edit mode, **When** the user views the document, **Then** the raw `::: {custom-style="…"} … :::` text is shown unmodified — the syntax is plain markdown source, only preview renders it.

**Investigation note (how the syntax works)**: `::: {custom-style="RuleBox"} … :::` is **pandoc's `fenced_div` extension**, not a standard markdown feature. In pandoc's HTML output the `custom-style` attribute is preserved on a `<div>` and styled with CSS `[custom-style="RuleBox"] { … }` (in `.docx` output it maps to a named Word paragraph style — its original primary purpose). In a React `react-markdown` pipeline, the idiomatic, generic mechanism is the **`remark-directive`** plugin (parses the `{#id .class key="value"}` attribute list into a `containerDirective` AST node) + `remark-directive-rehype` (converts it to a plain element) + a `components` override that renders the `containerDirective` as `<div class="custom-style custom-style--<Name>" data-style="<Name>">`. The style registry then supplies the CSS per name. This is the architecturally-correct, generic mechanism — it supports the full fenced-div attribute set (not a hard-coded `RuleBox` string match) and is how pandoc-authored documents intend to be styled.

---

### Edge Cases (v3 — file handlers, tables, custom styles)

- **What happens when the Editor becomes the default (double-click) handler for `.md`/`.txt`, replacing the in-app generic text-editor fallback?** → The agentic Editor takes over double-click for those types (intended — it *is* the markdown/text editor). Other types (e.g. `.html`) are unaffected; the user can still change the selected handler per type via the existing "Open with" → always-use behavior (spec 036).
- **What happens when a fenced div references a style name not in the registry (typo, or a document authored in another tool)?** → It renders as a neutral generic container; no content loss, no crash (US11.3).
- **What happens when the `storage` capability is revoked (so user-defined styles can't persist)?** → Built-in styles still render; user style definitions are simply not persisted (consistent with ADR-5's graceful degradation for `storage`).
- **What happens when a fenced-div delimiter (`:::`) appears inside a fenced code block?** → Code-block content is literal and is **not** treated as a directive delimiter (the parser must not confuse a `:::` inside a ``` fence with a fenced-div boundary).

---

## Assistant Tools

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
- **FR-009**: The chat MUST be global across all tabs — a single active conversation is shared by every tab at a time. The app MUST support multiple conversations and let the user switch between them (FR-024).
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
- **FR-023**: The app MUST provide an agent selector (dropdown) in the chat header that lists the agents available in BrowserOS, and MUST route messages to the selected agent. The currently-active agent MUST be marked in the selector, and the selection MUST persist across app restarts.
- **FR-024**: The app MUST support multiple conversations: a control to start a new conversation, and a dropdown to select among existing conversations. Each conversation MUST retain its own transcript and be associated with the agent that ran it. The conversation list, the active conversation, and the selected agent MUST all persist across app restarts.
- **FR-025**: The chat MUST render every tool call invoked by the agent in the reply's tool row. Editor tools (`agentic_editor_*`) MUST keep their existing rendering; all other tool calls MUST be rendered in a visually distinct style (different color) so they are clearly separable from the editor tools.
- **FR-026**: The Editor MUST register itself as a file-type handler for `text/markdown` (`.md`) and `text/plain` (`.txt`) — in addition to `text/html` — via the 036 `AppManifest.fileHandlers` mechanism declared in its `app.json`, with both `render` and `edit` capabilities for each. The Editor MUST be the selected (double-click) handler for `text/markdown` and `text/plain`, and MUST appear as an "Open with Editor" option for `text/markdown`, `text/plain`, and `text/html`. When launched via the open-file launch contract (`{ path, action }`), it MUST open the file in a tab and, for `action: "open"`, display preview mode — the same contract it already uses for HTML.
- **FR-027**: The markdown renderer (preview mode) MUST correctly render GitHub-Flavored-Markdown tables: `<thead>`/`<tbody>` header and body rows, the `:---` / `:---:` / `---:` alignment delimiter row (left/center/right), multi-line cells, escaped pipes (`\|`) rendered literally, inline markdown within cells, and tables nested in lists or adjacent to paragraphs. Edit mode MUST show the raw table source unmodified. A `:::` or other directive sequence appearing inside a fenced code block MUST be treated as literal code, not as a fenced-div delimiter.
- **FR-028**: The markdown renderer (preview mode) MUST support pandoc `fenced_div` syntax (`::: {attrs} … :::`). A fenced div's `custom-style="Name"` attribute (and the equivalent `.Name` class) MUST map to a **named style** from a style registry, where a named style is a CSS definition. The registry MUST contain a built-in set of named styles and MUST allow the user to create/edit named styles. Fenced divs MUST support nesting. A fenced div referencing a name not in the registry MUST still render the enclosed content (as a neutral generic container) without dropping content or throwing.
- **FR-029**: The Settings panel MUST expose a "Custom Styles" section where the user can add, edit, and remove named styles, each defined as a name plus a CSS declaration block. User-defined styles MUST take effect in the preview immediately on save and MUST persist across app restarts (via the app's storage). Built-in named styles MUST remain present (the user may override their CSS but not remove the built-in names).

### Key Entities

- **Document**: Represents an open file or new untitled document. Attributes: id (unique), filename, path (if from disk), content (internal buffer), format (markdown, plaintext, or extensible), isDirty (has unsaved changes), lastSaved (timestamp), isActive (current tab).
- **Tab**: UI representation of a document in the left pane. Attributes: document reference, visibleName, index.
- **ChatMessage**: A message in the global chat. Attributes: id, role (user/agent), content, timestamp, relatedDocumentId (optional, for messages that reference a specific document).
- **DocumentFormatHandler**: Pluggable format handler for rendering and editing different document types. Attributes: id, name, extensions, renderer (for preview), editor (for edit mode).
- **EditorSettings**: User-configurable appearance settings. Attributes: fontFamily, fontSize, headingColors, codeBlockBackground, codeBlockForeground, linkColor, etc.
- **Conversation**: A distinct chat thread. Attributes: id, agentId (the agent it runs on), messages[], createdAt, lastActiveAt, isActive. The app stores a list of conversations; exactly one is active at a time. The chat surface displays the active conversation only.
- **NamedStyle (StyleDefinition)**: A named custom style from the style registry. Attributes: name (unique, e.g. "Note"), css (a CSS declaration block), builtin (true for shipped styles, false for user-defined). The registry is the map of name → NamedStyle; built-in entries ship with the item, user-defined entries persist in the app's storage.
- **fileHandlers (manifest)**: The Editor's `AppManifest.fileHandlers` declarations for `text/html`, `text/markdown`, and `text/plain` (each with `render` + `edit`), consumed by the 036 file-handler registry at boot.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can open a file from disk, edit it in text mode, toggle to preview mode, and save it back to disk with all changes persisted correctly.
- **SC-002**: Users can ask the agent to add, modify, or remove content and see the changes reflected in the document immediately (within 1 second of agent response).
- **SC-003**: Users can work with multiple documents (5+ simultaneously) and switch between tabs without performance degradation.
- **SC-004**: The agent can open, create, save, and edit files via assistant tool calls without the app window being the active UI surface.
- **SC-005**: Users can configure font family, size, and element colors in settings and see changes reflected immediately in both edit and preview modes.
- **SC-006**: All app state (tabs, content, chat history, settings) is preserved across app restarts with no data loss.
- **SC-007**: The document format architecture supports adding a new format handler (e.g., HTML) as a single pluggable module without modifying core app code.
- **SC-008**: The user can switch the active agent from the dropdown and have subsequent messages processed by that agent; the selection persists across restarts.
- **SC-009**: The user can start new conversations and switch between existing ones; each retains its transcript and agent, all restored after restart, with the chat remaining global across tabs.
- **SC-010**: Every tool call the agent makes is visible in the reply's tool row — editor tools in the existing style, all others in a distinct, separable style.
- **SC-011**: Double-clicking a `.md` or `.txt` file in the Files app opens it in the Editor with no manual "Open with" step; "Open with Editor" also appears for `.md`, `.txt`, and `.html`.
- **SC-012**: A markdown document containing GFM tables (aligned, multi-line, escaped pipes, nested in lists) renders as correct tables in preview — 0 such tables render as literal pipe text.
- **SC-013**: A document containing `::: {custom-style="Note"} … :::` renders the built-in Note style; a user-defined style created in Settings renders per its CSS and persists across restarts; a fenced div with an unknown style name still renders its content in a neutral container (never dropped, no crash).

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
- **v2 (agent & conversation management)**: The agent list is sourced from BrowserOS's registered agents; the default is the Main Assistant (the agent the embedded chat is currently bound to). Each conversation is bound to a single agent — the agent dropdown selects the agent for the active conversation, and "New conversation" starts a fresh thread on the currently selected agent. (Flag as A1; see Clarifications.)
- **v2 (tool-call visibility)**: Full per-reply tool-call visibility requires the embedded chat to expose the complete list of tool calls for each agent reply — not just the editor surface tools — to the app's rendering layer, so the app can color non-editor tools distinctly.

## Clarifications

- **Per-conversation agent binding (RESOLVED — A1):** Each conversation is bound to one agent. "New conversation" starts a fresh thread on the *currently selected* agent — the agent dropdown controls the active conversation's agent.
- **Conversation persistence scope (RESOLVED — A2):** App-scoped — the conversation list shows only conversations this app started. (They are still real BOS assistant conversations under the hood, but the dropdown does not enumerate conversations started elsewhere.)
- **Non-editor tool color (RESOLVED — A3):** Neutral gray with the same chip shape; only the accent color differs from the violet editor chips.
- **Agent list scope (RESOLVED — A4):** Registered assistant agents only (Main Assistant + any user-defined agents). Window-scoped surface agents are not listed.
- **v3 — default handler for `.md`/`.txt` (RESOLVED — Q1):** The Editor is the selected (double-click) handler for `text/markdown` and `text/plain` — double-clicking such a file opens the Editor directly. It also remains an "Open with" option for `text/markdown`, `text/plain`, and `text/html` (spec 036).
- **v3 — style registry scope (RESOLVED — Q2):** (a) a built-in starter set (Note, Info, Warning, Tip) + user-extensible via Settings. Consistent with the existing appearance Settings (FR-018/FR-019).
- **v3 — built-in style names (RESOLVED — Q3):** The shipped built-in set seeds `Note`, `Info`, `Warning`, `Tip`. `RuleBox` is deliberately NOT a built-in — it was the user's illustrative example of the syntax, not a requested style. Names are overridable in CSS but not removable (FR-029).
- **v3 — markdown rendering mechanism (ASSUMPTION for design):** The table + fenced-div fixes are expected to come from enabling the full GFM/directive pipeline in the Editor's markdown renderer (`remark-gfm` for tables; `remark-directive` + `remark-directive-rehype` for fenced divs). The spec pins the *behavior* (FR-027/FR-028); the design step confirms the exact plugins against the Editor's current rendering stack (the v1 `format-service`). If the current renderer is not `react-markdown`-based, the equivalent is a small pre-transform that parses `::: {custom-style="X"} … :::` into a styled block — same behavior, different plumbing.
