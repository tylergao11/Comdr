/**
 * tools/execute.ts — TS 层工具执行分发
 *
 * 处理 5 个高层语义工具的运行时执行。
 * 每个工具复用已有的 Memory/Index/Retrieval 基础设施。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ToolCall, ToolResult, ErrorCategory } from '@comdr/core/types';
import type { ToolBlueprint } from '@comdr/core';
import { SYSTEM, RUN_MODE, ERROR_CATEGORY } from '@comdr/core';
import type { EpisodicMemory } from '../memory/episodic.js';
import type { SemanticMemory } from '../memory/semantic.js';

import type { INativeTools } from '@comdr/core/contracts';
import { safeParseArgs } from '../utils.js';
import { BM25Scorer, tokenize, contextualPrefix } from '../retrieval.js';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { expandTool, formatExpansion } from '../tool-blueprint/index.js';

// ============================================================================
// §1 执行上下文
// ============================================================================

import type { Engine } from '../loop.js';

export interface ToolExecContext {
  projectPath: string;
  episodicMemory: EpisodicMemory;
  semanticMemory: SemanticMemory;
  nativeTools: INativeTools | null;
  engine: Engine;
  /** ★ Tool Blueprint — tool_explore 查询使用 */
  blueprint?: ToolBlueprint;
  /** ★ 原始工具列表 — tool_explore 展开时查找完整定义 */
  allTools?: import('@comdr/core/types').ToolDefinition[];
}

// ============================================================================
// §2 工具分发
// ============================================================================

/** ★ 判断是否为 TS 层高级工具 */
export function isAdvancedTool(toolName: string): boolean {
  return ADVANCED_TOOL_NAMES.has(toolName);
}

const ADVANCED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'tool_search',
  'tool_explore',
  'file_search',
  'memory_recall',
  'symbol_find',
  'repo_query',
  'shell_test',
  'task_spawn',
]);

/**
 * 执行 TS 层高级工具。
 * @returns ToolResult，未知工具返回 error
 */
export async function executeAdvancedTool(
  call: ToolCall,
  ctx: ToolExecContext,
): Promise<ToolResult> {
  const args = safeParseArgs(call.function.arguments);
  const base = {
    callId: call.id,
    toolName: call.function.name,
  };

  try {
    switch (call.function.name) {
      case 'tool_explore':
        return { ...base, ...execToolExplore(String(args.name ?? ''), ctx) };
      case 'tool_search':
        return { ...base, ...execToolSearch(String(args.query ?? ''), ctx) };
      case 'file_search':
        return { ...base, ...(await execFileSearch(
          String(args.query ?? ''),
          typeof args.topK === 'number' ? args.topK : 5,
          ctx,
        )) };
      case 'memory_recall':
        return { ...base, ...await execMemoryRecall(String(args.query ?? ''), ctx) };
      case 'symbol_find':
        return { ...base, ...execSymbolFind(String(args.name ?? ''), ctx) };
      case 'repo_query':
        return { ...base, ...execRepoQuery(
          String(args.action ?? 'hubs'),
          typeof args.file === 'string' ? args.file : undefined,
          typeof args.symbol === 'string' ? args.symbol : undefined,
          ctx,
        ) };
      case 'task_spawn':
        return { ...base, ...(await execTaskSpawn(
          String(args.prompt ?? ''),
          typeof args.mode === 'string' ? args.mode : 'plan',
          ctx,
        )) };
      case 'shell_test':
        return {
          ...base,
          ...execShellTest(
            typeof args.path === 'string' ? args.path : undefined,
            typeof args.filter === 'string' ? args.filter : undefined,
            ctx,
          ),
        };
      default:
        return {
          ...base,
          ok: false,
          content: `Unknown advanced tool: ${call.function.name}`,
          errorCategory: ERROR_CATEGORY.EXECUTION_ERROR,
        };
    }
  } catch (err) {
    return {
      ...base,
      ok: false,
      content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
      errorCategory: ERROR_CATEGORY.EXECUTION_ERROR,
    };
  }
}

// ============================================================================
// §3 各工具实现
// ============================================================================

/** 1. tool_search — Embedding 工具检索 */
type ExecResult = { ok: boolean; content: string; errorCategory?: ErrorCategory };

