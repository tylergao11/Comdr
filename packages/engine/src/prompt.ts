/**
 * prompt.ts — 分层 Prompt 构造
 *
 * 来源：Claude Code 两区架构 + DeepSeek 自动前缀缓存
 *
 * 七层架构:
 *   ZONE 1: STATIC (缓存友好，不变)
 *     L1: System Prompt (不含时间戳)
 *     L2: Tool Definitions (JSON.stringify sorted keys)
 *     L3: Session Anchor (会话摘要 + 持久记忆)
 *   ZONE 2: DYNAMIC (每轮变化)
 *     L4: State Window (最近 5 条 WHAT)
 *     L5: Intent Window (最近 5 条 WHY)
 *     L6: Recent History (最近 5 轮完整消息)
 *     L7: Current User Input
 *
 * 关键设计:
 *   - L1-L3 保持绝对不变 → DeepSeek 全自动前缀缓存 100% 命中
 *   - L4-L7 每轮变化，但总量控制在 ~8K tokens 以内
 *   - System Prompt 不含任何时间戳、动态 ID、随机数
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type {
  Message,
  ToolDefinition,
  SessionState,
  SessionAnchor,
  Route,
} from '@comdr/core/types';
import { MESSAGE_ROLE, THINKING_TYPE, THINKING_EFFORT, SYSTEM } from '@comdr/core';
import { serializeTools } from '@comdr/llm';
import { buildSystemPromptPrefix } from '@comdr/llm';

// ============================================================================
// §1 常量
// ============================================================================

/**
 * 最近历史保留轮数
 */
const RECENT_HISTORY_TURNS = SYSTEM.PROMPT_RECENT_HISTORY_TURNS;

/**
 * System Prompt（固定，不含时间戳）
 */
const SYSTEM_PROMPT = buildSystemPromptPrefix();

// ============================================================================
// §2 PromptConstructor 类
// ============================================================================

export class PromptConstructor {
  /**
   * comdr.md 内容——项目专属指令，注入到 System Prompt 之后。
   * 同会话内不变 → DeepSeek 前缀缓存友好。
   * 空串 = 文件不存在或无内容，跳过注入。
   */
  private comdrMd: string = '';

  /**
   * 设置项目专属指令内容。Engine 构造时调用。
   */
  setComdrMd(content: string): void {
    this.comdrMd = content;
  }

  /**
   * 构造本轮 messages 数组
   *
   * @param session     当前会话状态
   * @param tools       活跃工具定义列表
   * @param route       任务路由结果
   * @param anchor      会话锚点（跨会话上下文）
   */
  build(
    session: SessionState,
    tools: ToolDefinition[],
    route: Route,
    anchor: SessionAnchor,
  ): Message[] {
    const staticZone = this.buildStaticZone(tools, anchor);
    const dynamicZone = this.buildDynamicZone(session, route);
    return [...staticZone, ...dynamicZone];
  }

  // --------------------------------------------------------------------------
  // ZONE 1: STATIC（缓存友好）
  // --------------------------------------------------------------------------

  /**
   * 构建静态区域 L1-L3
   * 这些在同一个会话中保持不变，保证 DeepSeek 前缀缓存命中
   */
  private buildStaticZone(
    tools: ToolDefinition[],
    anchor: SessionAnchor,
  ): Message[] {
    const messages: Message[] = [
      this.buildL1_SystemPrompt(),
    ];

    // ★ comdr.md — 项目专属指令（L1 之后，同会话固定 → 缓存友好）
    if (this.comdrMd) {
      messages.push({
        role: MESSAGE_ROLE.SYSTEM,
        content: `<project_instructions>\n${this.comdrMd}\n</project_instructions>`,
      });
    }

    messages.push(
      this.buildL2_ToolDefinitions(tools),
      this.buildL3_SessionAnchor(anchor),
    );
    return messages;
  }

  /**
   * L1: System Prompt（不含时间戳）
   */
  private buildL1_SystemPrompt(): Message {
    return {
      role: MESSAGE_ROLE.SYSTEM,
      content: SYSTEM_PROMPT,
    };
  }

