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

import { createHash } from 'node:crypto';
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
/** System Prompt（完全静态——不含日期等动态内容，保证前缀缓存 100% 命中） */
const SYSTEM_PROMPT = buildSystemPromptPrefix();

// ============================================================================
// §2 PromptConstructor 类
// ============================================================================

export class PromptConstructor {
  /**
   * COMDR.md 内容——项目专属指令，注入到 System Prompt 之后。
   * 同会话内不变 → DeepSeek 前缀缓存友好。
   * 空串 = 文件不存在或无内容，跳过注入。
   */
  private comdrMd: string = '';

  /**
   * ★ L1.x — World Model 检索到的相关 chunk（格式化文本）。
   * 同会话内不变（查询依据 = session.currentInput）。
   */
  private worldModelContext: string = '';

  // ---- 动态区跨轮数据 ----

  /**
   * ★ L4.5 — Semantic Memory 实体上下文（每轮更新）。
   */
  private entityContext: string = '';

  /**
   * ★ L4.5 — Context Anchor 压缩摘要（每轮更新）。
   */
  private compactSummary: string = '';

  /**
   * 设置项目专属指令内容。Engine 构造时调用。
   */
  setComdrMd(content: string): void {
    this.comdrMd = content;
  }

  /**
   * ★ 设置 World Model 检索到的相关 chunk（L1.x）。
   * Engine 构造时调用一次，同会话不变。
   */
  setWorldModelContext(chunksText: string): void {
    this.worldModelContext = chunksText;
  }

  /**
   * ★ 仓库拓扑图——Aider-style repository map，注入到 L1.5。
   * 同会话固定 → 缓存友好（除非 file_write 后标记 dirty 重建）。
   */
  private repoMap: string = '';

  /**
   * ★ 任务行为指令——从 L7 提到 L3 静态区。
   * 同 route 内不变 → 缓存友好。route 切换时更新（罕见）。
   */
  private taskBehavior: string = '';

  /** 设置仓库地图。Engine 构造时调用一次。 */
  setRepoMap(text: string): void {
    this.repoMap = text;
  }

  /** 设置任务行为指令。loop.ts 每轮调用——但内容只在 route 变化时更新。 */
  setTaskBehavior(route: Route): void {
    const hint = buildTaskHint(route);
    if (hint !== this.taskBehavior) {
      this.taskBehavior = hint;
    }
  }

  /**
   * ★ 设置 Semantic Memory 实体上下文（L4.5）。
   * 每轮调用，反映最新的文件/实体关系。
   */
  setEntityContext(text: string): void {
    this.entityContext = text;
  }

  /**
   * ★ 设置 Context Anchor 压缩摘要（L4.5）。
   * 每轮调用，反映压缩管线的最新摘要。
   */
  setCompactSummary(text: string): void {
    this.compactSummary = text;
  }

  /**
   * ★ 计算静态区的 SHA256 指纹——用于监控前缀缓存命中情况。
   *
   * 指纹覆盖 L1 (system prompt) + COMDR.md + world model context + L2 (tool defs)。
   * L3 (session anchor) 同会话内不变但跨会话可能变，因此也纳入计算。
   *
   * 如果指纹与上一轮不同 → 前缀缓存必然 miss。
   *
   * @param tools     活跃工具定义
   * @param anchor    会话锚点
   * @param prevFp    上一轮的指纹（用于比较）
   * @returns { fingerprint, changed } — 当前指纹 + 是否变化
   */
  computeFingerprint(
    tools: ToolDefinition[],
    anchor: SessionAnchor,
    prevFp?: string,
  ): { fingerprint: string; changed: boolean } {
    const hash = createHash('sha256');
    hash.update(SYSTEM_PROMPT);
    hash.update(this.comdrMd);
    hash.update(this.worldModelContext);
    hash.update(serializeTools(tools));
    hash.update(JSON.stringify(anchor));
    const fingerprint = hash.digest('hex').slice(0, 16);
    return {
      fingerprint,
      changed: prevFp !== undefined && prevFp !== fingerprint,
    };
  }

