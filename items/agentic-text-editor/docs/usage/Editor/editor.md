# Editor

Editor is a two-pane text editor for the files in your BrowserOS home: the left
pane is the editor, the right pane is a chat with a BrowserOS agent, and both
write to the **same document**. When the agent rewrites a paragraph you see it
appear under your cursor — there is no second copy to merge, and nothing is
written to disk until you save.

It knows three kinds of file:

| Kind | Extensions | Preview shows |
| --- | --- | --- |
| Markdown | `.md`, `.markdown`, `.mdx`, `.mdown` | the formatted document |
| HTML | `.html`, `.htm` | the **rendered page** |
| Plain text | `.txt`, `.log`, `.env`, anything else | the text as-is |

The kind is picked from the filename, so it follows a Save As: rename
`notes.txt` to `notes.md` and the preview starts formatting it. It is worked out
fresh every time Editor starts, too — a tab restored from a previous session is
opened with the kinds this version of Editor knows about, not the ones it knew
when you last closed it.

## The basics

- **Open** — the toolbar's *Open* button browses your files. Each document gets
  its own tab; the dot on a tab means unsaved changes.
- **Edit / Preview** — the toggle in the middle of the toolbar. Edit is a
  monospace editor with line numbers; Preview renders the document.
- **Save** — the *Save* button or `Ctrl`/`Cmd` + `S`. A brand-new document asks
  where to put it first.
- **Closing a tab** with unsaved changes always asks before discarding — including
  changes the agent made rather than you.
- **Settings** (the gear) sets the font, the size, and the colours used for
  headings, links and code blocks in both panes.

Documents survive a restart: your open tabs, the split position and your
appearance settings are all remembered, unsaved buffers included.

## Opening an HTML file from Files: "Open with Editor"

Editor registers itself as a handler for HTML files, so it shows up in the Files
app next to the built-in previewer:

1. Open **Files** and find an `.html` or `.htm` file.
2. **Right-click** it. Under *Open with* you will see both
   **Open with Web View** (the built-in read-only previewer) and
   **Open with Editor**.
3. Pick **Open with Editor**. The file opens in a new Editor tab, in
   **Preview** mode — flip to *Edit* whenever you want the source.

Two things worth knowing about that menu:

- The **checkmark** marks the app that HTML files open with when you just
  **double-click** them. Choosing *Open with Editor* moves the checkmark to
  Editor, so from then on double-clicking an HTML file opens it here. Choose
  *Open with Web View* again to hand it back.
- If the file is **already open in a tab**, Editor focuses that tab instead of
  opening the same file twice — so you never end up with two tabs quietly
  disagreeing about the same file.

Editor asks BrowserOS for the file's contents itself, which means the usual
rules apply: it can only read files you can read, and it writes nothing until
you save.

## How the HTML preview works

For an HTML file, *Preview* is not a formatted approximation — it is the page,
rendered:

- **It shows your unsaved buffer, not the file on disk.** Type in *Edit*, switch
  to *Preview*, and you are looking at what you just typed. Ask the agent to
  restyle the page and the preview follows on its next redraw. Nothing needs to
  be saved first.
- **Scripts in the page run.** A preview that silently skipped the page's own
  JavaScript would be misleading about what the file actually does.
- **The page is sandboxed.** It renders in an isolated frame with no access to
  Editor, to BrowserOS, or to your files — so previewing a page you did not
  write cannot read your documents or act as you.

Because the page brings its own styling, the Editor appearance settings do not
apply to an HTML preview; they still apply to the Markdown preview and to the
editor itself.

A few practical notes:

- Relative links and `<img src="picture.png">` will not resolve — the preview is
  rendered from the buffer, not from the file's folder, so it has no notion of
  "next to this file". Absolute `https://…` URLs work normally.
- A fragment is fine: you do not need `<html>` and `<body>` for the preview to
  render something sensible.
- Links that navigate will do so **inside** the preview frame. Switch modes, or
  reopen the file, to get back.

*Edit* mode is the raw source — the same monospace editor with line numbers you
get for any other file. Editor never reformats or "tidies" your HTML; what you
save is what you typed.

## Working with the agent

The chat on the right talks to a BrowserOS agent that can read and change the
document you have open — "tighten the intro", "add a summary table", "convert
this list into a `<table>`". Its edits land in the buffer, so they are
previewable immediately and yours to save or discard. Tool calls the agent made
are shown as chips under its reply, and an edit that came from the agent is
flashed in the status bar so it is never mistaken for something you typed.

Conversations are picked in the chat header, along with which agent you are
talking to; the transcript belongs to the conversation, not to a tab, so
switching tabs never changes what you are reading.
