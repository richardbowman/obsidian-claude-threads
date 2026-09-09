# ADR: Google Workspace MCP through a plugin-owned authentication proxy

**Date:** 2026-09-09
**Status:** Accepted

## Context

Agent Threads must expose Google's native Docs, Drive, Sheets and Slides MCP tools
to both Claude and Codex using the connected Google Docs Sync plugin. The shared
MCP factory supplies external HTTP configuration to both harnesses, whose verified
adapters use static headers. Google tokens expire during long threads. Google owns
discovery, schemas and operations; this integration must preserve those contracts.

## Decision

Run one plugin-owned listener on `127.0.0.1`, ephemeral port, started only when a
service is selected. Four fixed routes target Google's HTTPS MCP servers. Each
thread receives an unpredictable in-memory bearer capability scoped to its initial
enabled services. The proxy obtains a valid token through Google Docs Sync before
forwarding. Google tokens never enter harness configuration.

Use Node HTTPS for upstream requests, bypassing renderer CSP/CORS, and preserve
raw JSON/SSE bytes, status and relevant MCP session headers. Authenticate every
request, validate Host/Origin, allow only POST/GET/DELETE on exact known paths,
reject upstream redirects, allowlist headers, limit requests to 10 MiB and five
minutes, and bound token acquisition to 30 seconds. No operation parsing or replay.
Disconnecting transport does not prove Google cancelled an already submitted write.

Persist a plugin-settings map from thread ID to a SHA-256 connection fingerprint
(normalized auth-proxy URL plus refresh token) and initial service selection.
Never persist the refresh token, local bearer capability, or port. The synchronous
factory can return configuration while saving, but first upstream access awaits
successful persistence and fails closed if saving fails. Application restart
remints local capabilities only when the persisted fingerprint matches. Rotation,
reconnection, auth-host change or runtime peer-instance change revokes access;
old threads never silently adopt another connection. Ordinary access-token renewal
with unchanged refresh token remains automatic.

Disabling a service revokes the existing thread capability; re-enabling it does
not revive that capability. Archive/delete removes bindings and interrupts their
authorization; unload shuts down requests and the listener but preserves identity
metadata for later restart checks. Unbound threads may first bind after opt-in.

Require the companion TokenStore's `supportsConnectionGuard` capability. Its
guard checks tokens and auth host before applying async refresh results, preventing
stale refreshes from replacing or clearing a reconnected account. Proxy refresh
calls are serialized as well. Older companion builds produce an update instruction.

## Options considered

| Option | Benefit | Cost |
| --- | --- | --- |
| Static Google headers | Minimal wiring | Expiration during threads; Google tokens enter harness config |
| Harness refresh helpers | Direct Google connection | No verified common refresh contract |
| Loopback proxy | Common transport; central refresh; native tools | Local listener and forwarding lifecycle |
| In-process MCP bridge | Reuses host tools | More schema, result and session translation |

## Consequences and risks

No new dependencies or generic connector framework. Selected services expose
Google's full read/write toolsets through existing harness permissions. API
enablement, preview registration, OAuth scopes and corporate policies still apply.
Conservative rotation handling trades convenience for identity preservation.
Native Claude/Codex corporate live discovery and tool use across all four services
remain validation gates; mocked transport tests do not establish Google access.
Revisit this decision if both harnesses gain a common dynamic-auth contract or the
companion exposes a stronger stable account identity.

## References

- [MCP HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [Google Workspace MCP setup](https://developers.google.com/workspace/guides/configure-mcp-servers)
