/**
 * subagent-adapter.ts — @comdr/cocos-engine 子智能体适配器
 *
 * ★ 实现 ISubAgent 契约，暴露 Cocos Creator 场景编辑能力给主 Comdr 引擎。
 *   工具以 "cocos__*" 形式注册。
 *
 * ★ 当前为骨架——cocos-engine 自身有独立 Gateway 循环，
 *   此适配器暴露关键探测/操作接口。完整集成需 Bridge IPC 就绪。
 *
 * @agent Agent 6 — cocos-engine 子智能体
 */

import type { ToolDefinition, ToolResult } from '@comdr/core/types';
import type { ISubAgent, SubAgentManifest } from '@comdr/core/contracts';
import {
  resolveProjectContext,
  discoverCandidates,
} from './context/project-context.js';

// ============================================================================
// §1 Manifest
// ============================================================================

const MANIFEST: SubAgentManifest = {
  name: 'cocos-engine',
  description:
    'Cocos Creator 3.x scene editing — Blueprint Pattern, LLM-driven node/component manipulation via DSL',
  version: '0.1.0',
  toolPrefix: 'cocos',
};

// ============================================================================
// §2 Tool Definitions
// ============================================================================

function t(name: string, desc: string, params: Record<string, unknown>, ms: number): ToolDefinition {
  return {
    name,
    description: desc,
    parameters: {
      type: 'object',
      properties: params as Record<string, any>,
      ...(Object.keys(params).length > 0 ? { required: Object.keys(params) } : {}),
    } as ToolDefinition['parameters'],
    permission: 'read_only' as const,
    timeoutMs: ms,
  };
}

const TOOLS: ToolDefinition[] = [
  t('project_info',
    'Discover Cocos Creator project structure: assets, scenes, scripts, prefabs.',
    { path: { type: 'string', description: 'Project root directory path' } },
    10000),
  t('scene_probe',
    'Query Cocos scene/prefab structure. Returns compiled blueprint (simplified LLM-friendly format).',
    { target: { type: 'string', description: 'Scene or prefab path' }, mode: { type: 'string', description: 'structure | components | references' } },
    15000),
  t('component_catalog',
    'List available Cocos Creator components with property schemas.',
    { filter: { type: 'string', description: 'all | engine | scripts | ui | physics' } },
    5000),
];

// ============================================================================
// §3 Adapter
// ============================================================================

let seq = 0;
function okResult(toolName: string, data: unknown): ToolResult {
  return {
    ok: true,
    callId: `cocos-${++seq}`,
    toolName: `cocos__${toolName}`,
    content: JSON.stringify(data, null, 2),
  };
}

function errResult(toolName: string, msg: string): ToolResult {
  return {
    ok: false,
    callId: `cocos-${++seq}`,
    toolName: `cocos__${toolName}`,
    content: msg,
    errorCategory: 'execution_error',
  };
}

export class CocosSubAgent implements ISubAgent {
  get manifest(): SubAgentManifest { return MANIFEST; }

  getTools(): ToolDefinition[] { return TOOLS; }

  async executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (toolName) {
      case 'project_info': {
        try {
          const ctx = resolveProjectContext({ projectPath: String(args.path ?? '.') });
          const candidates = discoverCandidates(ctx);
          return okResult('project_info', {
            projectPath: (ctx as any).projectPath,
            candidates: candidates.slice(0, 50),
          });
        } catch (err) {
          return errResult('project_info',
            `Failed to probe project: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      case 'scene_probe':
        return okResult('scene_probe', {
          status: 'bridge_required',
          message: 'Scene probe requires Bridge IPC to running Cocos Creator editor.',
          tip: 'Open the target scene in Cocos Creator and ensure the Bridge extension is active.',
        });

      case 'component_catalog':
        return okResult('component_catalog', {
          status: 'bridge_required',
          message: 'Component catalog available via Bridge IPC in Cocos Creator editor.',
          commonComponents: ['cc.Node', 'cc.UITransform', 'cc.Sprite', 'cc.Label', 'cc.Button', 'cc.Layout', 'cc.Prefab', 'cc.RigidBody2D', 'cc.BoxCollider2D'],
        });

      default:
        return errResult(toolName, `Unknown cocos-engine tool: ${toolName}`);
    }
  }
}

/**
 * ★ 工厂函数——实现 SubAgentFactory 契约。
 */
export function createSubAgent(_config?: Record<string, unknown>): ISubAgent {
  return new CocosSubAgent();
}
