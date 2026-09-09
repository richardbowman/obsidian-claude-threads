# ADR-0007: Host-confirmed agent MCP registration

**Date:** 2026-09-08
**Status:** Accepted

## Context

Agents need to add external MCP servers without manually editing plugin configuration. A saved stdio configuration can cause future sessions to execute a command, and remote configurations can send headers to an endpoint. Harness auto-approval cannot stand in for reviewing that durable configuration.

## Decision

Add `mcp_register_server` on the shared Claude/Codex tool surface. Use one plugin-owned confirmation dialog and one serialized registration transaction across all threads. Save unresolved credentials globally in the existing `mcpServers` store, await durable persistence, and apply only to newly initialized sessions. Creation is idempotent and never overwrites conflicting names. Scheduled requests return unavailable; registration never launches or probes servers.

## Options considered

| Option | Benefit | Cost |
| --- | --- | --- |
| Normal harness tool approval | Smallest integration | Auto/bypass permissions can approve durable command registration |
| Host confirmation (selected) | Explicit review across both harnesses | Requires an interactive host dialog |
| Inactive proposal queue | Supports unattended proposals | Additional lifecycle and review UI; no immediate activation |

## Consequences and risks

No new dependencies, storage schema or peer-plugin public API are needed. A plugin-level queue, post-confirmation collision check and identity-based rollback protect concurrent registration and settings edits. The host closes pending dialogs on unload. Credential-field validation is intentionally limited to recognizable fields; agents must keep every arbitrary literal nonsecret. Confirmation cannot guarantee that a reviewed command or endpoint is trustworthy. Registration does not validate connectivity, and missing credential variables are reported by the existing future-session resolver.
