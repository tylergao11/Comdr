/**
 * reducer.ts — UI 状态 reducer
 *
 * 纯函数，从 UIAction → UIState。一站式处理所有 AgentEvent 变体。
 *
 * @agent Agent 5 — TUI 渲染器
 */

import type { ToolCall, StateEntry, IntentEntry, AgentEvent, RunMode } from '@comdr/core';
import { AGENT_EVENT, SERVER_STATUS, SYSTEM } from '@comdr/core';
import type { UIState, UIAction, PendingConfirm, ConnectionPhase, TabId } from './types.js';
import { uid } from './utils.js';

// ============================================================================
// Initial state factory
// ============================================================================

export function createInitialState(sessionId: string, mode: RunMode): UIState {
  return {
    streamingText: '', streamingThinking: '',
    messages: [{
      id: 'welcome', type: 'info',
      content: `Comdr v0.3 — ${mode === 'plan' ? 'Plan · 只读分析' : mode === 'yolo' ? 'YOLO · 全自动' : 'Agent · 逐步确认'}`,
      timestamp: Date.now(),
    }],
    activeToolCalls: new Map(),
    stateWindow: [], intentWindow: [],
    status: {
      turn: 0, maxTurns: SYSTEM.DEFAULT_MAX_TURNS,
      tokensUsed: 0, tokenBudget: SYSTEM.DEFAULT_TOKEN_BUDGET,
      thinking: 'high', mode, sessionId,
    },
    progressWarning: null,
    mcpServers: [],
    running: false, finished: false,
    summary: '', fatalError: null,
    focusedIndex: 0,
    showRightPanel: true,
    expandedDetailIds: new Set(),
    showHelp: false,
    activeTab: 'messages',
    pendingConfirm: null,
    connectionPhase: 'idle',
    cacheHitRate: 0,
    autoScrollLock: false,
    searchQuery: '',
    searchMatches: [],
    activeSearchMatch: -1,
    runStartedAt: 0,
  };
}

// ============================================================================
// Helper: flush streaming → messages
// ============================================================================

function flushStreaming(state: UIState): UIState['messages'] {
  const fresh: UIState['messages'] = [];

  if (state.streamingThinking.trim()) {
    const segments = countThinkingSegmentsLocal(state.streamingThinking);
    const label = segments.length > 1
      ? `${segments.length} 段思考: ${truncateLocal(segments[0] ?? '', 40)}`
      : truncateLocal(segments[0] ?? 'thinking', 60);
    fresh.push({
      id: `think-${uid()}`,
      type: 'thinking',
      content: state.streamingThinking.trim(),
      detail: label,
      timestamp: Date.now(),
    });
  }

  if (state.streamingText.trim()) {
    fresh.push({
      id: `text-${uid()}`,
      type: 'text',
      content: state.streamingText.trim(),
      timestamp: Date.now(),
    });
  }

  return fresh;
}

// Local imports to avoid circular deps
import { truncate as truncateLocal } from './utils.js';

function countThinkingSegmentsLocal(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);
}

// ============================================================================
// Reducer
// ============================================================================

