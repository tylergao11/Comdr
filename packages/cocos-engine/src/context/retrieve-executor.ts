// ============================================================
// Retrieve Executor — >retrieve() 命令执行器
// 1. CAG: schema 查表 → compileSchema
// 2. RAG: probe 调 Bridge → 编译
// 3. 组装 → CompiledContext → 格式化为文本
// ============================================================

import { DslCommand, CmdResult } from '../types.js';
import { ComponentCatalog } from '../model/component-catalog.js';
import { InternalAssetCatalog } from '../model/internal-catalog.js';
import { AssetCache } from '../memory/asset-cache.js';
import { DocumentState } from '../memory/document-state.js';
import { RefResolver } from '../model/cocos-world.js';
import { compileContext } from './index.js';
import { ProbeSpec, CompiledContext } from './types.js';

// ===== 依赖接口 =====

export interface RetrieveDeps {
  catalog: ComponentCatalog;
  internalCatalog: InternalAssetCatalog;
  assetCache: AssetCache;
  documentState: DocumentState;
  resolver: RefResolver;
  projectPath: string;
  /** Bridge 通信接口，只需要 submit 方法 */
  toolCenter: {
    submit(task: { type: string; payload: Record<string, unknown> }, signal?: AbortSignal): Promise<{ ok: boolean; data?: unknown; error?: string; errorCode?: string }>;
  };
  signal?: AbortSignal;
}

// ===== 主入口 =====

/**
 * 执行 >retrieve() 命令
 * 返回编译后的上下文文本，由 Gateway 注入为下一轮 user message
 */
export async function executeRetrieve(
  cmd: DslCommand,
  deps: RetrieveDeps,
): Promise<CmdResult> {
  // ★ 精准供给: 读 DSL 参数，默认收紧（structure + depth 3）
  const schemas = cmd.schemas || [];
  const probeSpecs = cmd.probes || [];
  const hints = cmd.hints || '';
  const detail = cmd.detail || 'structure';   // 默认紧凑，LLM 需显式 full 才展开属性值
  const depth = cmd.depth ?? 3;                // 默认 3 层，LLM 需显式 all 才全展开
  const focus = cmd.focus;

  if (schemas.length === 0 && probeSpecs.length === 0) {
    return {
      ok: false,
      error: 'retrieve requires at least one schema or probe. Use >retrieve(schema=cc.Type) or >retrieve(probe=kind, ...)',
      errorCode: 'RETRIEVE_EMPTY',
    };
  }

  const warnings: string[] = [];

  // 1. CAG: 编译 schema
  const schemaEntries: Array<{ entry: NonNullable<ReturnType<typeof deps.catalog['get']>>; resolver: RefResolver }> = [];
  for (const typeName of schemas) {
    const resolved = deps.catalog.resolve(typeName);
    if (!resolved) {
      warnings.push(`Schema "${typeName}" not found. Available: use retrieve(schemas:[...]) with correct cc. prefix.`);
      continue;
    }
    const entry = deps.catalog.get(resolved);
    if (!entry) {
      warnings.push(`Schema "${typeName}" resolved to "${resolved}" but entry missing.`);
      continue;
    }
    schemaEntries.push({ entry: entry!, resolver: deps.resolver });
  }

  // 2. RAG: 并行执行 probe
  const probeResults: Array<{ kind: string; ok: boolean; data?: unknown; error?: string }> = [];
  if (probeSpecs.length > 0) {
    const probePromises = probeSpecs.map(async (spec): Promise<ProbeResult> => {
      const kind = spec.kind as string;
      const payload: Record<string, unknown> = { probeType: kind };
      // 展开 spec 各字段到 Bridge payload
      for (const [key, val] of Object.entries(spec)) {
        if (key === 'kind' || key === 'depth' || key === 'detail') continue;
        payload[key] = val;
      }
      try {
        const result = await deps.toolCenter.submit({ type: 'probe', payload }, deps.signal);
        return { kind, ok: result.ok, data: result.data, error: result.error };
      } catch (e) {
        return { kind, ok: false, error: (e as Error).message };
      }
    });
    const results = await Promise.all(probePromises);
    for (const r of results) {
      if (!r.ok) {
        warnings.push(`Probe(${r.kind}) failed: ${r.error}`);
      }
      probeResults.push(r);
    }
  }

  // 3. 提取 probe 结果
  let sceneJson: unknown[] | undefined;
  let assets: Array<{ name: string; path: string; isDir: boolean; importer?: string }> | undefined;
  let scripts: Array<{ name: string; path: string; compressedId: string }> | undefined;
  let sceneFocus: string | undefined;

  for (const result of probeResults) {
    if (!result.ok || !result.data) continue;
    const data = result.data as Record<string, unknown>;

    switch (result.kind) {
      case 'document-serialize': {
        sceneJson = data.json as unknown[];
        if (data.rootFileId) sceneFocus = data.rootFileId as string;
        break;
      }
      case 'node-detail': {
        // 单节点 probe → 构建最小场景 JSON
        if (data.json) {
          sceneJson = data.json as unknown[];
        }
        if (data.fileId) sceneFocus = data.fileId as string;
        break;
      }
      case 'find-in-doc': {
        if (data.matches && Array.isArray(data.matches)) {
          // find-in-doc 返回匹配列表 → 取第一个匹配节点的上下文
          const matches = data.matches as Array<Record<string, unknown>>;
          if (matches.length > 0) {
            sceneFocus = matches[0].fileId as string;
          }
        }
        break;
      }
      case 'assets': {
        const entries = (data.entries || []) as Array<Record<string, unknown>>;
        assets = entries.map((e) => ({
          name: e.name as string,
          path: e.path as string,
          isDir: e.isDir as boolean,
          importer: e.importer as string | undefined,
        }));
        break;
      }
      case 'scripts': {
        const list = (data.scripts || []) as Array<Record<string, unknown>>;
        scripts = list.map((s) => ({
          name: s.name as string,
          path: s.path as string,
          compressedId: s.compressedId as string,
        }));
        break;
      }
    }
  }

  // 4. 编译上下文
  const docState = deps.documentState.getCurrent();
  const docInfo = (docState && docState.kind !== 'none')
    ? {
        kind: (docState.kind as 'prefab' | 'scene'),
        path: docState.path || docState.dbUrl || '',
        name: docState.name || '',
        rootFileId: docState.rootUuid || undefined,
      }
    : undefined;

  const compiled = compileContext({
    schemaEntries,
    sceneJson,
    sceneOpts: { detail, depth, focus },
    assets,
    scripts,
    document: docInfo,
    hints,
  });

  // 合并 probe 级别的警告
  if (warnings.length > 0) {
    compiled.warnings = [...(compiled.warnings || []), ...warnings];
  }

  // 5. 格式化上下文为文本
  const contextText = formatCompiledContext(compiled);

  return {
    ok: true,
    type: 'retrieve',
    data: { context: contextText, compiled },
  };
}