  /**
   * L2: Tool Definitions (sorted keys 保证稳定)
   *
   * ★ 使用 serializeTools 保证 JSON.stringify 的 key 顺序稳定，
   * 每次调用生成完全相同的 JSON 字符串 → DeepSeek 缓存命中
   */
  private buildL2_ToolDefinitions(tools: ToolDefinition[]): Message {
    // 工具定义作为 system 消息注入（前面的 content 会被缓存锚定）
    const defsText = serializeTools(tools);
    return {
      role: MESSAGE_ROLE.SYSTEM,
      content: `<tool_definitions>\n${defsText}\n</tool_definitions>`,
    };
  }

  /**
   * L3: Session Anchor（会话摘要 + 跨会话上下文）
   */
  private buildL3_SessionAnchor(anchor: SessionAnchor): Message {
    const parts: string[] = [];

    if (anchor.relatedHistory.length > 0) {
      parts.push(
        '<related_history>',
        ...anchor.relatedHistory.map((h) => `- ${h}`),
        '</related_history>',
      );
    }

    if (anchor.stateSummary) {
      parts.push(
        '<state_summary>',
        anchor.stateSummary,
        '</state_summary>',
      );
    }

    if (anchor.intentSummary) {
      parts.push(
        '<intent_summary>',
        anchor.intentSummary,
        '</intent_summary>',
      );
    }

    if (parts.length === 0) {
      parts.push('No prior session context.');
    }

    return {
      role: MESSAGE_ROLE.SYSTEM,
      content: parts.join('\n'),
    };
  }

  // --------------------------------------------------------------------------
  // ZONE 2: DYNAMIC（每轮变化）
  // --------------------------------------------------------------------------

  /**
   * 构建动态区域 L4-L7
   * 每轮重建，总量控制在 ~8K tokens 以内
   */
  private buildDynamicZone(
    session: SessionState,
    route: Route,
  ): Message[] {
    return [
      this.buildL4_StateWindow(session),
      this.buildL5_IntentWindow(session),
      ...this.buildL6_RecentHistory(session),
      this.buildL7_UserInput(session, route),
    ];
  }

  /**
   * L4: State Window（最近 5 条 WHAT）
   */
  private buildL4_StateWindow(session: SessionState): Message {
    if (session.stateWindow.length === 0) {
      return {
        role: MESSAGE_ROLE.USER,
        content: '<state_window>\n(empty)\n</state_window>',
      };
    }

    const lines = session.stateWindow.map(
      (e) => `- [${e.key}] ${e.text} (turn ${e.turn})`,
    );
    return {
      role: MESSAGE_ROLE.USER,
      content: `<state_window>\n${lines.join('\n')}\n</state_window>`,
    };
  }

  /**
   * L5: Intent Window（最近 5 条 WHY）
   */
  private buildL5_IntentWindow(session: SessionState): Message {
    if (session.intentWindow.length === 0) {
      return {
        role: MESSAGE_ROLE.USER,
        content: '<intent_window>\n(empty)\n</intent_window>',
      };
    }

    const lines = session.intentWindow.map(
      (e) => `- [${e.key}] ${e.why} (turn ${e.turn})`,
    );
    return {
      role: MESSAGE_ROLE.USER,
      content: `<intent_window>\n${lines.join('\n')}\n</intent_window>`,
    };
  }

