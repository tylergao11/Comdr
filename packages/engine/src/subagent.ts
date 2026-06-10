/**
 * subagent.ts — 确定性子 Agent 编排
 *
 * 来源: Whale workflown (2026) — deterministic fan-out pattern.
 *       AutoGen group chat (2023) — structured output via schema.
 *       "More Agents Is All You Need" (2024) — sampling-and-voting.
 *
 * 三个原语:
 *   runSubAgent(prompt, engine, opts) → Promise<SubAgentResult>
 *   fanOut(prompts, engine, opts)      → Promise<SubAgentResult[]>
 *   pipeline(items, stages, engine)    → Promise<SubAgentResult[][]>
 *
 * 每个子 Agent = 独立 Engine 实例 + 隔离 SessionState。
 * 共享: LLM client, tools, episodic memory, config。
 * 隔离: working memory, progress, reasoning cache, session。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { RunResult, JSONSchema } from '@comdr/core/types';
import { AGENT_EVENT } from '@comdr/core';
import type { IDeepSeekClient, INativeTools, IEventLogger } from '@comdr/core/contracts';
import type { AgentConfig } from '@comdr/core/types';
import { Engine } from './loop.js';

// ============================================================================
// §1 类型
// ============================================================================

export interface SubAgentOpts {
  /** 运行模式: agent(逐步) | plan(只读) | yolo(全自动) */
  mode?: 'agent' | 'plan' | 'yolo';
  /** 强制结构化输出——Agent 必须返回符合此 schema 的 JSON */
  schema?: JSONSchema;
  /** 子 Agent 的 token 预算上限 */
  tokenBudget?: number;
  /** 子 Agent 描述标签（用于日志） */
  label?: string;
}

export interface SubAgentResult {
  ok: boolean;
  /** 子 Agent 的最终文本输出 */
  summary: string;
  /** 结构化输出（若提供 schema） */
  structured?: unknown;
  /** 消耗的 token */
  tokensUsed: number;
  /** 执行轮数 */
  turns: number;
  /** 使用过的工具调用 */
  toolCalls: string[];
  /** 标签 */
  label?: string;
}

// ============================================================================
// §2 runSubAgent — 单实例
// ============================================================================

/**
 * 启动一个独立的子 Agent 执行指定任务。
 *
 * @param prompt  子任务描述（如 "审查 src/auth.ts 的安全性"）
 * @param engine  主 Engine 实例（用于共享 LLM + tools + config）
 * @param opts    可选配置
 */
export async function runSubAgent(
  prompt: string,
  engine: Engine,
  opts: SubAgentOpts = {},
): Promise<SubAgentResult> {
  const mode = opts.mode ?? 'agent';
  const label = opts.label ?? `sub-${prompt.slice(0, 30)}`;

  // ★ 创建独立 Engine 实例（共享 LLM + tools + logger + config）
  const contextLLM = (engine as any).contextLLM as IDeepSeekClient | undefined;
  const sub = new Engine(
    (engine as any).llm as IDeepSeekClient,
    (engine as any).config as AgentConfig,
    (engine as any).tools as INativeTools | null,
    (engine as any).logger as IEventLogger | null,
    contextLLM,  // ★ 子 Agent 继承主 Engine 的 flash 模型
  );

  const toolCalls: string[] = [];
  let done: RunResult | null = null;

  try {
    for await (const event of sub.run(prompt, mode)) {
      if (event.type === AGENT_EVENT.TOOL_CALL) {
        toolCalls.push(event.call.function.name);
      }
      if (event.type === AGENT_EVENT.DONE) {
        done = event.result;
      }
    }
  } catch (err) {
    return {
      ok: false,
      summary: `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`,
      tokensUsed: 0,
      turns: 0,
      toolCalls,
      label,
    };
  }

  if (!done) {
    return { ok: false, summary: 'Sub-agent returned no result', tokensUsed: 0, turns: 0, toolCalls, label };
  }

  // ★ Structured output
  let structured: unknown = undefined;
  if (opts.schema && done.summary) {
    try {
      const parsed = JSON.parse(done.summary);
      structured = parsed;
    } catch {
      // 非 JSON 输出 → structured 保持 undefined
    }
  }

  return {
    ok: done.ok,
    summary: done.summary,
    structured,
    tokensUsed: done.tokensUsed,
    turns: done.turns,
    toolCalls,
    label,
  };
}

// ============================================================================
// §3 fanOut — 并行
// ============================================================================

/**
 * 并行启动 N 个子 Agent，全部完成后返回结果数组。
 *
 * ★ Barrier 模式 — 等待最慢的一个。适合需要所有结果做综合判断的场景。
 *
 * @param prompts  子任务描述列表
 * @param engine   主 Engine 实例
 * @param opts     可选配置（所有子 Agent 共用）
 */
export async function fanOut(
  prompts: string[],
  engine: Engine,
  opts: SubAgentOpts = {},
): Promise<SubAgentResult[]> {
  const tasks = prompts.map((p, i) =>
    runSubAgent(p, engine, { ...opts, label: opts.label ?? `fan-${i + 1}` }),
  );
  return Promise.all(tasks);
}

// ============================================================================
// §4 pipeline — 流水线
// ============================================================================

/**
 * 流水线处理——每项流经多个阶段，阶段间无 Barrier。
 *
 * Item A 可以在 Stage 3 时 Item B 还在 Stage 1。
 * 每个阶段收到上一阶段的结果 + 原始 item。
 *
 * @param items    待处理的数据列表
 * @param stages   阶段函数——每个接收 (prevResult, originalItem, index)
 * @param engine   主 Engine 实例
 * @param opts     可选配置
 */
export async function pipeline<T>(
  items: T[],
  stages: Array<(prevResult: SubAgentResult | null, item: T, index: number) => string | Promise<string>>,
  engine: Engine,
  opts: SubAgentOpts = {},
): Promise<SubAgentResult[][]> {
  const results: SubAgentResult[][] = items.map(() => []);

  // Stage 1: 对每个 item 并行
  let prevResults: SubAgentResult[] = await Promise.all(
    items.map((item, i) => {
      const prompt = stages[0]!(null, item, i);
      return typeof prompt === 'string'
        ? runSubAgent(prompt, engine, { ...opts, label: `${opts.label ?? 'pipe'}-s1-${i + 1}` })
        : Promise.resolve(prompt).then(p => runSubAgent(p, engine, { ...opts, label: `${opts.label ?? 'pipe'}-s1-${i + 1}` }));
    }),
  );
  for (let i = 0; i < items.length; i++) {
    results[i]!.push(prevResults[i]!);
  }

  // Stage 2+: 逐阶段处理
  for (let s = 1; s < stages.length; s++) {
    const stageFn = stages[s]!;
    const stageResults = await Promise.all(
      items.map(async (item, i) => {
        const prev = results[i]![results[i]!.length - 1] ?? null;
        const prompt = await stageFn(prev, item, i);
        return runSubAgent(prompt, engine, { ...opts, label: `${opts.label ?? 'pipe'}-s${s + 1}-${i + 1}` });
      }),
    );
    for (let i = 0; i < items.length; i++) {
      results[i]!.push(stageResults[i]!);
    }
  }

  return results;
}
