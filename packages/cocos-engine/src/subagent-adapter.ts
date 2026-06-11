/**
 * subagent-adapter.ts — @comdr/cocos-engine 子智能体适配器
 *
 * ★ 只暴露 cocos-ask。cocos-engine 本身是完整 agent（Commander + DSL + Bridge），
 *   此适配器只做直连——把主引擎 LLM 的问题直接交给 AssemblyGateway。
 *
 * @agent Agent 6 — cocos-engine 子智能体
 */

import type { ToolDefinition, ToolResult } from '@comdr/core/types';
import type { ISubAgent, SubAgentManifest } from '@comdr/core/contracts';
import { runAssemblyProcess } from './gateway/assembly-gateway.js';
import { loadGatewayConfig, getActiveProvider, resolveCommanderModel } from './config/config-store.js';
import { CommanderState } from './memory/session-memory.js';
import { AssetCache } from './memory/asset-cache.js';
import { DocumentState } from './memory/document-state.js';
import type { CommanderSnapshot } from './memory/session-store.js';

// ============================================================================
// §1 Manifest
// ============================================================================

const MANIFEST: SubAgentManifest = {
  name: 'cocos-engine',
  description: 'Cocos Creator 3.x scene expert. Ask in natural language — it reads/writes scenes, manipulates nodes, manages components, and edits prefabs.',
  version: '0.3.0',
  toolPrefix: 'cocos',
};

// ============================================================================
// §2 Tool Definition — just one
// ============================================================================

const TOOLS: ToolDefinition[] = [
  {
    name: 'ask',
    description:
      'Ask cocos-engine to do something in the Cocos Creator project. ' +
      'Use natural language — it handles scene probing, node creation, component editing, ' +
      'prefab manipulation, and anything else Cocos-related. ' +
      'Examples: "add a Button to MainScene", "list all UI nodes in the current scene", ' +
      '"change the Label text on the login panel", "what scripts are available".',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What to do — in natural language.',
        },
      },
      required: ['prompt'],
    } as ToolDefinition['parameters'],
    permission: 'read_only' as const,
    timeoutMs: 300000, // 5 min — AssemblyGateway may run multiple turns
  },
];

// ============================================================================
// §3 Adapter
// ============================================================================

let seq = 0;
function ok(data: unknown): ToolResult {
  return {
    ok: true,
    callId: `cocos-${++seq}`,
    toolName: 'cocos__ask',
    content: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
  };
}

function err(msg: string): ToolResult {
  return {
    ok: false,
    callId: `cocos-${++seq}`,
    toolName: 'cocos__ask',
    content: msg,
    errorCategory: 'execution_error',
  };
}

export class CocosSubAgent implements ISubAgent {
  private projectRoot: string;
  private sessionMemory: CommanderState;
  private assetCache: AssetCache;
  private documentState: DocumentState;
  private commanderSnapshot: CommanderSnapshot | undefined;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.sessionMemory = new CommanderState();
    this.assetCache = new AssetCache(projectRoot);
    this.documentState = new DocumentState();
  }

  get manifest(): SubAgentManifest { return MANIFEST; }
  getTools(): ToolDefinition[] { return TOOLS; }

  async executeTool(_toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const prompt = String(args.prompt ?? '');

    try {
      const config = loadGatewayConfig();
      const provider = getActiveProvider(config);
      const model = resolveCommanderModel(provider, 'fast'); // Flash

      const result = await runAssemblyProcess({
        request: prompt,
        projectPath: this.projectRoot,
        sessionMemory: this.sessionMemory,
        assetCache: this.assetCache,
        documentState: this.documentState,
        provider: provider.provider,
        model,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        commanderSnapshot: this.commanderSnapshot,
      });

      // Save snapshot for next call (session continuity)
      if (result.commanderSnapshot) {
        this.commanderSnapshot = result.commanderSnapshot;
      }

      if (!result.ok) {
        return err(result.error ?? 'AssemblyGateway returned !ok');
      }

      // Commander has a question for the user
      if (result.ask) {
        return ok({ status: 'ask', ...result.ask });
      }

      return ok({
        status: result.status ?? 'completed',
        round: result.round,
        report: result.doneReport ?? null,
        results: result.results?.map((r) => ({
          command: r.command,
          ok: r.result.ok,
          data: r.result.data,
        })),
        diffs: result.diffs ?? [],
      });
    } catch (e) {
      return err(`cocos-ask failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ============================================================================
// §4 Factory
// ============================================================================

export function createSubAgent(config?: Record<string, unknown>): ISubAgent {
  return new CocosSubAgent(
    (config?.projectRoot as string) || process.cwd(),
  );
}
