# Peer Plugin API v1

Agent Threads exposes a generation-scoped API to other enabled Geode/Obsidian plugins:

```ts
const api = app.plugins.plugins['claude-threads']?.api?.v1;
```

Listen for `claude-threads:api-ready` and `claude-threads:api-stopping`, reacquire the API after every ready event, and discard an API object after stopping. The checked-in consumer contract is [`api/public-api-v1.d.ts`](../api/public-api-v1.d.ts).

## WikiSkill-safe capabilities

- `threads.create/send/wait/cancel` accepts caller correlation. Supplying both `ownerPluginId` and `idempotencyKey` makes create/send retries idempotent. Keys are bound to their operation, target thread, and an input fingerprint; reuse with different input fails with `IDEMPOTENCY_CONFLICT`. A second distinct active send fails with `THREAD_BUSY`.
- `origin`, `externalJobId`, `ephemeral`, and `background` identify managed work. When an owner is supplied, omitted origin defaults to `ownerPluginId`; a conflicting explicit origin is rejected. Background threads are hidden from both Agent Board views. Threads with an `origin` are excluded from trace sources to prevent self-training loops.
- `traces.listSources/readChunk/subscribe` returns immutable, bounded, sanitized semantic records through opaque cursors. Source discovery uses stable source-ID paging. Chunks always return a byte-offset continuation cursor (including at EOF, so polling can resume after append) bound to the source ID, append-stable revision, and a restart-verifiable byte-boundary fingerprint. `contentHash` changes when content is appended. Skill attribution is maintained by a revision-and-installed-skill-set-bound incremental session state machine that resets at `session_start` and terminal `result`, rather than rescanning history per result. Per-session attribution and simultaneous distinct-source projection work are bounded; overflow fails closed with no partial attribution. `TraceEvent.invokedSkill` is present only when a structured assistant `Skill` request names a currently registered skill and has a correlated, successful `tool_result`; that result carries `skillLoadOutcome: 'loaded'`, which does not imply task success. A terminal `result` event carries `skillRunOutcomes`, with the verified skill name, its source invocation index, and the enclosing run's `success` or `failure` outcome. Failed loads, unregistered skills, and text-only claims remain unattributed. Raw log paths, credentials, known secret fields, and absolute POSIX, Windows drive, UNC, home-relative, and file-URI paths are never returned; ordinary web URLs remain intact.
- `constrainedRuns` provides Claude-only, one-turn, input-only evaluation. It runs in a fresh empty directory with an isolated home/config directory and an authentication-only environment, then removes that directory. Provider credentials are projected from the plugin's keychain-backed resolver through an exact environment-name allowlist; the host configuration is never copied. It loads no tools, MCP servers, settings sources, skills, plugins, host filesystem context, or resumable session. Inputs, budgets, timeouts, persisted state (1 MiB total), and output (100,000 characters) are bounded. Unsupported constraints fail with `CONSTRAINT_UNSUPPORTED`.

The API serializes correlated operations and awaits atomic host persistence before returning their handles. Idempotency mappings and results are retained and evicted as pairs. A provider reload marks an in-flight operation interrupted; a consumer can reacquire v1 and reconcile it by run ID without duplicating work. Cancellation, completion, and provider shutdown use first-terminal-wins semantics.

## Security boundary

Trace projection and redaction are owned by Agent Threads. Consumers must still treat trace text as sensitive and apply their own policy before persistence. `constrainedRuns` returns only final text and sanitized usage; SDK events, environment variables, credentials, and session IDs are private.
