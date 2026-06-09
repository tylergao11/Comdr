/**
 * mock-engine.ts — Mock IEngine 实现
 *
 * 用于 Agent 5 独立开发和测试。生成仿真事件序列，
 * 覆盖所有 AgentEvent 变体，使 TUI/MCP Server 可脱离真实 Engine 运行。
 *
 * @agent Agent 5 — 此文件仅用于开发/测试，不进生产构建
 */

import type {
  AgentEvent,
  IEngine,
  RunMode,
  RunResult,
  SessionState,
  TokenUsage,
} from '@comdr/core';
import { AGENT_EVENT, sleep } from '@comdr/core';

/** Mock 引擎专用错误码（仅开发/测试，不进生产） */
const MOCK_ERROR_CODE = {
  UNKNOWN_SCENARIO: 'MOCK_UNKNOWN_SCENARIO',
  ENGINE_CRASH: 'MOCK_ENGINE_CRASH',
} as const;

// ============================================================================
// 工具函数
// ============================================================================

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ============================================================================
// 场景数据
// ============================================================================

const SCENARIOS: Record<string, () => AsyncGenerator<AgentEvent>> = {
  /** 简单对话 */
  chat: async function* () {
    yield { type: AGENT_EVENT.THINKING_DELTA, content: '用户问了一个简单问题，直接回答即可。' };
    await sleep(200);
    const words = '你好！我是 Comdr。我可以帮你读代码、改文件、执行命令。有什么需要？'.split('');
    for (const c of words) {
      yield { type: AGENT_EVENT.TEXT_DELTA, content: c };
      await sleep(20);
    }
  },

  /** 文件编辑 */
  edit: async function* () {
    // 思考
    yield { type: AGENT_EVENT.THINKING_DELTA, content: '需要读取 src/auth.ts 了解当前实现。' };
    await sleep(300);
    yield { type: AGENT_EVENT.THINKING_DELTA, content: '然后添加 validateToken 函数。' };
    await sleep(200);

    // 工具调用 1: file_read
    yield {
      type: AGENT_EVENT.TOOL_CALL,
      call: {
        id: `call_${rid()}`,
        type: 'function',
        function: { name: 'file_read', arguments: '{"path":"src/auth.ts","offset":1,"limit":50}' },
      },
    };
    await sleep(400);
    yield {
      type: AGENT_EVENT.TOOL_RESULT,
      result: {
        callId: 'call_1',
        toolName: 'file_read',
        ok: true,
        content: '// auth.ts - 认证模块\nexport function login(u,p) { ... }\nexport function logout() { ... }',
        diffSummary: 'read 50 lines',
      },
    };

    // 工具调用 2: file_edit
    yield { type: AGENT_EVENT.THINKING_DELTA, content: '现在插入新函数。' };
    await sleep(200);
    yield {
      type: AGENT_EVENT.TOOL_CALL,
      call: {
        id: `call_${rid()}`,
        type: 'function',
        function: {
          name: 'file_edit',
          arguments: '{"path":"src/auth.ts","old_string":"export function logout()","new_string":"export function validateToken(t) { ... }\\n\\nexport function logout()"}',
        },
      },
    };
    await sleep(500);
    yield {
      type: AGENT_EVENT.TOOL_RESULT,
      result: {
        callId: 'call_2',
        toolName: 'file_edit',
        ok: true,
        content: 'Edited src/auth.ts',
        diffSummary: '+5/-0 lines',
        snapshotId: `snap_${rid()}`,
      },
    };

    // 文本输出
    const words = '已为 auth.ts 添加 validateToken 函数，修改了 5 行。'.split('');
    for (const c of words) {
      yield { type: AGENT_EVENT.TEXT_DELTA, content: c };
      await sleep(15);
    }
  },

  /** 工具失败 + 回滚 */
  failure: async function* () {
    yield { type: AGENT_EVENT.THINKING_DELTA, content: '尝试批量重构...' };
    await sleep(200);

    const callId = `call_${rid()}`;
    yield {
      type: AGENT_EVENT.TOOL_CALL,
      call: {
        id: callId,
        type: 'function',
        function: { name: 'file_edit', arguments: '{"path":"src/app.ts","old_string":"...","new_string":"..."}' },
      },
    };
    await sleep(600);
    yield {
      type: AGENT_EVENT.TOOL_RESULT,
      result: {
        callId,
        toolName: 'file_edit',
        ok: false,
        content: null,
        diffSummary: 'expected 3 changes, got 7',
        snapshotId: `snap_${rid()}`,
      },
    };

    await sleep(300);
    yield {
      type: AGENT_EVENT.THINKING_DELTA,
      content: 'DIFF_MISMATCH — 实际变更超出预期。自动回滚到快照，然后告知用户。',
    };
    await sleep(200);

    const words = '文件编辑失败：实际变更范围超出预期。已自动回滚。建议拆分为更小的修改步骤。'.split('');
    for (const c of words) {
      yield { type: AGENT_EVENT.TEXT_DELTA, content: c };
      await sleep(15);
    }
  },

  /** 停滞警告 */
  stall: async function* () {
    yield { type: AGENT_EVENT.THINKING_DELTA, content: '第一次尝试修复...' };
    await sleep(300);
    const callId = `call_${rid()}`;
    yield {
      type: AGENT_EVENT.TOOL_CALL,
      call: {
        id: callId,
        type: 'function',
        function: { name: 'shell_bash', arguments: '{"command":"pnpm test"}' },
      },
    };
    await sleep(400);
    yield {
      type: AGENT_EVENT.TOOL_RESULT,
      result: {
        callId,
        toolName: 'shell_bash',
        ok: false,
        content: '3/12 tests failed',
      },
    };
    await sleep(200);
    yield {
      type: AGENT_EVENT.PROGRESS_WARNING,
      message: '连续 2 轮零进展，检测到停滞。',
      stalledTurns: 2,
    };
  },

  /** ★ MCP 调用场景——展示跨 Agent 协作（使用真实 MCP 工具名格式 mcp__<server>__<tool>） */
  mcp: async function* () {
    const projectPath = '/cocos-project';

    yield {
      type: AGENT_EVENT.THINKING_DELTA,
      content: '用户需要生成资产和操作编辑器。已连接 comdr-art（AI 美术）和 comdr-engine（编辑器操作）。',
    };
    await sleep(200);

    // ★ MCP 调用 1: mcp__comdr-art__comdr-art（真实工具名格式）
    const mcp1Id = `call_${rid()}`;
    yield {
      type: AGENT_EVENT.TOOL_CALL,
      call: {
        id: mcp1Id,
        type: 'function',
        function: {
          name: 'mcp__comdr-art__comdr-art',
          arguments: JSON.stringify({
            request: '赛博朋克风格主菜单UI：暗色背景、霓虹Logo、开始/退出按钮',
            projectPath,
            style: 'cyberpunk',
          }),
        },
      },
    };
    await sleep(1200);
    yield {
      type: AGENT_EVENT.TOOL_RESULT,
      result: {
        callId: mcp1Id,
        toolName: 'mcp__comdr-art__comdr-art',
        ok: true,
        content:
          '[ok] 5/5 assets in 45.3s\n' +
          '[done] bg_main (background) → assets/comdr-art/backgrounds/bg_main.png score=8\n' +
          '[done] logo_title (logo) → assets/comdr-art/logos/logo_title.png score=7\n' +
          '\n' +
          '## 已注册资产（可用 comdr-engine-ask 引用）\n' +
          '- **bg_main** (background) — `db://assets/comdr-art/backgrounds/bg_main.png` — UUID: `a1b2c3d4-...`\n' +
          '- **logo_title** (logo) — `db://assets/comdr-art/logos/logo_title.png` — UUID: `e5f6a7b8-...`\n' +
          '\n' +
          '[session] art-abc123',
        diffSummary: 'bg_main.png (2.1MB) + logo_title.png (340KB)',
      },
    };

    // ★ MCP 调用 2: mcp__comdr-engine__comdr-engine-ask（真实工具名格式）
    yield {
      type: AGENT_EVENT.THINKING_DELTA,
      content: '资产已就位。装配到编辑器场景。',
    };
    await sleep(100);
    const mcp2Id = `call_${rid()}`;
    yield {
      type: AGENT_EVENT.TOOL_CALL,
      call: {
        id: mcp2Id,
        type: 'function',
        function: {
          name: 'mcp__comdr-engine__comdr-engine-ask',
          arguments: JSON.stringify({
            request: '把 bg_main 挂到 MainPanel 的 cc.Sprite.spriteFrame，logo_title 挂到标题节点',
            projectPath,
          }),
        },
      },
    };
    await sleep(600);
    yield {
      type: AGENT_EVENT.TOOL_RESULT,
      result: {
        callId: mcp2Id,
        toolName: 'mcp__comdr-engine__comdr-engine-ask',
        ok: true,
        content:
          '[ok] Completed in 3 rounds\n' +
          '[ver] gateway=1.0.0 bridge=3.8.2\n' +
          '[ok] >write: bg_main.png spriteFrame → MainPanel\n' +
          '[ok] >write: logo_title.png spriteFrame → TitleNode',
        diffSummary: 'MainPanel + TitleNode: spriteFrame 已挂载',
      },
    };

    const words = '主菜单已装配完成。赛博朋克风格背景 + 霓虹 Logo 已挂载到 MainScene。'.split('');
    for (const c of words) {
      yield { type: AGENT_EVENT.TEXT_DELTA, content: c };
      await sleep(15);
    }
  },

  /** 混合场景：使用所有事件类型 */
  full: async function* () {
    yield { type: AGENT_EVENT.THINKING_DELTA, content: '分析用户需求：创建 hello.ts。任务简单，直接执行。' };
    await sleep(150);

    yield {
      type: AGENT_EVENT.TOOL_CALL,
      call: {
        id: 'call_read',
        type: 'function',
        function: { name: 'file_glob', arguments: '{"pattern":"**/*.ts"}' },
      },
    };
    await sleep(300);
    yield {
      type: AGENT_EVENT.TOOL_RESULT,
      result: {
        callId: 'call_read',
        toolName: 'file_glob',
        ok: true,
        content: 'Found: src/cli.ts, packages/core/src/types.ts, ...',
        diffSummary: '12 .ts files found',
      },
    };

    yield { type: AGENT_EVENT.THINKING_DELTA, content: '项目已有 TypeScript 文件。在 src/ 下创建 hello.ts。' };
    await sleep(100);

    yield {
      type: AGENT_EVENT.TOOL_CALL,
      call: {
        id: 'call_write',
        type: 'function',
        function: {
          name: 'file_write',
          arguments: '{"path":"src/hello.ts","content":"console.log(\'Hello from Comdr!\');"}',
        },
      },
    };
    await sleep(350);
    yield {
      type: AGENT_EVENT.TOOL_RESULT,
      result: {
        callId: 'call_write',
        toolName: 'file_write',
        ok: true,
        content: 'Wrote src/hello.ts',
        diffSummary: '+1/-0 lines',
      },
    };

    yield { type: AGENT_EVENT.TEXT_DELTA, content: '已创建 ' };
    await sleep(50);
    yield { type: AGENT_EVENT.TEXT_DELTA, content: 'src/hello.ts。' };
    await sleep(50);
    yield { type: AGENT_EVENT.TEXT_DELTA, content: '文件内容为一行 console.log。' };
  },
};

