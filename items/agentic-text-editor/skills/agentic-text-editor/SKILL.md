---
name: Drive the Agentic Text Editor
description: How to use the Agentic Text Editor's tools — editing documents in the open buffer, saving deliberately, and defining the named styles its markdown preview renders.
when_to_use: When a message arrives with an "## Agentic Text Editor context" block, or the user asks you to write, edit, restyle or save a document in the Editor.
created_by: seed
---

You are talking to the user from inside the **Agentic Text Editor**: a window split
between a document editor (left) and this chat (right). Both panes write to the
**same buffer**, so an edit you make is on screen before your sentence about it is.

Every message the user sends carries a context block naming the open tabs, which one
is **ACTIVE**, and the first 2000 characters of it. Read it before you reach for a
tool — most of the time it already answers "which document?" and "what is in it?".

## The three rules

**1. Your edits go to the buffer, not to disk.** `add_content`, `modify_content`,
`remove_content` change what the user sees and mark the tab unsaved (•). Nothing
reaches the VFS until `agentic_editor_save_document` or `agentic_editor_save_all`.
**Do not save unless asked** — the unsaved state is how the user reviews your work.

**2. "This document" means the ACTIVE tab.** Every document tool takes an optional
`documentId`; omit it and you get the active one, which is what the user means.
Pass one only when they named a different open file. A `documentId` that looks like
a path (`/Documents/notes.md`) is opened for you rather than refused.

**3. Edit what is actually there.** `modify_content` and `remove_content` match
EXACT text. The context preview is the first 2000 characters only — for anything
below that, call `agentic_editor_get_document_content` (full current buffer,
including unsaved edits) or `agentic_editor_search_document` first. Guessing at the
wording is what turns one edit into four failed tool calls.

## Documents

| Tool | What it does |
|---|---|
| `agentic_editor_open_file` | Open a VFS path in a new tab, e.g. `/Documents/notes.md` |
| `agentic_editor_create_document` | New empty tab; it has no path until saved |
| `agentic_editor_save_document` | Write one buffer to disk (`path` required the first time) |
| `agentic_editor_save_all` | Write every tab that has unsaved changes |
| `agentic_editor_add_content` | Append to the end of the buffer |
| `agentic_editor_modify_content` | Replace exact text (`all: "true"` for every occurrence) |
| `agentic_editor_remove_content` | Delete exact text |
| `agentic_editor_set_active_document` | Switch tabs |
| `agentic_editor_list_documents` | Every open tab: id, path, format, unsaved state |
| `agentic_editor_get_active_document` | The active tab + a 2000-character preview |
| `agentic_editor_get_document_content` | One buffer in full |
| `agentic_editor_search_document` | Case-insensitive search with line numbers |

**Writing somewhere other than the end.** There is no insert-at-line tool, and that
is deliberate: anchor on text instead. To add a section after a heading, call
`modify_content` with `find` = the heading line and `replace` = the heading plus the
new section. To restructure heavily, read the buffer, then replace a whole block in
one call rather than a dozen small ones.

**A new document.** `create_document` → `add_content` → `save_document` WITH a
`path` (it has none yet). Saving a never-saved document without one fails, and
`save_all` reports it as skipped rather than inventing a filename.

## The preview, and what renders in it

The editor renders markdown itself: headings, lists, quotes, links, inline code,
fenced code blocks, and **GFM tables** (`| a | b |` with an alignment row —
`:---`, `:---:`, `---:`). Escape a literal pipe inside a cell as `\|`.

**Mermaid diagrams render.** A fenced block tagged `mermaid` is drawn in Preview —
flowcharts, sequence, state, class, gantt, pie, anything Mermaid parses:

````
```mermaid
graph TD
  Idea --> Draft --> Review --> Published
```
````

So when a document wants a diagram, write one; do not describe the picture in
prose or paste an ASCII drawing. Two things to know: a block whose syntax
Mermaid rejects shows the error and the source instead of a diagram (the user
sees exactly what you wrote), and only the `mermaid` tag is drawn — a block
tagged `js` or untagged stays a code block.

It also renders **pandoc fenced divs**, which is how a document gets a coloured
callout box:

```
::: {custom-style="Note"}
Text inside the box. Markdown still works here.
:::
```

`::: {.Note}` is an accepted short form. The name resolves through the style
registry below. A name that is not in the registry still renders — as a neutral
grey box — so a broken reference never loses content, it just looks wrong.

## Styles

The registry is **app settings, not document content**: there is no buffer, no
unsaved state, and no save step. A change applies to every document in every tab
the moment the tool returns.

| Tool | What it does |
|---|---|
| `agentic_editor_list_styles` | Every style with the CSS it currently resolves to |
| `agentic_editor_add_style` | Create a new named style (`name`, `css`) |
| `agentic_editor_update_style` | Replace a style's `css`, rename it (`newName`), or both |
| `agentic_editor_remove_style` | Delete a user style |
| `agentic_editor_reset_style` | Put a built-in back to its shipped CSS |

**Built-in vs user styles.** `Note`, `Info`, `Warning` and `Tip` ship with the app.
Their **names are fixed** — they cannot be renamed or removed — but their CSS can be
overridden with `update_style` and put back with `reset_style`. Everything else is a
user style you can create, re-style, rename and delete freely.

**`css` is a declaration block — no selector, no braces:**

```
background: rgba(56,189,248,0.10); border-left: 3px solid #38bdf8;
border-radius: 8px; padding: 12px 16px; color: #bae6fd;
```

**`css` REPLACES, it does not merge.** "Make the Note boxes red" is therefore two
calls, not one: `list_styles` to read Note's current CSS, then `update_style` with
that whole block and the colours changed. Sending only `background: red;` throws
away its padding, border and radius.

The working loop for a request like "give me a style for terminal output":

1. `agentic_editor_list_styles` — see what exists; the user may be describing
   something that is already there under another name.
2. `agentic_editor_add_style` with a name the document will use.
3. Tell the user the exact syntax to type: `::: {custom-style="Terminal"}`.
4. If they want to see it, add a short example block to the document with
   `add_content` and let the preview do the rest.

**Names.** A name is referenced as `custom-style="Name"`, so quotes, braces and
newlines are refused — anything else is fine, including spaces. Names are
case-sensitive and must be unique across built-in and user styles.

**Renaming orphans documents.** `update_style` with `newName` does not rewrite the
documents that used the old name — they fall back to the neutral box. If the user
asks for a rename, offer to `modify_content` the affected documents too.

## Mistakes that cost the most

**Saving uninvited.** The user asked for a draft, not a commit. Edit the buffer and
stop; they will say "save it" when they mean it.

**Re-typing a document to change one line.** You have `modify_content` — use the
smallest `find` that is unambiguous. Replacing the whole buffer to fix a typo burns
the document's length in tokens and discards any edit the user made while you wrote.

**Treating a refusal as a dead end.** Every refusal from these tools names the tool
that does apply — `add_style` on an existing name points at `update_style`,
`remove_style` on a built-in points at `reset_style`. Follow the pointer instead of
retrying the same call.

**Describing a style instead of making one.** If the user wants a callout, create it
and show them the three lines to type. Pasting raw CSS into the chat is not an
answer the editor can render.
