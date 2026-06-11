// ============================================================
// DSL Formatter — 将命令执行结果格式化为 Commander 反馈文本
// ============================================================

import { ExecutedCommand, DslCommand } from '../types.js';
import { CommanderState } from '../memory/session-memory.js';
import { DocumentState } from '../memory/document-state.js';
import { ComponentCatalog } from '../model/component-catalog.js';
import { DISPLAY_FALLBACK_MAX } from '../foundation/constants.js';

/** 将压缩 UUID 翻译为可读的类名显示（仅展示用，不影响实际数据） */
function displayCompType(raw: string, catalog?: ComponentCatalog | null): string {
  if (!raw || !catalog) return raw;
  const name = catalog.classNameOf(raw);
  return name || raw;
}

/** 批量翻译 compTypes 数组 */
function displayCompTypes(types: string[] | undefined, catalog?: ComponentCatalog | null): string[] {
  if (!types) return [];
  return types.map((t) => displayCompType(t, catalog));
}

/** 将执行结果格式化为多行文本反馈 */
export function formatCommandResults(results: ExecutedCommand[], catalog?: ComponentCatalog | null): string {
  if (!results || results.length === 0) return '[no results]';

  const lines: string[] = [];
  const cat = catalog;

  for (let i = 0; i < results.length; i++) {
    const { command, result } = results[i];
    const prefix = result.ok ? '[ok]' : '[err]';
    const type = command.type || 'unknown';

    switch (type) {
      case 'probe': {
        const subType = command.probeType || 'unknown';
        if (result.ok) {
          const data = summarizeProbeResult(subType, result.data, cat);
          lines.push(`${prefix} probe(${subType}): ${data}`);
        } else {
          lines.push(`${prefix} probe(${subType}): ${result.error}`);
        }
        break;
      }
      case 'detail':
        lines.push(`${prefix} detail: ${result.ok ? summarizeNodeDetail(result.data, cat) : result.error}`);
        break;
      case 'open':
        if (result.ok && result.data) {
          const d = result.data as Record<string, unknown>;
          const rootName = d.name || d.rootName || '';
          const rootId = d.rootNodeUuid || d.rootFileId || '';
          lines.push(`${prefix} open(${command.assetPath || command.path || ''}): root=${rootName || 'opened'}${rootId ? ' fileId=#' + rootId : ''}`);
        } else {
          lines.push(`${prefix} open(${command.assetPath || command.path || ''}): ${result.ok ? 'opened' : result.error}`);
        }
        break;
      case 'schema':
        lines.push(`${prefix} schema(${command.component || ''}): ${result.ok ? formatSchema(result.data) : result.error}`);
        break;
      case 'compile':
        lines.push(`${prefix} compile(${command.path || ''}): ${result.ok ? formatCompileResult(command, result.data) : result.error}`);
        break;
      case 'add-node':
        lines.push(`${prefix} add-node(${command.tempId || ''}): ${result.ok ? formatAddNodeResult(result.data) : result.error}`);
        break;
      case 'add-comp':
        lines.push(`${prefix} add-comp(${command.component || ''}): ${result.ok ? 'added' : result.error}`);
        break;
      case 'write':
        lines.push(`${prefix} write(${command.path || command.dbUrl || ''}): ${result.ok ? 'written' : result.error}`);
        break;
      case 'set-prop':
      case 'set-props':
      case 'delete-node':
      case 'reparent':
      case 'duplicate':
      case 'set-active':
        lines.push(`${prefix} ${command.editType || type}: ${result.ok ? 'done' : result.error}`);
        break;
      case 'save':
        lines.push(`${prefix} save: ${result.ok ? 'saved' : result.error}`);
        break;
      case 'undo':
        lines.push(`${prefix} undo: ${result.ok ? 'restored' : result.error}`);
        break;
      case 'ask':
        lines.push(`[ask] ${result.ok && result.data ? (result.data as Record<string,unknown>).question || command.question || '' : command.question || ''}`);
        break;
      default:
        lines.push(`${prefix} ${type}: ${result.ok ? 'ok' : result.error}`);
    }

    // 本地修正记录（Gateway 本地执行，不浪费 LLM 轮次）
    if (result.autoCorrected) {
      lines.push(`  [fix] ${result.autoCorrected.from} → ${result.autoCorrected.to}`);
    }
  }

  return lines.join('\n');
}