/** ★ tool_explore — Blueprint 世界模型 drill-down */
function execToolExplore(
  toolName: string,
  ctx: ToolExecContext,
): ExecResult {
  const name = toolName.trim();
  if (!name) {
    return { ok: false, content: 'tool_explore requires a tool name. Try "file_edit", "audit__scan", etc.', errorCategory: 'execution_error' };
  }

  const blueprint = ctx.blueprint;
  const tools = ctx.allTools;

  if (!blueprint || !tools) {
    return { ok: false, content: 'Tool blueprint not available. Tools may not have been compiled yet.', errorCategory: 'execution_error' };
  }

  const expansion = expandTool(name, tools, blueprint);
  if (!expansion) {
    // 尝试模糊匹配——给出最接近的工具名提示
    const candidates = blueprint.nodes
      .map((n) => n.name)
      .filter((n) => n.includes(name) || name.includes(n))
      .slice(0, 5);
    const hint = candidates.length > 0
      ? ` Did you mean: ${candidates.join(', ')}?`
      : '';
    return {
      ok: false,
      content: `Tool "${name}" not found in blueprint.${hint}\nUse names exactly as shown in the blueprint — try the short names (e.g. "file_edit" not "edit").`,
      errorCategory: 'execution_error',
    };
  }

  return {
    ok: true,
    content: formatExpansion(expansion),
  };
}

