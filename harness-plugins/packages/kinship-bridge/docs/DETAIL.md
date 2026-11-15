# Kinship bridge

Publishes exactly one live Kinship Session to the Kinship backend as a loopback
HTTP API. The plugin binds at most one root Session whose agent preset is
`kinship`, persists that binding under `$DSH_HOME/kinship/binding.json`, and
authenticates every request with a bearer token.

## Endpoints

Under the bearer token, `GET /v1/health`, `GET /v1/session`, paged
`GET /v1/session/messages`, `POST /v1/session/messages`, `POST /v1/inbox`,
`POST /v1/session/bind`, `POST /v1/session/abort`, `GET /v1/session/events`
(SSE with the live `kinship/assistant-stream` frame type), `GET /v1/models`,
`GET /v1/session/context`, `POST /v1/session/compact`, `GET /v1/session/compaction`,
and the subagent catalog.

The owner-facing panel API used by the Web **Kinship** page lives beside them on
the dsh Connection's authenticated `/api` channel (`/api/kinship/ui/state`,
`/config`, `/token`, `/bind`); those routes never accept the bridge token and
are refused for every principal but the owner.

## Session lifecycle

A harness restart empties the live agent registry while the durable binding
still names the last Kinship Session. The bridge treats that as "not live yet":
it rehydrates the Session through the harness's own `sessionController` service
(the same path the Web UI takes when it opens a Session, including preset
mounting), warms it once at startup and lazily on the first request, and shares
one attempt between concurrent callers. A restart therefore needs no manual
"open the session in the UI once" step. Only a persisted Session the harness
reports as not found falls back to `bound_session_missing`; other resume
failures answer `409 bound_session_unavailable`.

## Configuration

`host` and `port` choose the listener (loopback only), `tokenFile` wins over
`tokenEnv`, which wins over the generated `$DSH_HOME/kinship/bridge-token`.
`policy` selects automatic first-Session binding or manual binding, `sessionId`
names a Session to bind at startup under the manual policy, and
`rebindOnMissing` lets the first policy move to another live Kinship Session when
the bound one disappears. `bodyLimitBytes` bounds request bodies.

Everything above is editable from the Web panel; saving writes the active
profile's plugin configuration and reloads this row.

## Limits

- The bridge is loopback-only by construction; there is no option to listen on a
  network interface.
- One Session at a time: switching the binding closes open event streams.
- Live assistant deltas are process-local and are not part of the durable log.
