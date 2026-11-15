# Kinship plan

The daily-plan tool row of the Kinship preset. It owns the v1 truth file
(`plan-{date}.json`), the derived markdown view and the append-only ledger, and
since W59 it also writes the day's overlay (`plan-{date}.overlay.json`) when
the v1 file cannot serve a `plan note` / `plan done`.

## What it is

A preset tool plugin (`name: kinship-plan`, `inject: ['tools']`) that registers
`plan_read`, `plan_overlay_read`, `plan_commit`, `plan_note`, `plan_done`,
`plan_close`, and the Loom-compatible `plan` alias. The v1 store stays the truth
for daily planning: it is what the legacy adapter and the scheduler's legacy
reader consume. The overlay write-back is a fallback for the master+overlay
model, not a second truth for the day.

## Root and files

Root resolution never guesses:

1. `config.root`
2. `KINSHIP_PLAN_ROOT`
3. `KINSHIP_AI_ROOT/data`

Without any of them activation fails with a validation error; a relative path is
refused, and every resolved target is checked against the root's real path.

| Path | Written here | Meaning |
| --- | --- | --- |
| `{root}/daily/{date}/plan-{date}.json` | yes (v1 tools) | v1 truth, CAS on `version` |
| `{root}/daily/{date}/计划-{date}.md` | yes | derived human view |
| `{root}/daily/{date}/plan-ledger.jsonl` | yes (v1 and overlay rows) | append-only audit ledger |
| `{root}/daily/{date}/plan-{date}.overlay.json` | yes (overlay fallback) | day diff over the master, `.plan.lock` + atomic write |
| `{root}/plan/master.json` | no, read-only | master schedule; the overlay base |

The v1 file is rewritten with the same directory temp + `fsync` + rename
pattern; the markdown is written after the JSON, and a failed markdown write
does not roll the JSON back. Unknown top-level and unknown item fields are kept
in `extra` and merged back on every write, so v1/v2 fields such as `coverage`
survive even though this row never interprets them.

If `plan-{date}.overlay.json` exists while the v1 truth file does not,
`plan_commit` refuses to create the v1 file (`plan_overlay_present`) unless
`allowOverlayShadow: true`; `plan_read` reports `warning: "overlay_present"` in
that state.

## Tools

| Tool | Role |
| --- | --- |
| `plan_read` | read the v1 truth file; a missing file is `found:false`, not an error |
| `plan_overlay_read` | read the effective plan (master + overlay diff) and the ids/versions used by the write-back |
| `plan_commit` | create (`expected_version: 0`) or fully replace items/notes; unknown fields preserved; no coverage management |
| `plan_note` | append one note to v1, or to the day overlay when v1 cannot serve |
| `plan_done` | set one item status (default `done`), optional `evidence`/`note`, `done_at` on `done`; v1 first, overlay fallback |
| `plan_close` | close the day, carry unfinished items, write `carry_over` and a ledger row |
| `plan` | Loom-compatible alias (`read/commit/revise/diff/note/done/close`); `revise`/`diff` are full commits |

Every mutation carries `expected_version`: `0` creates (commit only), any other
value must equal the file's current version, and a mismatch is a `plan_conflict`
that leaves the file untouched. A `closed` v1 plan refuses `plan_commit`;
`plan_note` / `plan_done` leave it untouched and go to the overlay instead.
`close` with the current version is idempotent. Within one process writes are
serialized per date; across processes the v1 store compares versions and writes,
it is not a file lock.

## Overlay write-back

Master entries are not in the day's v1 file, and after the runtime switch a
business wake told the model to mark a master entry done, which answered
item-not-found (2026-11-15 production). The fallback closes that gap using the
same master/overlay code the scheduler already ports
(`kinship-plan-scheduler/plan/json-master-plan-store`, `json-plan-overlay-store`,
`plan-overlay`, `plan-ledger`).

### When it triggers

