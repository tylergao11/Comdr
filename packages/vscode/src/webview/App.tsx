/**
 * App.tsx — Comdr Webview 根组件
 *
 * 布局: 主区域 (Chat) + 右侧面板 (按需滑入)
 *   ┌─ ActivityBar ──────────────────────────────────┐
 *   │ ▸ Pro ● thinking  ▸ Shadow ✓  ▸ MCP ● 1 runn. │
 *   ├──────────────────────┬──────────────────────────┤
 *   │ Chat                 │ Panel (条件渲染)          │
 *   │  · 消息               │  · MCP 或 Brain          │
 *   │  · Diff 审批          │                          │
 *   │  · 流式增量           │                          │
 *   ├──────────────────────┴──────────────────────────┤
 *   │ Input Box                                        │
 *   └──────────────────────────────────────────────────┘
 *
 * 状态管理: useReducer (移植自 tui/reducer.ts 模式)
 */

import { useReducer, useCallback, useRef, useEffect } from 'react';
import type { AppState, ExtensionMessage, WebviewMessage } from './types.js';
import {
  appReducer,
  initialAppState,
  mapMessageToAction,
} from './reducer.js';
import { ActivityBar } from './ActivityBar.js';
import { ChatView } from './ChatView.js';
import { ConfigSetup } from './ConfigSetup.js';
import { MCPPanel } from './MCPPanel.js';
import { BrainPanel } from './BrainPanel.js';
import { theme } from './styles.js';
import { vscodeApi } from './vscode-api.js';

const vscode = vscodeApi;

// ============================================================================
// Error Boundary — 捕获 React 渲染树中的任何崩溃
// ============================================================================

import { Component } from 'react';

