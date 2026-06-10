/**
 * ActivityBar.tsx — 三条压缩状态栏
 *
 * 始终可见，每条约 24px 高。
 * hover → 悬浮提示, click → 展开对应面板
 *
 * Paper 依据:
 *   CUA Dashboard: "compress parallel trajectories into status bars"
 */

import { useCallback } from 'react';
import type { ModelBarState, ShadowBarState, MCPBarState, MCPServerStatusMsg } from './types.js';
import { theme } from './styles.js';

interface ActivityBarProps {
  modelBar: ModelBarState;
  shadowBar: ShadowBarState;
  mcpBar: MCPBarState;
  onToggleMCP: () => void;
  onToggleBrain: () => void;
  onAbort: () => void;
  onReconfig: () => void;
  isRunning: boolean;
}

export function ActivityBar({
  modelBar, shadowBar, mcpBar,
  onToggleMCP, onToggleBrain, onAbort, onReconfig, isRunning,
}: ActivityBarProps): JSX.Element {
  return (
    <div style={styles.container}>
      <ModelBar modelBar={modelBar} onClick={onToggleBrain} />
      <ShadowBar shadowBar={shadowBar} />
      <MCPBar mcpBar={mcpBar} onClick={onToggleMCP} />
      <div style={{ flex: 1 }} />
      <GearButton onClick={onReconfig} />
      {isRunning && <AbortButton onClick={onAbort} />}
    </div>
  );
}

// ── Model Bar ──────────────────────────────────────────────────

function ModelBar({ modelBar, onClick }: { modelBar: ModelBarState; onClick: () => void }): JSX.Element {
  const icon = modelBar.thinking ? '●' : '○';
  const color = modelBar.thinking ? theme.colors.accent : theme.colors.muted;
  const label = modelBar.thinking
    ? `${modelBar.model} ${modelBar.thinkingProgress ?? 'thinking'}`
    : modelBar.model;
  const cache = modelBar.cacheHitRate !== null
    ? `${(modelBar.cacheHitRate * 100).toFixed(0)}% cache`
    : null;

  return (
    <div
      style={{ ...styles.bar, color, cursor: 'pointer' }}
      onClick={onClick}
      title={`Click to toggle Brain panel\nModel: ${modelBar.model}\nThinking: ${modelBar.thinking}\nCache: ${cache ?? 'N/A'}`}
    >
      <span style={styles.dot}>{icon}</span>
      <span style={styles.label}>{label}</span>
      {cache && <span style={styles.extra}>{cache}</span>}
    </div>
  );
}

// ── Shadow Workspace Bar ───────────────────────────────────────

function ShadowBar({ shadowBar }: { shadowBar: ShadowBarState }): JSX.Element {
  if (!shadowBar.showing) return null as unknown as JSX.Element;

  const { lastResult, isValidating } = shadowBar;
  let icon = '◌';
  let color: string = theme.colors.muted;
  let label = 'Shadow validating...';

  if (!isValidating && lastResult) {
    if (lastResult.errorsIntroduced === 0 && lastResult.errorsFixed >= 0) {
      icon = '✓';
      color = theme.colors.ok;
      label = `Shadow ${lastResult.errorsFixed} fixed, 0 new`;
    } else if (lastResult.errorsIntroduced > 0) {
      icon = '!';
      color = theme.colors.warn;
      label = `Shadow ${lastResult.errorsFixed} fixed, ${lastResult.errorsIntroduced} new`;
    }
  }

  return (
    <div
      style={{ ...styles.bar, color }}
      title={`Shadow Workspace\n${lastResult ? `${lastResult.errorsFixed} errors fixed\n${lastResult.errorsIntroduced} errors introduced` : 'Validating...'}`}
    >
      <span style={styles.dot}>{icon}</span>
      <span style={styles.label}>{label}</span>
    </div>
  );
}

// ── MCP Bar ────────────────────────────────────────────────────

function MCPBar({ mcpBar, onClick }: { mcpBar: MCPBarState; onClick: () => void }): JSX.Element {
  if (mcpBar.servers.length === 0) return null as unknown as JSX.Element;

  const activeServers = mcpBar.servers.filter(s => s.activeTool !== undefined);
  const runningCount = activeServers.length;
  const connectedCount = mcpBar.servers.filter(s => s.status === 'connected').length;
  const errorCount = mcpBar.servers.filter(s => s.status === 'error').length;

  let icon = '◌';
  let color: string = theme.colors.muted;
  let label = `${connectedCount} MCP connected`;

  if (runningCount > 0) {
    icon = '●';
    color = theme.colors.accent;
    const tools = activeServers.map(s => s.activeTool).join(', ');
    label = `${runningCount} MCP running: ${tools}`;
  }
  if (errorCount > 0) {
    icon = '!';
    color = theme.colors.err;
    label = `${errorCount} MCP error`;
  }

  return (
    <div
      style={{ ...styles.bar, color, cursor: 'pointer' }}
      onClick={onClick}
      title={`Click to toggle MCP panel\n${mcpBar.servers.map(s => `  ${s.name}: ${s.status}${s.activeTool ? ` (${s.activeTool})` : ''}`).join('\n')}`}
    >
      <span style={styles.dot}>{icon}</span>
      <span style={styles.label}>{label}</span>
    </div>
  );
}

// ── Abort Button ───────────────────────────────────────────────

function GearButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <div
      style={{ cursor: 'pointer', fontSize: theme.fontSizes.sm, color: theme.colors.muted, padding: '0 4px' }}
      onClick={onClick}
      title="Change API key / settings"
    >
      ⚙
    </div>
  );
}

function AbortButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <div style={{ ...styles.bar, color: theme.colors.err, cursor: 'pointer' }} onClick={onClick}>
      <span style={styles.label}>⏹ Abort</span>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    gap: '12px',
    padding: '4px 12px',
    borderBottom: `1px solid ${theme.colors.border}`,
    background: theme.colors.bgSurface,
    alignItems: 'center',
    minHeight: '28px',
    flexWrap: 'wrap' as const,
    userSelect: 'none' as const,
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: theme.fontSizes.xs,
    fontFamily: theme.fonts.mono,
    whiteSpace: 'nowrap' as const,
  },
  dot: {
    fontSize: theme.fontSizes.xs,
    lineHeight: 1,
  },
  label: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  extra: {
    color: theme.colors.muted,
    fontSize: theme.fontSizes.xs,
  },
};