// ============================================================================
// MockEngine 实现
// ============================================================================

/**
 * 开发用 Mock Engine
 *
 * 根据 userInput 关键词选择不同场景：
 *   - 包含 "edit"/"修改"/"改" → edit 场景
 *   - 包含 "fail"/"错误"/"失败" → failure 场景
 *   - 包含 "stall"/"test" → stall 场景
 *   - 包含 "full" → full 场景
 *   - 其他 → chat 场景
 */
export class MockEngine implements IEngine {
  private aborted = false;
  private sessionId: string;
  private _session: SessionState;

  constructor() {
    this.sessionId = `mock-${rid()}`;
    this._session = {
      id: this.sessionId,
      turn: 0,
      tokensUsed: 0,
      currentInput: '',
      outcome: null,
      messages: [],
      stateWindow: [
        { key: 'file:src/auth.ts', text: 'added validateToken()', turn: 1 },
        { key: 'file:src/app.ts', text: 'refactored main loop', turn: 2 },
      ],
      intentWindow: [
        { key: 'file:src/auth.ts', why: '添加 token 验证逻辑', turn: 1 },
        { key: 'file:src/app.ts', why: '简化主循环结构', turn: 2 },
      ],
      tempIdMappings: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async *run(
    userInput: string,
    _mode: RunMode,
    _sessionId?: string,
  ): AsyncGenerator<AgentEvent, RunResult, void> {
    this.aborted = false;
    let scenario: string;

    if (/mcp|外部|agent/i.test(userInput)) {
      scenario = 'mcp';
    } else if (/full/i.test(userInput)) {
      scenario = 'full';
    } else if (/edit|修改|改/i.test(userInput)) {
      scenario = 'edit';
    } else if (/fail|错误|失败/i.test(userInput)) {
      scenario = 'failure';
    } else if (/stall|test/i.test(userInput)) {
      scenario = 'stall';
    } else {
      scenario = 'chat';
    }

    const generator = SCENARIOS[scenario];
    if (!generator) {
      yield {
        type: AGENT_EVENT.ERROR,
        code: MOCK_ERROR_CODE.UNKNOWN_SCENARIO,
        message: `No scenario: ${scenario}`,
        recoverable: false,
      };
      return {
        ok: false,
        turns: 0,
        tokensUsed: 0,
        summary: `Unknown scenario: ${scenario}`,
        sessionId: this.sessionId,
      };
    }

    // ★ Emit lifecycle events
    yield {
      type: AGENT_EVENT.SESSION_STARTED,
      sessionId: this.sessionId,
      mode: _mode,
    };
    yield {
      type: AGENT_EVENT.MCP_STATUS,
      servers: [],
    };

    let turns = 0;
    let tokensUsed = 0;
    let turnTokens = 0;

    try {
      yield {
        type: AGENT_EVENT.TURN_BEGIN,
        turn: 1,
        tokensUsed: 0,
      };

      for await (const event of generator()) {
        if (this.aborted) break;
        yield event;
        if (event.type === AGENT_EVENT.TEXT_DELTA) {
          tokensUsed += event.content.length;
          turnTokens += event.content.length;
        }
        if (event.type === AGENT_EVENT.TOOL_RESULT) {
          turns++;
          tokensUsed += 200;
          turnTokens += 200;
          // Emit token_usage after each tool execution
          yield {
            type: AGENT_EVENT.TOKEN_USAGE,
            usage: {
              promptTokens: turnTokens,
              completionTokens: 0,
              reasoningTokens: 0,
              cacheHitTokens: 0,
              cacheMissTokens: 0,
            },
          };
        }
      }
    } catch (err) {
      yield {
        type: AGENT_EVENT.ERROR,
        code: MOCK_ERROR_CODE.ENGINE_CRASH,
        message: String(err),
        recoverable: false,
      };
      return {
        ok: false,
        turns,
        tokensUsed,
        summary: `Mock engine error: ${String(err)}`,
        sessionId: this.sessionId,
      };
    }

    // 如果被中断，不发送 done
    if (this.aborted) {
      return {
        ok: false,
        turns,
        tokensUsed,
        summary: 'User aborted',
        sessionId: this.sessionId,
      };
    }

    yield {
      type: AGENT_EVENT.DONE,
      result: {
        ok: true,
        turns,
        tokensUsed,
        summary: `Mock run complete — ${turns} turns, ${tokensUsed} tokens`,
        sessionId: this.sessionId,
      },
    };

    return {
      ok: true,
      turns,
      tokensUsed,
      summary: `Completed ${scenario} scenario`,
      sessionId: this.sessionId,
    };
  }

  getSession(): SessionState {
    return this._session;
  }

  async resumeSession(sessionId: string): Promise<SessionState> {
    this.sessionId = sessionId;
    this._session.id = sessionId;
    this._session.updatedAt = new Date().toISOString();
    return this._session;
  }

  abort(): void {
    this.aborted = true;
  }

}

/**
 * 创建 mock engine 实例
 */
export function createMockEngine(): IEngine {
  return new MockEngine() as unknown as IEngine;
}
