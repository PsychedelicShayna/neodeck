# Architecture

## High level

```
Browser tabs (Vite dev :5173 · Bun prod :1701)
   │  WS frames (subscribe / prompt / abort) + REST control plane
   ▼
Bun server  (apps/server)
   ├─ AgentBridge interface
   │   └─ InProcessAgentBridge → @oh-my-pi/pi-coding-agent SDK
   │       └─ Map<sessionId, AgentSession>
   ├─ Hono REST router  /api/{health, sessions, tasks, routines, inbox,
   │                         settings, models, marketplace, bridges, slash-commands, fs}
   ├─ Bun.serve WebSocket hub  /ws
   ├─ BroadcastBus (non-session frames: tasks_changed)
   ├─ MarketplaceService (lazy SDK MarketplaceManager wrapper)
   ├─ BridgeSupervisor (telegram and future messaging bridges)
   ├─ Routines runner (croner)
   └─ Static file serving for the built web bundle
```

```
apps/bridges/telegram (standalone Bun process — only when started)
   ├─ Long-poll Telegram API
   ├─ Per-chat session map (SQLite)
   ├─ Deck REST + WS client (talks to the deck like any other client)
   └─ Supervised by the deck's BridgeSupervisor
```

## Workspaces

- **`apps/server`** — Bun + Hono backend. Embeds the omp SDK.
- **`apps/web`** — Vite + React + Tailwind frontend. Pure consumer of the WS
  event stream; reduces events into a structured `SessionUi` in
  `lib/reducer.ts`.
- **`apps/bridges/telegram`** — Standalone Bun process. Independent
  package, depends on `@npi-deck/protocol` for shared types.
- **`packages/protocol`** — Dep-free shared types (REST + WS frames + DB
  shapes). The contract layer.

## The `AgentBridge` interface

`apps/server/src/bridge/types.ts` defines the contract. Current impl is
`InProcessAgentBridge` which embeds the SDK in the same Bun process. A
future subprocess-per-session impl (`omp --mode rpc` over stdio) can drop in
behind the same interface — useful when you want crash isolation per session
or to run sessions on different machines.

Routes never import `@oh-my-pi/pi-coding-agent` directly. Everything
sessions-related flows through `AgentBridge` or `SessionHandle`.

## Mixtures of agents

NeoPi owns mixture parsing, resolution, validation, persistence and execution.
`apps/server/src/mixtures-service.ts` (routes in `routes-mixtures.ts`) lists
every `MIXTURES.toml` on NeoPi's search path for a known workspace, addressed
by opaque ids, and validates drafts through the `mixture-config` manifest
feature. `mixture-files.ts` reads and writes those files without following
links (temp file + rename in the expected directory). A save holds NeoPi's
cross-process file lock across the hash compare, write and read-back, then
calls `AgentBridge.refreshMixtureRoster(cwd)`, the only place the deck
replaces a workspace's mixture roster. The bridge otherwise leases a
workspace scope per request (picker listing, chat creation, model switch) and
re-validates the chosen mixture under the chat's settings.

The web side keeps the chat's trace cards (`reducer.ts`) and the inspector's
MoA panel (`mixture-reducer.ts`) on the same `mixture_*` events. The routine
canvas and the mixture flowchart share `components/graph/GraphCanvasSurface.tsx`
for React Flow chrome only; each keeps its own nodes, edges and semantics.

## Frame model

The WS hub maintains:

- **Per-connection subscriptions** — `Set<sessionId>` per WS. Used to
  forward `session_event` frames + per-session bridge frames (UI dialog,
  plan-mode, subagent tree).
- **A global connection set** — `Set<ServerWebSocket>`. Used for broadcast
  frames (`tasks_changed`, `skills_changed`, `kb_changed`, `heartbeat`,
  `notification`) sent to every open client.

The `BroadcastBus` singleton (`apps/server/src/broadcast-bus.ts`) is the
producer side. Routes (`routes-tasks.ts`, `routes-skills.ts`, …) and deck
slash commands (`deck-slash-commands.ts`) call
`broadcastBus.broadcast(frame)`. The hub subscribes once at construction
and relays to every open connection.

Each in-process root subscribes to its own NeoPi `subagentEventBus` and joins
task lifecycle/progress/event updates to the global `AgentRegistry` parentId
chain. Only descendants of that root generation enter its `subagents_snapshot`
frames. `GET /api/subagents/:sessionId/:id/transcript` reads the child JSONL
incrementally; `POST /api/subagents/:sessionId/:id/abort` aborts the exact
registered session and tombstones its ref. Both reject another session's child
with 403. These routes do not resume parked agents or spawn a session while
browsing. Subagents remain visible in the chat's collapsible read-only panel
after completion; cross-process sessions are not part of this feature.

