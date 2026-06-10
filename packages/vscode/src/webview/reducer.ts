/**
 * reducer.ts — Webview 状态机
 *
 * 移植自 tui/reducer.ts 的 AgentEvent → UI State 映射模式。
 * 唯一的状态变更入口——不允许外部直接 setState。
 */

import type {
  AppState,
  ChatMessage,
  ExtensionMessage,
  MCPServerStatusMsg,
} from './types.js';
import { parseContent } from './parser.js';

// ============================================================================
// §1 Action 类型
// ============================================================================

export type AppAction =
  | { type: 'CONFIG_REQUIRED'; missingFields: string[] }
  | { type: 'ENGINE_READY' }
  | { type: 'SETUP_COMPLETE' }
  | { type: 'SESSION_STARTED'; sessionId: string }
  | { type: 'TEXT_DELTA'; content: string }
  | { type: 'THINKING_DELTA'; content: string }
  | { type: 'TOOL_CALL'; callId: string; toolName: string }
  | { type: 'TOOL_RESULT'; callId: string; toolName: string; ok: boolean; summary: string; errorCategory?: string }
  | { type: 'MODEL_STATUS'; model: string; thinking: boolean; thinkingProgress?: string }
  | { type: 'SHADOW_STATUS'; errorsFixed: number; errorsIntroduced: number; isValidating: boolean }
  | { type: 'MCP_STATUS'; servers: MCPServerStatusMsg[] }
  | { type: 'DIFF'; filePath: string; original: string; modified: string; lspVerified?: boolean }
  | { type: 'REFS'; refs: import('./types.js').ChatRef[] }
  | { type: 'TOKEN_USAGE'; usage: import('./types.js').TokenUsageMsg; cacheHitRate?: number }
  | { type: 'STATE_SYNC'; messages: ChatMessage[]; sessionId: string | null; turn: number; tokensUsed: number; isRunning: boolean }
  | { type: 'USER_INPUT'; text: string }
  | { type: 'DONE'; turns: number; tokens: number; summary: string; sessionId: string }
  | { type: 'ERROR'; message: string; recoverable: boolean }
  | { type: 'CLEAR_ERROR' }
  | { type: 'TOGGLE_MCP_PANEL' }
  | { type: 'TOGGLE_BRAIN_PANEL' }
  | { type: 'DISMISS_DIFF' };

// ============================================================================
// §2 消息 ID 生成（计数器保证无碰撞）
// ============================================================================

let msgIdCounter = 0;
function nextMsgId(): string {
  return `msg_${Date.now()}_${++msgIdCounter}`;
}

// ============================================================================
// §3 初始状态
// ============================================================================

export function initialAppState(): AppState {
  return {
    sessionId: null,
    turn: 0,
    tokensUsed: 0,
    isRunning: false,
    setupRequired: false,
    setupMissing: [],
    messages: [],
    currentDelta: '',
    currentThinking: '',
    modelBar: { model: 'deepseek-v4-pro', thinking: false, thinkingProgress: null, cacheHitRate: null },
    shadowBar: { showing: false, isValidating: false, lastResult: null },
    mcpBar: { servers: [], activeCount: 0 },
    mcpPanelVisible: false,
    brainPanelVisible: false,
    activeDiff: null,
    refs: [],
    error: null,
  };
}

