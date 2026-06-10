/**
 * tools/execute.ts — TS 层工具执行分发
 *
 * 处理 5 个高层语义工具的运行时执行。
 * 每个工具复用已有的 Memory/Index/Retrieval 基础设施。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ToolCall, ToolResult } from '@comdr/core/types';
import type { EpisodicMemory } from '../memory/episodic.js';
import type { SemanticMemory } from '../memory/semantic.js';
import type { ToolRetriever } from '../tool-retriever.js';
import type { INativeTools } from '@comdr/core/contracts';
import { safeParseArgs } from '../utils.js';
import { BM25Scorer, tokenize, contextualPrefix } from '../retrieval.js';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

// ============================================================================
// §1 执行上下文
// ============================================================================

import type { Engine } from '../loop.js';

export interface ToolExecContext {
  projectPath: string;
  episodicMemory: EpisodicMemory;
  semanticMemory: SemanticMemory;
  toolRetriever: ToolRetriever;
  nativeTools: INativeTools | null;
  /** ★ Engine 实例——task_spawn 需要用于 fork 子 Agent */
  engine: Engine;
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
  'file_search',
  'memory_recall',
  'symbol_find',
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
      case 'tool_search':
        return { ...base, ...execToolSearch(String(args.query ?? ''), ctx) };
      case 'file_search':
        return { ...base, ...execFileSearch(
          String(args.query ?? ''),
          typeof args.topK === 'number' ? args.topK : 5,
          ctx,
        ) };
      case 'memory_recall':
        return { ...base, ...execMemoryRecall(String(args.query ?? ''), ctx) };
      case 'symbol_find':
        return { ...base, ...execSymbolFind(String(args.name ?? ''), ctx) };
      case 'task_spawn':
        return { ...base, ...(await execTaskSpawn(
          String(args.prompt ?? ''),
          typeof args.mode === 'string' ? args.mode : 'plan',
          ctx,
        )) };
      case 'shell_test':
        return { ...base, ...execShellTest(
          typeof args.path === 'string' ? args.path : undefined,
          typeof args.filter === 'string' ? args.filter : undefined,
          ctx,
        ) };
      default:
        return {
          ...base,
          ok: false,
          content: `Unknown advanced tool: ${call.function.name}`,
          errorCategory: 'execution_error',
        };
    }
  } catch (err) {
    return {
      ...base,
      ok: false,
      content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
      errorCategory: 'execution_error',
    };
  }
}

// ============================================================================
// §3 各工具实现
// ============================================================================

/** 1. tool_search — BM25 检索工具描述 */
/** Helper: return only ok+content (base fields filled by caller) */
type ExecResult = { ok: boolean; content: string };

function execToolSearch(
  query: string,
  ctx: ToolExecContext,
): ExecResult {
  if (!query.trim()) {
    return { ok: true, content: 'No query provided.' };
  }
  const results = ctx.toolRetriever.retrieve(query, 5);
  if (results.length === 0) {
    return { ok: true, content: 'No matching tools found.' };
  }
  return {
    ok: true,
    content: results.map((name) => `- ${name}`).join('\n'),
  };
}

