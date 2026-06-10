/**
 * types.ts — TUI 内部类型定义
 *
 * 仅 TUI 层使用的类型。跨 Agent 共享类型在 @comdr/core/types.ts。
 *
 * @agent Agent 5 — TUI 渲染器
 */

import type { ToolCall, RunMode, StateEntry, IntentEntry, MCPServerStatus } from '@comdr/core';

// ============================================================================
// MessageItem
// ============================================================================

export interface MessageItem {
  id: string;
  type: 'text' | 'user' | 'thinking' | 'tool_call' | 'tool_result' | 'warning' | 'error' | 'info' | 'separator';
  content: string;
  detail?: string;
  timestamp: number;
}

// ============================================================================
// Tab 类型
// ============================================================================

export type TabId = 'messages' | 'files' | 'logs';

// ============================================================================
// PendingConfirm — 确认对话框状态
// ============================================================================

export interface PendingConfirm {
  toolName: string;
  args: Record<string, unknown>;
  callId: string;
}

// ============================================================================
// ConnectionPhase — StatusLine 连接阶段
// ============================================================================

export type ConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'thinking'
  | 'generating'
  | 'executing_tool'
  | 'completed'
  | 'error';

// ============================================================================
// UIState — 全局 UI 状态
// ============================================================================

export interface UIState {
  streamingText: string;
  streamingThinking: string;
  messages: MessageItem[];
  activeToolCalls: Map<string, { call: ToolCall; status: 'running' }>;
  stateWindow: StateEntry[];
  intentWindow: IntentEntry[];
  status: {
    turn: number;
    maxTurns: number;
    tokensUsed: number;
    tokenBudget: number;
    thinking: string;
    mode: RunMode;
    sessionId: string;
  };
  progressWarning: string | null;
  mcpServers: MCPServerStatus[];
  running: boolean;
  finished: boolean;
  summary: string;
  fatalError: string | null;
  /** 消息焦点（↑↓ 导航） */
  focusedIndex: number;
  /** 右面板显隐 */
  showRightPanel: boolean;
  /** 已展开详情的消息 ID */
  expandedDetailIds: Set<string>;
  /** 帮助面板显隐 */
  showHelp: boolean;
  /** ★ Tab 系统 */
  activeTab: TabId;
  /** ★ 确认对话框 */
  pendingConfirm: PendingConfirm | null;
  /** ★ LLM 连接阶段 */
  connectionPhase: ConnectionPhase;
  /** ★ 缓存命中率 (0-1) */
  cacheHitRate: number;
  /** ★ 自动滚动锁定 */
  autoScrollLock: boolean;
  /** ★ 搜索状态 */
  searchQuery: string;
  searchMatches: number[];
  activeSearchMatch: number;
  /** ★ 本轮开始时间（用于完成通知判断） */
  runStartedAt: number;
}

// ============================================================================
// UIAction
// ============================================================================

export type UIAction =
  | { type: 'AGENT_EVENT'; event: import('@comdr/core').AgentEvent }
  | { type: 'RUN_START' }
  | { type: 'RESET'; sessionId: string }
  | { type: 'USER_INPUT'; text: string }
  | { type: 'SYNC_WINDOWS'; stateWindow: StateEntry[]; intentWindow: IntentEntry[] }
  | { type: 'MCP_CONNECTED'; name: string; transport: 'stdio' | 'tcp'; pid?: number }
  | { type: 'MCP_DISCONNECTED'; name: string }
  | { type: 'MCP_ERROR'; name: string; error: string }
  | { type: 'FOCUS_PREV' }
  | { type: 'FOCUS_NEXT' }
  | { type: 'TOGGLE_DETAIL'; messageId: string }
  | { type: 'TOGGLE_RIGHT_PANEL' }
  | { type: 'TOGGLE_HELP' }
  | { type: 'SET_TAB'; tab: TabId }
  | { type: 'SCROLL_LOCK' }
  | { type: 'SCROLL_UNLOCK' }
  | { type: 'SEARCH_START' }
  | { type: 'SEARCH_UPDATE'; query: string }
  | { type: 'SEARCH_NEXT' }
  | { type: 'SEARCH_PREV' }
  | { type: 'SEARCH_STOP' }
  | { type: 'SET_CONNECTION_PHASE'; phase: ConnectionPhase }
  | { type: 'SET_CACHE_HIT_RATE'; rate: number };
