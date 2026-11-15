# Kinship panel

Adds **Kinship** to the left sidebar of the dsh Web GUI. The page is the one
place to check and change the Kinship adapter on this Harness: it reads live
state from the `kinship-bridge` plugin over the authenticated `/api` channel and
writes bridge configuration through that plugin's own configuration entry.

## What the page shows

- **Bridge status** — listening URL, bridge and Harness versions, binding state,
  and the bound Session's title, id, cwd, and agent status.
- **Bearer token** — where the token comes from (environment variable, secret
  file, or the generated harness-home file) and its length. The value itself
  appears only after **Reveal token**; **Rotate token** writes a new value to the
  same file and switches the running bridge immediately.
- **Bridge configuration** — listen address and port, binding policy, the
  startup Session id, automatic rebinding, request-body limit, and the token
  environment variable and file path. Saving writes the active profile's plugin
  configuration and reloads the bridge row, so the new listener is live a moment
  later.
- **Bindable Sessions** — every live root Session running the `kinship` preset,
  with a bind action for each.
- **Connect Kinship** — the `config.yaml` keys the Kinship backend needs
  (`ai_backend: dsh`, `dsh.url`, `dsh.token`), ready to copy.
- **Plan schedule** — the optional `kinship-plan-scheduler` row's live view:
  mode (live/shadow/off), plan root, state directory, timezone, reconcile
  anchors, degradation state, and the next wake-up. The master schedule table
  lists every entry with its local time text (daily `HH:MM`, weekly
  `星期X HH:MM`, monthly `每月 N 日 HH:MM`, once `YYYY-MM-DD HH:MM`), kind,
  action, title, enabled toggle, next wake, and a two-step delete. Each row also
  carries an inline `HH:MM` editor that commits on Enter or blur. A small form
  adds daily/weekly entries, and the card ends with the wake queue (pending
  count with the first five pending wakes, the delivered tail, and **Reconcile
  now**).

## Plan-schedule routes

The card reads and writes the scheduler through the same owner-only channel:

| Method | Path | Request | Success response |
|---|---|---|---|
| GET | `/api/kinship/ui/plan` | - | `{ok, scheduler, master, queue, next}` |
| POST | `/api/kinship/ui/plan/ops` | `{expectedVersion, ops}` | the GET shape |
| POST | `/api/kinship/ui/plan/reconcile` | `{reason: "manual"}` | `{ok, queued:{added,updated,cancelled}, ...snapshot}` |
| POST | `/api/kinship/ui/plan/seed` | `{}` | the GET shape |

Every write sends the master `version` the card last read as
`expectedVersion`; a mismatch is answered `409` and the card asks the operator to
refresh instead of overwriting the other writer. When the scheduler plugin is
absent (route 404) or answers non-2xx, only the plan card shows an inline hint;
the bridge cards keep working.

## Behaviour and limits

- The panel appears only in compositions that serve the dsh Web GUI and that
  enable the `kinship-bridge` row; without that row the page reports that the
  bridge did not answer instead of showing stale state.
- Viewing needs no extra credential: the dsh Connection already authenticated
  the browser and refuses every non-owner principal on these routes.
- Saving needs a profile whose bridge row is uniquely addressable. A deployment
  without a configuration editor shows the page read-only.
- A token supplied by an environment variable cannot be rotated from the page;
  change the variable and restart `dsh` instead.
- Configuration is written as a complete override for the row, so values the
  bundle patch supplied dynamically (for example from environment variables) are
  pinned at the profile layer once you save.
- The plan card needs the `kinship-plan-scheduler` row. Without it the card
  states that the scheduler is not installed and the rest of the page is
  unaffected; a corrupt master plan shows the uninitialized state instead of
  stale rows.
- Plan edits are validated by the scheduler (schedule shape, entry kind, wake
  action). A rejected edit surfaces the Host's message verbatim and re-reads the
  snapshot, so the table never drifts from the file.
