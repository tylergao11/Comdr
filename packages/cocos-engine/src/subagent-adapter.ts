/**
 * subagent-adapter.ts — @comdr/cocos-engine 子智能体适配器
 *
 * ★ 实现 ISubAgent 契约，暴露 Cocos Creator 场景编辑能力给主 Comdr 引擎。
 *   工具以 "cocos__*" 形式注册。
 *
 * ★ scene_probe 直接读取 .prefab/.scene JSON，走 compileSceneTree 编译
 *   component_catalog 加载本地组件缓存 + 知识库
 *
 * @agent Agent 6 — cocos-engine 子智能体
 */

import type { ToolDefinition, ToolResult } from '@comdr/core/types';
import type { ISubAgent, SubAgentManifest } from '@comdr/core/contracts';
import {
  resolveProjectContext,
  discoverCandidates,
} from './context/project-context.js';
import { compileSceneTree } from './context/scene-compiler.js';
import { ComponentCatalog } from './model/component-catalog.js';
import { readJsonUtf8, normalizeSlash } from './foundation/value-kit.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

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
    'Query Cocos scene/prefab structure. Returns compiled blueprint (node hierarchy tree, component summary).',
    {
      target: { type: 'string', description: 'Scene or prefab file path (absolute or relative to project root)' },
      mode: { type: 'string', description: 'structure (default) | components | references' },
      depth: { type: 'number', description: 'Max tree depth (default 3, use large number for full)' },
    },
    15000),
  t('component_catalog',
    'List available Cocos Creator components with property schemas. Filter by category.',
    { filter: { type: 'string', description: 'all (default) | engine | scripts | ui | physics' } },
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
  private projectRoot: string;
  private _catalog: ComponentCatalog | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  get manifest(): SubAgentManifest { return MANIFEST; }

  getTools(): ToolDefinition[] { return TOOLS; }

  async executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (toolName) {
      case 'project_info': {
        try {
          const ctx = resolveProjectContext({ projectPath: String(args.path ?? this.projectRoot) });
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

      case 'scene_probe': {
        try {
          const target = String(args.target ?? '');
          const mode = String(args.mode ?? 'structure');
          const depth = args.depth !== undefined ? Number(args.depth) : 3;

          // Resolve path: absolute or relative to project root
          const resolved = path.isAbsolute(target)
            ? target
            : path.resolve(this.projectRoot, target);

          if (!fs.existsSync(resolved)) {
            return errResult('scene_probe', `File not found: ${resolved}`);
          }

          const raw = fs.readFileSync(resolved, 'utf-8');
          let json: unknown[];
          try {
            json = JSON.parse(raw);
          } catch {
            return errResult('scene_probe', `Invalid JSON in: ${resolved}`);
          }

          if (!Array.isArray(json)) {
            return errResult('scene_probe', `Expected a Cocos prefab/scene JSON array, got ${typeof json}`);
          }

          const detail = mode === 'components' ? 'full' : 'structure';
          const tree = compileSceneTree(json, { detail, depth });

          if (!tree) {
            return okResult('scene_probe', {
              status: 'empty',
              message: 'No nodes found in scene/prefab.',
            });
          }

          return okResult('scene_probe', tree);
        } catch (err) {
          return errResult('scene_probe',
            `Failed to probe scene: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      case 'component_catalog': {
        try {
          const filter = String(args.filter ?? 'all');
          const catalog = this.getCatalog();

          // Fallback: no cached data available
          if (!catalog.isLoaded || catalog.count === 0) {
            return okResult('component_catalog', {
              status: 'minimal',
              message: 'Component cache not available. Run Cocos Creator with Bridge to populate.',
              commonComponents: [
                { type: 'cc.Node', category: 'engine' },
                { type: 'cc.UITransform', category: 'ui' },
                { type: 'cc.Sprite', category: 'ui' },
                { type: 'cc.Label', category: 'ui' },
                { type: 'cc.Button', category: 'ui' },
                { type: 'cc.Layout', category: 'ui' },
                { type: 'cc.Widget', category: 'ui' },
                { type: 'cc.RigidBody2D', category: 'physics' },
                { type: 'cc.BoxCollider2D', category: 'physics' },
                { type: 'cc.CircleCollider2D', category: 'physics' },
                { type: 'cc.Animation', category: 'engine' },
                { type: 'cc.ParticleSystem', category: 'engine' },
                { type: 'cc.Camera', category: 'engine' },
                { type: 'cc.Canvas', category: 'engine' },
                { type: 'cc.Prefab', category: 'engine' },
              ],
            });
          }

          // Get entries based on filter
          let entries: any[];
          switch (filter) {
            case 'engine':
              entries = catalog.listEngine();
              break;
            case 'scripts':
              entries = catalog.listScripts();
              break;
            default:
              entries = catalog.list().map((name: string) => catalog.get(name)).filter(Boolean);
              break;
          }

          return okResult('component_catalog', {
            filter,
            count: entries.length,
            components: entries.slice(0, 100).map((e: any) => ({
              type: e.identity?.fullType ?? e.type,
              schema: e.schema?.map((s: any) => ({ name: s.name, type: s.type })),
              knowledge: e.knowledge ? 'available' : undefined,
            })),
          });
        } catch (err) {
          return errResult('component_catalog',
            `Failed to load catalog: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      default:
        return errResult(toolName, `Unknown cocos-engine tool: ${toolName}`);
    }
  }

  private getCatalog(): ComponentCatalog {
    if (this._catalog) return this._catalog;
    const catalog = new ComponentCatalog();
    try {
      catalog.load(this.projectRoot);
    } catch {
      // Catalog load may fail if temp/comdr/component-cache.json doesn't exist
      // Return empty catalog — component list falls back to hardcoded defaults
    }
    this._catalog = catalog;
    return catalog;
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