## Synthetic events

"Synthetic" event flavors flow over the same WS as the SDK's own events,
dispatched by the deck-side bridge code so the UI can react without
custom plumbing per feature:

- **`context_usage`** — emitted after every turn-end or compaction so the
  context indicator updates without a re-snapshot.
- **`session_updated`** — emitted after `session.setModel()` so the chat
  header's model label flips immediately.
- **`todo_phases_set`** — emitted after every `todo_write` tool result so
  the Inspector TodoPanel reflects intra-turn changes (the SDK's own
  `todo_reminder` only fires on reminder ticks — typically at turn
  boundaries — leaving the panel stale between cycles).
- **`prompt_queued`** + **`queue_state`** — emitted by the bridge's shadow
  queue when the user sends a prompt while streaming. `queue_state`
  re-broadcasts the canonical queue after every queue mutation (queue,
  cancel, edit, drain) so clients replace `queuedPrompts` wholesale.
- **`plan_mode_changed`**, **`plan_proposed`**, **`plan_proposal_resolved`**
  — plan-mode lifecycle. Pending proposals are replayed to late
  subscribers so a page reload during approval re-renders the card.
- **`ext_ui_dialog_open`** + **`ext_ui_dialog_cancel`** — `ask` tool +
  arbitrary `ctx.ui.*` extension calls. Replayed to late subscribers
  similarly.
- **`message_start` with `synthetic: true`** — emitted by both the SDK
  slash dispatcher and the deck slash dispatcher to inject the user's
  typed command + the handler's output into the transcript. The reducer
  ingests these as regular messages; the UI shows a `SYNTHETIC` badge.

The reducer (`apps/web/src/lib/reducer.ts`) handles each from a single
union case. No special protocol fork.

## Database

SQLite via Bun's built-in `bun:sqlite`. WAL mode, foreign keys on.

The shared connection owns every statement returned by `query()`, including
migration bookkeeping, initial seeding and DAO mutations. Its SQL-keyed cache
has no eviction: callers can retain a statement across transaction callbacks
or loops without it being finalized underneath them. The key space is the
finite set of SQL strings generated by the data layer; user values stay in
bound parameters. This avoids Bun's native 20-query cache limit, after which
new queries otherwise depend on GC for finalization.

Closing explicitly finalizes the connection's query cache before a strict
native close. The singleton is cleared only after close succeeds. Deliberately
uncached `prepare()` statements remain the caller's responsibility and must
be finalized before closing. Teardown removes database directories only after
that resource barrier, without forced GC, ignored errors or removal retries.

Schema lives in `apps/server/src/db/migrations/*.sql`. Migrations are
filename-sorted and applied at boot; a `schema_migrations` table records
which ones have been applied.

Tables:

- `schema_migrations` — applied migrations.
- `task_states` — kanban columns. Configurable.
- `tasks` — backlog/active/blocked/done items. `display_id` for human IDs (`T-1`, ...).
- `inbox_items` — quick captures + promote-to-task records.
- `routines` — cron / webhook / manual / event definitions: V0 single-action, V1 pipelines in `spec_yaml`, or V2 native graphs in `graph_json`.
- `routine_runs` — per-run history with status, duration, total cost, pinned NeoPi backend identity for agent steps, and immutable V2 execution traces in `graph_run_json`.
- `routine_step_runs` — per-step records inside a V1 run (stdout / stderr excerpts, JSON output, model, tokens, cost, retry attempt).
- `routine_state` — cross-run persistent state per routine, addressable from the templating engine.
- `bridge_state` — supervised bridge process records (currently Telegram).
- `env_settings` — masked secret store backing Settings → Env (atomic writes paired with `env-audit.log`).
- `sequences` — monotonic counters (currently just `tasks`).

On first boot against an empty `tasks` table the deck seeds a single
"Welcome to npi-deck" backlog task — see `apps/server/src/db/index.ts`
`seedWelcomeTaskIfEmpty`.

## Native routine graphs