// ============================================================================
// §4 Reducer
// ============================================================================

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {

    case 'CONFIG_REQUIRED':
      return { ...state, setupRequired: true, setupMissing: action.missingFields };

    case 'ENGINE_READY':
      return { ...state, setupRequired: false, setupMissing: [], error: null };

    case 'SETUP_COMPLETE':
      return { ...state, setupRequired: false, setupMissing: [], error: null };

    case 'SESSION_STARTED':
      return { ...state, sessionId: action.sessionId, isRunning: true, turn: 0 };

    case 'TEXT_DELTA':
      return { ...state, currentDelta: state.currentDelta + action.content };

    case 'THINKING_DELTA':
      return { ...state, currentThinking: state.currentThinking + action.content };

    case 'TOOL_CALL': {
      if (state.currentDelta.trim()) {
        return { ...commitDelta(state, state.currentDelta), currentDelta: '' };
      }
      return state;
    }

    case 'TOOL_RESULT': {
      const msgs = [...state.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]!.role === 'agent' && msgs[i]!.toolCall?.callId === action.callId) {
          msgs[i] = {
            ...msgs[i]!,
            toolCall: { ...msgs[i]!.toolCall!, ok: action.ok, summary: action.summary },
          };
          break;
        }
      }
      return { ...state, messages: msgs };
    }

    case 'MODEL_STATUS':
      return {
        ...state,
        modelBar: {
          model: action.model,
          thinking: action.thinking,
          thinkingProgress: action.thinking ? (action.thinkingProgress ?? state.modelBar.thinkingProgress) : null,
          cacheHitRate: state.modelBar.cacheHitRate,
        },
      };

    case 'SHADOW_STATUS':
      return {
        ...state,
        shadowBar: {
          showing: true,
          isValidating: action.isValidating,
          lastResult: action.isValidating ? state.shadowBar.lastResult : {
            errorsFixed: action.errorsFixed,
            errorsIntroduced: action.errorsIntroduced,
          },
        },
      };

    case 'MCP_STATUS': {
      const runningCount = action.servers.filter(s => s.activeTool !== undefined).length;
      return {
        ...state,
        mcpBar: {
          servers: action.servers,
          activeCount: runningCount,
        },
        mcpPanelVisible: runningCount > 0 ? true : state.mcpPanelVisible,
      };
    }

    case 'DIFF':
      return {
        ...state,
        activeDiff: {
          filePath: action.filePath,
          original: action.original,
          modified: action.modified,
          lspVerified: action.lspVerified ?? null,
        },
        shadowBar: { ...state.shadowBar, isValidating: false },
      };

    case 'REFS': {
      const MAX_REFS = 200;
      const merged = [...state.refs, ...action.refs];
      const deduped = dedupeRefs(merged);
      return { ...state, refs: deduped.slice(-MAX_REFS) };
    }

    case 'TOKEN_USAGE':
      return {
        ...state,
        tokensUsed: state.tokensUsed + action.usage.promptTokens + action.usage.completionTokens,
        modelBar: {
          ...state.modelBar,
          cacheHitRate: action.cacheHitRate ?? state.modelBar.cacheHitRate,
        },
      };

    case 'USER_INPUT': {
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: nextMsgId(), role: 'user', content: action.text, parsedContent: null, timestamp: Date.now() },
        ],
        isRunning: true,
        currentDelta: '',
        currentThinking: '',
        error: null,
      };
    }

    case 'DONE': {
      const withFinalDelta = state.currentDelta.trim()
        ? commitDelta(state, state.currentDelta)
        : state;
      return {
        ...withFinalDelta,
        isRunning: false,
        turn: action.turns,
        tokensUsed: action.tokens,
        currentDelta: '',
        currentThinking: '',
        shadowBar: { ...state.shadowBar, showing: false, isValidating: false },
      };
    }

    case 'STATE_SYNC':
      return {
        ...state,
        messages: action.messages,
        sessionId: action.sessionId,
        turn: action.turn,
        tokensUsed: action.tokensUsed,
        isRunning: action.isRunning,
      };

    case 'ERROR':
      return {
        ...state,
        error: { message: action.message, recoverable: action.recoverable },
        isRunning: action.recoverable ? state.isRunning : false,
        shadowBar: action.recoverable ? state.shadowBar : { ...state.shadowBar, showing: false, isValidating: false },
      };

    case 'CLEAR_ERROR':
      return { ...state, error: null };

    case 'TOGGLE_MCP_PANEL':
      return { ...state, mcpPanelVisible: !state.mcpPanelVisible };

    case 'TOGGLE_BRAIN_PANEL':
      return { ...state, brainPanelVisible: !state.brainPanelVisible };

    case 'DISMISS_DIFF':
      return { ...state, activeDiff: null };

    default:
      return state;
  }
}

// ============================================================================
// §5 ExtensionMessage → dispatch (薄映射)
// ============================================================================

export function mapMessageToAction(msg: ExtensionMessage): AppAction {
  switch (msg.type) {
    case 'configRequired': return { type: 'CONFIG_REQUIRED', missingFields: msg.missingFields };
    case 'engineReady': return { type: 'ENGINE_READY' };
    case 'sessionStarted': return { type: 'SESSION_STARTED', sessionId: msg.sessionId };
    case 'textDelta': return { type: 'TEXT_DELTA', content: msg.content };
    case 'thinkingDelta': return { type: 'THINKING_DELTA', content: msg.content };
    case 'toolCall': return { type: 'TOOL_CALL', callId: msg.callId, toolName: msg.toolName };
    case 'toolResult': return { type: 'TOOL_RESULT', callId: msg.callId, toolName: msg.toolName, ok: msg.ok, summary: msg.summary, errorCategory: msg.errorCategory };
    case 'modelStatus': return { type: 'MODEL_STATUS', model: msg.model, thinking: msg.thinking, thinkingProgress: msg.thinkingProgress };
    case 'shadowStatus': return { type: 'SHADOW_STATUS', errorsFixed: msg.errorsFixed, errorsIntroduced: msg.errorsIntroduced, isValidating: msg.isValidating };
    case 'mcpStatus': return { type: 'MCP_STATUS', servers: msg.servers };
    case 'lspDiagnostics': return { type: 'ERROR', message: 'LSP diagnostics routed incorrectly', recoverable: true }; // LSP is handled by hover, not reducer
    case 'diff': return { type: 'DIFF', filePath: msg.filePath, original: msg.original, modified: msg.modified, lspVerified: msg.lspVerified };
    case 'refs': return { type: 'REFS', refs: msg.refs };
    case 'tokenUsage': return { type: 'TOKEN_USAGE', usage: msg.usage, cacheHitRate: msg.cacheHitRate };
    case 'done': return { type: 'DONE', turns: msg.turns, tokens: msg.tokens, summary: msg.summary, sessionId: msg.sessionId };
    case 'error': return { type: 'ERROR', message: msg.message, recoverable: msg.recoverable };
    case 'state': {
      // ★ 全量 state 同步——从 Extension Host 恢复会话状态
      // 仅同步 messages（避免覆盖流式增量 currentDelta/currentThinking）
      return {
        type: 'STATE_SYNC',
        messages: msg.state.messages,
        sessionId: msg.state.sessionId,
        turn: msg.state.turn,
        tokensUsed: msg.state.tokensUsed,
        isRunning: msg.state.isRunning,
      };
    }
  }
}

// ============================================================================
// §6 辅助
// ============================================================================

function commitDelta(state: AppState, delta: string): AppState {
  const parsed = parseContent(delta);
  const msg: ChatMessage = {
    id: nextMsgId(),
    role: 'agent',
    content: delta,
    parsedContent: parsed,
    timestamp: Date.now(),
  };
  return { ...state, messages: [...state.messages, msg] };
}

function dedupeRefs(refs: import('./types.js').ChatRef[]): import('./types.js').ChatRef[] {
  const seen = new Set<string>();
  return refs.filter(r => {
    const key = `${r.kind}:${r.target}:${r.line ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
