# Peer Plugin API v1

Agent Threads exposes a generation-scoped API to other enabled Geode/Obsidian plugins:

```ts
const api = app.plugins.plugins['claude-threads']?.api?.v1;
```

Listen for `claude-threads:api-ready` and `claude-threads:api-stopping`, reacquire the API after every ready event, and discard an API object after stopping. The checked-in consumer contract is [`api/public-api-v1.d.ts`](../api/public-api-v1.d.ts).

## WikiSkill-safe capabilities

- `threads.create/send/wait/cancel` accepts caller correlation. Supplying both `ownerPluginId` and `idempotencyKey` makes create/send retries idempotent. A second distinct active send fails with `THREAD_BUSY`.
- `origin`, `externalJobId`, `ephemeral`, and `background` identify managed work. Threads with an `origin` are excluded from trace sources to prevent self-training loops.
- `traces.listSources/readChunk/subscribe` returns immutable, bounded, sanitized semantic records through opaque cursors. `TraceEvent.invokedSkill` is present only when Agent Threads observes a structured assistant `Skill` tool invocation; text cannot claim attribution, so consumers should reject events where it is absent. Raw log paths, credentials, and known secret fields are never returned.
- `constrainedRuns` provides Claude-only, one-turn, input-only evaluation. It loads no tools, MCP servers, settings sources, skills, plugins, filesystem context, or resumable session. Unsupported constraints fail with `CONSTRAINT_UNSUPPORTED`.

The API persists idempotency mappings and bounded results. A provider reload marks an in-flight operation interrupted; a consumer can reacquire v1 and reconcile it by run ID without duplicating work.

## Security boundary

Trace projection and redaction are owned by Agent Threads. Consumers must still treat trace text as sensitive and apply their own policy before persistence. `constrainedRuns` returns only final text and sanitized usage; SDK events, environment variables, credentials, and session IDs are private.
