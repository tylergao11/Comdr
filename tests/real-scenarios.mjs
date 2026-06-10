/**
 * 真实场景测试用例
 *
 * 前置条件: pnpm build && pnpm build:tools
 * 用法:      node tests/real-scenarios.mjs
 *
 * 覆盖 5 个典型场景：
 *   1. 聊天       — 零工具、低 token
 *   2. 读文件     — file_read 命中、读取成功
 *   3. 搜索代码   — file_grep 命中、搜索成功
 *   4. 改文件     — file_read + file_edit 命中
 *   5. 跑命令     — shell_bash 命中、执行成功
 */

import { createEngine } from '@comdr/engine';
import { DeepSeekClient } from '@comdr/llm';
import { loadConfig, AGENT_EVENT } from '@comdr/core';

const config = loadConfig(process.cwd());
const llm = new DeepSeekClient(config.llm);

// ── 加载 NativeTools ──
let tools = null;
let toolsOk = false;
try {
  const { createNativeTools } = await import('@comdr/tools');
  tools = createNativeTools(config.project.projectPath);
  toolsOk = true;
} catch {
  console.log('⚠ NativeTools 不可用 (pnpm build:tools 未执行)，仅测检索+Token\n');
}

// ============================================================================
// 工具函数
// ============================================================================

function hr(label) {
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`  ${label}`);
  console.log(`${'═'.repeat(55)}`);
}

async function run(input) {
  console.log(`  输入: ${input}`);
  const engine = createEngine(llm, config, tools);
  let textOut = '';
  const toolCalls = [];
  let tokens = 0, turns = 0;

  for await (const event of engine.run(input, 'agent')) {
    switch (event.type) {
      case AGENT_EVENT.TEXT_DELTA:
        process.stdout.write(event.content);
        textOut += event.content;
        break;
      case AGENT_EVENT.TOOL_CALL:
        toolCalls.push(event.call.function.name);
        process.stdout.write(`\n  ⏳ ${event.call.function.name}`);
        break;
      case AGENT_EVENT.TOOL_RESULT:
        process.stdout.write(event.result.ok ? ' ✓' : ' ✗');
        break;
      case AGENT_EVENT.PROGRESS_WARNING:
        console.log(`\n  ⚠ ${event.message}`);
        break;
      case AGENT_EVENT.DONE:
        tokens = event.result.tokensUsed;
        turns = event.result.turns;
        break;
      case AGENT_EVENT.ERROR:
        if (!event.recoverable) console.log(`\n  ✗ ${event.message}`);
        break;
    }
  }
  console.log('');
  return { tokens, turns, toolCalls, textOut };
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  console.log(`Comdr 真实场景测试  ·  ${config.llm.model}  ·  ${config.agent.tokenBudget / 1000}K\n`);

  const results = [];

  // ─── 1. 聊天 ───
  hr('1/5  聊天');
  const r1 = await run('你好');
  results.push({ label: '聊天', ...r1 });
  console.log(`  ${r1.tokens} tokens | ${r1.turns} turns | ${r1.toolCalls.length === 0 ? '✓ 零工具' : '⚠ 带工具:' + r1.toolCalls.join(',')}`);

  // ─── 2. 读文件 ───
  hr('2/5  读文件');
  const r2 = await run('读一下 README.md 前 3 行，告诉我项目是什么');
  results.push({ label: '读文件', ...r2 });
  console.log(`  ${r2.tokens} tokens | ${r2.turns} turns | 工具: [${r2.toolCalls.join(',')}]`);

  // ─── 3. 搜索 ───
  hr('3/5  搜索代码');
  const r3 = await run('搜索一下项目里哪里定义了 AGENT_EVENT 常量');
  results.push({ label: '搜索', ...r3 });
  console.log(`  ${r3.tokens} tokens | ${r3.turns} turns | 工具: [${r3.toolCalls.join(',')}]`);

  // ─── 4. 改文件 ───
  hr('4/5  改文件');
  const r4 = await run('读一下 packages/engine/src/planner.ts 的第 45-50 行，给 query 模式的 triggers 数组追加一个 "帮助"');
  results.push({ label: '改文件', ...r4 });
  console.log(`  ${r4.tokens} tokens | ${r4.turns} turns | 工具: [${r4.toolCalls.join(',')}]`);

  // ─── 5. 跑命令 ───
  hr('5/5  跑命令');
  const r5 = await run('运行 pnpm typecheck 看看有没有编译错误');
  results.push({ label: '跑命令', ...r5 });
  console.log(`  ${r5.tokens} tokens | ${r5.turns} turns | 工具: [${r5.toolCalls.join(',')}]`);

  // ─── 汇总 ───
  hr('汇总');
  let total = 0;
  for (const r of results) {
    const icon = r.toolCalls.length === 0 ? '💬' : '🔧';
    console.log(`  ${icon} ${r.label.padEnd(8)} ${String(r.tokens).padStart(6)} tk  ${String(r.turns).padStart(1)}t  [${r.toolCalls.join(',') || '无工具'}]`);
    total += r.tokens;
  }
  console.log(`  ${'─'.repeat(42)}`);
  console.log(`  合计 ${total} tokens  ·  均价 ${Math.round(total / results.length)} tokens/次`);
  console.log(`  目标: 聊天<5K, 工具场景<12K, 均价<10K`);
}

main().catch(e => {
  console.error('失败:', e.message);
  process.exit(1);
});