  /**
   * ★ 获取静态区指纹（不带 anchor——用于同会话内快速比较）。
   * 同会话内 L3 不变，因此不带 anchor 的指纹更精确地反映"纯静态区是否漂移"。
   */
  computeStaticFingerprint(tools: ToolDefinition[]): { fingerprint: string } {
    const hash = createHash('sha256');
    hash.update(SYSTEM_PROMPT);
    hash.update(this.comdrMd);
    hash.update(this.worldModelContext);
    hash.update(serializeTools(tools));
    return { fingerprint: hash.digest('hex').slice(0, 16) };
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
    // ★ Merge L1.x + L1.5 + L1.6 + L1 project_instructions + L3 anchor
    // into ONE system message to save JSON wrapper overhead (~120B).
    const contextBlocks: string[] = [];
    if (this.taskBehavior) contextBlocks.push(this.taskBehavior);
    if (this.comdrMd) contextBlocks.push(`<project>\n${this.comdrMd}\n</project>`);
    if (this.repoMap) contextBlocks.push(this.repoMap);
    if (this.worldModelContext) contextBlocks.push(`<world>\n${this.worldModelContext}\n</world>`);

    // L3 anchor: relatedHistory + reflections (static within session)
    const anchorParts: string[] = [];
    if (anchor.relatedHistory.length > 0) {
      anchorParts.push('<history>', ...anchor.relatedHistory.map(h => `- ${h}`), '</history>');
    }
    if (anchor.reflectionSummary) {
      anchorParts.push('<reflection>', anchor.reflectionSummary, '</reflection>');
    }
    if (contextBlocks.length > 0 || anchorParts.length > 0) {
      const merged = [...contextBlocks, ...anchorParts].join('\n');
      if (merged) {
        return [
          this.buildL1_SystemPrompt(),
          { role: MESSAGE_ROLE.SYSTEM, content: merged },
          this.buildL2_ToolDefinitions(tools),
        ];
      }
    }

    return [
      this.buildL1_SystemPrompt(),
      this.buildL2_ToolDefinitions(tools),
    ];
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

  /** @deprecated Inlined into buildStaticZone for JSON wrapper savings */

  // --------------------------------------------------------------------------
  // ZONE 2: DYNAMIC（每轮变化）
  // --------------------------------------------------------------------------

  /**
   * 构建动态区域 L6-L7
   *
   * ★ 缓存优化：L4/L5/L4.5 不再作为独立消息（会切断 prefix cache）。
   * 改为合并到 L7 用户消息末尾。动态消息顺序变为:
   *   L6: Recent History → L7: User Input + State + Intent + Entity + Summary
   *
   * 这样 L1-L3 的 ~3200 tokens 永远命中缓存。
   */
  private buildDynamicZone(
    session: SessionState,
    route: Route,
  ): Message[] {
    return [
      ...this.buildL6_RecentHistory(session),
      this.buildL7_WithContext(session, route),
    ];
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

    // 从后往前扫描——不限轮次，由压缩管线按 token 预算处理
    for (const msg of [...session.messages].reverse()) {
      // 检测轮次边界：assistant 消息（无论是否有 tool_calls）
      if (msg.role === MESSAGE_ROLE.ASSISTANT && currentTurn.length > 0) {
        turns.unshift(currentTurn);
        currentTurn = [];
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
   * L7: User Input + Dynamic Context (merged)
   *
   * ★ 缓存优化: State Window, Intent Window, Entity Context, Compact Summary
   * 不再作为独立消息，而是合并到用户消息末尾。这样 L1-L3 的 ~3200 tokens
   * 永远命中前缀缓存。
   */
  private buildL7_WithContext(
    session: SessionState,
    _route: Route,
  ): Message {
    const parts: string[] = [];

    // ---- User input ----
    parts.push(session.currentInput);

    // ---- Dynamic context ----
    const ctx = this.buildContextSuffix(session);
    if (ctx) {
      parts.push('');
      parts.push(ctx);
    }

    return {
      role: 'user',
      content: parts.join('\n'),
    };
  }

  /**
   * ★ 构建动态上下文后缀。标签已最小化以减少缓存外字节。
   */
  private buildContextSuffix(session: SessionState): string | null {
    const blocks: string[] = [];

    if (session.stateWindow.length > 0) {
      const lines = session.stateWindow.map(e => `- [${e.key}] ${e.text}`);
      blocks.push(`<s>\n${lines.join('\n')}\n</s>`);
    }
    if (session.intentWindow.length > 0) {
      const lines = session.intentWindow.map(e => `- [${e.key}] ${e.why}`);
      blocks.push(`<i>\n${lines.join('\n')}\n</i>`);
    }
    const extras: string[] = [];
    if (this.entityContext) {
      extras.push(`<e>\n${this.entityContext}\n</e>`);
    }
    if (this.compactSummary) {
      extras.push(`<c>\n${this.compactSummary}\n</c>`);
    }
    if (extras.length > 0) blocks.push(extras.join('\n'));

    return blocks.length > 0 ? blocks.join('\n') : null;
  }
}

// ============================================================================
// §3 辅助
// ============================================================================

/**
 * 构建任务行为提示（注入 L1.6 静态区）。
 * 同 route 内不变 → 缓存友好。
 */
export function buildTaskHint(route: Route): string {
  const mode = (() => {
    switch (route.taskType) {
      case 'query':       return '[r] answer directly, use tools only when asked';
      case 'edit':        return '[e] minimal changes, read first, verify after';
      case 'generate':    return '[g] plan structure, create files, handle imports';
      case 'refactor':    return '[r!] read all callers, smallest safe steps, single-file';
      case 'architect':   return '[a] design only, no impl, output decisions+tradeoffs+plan';
      case 'orchestrate': return '[o] multi-step, parallel vs sequential, mcp/task_spawn';
    }
  })();
  const think = route.thinking.type === 'enabled' && route.thinking.effort === 'max'
    ? ' [think:max]' : '';
  return mode + think;
}

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
  _stateWindow: { key: string; text: string }[],
  _intentWindow: { key: string; why: string }[],
  relatedHistory: string[] = [],
  reflections?: string[],
): SessionAnchor {
  // ★ State/Intent summaries are now in L7 context suffix — NOT in L3.
  // L3 should only contain truly static data (relatedHistory, reflections)
  // to keep the prefix cache boundary clean.
  return {
    relatedHistory,
    reflectionSummary: reflections?.length ? reflections.join('\n') : undefined,
  };
}
