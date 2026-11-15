# Kinship for DeepSeek Harness

Turns a DeepSeek Harness profile into Kinship's AI runtime. The bundle patches
the profile with four cooperating pieces:

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
- **`kinship-ui`** (browser) — the **Kinship** page in the Web sidebar, which
  shows live bridge state, edits the bridge configuration through the same
  authenticated channel the GUI uses, and carries the **Plan schedule** card.

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
  id>`, a trailing hint that names **no** write-back tool (neither `plan done`
  nor `plan note` can reach a master id), and the fixed line
  `不发用户通知，除非条目要求。`.
- Edits ride the owner-only `/api/kinship/ui/plan*` routes and are versioned: a
  stale `expectedVersion` is refused with `master_conflict` instead of
  overwriting another writer.

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
