# Kinship for DeepSeek Harness

Turns a DeepSeek Harness profile into Kinship's AI runtime. The bundle patches
the profile with five cooperating pieces:

- **`presets/kinship.patch.yml`** — the `kinship` agent preset. It mounts the
  Kinship persona from `$KINSHIP_AI_ROOT/agents/main.md` (prefix only, the file is
  the persona), the shell and filesystem tools the Kinship workflows expect, the
  Loom tool aliases, and the daily-plan tool.
- **`kinship-bridge`** (Host) — a loopback HTTP API over exactly one root Session
  running that preset: message delivery, inbox classes, event stream, subagent
  catalog, model and context reads, and manual compaction. The Kinship backend
  speaks to it with a bearer token.
- **`kinship-plan-scheduler`** (Host) — restores Loom's plan wake scheduling: it
  reads the same `plan/master.json` and `plan-{date}.overlay.json` files, queues
  one wake per due entry in a per-Session persistent queue, and delivers each
  wake text into the bound Session through the bridge's `deliver` service. Its
  design and its differences from Loom are documented in
  [`packages/kinship-plan-scheduler/docs/DETAIL.md`](../packages/kinship-plan-scheduler/docs/DETAIL.md).
- **`kinship-ui`** (browser) — the **Kinship** page in the Web sidebar, split
  into Overview / Isolation / Plan / Access / Settings tabs: live bridge state,
  isolation results, the plan schedule, the token and connect snippet, and the
  bridge configuration form.
