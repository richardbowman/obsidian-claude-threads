import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { effectiveExtraEnv, parseExtraEnv, type PluginSettings } from './types';
import type { ConstrainedQueryInput, ConstrainedQueryOutput } from './PublicApi';

type QueryFunction = typeof query;

/**
 * Input-only Claude execution used by peer plugins for evaluation. The option
 * set is deliberately closed: callers cannot add tools, settings, plugins,
 * MCP servers, filesystem roots, or resumable session state.
 */
export function createConstrainedQueryRunner(
  getSettings: () => Pick<PluginSettings, 'claudeBinaryPath' | 'extraEnv' | 'provider'>,
  runQuery: QueryFunction = query,
): (input: ConstrainedQueryInput) => Promise<ConstrainedQueryOutput> {
  return async ({ prompt, options, signal }) => {
    // Desktop-only execution path. Keep Node built-ins out of module init so
    // importing the plugin bundle remains safe on Obsidian Mobile.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');
    const settings = getSettings();
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(Math.max(options.timeoutMs, 1), 600_000));
    try {
      let result: Extract<SDKMessage, { type: 'result' }> | undefined;
      for await (const message of runQuery({
        prompt,
        options: {
          abortController,
          pathToClaudeCodeExecutable: settings.claudeBinaryPath,
          env: { ...process.env, ...parseExtraEnv(effectiveExtraEnv(settings)), CLAUDE_AGENT_SDK_CLIENT_APP: 'agent-threads/constrained-runs' },
          cwd: os.tmpdir(),
          model: options.model,
          systemPrompt: options.systemInstructions,
          tools: [],
          allowedTools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          skills: [],
          plugins: [],
          persistSession: false,
          permissionMode: 'dontAsk',
          canUseTool: async () => ({ behavior: 'deny', message: 'Tools are disabled for constrained runs.' }),
          maxTurns: 1,
          maxBudgetUsd: options.maxBudgetUsd,
          enableFileCheckpointing: false,
        },
      })) {
        if (message.type === 'assistant' && message.message.content.some(block => block.type === 'tool_use')) throw new Error('Constraint violation: tool use emitted.');
        if (message.type === 'result') result = message;
      }
      if (!result || result.subtype !== 'success' || result.is_error) throw new Error('Constrained run failed.');
      return {
        output: result.result,
        usage: {
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          costUsd: result.total_cost_usd,
          durationMs: result.duration_ms,
          turns: result.num_turns,
        },
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  };
}