/** 2. file_search — BM25 对文件内容建索引 + 检索 */
function execFileSearch(
  query: string,
  topK: number,
  ctx: ToolExecContext,
): ExecResult {
  const q = query.trim();
  if (!q) return { ok: true, content: 'No query provided.' };

  const files = scanProjectFiles(ctx.projectPath, 200);
  if (files.length === 0) {
    return { ok: true, content: 'No files found to search.' };
  }

  const bm25 = new BM25Scorer();
  const docTokens: Map<string, number>[] = [];
  const docPaths: string[] = [];

  for (const file of files.slice(0, 100)) {
    try {
      const text = readFileSync(file, 'utf-8').slice(0, 8000);
      const tokens = tokenize(text);
      bm25.addDocument(tokens);
      docTokens.push(tokens);
      docPaths.push(file);
    } catch {
      // 跳过不可读文件
    }
  }

  if (docPaths.length === 0) {
    return { ok: true, content: 'No readable files found.' };
  }

  const queryTokens = tokenize(q);
  const scored = docPaths
    .map((path, i) => ({
      path,
      score: bm25.score(queryTokens, docTokens[i]!),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (scored.length === 0) {
    return { ok: true, content: 'No matching files found.' };
  }

  const lines = scored.map((s, idx) => {
    const prefix = contextualPrefix(
      `score=${s.score.toFixed(2)}`,
      { source: s.path },
    );
    return `${idx + 1}. ${prefix}`;
  });

  return { ok: true, content: `Found ${scored.length} matching file(s):\n${lines.join('\n')}` };
}

/** 3. memory_recall — EpisodicMemory 检索 */
function execMemoryRecall(
  query: string,
  ctx: ToolExecContext,
): ExecResult {
  const q = query.trim();
  if (!q) return { ok: true, content: 'No query provided.' };

  const results = ctx.episodicMemory.retrieve(q, 5);
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

/** 5. shell_test — 通过 NativeTools 执行测试 */
function execShellTest(
  testPath: string | undefined,
  filter: string | undefined,
  ctx: ToolExecContext,
): ExecResult {
  if (!ctx.nativeTools) {
    return {
      ok: false,
      content: 'Native tools not available (pnpm build:tools not run). Error: execution_error',
    };
  }

  // 通过 shell_bash 执行测试，解析输出为结构化数据
  const testRunner = detectTestRunner(ctx.projectPath);
  const cmd = buildTestCommand(testRunner, testPath, filter);

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
): Promise<{ ok: boolean; content: string }> {
  const p = prompt.trim();
  if (!p) return { ok: false, content: 'task_spawn requires a prompt.' };

  const validModes = ['agent', 'plan', 'yolo'];
  const subMode = validModes.includes(mode) ? (mode as 'agent' | 'plan' | 'yolo') : 'plan';

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

/** 根据测试运行器构建测试命令 */
function buildTestCommand(runner: string, testPath?: string, filter?: string): string {
  const path = testPath ?? '';
  switch (runner) {
    case 'vitest': return filter ? `npx vitest run ${path} -t "${filter}"` : `npx vitest run ${path}`;
    case 'jest': return filter ? `npx jest ${path} -t "${filter}"` : `npx jest ${path}`;
    case 'cargo': return filter ? `cargo test ${filter}` : 'cargo test';
    case 'pytest': return filter ? `python -m pytest ${path} -k "${filter}"` : `python -m pytest ${path}`;
    case 'go': return filter ? `go test ${path} -run "${filter}"` : `go test ${path} ./...`;
    default: return filter ? `npm test -- ${path} --grep "${filter}"` : `npm test ${path}`;
  }
}

/** 从测试输出中解析 passed/failed 计数 */
function parseTestOutput(
  output: string,
  _runner: string,
): { passed: number; failed: number } | null {
  // Vitest/Jest: "Tests: 5 passed, 2 failed, 7 total"
  const vitestMatch = output.match(/Tests?:\s*(\d+)\s*(?:passed|passing).*?(\d+)\s*(?:failed|failing)/i);
  if (vitestMatch) {
    return { passed: parseInt(vitestMatch[1]!, 10), failed: parseInt(vitestMatch[2]!, 10) };
  }
  // Pytest: "3 passed, 1 failed"
  const pytestMatch = output.match(/(\d+)\s*passed.*?(\d+)\s*failed/i);
  if (pytestMatch) {
    return { passed: parseInt(pytestMatch[1]!, 10), failed: parseInt(pytestMatch[2]!, 10) };
  }
  // Cargo: "test result: ok. 5 passed; 1 failed"
  const cargoMatch = output.match(/test result:.*?(\d+)\s*passed.*?(\d+)\s*failed/i);
  if (cargoMatch) {
    return { passed: parseInt(cargoMatch[1]!, 10), failed: parseInt(cargoMatch[2]!, 10) };
  }
  return null;
}
