/**
 * cli.ts — Comdr CLI 入口
 *
 * 用法:
 *   comdr exec "需求"        全自动模式
 *   comdr plan "需求"        只读分析模式
 *   comdr "需求"             默认 = exec
 *   comdr                    显示帮助
 *
 * @agent Agent 5 — CLI 入口
 */

import { createEngine, registerBuiltinSubAgents } from '@comdr/engine';
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
  isHelp: boolean;
}

function parseArgs(): ParsedArgs {
  if (args.length === 0) {
    return { mode: 'yolo', prompt: '', isHelp: true };
  }

  const cmd = args[0]!;
  const rest = args.slice(1).join(' ');

  switch (cmd) {
    case 'exec':
      return { mode: 'yolo', prompt: rest, isHelp: rest.length === 0 };
    case 'plan':
      return { mode: 'plan', prompt: rest, isHelp: rest.length === 0 };
    case '--help':
    case '-h':
      return { mode: 'yolo', prompt: '', isHelp: true };
    case 'mcp-server':
      return { mode: 'yolo', prompt: '', isHelp: false };
    default:
      return { mode: 'yolo', prompt: args.join(' '), isHelp: false };
  }
}

function showHelp(): void {
  process.stderr.write([
    'Comdr — 通用 coding agent',
    '',
    '用法:',
    '  comdr exec "需求"    全自动执行',
    '  comdr plan "需求"    只读分析',
    '  comdr "需求"         默认 = exec',
    '  comdr mcp-server     启动 MCP JSON-RPC 端点',
    '  comdr session list   列出会话',
    '  comdr session resume 恢复会话',
    '  comdr session delete 删除会话',
    '',
    '配置文件: ~/.comdr/config.toml 或 COMDR_API_KEY 环境变量',
    '',
  ].join('\n'));
}

// ============================================================================
// 获取引擎
// ============================================================================

function getEngine(): IEngine {
  try {
    const config = loadConfig(process.cwd());
    const llm = new DeepSeekClient(config.llm);
    const tools = createNativeTools(config.project.projectPath);

    // 压缩/摘要/反思默认走 flash（便宜 10x，任务不需要重型推理）
    const flashModel = config.project.contextModel || MODEL_ROLE.CONTEXT;
    const contextLLM = new DeepSeekClient({ ...config.llm, model: flashModel });
    process.stderr.write(`[comdr] 真实引擎就绪 · ${config.llm.model} · context: ${flashModel} · ${config.agent.tokenBudget / 1000}K budget\n`);
    return createEngine(llm, config, tools, undefined, contextLLM);
  } catch (err) {
    process.stderr.write(
      `[comdr] 启动失败: ${(err as Error).message}\n` +
      '[comdr] 配置方式: 创建 ~/.comdr/config.toml 或设置 COMDR_API_KEY 环境变量\n',
    );
    process.exit(1);
  }
}

// ============================================================================
// CLI 流式输出（从原 TUI 模块迁移的最小流式输出）
// ============================================================================

async function streamToCLI(
  engine: IEngine,
  prompt: string,
  mode: RunMode,
): Promise<{ ok: boolean }> {
  let ok = true;
  let toolCount = 0;
  let textOutput = '';

  try {
    for await (const event of engine.run(prompt, mode)) {
      switch (event.type) {
        case 'text_delta': {
          const text = (event as any).text ?? (event as any).delta ?? '';
          if (text) {
            process.stdout.write(text);
            textOutput += text;
          }
          break;
        }
        case 'tool_call': {
          const tc = event as any;
          toolCount++;
          process.stderr.write(`\n🔧 ${tc.name || tc.toolName || ''}\n`);
          break;
        }
        case 'tool_result': {
          const tr = event as any;
          const icon = tr.ok ? '✅' : '❌';
          const detail = tr.errorCategory ? ` [${tr.errorCategory}]` : '';
          process.stderr.write(`${icon}${detail}\n`);
          if (tr.diffSummary) {
            process.stderr.write(`${tr.diffSummary}\n`);
          }
          if (!tr.ok) ok = false;
          break;
        }
        case 'token_usage': {
          const tu = event as any;
          process.stderr.write(
            `📊 tokens: ${tu.used ?? '?'}/${tu.total ?? '?'} · cache: ${tu.cacheHitRate ?? '?'}%\n`,
          );
          break;
        }
        case 'progress_warning': {
          process.stderr.write(`⚠️  ${(event as any).message}\n`);
          break;
        }
        case 'done': {
          break;
        }
      }
    }

    if (textOutput && !textOutput.endsWith('\n')) {
      process.stdout.write('\n');
    }
  } catch (err) {
    process.stderr.write(`[comdr] 执行失败: ${(err as Error).message}\n`);
    ok = false;
  }

  return { ok };
}

// ============================================================================
// 主入口
// ============================================================================

async function main(): Promise<void> {
  const { mode, prompt, isHelp } = parseArgs();

  if (isHelp) {
    showHelp();
    process.exit(0);
  }

  // mcp-server 委托
  if (args[0] === 'mcp-server') {
    const engine = getEngine();
    const { startMCPServer } = await import('./mcp-server.js');
    startMCPServer({ engine });
    return;
  }

  // session 管理
  if (args[0] === 'session') {
    const cmd = args[1];
    const sessionId = args[2];
    if (cmd === 'list') {
      process.stdout.write('Sessions: (持久化待实现)\n');
    } else if (cmd === 'resume' && sessionId) {
      process.stdout.write(`Resuming session ${sessionId}...\n`);
    } else if (cmd === 'delete' && sessionId) {
      process.stdout.write(`Deleting session ${sessionId}...\n`);
    } else {
      process.stdout.write('用法: comdr session list|resume|delete [id]\n');
    }
    process.exit(0);
  }

  if (!prompt) {
    process.stderr.write('[comdr] 请提供 prompt，例如: comdr exec "重构 auth"\n');
    process.exit(1);
  }

  const engine = getEngine();

  // 注册内置子智能体（audit 等）——加载失败静默降级
  await registerBuiltinSubAgents(engine);

  const result = await streamToCLI(engine, prompt, mode);
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('comdr: fatal error:', err);
  process.exit(2);
});
