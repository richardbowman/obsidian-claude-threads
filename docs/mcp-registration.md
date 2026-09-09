# Agent MCP registration

`mcp_register_server` lets an agent propose a global external MCP configuration. Claude and Codex use the same handler. The host asks for confirmation independently of harness tool approvals, so auto/bypass modes still show the dialog.

Example input (HTTP):

```json
{
  "name": "example-tools",
  "type": "http",
  "url": "https://mcp.example.com/tools",
  "headers": { "Authorization": "Bearer ${EXAMPLE_TOKEN}" }
}
```

For stdio, use `type: "stdio"`, `command`, optional `args` and `env`. For SSE use `type: "sse"`, `url` and optional `headers`. Do not mix transport fields. Names contain letters, digits, hyphens or underscores; `claude_threads`, `obsidian`, `__proto__`, `constructor` and `prototype` are reserved regardless of case.

The dialog displays the proposed configuration with unresolved placeholders and explains that it applies globally. Future initialized sessions may run the command or connect to the endpoint. Registration performs neither action. Existing adapters keep their original tool configuration. Cancel, dismissal, unavailable UI and scheduled requests make no changes. Scheduled requests return immediately rather than waiting behind an interactive dialog.

Results contain `success`, `status`, and `message`. Success statuses are `registered` and `unchanged`; they also include `requiredVariables` (placeholder names only). Other statuses are `conflict`, `invalid`, `cancelled`, `unavailable`, and `failed`. Identical retries do not save or prompt again. A different configuration with the same name is a conflict; edit existing servers in Settings → MCP.

Credentials must use `${NAME}` placeholders; obtain their values through `request_secret`. Common credential names in environment variables, headers, URL query parameters and CLI flags are checked. This check is not general secret detection: arbitrary literals, command strings and argument values must also remain nonsecret. HTTP/SSE URLs require HTTP(S) and cannot embed username/password credentials. No resolved secret or configuration is returned by registration. A required variable absent from a future session's environment causes the existing resolver to skip that server and show a warning; Project-scoped secret availability still applies.

Registration serializes agent requests and rechecks name collisions after approval. Success is returned only after settings persistence completes. A failed save removes only the entry written by that transaction, preserving unrelated or newer settings edits.
