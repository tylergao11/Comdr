/**
 * index.ts — TUI 公开 API
 *
 * @agent Agent 5 — TUI 渲染器
 */

import { render } from 'ink';
import React from 'react';
import type { IEngine, RunMode, RunResult } from '@comdr/core';
import { AGENT_EVENT } from '@comdr/core';
import { App } from './app.js';
import { toolDisplayName, formatTokens } from './utils.js';

// ============================================================================
// startTUI — 启动交互式 TUI
// ============================================================================

interface StartTUIOptions {
  engine: IEngine;
  mode: RunMode;
  initialInput?: string;
}

export function startTUI(opts: StartTUIOptions): ReturnType<typeof render> {
  const { engine, mode, initialInput } = opts;

  // stdin 适配——非 TTY 环境（VS Code 终端等）补上 setRawMode
  const stdin = process.stdin as typeof process.stdin & { setRawMode?(mode: boolean): void };
  if (!stdin.setRawMode) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stdin as unknown as Record<string, unknown>).setRawMode = (_mode: boolean) => stdin;
    (stdin as unknown as Record<string, unknown>).isTTY = true;
  }

  const instance = render(React.createElement(App, { engine, mode, initialInput }), {
    stdin,
    exitOnCtrlC: true,
    patchConsole: false,
  });

  return instance;
}

// ============================================================================
// streamToCLI — 非交互流式输出
// ============================================================================

export async function streamToCLI(
  engine: IEngine,
  input: string,
  mode: RunMode,
): Promise<RunResult> {
  let result: RunResult = { ok: true, turns: 0, tokensUsed: 0, summary: '', sessionId: '' };
  for await (const event of engine.run(input, mode)) {
    switch (event.type) {
      case AGENT_EVENT.TEXT_DELTA:
        process.stdout.write(event.content);
        break;
      case AGENT_EVENT.THINKING_DELTA:
        break;
      case AGENT_EVENT.TOOL_CALL:
        console.log(`\n⏳ ${toolDisplayName(event.call.function.name)}`);
        break;
      case AGENT_EVENT.TOOL_RESULT: {
        const ok = event.result.ok;
        console.log(`  ${ok ? '✓' : '✗'} ${event.result.toolName}${event.result.diffSummary ? ': ' + event.result.diffSummary : ''}`);
        if (!ok && event.result.content) {
          const detail = event.result.content.length > 120
            ? event.result.content.slice(0, 120) + '…'
            : event.result.content;
          console.log(`    ${detail}`);
        }
        break;
      }
      case AGENT_EVENT.PROGRESS_WARNING:
        console.log(`\n⚠ ${event.message}`);
        break;
      case AGENT_EVENT.DONE:
        console.log(`\n✓ Done — ${event.result.turns} turns, ${formatTokens(event.result.tokensUsed)} tokens`);
        result = {
          ok: true,
          turns: event.result.turns,
          tokensUsed: event.result.tokensUsed,
          summary: event.result.summary,
          sessionId: '',
        };
        break;
      case AGENT_EVENT.ERROR:
        console.error(`\n✗ ${event.code}: ${event.message}`);
        result = { ok: false, turns: 0, tokensUsed: 0, summary: `${event.code}: ${event.message}`, sessionId: '' };
        break;
    }
  }
  return result;
}

export { RUN_MODE } from '@comdr/core';
