# Kinship plan scheduler

Restores Loom's plan wake scheduling inside the Harness. A Host-level row that
keeps one schedule truth across runtimes: it reads the same
`plan/master.json` and `plan-{date}.overlay.json` files Loom writes, turns them
into timed wakes, and delivers each wake as a plain user message into the bound
Kinship Session. The Kinship panel's **Plan schedule** card edits the same
master file through the owner-only channel.

The engine is a port of Loom's scheduler, not a reimplementation:
`plan-scheduler.ts`, `wake/queue.ts`, `master-plan.ts`, `plan-overlay.ts`,
`plan-store.ts`, `plan-ledger.ts`, `timezone.ts`, `wake-render.ts`,
`atomic-write.ts` and `file-lock.ts` all carry a `Ported from ... kinship@c945667`
note. `plan/legacy.ts` is the dsh-specific adaptation; see
[Deliberate differences from Loom](#deliberate-differences-from-loom).

## What it is

- A Host plugin (`name: kinship-plan-scheduler`, `inject: ['agents']`) that is
  always mounted. The operator configures **no paths**: the Kinship backend
  pushes them through the sibling bridge (see
  [Paths pushed by the Kinship backend](#paths-pushed-by-the-kinship-backend)),
  and the plugin re-resolves when a push moves the plan root. When nothing
  resolves it stays mounted but starts no engine, so the panel can explain what
  is missing instead of the routes disappearing.
- A scheduling layer only. It never writes completion state back into a day
  plan: it reads the master and the day's overlay, queues wakes, and appends
  facts to a ledger.
- A single-Session scheduler. It schedules for the one Session the sibling
  `kinship-bridge` row has bound, and delivers through that row's `deliver`
  service.
- Additive: with `mode: "off"` it does nothing at all; uninstalling the row
  leaves the plan files untouched (only the panel edits write `master.json`).

| Piece | Row | Role |
| --- | --- | --- |
| `kinship-plan-scheduler` | this package | master/overlay read, reconcile, wake queue, delivery, plan panel routes |
| `kinship-bridge` | sibling row | binds the Session, exposes `kinshipBridge.deliver(text)` |
| `kinship-ui` | sibling row | renders the **Plan schedule** card and calls the plan routes |
| `kinship-plan` | preset tool row | writes the v1 `plan-{date}.json` the legacy adapter reads |

Engine modules (`src/`): `config.ts` roots and schema, `defaults.ts` the seed
schedule, `delivery.ts` the bridge adapter, `queue-registry.ts` the
session-scoped queue owner, `routes.ts` the four panel routes, `snapshot.ts` the
panel projection, `index.ts` wiring, `plan/` the ported engine, `wake/queue.ts`
the persistent queue.

## Schedule model

`{planRoot}/plan/master.json` (schema 1, `kind: "master-plan"`) is the truth: a
timezone plus an ordered list of entries. Each entry carries `id`, `kind`,
`title`, `enabled`, `schedule`, `created_at`, `updated_at`, and optionally
`intent`, `action`, `payload`, `instruction`, `target_date`, `window`,
`done_when`, `last_done`, `status`, `next_check`, `legacy_long_task_id`.

Entry kinds:

- `fixed` - a fixed wall-clock slot (the seeded daily review, the 05:00 build and
  the 07:30 review).
- `anchor` - a coverage checkpoint; `window` (`HH:MM~HH:MM`) and
  `target_date` (`today` | `previous_day`) give the wake its span. `anchor` is a
  classification only: the timing still comes from `schedule`.
- `long_term` - a long-running item. It must state `status`
  (`active` | `paused` | `archived`), and an `active` one must also state
  `next_check` (a `YYYY-MM-DD`); both are enforced by the schema.

Schedule kinds (`schedule.kind`):

- `daily` - `{ at: "HH:MM" }`.
- `weekly` - `{ days: [...], at }`; days are weekday names (`mon` ... `sun`) or
  numbers, at least one, no duplicates.
- `monthly` - `{ days: [1..31], at }`.
- `once` - `{ date: "YYYY-MM-DD", at }`.

`action`, when present, must be a known wake action (`plan.build`,
`plan.review`, `coverage.run`, `review.daily`, `review.weekly`,
`review.biweekly`, `audit.night`, `weather.morning`, `session.compact`,
`probe.run`, `fleet.run`, `longterm.due`, `flow.check`, `special.continue`,
`inbox.digest`). An entry without `action` is rendered with the source default
(`master` -> `plan.build`).

`materializeMasterEntries(document, date)` decides which entries exist on a
given day, in this order:

1. `enabled` must be true.
2. For `long_term` only: `status` must be `active`, and `next_check` must be
   present and not later than the date.
3. The schedule must match the date: `daily` always, `weekly` by weekday,
   `monthly` by day of month, `once` by exact date.

The scheduler then uses `schedule.at` as the wake clock. The day's overlay
(`plan-{date}.overlay.json`) is a diff on top of that list: `add` / `update` /
`remove` / `note` operations applied by id. A day with an overlay is scheduled
from the merged view; a day without one is scheduled straight from the master.

## Reconcile

One reconcile projects the master plus the day's overlay onto the date window
and hands the result to the wake queue, replacing that queue's `plan` source.

Triggers:

- `boot` - once while the plugin mounts, followed by `start()`.
- Daily anchors - `anchors` (default `05:00` and `07:30`), one timer each,
  re-armed for the next day after firing. Reasons are `anchor-0500`,
  `anchor-0730` for the two defaults and `anchor:HH:MM` for any other clock. If
  the master names a different timezone than the plugin config, the anchors are
  re-armed against the master zone on the first successful read.
- Watchdog - every `watchdogMs` (default 60 s, `0` disables), reason
  `watchdog`.
- Panel - the reconcile route, reason `manual`.
- Post-boot retry - when the boot reconcile deferred for lack of a bound
  Session, an `agent/created` event schedules one retry 1 s later, so the first
  Session the bridge binds does not wait for the next anchor.

Reconciles are serialized on one promise chain. Ids are derived from the date,
the action and the entry id (plus a stable catch-up anchor), so a repeated
reconcile produces the same ids and the queue dedupes by id, `at` and payload.

Window and budget (all from `now`): dates from `dateKey(now - debtAfterHours)`
to `dateKey(now + horizonHours)`, at most 20 dates. For each candidate slot:

- No `at` -> `skipped_no_time` (the v1 legacy items land here).
- `slotAt > now + horizonHours` (48 h) -> `skipped_horizon`.
- `slotAt < now - debtAfterHours` (24 h) -> `skipped_debt`, and one ledger row
  with `reason: "older_than_debt"`.
- Id already planned on that date -> `skipped_duplicate`.
- A slot on a past date is dropped unless its action is `coverage.run`; past
  non-coverage items belong to yesterday's leftovers, not to a new wake.
- A slot in the last `catchupMaxAgeHours` (8 h) keeps its own timestamp, so a
  slot that just passed is delivered on the next queue tick.
- A slot older than the catchup window but inside the debt window is re-issued
  at `now + 60 s` with `payload.late: true`; coverage checkpoints instead
  coalesce per date into one entry (below).

Catchup coalescing: late `coverage.run` slots of one date become a single entry
`plan:{date}:catchup:{HHMM}`, where `{HHMM}` is the last late checkpoint's
original clock. Its `at` is that checkpoint's original time, its
`payload.slots` lists every missed checkpoint, and its instruction is the
generated `补做 {date} 的迟到覆盖：` block. The id is stable across reconciles,
so a repeated pass does not queue the same catch-up twice.

Single build/review per date: `plan.build` and `plan.review` entries are keyed
`plan:{date}:build` and `plan:{date}:review`, so however many anchors fire, a
date carries one build wake and one review wake.

Yesterday's leftovers: the effective plan of `today - 1` contributes its
non-suppressed entries still in `planned` / `blocked` / `carried`, excluding
`plan.build` and `plan.review` (those are scheduler actions, not work). The list
rides today's `plan.build` entry as `payload.leftovers`.

Queue writes: `queue.reconcileSource("plan", entries)` only. Entries not in the
new set are cancelled; the other sources and the delivered archive are left
alone. The result's `added` / `updated` / `cancelled` counts are what the
reconcile route returns.

Shadow mode (`mode: "shadow"`) computes the same entries and writes them to
`{stateDir}/plan/shadow/{date}.jsonl` (one JSON object per line, atomic write)
instead of touching the queue; the result status is `shadow`. Observation only:
it also needs a bound Session, because the session check runs before the shadow
branch.

Ledger: each reconcile fact (deferred, master error/fallback, overlay error,
skipped debt, queue error) is appended to
`{planRoot}/daily/{date}/plan-ledger.jsonl` through the ported `PlanLedger`
with `source: "scheduler"`. The engine's own fallback ledger
`{stateDir}/plan/scheduler.jsonl` is unused in this wiring, because the plugin
always injects the ledger sink.

## Delivery

One event per due entry. `QueueRegistry` owns exactly one `WakeQueue`, derived
from the bridge's current binding on every use: while the bound session id is
stable the queue is reused, and a changed id disposes the old queue and restores
a fresh one.

Queue file: `{stateDir}/session/wake-queue/{sessionId}.json`, schema 2:

```json
{ "schema": 2, "session_id": "session-...", "entries": [], "delivered": [],
  "legacy_migrated_at": 1790000000000 }
```

- Every mutation rewrites the whole file through the ported atomic writer
  (same-directory temp + `fsync` + `rename` + directory `fsync`), key-sorted
  JSON, so a reader only ever sees a complete old or complete new document.
- Cross-process exclusion: `{stateDir}/session/wake-queue/.instance.json`
  created with `O_EXCL` and holding `{pid, started_at}`. A lock whose pid is
  alive refuses restore (`wake-queue:locked`); a dead pid is taken over. The
  registry deletes the lock on rebind or dispose, but only when this process
  owns it, so a second Harness instance keeps its exclusion.
- One `setTimeout` per queue, always pointing at the earliest pending entry;
  very distant wakes are re-armed in blocks. On fire: claim (remove from the
  file and persist), render, deliver.
- Retry once: a failed delivery is re-queued at `now + 30 s` with the attempt
  count incremented. A second failure archives the entry with
  `outcome: "failed"` and reports a dead letter. There is no exponential
  backoff.
- Staleness: an entry whose session no longer matches the binding is archived
  as `stale` (reason `session`); an entry the renderer refuses is archived as
  `stale` (reason `render`).
- Retention, applied at restore: `plan` and `inbox` entries live 48 h from
  `at`, `flow` and `special` 30 days. The delivered archive keeps the last 500
  records.
- The pre-2.0 single wake file `{stateDir}/session/wake/{sessionId}.json` is
  migrated once as `legacy-auto-wake` and then renamed to
  `{sessionId}.json.legacy-{now}`.

Delivery itself goes through `kinshipBridge.deliver(text)`: the bridge trims the
text (empty -> 422 `invalid_message`), resolves the bound Session through its
own `ensureBoundSession` (so a Session that a restart left live-less is resumed
first), and sends it as a user message with source
`{kind: "bridge", source: "plan-scheduler"}` on `next-turn`. The returned
`sessionId` and `messageId` are checked; anything else is a delivery failure and
takes the retry path. If the `kinship-bridge` row is missing, `deliver` throws
`kinship bridge is unavailable` and the queue records it like any other failure.

Wake line contract (built by `plan/wake-render.ts`, verbatim):

```
【计划唤醒·<action>】HH:MM · <title>
<instruction>
条目：<entry id>
<done hint>
不发用户通知，除非条目要求。
```

- The clock is the entry's `at` rendered in the master timezone.
- The instruction is the entry's `instruction`, else (coverage entries without
  one) the generated `按 data-check 流程执行 ... （窗口 ...，目标日 ...）` line;
  the line is omitted when there is nothing to say.
- `条目：<id>` uses `payload.entry_id` (the master id), not the queue id.
- The done hint is the dsh variant, see difference (b) below.
- The last line is the fixed boundary: a wake does not notify the user.

## Files and directories

`{planRoot}` is the absolute plan root; `{stateDir}` is the absolute scheduler
state root (`$DSH_HOME/kinship/state` by default).

| Path | Written by | Meaning |
| --- | --- | --- |
| `{planRoot}/plan/master.json` | panel edits only | master schedule truth |
| `{planRoot}/plan/master.md` | master store | derived human view |
| `{planRoot}/plan/master.last-good.json` | master store | last successful write, read on corruption |
| `{planRoot}/plan/.master.lock` | master store | write lock (stale 10 s, wait 2 s) |
| `{planRoot}/daily/{date}/plan-{date}.overlay.json` | Loom | day diff over the master, read-only here |
| `{planRoot}/daily/{date}/计划-{date}.md` | overlay store | derived human view of the overlay |
| `{planRoot}/daily/{date}/.plan.lock` | overlay store | overlay write lock |
| `{planRoot}/daily/{date}/plan-{date}.json` | `kinship-plan` (v1) | legacy day plan, read-only here |
| `{planRoot}/daily/{date}/plan-ledger.jsonl` | ledger | append-only, `source: "scheduler"` rows from this plugin |
| `{stateDir}/session/wake-queue/{sessionId}.json` | wake queue | pending and delivered entries (schema 2) |
| `{stateDir}/session/wake-queue/.instance.json` | wake queue | cross-process instance lock |
| `{stateDir}/session/wake/{sessionId}.json` | old single-wake file | migrated once, then renamed |
| `{stateDir}/plan/shadow/{date}.jsonl` | shadow reconcile | what would have been queued |
| `{stateDir}/plan/scheduler.jsonl` | engine fallback ledger | not written by the dsh wiring |
| `$DSH_HOME/kinship/paths.json` | `kinship-bridge` | last paths pushed by the Kinship backend; the plan root comes from here |

## Paths pushed by the Kinship backend

The Kinship backend owns the deployment layout (`data.ai_root`,
`data.dir`). Instead of asking the operator to repeat those paths in dsh
environment variables, the backend pushes them over the bridge's authenticated
loopback channel:

```
Kinship backend ──POST /v1/kinship/paths──▶ kinship-bridge
                                             ├─ $DSH_HOME/kinship/paths.json (0600, atomic)
                                             └─ emits `kinship/paths`
                                                        │
                              kinship-plan-scheduler ◀───┘ re-resolves the plan root
```

The scheduler reads that file at boot (so a restart keeps the last accepted
layout even when the backend is down) and re-reads it on every `kinship/paths`
event. `plan_root` from the push is the first plan-root candidate:
**pushed → row config → `KINSHIP_PLAN_ROOT` → `KINSHIP_AI_ROOT/data`**. A push
that resolves to a different root stops and restarts the engine in place
(anchors and timezone are derived again from the new master); a push that
resolves to the same root only refreshes the provenance shown in the panel. A
rejected or `null` payload never tears down a running engine.

The plugin never writes `paths.json`; it only validates what it reads. When the
document is missing (backend never pushed), the panel shows the plan root's
provenance as `env` / `default` and explains that it is waiting for the Kinship
backend.

## Configuration

Plugin row config (all fields optional; the bundle patch fills them from the
environment variables below):

| Field | Default | Env fallback | Meaning |
| --- | --- | --- | --- |
| `planRoot` | `""` | `KINSHIP_PLAN_ROOT`, else `KINSHIP_AI_ROOT/data` | absolute plan root override; the root the backend pushed wins, this is the fallback |
| `stateDir` | `""` | `KINSHIP_PLAN_STATE_DIR` | absolute state root; empty uses `$DSH_HOME/kinship/state` |
| `mode` | `live` | `KINSHIP_PLAN_MODE` | `live` / `shadow` / `off` |
| `timezone` | `Asia/Shanghai` | `KINSHIP_PLAN_TIMEZONE` | zone used only until the master supplies its own (the master wins) |
| `anchors` | `[]` (derive) | `KINSHIP_PLAN_ANCHORS` (comma separated) | daily reconcile clocks, strict `HH:MM`, at most 8, no duplicates; empty derives `plan.build`/`plan.review` slots from the master, falling back to `05:00,07:30` |
| `watchdogMs` | `60000` | `KINSHIP_PLAN_WATCHDOG_MS` | watchdog interval; `0` disables |
| `horizonHours` | `48` | `KINSHIP_PLAN_HORIZON_HOURS` | how far ahead slots are materialized (max 168) |
| `catchupMaxAgeHours` | `8` | `KINSHIP_PLAN_CATCHUP_MAX_AGE_HOURS` | late slots younger than this keep their own time |
| `debtAfterHours` | `24` | `KINSHIP_PLAN_DEBT_AFTER_HOURS` | older slots are skipped as debt (max 168); must exceed `catchupMaxAgeHours` |



`planRoot` normally needs no value at all: the Kinship backend pushes the
layout and the plugin prefers it. `KINSHIP_PLAN_ROOT` is still read twice on
purpose as a fallback: the bundle patch passes it as the row config, and
`config.ts` uses it again when the config value is empty. A relative candidate
is refused and the next candidate is tried (a stale override must not mask a
pushed root); the panel-facing `problem` is only set when nothing resolves.
`$DSH_HOME` unset or blank means `~/.dsh`.

`timezone` and `anchors` follow the plan master once it is readable: the
master's `timezone` becomes the scheduler zone, and when `anchors` is empty the
`plan.build` / `plan.review` entries' `schedule.at` clocks become the reconcile
anchors (`05:00` / `07:30` if the master has none). The snapshot reports both
sources (`timezone` effective, `anchorsSource: config|master|default`) so the
panel can show where the schedule comes from.

Mode semantics:

- `live` - reconcile and deliver. The queue is mounted and writes to
  `{stateDir}`.
- `shadow` - reconcile and write the shadow file; never touch the queue.
- `off` - no engine, no timers, no files. The row still loads and the panel
  still answers `GET /api/kinship/ui/plan` (mode `off`, empty master/queue), so
  an operator can see why nothing is scheduled.

Invalid timing knobs (a non-integer `horizonHours`, `debtAfterHours <=
catchupMaxAgeHours`, an unparsable anchor, an unknown timezone) are rejected
when the engine is constructed. The plugin then keeps `status.degraded` and
`status.lastError` for the panel, and the write routes answer 409.

The panel does not edit this row: change the environment variable or the profile
patch and restart `dsh`.

## Panel API

Four routes on the dsh Connection's authenticated Fetch channel, i.e. the same
owner-only registry the bridge panel uses. They do not accept the bridge bearer
token, are refused for every principal but the owner, and are registered per
plugin effect, so a reload removes and re-registers them.

| Method | Path | Request | Success |
| --- | --- | --- | --- |
| `GET` | `/api/kinship/ui/plan` | - | `{ok, scheduler, master, queue, next}` |
| `POST` | `/api/kinship/ui/plan/ops` | `{expectedVersion, ops: [...]}` | the GET shape after re-reconcile |
| `POST` | `/api/kinship/ui/plan/reconcile` | `{reason: "manual"}` (optional) | `{ok, queued: {added, updated, cancelled}, snapshot}` |
| `POST` | `/api/kinship/ui/plan/seed` | `{}` | the GET shape |

Snapshot (`GET`, and the answer of every write):

- `scheduler`: `{mode, planRoot, stateDir, timezone, anchors, planRootSource,
  pathsPushedAt, pathsSource, pathsProblem, anchorsSource, degraded, lastError,
  problem, masterPresent}`. `problem` is a root-resolution failure,
  `degraded`/`lastError` a runtime one, `masterPresent` says whether a master
  file exists even when it cannot be read. Provenance: `planRootSource` is
  `pushed|config|env|default` (null while nothing resolves), `pathsPushedAt` /
  `pathsSource` describe the accepted backend push, `pathsProblem` a refused
  one, `anchorsSource` is `config|master|default`, and `timezone` is the
  effective zone (master first).
- `master`: `null` or `{version, timezone, updatedAt, entries}`; each entry is
  `{id, kind, title, action, enabled, status, schedule, next_at, next_local}`
  with `next_at` computed by the ported timezone helpers.
- `queue`: `{sessionId, pending: [{id, at, action, attempts, title}],
  delivered: [{id, delivered_at, outcome}]}`; `delivered` is the last 10 records,
  and both lists are empty when no queue is mounted.
- `next`: the earliest `next_at` among enabled entries, or `null`.

Write rules:

- `ops` are the master store's edit operations: `upsert_entry`, `replace_entry`,
  `remove_entry`, `set_enabled`, `set_status`, `update_entry` (with a patch).
- `expectedVersion` is required and must be a positive integer; it is the
  `version` the caller last read. A mismatch is `409 master_conflict` and the
  file is untouched. After a successful edit the plugin reconciles and answers
  the fresh snapshot.
- `seed` writes the generic default master (daily review, session compaction,
  weather, `plan.build` at 05:00, `plan.review` at 07:30, one weekly review, and
  seven 4 h coverage checkpoints) only when no master exists;
  otherwise `409 master_exists`. Seeding is the panel's "Create default
  schedule" button.
- Request bodies are bounded at 16 KiB.

Error envelope (shared with the bridge panel): `{"ok": false, "error": {"code",
"message"}}`.

| Code | Status | When |
| --- | --- | --- |
| `invalid_request` | 400 | body is not a JSON object, `expectedVersion` is missing or not a positive integer, `ops` is not an array, a validation error from the master schema |
| `body_too_large` | 413 | body over 16 KiB |
| `master_missing` | 404 | `ops` while no master file exists yet (use `seed` to create it) |
| `master_conflict` | 409 | `expectedVersion` does not match the file |
| `master_exists` | 409 | `seed` while a master exists |
| `scheduler_disabled` | 409 | `mode: "off"`, no usable plan root, or the engine failed to start |
| `internal` | 500 | anything else |

`GET` answers even while writes are refused, so a disabled scheduler still
explains itself in the panel.

## Deliberate differences from Loom

Each difference is an adapter decision, not an oversight.

(a) **A legacy `plan-{date}.json` day still schedules the master entries.**
Loom's `effectiveFromLegacyPlan` replaced the day view with the legacy plan, so
the master schedule vanished for that date. On dsh the v1 file is written by
`kinship-plan`, which has no coverage blocks and no wake time on items, so
copying Loom here would silently drop every scheduled wake for any day the model
touched. `legacy.ts` therefore materializes the master first and appends the
legacy items as overlay-style adds with `source: "legacy"`; an id that already
exists is skipped with a `legacy_collision:<id>` warning. Legacy items have no
`at`, so the scheduler counts them as `no_time` and they never invent a wake.
The read side is two-tier on purpose: the Loom v1 shape is validated strictly, a
dsh-written shape (no coverage, `carry_over`, items without `title`/`at`) is
coerced and flagged with a `legacy_coerced` warning. Both tiers failing degrades
to the master instead of throwing away the day.

(b) **The done hint no longer says `plan done` for non-build/review actions.**
Loom's hint told the model to mark the entry done, and Loom's plan store held
those ids. dsh's v1 plan tools read and write `plan-{date}.json`, which does not
contain master ids, so `plan done` would answer item-not-found. The rendered
wake therefore says, for `plan.build` / `plan.review`,
`完成后只写当日计划，不需要 plan done。`, and for everything else
`完成后无需回写计划（母版条目不在当日 v1 账里）；如需留痕，在回复里说明。`
The `条目：` line is still the master id, so the model can quote it in its reply.
The first version of this port said `plan note` instead; the 2026-11-15
production wake showed that path also fails (the day's v1 file was a closed test
leftover and the model passed the overlay version, so `plan note` answered
`expected version 20, actual 4`). Naming no tool is the honest hint until the
overlay write path is ported (see Known limits).

(c) **Only the `plan` wake source is implemented.** Loom also scheduled `flow`,
`special` and `inbox` wakes; dsh has no flow engine, no automatic wake command
and no inbox letter dispatch, so nothing would produce those entries. The ported
queue and renderer still understand all four sources (that is why the queue file
has a `source` field and the retention table has two tiers), but this plugin
only ever calls `reconcileSource("plan", ...)`. A deployment that also runs
Loom-style producers is therefore unaffected: the scheduler never cancels an
entry it did not create.

(d) **The state root defaults to `$DSH_HOME/kinship/state`.** Loom received a
`stateRoot` from its host process. dsh has no such concept, so the plugin
resolves a fixed default under the Harness home and lets `stateDir` /
`KINSHIP_PLAN_STATE_DIR` override it. Scheduler state (queue, shadow files) is
kept out of the plan root so switching runtimes does not mix state formats.

## Known limits

- Delivery needs the `kinship-bridge` row and a bound Session. Without a bound
  Session every reconcile answers `deferred_no_session` and does nothing, in
  shadow mode too.
- One bound Session only. The queue is per session id, so a manual rebind starts
  a fresh, empty queue; entries still pending in the previous session's file
  stay there and are not migrated.
- A crash between claim and delivery loses that one wake: the claim is persisted
  before the text is handed to the Session. Loom behaves the same way.
- Master ids cannot be marked done from dsh's v1 plan tools. Follow-up: port the
  day-overlay write tool (the overlay store is already mounted, but no tool
  exposes it), which would let the model write `update` ops against master ids.
- Coverage entries without an explicit `instruction` get the ported generated
  line, which ends after the task/window sentence; no wake names a write-back
  tool. Two earlier variants were wrong in production: Loom's
  `完成后 plan done。` (item-not-found on a master id) and the first port's
  `plan note` (closed v1 account / version conflict). Completion facts stay in
  the session reply until the overlay write tool exists.
- All master edits go through the panel routes. The Kinship model's own plan
  tools keep writing the v1 day file, which the scheduler then reads as legacy.
- `mode: "shadow"` never mounts a queue, so the panel's queue section is empty
  and the reconcile route returns zero counts.
- A wake is a chat message in the bound Session; it does not notify the user.
  The instruction line is the only place that can ask for a notification.
