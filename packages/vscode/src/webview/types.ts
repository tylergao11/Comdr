/**
 * types.ts — Webview 消息类型定义
 *
 * 设计原则:
 *   - 所有消息 type 字段用作可辨识联合判别
 *   - 消息流向: ExtensionMessage (ext→ui) / WebviewMessage (ui→ext)
 *   - 导航 (click link) 和预览 (hover) 在 UI 内完成，不发消息
 *
 * Paper 依据:
 *   VL/HCC 2025: "reviewable and reversible"
 *   CUA Dashboard: "compress parallel trajectories"
 */

// ============================================================================
// §1 Extension → Webview
// ============================================================================

export type ExtensionMessage =
  // ── 会话生命周期 ──
  | { type: 'state'; state: ChatState }
  | { type: 'sessionStarted'; sessionId: string }

  // ── 配置启动画面 ──
  | { type: 'configRequired'; missingFields: string[] }
  | { type: 'engineReady' }

  // ── 流式输出 ──
  | { type: 'textDelta'; content: string }
  | { type: 'thinkingDelta'; content: string }

  // ── 工具调用 ──
  | { type: 'toolCall'; callId: string; toolName: string; args?: Record<string, unknown> }
  | { type: 'toolResult'; callId: string; toolName: string; ok: boolean; summary: string; errorCategory?: string }

  // ── 三活动条 (★ 新增) ──
  | { type: 'modelStatus'; model: string; thinking: boolean; thinkingProgress?: string }
  | { type: 'shadowStatus'; errorsFixed: number; errorsIntroduced: number; isValidating: boolean }
  | { type: 'mcpStatus'; servers: MCPServerStatusMsg[] }

  // ── LSP 诊断 (★ 新增) ──
  | { type: 'lspDiagnostics'; filePath: string; diagnostics: LSPDiagnosticMsg[]; action: 'introduced' | 'fixed' | 'snapshot' }

  // ── Diff 审批 ──
  | { type: 'diff'; filePath: string; original: string; modified: string; lspVerified?: boolean }

  // ── 引用链接 (★ 新增) ──
  | { type: 'refs'; refs: ChatRef[] }

  // ── Token 用量 ──
  | { type: 'tokenUsage'; usage: TokenUsageMsg; cacheHitRate?: number }

  // ── 终止 ──
  | { type: 'done'; turns: number; tokens: number; summary: string; sessionId: string }
  | { type: 'error'; message: string; recoverable: boolean };

// ============================================================================
// §2 Webview → Extension
// ============================================================================

export type WebviewMessage =
  | { type: 'userInput'; text: string }
  | { type: 'submitConfig'; apiKey: string; baseUrl?: string; model?: string }
  | { type: 'requestConfigSetup' }
  | { type: 'acceptDiff'; filePath: string }
  | { type: 'rejectDiff'; filePath: string; reason?: string }
  | { type: 'abortTask' }
  | { type: 'retryFix'; filePath: string; instruction?: string }
  | { type: 'clickRef'; ref: ChatRef }                         // ★ 链接点击 → 导航
  | { type: 'requestFileContext'; filePath: string };          // ★ 请求文件语义信息

// ============================================================================
// §3 应用状态 (Reducer 管理)
// ============================================================================

export interface AppState {
  sessionId: string | null;
  turn: number;
  tokensUsed: number;
  isRunning: boolean;

  // 配置启动画面
  setupRequired: boolean;
  setupMissing: string[];

  // 对话
  messages: ChatMessage[];
  currentDelta: string;
  currentThinking: string;

  // 三活动条
  modelBar: ModelBarState;
  shadowBar: ShadowBarState;
  mcpBar: MCPBarState;

  // 面板状态
  mcpPanelVisible: boolean;
  brainPanelVisible: boolean;

  // Diff
  activeDiff: DiffState | null;

  // 链接引用
  refs: ChatRef[];

  // 错误
  error: AppError | null;

  // 悬浮 (UI 内部，不放 state)
  // hoverRef 在组件本地 useState 管理
}

export interface ModelBarState {
  model: string;
  thinking: boolean;
  thinkingProgress: string | null;
  cacheHitRate: number | null;
}

export interface ShadowBarState {
  showing: boolean;           // 是否有 Shadow Workspace 活动
  isValidating: boolean;
  lastResult: { errorsFixed: number; errorsIntroduced: number } | null;
}

export interface MCPBarState {
  servers: MCPServerStatusMsg[];
  activeCount: number;
}

export interface DiffState {
  filePath: string;
  original: string;
  modified: string;
  lspVerified: boolean | null;
}

export interface AppError {
  message: string;
  recoverable: boolean;
}

// ============================================================================
// §4 ChatMessage — 增强版 (★ 支持结构化链接和悬浮预览)
// ============================================================================

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;                          // 原始 Markdown
  parsedContent: ParsedContent | null;      // ★ 解析后的结构化内容
  diff?: DiffState;
  toolCall?: { callId: string; name: string; ok?: boolean; summary?: string };
  tokenUsage?: TokenUsageMsg;
  refs?: ChatRef[];
  timestamp: number;
}

/**
 * ★ 解析后的消息内容——每个 segment 是一个内联块
 */
export interface ParsedContent {
  segments: ContentSegment[];
}

export type ContentSegment =
  | { type: 'text'; text: string }
  | { type: 'fileRef'; path: string; line?: number; display: string; hover?: string }
  | { type: 'symbolRef'; symbol: string; file?: string; display: string; hover?: string }
  | { type: 'lspRef'; count: number; severity: LSPDiagnosticSeverity; filePath: string; display: string }
  | { type: 'shadowRef'; errorsFixed: number; errorsIntroduced: number; display: string }
  | { type: 'turnRef'; turn: number; display: string };

// ============================================================================
// §5 引用 (可点击链接)
// ============================================================================

export interface ChatRef {
  kind: 'file' | 'symbol' | 'lsp' | 'shadow' | 'turn';
  label: string;
  target: string;
  line?: number;
  hover?: string;
}

export type LSPDiagnosticSeverity = 'error' | 'warning' | 'hint';

export interface LSPDiagnosticMsg {
  file: string;
  line: number;
  column: number;
  severity: LSPDiagnosticSeverity;
  message: string;
  code?: string;
  source?: string;
}

// ============================================================================
// §6 辅助类型
// ============================================================================

export interface ChatState {
  sessionId: string | null;
  turn: number;
  tokensUsed: number;
  isRunning: boolean;
  messages: ChatMessage[];
}

export interface TokenUsageMsg {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export interface MCPServerStatusMsg {
  name: string;
  status: 'connected' | 'connecting' | 'offline' | 'error';
  tools: string[];
  activeTool?: string;
}
