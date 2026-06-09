/**
 * tui.tsx — Comdr 终端界面
 *
 * Ink 7 + React 19。专为 DeepSeek reasoning 流式输出设计。
 *
 * 设计原则：
 *   - 双通道流式（thinking_delta + text_delta）独立渲染
 *   - thinking 有闪烁光标 → 完成自动折叠
 *   - thinking → text 切换有 ── ✦ ── 视觉转场
 *   - 右面板紧凑单屏（State + Intent 合并）
 *   - 配色：暖橙 accent，深灰辅助，克制使用
 *
 * @agent Agent 5 — TUI 渲染器
 */

import { render, Box, Text, Static, useInput, useApp, useStdout } from 'ink';
import React, { useState, useEffect, useReducer, useCallback, useMemo, useRef } from 'react';
import type { AgentEvent, IEngine, RunMode, RunResult, StateEntry, IntentEntry, ToolCall, MCPServerStatus, ToolResult } from '@comdr/core';
import { AGENT_EVENT, RUN_MODE, SYSTEM, SERVER_STATUS } from '@comdr/core';

// ============================================================================
// 颜色系统（克制调色板）
// ============================================================================

const C = {
  accent:    '#c46b3d',   // 暖橙 — 品牌色
  dim:       '#888888',   // 次级文本
  good:      '#5a9e6f',   // 成功（柔和绿）
  warn:      '#d4a853',   // 警告（暖金）
  bad:       '#d4574a',   // 错误（柔和红）
  think:     '#9b8e7c',   // thinking 文本（暖灰）
  border:    '#3a3a3a',   // 面板边框
  brand:     '#c46b3d',   // 同 accent
} as const;

// ============================================================================
// 类型
// ============================================================================

interface MessageItem {
  id: string;
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'warning' | 'error' | 'info' | 'separator';
  content: string;
  detail?: string;
  timestamp: number;
}

interface UIState {
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
}

type UIAction =
  | { type: 'AGENT_EVENT'; event: AgentEvent }    // ★ 直接消费 AgentEvent，不再逐变体翻译
  | { type: 'RUN_START' }
  | { type: 'RESET'; sessionId: string }
  | { type: 'USER_INPUT'; text: string }
  | { type: 'SYNC_WINDOWS'; stateWindow: StateEntry[]; intentWindow: IntentEntry[] }
  | { type: 'MCP_CONNECTED'; name: string; transport: 'stdio' | 'tcp'; pid?: number }
  | { type: 'MCP_DISCONNECTED'; name: string }
  | { type: 'MCP_ERROR'; name: string; error: string };

// ============================================================================
// 工具函数
// ============================================================================

function uid(): string {
  return Math.random().toString(36).slice(2, 8);
}
/**
 * 词/字边界安全的展示截断。
 * - 不需要硬截断，在 word/grapheme 边界处断
 * - 中文/emoji 安全：使用 Intl.Segmenter 避免切断多字节字符
 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;

  // Intl.Segmenter 提供 grapheme-cluster 级别的分割
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  } catch {
    // 极旧环境 → 降级到字符截断
    return s.slice(0, max - 1) + '…';
  }

  const target = max - 1; // 预留给省略号
  let cutAt = 0;
  for (const seg of segmenter.segment(s)) {
    if (seg.index <= target) cutAt = seg.index;
    else break;
  }

  // 如果在单词中间（ASCII），回退到上一个空格/标点
  if (cutAt > 0 && cutAt < s.length) {
    const charBefore = s[cutAt - 1]!;
    const charAfter = s[cutAt]!;
    if (/\w/.test(charBefore) && /\w/.test(charAfter)) {
      for (let i = cutAt - 1; i > 0; i--) {
        if (/[\s,.;:!?\-)\]}>]/.test(s[i]!)) {
          cutAt = i + 1;
          break;
        }
      }
    }
  }

  return s.slice(0, Math.max(1, cutAt)) + '…';
}
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s}s`;
}

function toolDisplayName(name: string, argsJson?: string): string {
  if (name === 'mcp_call') {
    try {
      if (argsJson) {
        const args = JSON.parse(argsJson) as Record<string, unknown>;
        const server = typeof args['server'] === 'string' ? args['server'] : null;
        const tool = typeof args['tool'] === 'string' ? args['tool'] : null;
        if (server && tool) return `📡 ${server} → ${tool}`;
        if (server) return `📡 ${server}`;
      }
    } catch { /* fall through */ }
    return '📡 mcp';
  }
  const map: Record<string, string> = {
    file_read: '📖 read', file_write: '✏️ write', file_edit: '✏️ edit',
    file_glob: '🔍 glob', file_grep: '🔎 grep', file_ls: '📂 ls',
    shell_bash: '⚡ bash',
    git_diff: '📋 diff', git_status: '📋 status', git_log: '📋 log',
    git_add: '📋 add', git_commit: '📋 commit', git_revert: '↩ revert',
    lsp_symbols: '🔬 symbols', lsp_diagnostics: '🔬 diagnostics',
  };
  return map[name] ?? `🔧 ${name}`;
}

