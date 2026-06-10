/**
 * app.tsx — Comdr TUI 主组件
 *
 * 整合所有子组件，处理全局键盘快捷键、自动滚动、完成通知。
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React, { useState, useEffect, useReducer, useCallback, useMemo, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import type { AgentEvent, IEngine, RunMode, RunResult } from '@comdr/core';
import { AGENT_EVENT } from '@comdr/core';
import { execSync } from 'node:child_process';
import { C } from './colors.js';
import { uiReducer, createInitialState } from './reducer.js';
import type { TabId } from './types.js';
import { Header } from './components/Header.js';
import { Footer } from './components/Footer.js';
import { StatusLine } from './components/StatusLine.js';
import { TokenGauge } from './components/TokenGauge.js';
import { TabBar } from './components/TabBar.js';
import { SearchBar } from './components/SearchBar.js';
import { MessageLine } from './components/MessageLine.js';
import { LiveThinking } from './components/LiveThinking.js';
import { LiveText, TransitionSeparator } from './components/LiveText.js';
import { ActiveTools } from './components/ActiveTools.js';
import { RightPanel } from './components/RightPanel.js';
import { InputBar } from './components/InputBar.js';
import { HelpPanel } from './components/HelpPanel.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import { uid } from './utils.js';

// ============================================================================
// App Props
// ============================================================================

interface AppProps {
  engine: IEngine;
  mode: RunMode;
  initialInput?: string;
}

// ============================================================================
// Files Tab Content
// ============================================================================

function FilesTab({ state }: { state: import('./types.js').UIState }) {
  const files = state.stateWindow;
  if (files.length === 0) {
    return (
      <Box paddingLeft={1}>
        <Text color={C.dim}>No files modified yet.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold color={C.accent}>Modified Files</Text>
      {files.map((f, i) => (
        <Box key={i} paddingLeft={2}>
          <Text color={C.info}>{f.key}</Text>
          <Text color={C.dim}>  turn {f.turn}: {f.text}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ============================================================================
// Logs Tab Content
// ============================================================================

function LogsTab({ state }: { state: import('./types.js').UIState }) {
  const logs = state.messages.filter(m =>
    m.type === 'error' || m.type === 'warning' || m.type === 'info',
  );

  if (logs.length === 0) {
    return (
      <Box paddingLeft={1}>
        <Text color={C.dim}>No logs yet.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold color={C.accent}>System Logs</Text>
      {logs.slice(-20).map((log, i) => (
        <Box key={i} paddingLeft={2}>
          <MessageLine msg={log} />
        </Box>
      ))}
    </Box>
  );
}

// ============================================================================
// Notification helper (zero external deps)
// ============================================================================

function sendCompletionNotification(summary: string, durationMs: number): void {
  try {
    // Terminal title update
    process.stdout.write(`\x1b]2;Comdr ✓ Done (${Math.round(durationMs / 1000)}s)\x07`);
    // Short beep
    process.stdout.write('\x07');

    // Windows toast notification via PowerShell
    if (process.platform === 'win32') {
      const shortSummary = summary.length > 100 ? summary.slice(0, 97) + '...' : summary;
      const psCommand = `powershell -Command "`
        + `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;`
        + `$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);`
        + `$template.GetElementsByTagName('text')[0].AppendChild($template.CreateTextNode('Comdr ✓ Task Complete')) | Out-Null;`
        + `$template.GetElementsByTagName('text')[1].AppendChild($template.CreateTextNode('${shortSummary.replace(/'/g, "''")}')) | Out-Null;`
        + `$toast = [Windows.UI.Notifications.ToastNotification]::new($template);`
        + `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Comdr').Show($toast);"
      `;
      execSync(psCommand, { timeout: 3000, stdio: 'ignore' });
    }

    // macOS notification
    if (process.platform === 'darwin') {
      execSync(`osascript -e 'display notification "${summary.slice(0, 100)}" with title "Comdr ✓ Done"'`, { timeout: 3000, stdio: 'ignore' });
    }

    // Linux notification
    if (process.platform === 'linux') {
      execSync(`notify-send "Comdr ✓ Done" "${summary.slice(0, 100)}"`, { timeout: 3000, stdio: 'ignore' });
    }
  } catch {
    // Silent fail — notifications are best-effort
  }
}

// ============================================================================
// App Component
// ============================================================================

export function App({ engine, mode, initialInput }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;

  const sessionId = useMemo(() => `comdr-${uid()}`, []);
  const [state, dispatch] = useReducer(uiReducer, createInitialState(sessionId, mode));
  const [showThinking, setShowThinking] = useState(true);
  const [expandedThinkIds, setExpandedThinkIds] = useState<Set<string>>(new Set());
  const [blink, setBlink] = useState(true);
  const [searchActive, setSearchActive] = useState(false);
  const messageCount = useRef(0);
  const lastActivityRef = useRef(Date.now());

  // ── Auto-scroll to bottom on new messages (unless locked) ──
  useEffect(() => {
    if (state.messages.length > messageCount.current) {
      messageCount.current = state.messages.length;
      if (!state.autoScrollLock) {
        dispatch({ type: 'FOCUS_NEXT' });
      }
    }
  }, [state.messages.length, state.autoScrollLock]);

  // ── Blink cursor (530ms period during streaming) ──
  useEffect(() => {
    if (state.streamingThinking || state.streamingText) {
      lastActivityRef.current = Date.now();
      const id = setInterval(() => setBlink(b => !b), 530);
      return () => clearInterval(id);
    }
    setBlink(true);
  }, [state.streamingThinking, state.streamingText]);

  // ── Initial sync ──
  useEffect(() => {
    const s = engine.getSession();
    dispatch({ type: 'SYNC_WINDOWS', stateWindow: s.stateWindow, intentWindow: s.intentWindow });
  }, [engine]);

  // ── Completion notification ──
  useEffect(() => {
    if (state.finished && state.runStartedAt > 0) {
      const duration = Date.now() - state.runStartedAt;
      if (duration > 30_000) {
        sendCompletionNotification(state.summary || 'Task completed', duration);
      }
    }
  }, [state.finished, state.summary, state.runStartedAt]);

  // ── Run user input ──
  const runUserInput = useCallback(async (input: string) => {
    dispatch({ type: 'USER_INPUT', text: input });
    dispatch({ type: 'RUN_START' });

    let gotDone = false;

    try {
      for await (const event of engine.run(input, mode, sessionId)) {
        dispatch({ type: 'AGENT_EVENT', event });

        if (event.type === AGENT_EVENT.TOOL_RESULT) {
          const s = engine.getSession();
          dispatch({ type: 'SYNC_WINDOWS', stateWindow: s.stateWindow, intentWindow: s.intentWindow });
        }

        if (event.type === AGENT_EVENT.DONE) { gotDone = true; return; }
        if (event.type === AGENT_EVENT.ERROR && !event.recoverable) { gotDone = true; return; }
      }
    } catch (err) {
      dispatch({
        type: 'AGENT_EVENT',
        event: { type: AGENT_EVENT.ERROR, code: 'ENGINE_CRASH', message: String(err), recoverable: false },
      });
    }

    if (!gotDone) {
      dispatch({
        type: 'AGENT_EVENT',
        event: {
          type: AGENT_EVENT.DONE,
          result: { ok: false, turns: 0, tokensUsed: 0, summary: '引擎已停止（未收到完成事件）', sessionId },
        },
      });
    }
  }, [engine, mode, sessionId]);

  // ── Global Keyboard Shortcuts ──
  useInput((input, key) => {
    // ★ Bail out when confirm dialog is active (modal requires focused interaction)
    if (state.pendingConfirm) return;

    // ★ Ctrl+F: Toggle search
    if (key.ctrl && input === 'f') {
      if (searchActive) {
        setSearchActive(false);
        dispatch({ type: 'SEARCH_STOP' });
      } else {
        setSearchActive(true);
        dispatch({ type: 'SEARCH_START' });
      }
      return;
    }

    // ★ Don't process other shortcuts when mode is in a special state
    // Navigation: ↑↓ (only when not running or when running but not in input mode)
    if (key.upArrow && !key.meta && !searchActive) {
      dispatch({ type: 'FOCUS_PREV' });
      return;
    }
    if (key.downArrow && !key.meta && !searchActive) {
      dispatch({ type: 'FOCUS_NEXT' });
      return;
    }

    // ★ Enter: expand detail on focused message (only when running)
    if (key.return && state.messages[state.focusedIndex] && state.running && !searchActive) {
      dispatch({ type: 'TOGGLE_DETAIL', messageId: state.messages[state.focusedIndex]!.id });
      return;
    }

    if (!key.ctrl) return;

    switch (input) {
      case 'c':
        engine.abort();
        exit();
        break;
      case 't':
        setShowThinking(prev => !prev);
        setExpandedThinkIds(prev => {
          const allThinkIds = state.messages
            .filter(m => m.type === 'thinking')
            .map(m => m.id);
          if (allThinkIds.length === 0) return prev;
          const allExpanded = allThinkIds.every(id => prev.has(id));
          const next = new Set(prev);
          if (allExpanded) { for (const id of allThinkIds) next.delete(id); }
          else { for (const id of allThinkIds) next.add(id); }
          return next;
        });
        break;
      case 'l':
        dispatch({ type: 'RESET', sessionId });
        break;
      case 'h':
        dispatch({ type: 'TOGGLE_HELP' });
        break;
      case 'p':
        dispatch({ type: 'TOGGLE_RIGHT_PANEL' });
        break;
      // ★ Tab switching
      case '1':
        dispatch({ type: 'SET_TAB', tab: 'messages' });
        break;
      case '2':
        dispatch({ type: 'SET_TAB', tab: 'files' });
        break;
      case '3':
        dispatch({ type: 'SET_TAB', tab: 'logs' });
        break;
    }
  });

  // ── Auto-run initial input ──
  useEffect(() => {
    if (initialInput) runUserInput(initialInput);
  }, [initialInput]);

  // ── Derived state ──
  const showSeparator = !!(state.streamingThinking && state.streamingText);
  const showWaiting = state.running && !state.streamingThinking && !state.streamingText && state.activeToolCalls.size === 0;
  const isSearching = searchActive && state.searchQuery.length > 0;

  // ── Help Panel Overlay ──
  if (state.showHelp) {
    return (
      <Box flexDirection="column" height={rows} paddingLeft={2} paddingRight={2}>
        <Header status={state.status} />
        <Box flexGrow={1} paddingTop={1}>
          <HelpPanel />
        </Box>
        <Footer running={state.running} searching={searchActive} autoScrollLock={state.autoScrollLock} />
      </Box>
    );
  }

  // ── Confirm Dialog Overlay ──
  if (state.pendingConfirm) {
    return (
      <Box flexDirection="column" height={rows} paddingLeft={2} paddingRight={2}>
        <Header status={state.status} />
        <Box flexGrow={1} paddingTop={2} paddingLeft={4}>
          <ConfirmDialog
            confirm={state.pendingConfirm}
            onApprove={() => {
              // TODO: Engine confirm protocol not yet implemented
              dispatch({ type: 'RESET', sessionId }); // placeholder
            }}
            onDeny={() => {
              dispatch({ type: 'RESET', sessionId }); // placeholder
            }}
          />
        </Box>
        <Footer running={state.running} searching={searchActive} autoScrollLock={state.autoScrollLock} />
      </Box>
    );
  }

  // ── Main Layout ──
  return (
    <Box flexDirection="column" height={rows} paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <Header status={state.status} />

      {/* Status Line */}
      <StatusLine
        phase={state.connectionPhase}
        cacheHitRate={state.cacheHitRate}
        running={state.running}
      />

      {/* Token Gauge */}
      <TokenGauge
        used={state.status.tokensUsed}
        budget={state.status.tokenBudget}
        cols={cols}
      />

      {/* Tab Bar + Divider */}
      <TabBar
        activeTab={state.activeTab}
        onTabChange={(tab: TabId) => dispatch({ type: 'SET_TAB', tab })}
      />
      <Box height={1}>
        <Text color={C.dim}>{'─'.repeat(cols - 2)}</Text>
      </Box>

      {/* Main Area: Left (content) | Right (context) */}
      <Box flexDirection="row" flexGrow={1}>
        {/* Left Panel */}
        <Box flexDirection="column" flexGrow={1} paddingRight={1}>
          {state.activeTab === 'messages' && (
            <>
              {/* Message History */}
              {state.messages.map((msg, idx) => {
                const isFocused = idx === state.focusedIndex;
                const isExpanded = state.expandedDetailIds.has(msg.id);
                const thinkExpanded = expandedThinkIds.has(msg.id);
                const isSearchMatch = state.searchMatches.includes(idx);
                const isActiveMatch = state.activeSearchMatch >= 0
                  && state.searchMatches[state.activeSearchMatch] === idx;

                return (
                  <Box key={msg.id}>
                    {/* Focus indicator / Search highlight */}
                    <Box>
                      {isFocused && !state.running && (
                        <Text color={C.accent}>{'> '}</Text>
                      )}
                      {isActiveMatch && isSearching && (
                        <Text backgroundColor={C.highlight} color="black">{'>'}</Text>
                      )}
                      {isSearchMatch && !isActiveMatch && isSearching && (
                        <Text color={C.highlight}>|</Text>
                      )}
                      {msg.type === 'thinking'
                        ? <MessageLine msg={msg} expanded={thinkExpanded} />
                        : <MessageLine msg={msg} expanded={isExpanded} showDetail={isExpanded} />
                      }
                    </Box>
                  </Box>
                );
              })}

              {/* Loading indicator */}
              {showWaiting && (
                <Box paddingLeft={1}>
                  <Text color={C.dim}>⏳ 思考中…</Text>
                </Box>
              )}

              {/* Live streaming */}
              <LiveThinking text={state.streamingThinking} blink={blink} show={showThinking} />
              {showSeparator && <TransitionSeparator show={true} />}
              <LiveText text={state.streamingText} blink={blink} />
              <ActiveTools tools={state.activeToolCalls} />
            </>
          )}

          {state.activeTab === 'files' && <FilesTab state={state} />}
          {state.activeTab === 'logs' && <LogsTab state={state} />}
        </Box>

        {/* Right Panel */}
        {state.showRightPanel && (
          <RightPanel state={state} rows={rows} cols={cols} />
        )}
      </Box>

      {/* Search Bar (replaces input when active) */}
      {searchActive ? (
        <SearchBar
          active={searchActive}
          query={state.searchQuery}
          matchCount={state.searchMatches.length}
          activeMatch={state.activeSearchMatch}
          onQueryChange={(q: string) => dispatch({ type: 'SEARCH_UPDATE', query: q })}
          onNext={() => dispatch({ type: 'SEARCH_NEXT' })}
          onPrev={() => dispatch({ type: 'SEARCH_PREV' })}
          onStop={() => { setSearchActive(false); dispatch({ type: 'SEARCH_STOP' }); }}
        />
      ) : !state.running ? (
        /* Input Bar (only when idle) */
        <Box height={1}>
          <Text color={C.accent} bold>{'→ '}</Text>
          <InputBar onSubmit={runUserInput} disabled={state.running} />
        </Box>
      ) : null}

      {/* Footer */}
      <Footer
        running={state.running}
        searching={searchActive}
        autoScrollLock={state.autoScrollLock}
      />
    </Box>
  );
}
