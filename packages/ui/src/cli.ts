/**
 * cli.ts — Comdr CLI 入口
 *
 * 用法:
 *   comdr                    交互模式（TUI）
 *   comdr exec "需求"        全自动模式
 *   comdr plan "需求"        只读分析模式
 *
 * @agent Agent 5 — CLI 入口
 */
import { startTUI, streamToCLI } from './tui/index.js';
import { createEngine } from '@comdr/engine';
import { DeepSeekClient } from '@comdr/llm';
import { createNativeTools } from '@comdr/tools';
import { loadConfig, RUN_MODE, MODEL_ROLE } from '@comdr/core';
import type { IEngine, RunMode } from '@comdr/core';

// ============================================================================
// 解析命令行参数
// ============================================================================

const args = process.argv.slice(2);

interface ParsedArgs {
  mode: RunMode;
  prompt: string;
}

function parseArgs(): ParsedArgs {
  if (args.length === 0) {
    return { mode: 'agent', prompt: '' };
  }

  const cmd = args[0]!;
  const rest = args.slice(1).join(' ');

  switch (cmd) {
    case 'exec':
      return { mode: 'yolo', prompt: rest };
    case 'plan':
      return { mode: 'plan', prompt: rest };
    case 'interactive':
    case 'agent':
      return { mode: 'agent', prompt: rest };
    default:
      return { mode: 'agent', prompt: args.join(' ') };
  }
}

// ============================================================================
// 获取引擎
// ============================================================================

function getEngine(): IEngine {
  // 尝试真实引擎（需要 COMDR_API_KEY 或 .comdr.toml）
  try {
    const config = loadConfig(process.cwd());
    const llm = new DeepSeekClient(config.llm);
    const tools = createNativeTools(config.project.projectPath);

    // ★ 压缩/摘要/反思默认走 flash（便宜 10x，任务不需要重型推理）
    const flashModel = config.project.contextModel || MODEL_ROLE.CONTEXT;
    const contextLLM = new DeepSeekClient({ ...config.llm, model: flashModel });
    process.stderr.write(`[comdr] 真实引擎就绪 · ${config.llm.model} · context: ${flashModel} · ${config.agent.tokenBudget / 1000}K budget\n`);
    return createEngine(llm, config, tools, undefined, contextLLM);
  } catch (err) {
    // ★ 配置错误 → 直接退出，不降级到 MockEngine
    process.stderr.write(
      `[comdr] 启动失败: ${(err as Error).message}\n` +
      '[comdr] 配置方式: 创建 .comdr.toml 或设置 COMDR_API_KEY 环境变量\n' +
      '[comdr] 开发/演示用途可显式使用: comdr exec --mock "需求"\n',
    );
    process.exit(1);
  }
}

// ============================================================================
// 主入口
// ============================================================================

async function main(): Promise<void> {
  const { mode, prompt } = parseArgs();
  const engine = getEngine();

  if (mode === RUN_MODE.AGENT && !prompt) {
    // 交互模式：启动 TUI
    startTUI({ engine, mode });
  } else if (prompt) {
    // 非交互模式：流式输出到 stdout
    const result = await streamToCLI(engine, prompt, mode);
    process.exit(result.ok ? 0 : 1);
  }
}

main().catch((err) => {
  console.error('comdr: fatal error:', err);
  process.exit(2);
});