function execToolSearch(
  query: string,
  ctx: ToolExecContext,
): ExecResult {
  const q = query.trim();
  if (!q) return { ok: true, content: 'No query provided. Describe what you want to do (e.g. "edit a file" or "run a shell command").' };

  const tools = ctx.allTools;
  if (!tools || tools.length === 0) {
    return { ok: false, content: 'No tools available to search.', errorCategory: 'execution_error' };
  }

  // ★ 子串 + 词级匹配——30~50 个工具，同步跑 <1ms，不需要 embedding
  const queryLower = q.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 1);

  const matches = tools
    .map((t) => {
      const haystack = `${t.name} ${t.description}`.toLowerCase();
      let score = 0;
      // 全 query 子串命中 = 高权重
      if (haystack.includes(queryLower)) score += 10;
      // 每个词命中 +1
      for (const word of queryWords) {
        if (haystack.includes(word)) score += 1;
      }
      return { tool: t, score };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (matches.length === 0) {
    return { ok: true, content: `No tools matching "${q}". Try describing what you want to do (e.g. "find files by content" instead of "grep").` };
  }

  const lines = matches.map((m, idx) => {
    const desc = m.tool.description.length > 120
      ? m.tool.description.slice(0, 117) + '...' : m.tool.description;
    return `${idx + 1}. score=${m.score} | ${m.tool.name} — ${desc}`;
  });
  return { ok: true, content: `Tools matching "${q}":\n${lines.join('\n')}\n\nUse tool_explore("name") for full details on any tool.` };
}

/** 2. file_search — BM25 关键词检索 */
async function execFileSearch(
  query: string,
  topK: number,
  ctx: ToolExecContext,
): Promise<ExecResult> {
  const q = query.trim();
  if (!q) return { ok: true, content: 'No query provided.' };

  const files = scanProjectFiles(ctx.projectPath, SYSTEM.SCAN_PROJECT_MAX_FILES);
  if (files.length === 0) return { ok: true, content: 'No files found to search.' };

  const bm25 = new BM25Scorer();
  const docTokens: Map<string, number>[] = [];
  const docPaths: string[] = [];
  for (const file of files.slice(0, SYSTEM.SCAN_PROJECT_MAX_FILES / 2)) {
    try {
      const text = readFileSync(file, 'utf-8').slice(0, SYSTEM.FILE_INDEX_TRUNCATE_CHARS);
      const tokens = tokenize(text);
      bm25.addDocument(tokens);
      docTokens.push(tokens);
      docPaths.push(file);
    } catch { /* skip */ }
  }
  if (docPaths.length === 0) return { ok: true, content: 'No readable files found.' };

  const queryTokens = tokenize(q);
  const scored = docPaths
    .map((path, i) => ({ path, score: bm25.score(queryTokens, docTokens[i]!) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  if (scored.length === 0) return { ok: true, content: 'No matching files found.' };
  const lines = scored.map((s, idx) => `${idx + 1}. score=${s.score.toFixed(2)} | ${s.path}`);
  return { ok: true, content: `Found ${scored.length} matching file(s):\n${lines.join('\n')}` };
}

/** 3. memory_recall — EpisodicMemory 检索 */
async function execMemoryRecall(
  query: string,
  ctx: ToolExecContext,
): Promise<ExecResult> {
  const q = query.trim();
  if (!q) return { ok: true, content: 'No query provided.' };

  const results = await ctx.episodicMemory.retrieve(q, 5);
  if (results.length === 0) {
    return { ok: true, content: 'No matching past sessions found.' };
  }

  const lines = results.map((ep, idx) => {
    const files = ep.structuredSummary?.fileModifications
      ?.map((f) => `${f.action} ${f.path}`) ?? [];
    const decisions = ep.structuredSummary?.decisions?.map((d) => d.what) ?? [];
    return [
      `${idx + 1}. [${ep.id.slice(0, 8)}] ${ep.task}`,
      `   Outcome: ${ep.outcome ?? 'unknown'} | Turns: ${ep.turns} | Tokens: ${ep.tokensUsed}`,
      files.length > 0 ? `   Files: ${files.join(', ')}` : '',
      decisions.length > 0 ? `   Decisions: ${decisions.join('; ')}` : '',
    ].filter(Boolean).join('\n');
  });

  return { ok: true, content: `Past sessions:\n${lines.join('\n\n')}` };
}

/** 4. symbol_find — SemanticMemory 查符号 */
function execSymbolFind(
  name: string,
  ctx: ToolExecContext,
): ExecResult {
  const n = name.trim();
  if (!n) return { ok: true, content: 'No symbol name provided.' };

  const def = ctx.semanticMemory.findDefinition(n);
  if (!def) {
    return { ok: true, content: `Symbol "${n}" not found in the project index.` };
  }

  const dependents = ctx.semanticMemory.getDependents(def.path);
  const parts: string[] = [
    `Definition: ${def.type} \`${def.name}\` in ${def.path}${def.location ? ` at ${def.location}` : ''}`,
  ];
  if (dependents.length > 0) {
    parts.push(`Dependents (${dependents.length}):`);
    for (const dep of dependents.slice(0, 10)) {
      parts.push(`  - ${dep}`);
    }
  } else {
    parts.push('Dependents: none found.');
  }

  return { ok: true, content: parts.join('\n') };
}

/** 5a. repo_query — 依赖图查询 */
function execRepoQuery(
  action: string,
  file?: string,
  symbol?: string,
  ctx?: ToolExecContext,
): ExecResult {
  const sem = ctx?.semanticMemory;
  if (!sem) return { ok: false, content: 'Semantic memory not available.' };

  switch (action) {
    case 'hubs': {
      // Top imported files (hub nodes)
      const hubs = sem.getTopImported?.(10) ?? [];
      if (hubs.length === 0) return { ok: true, content: 'No dependency data available.' };
      const lines = ['Top hub files (most imported):'];
      for (const h of hubs) lines.push(`  - ${h.path} ← ${h.count} importers`);
      return { ok: true, content: lines.join('\n') };
    }
    case 'dependents': {
      if (!file) return { ok: false, content: 'repo_query dependents requires "file" parameter.' };
      const deps = sem.getDependents(file);
      if (deps.length === 0) return { ok: true, content: `No files import "${file}".` };
      return { ok: true, content: `${deps.length} files import "${file}":\n${deps.slice(0, 20).map((d) => `  - ${d}`).join('\n')}` };
    }
    case 'dependencies': {
      if (!file) return { ok: false, content: 'repo_query dependencies requires "file" parameter.' };
      const deps = sem.getDependencies?.(file) ?? [];
      if (deps.length === 0) return { ok: true, content: `"${file}" imports nothing tracked.` };
      return { ok: true, content: `"${file}" imports:\n${deps.slice(0, 20).map((d) => `  - ${d}`).join('\n')}` };
    }
    case 'find': {
      if (!symbol) return { ok: false, content: 'repo_query find requires "symbol" parameter.' };
      const def = sem.findDefinition(symbol);
      if (!def) return { ok: true, content: `Symbol "${symbol}" not found.` };
      return { ok: true, content: `${def.type} \`${def.name}\` defined in ${def.path}${def.location ? ` @${def.location}` : ''}` };
    }
    default:
      return { ok: false, content: `Unknown action "${action}". Valid: hubs, dependents, dependencies, find.` };
  }
}

/** 5. shell_test — 通过 NativeTools 执行测试 */
function execShellTest(
  testPath: string | undefined,
  filter: string | undefined,
  ctx: ToolExecContext,
): ExecResult {
  if (!ctx.nativeTools) {
    return {
      ok: false,
      content: 'Native tools not available (pnpm build:tools not run).',
      errorCategory: ERROR_CATEGORY.EXECUTION_ERROR,
    };
  }

  // 通过 shell_bash 执行测试，解析输出为结构化数据
  const testRunner = detectTestRunner(ctx.projectPath);
  const cmd = buildTestCommand(ctx.projectPath, testRunner, testPath, filter);

  const result = ctx.nativeTools.execute({
    name: 'shell_bash',
    callId: `test-${Date.now()}`,
    arguments: { command: cmd },
    projectPath: ctx.projectPath,
    timeoutMs: 120000,
  });

  // 解析测试输出，提取 passed/failed
  const parsed = parseTestOutput(result.content ?? '', testRunner);
  if (parsed) {
    return {
      ok: result.ok,
      content: [
        `Test runner: ${testRunner}`,
        `Command: ${cmd}`,
        `Passed: ${parsed.passed}, Failed: ${parsed.failed}`,
        '',
        'Output:',
        result.content?.slice(0, 2000) ?? '(empty)',
      ].join('\n'),
    };
  }

  return {
    ok: result.ok,
    content: result.content ?? 'Test execution completed (results could not be parsed).',
  };
}

/** 6. task_spawn — 启动独立子 Agent */
async function execTaskSpawn(
  prompt: string,
  mode: string,
  ctx: ToolExecContext,
): Promise<ExecResult> {
  const p = prompt.trim();
  if (!p) return { ok: false, content: 'task_spawn requires a prompt.', errorCategory: ERROR_CATEGORY.EXECUTION_ERROR };

  const validModes = [RUN_MODE.AGENT, RUN_MODE.PLAN, RUN_MODE.YOLO] as string[];
  const subMode = (validModes.includes(mode) ? mode : RUN_MODE.PLAN) as 'agent' | 'plan' | 'yolo';

  const startTime = Date.now();
  // ★ Dynamic import to avoid circular dependency (loop.ts → execute.ts → subagent.ts → loop.ts)
  const { runSubAgent } = await import('../subagent.js');
  const result = await runSubAgent(p, ctx.engine, { mode: subMode, label: `spawn-${p.slice(0, 20)}` });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const lines = [
    `Sub-agent completed in ${duration}s | ${result.turns} turns | ${result.tokensUsed} tokens`,
    result.ok ? 'Status: OK' : 'Status: FAILED',
    `Tools used: ${result.toolCalls.length > 0 ? result.toolCalls.join(', ') : 'none'}`,
    '',
    'Result:',
    // ★ 截断到 4000 字符：子 Agent 输出可能极大（如整个代码审查报告），
    //   prompt token 预算有限，保留完整结果会撑爆上下文窗口。
    //   4000 字符（约 1000-2000 token，取决于中英文混合度）是经验值：
    //   - 足够容纳子 Agent 的最终总结（包含关键结论、文件列表、错误信息）
    //   - 不会占满主 Agent 的 token 预算
    //   - 若需要完整结果，主 Agent 可再调用 task_spawn 获取细节
    result.summary.slice(0, 4000),
  ];

  return { ok: result.ok, content: lines.join('\n') };
}

// ============================================================================
// §4 辅助函数
// ============================================================================

/** 扫描项目文件（用于 BM25 索引） */
function scanProjectFiles(projectPath: string, maxFiles: number): string[] {
  const files: string[] = [];
  const codeExts = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.rs', '.py', '.go', '.java',
    '.toml', '.yaml', '.yml', '.json', '.md', '.html', '.css',
  ]);
  const skipDirs = new Set(['node_modules', 'target', 'dist', '.git', '__pycache__', '.venv']);

  function walk(dir: string) {
    if (files.length >= maxFiles) return;
    try {
      for (const entry of readdirSync(dir)) {
        if (files.length >= maxFiles) return;
        const full = join(dir, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            if (!skipDirs.has(entry)) walk(full);
          } else if (st.isFile()) {
            const ext = extname(entry);
            if (codeExts.has(ext) && st.size < 500_000) {
              files.push(full);
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  walk(projectPath);
  return files;
}

/** 检测项目的测试运行器 */
function detectTestRunner(projectPath: string): string {
  if (existsSync(join(projectPath, 'vitest.config.ts')) ||
      existsSync(join(projectPath, 'vitest.config.js'))) return 'vitest';
  if (existsSync(join(projectPath, 'jest.config.ts')) ||
      existsSync(join(projectPath, 'jest.config.js'))) return 'jest';
  if (existsSync(join(projectPath, 'Cargo.toml'))) return 'cargo';
  if (existsSync(join(projectPath, 'pyproject.toml'))) return 'pytest';
  if (existsSync(join(projectPath, 'go.mod'))) return 'go';
  if (existsSync(join(projectPath, 'package.json'))) return 'vitest'; // default for JS/TS
  return 'unknown';
}

/** 检测 package.json 中的包管理器 */
function detectPackageManager(projectPath: string): string {
  try {
    const lockFiles = readdirSync(projectPath);
    if (lockFiles.includes('pnpm-lock.yaml')) return 'pnpm';
    if (lockFiles.includes('yarn.lock')) return 'yarn';
  } catch { /* fallback to npx */ }
  return 'npx';
}

/** 根据测试运行器构建测试命令 */
function buildTestCommand(projectPath: string, runner: string, testPath?: string, filter?: string): string {
  const path = testPath ?? '';
  const pm = detectPackageManager(projectPath);
  switch (runner) {
    case 'vitest': return filter ? `${pm} vitest run ${path} -t "${filter}"` : `${pm} vitest run ${path}`;
    case 'jest': return filter ? `${pm} jest ${path} -t "${filter}"` : `${pm} jest ${path}`;
    case 'cargo': return filter ? `cargo test ${filter}` : 'cargo test';
    case 'pytest': return filter ? `python -m pytest ${path} -k "${filter}"` : `python -m pytest ${path}`;
    case 'go': return filter ? `go test ${path} -run "${filter}"` : `go test ${path} ./...`;
    default: return filter ? `${pm} test -- ${path} --grep "${filter}"` : `${pm} test ${path}`;
  }
}

/** 从测试输出中解析 passed/failed 计数 */
function parseTestOutput(
  output: string,
  _runner: string,
): { passed: number; failed: number } | null {
  // ★ 同时尝试 passed-before-failed 和 failed-before-passed 两种顺序
  //   vitest "Tests: 2 failed, 5 passed, 7 total" → failed 在前
  //   vitest "Tests: 5 passed, 2 failed, 7 total" → passed 在前

  // 模式 1: "Tests: N passed/passing ... M failed/failing" (passed 在前)
  let match = output.match(/Tests?:\s*(\d+)\s*(?:passed|passing).*?(\d+)\s*(?:failed|failing)/i);
  if (match) {
    return { passed: parseInt(match[1]!, 10), failed: parseInt(match[2]!, 10) };
  }

  // 模式 2: "Tests: N failed/failing ... M passed/passing" (failed 在前)
  match = output.match(/Tests?:\s*(\d+)\s*(?:failed|failing).*?(\d+)\s*(?:passed|passing)/i);
  if (match) {
    return { failed: parseInt(match[1]!, 10), passed: parseInt(match[2]!, 10) };
  }

  // Pytest: "3 passed, 1 failed"
  match = output.match(/(\d+)\s*passed.*?(\d+)\s*failed/i);
  if (match) {
    return { passed: parseInt(match[1]!, 10), failed: parseInt(match[2]!, 10) };
  }
  // Cargo: "test result: ok. 5 passed; 1 failed"
  match = output.match(/test result:.*?(\d+)\s*passed.*?(\d+)\s*failed/i);
  if (match) {
    return { passed: parseInt(match[1]!, 10), failed: parseInt(match[2]!, 10) };
  }
  return null;
}