`packages/protocol/src/graph.ts` owns the shared V2 contracts. A `RoutineGraph`
contains typed nodes, named input/output ports and directed edges; its JSON,
not YAML or canvas layout, is the execution source of truth. Port types are
`object`, `array`, `string`, `number`, `boolean` and `null`. `object` is the
general type: narrower outputs may connect to it, but a general output cannot
connect to a narrower input. Required inputs and single/multiple cardinality
are validated before persistence or dispatch, together with node configuration.

`GraphNodeRegistry.register({ definition, execute })` registers one node type.
The definition supplies its ports and optional configuration JSON Schema;
`execute(context)` returns named `{ port, value }` emissions, synchronously or
asynchronously. `GraphNodeContext` provides the node, ordered
`{ port, edgeId, output }` inputs, activation, run ID, abort signal and incremental
usage reporting. Handlers must cooperate with the abort signal; settled handlers
cannot report later usage. Validation, execution and the HTTP catalogue use the
same registry. `RoutinesRunner.graphRegistry` is the registration point for
subsequent node catalogues.

Every emitted `GraphOutput` contains `{ nodeId, port, result, inputs }`. Object
results and input envelopes retain their original in-memory objects; scalar,
null and array values reside in `result.value`. `inputs` preserves incoming edge
order and recursively retains upstream envelopes. Only an emitted port activates
its connected branch: `1`, a truthy string and literal `true` remain different
values. `readGraphPath(output, path)` traverses own keys, and
`findGraphOutput(output, nodeId, port?)` finds the nearest upstream envelope in
stable input order.

`GraphActivation` carries an `eventType`, the original event object and an
optional selected source node. The built-in `event.source` emits that event
through its `event` port; one activation runs each matching source once.
Unselected sources and disconnected branches produce skipped records, not
invented values. Execution is a deterministic DAG; inbox subscriptions, gate
and operation catalogues, external actions, iteration and canvas authoring have
their own slices and do not change this envelope contract.

Create and update through `POST /api/routines` and
`PATCH /api/routines/:id` with `graph`, and execute through the existing run
endpoint. `GET /api/routine-node-types` returns the shared catalogue;
`POST /api/routine-graphs/validate` rejects invalid connections before saving or
running them. Native graphs reject legacy action/YAML authoring fields.
`GET /api/routines/:id/runs/:runId/graph` returns a `GraphRunRecord`, including
the executed definition, activation, ordered node records, outputs, status and
usage. Final traces and existing run aggregates persist atomically. Later edits
do not replace a historical trace; reopening the database preserves exact JSON
values and recursive provenance.

## Theming

CSS custom properties on `<html data-theme="…">`. Tailwind reads each
color token through `rgb(var(--token) / <alpha-value>)`. An inline script
in `apps/web/index.html`'s `<head>` applies the saved theme **before**
React mounts to avoid flash-of-default. Full reference in
[docs/themes.md](./themes.md).

## Stores

The web frontend uses Zustand (`apps/web/src/lib/store.ts`) as the single
source of truth for sessions, WS connection, workspace metadata, and the
`tasksChangeCounter` that drives live kanban refreshes.

The TasksView, RoutinesView, and InboxView own their own local fetches and
caches — they subscribe to relevant change counters or refetch on mount.
Chat is fully store-driven because it needs cross-session state.

## Build outputs

- `apps/web/dist/` — production static bundle. Served by the deck server
  when `NPI_DECK_WEB_DIST` resolves to it (auto-detected).
- `apps/server/dist/` — `bun run build` also bundles the server
  (`bun build --target=bun`): `index.js` plus `structured-output-worker.js`,
  the worker thread that validates routine structured output, which must
  stay beside `index.js`. Nothing runs that bundle: the `npi-deck`
  launcher, `bun run start` and `bun run dev` all run
  `apps/server/src/index.ts` from source.

## Where omp lives

The deck loads NeoPi (`@oh-my-pi/pi-coding-agent` and its sibling packages)
at runtime from the source tree named by `activeBackend` in
`~/.npi-deck/config.yml`, pinned in `neopi.pin`; it is not a package
dependency. The deck reads from:

- NeoPi's agent dir (`getAgentDir()`, default `~/.omp/agent/`; `PI_CODING_AGENT_DIR` overrides) — sessions JSONL, auth.db,
  marketplaces.json, installed_plugins.json.
- The SDK's in-process `ModelRegistry`, `SessionManager`, `Settings`,
  `MarketplaceManager`, `BUILTIN_SLASH_COMMANDS_INTERNAL`,
  `ACP_BUILTIN_SLASH_COMMANDS`, and friends.

The deck never re-derives state the SDK already knows about — it calls
through.
