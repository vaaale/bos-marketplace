# BrowserOS Marketplace

The official marketplace for [BrowserOS](https://github.com/browseros). A marketplace
is a plain **git repository** that BrowserOS registers by URL and serves two kinds
of items to users: **sandboxed apps** (run/install) and **adoptable specs** (fork
into the user's own spec store, then evolve in Build Studio).

## Structure

```
marketplace.json          Root manifest (validated on register/sync)
items/
  <item-id>/
    app/                  Optional: a PRE-BUILT static app (must contain index.html)
    spec/                 Optional: an adoptable spec folder (spec.md, plan.md, …)
```

Each item must expose an `app`, a `spec`, or both.

## `marketplace.json`

```jsonc
{
  "id": "bos-marketplace",          // [a-zA-Z0-9._-]+, unique
  "name": "BrowserOS Marketplace",
  "version": "0.1.0",
  "description": "…",
  "items": [
    {
      "id": "welcome",              // [a-zA-Z0-9._-]+, unique within the marketplace
      "name": "Welcome",
      "description": "…",
      "tags": ["sample"],
      "app":  { "entrypoint": "items/welcome/app",  "runtime": "iframe", "version": "0.1.0", "icon": "Store" },
      "spec": { "path": "items/welcome/spec", "version": "0.1.0" }
    }
  ]
}
```

- `app.entrypoint` / `spec.path` are **repo-relative** paths (no leading `/`, no `..`).
- `app.runtime` is always `"iframe"`; `icon` is a [lucide](https://lucide.dev) name.
- Apps ship **pre-built** (an `index.html` plus bundled assets), not source.

## Trust model

Marketplace apps are **untrusted**: BrowserOS runs them in an **opaque-origin
iframe sandbox**. They cannot reach BrowserOS directly — the only channel is the
injected SDK (`window.__bos`), and only capabilities the user grants at install
take effect. `localStorage`/`sessionStorage` are transparently backed by a
per-app store (the `storage` capability).

## Adding an item

1. `mkdir -p items/<id>/{app,spec}` (include only what you need).
2. Put a pre-built `index.html` (+ assets) in `app/`, and/or a spec folder in `spec/`.
3. Add the item to `marketplace.json`.
4. Commit + push. Users get it on the next **Sync**.
