/**
 * builtin-subagents.ts — 内置子智能体注册
 */

import type { IEngine } from '@comdr/core/contracts';
import type { ISubAgent } from '@comdr/core/contracts';

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