/** 格式化链式失败信息 */
export function formatChainFailure(
  completed: ExecutedCommand[],
  failedCmd: DslCommand,
  failedResult: { ok: boolean; error?: string },
  remaining: DslCommand[]
): string {
  const lines: string[] = [];

  if (completed.length > 0) {
    lines.push(`# Completed (${completed.length}):`);
    for (const item of completed) {
      const prefix = item.result.ok ? '[ok]' : '[err]';
      lines.push(`  ${prefix} >${item.command.type}`);
      if (item.result.autoCorrected) {
        lines.push(`    [fix] ${item.result.autoCorrected.from} → ${item.result.autoCorrected.to}`);
      }
    }
  }

  lines.push(`# Failed: >${failedCmd.type}`);
  lines.push(`  [err] ${failedResult.error || 'unknown error'}`);

  if (remaining.length > 0) {
    lines.push(`# Not executed (${remaining.length}):`);
    for (const cmd of remaining) {
      lines.push(`  [skip] >${cmd.type}`);
    }
  }

  return lines.join('\n');
}

/** 构建本轮增量：只输出本轮新创建的 tempId（短名，不含 UUID） */
export function buildTurnDelta(commanderState: CommanderState | null): string {
  if (!commanderState) return '';
  const delta = commanderState.flushDelta();
  if (delta.length === 0) return '';
  return `+ ${delta.join(' ')}`;
}

// ===== 内部格式化 =====

function summarizeProbeResult(subType: string, data: unknown, cat?: ComponentCatalog | null): string {
  if (data === null || data === undefined) return 'null';

  // 控制台摘要
  if (typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (d.schema === 'Comdr.console-summary.v1') return formatConsoleSummary(d);
  }

  // 项目摘要
  if (subType === 'project-summary' && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    // probe-v2 返回的字段名为 scenes/prefabs/scripts（非 sceneCount/prefabCount/scriptCount）
    return `${d.scenes || 0} scenes, ${d.prefabs || 0} prefabs, ${d.scripts || 0} scripts`;
  }

  // 扁平路径列表
  if (Array.isArray(data)) {
    const label = subType === 'assets' ? 'assets' : subType === 'scripts' ? 'scripts' : subType === 'search' ? 'results' : subType === 'console' ? 'console entries' : 'items';
    const arr = data as Array<unknown>;
    if (arr.length === 0) return `0 ${label}`;
    if (subType === 'console') return `${arr.length} ${label}`;
    const paths = arr.map((item) => (typeof item === 'string' ? item : (item as Record<string, unknown>)?.path || (item as Record<string, unknown>)?.url || '')).filter(Boolean).join('\n  ');
    return `${arr.length} ${label}:\n  ${paths}`;
  }

  // 文档内模糊搜名
  if (subType === 'find-in-doc' && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const count = d.count as number || 0;
    const matches = d.matches as Array<Record<string, unknown>> | undefined;
    if (!matches || matches.length === 0) return `0 matches for '${d.query || ''}'. Do NOT invent a fileId. Try a different name, search without name= to list all nodes, or >ask(question=...) if stuck.`;
    const lines = matches.map((m) => {
      const fid = m.fileId || '';
      const comps = m.compTypes ? ', ' + displayCompTypes(m.compTypes as string[], cat).join(', ') : '';
      return `  ${m.path || ''} (node=${fid}) [${m.childCount || 0} children${comps}]`;
    });
    if (d.truncated) lines.push(`  ... (truncated — ${count} total matches)`);
    if (lines.length > 0) {
      lines.unshift(`  # Use the EXACT node= value (including #) in set-prop/delete-node/etc. Do NOT invent or change it.`);
    }
    return `${count} matches for '${d.query || ''}':\n${lines.join('\n')}`;
  }

  // 单资产详情
  if (subType === 'asset' && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (d.uuid) {
      const p = (d.path || d.url || d.displayName || '') as string;
      return `asset: ${p} uuid=${(d.uuid as string).slice(0, 8)}... (${(d.uuid as string).length} chars total)`;
    }
  }

  // 属性查询 — LLM 的眼睛，绝不截断
  if (subType === 'property') {
    if (typeof data === 'string') return data;
    return JSON.stringify(data);
  }

  // 兜底
  if (typeof data === 'string') {
    return data.length > DISPLAY_FALLBACK_MAX
      ? data.slice(0, DISPLAY_FALLBACK_MAX) + `\n... [truncated from ${data.length} chars]`
      : data;
  }
  const json = JSON.stringify(data);
  return json.length > DISPLAY_FALLBACK_MAX
    ? json.slice(0, DISPLAY_FALLBACK_MAX) + `\n... [truncated from ${json.length} chars]`
    : json;
}