// ===== 辅助类型 =====

interface ProbeResult {
  kind: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ===== 格式化 CompiledContext → LLM 可读文本 =====

export function formatCompiledContext(ctx: CompiledContext): string {
  const lines: string[] = [];

  // 文档
  if (ctx.document) {
    lines.push(`[文档] ${ctx.document.kind}: ${ctx.document.path}`);
    lines.push('');
  }

  // 场景树
  if (ctx.tree) {
    lines.push('[场景树]');
    formatNode(ctx.tree, lines, '', true);
    lines.push('');
  }

  // 可插入位置
  if (ctx.insertionPoints && ctx.insertionPoints.length > 0) {
    lines.push('[可插入位置]');
    for (const pt of ctx.insertionPoints) {
      const rankLabel = pt.rank === 'recommended' ? '[推荐]' : pt.rank === 'usable' ? '[可用]' : '[有限]';
      lines.push(`  ${pt.name} (#${pt.parent}) ${rankLabel}`);
      lines.push(`    ${pt.description}`);
      if (pt.currentChildren.length > 0) {
        const childrenList = pt.currentChildren.slice(0, 5).join(', ');
        const more = pt.currentChildren.length > 5 ? ` +${pt.currentChildren.length - 5} more` : '';
        lines.push(`    → 现有子节点: ${childrenList}${more}`);
      }
    }
    lines.push('');
  }

  // Schema
  if (ctx.schemas.length > 0) {
    lines.push('[组件 Schema]');
    for (const s of ctx.schemas) {
      // description + requires 已在 system prompt 的组件目录中缓存，此处不重复
      lines.push(`${s.type} (共${s.totalProperties}个属性${s.isScript ? ', 用户脚本' : ''}):`);

      if (s.conflicts) {
        lines.push(`  互斥: [${s.conflicts.join(', ')}]`);
      }

      // 关键属性 — 这是 retrieve 独有的展开信息
      if (s.keyProperties.length > 0) {
        const propLines = s.keyProperties.map(
          (p) => `${p.name}: ${p.type}${p.default !== undefined ? ` (default: ${JSON.stringify(p.default)})` : ''}`,
        );
        lines.push(`  关键属性: ${propLines.join(', ')}`);
      }

      // 引用属性
      if (s.refProperties && s.refProperties.length > 0) {
        const refLines = s.refProperties.map((r) => `${r.name} → ${r.refType}`);
        lines.push(`  引用属性: ${refLines.join(', ')}`);
      }

      // Knowledge children
      if (s.children && s.children.length > 0) {
        const childLines = s.children.map((c) => {
          const required = c.optional ? '' : ' (必建)';
          const childComps = (c as unknown as Record<string, unknown>).components as Array<{type: string}> | undefined;
          const compStr = childComps ? childComps.map((co: {type: string}) => co.type).join('+') : '';
          return `${c.type}[${compStr}]${required}`;
        });
        lines.push(`  自动子结构: ${childLines.join(', ')}`);
      }
    }
    lines.push('');
  }

  // 脚本
  if (ctx.scripts && ctx.scripts.length > 0) {
    lines.push('[可用脚本]');
    for (const s of ctx.scripts.slice(0, 20)) {
      lines.push(`  ${s.name} (path=${s.path})`);
    }
    if (ctx.scripts.length > 20) {
      lines.push(`  ... 共${ctx.scripts.length}个脚本`);
    }
    lines.push('');
  }

  // 资产
  if (ctx.assets && ctx.assets.length > 0) {
    lines.push('[资产列表]');
    for (const a of ctx.assets.slice(0, 30)) {
      const dirMark = a.isDir ? '/' : '';
      lines.push(`  ${a.path}${dirMark}`);
    }
    if (ctx.assets.length > 30) {
      lines.push(`  ... 共${ctx.assets.length}个条目`);
    }
    lines.push('');
  }

  // 警告
  if (ctx.warnings && ctx.warnings.length > 0) {
    lines.push('[注意]');
    for (const w of ctx.warnings) {
      lines.push(`  ${w}`);
    }
    lines.push('');
  }

  // 摘要
  lines.push(`[检索摘要] ${ctx.summary}`);

  return lines.join('\n');
}

// ===== 内部格式化 =====

function formatNode(
  node: import('./types.js').CompiledNode,
  lines: string[],
  prefix: string,
  isLast: boolean,
): void {
  const connector = isLast ? '└─' : '├─';
  const compSummary = formatCompSummary(node);

  const prefixChars = prefix.length > 0 ? prefix + connector : connector;
  const detailParts: string[] = [];
  if (compSummary) detailParts.push(compSummary);
  const detail = detailParts.length > 0 ? ` — ${detailParts.join(' ')}` : '';

  lines.push(`${prefixChars} ${node.name} (#${node.fileId})${detail}`);

  // 组件展示
  const childPrefix = prefix + (isLast ? '  ' : '│ ');
  for (let ci = 0; ci < node.components.length; ci++) {
    const comp = node.components[ci];
    if (Object.keys(comp.keyProps).length > 0) {
      const propStr = Object.entries(comp.keyProps)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(', ');
      const compPrefix = ci < node.components.length - 1 ? '├─' : '└─';
      lines.push(`${childPrefix}  ${compPrefix} [${comp.type}: ${propStr}]`);
    } else {
      const compPrefix = ci < node.components.length - 1 ? '├─' : '└─';
      lines.push(`${childPrefix}  ${compPrefix} [${comp.type}]`);
    }
  }

  // 递归子节点（只展示到 depth 限制）
  for (let ci = 0; ci < node.children.length; ci++) {
    const child = node.children[ci];
    const childIsLast = ci === node.children.length - 1;
    formatNode(child, lines, childPrefix, childIsLast);
  }
}

function formatCompSummary(node: import('./types.js').CompiledNode): string {
  // 提取关键信息：首组件类型 + 尺寸相关
  const parts: string[] = [];

  // 尺寸
  for (const comp of node.components) {
    if (comp.type === 'cc.UITransform' && comp.keyProps.width !== undefined) {
      parts.push(`${comp.keyProps.width}×${comp.keyProps.height}`);
      break;
    }
  }

  return parts.join(' ');
}