- **`kinship-isolation`** (preset) — subtracts host contributions inside the
  `kinship` preset: an empty same-name section shadows `memory:index`
  (`dsh-auto-memory`'s index) and `tools.restrict()` hides the `memory_*` tools for
  that preset's Agents and subagents. It syncs on `tools/change` so it does not
  depend on profile row order, and reports each rule and its result to the panel
  through `kinshipBridge.reportIsolation`.

`kinship-plan`, `kinship-compact`, `kinship-tools` and `kinship-task-compat` carry
the planning store, the model-callable compaction tool, the notification /
reminder-board / TTS tools and the Loom compatibility tools the preset exposes to
the model.

## Use

1. Enable the bundle in a profile and set `KINSHIP_AI_ROOT` to the Kinship `ai`
   directory, so the preset can load its persona.
2. Start `dsh` with the Web GUI, open **Kinship** in the sidebar, reveal or rotate
   the bearer token, and copy the shown `config.yaml` keys into the Kinship
   backend (`ai_backend: dsh`, `dsh.url`, `dsh.token`).
3. Create a Session with the `kinship` preset inside the workspace the backend
   should use; the bridge binds the earliest such Session, or the one you bind
   from the page. After a `dsh` restart the bridge rehydrates the bound Session
   by itself (same resume path as the Web UI), so there is no need to open that
   Session manually first.

## Plan scheduling

The scheduler row is additive: it never writes a day plan. It writes only the
master file (through the plan card's edits), its own scheduler state under
`{stateDir}`, and a `source: "scheduler"` fact line into the day's
`plan-ledger.jsonl`.

- It reconciles at boot, at the configured daily anchors (default `05:00` and
  `07:30`), on a 60 s watchdog, and on demand from the plan card. One reconcile
  covers `now - 24 h` (debt) to `now + 48 h` (horizon): slots from the last 8 h
  keep their own time, older non-coverage slots are re-issued at `now + 60 s`,
  and older coverage checkpoints coalesce into one catch-up entry per date.
- Due wakes queue in `{stateDir}/session/wake-queue/{sessionId}.json` (schema 2,
  atomic rewrite, `O_EXCL` instance lock in the same directory). A failed
  delivery is retried once 30 s later and then archived as `failed`; `plan`
  entries are retained 48 h and the delivered archive keeps 500 records.
- The plan root needs no dsh-side configuration: the Kinship backend pushes
  `{ai_root, data_dir, plan_root, plan_master}` over
  `POST /v1/kinship/paths`, the bridge persists it as
  `$DSH_HOME/kinship/paths.json` and emits `kinship/paths`, and the scheduler
  prefers that root (row config / env remain fallbacks). Replays after a
  restart keep the layout without asking the owner to repeat paths.
- The wake text injected through `kinshipBridge.deliver` is a plain user message:
  `【计划唤醒·<action>】HH:MM · <title>`, the entry instruction, `条目：<entry
  id>`, Loom's trailing `完成后执行 plan done（date=…, id=…）` (the coalesced
  catch-up entry lists every slot id; `plan.build` / `plan.review` keep "only
  write the day's plan"), and the fixed line `不发用户通知，除非条目要求。`.
- Completion facts have a destination again: `kinship-plan`'s `plan_note` /
  `plan_done` fall back to the day overlay (`plan-{date}.overlay.json`, created
  over `plan/master.json` with the master anchor ids as coverage checkpoints)
  when the v1 truth file is missing, closed or lacks the id, and
  `plan_overlay_read` lists the reachable ids and the overlay version. The wake
  hint can therefore name `plan done` for a master id again. The fallback needs a
  master with at least one anchor entry, and v1 conflicts stay conflicts.
- Edits ride the owner-only `/api/kinship/ui/plan*` routes and are versioned: a
  stale `expectedVersion` is refused with `master_conflict` instead of
  overwriting another writer.

## Notifications, reminders and TTS

These three features used to be one MCP server (`ai-template/mcp/ai_mcp.py`) that
read the backend address and a service token off the filesystem. On dsh they are
native preset tools (`kinship-tools`: `ai-mcp_send_notification`,
`ai-mcp_send_reminder`, `ai-mcp_list_reminders`, `tts_speak`) that call the
sibling `kinshipBridge` service instead of an extra process.

The backend owns its own listen address and token, so it pushes both once to
`POST /v1/kinship/tool-auth` (bearer = the bridge token). The bridge validates the
document (schema 1, `http(s)` on `127.0.0.1`/`localhost` only), keeps
`{baseUrl, token, at}` in memory - nothing is written to `$DSH_HOME` - and emits
`kinship/tool-auth` without the token. `GET` on the same path answers
`{ok, schema, configured, base_url, at}` and never the token.

The client skips certificate verification for `https` (the main instance serves a
self-signed certificate on loopback), uses plain `http` otherwise, times out after
30 s, and folds every failure (non-2xx, non-JSON, connection error) into
`ok:false` with a short message whose token occurrences are redacted. With no
push yet the tools answer a readable text instead of throwing, so a session whose
backend is down still works.

## Isolation from host plugins

`kinship-isolation` keeps host-level plugins out of the Kinship Sessions without
editing the host configuration. dsh merges scoped prompt sections by name, so an
empty section registered in the preset scope with the host section's name shadows
it for every Agent under that preset. `ctx.tools.restrict({ deny })` on the preset
scope does the same for inherited host tools: the schema, description and executor
disappear together, and the restriction reaches the preset's subagents through the
scope chain.

The default targets are `memory:index` and tools starting with `memory_` - the
`dsh-auto-memory` plugin, whose index and write guidance otherwise ride into every
Kinship request. `tools.restrict()` rejects names that are not registered yet, and
a preset may activate before the host plugin, so the plugin re-syncs on
`tools/change` and denies names as they appear. Results are reported through the
bridge service and rendered in the panel's **Isolation** tab; a rule that never
matched a host contribution stays visible as pending instead of silently doing
nothing. Sibling presets, the host Sessions and the memory panel keep the plugin.

## Compaction

The preset's `compaction` group isolates the `compaction` and `toolResultPruner`
services and mounts `compaction-basic` (automatic), `command-compact` (the human
`/compact`), `tool-result-pruner`, and `compact-context` - the row of
`kinship-compact`, which registers the model-callable `compact_context` tool.

dsh's `compactNow` only runs on an idle Session, so the tool records the request
and answers `Compaction scheduled: it runs when this turn ends.`; a
plugin-owned poll compacts once after the turn. An idle call compacts
immediately (`Compaction finished (~N history items).`), and a Session with
nothing to compact answers `No compactable history yet.`. Config:
`pollIntervalMs` 500 ms, `maxWaitMs` 600000 ms, `maxAttempts` 600. Design and
limits: [`packages/kinship-compact/docs/DETAIL.md`](../packages/kinship-compact/docs/DETAIL.md).

## Limits

- The bridge is loopback-only and serves one Session at a time.
- The preset needs `KINSHIP_AI_ROOT`; without it the persona cannot load.
- The sidebar page needs the `kinship-bridge` row; without it the page reports
  that the bridge did not answer.
- The plan card needs the `kinship-plan-scheduler` row; without it the card says
  the scheduler is not installed and the rest of the page keeps working. The
  card shows where the plan root came from (backend push / row config / env /
  default); until the backend pushes once, the root falls back to the
  environment.
- Plan wakes need the `kinship-bridge` row and a bound Session: without them the
  scheduler reconciles but defers, and queues nothing.
- The wake queue belongs to the bound Session id, so a manual rebind starts an
  empty queue; pending entries in the previous Session's file are not migrated.
- A crash between claiming a wake and delivering it loses that one wake.
- The overlay write-back needs a master with at least one anchor entry; without
  one the plan tools refuse instead of inventing files. Once a day has an
  overlay, the scheduler reads that date as the merged master+overlay view and
  no longer merges the day's v1 legacy items. There is no coverage verifier yet.
- `compact_context` compacts after the turn, not in the middle of it. A
  scheduled request can still be dropped by `maxWaitMs` / `maxAttempts` after
  the tool has already answered "scheduled", and a Session with nothing to
  compact answers `No compactable history yet.`