function summarizeNodeDetail(data: unknown, cat?: ComponentCatalog | null): string {
  if (!data || typeof data !== 'object') return 'empty';
  const d = data as Record<string, unknown>;
  const comps = d.components as Array<Record<string, unknown>> | undefined;
  if (!comps || comps.length === 0) return `node ${d.name || 'unnamed'}: 0 components`;
  const lines = comps.map((c) => {
    const rawType = (c.type || '?') as string;
    const label = displayCompType(rawType, cat);
    const props = c.properties as Record<string, unknown> | undefined;
    const propKeys = props ? Object.keys(props).filter((k) => !k.startsWith('__') && k !== '_objFlags' && k !== '_enabled' && k !== '_name' && k !== '_id') : [];
    return `  ${label}${propKeys.length > 0 ? ' [' + propKeys.join(', ') + ']' : ''}`;
  });
  return `node ${d.name || 'unnamed'} (${comps.length} components):\n${lines.join('\n')}`;
}

function formatSchema(data: unknown): string {
  if (!data || typeof data !== 'object') return 'no schema';
  const d = data as Record<string, unknown>;
  const props = d.properties as Record<string, unknown> | undefined;
  if (!props) return 'no properties';
  const keys = Object.keys(props);
  return `${keys.length} fields: ${keys.join(', ')}`;
}

function formatConsoleSummary(d: Record<string, unknown>): string {
  const total = d.totalBuffered as number;
  const byLevel = d.byLevel as Record<string, number> | undefined;
  if (!byLevel) return `${total} console entries buffered`;
  const parts = Object.entries(byLevel).map(([lvl, n]) => `${lvl}:${n}`);
  return `${total} buffered (${parts.join(', ')})`;
}

function formatCompileResult(command: DslCommand, data: unknown): string {
  const spec = command.spec;
  const root = spec?.nodes?.find((n) => !n.parent);
  let nodeInfo = '';
  if (root) {
    const compTypes = (root.components || []).map((c) => c.type).join(', ');
    nodeInfo = ` root="${root.name}"${compTypes ? ` components=[${compTypes}]` : ''}`;
  }
  if (!data || typeof data !== 'object') return 'empty' + nodeInfo;
  const d = data as Record<string, unknown>;
  const stats = d.stats as Record<string, number> | undefined;
  if (stats) {
    return `${stats.nodes || 0}n ${stats.components || 0}c${nodeInfo}`;
  }
  return 'compiled' + nodeInfo;
}

function formatAddNodeResult(data: unknown): string {
  if (!data || typeof data !== 'object') return 'added';
  const d = data as Record<string, unknown>;
  const nodeFileId = d.nodeFileId as string || '';
  const mappings = d.mappings as Record<string, string> | undefined;
  const count = mappings ? Object.keys(mappings).length : 0;
  const ids = mappings ? Object.keys(mappings).slice(0, 5).join(', ') : '';
  const more = count > 5 ? ` +${count - 5} more` : '';
  if (nodeFileId) {
    return `created node #${String(nodeFileId).slice(0, 8)}${count > 0 ? ` (${count} tempIds: ${ids}${more})` : ''}`;
  }
  return `created${count > 0 ? ` (${count} tempIds: ${ids}${more})` : ''}`;
}
