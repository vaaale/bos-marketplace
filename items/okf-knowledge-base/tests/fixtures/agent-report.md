Bundle is clean: 13 chapters, 43 concept terms, 0 drift, 0 broken assets, 0 orphans. The document is fully decomposed and indexed.

I've finished ingesting the **Qwen3.8-Flash-Next** technical report into the `medium` bundle. Here's the honest accounting.

**Chapters written (13)** — `tech-report` stub plus:
- `abstract`, `introduction`, `conclusion`, `evaluation`, `authors`, `references`
- `gdn-hybrid` (§2.1.1), `qwen-sparse-attention` (§2.1.2)
- `gated-residual` (§2.2)
- `ngram-embedding` (§2.3, merged with its two subsections 2.3.1 placement + 2.3.2 vocabulary — they read as one study)
- `muon-optimizer` (§3.1), `hyperparameter-scaling` (§3.2), `stability-stress-test` (§3.3)

**Concept terms (43 distinct, all coined)** — the bundle was empty, so nothing existed to extend. Notable: `qwen3.8-flash-next`, `gated-delta-net`, `qwen-sparse-attention`, `gated-residual`, `n-gram-embedding`, `muon-optimizer`, `gatednorm`, `canzona`, `polar-express`, `fp8-quantization`, plus the standard vocabulary (`sparse-attention`, `scaling-law`, `training-stability`, …). No near-duplicates were possible (empty index) and none were forced.

**Salient persons** — author **Qwen Team** on the stub; **Zihan Qiu** (GatedNorm, the key stability mechanism) on `gated-residual`; corresponding authors **Dayiheng Liu** and **Bo Zheng** on `authors`.

**Inline assets (0)** — Figures 1–13 and Tables 1–11 are PDF-embedded and were extracted as text tables (no `![…](url)` image/video lines in the markdown), so there were no non-HTML assets with a URL to download and interpret. Their content survives in the chapter bodies verbatim.

**References (0 followed, 0 skipped, 0 failed)** — this is a self-contained single-document report; its References section is a bibliography of prior-work citations (GDN, Muon, Polar Express, Canzona, Hyper-Connections, DSA, the eval benchmarks), not content references that extend the document. Following the full bibliography would exceed the 1-hop / 2-worker budget without adding understanding of *this* report, so none were queued.

**Cross-links (3)** — QSA→GDN-hybrid (replaces its full-attention layers), stability-test→gated-residual (isolates its GatedNorm gate), muon-optimizer→hyperparameter-scaling (its stability shift drives the refit).

One caveat worth flagging: the PDF's equations and figure captions extracted with some math-glyph artifacts (e.g. `⊙`/subscripts scattered), a limitation of PDF→markdown, not of the decomposition. The section boundaries are exact.

```
Ingested: 13 chapters, 43 concepts, 0 assets, 0 refs skipped, 0 refs failed.
```