/** 计数 thinking 段——按空行分割 */
function countThinkingSegments(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);
}

// ============================================================================
// Reducer
// ============================================================================

function uiReducer(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    // ★ 一站式 AgentEvent → 不再逐变体 dispatch
    case 'AGENT_EVENT': {
      const event = action.event;
      switch (event.type) {
        case AGENT_EVENT.TEXT_DELTA:
          return { ...state, streamingText: state.streamingText + event.content };

        case AGENT_EVENT.THINKING_DELTA:
          return { ...state, streamingThinking: state.streamingThinking + event.content };

        case AGENT_EVENT.TOOL_CALL: {
          const next = new Map(state.activeToolCalls);
          next.set(event.call.id, { call: event.call, status: 'running' });
          return { ...state, activeToolCalls: next };
        }

        case AGENT_EVENT.TOOL_RESULT: {
          const next = new Map(state.activeToolCalls);
          const existing = next.get(event.result.callId);
          next.delete(event.result.callId);

          const messages = state.messages;
          const fresh: MessageItem[] = [];

          // Flush thinking → collapsed message
          if (state.streamingThinking.trim()) {
            const segments = countThinkingSegments(state.streamingThinking);
            const label = segments.length > 1
              ? `${segments.length} 段思考: ${truncate(segments[0] ?? '', 40)}`
              : truncate(segments[0] ?? 'thinking', 60);
            fresh.push({
              id: `think-${uid()}`,
              type: 'thinking',
              content: state.streamingThinking.trim(),
              detail: label,
              timestamp: Date.now(),
            });
          }
          // Flush streaming text
          if (state.streamingText.trim()) {
            fresh.push({
              id: `text-${uid()}`,
              type: 'text',
              content: state.streamingText.trim(),
              timestamp: Date.now(),
            });
          }

          // ★ 直接用 event.result.toolName，不再跨索引查找
          const name = event.result.toolName;
          const argsJson = existing?.call.function.arguments;
          const displayName = toolDisplayName(name, argsJson);
          fresh.push({
            id: `call-${uid()}`,
            type: 'tool_call',
            content: displayName,
            detail: argsJson,
            timestamp: Date.now(),
          });
          fresh.push({
            id: `result-${uid()}`,
            type: 'tool_result',
            content: event.result.ok
              ? `✓ ${event.result.diffSummary ?? event.result.content ?? 'OK'}`
              : `✗ ${event.result.errorCategory ?? 'execution_error'}`,
            detail: event.result.content ?? undefined,
            timestamp: Date.now(),
          });

          return {
            ...state,
            messages: [...messages, ...fresh],
            streamingText: '',
            streamingThinking: '',
            activeToolCalls: next,
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
            status: {
              ...state.status,
              sessionId: event.sessionId,
              mode: event.mode,
            },
          };

        case AGENT_EVENT.TURN_BEGIN:
          return {
            ...state,
            status: {
              ...state.status,
              turn: event.turn,
              tokensUsed: event.tokensUsed,
            },
          };

        case AGENT_EVENT.TOKEN_USAGE:
          return {
            ...state,
            status: {
              ...state.status,
              tokensUsed: state.status.tokensUsed
                + event.usage.promptTokens
                + event.usage.completionTokens,
            },
          };

        case AGENT_EVENT.MCP_STATUS:
          return { ...state, mcpServers: event.servers };

        case AGENT_EVENT.DONE: {
          let msgs = state.messages;
          if (state.streamingText.trim()) {
            msgs = [...msgs, {
              id: `text-${uid()}`, type: 'text' as const,
              content: state.streamingText.trim(), timestamp: Date.now(),
            }];
          }
          if (state.streamingThinking.trim()) {
            const segments = countThinkingSegments(state.streamingThinking);
            msgs = [...msgs, {
              id: `think-${uid()}`, type: 'thinking' as const,
              content: state.streamingThinking.trim(),
              detail: `${segments.length} 段思考`,
              timestamp: Date.now(),
            }];
          }
          return {
            ...state, messages: msgs,
            streamingText: '', streamingThinking: '',
            running: false, finished: true,
            summary: event.result.summary,
            status: {
              ...state.status,
              turn: event.result.turns,
              tokensUsed: event.result.tokensUsed,
            },
          };
        }

        case AGENT_EVENT.ERROR:
          // ★ 可恢复错误 → 记录消息但不停止 UI；不可恢复 → 终止
          return {
            ...state,
            running: event.recoverable ? state.running : false,
            finished: !event.recoverable,
            fatalError: event.recoverable ? null : event.message,
            messages: [...state.messages, {
              id: `err-${uid()}`, type: 'error' as const,
              content: `✗ ${event.code}: ${event.message}`, timestamp: Date.now(),
            }],
          };

        default:
          return state;
      }
    }

    case 'RUN_START':
      return { ...state, running: true, finished: false };

    case 'RESET':
      return createInitialState(action.sessionId, state.status.mode);

    case 'USER_INPUT':
      return {
        ...state,
        messages: [...state.messages, {
          id: `user-${uid()}`, type: 'text' as const,
          content: action.text, timestamp: Date.now(),
        }],
      };

    case 'SYNC_WINDOWS':
      return { ...state, stateWindow: action.stateWindow, intentWindow: action.intentWindow };

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

    default:
      return state;
  }
}