export function uiReducer(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    // ── AgentEvent aggregator ─────────────────────────────────
    case 'AGENT_EVENT': {
      const event = action.event;
      switch (event.type) {
        case AGENT_EVENT.TEXT_DELTA:
          return {
            ...state,
            streamingText: state.streamingText + event.content,
            connectionPhase: 'generating',
          };

        case AGENT_EVENT.THINKING_DELTA:
          return {
            ...state,
            streamingThinking: state.streamingThinking + event.content,
            connectionPhase: 'thinking',
          };

        case AGENT_EVENT.TOOL_CALL: {
          const nextTC = new Map(state.activeToolCalls);
          nextTC.set(event.call.id, { call: event.call, status: 'running' });
          return {
            ...state,
            activeToolCalls: nextTC,
            connectionPhase: 'executing_tool',
          };
        }

        case AGENT_EVENT.TOOL_RESULT: {
          const nextTC = new Map(state.activeToolCalls);
          const existing = nextTC.get(event.result.callId);
          nextTC.delete(event.result.callId);

          const flushed = flushStreaming(state);
          const messages = [...state.messages, ...flushed];

          const name = event.result.toolName;
          const argsJson = existing?.call.function.arguments;
          const displayName = toolDisplayNameLocal(name, argsJson);
          messages.push({
            id: `call-${uid()}`,
            type: 'tool_call',
            content: displayName,
            detail: argsJson,
            timestamp: Date.now(),
          });
          const toolSuccessSummary = event.result.diffSummary
            ? ': ' + truncateLocal(event.result.diffSummary, 80)
            : event.result.content
              ? ': ' + truncateLocal(event.result.content, 80)
              : '';
          messages.push({
            id: `result-${uid()}`,
            type: 'tool_result',
            content: event.result.ok
              ? `✓ ${name}${toolSuccessSummary}`
              : `✗ ${name}: ${event.result.errorCategory ?? 'execution_error'}`,
            detail: event.result.content ?? undefined,
            timestamp: Date.now(),
          });

          return {
            ...state,
            messages,
            streamingText: '',
            streamingThinking: '',
            activeToolCalls: nextTC,
            connectionPhase: state.streamingText ? 'generating' : state.streamingThinking ? 'thinking' : 'executing_tool',
          };
        }

        case AGENT_EVENT.PROGRESS_WARNING:
          return {
            ...state,
            messages: [...state.messages, {
              id: `warn-${uid()}`, type: 'warning',
              content: `⚠ ${event.message} (stalled ${event.stalledTurns} turns)`,
              timestamp: Date.now(),
            }],
            progressWarning: event.message,
          };

        case AGENT_EVENT.SESSION_STARTED:
          return {
            ...state,
            status: { ...state.status, sessionId: event.sessionId, mode: event.mode },
            connectionPhase: 'connecting',
          };

        case AGENT_EVENT.TURN_BEGIN:
          return {
            ...state,
            status: { ...state.status, turn: event.turn },
          };

        case AGENT_EVENT.TOKEN_USAGE:
          return {
            ...state,
            status: {
              ...state.status,
              // ★ 只计 cache miss（真正消耗的 token）：miss + completion
              tokensUsed: state.status.tokensUsed
                + event.usage.cacheMissTokens
                + event.usage.completionTokens,
            },
            cacheHitRate: event.cacheHitRate ?? state.cacheHitRate,
          };

        case AGENT_EVENT.MCP_STATUS:
          return { ...state, mcpServers: event.servers };

        case AGENT_EVENT.BOOTSTRAP_DONE:
          return {
            ...state,
            messages: [...state.messages, {
              id: `bootstrap-${uid()}`,
              type: 'info',
              content: `📊 代码索引: ${event.symbolsFound} 符号, ${event.referencesFound} 引用, ${event.filesScanned} 文件`,
              timestamp: Date.now(),
            }],
          };

        case AGENT_EVENT.DONE: {
          let msgs = state.messages;
          if (state.streamingThinking.trim()) {
            const segments = countThinkingSegmentsLocal(state.streamingThinking);
            msgs = [...msgs, {
              id: `think-${uid()}`, type: 'thinking' as const,
              content: state.streamingThinking.trim(),
              detail: `${segments.length} 段思考`,
              timestamp: Date.now(),
            }];
          }
          if (state.streamingText.trim()) {
            msgs = [...msgs, {
              id: `text-${uid()}`, type: 'text' as const,
              content: state.streamingText.trim(), timestamp: Date.now(),
            }];
          }
          return {
            ...state, messages: msgs,
            streamingText: '', streamingThinking: '',
            running: false, finished: true,
            summary: event.result.summary,
            connectionPhase: 'completed',
            status: {
              ...state.status,
              turn: event.result.turns,
              tokensUsed: event.result.tokensUsed,
            },
          };
        }

        case AGENT_EVENT.ERROR:
          return {
            ...state,
            running: event.recoverable ? state.running : false,
            finished: !event.recoverable,
            fatalError: event.recoverable ? null : event.message,
            connectionPhase: 'error',
            messages: [...state.messages, {
              id: `err-${uid()}`, type: 'error' as const,
              content: `✗ ${event.code}: ${event.message}`, timestamp: Date.now(),
            }],
          };

        default:
          return state;
      }
    }

    // ── Lifecycle actions ────────────────────────────────────
    case 'RUN_START':
      return { ...state, running: true, finished: false, fatalError: null, summary: '', runStartedAt: Date.now() };

    case 'RESET':
      return createInitialState(action.sessionId, state.status.mode);

    case 'USER_INPUT':
      return {
        ...state,
        messages: [...state.messages.filter(m => m.id !== 'welcome'), {
          id: `user-${uid()}`, type: 'user' as const,
          content: action.text, timestamp: Date.now(),
        }],
      };

    case 'SYNC_WINDOWS':
      return { ...state, stateWindow: action.stateWindow, intentWindow: action.intentWindow };

    // ── MCP status ───────────────────────────────────────────
    case 'MCP_CONNECTED':
      return {
        ...state,
        mcpServers: state.mcpServers.map(s =>
          s.name === action.name
            ? { ...s, status: SERVER_STATUS.CONNECTED, transport: action.transport, pid: action.pid, uptime: 0, error: undefined }
            : s),
      };

    case 'MCP_DISCONNECTED':
      return {
        ...state,
        mcpServers: state.mcpServers.map(s =>
          s.name === action.name ? { ...s, status: SERVER_STATUS.OFFLINE, uptime: undefined, pid: undefined } : s),
      };

    case 'MCP_ERROR':
      return {
        ...state,
        mcpServers: state.mcpServers.map(s =>
          s.name === action.name ? { ...s, status: SERVER_STATUS.ERROR, error: action.error, uptime: undefined } : s),
      };

    // ── Navigation ───────────────────────────────────────────
    case 'FOCUS_PREV':
      return { ...state, focusedIndex: Math.max(0, state.focusedIndex - 1), autoScrollLock: true };
    case 'FOCUS_NEXT': {
      const maxIdx = Math.max(0, state.messages.length - 1);
      const newIdx = Math.min(maxIdx, state.focusedIndex + 1);
      const isAtBottom = newIdx >= maxIdx;
      return {
        ...state,
        focusedIndex: newIdx,
        autoScrollLock: isAtBottom ? false : state.autoScrollLock,
      };
    }
    case 'TOGGLE_DETAIL': {
      const next = new Set(state.expandedDetailIds);
      if (next.has(action.messageId)) next.delete(action.messageId);
      else next.add(action.messageId);
      return { ...state, expandedDetailIds: next };
    }
    case 'TOGGLE_RIGHT_PANEL':
      return { ...state, showRightPanel: !state.showRightPanel };
    case 'TOGGLE_HELP':
      return { ...state, showHelp: !state.showHelp };

    // ── Tab ──────────────────────────────────────────────────
    case 'SET_TAB':
      return { ...state, activeTab: action.tab };

    // ── Scroll lock ──────────────────────────────────────────
    case 'SCROLL_LOCK':
      return { ...state, autoScrollLock: true };
    case 'SCROLL_UNLOCK':
      return { ...state, autoScrollLock: false };

    // ── Search ───────────────────────────────────────────────
    case 'SEARCH_START':
      return { ...state, searchQuery: '', searchMatches: [], activeSearchMatch: -1 };
    case 'SEARCH_UPDATE': {
      const q = action.query.toLowerCase();
      if (!q) return { ...state, searchQuery: q, searchMatches: [], activeSearchMatch: -1 };
      const matches = state.messages
        .map((m, i) => (m.content.toLowerCase().includes(q) ? i : -1))
        .filter(i => i >= 0);
      return {
        ...state,
        searchQuery: q,
        searchMatches: matches,
        activeSearchMatch: matches.length > 0 ? 0 : -1,
      };
    }
    case 'SEARCH_NEXT': {
      if (state.searchMatches.length === 0) return state;
      const cur = state.activeSearchMatch;
      const nextIdx = (cur + 1) % state.searchMatches.length;
      const msgIdx = state.searchMatches[nextIdx];
      return {
        ...state,
        activeSearchMatch: nextIdx,
        focusedIndex: msgIdx ?? state.focusedIndex,
      };
    }
    case 'SEARCH_PREV': {
      if (state.searchMatches.length === 0) return state;
      const cur = state.activeSearchMatch;
      const prevIdx = (cur - 1 + state.searchMatches.length) % state.searchMatches.length;
      const msgIdx = state.searchMatches[prevIdx];
      return {
        ...state,
        activeSearchMatch: prevIdx,
        focusedIndex: msgIdx ?? state.focusedIndex,
      };
    }
    case 'SEARCH_STOP':
      return { ...state, searchQuery: '', searchMatches: [], activeSearchMatch: -1 };

    // ── Connection phase ─────────────────────────────────────
    case 'SET_CONNECTION_PHASE':
      return { ...state, connectionPhase: action.phase };
    case 'SET_CACHE_HIT_RATE':
      return { ...state, cacheHitRate: action.rate };

    default:
      return state;
  }
}

// Local import to avoid circular deps
import { toolDisplayName as toolDisplayNameLocal } from './utils.js';
