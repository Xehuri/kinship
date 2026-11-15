# Kinship compact

Model-callable manual compaction for the Kinship Session: one `compact_context`
tool over the harness compaction seam, executed once the current turn ends
instead of in the middle of it.

## What `compact_context` is

Loom's main Session can compact itself: `compact_context` starts a compaction
worker and the current turn suspends at its next LLM call until the summary is
in place (`loom-harness/packages/server/src/serve/compact-tool.ts`). The dsh
preset originally had only automatic compaction (`compaction-basic`), the human
`/compact` command (`command-compact`) and the bridge's
`POST /v1/session/compact` endpoint, so a `session.compact` wake - the seeded
default master carries one at 04:00 - had no model-facing tool to run.

This package mounts that tool. It is a preset row, not a Host row: it lives in
the `compaction` group of `presets/kinship.patch.yml`, so only Sessions running
that preset mount it.

## Why the deferred idle path exists

dsh's `CompactionEngine.compactNow` is an idle-session operation. Called while
the Session is running it fails with the `busy` `ManualCompactionError` (the
same reason `POST /v1/session/compact` answers 409 `compaction_busy`). A tool
always runs inside a turn, so `compact_context` cannot compact synchronously in
the general case.

The tool therefore records the request and returns immediately. A plugin-owned
poll waits for the agent to become idle after the turn and compacts exactly
once. The model-facing contract is still Loom's - call `compact_context`, get a
short acknowledgement, let the harness compact - with one difference: the
compaction lands in the gap before the next prompt instead of suspending the
current turn.

## Tool contract

`compact_context` takes no parameters (`parameters: {}`). It reads the calling
`exec.agent`; a call that has no owning agent session fails with
`compact_context requires an owning agent session`.

| Situation | Result text | `status` |
| --- | --- | --- |
| Agent idle, compaction produced a summary | `Compaction finished (~N history items).` | `finished` |
| Agent idle, nothing to compact | `No compactable history yet.` | `empty` |
| Agent running (or starts running before the call) | `Compaction scheduled: it runs when this turn ends.` | `scheduled` |
| Agent idle, compaction failed for a non-busy reason | the error is thrown to the model | - |

The structured output behind those texts is `{status, items}`, with
`items = 0` unless the status is `finished`.

## Configuration

Plugin row config (all optional; the preset row sets none, so the defaults
apply). The schema is the `Config` object exported from `src/index.ts`.

| Field | Default | Meaning |
| --- | --- | --- |
| `pollIntervalMs` | `500` | Interval of the deferred scan; the timer only runs while a request is pending |
| `maxWaitMs` | `600000` | Wall-clock budget for one scheduled request, measured from the newest call; past it the request is dropped |
| `maxAttempts` | `600` | How many `busy` outcomes one scheduled request may spend before it is dropped |

The plugin declares `inject: ['tools', 'compaction']` and the config is validated
by schemastery (`pollIntervalMs >= 1`, `maxWaitMs >= 0`, `maxAttempts >= 1`).

## Retry, replacement and disposal

- Pending requests live in one map keyed by Session id. A second call for the
  same Session replaces the earlier entry and re-arms the wait budget; the
  replaced entry is never compacted, because the scan only settles the exact
  entry it read.
- While the agent reports `running` the request stays pending and is retried on
  the next tick. `maxAttempts` counts `busy` outcomes; reaching it drops the
  request with one warning.
- `maxWaitMs` is checked before every attempt. An expired request is dropped
  with one warning and never compacted.
- A non-busy error on the deferred path is logged as a warning and the request
  is dropped; on the immediate path it is thrown to the model instead.
- The plugin owns one `setTimeout` at a time. It is armed only while requests
  are pending, `unref()`ed so it never keeps the process alive, and cleared
  together with the pending map on plugin dispose (`ctx.effect`).

The 04:00 wake and the tool are independent: a wake only asks the model to
compact itself; the tool is what actually calls the compaction engine.

## Known limits

- Compaction runs after the turn, not mid-turn. A very long turn cannot free
  context while it runs, unlike Loom, where the turn suspends at the next LLM
  call.
- A short Session, or one whose history is already compacted, answers
  `No compactable history yet.` - that is the engine reporting no compactable
  range, not a failure.
- The tool has no session parameter: it compacts the agent that is running the
  call. There is no main-session targeting and no way to compact another
  Session; it exists only where the Kinship preset's compaction group is
  mounted.
- A scheduled request is a best-effort promise: `maxWaitMs` / `maxAttempts` can
  drop it (with a warning) after the model already received the "scheduled"
  text.
- The poll is process-local. After a harness restart, pending requests are gone;
  the next `compact_context` call schedules a new one.
