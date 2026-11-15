# Kinship for DeepSeek Harness

Turns a DeepSeek Harness profile into Kinship's AI runtime. The bundle patches
the profile with three cooperating pieces:

- **`presets/kinship.patch.yml`** — the `kinship` agent preset. It mounts the
  Kinship persona from `$KINSHIP_AI_ROOT/agents/main.md` (prefix only, the file is
  the persona), the shell and filesystem tools the Kinship workflows expect, the
  Loom tool aliases, and the daily-plan tool.
- **`kinship-bridge`** (Host) — a loopback HTTP API over exactly one root Session
  running that preset: message delivery, inbox classes, event stream, subagent
  catalog, model and context reads, and manual compaction. The Kinship backend
  speaks to it with a bearer token.
- **`kinship-ui`** (browser) — the **Kinship** page in the Web sidebar, which
  shows live bridge state and edits the bridge configuration through the same
  authenticated channel the GUI uses.

`kinship-plan` and `kinship-task-compat` carry the planning store and the Loom
compatibility tools the preset exposes to the model.

## Use

1. Enable the bundle in a profile and set `KINSHIP_AI_ROOT` to the Kinship `ai`
   directory, so the preset can load its persona.
2. Start `dsh` with the Web GUI, open **Kinship** in the sidebar, reveal or rotate
   the bearer token, and copy the shown `config.yaml` keys into the Kinship
   backend (`ai_backend: dsh`, `dsh.url`, `dsh.token`).
3. Create a Session with the `kinship` preset inside the workspace the backend
   should use; the bridge binds the earliest such Session, or the one you bind
   from the page.

## Limits

- The bridge is loopback-only and serves one Session at a time.
- The preset needs `KINSHIP_AI_ROOT`; without it the persona cannot load.
- The sidebar page needs the `kinship-bridge` row; without it the page reports
  that the bridge did not answer.