  /**
   * L6: Recent History（最近 5 轮完整消息）
   *
   * session.messages 不含 user 消息（user 由 L7 动态注入），
   * 因此以「assistant with tool_calls」作为轮次边界。
   *
   * 每轮 = 1 条 assistant message（含 tool_calls）
   *      + N 条 tool result messages
   *      + 可能的后置 system 消息（reflection/progress feedback）
   */
  private buildL6_RecentHistory(session: SessionState): Message[] {
    if (session.messages.length === 0) return [];

    const turns: Message[][] = [];
    let currentTurn: Message[] = [];

    // 从后往前扫描
    for (const msg of [...session.messages].reverse()) {
      // 检测轮次边界：assistant 消息（无论是否有 tool_calls）
      if (msg.role === MESSAGE_ROLE.ASSISTANT && currentTurn.length > 0) {
        turns.unshift(currentTurn);
        currentTurn = [];
        if (turns.length >= SYSTEM.PROMPT_RECENT_HISTORY_TURNS) break;
      }

      currentTurn.unshift(msg);
    }

    // 不要漏掉最后一轮
    if (currentTurn.length > 0) {
      turns.unshift(currentTurn);
    }

    // ★ 防御性保证：每条 assistant + tool_calls 消息必须有 reasoning_content
    // DeepSeek V4 要求：缺失 = 400 错误。正常情况下 reasoning.inject() 已在调用方处理，
    // 但如果未来有其他代码路径绕过 inject()，这里作为最后防线。
    const flat = turns.flat();
    for (const msg of flat) {
      if (
        msg.role === MESSAGE_ROLE.ASSISTANT &&
        msg.tool_calls &&
        msg.tool_calls.length > 0 &&
        msg.reasoning_content === undefined
      ) {
        msg.reasoning_content = '';
      }
    }

    return flat;
  }

  /**
   * L7: Current User Input
   *
   * ★ 按 taskType 注入行为约束前缀。
   * prefix 顺序: taskType 约束 → thinking 指令
   */
  private buildL7_UserInput(
    session: SessionState,
    route: Route,
  ): Message {
    const prefixes: string[] = [];

    // ---- Task-type behavior constraint ----
    switch (route.taskType) {
      case 'query':
        prefixes.push(
          '[read-only] Analysis only. Do NOT modify any files. Read, search, and report.',
        );
        break;
      case 'edit':
        prefixes.push(
          '[edit] Make minimal precise changes. Read the target file first, edit only what is needed, verify after.',
        );
        break;
      case 'generate':
        prefixes.push(
          '[generate] Plan file structure first, then create each file. Handle imports and dependencies correctly.',
        );
        break;
      case 'refactor':
        prefixes.push(
          '[refactor] Read full file and all callers before touching anything. Plan the smallest safe steps. Prefer single-file refactors.',
        );
        break;
      case 'architect':
        prefixes.push(
          '[architect] Design phase only. Do NOT write implementation code. Output architecture decisions, trade-offs, file layout, and implementation plan.',
        );
        break;
      case 'orchestrate':
        // ★ 告知 MCP 工具可用性（如果有的话）
        prefixes.push(
          '[orchestrate] Multi-step coordination. Check which services are available. Plan parallel vs sequential execution. Use mcp__* tools for external agent tasks.',
        );
        break;
    }

    // ---- Thinking mode hint ----
    if (
      route.thinking.type === THINKING_TYPE.ENABLED &&
      route.thinking.effort === THINKING_EFFORT.MAX
    ) {
      prefixes.push('[thinking:max] Think through the full plan before acting.');
    }

    const content = prefixes.length > 0
      ? `${prefixes.join('\n')}\n\n${session.currentInput}`
      : session.currentInput;

    return {
      role: 'user',
      content,
    };
  }
}

// ============================================================================
// §3 辅助
// ============================================================================

/**
 * 构建空的会话锚点（新会话无历史）
 */
export function emptyAnchor(): SessionAnchor {
  return {
    relatedHistory: [],
    stateSummary: '',
    intentSummary: '',
  };
}

/**
 * 从双窗口构造锚点摘要文本
 */
export function anchorFromWindows(
  stateWindow: { key: string; text: string }[],
  intentWindow: { key: string; why: string }[],
  relatedHistory: string[] = [],
): SessionAnchor {
  const stateSummary = stateWindow
    .map((e) => `- ${e.key}: ${e.text}`)
    .join('\n');

  const intentSummary = intentWindow
    .map((e) => `- ${e.key}: ${e.why}`)
    .join('\n');

  return {
    relatedHistory,
    stateSummary,
    intentSummary,
  };
}
