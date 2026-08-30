# Examples

`build-skill-workflow.json` — the corrected "BOS Skill Builder" workflow
(PLAN → DRAFT → SAVE → TEST → EVALUATE → UPDATE → RE-TEST). The version
originally shipped with this item predated the current node model entirely
(flat `type`/`agentId` fields, no `outputType`/`agentSource`) and, once
schema-migrated naively, resolved to agents whose ambient tool grants could
include `dev_delegate` — a BOS-source-only tool that fails outside a real
chat run with an active feature branch. Every step here uses an `ephemeral`
agentSource with an explicit, minimal `tools` list (`skill_save`/`skill_patch`
only where actually needed, empty otherwise), so no step can ever reach
`dev_delegate` regardless of what any named BOS agent's own tool grant looks
like. Re-import with `workflow_create`'s `workflow` parameter, or `PATCH
/workflows/<id>` (`{"changes": {...}}`) against an existing one.