| Call | v1 outcome | Fallback |
| --- | --- | --- |
| `plan_note` with `expected_version` | `PlanNotFoundError` (no file) or `PlanClosedError` | writes the day overlay |
| `plan_note` without `expected_version` | allowed only while v1 is missing or closed | writes the day overlay; an existing open v1 file answers a validation error instead |
| `plan_done` with `expected_version` | `PlanItemNotFoundError`, `PlanNotFoundError` or `PlanClosedError` | writes the day overlay |
| `plan_done` without `expected_version` | allowed only while v1 is missing or closed | writes the day overlay (the wake hint's minimal form); an open v1 file answers a validation error with its current version |
| `plan` alias `note`/`done` | same handlers | same fallback (the alias never required the version) |

`plan_done` forwards its `expected_version` to the overlay CAS when it is `>= 1`;
`0` only means "no v1 plan was expected" and is not forwarded, so a stale real
v1 version still stays a conflict.

### Overlay creation

`ensureOverlay` returns the existing overlay or creates version 1 over the
current master:

- `date` is the requested day, `kind: "plan-overlay"`, `schema: 1`,
  `base_version` = the master's `version`, `ops: []`, `status: "draft"`.
- `coverage` = `{profile: "merged_7", checkpoints: <master anchor ids, sorted>,
  debt: []}`. The overlay schema requires at least one checkpoint, so a master
  with no `anchor` entry cannot be backed - the write fails validation.
- A missing master is refused with `[plan:overlay] master plan is required ...`
  (the fallback never invents a master).
- A creation race (another writer created the overlay between the read and the
  write) adopts that overlay instead of failing.
- A first note rides along on creation (`notes: [...]`), so it lands in version 1
  instead of costing a second revision.

### `plan_note` on the overlay

The note is appended through a CAS revision (`notes_append`) and a ledger row is
written:

```json
{"schema":1,"at":1794759707693,"date":"2026-11-16","source":"plan","event":"note","version":3,"reason":"<note>"}
```

### `plan_done` on the overlay

1. Build the effective view with `mergeOverlay(master, overlay, date)`.
2. Refuse an id that is absent from it (`... not in the effective plan;
   plan_overlay_read lists the available ids`) and an id the day's `remove` op
   suppressed (`... removed by a remove op in the day overlay`).
3. Check `expectedVersion`, when given, against the overlay version.
4. Patch `{status, evidence?, done_at}` - `done_at` is the injected clock as an
   ISO string and is only added for `status: "done"`; a blank `evidence` is
   omitted.
5. `upsertEntryPatch` keeps Loom's "at most one op per id" invariant: an
   existing `add` is patched in place, an existing `update` is merged, an id the
   day already removed is refused, and a `note` op does not block a first
   update.
6. Revise with the overlay version as CAS, then append the ledger row:

```json
{"schema":1,"at":1794759703751,"date":"2026-11-16","source":"plan","event":"done","entry_id":"cov-08","status":"done","version":2}
```

The returned mutation view reports the overlay's `version`/`status`,
`json_path` = the overlay file, and `source: "overlay"`, so the model can tell a
v1 write (`source` absent) from an overlay write.

### `plan_overlay_read`

`readEffective(date)` returns `{source, date, overlay_version, overlay_status,
entries}`:

- `source: "master"` when the day has no overlay: the master's entries for that
  date (`materializeMasterEntries`) with `status: "planned"` and `at` from the
  entry schedule.
- `source: "overlay"` when it does: the merged view with suppressed ids filtered
  out; each entry is projected to `id`, `kind`, `title`, `action`, `status`,
  `at` (evidence and `done_at` stay in the overlay op).
- `overlay_version` / `overlay_status` are `null` without an overlay.
- A missing `date` argument uses the row's default day (configured time zone).

The tool needs the overlay support the row wires in; without it the call fails
with `overlay: is not configured for this tool host`.

### What does not fall back

- v1 conflicts stay conflicts: `PlanConflictError` is not caught, so a stale
  `expected_version` never silently becomes an overlay write.
- `plan_commit` and `plan_close` only speak v1; they never create or edit an
  overlay.
- The plan tools never write the master; only the Kinship panel's plan routes do.
- `verify=coverage` is not implemented in dsh. The overlay's coverage block is a
  scheduling checkpoint list; nothing validates a day's coverage debt here.
- A closed v1 plan is never written; the overlay is the only destination.

## Ledger

`{root}/daily/{date}/plan-ledger.jsonl` is append-only (`O_APPEND`, one row per
write, `fsync` per row, no rewrite). Every row carries `schema: 1`, `at`,
`date`, `source` and `event`; `version`, `entry_id`, `status` and `reason` are
optional, and `expected_version` appears only on v1 writes. Plan rows use
`source: "plan"` with `event` `commit`/`note`/`done`/`close`; overlay rows use
the same shape without `expected_version`. The scheduler writes its own rows
with `source: "scheduler"` into the same file.

## Known limits

- The overlay write-back needs `plan/master.json` with at least one `anchor`
  entry; without a master (or without an anchor) the fallback refuses instead of
  inventing files.
- `plan_note` and `plan_done` accept an omitted `expected_version` only while the
  v1 file is missing or closed (the normal master-entry wake); an open v1 file
  still requires its CAS version, so the tool answers a validation error with
  that version instead of silently writing the overlay. `plan_commit` and
  `plan_close` always require the version.
- Once a day has an overlay, `kinship-plan-scheduler` reads the merged
  master+overlay view for that date and no longer merges the day's v1 legacy
  items, so a v1 item written before the overlay appeared is not scheduled afterwards.
- No coverage verifier: the overlay records the coverage profile but nothing
  checks a day's coverage debt in dsh yet.
- The overlay write path is CAS + `.plan.lock`; the v1 path is in-process
  serialization plus a version compare, so two processes writing the same v1 day
  can still lose an update.
