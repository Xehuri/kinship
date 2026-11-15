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