class ErrorBoundary extends Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[Comdr] ErrorBoundary caught:', error, info);
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{
          color: '#f14c4c',
          padding: '24px',
          fontFamily: 'monospace',
          background: '#1e1e1e',
          height: '100vh',
          overflow: 'auto',
        }}>
          <h2 style={{ marginTop: 0 }}>Comdr — UI Error</h2>
          <pre style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            fontSize: '12px',
            lineHeight: '1.5',
          }}>
            {this.state.error.stack || this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================================================

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(appReducer, null, initialAppState);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── Extension → Webview: 消息监听 ──────────────────────────
  useEffect(() => {
    const handler = (e: MessageEvent<ExtensionMessage>): void => {
      const action = mapMessageToAction(e.data);
      dispatch(action);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // ── 持久化 state ───────────────────────────────────────────
  useEffect(() => {
    vscode.setState(state);
  }, [state]);

  // ── 链接点击 → 文件导航 ────────────────────────────────────
  const handleFileClick = useCallback((path: string, line?: number): void => {
    vscode.postMessage({
      type: 'clickRef',
      ref: { kind: 'file', label: path, target: path, line },
    } as WebviewMessage);
  }, []);

  // ── Diff 操作 ──────────────────────────────────────────────
  const handleAcceptDiff = useCallback((filePath: string): void => {
    vscode.postMessage({ type: 'acceptDiff', filePath } as WebviewMessage);
    dispatch({ type: 'DISMISS_DIFF' });
  }, []);

  const handleRejectDiff = useCallback((filePath: string): void => {
    vscode.postMessage({ type: 'rejectDiff', filePath } as WebviewMessage);
    dispatch({ type: 'DISMISS_DIFF' });
  }, []);

  const handleDismissDiff = useCallback((): void => {
    dispatch({ type: 'DISMISS_DIFF' });
  }, []);

  // ── 面板开关 ───────────────────────────────────────────────
  const handleToggleMCP = useCallback((): void => {
    dispatch({ type: 'TOGGLE_MCP_PANEL' });
  }, []);

  const handleToggleBrain = useCallback((): void => {
    dispatch({ type: 'TOGGLE_BRAIN_PANEL' });
  }, []);

  // ── 发送消息 ───────────────────────────────────────────────
  const handleSend = useCallback((text: string): void => {
    if (!text.trim() || state.isRunning) return;

    dispatch({ type: 'USER_INPUT', text });
    vscode.postMessage({ type: 'userInput', text } as WebviewMessage);

    // 清空输入框
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, [state.isRunning]);

  // ── 终止 ───────────────────────────────────────────────────
  const handleAbort = useCallback((): void => {
    vscode.postMessage({ type: 'abortTask' } as WebviewMessage);
  }, []);

  const handleRetry = useCallback((): void => {
    dispatch({ type: 'CLEAR_ERROR' });
  }, []);

  // ── 重新配置 API key ──────────────────────────────────────
  const handleReconfig = useCallback((): void => {
    vscode.postMessage({ type: 'requestConfigSetup' } as WebviewMessage);
    dispatch({ type: 'CONFIG_REQUIRED', missingFields: [] });
  }, []);

  // ── 面板可见性 ─────────────────────────────────────────────
  const panelVisible = state.mcpPanelVisible || state.brainPanelVisible;

  // ── Setup 模式 ──────────────────────────────────────────────
  if (state.setupRequired) {
    return (
      <ErrorBoundary>
        <div style={styles.container}>
          <ConfigSetup missingFields={state.setupMissing} />
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
    <div style={styles.container}>
      {/* ======== 活动条 ======== */}
      <ActivityBar
        modelBar={state.modelBar}
        shadowBar={state.shadowBar}
        mcpBar={state.mcpBar}
        onToggleMCP={handleToggleMCP}
        onToggleBrain={handleToggleBrain}
        onAbort={handleAbort}
        onReconfig={handleReconfig}
        isRunning={state.isRunning}
      />

      {/* ======== 主区域 ======== */}
      <div style={styles.main}>
        <div style={styles.chatPanel}>
          <ChatView
            messages={state.messages}
            currentDelta={state.currentDelta}
            currentThinking={state.currentThinking}
            error={state.error}
            isRunning={state.isRunning}
            activeDiff={state.activeDiff}
            onAcceptDiff={handleAcceptDiff}
            onRejectDiff={handleRejectDiff}
            onDismissDiff={handleDismissDiff}
            onFileClick={handleFileClick}
            onRetry={handleRetry}
            onAbort={handleAbort}
          />
        </div>

        {/* ======== 右侧面板 (条件渲染) ======== */}
        {state.mcpPanelVisible && (
          <MCPPanel
            servers={state.mcpBar.servers}
            visible={state.mcpPanelVisible}
            onToggle={handleToggleMCP}
          />
        )}
        {state.brainPanelVisible && (
          <BrainPanel
            visible={state.brainPanelVisible}
            thinkingDelta={state.currentThinking}
            turn={state.turn}
            tokensUsed={state.tokensUsed}
            modelBar={state.modelBar}
            shadowBar={state.shadowBar.lastResult}
            onToggle={handleToggleBrain}
          />
        )}
      </div>

      {/* ======== 输入框 ======== */}
      <div style={styles.inputBox}>
        <textarea
          ref={inputRef}
          style={styles.textarea}
          rows={2}
          placeholder={state.isRunning ? 'Comdr is working...' : 'Ask Comdr... (Enter send, Shift+Enter newline)'}
          disabled={state.isRunning}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              const value = (e.target as HTMLTextAreaElement).value;
              if (value.trim()) {
                handleSend(value);
                (e.target as HTMLTextAreaElement).value = '';
              }
            }
          }}
        />
        <button
          style={{
            ...styles.sendButton,
            opacity: state.isRunning ? 0.5 : 1,
          }}
          disabled={state.isRunning}
          onClick={() => {
            if (inputRef.current && inputRef.current.value.trim()) {
              handleSend(inputRef.current.value);
            }
          }}
        >
          ▸
        </button>
      </div>
    </div>
    </ErrorBoundary>
  );
}

// ── Styles ─────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.sm,
    color: theme.colors.fg,
    background: theme.colors.bg,
  },
  main: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  chatPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  inputBox: {
    display: 'flex',
    gap: '6px',
    padding: '8px 12px',
    borderTop: `1px solid ${theme.colors.border}`,
    background: theme.colors.bgSurface,
    alignItems: 'center',
  },
  textarea: {
    flex: 1,
    padding: '6px 10px',
    border: `1px solid ${theme.colors.border}`,
    borderRadius: '4px',
    background: theme.colors.bgCard,
    color: theme.colors.fg,
    fontFamily: theme.fonts.mono,
    fontSize: theme.fontSizes.sm,
    resize: 'none' as const,
    outline: 'none',
  },
  sendButton: {
    width: '36px',
    height: '36px',
    borderRadius: '4px',
    border: 'none',
    background: theme.colors.accent,
    color: '#fff',
    fontSize: theme.fontSizes.md,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
};