function createInitialState(sessionId: string, mode: RunMode): UIState {
  return {
    streamingText: '', streamingThinking: '',
    messages: [{
      id: 'welcome', type: 'info',
      content: `Comdr v0.1.0 — ${mode === 'plan' ? 'Plan · 只读分析' : mode === 'yolo' ? 'YOLO · 全自动' : 'Agent · 逐步确认'}`,
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
  };
}

// ============================================================================
// 组件：状态栏（两行宽松设计）
// ============================================================================

function StatusBar({ status }: { status: UIState['status'] }) {
  const pct = status.tokenBudget > 0 ? Math.round((status.tokensUsed / status.tokenBudget) * 100) : 0;
  const barW = 12;
  const filled = Math.min(Math.round((pct / 100) * barW), barW);
  const bar = '█'.repeat(filled) + '░'.repeat(barW - filled);
  const modeLabel = status.mode === 'plan' ? '📋 plan' : status.mode === 'yolo' ? '⚡ yolo' : '🤖 agent';

  return (
    <Box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={0} paddingBottom={0}>
      {/* Row 1: brand + mode */}
      <Box justifyContent="space-between">
        <Text color={C.accent} bold>Comdr</Text>
        <Box gap={2}>
          <Text>{modeLabel}</Text>
          <Text color={C.dim}>{truncate(status.sessionId, 10)}</Text>
        </Box>
      </Box>
      {/* Row 2: turn · tokens · thinking */}
      <Box gap={2}>
        <Text color={C.dim}>
          T<Text color={C.accent}>{String(status.turn)}</Text>/{String(status.maxTurns)}
        </Text>
        <Text color={C.dim}>
          <Text>{bar}</Text>{' '}
          <Text color={C.accent}>{formatTokens(status.tokensUsed)}</Text>
          <Text>/{formatTokens(status.tokenBudget)}</Text>
        </Text>
        <Text color={C.dim}>🧠 {status.thinking}</Text>
      </Box>
    </Box>
  );
}

// ============================================================================
// 组件：消息行
// ============================================================================

function MessageLine({ msg, expanded }: { msg: MessageItem; expanded?: boolean }) {
  const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  switch (msg.type) {
    case 'separator':
      return (
        <Box paddingLeft={1}>
          <Text color={C.dim}>{'  ── ✦ ──'}</Text>
        </Box>
      );

    case 'thinking': {
      // Completed thinking: show as collapsible block
      const segments = countThinkingSegments(msg.content);
      const label = msg.detail ?? `${segments.length} 段思考`;
      if (!expanded) {
        return (
          <Box paddingLeft={1}>
            <Text color={C.think}>▶ 💭 {label}</Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column" paddingLeft={1}>
          <Box>
            <Text color={C.think}>▼ 💭 {label}</Text>
          </Box>
          {segments.map((seg, i) => (
            <Box key={i} paddingLeft={4}>
              <Text color={C.think} italic>{`#${i + 1}  ${truncate(seg, 120)}`}</Text>
            </Box>
          ))}
        </Box>
      );
    }

    case 'text':
      return (
        <Box paddingLeft={1}>
          <Text color={C.dim}>{time}  </Text>
          <Text>{msg.content}</Text>
        </Box>
      );

    case 'tool_call':
      return (
        <Box paddingLeft={1}>
          <Text color={C.dim}>{time}  </Text>
          <Text color={C.accent}>{msg.content}</Text>
          {msg.detail ? <Text color={C.dim}>  {truncate(msg.detail, 55)}</Text> : null}
        </Box>
      );

    case 'tool_result':
      return (
        <Box paddingLeft={3}>
          <Text color={msg.content.startsWith('✓') ? C.good : C.bad}>{msg.content}</Text>
        </Box>
      );

    case 'warning':
      return (
        <Box paddingLeft={1}>
          <Text color={C.warn}>{msg.content}</Text>
        </Box>
      );

    case 'error':
      return (
        <Box paddingLeft={1}>
          <Text color={C.bad}>{msg.content}</Text>
        </Box>
      );

    case 'info':
      return (
        <Box paddingLeft={1}>
          <Text color={C.dim}>{msg.content}</Text>
        </Box>
      );

    default:
      return (
        <Box paddingLeft={1}>
          <Text>{msg.content}</Text>
        </Box>
      );
  }
}

// ============================================================================
// 组件：活跃工具指示器
// ============================================================================

function ActiveTools({ tools }: { tools: Map<string, { call: ToolCall; status: string }> }) {
  if (tools.size === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {Array.from(tools.values()).map(t => {
        const isMCP = t.call.function.name === 'mcp_call';
        return (
          <Box key={t.call.id}>
            <Text color={C.warn}>⏳ </Text>
            <Text color={isMCP ? C.accent : undefined}>
              {toolDisplayName(t.call.function.name, t.call.function.arguments)}
            </Text>
            <Text color={C.dim}> — {isMCP ? 'connecting...' : 'executing...'}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ============================================================================
// 组件：Live Thinking（流式进行中）
// ============================================================================

function LiveThinking({ text, blink, show }: { text: string; blink: boolean; show: boolean }) {
  if (!text) return null;
  const lastLine = text.split('\n').filter(Boolean).pop() ?? text;
  const segCount = countThinkingSegments(text).length;

  // ★ 折叠状态：单行占位，高度稳定。展开状态：完整内容。
  if (!show) {
    return (
      <Box paddingLeft={1} height={1}>
        <Text color={C.think}>💭 </Text>
        <Text color={C.dim}>{segCount} 段 · Ctrl+T 展开</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box>
        <Text color={C.think}>💭 </Text>
        <Text color={C.think} italic>{truncate(lastLine, 200)}</Text>
        <Text color={C.accent}>{blink ? '▍' : ' '}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color={C.dim}>{segCount} 段 · Ctrl+T 折叠</Text>
      </Box>
    </Box>
  );
}

// ============================================================================
// 组件：Live Text（正文流式进行中）
// ============================================================================

function LiveText({ text, blink }: { text: string; blink: boolean }) {
  if (!text) return null;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box>
        <Text>{text.slice(-500)}</Text>
        <Text color={C.accent}>{blink ? '▍' : ' '}</Text>
      </Box>
    </Box>
  );
}

// ============================================================================
// 组件：Thinking ↔ Text 转场分隔
// ============================================================================

function TransitionSeparator({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <Box paddingLeft={1}>
      <Text color={C.dim}>  ── ✦ ──</Text>
    </Box>
  );
}

// ============================================================================
// 组件：右面板（Memory 合并 + MCP 紧凑）
// ============================================================================

function MemoryPanel({ stateEntries, intentEntries }: { stateEntries: StateEntry[]; intentEntries: IntentEntry[] }) {
  const hasState = stateEntries.length > 0;
  const hasIntent = intentEntries.length > 0;

  if (!hasState && !hasIntent) {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor={C.border} paddingLeft={1} paddingRight={1}>
        <Box><Text bold color={C.accent}>📊 Memory</Text></Box>
        <Box><Text color={C.dim}>{'─'.repeat(28)}</Text></Box>
        <Box><Text color={C.dim}>  等待 agent 开始工作…</Text></Box>
      </Box>
    );
  }

  // 合并展示：S = State (WHAT), I = Intent (WHY)
  const lines: { key: string; label: string; text: string; color: string }[] = [];
  for (const e of stateEntries) {
    lines.push({ key: `s-${e.key}`, label: 'S', text: `${truncate(e.key, 16)} → ${e.text}`, color: C.dim });
  }
  for (const e of intentEntries) {
    lines.push({ key: `i-${e.key}`, label: 'I', text: `→ ${e.why}`, color: C.dim });
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={C.border} paddingLeft={1} paddingRight={1}>
      <Box><Text bold color={C.accent}>📊 Memory</Text></Box>
      <Box><Text color={C.dim}>{'─'.repeat(28)}</Text></Box>
      {lines.map(l => (
        <Box key={l.key}>
          <Text color={l.label === 'S' ? C.accent : C.think}>{l.label} </Text>
          <Text color={l.color}>{truncate(l.text, 26)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function MCPServerPanel({ servers }: { servers: MCPServerStatus[] }) {
  if (servers.length === 0) return null;

  const sym = (s: MCPServerStatus) =>
    s.status === SERVER_STATUS.CONNECTED ? '◉' : s.status === SERVER_STATUS.CONNECTING ? '◔' : s.status === SERVER_STATUS.ERROR ? '✗' : '○';
  const sc = (s: MCPServerStatus) =>
    s.status === SERVER_STATUS.CONNECTED ? C.good : s.status === SERVER_STATUS.CONNECTING ? C.warn : s.status === SERVER_STATUS.ERROR ? C.bad : C.dim;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={C.border} paddingLeft={1} paddingRight={1} marginTop={1}>
      <Box><Text bold color={C.accent}>📡 MCP</Text></Box>
      <Box><Text color={C.dim}>{'─'.repeat(28)}</Text></Box>
      {servers.map(s => (
        <Box key={s.name} flexDirection="column">
          <Box>
            <Text color={sc(s)}>{sym(s)} </Text>
            <Text>{s.name}</Text>
            <Text color={C.dim}>  {s.transport === 'stdio' ? '🔌' : '🌐'}</Text>
          </Box>
          <Box paddingLeft={3}>
            <Text color={C.dim}>
              {s.status === SERVER_STATUS.CONNECTED && s.uptime !== undefined
                ? `↑${formatUptime(s.uptime)}`
                : s.status === SERVER_STATUS.CONNECTING ? 'connecting...' : ''}
              {s.pid ? `  pid:${s.pid}` : ''}
            </Text>
            {s.status === SERVER_STATUS.ERROR && s.error ? (
              <Text color={C.bad}>  {truncate(s.error, 20)}</Text>
            ) : null}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

// ============================================================================
// 组件：YOLO 横幅
// ============================================================================

function YoloBanner() {
  return (
    <Box paddingLeft={2} paddingRight={2}>
      <Text backgroundColor={C.warn} color="black" bold> ⚡ YOLO — destructive actions auto-approved </Text>
    </Box>
  );
}

// ============================================================================
// 组件：进度警告
// ============================================================================

function ProgressWarning({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Box paddingLeft={2} paddingRight={2}>
      <Text color={C.warn} bold>⚠ {message}</Text>
    </Box>
  );
}

// ============================================================================
// 组件：输入栏
// ============================================================================

function InputBar({ onSubmit, disabled }: { onSubmit: (text: string) => void; disabled: boolean }) {
  const [buffer, setBuffer] = useState('');
  const inputRef = useRef('');

  useInput((input, key) => {
    if (disabled) return;
    if (key.return) {
      const trimmed = inputRef.current.trim();
      if (trimmed) { onSubmit(trimmed); inputRef.current = ''; setBuffer(''); }
    } else if (key.backspace || key.delete) {
      inputRef.current = inputRef.current.slice(0, -1);
      setBuffer(inputRef.current);
    } else if (input && !key.ctrl && !key.meta) {
      inputRef.current += input;
      setBuffer(inputRef.current);
    }
  });

  return (
    <Box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <Text color={C.accent} bold>{'→ '}</Text>
      <Text>{buffer}</Text>
      <Text color={C.dim}>{' ▍'}</Text>
    </Box>
  );
}

// ============================================================================
// 主组件
// ============================================================================

interface AppProps {
  engine: IEngine;
  mode: RunMode;
  initialInput?: string;
}

function App({ engine, mode, initialInput }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;

  const HEADER_H = mode === 'yolo' ? 3 : 2;
  const FOOTER_H = mode === 'yolo' ? 0 : 1;
  const RIGHT_W = 28;
  const BODY_H = Math.max(8, rows - HEADER_H - FOOTER_H);

  const sessionId = useMemo(() => `comdr-${uid()}`, []);
  const [state, dispatch] = useReducer(uiReducer, createInitialState(sessionId, mode));
  const [showThinking, setShowThinking] = useState(true);
  const [expandedThinkIds, setExpandedThinkIds] = useState<Set<string>>(new Set());
  const [blink, setBlink] = useState(true);

  // 闪烁光标：流式期间 530ms 周期
  useEffect(() => {
    if (state.streamingThinking || state.streamingText) {
      const id = setInterval(() => setBlink(b => !b), 530);
      return () => clearInterval(id);
    }
    setBlink(true);
  }, [state.streamingThinking, state.streamingText]);

  // 初始同步——双窗口由 Engine.getSession() 提供, MCP 由 mcp_status 事件推送
  useEffect(() => {
    const s = engine.getSession();
    dispatch({ type: 'SYNC_WINDOWS', stateWindow: s.stateWindow, intentWindow: s.intentWindow });
  }, [engine]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedThinkIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const runUserInput = useCallback(async (input: string) => {
    dispatch({ type: 'RESET', sessionId });
    dispatch({ type: 'USER_INPUT', text: input });
    dispatch({ type: 'RUN_START' });

    try {
      for await (const event of engine.run(input, mode, sessionId)) {
        // ★ 一站式 dispatch——reducer 内部按 event.type 分发
        dispatch({ type: 'AGENT_EVENT', event });

        // 工具结果后同步双窗口
        if (event.type === AGENT_EVENT.TOOL_RESULT) {
          const s = engine.getSession();
          dispatch({ type: 'SYNC_WINDOWS', stateWindow: s.stateWindow, intentWindow: s.intentWindow });
        }

        // done / irrecoverable error → 停止消费
        if (event.type === AGENT_EVENT.DONE) return;
        if (event.type === AGENT_EVENT.ERROR && !event.recoverable) return;
      }
    } catch (err) {
      dispatch({ type: 'AGENT_EVENT', event: { type: AGENT_EVENT.ERROR, code: 'ENGINE_CRASH', message: String(err), recoverable: false } });
    }

    // ★ 安全兜底: 如果引擎未 yield DONE 就返回了
    dispatch({
      type: 'AGENT_EVENT',
      event: {
        type: AGENT_EVENT.DONE,
        result: { ok: false, turns: 0, tokensUsed: 0, summary: '引擎已停止（未收到完成事件）', sessionId },
      },
    });
  }, [engine, mode, sessionId]);

  // 快捷键
  useInput((input, key) => {
    if (!key.ctrl) return;
    switch (input) {
      case 'c': engine.abort(); exit(); break;
      case 't': setShowThinking(prev => !prev); break;
      case 'l': dispatch({ type: 'RESET', sessionId }); break;
    }
  });

  // 自动运行
  useEffect(() => { if (initialInput) runUserInput(initialInput); }, [initialInput]);

  // 分隔线是否显示
  const showSeparator = !!(state.streamingThinking && state.streamingText);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {/* ================================================================
          HEADER — 绝对定位钉在顶部。永不移动。
          ================================================================ */}
      <Box position="absolute" top={0} left={0} width={cols} height={HEADER_H} flexDirection="column">
        <StatusBar status={state.status} />
        {mode === 'yolo' && <YoloBanner />}
      </Box>
      <Box position="absolute" top={HEADER_H} left={0} width={cols}>
        <ProgressWarning message={state.progressWarning} />
      </Box>

      {/* ================================================================
          RIGHT PANEL — 绝对定位钉在右侧。永不移动。
          ================================================================ */}
      <Box
        position="absolute"
        top={HEADER_H + 1}
        right={0}
        width={RIGHT_W}
        height={BODY_H - 1}
        flexDirection="column"
        paddingRight={1}
      >
        <MemoryPanel stateEntries={state.stateWindow} intentEntries={state.intentWindow} />
        <MCPServerPanel servers={state.mcpServers} />
      </Box>

      {/* ================================================================
          CHAT — 流式区域。唯一会"动"的内容。
          ================================================================ */}
      <Box
        flexDirection="column"
        marginTop={HEADER_H + 1}
        paddingLeft={2}
        marginRight={RIGHT_W}
        height={BODY_H - 1}
        overflowY="hidden"
      >
        <Static items={state.messages}>
          {(msg: MessageItem) => {
            if (msg.type === 'thinking') {
              return (
                <MessageLine
                  key={msg.id}
                  msg={msg}
                  expanded={expandedThinkIds.has(msg.id)}
                />
              );
            }
            return <MessageLine key={msg.id} msg={msg} />;
          }}
        </Static>

        {/* Live streaming — always rendered to keep layout stable */}
        <LiveThinking text={state.streamingThinking} blink={blink} show={showThinking} />
        {showSeparator && <TransitionSeparator show={true} />}
        <LiveText text={state.streamingText} blink={blink} />
        <ActiveTools tools={state.activeToolCalls} />
      </Box>

      {/* ================================================================
          FOOTER — 绝对定位钉在底部。永不移动。
          ================================================================ */}
      {mode !== 'yolo' && (
        <Box position="absolute" bottom={0} left={0} width={cols} height={FOOTER_H}>
          <InputBar onSubmit={runUserInput} disabled={state.running} />
        </Box>
      )}

      {/* 完成摘要 */}
      {state.finished && state.summary ? (
        <Box position="absolute" bottom={FOOTER_H} left={0} paddingLeft={2}>
          <Text color={state.fatalError ? C.bad : C.good}>
            {state.fatalError ? `✗ ${state.fatalError}` : `✓ ${state.summary}`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ============================================================================
// 公开 API
// ============================================================================

interface StartTUIOptions {
  engine: IEngine;
  mode: RunMode;
  initialInput?: string;
}

export function startTUI(opts: StartTUIOptions): ReturnType<typeof render> {
  const { engine, mode, initialInput } = opts;

  // ★ 检查 stdin 是否支持 raw mode（Windows 下需要特别处理）
  const stdin = process.stdin;
  const isRawModeSupported =
    stdin.isTTY && typeof stdin.setRawMode === 'function';

  if (!isRawModeSupported) {
    // 降级模式：仍可启动，但 useInput 键绑定不工作
    console.warn(
      '[Comdr] stdin does not support raw mode. Interactive input disabled.\n' +
        '  Run in a proper terminal for full TUI experience.\n' +
        '  Use comdr exec "<prompt>" for non-interactive mode.',
    );
  }

  const instance = render(React.createElement(App, { engine, mode, initialInput }), {
    stdin: isRawModeSupported ? stdin : undefined,
    exitOnCtrlC: true,
    patchConsole: false,
  });

  return instance;
}

export async function streamToCLI(
  engine: IEngine,
  input: string,
  mode: RunMode,
): Promise<RunResult> {
  let result: RunResult = { ok: true, turns: 0, tokensUsed: 0, summary: '', sessionId: '' };
  for await (const event of engine.run(input, mode)) {
    switch (event.type) {
      case AGENT_EVENT.TEXT_DELTA: process.stdout.write(event.content); break;
      case AGENT_EVENT.THINKING_DELTA: break;
      case AGENT_EVENT.TOOL_CALL:
        console.log(`\n⏳ ${toolDisplayName(event.call.function.name)}`);
        break;
      case AGENT_EVENT.TOOL_RESULT:
        console.log(`  ${event.result.ok ? '✓' : '✗'} ${event.result.diffSummary ?? event.result.content ?? ''}`);
        break;
      case AGENT_EVENT.PROGRESS_WARNING: console.log(`\n⚠ ${event.message}`); break;
      case AGENT_EVENT.DONE:
        console.log(`\n✓ Done — ${event.result.turns} turns, ${formatTokens(event.result.tokensUsed)} tokens`);
        result = { ok: true, turns: event.result.turns, tokensUsed: event.result.tokensUsed, summary: event.result.summary, sessionId: '' };
        break;
      case AGENT_EVENT.ERROR:
        console.error(`\n✗ ${event.code}: ${event.message}`);
        result = { ok: false, turns: 0, tokensUsed: 0, summary: `${event.code}: ${event.message}`, sessionId: '' };
        break;
    }
  }
  return result;
}

export { RUN_MODE };
