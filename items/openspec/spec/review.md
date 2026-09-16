# Review checklist: the OpenSpec pack

Run before calling this pack done. Each item is a way this pack can be wrong
that its own tests would not catch.

## The `specs` overload (design §3.3)

The likeliest silent failure. A resolver conflating the store-level **specs
tree** with a change's **delta specs** reports `specs: done` for a change
containing none.

- Delta specs declared **explicitly `scope: "unit"`** on both the artifact and
  its predicate. The default being right today is not a contract.
- **Test the negative**: a change with zero delta specs must NOT be `done`. And
  the positive: with a nested `specs/ui/spec.md` it must be. A positive-only
  test passes even when the glob cannot match at all.

## The driver skill carries the rules that fail silently (design §3.9a)

Four hashtags on scenarios, `## Purpose` on a new-capability delta only,
`RENAMED` as a fourth verb, `skip_specs: true` rather than an invented
requirement. Each produces a wrong result QUIETLY, so a validator cannot
substitute for the skill saying it.

## Terminology

"The specs tree" and "delta specs" used as distinct terms throughout the skill
and docs. Those two names are the only thing stopping an agent writing a delta
into current truth.

## The two surprises reach the USER docs

- There is no archiving inside BOS, so the specs tree never grows without the
  CLI (design §3.5).
- Delta specs are browsed in the tree, not the artifact pane (design §3.10).

Both read as bugs when discovered rather than read.

## Upstream pinning

The descriptor names a version AND the docs name the verified commit. "Targets
OpenSpec" without one is how prose drifts from the tool within a release.

## Layer dependencies

`spec.md`, "What this pack requires of the layer" — seven `045` behaviours this
pack is the first to exercise. A regression in any of them shows here first.
