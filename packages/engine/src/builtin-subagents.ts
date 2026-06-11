/**
 * builtin-subagents.ts — 内置子智能体注册
 *
 * ★ Engine 构造后调用 registerBuiltinSubAgents(engine) 一键注册所有内置子 agent。
 *   每个子 agent 通过 createSubAgent() 工厂创建，实现 ISubAgent 契约。
 *
 * 设计:
 *   - Engine 本身不依赖子 agent 包——由入口点 (CLI/VS Code) 决定注册哪些
 *   - 新增子 agent：加一行 register + 导出一行 createSubAgent
 *   - 子 agent 加载失败 → 静默降级，不阻塞主引擎
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { IEngine } from '@comdr/core/contracts';
import type { ISubAgent } from '@comdr/core/contracts';

// ============================================================================
// §1 注册入口
// ============================================================================

/**
 * ★ 注册所有内置子智能体到 Engine。
 * CLI 和 VS Code 入口点在 createEngine() 后调用。
 *
 * 子 agent 加载失败时静默降级——打 stderr 日志但不抛异常。
 */
export async function registerBuiltinSubAgents(engine: IEngine): Promise<void> {
  const results = await Promise.allSettled([
    registerAudit(engine),
    registerCocosEngine(engine),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') {
      process.stderr.write(`[comdr] sub-agent registration failed: ${String(result.reason)}\n`);
    }
  }
}

// ============================================================================
// §2 各子 agent 注册
// ============================================================================

async function registerAudit(engine: IEngine): Promise<void> {
  try {
    const { createSubAgent, createComdrToolExecutor } = await import('@comdr/audit');
    const toolExecutor = createComdrToolExecutor(
      (name: string, args: Record<string, unknown>) =>
        (engine as any).callTool(name, args),
    );
    const agent: ISubAgent = createSubAgent({
      projectRoot: (engine as any).projectRoot || process.cwd(),
      toolExecutor,
      llmClient: (engine as any).llm ?? undefined,
    });
    engine.registerSubAgent(agent);
    process.stderr.write(`[comdr] sub-agent registered: ${agent.manifest.name} v${agent.manifest.version}\n`);
  } catch (err) {
    process.stderr.write(`[comdr] audit sub-agent unavailable: ${(err as Error).message}\n`);
  }
}

async function registerCocosEngine(engine: IEngine): Promise<void> {
  try {
    const { createSubAgent } = await import('@comdr/cocos-engine');
    const agent: ISubAgent = createSubAgent({
      projectRoot: (engine as any).projectRoot || process.cwd(),
    });
    engine.registerSubAgent(agent);
    process.stderr.write(`[comdr] sub-agent registered: ${agent.manifest.name} v${agent.manifest.version}\n`);
  } catch (err) {
    process.stderr.write(`[comdr] cocos-engine sub-agent unavailable: ${(err as Error).message}\n`);
  }
}
