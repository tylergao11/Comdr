/**
 * MCPPanel.tsx — MCP 服务器状态面板
 *
 * 有 MCP 活动时从右侧滑入。显示每个 server 的状态 + 运行中的工具。
 * click 某一 server → 展开工具列表 + 最近结果。
 *
 * Paper 依据: CUA Dashboard — "diagnostic hotspot report"
 */

import type { MCPServerStatusMsg } from './types.js';
import { theme } from './styles.js';

interface MCPPanelProps {
  servers: MCPServerStatusMsg[];
  visible: boolean;
  onToggle: () => void;
}

export function MCPPanel({ servers, visible, onToggle }: MCPPanelProps): JSX.Element {
  if (!visible) return <div />;

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span>MCP Servers</span>
        <span style={styles.close} onClick={onToggle}>✕</span>
      </div>
      {servers.length === 0 ? (
        <div style={styles.empty}>No MCP servers connected</div>
      ) : (
        servers.map(s => <ServerCard key={s.name} server={s} />)
      )}
    </div>
  );
}

function ServerCard({ server }: { server: MCPServerStatusMsg }): JSX.Element {
  const statusColor =
    server.status === 'connected' ? theme.colors.ok
    : server.status === 'connecting' ? theme.colors.accent
    : server.status === 'error' ? theme.colors.err
    : theme.colors.muted;

  const statusIcon =
    server.status === 'connected' ? '✓'
    : server.status === 'connecting' ? '◌'
    : server.status === 'error' ? '✗'
    : '—';

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <span style={{ color: statusColor }}>{statusIcon}</span>
        <span style={styles.serverName}>{server.name}</span>
        <span style={styles.serverStatus}>{server.status}</span>
      </div>
      {server.activeTool && (
        <div style={styles.activeTool}>
          <span style={styles.runningDot}>●</span>
          Running: {server.activeTool}
        </div>
      )}
      <div style={styles.toolList}>
        {server.tools.slice(0, 8).map(t => (
          <span key={t} style={styles.toolTag}>{t}</span>
        ))}
        {server.tools.length > 8 && (
          <span style={styles.toolTag}>+{server.tools.length - 8} more</span>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: '280px',
    borderLeft: `1px solid ${theme.colors.border}`,
    background: theme.colors.bgCard,
    overflowY: 'auto',
    padding: '8px',
    flexShrink: 0,
    transition: 'width 0.2s ease',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
    color: theme.colors.fg,
    fontWeight: 600,
    fontSize: theme.fontSizes.sm,
  },
  close: {
    cursor: 'pointer',
    color: theme.colors.muted,
    fontSize: theme.fontSizes.sm,
  },
  empty: {
    color: theme.colors.muted,
    fontSize: theme.fontSizes.sm,
    textAlign: 'center' as const,
    padding: '16px 0',
  },
  card: {
    marginBottom: '8px',
    padding: '8px',
    borderRadius: '4px',
    border: `1px solid ${theme.colors.border}`,
    background: theme.colors.bgSurface,
  },
  cardHeader: {
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
    marginBottom: '4px',
  },
  serverName: {
    fontWeight: 600,
    fontSize: theme.fontSizes.sm,
    color: theme.colors.fg,
  },
  serverStatus: {
    fontSize: theme.fontSizes.xs,
    color: theme.colors.muted,
    marginLeft: 'auto',
  },
  activeTool: {
    fontSize: theme.fontSizes.xs,
    color: theme.colors.accent,
    fontFamily: theme.fonts.mono,
    marginBottom: '6px',
  },
  runningDot: {
    color: theme.colors.accent,
    marginRight: '4px',
  },
  toolList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
  },
  toolTag: {
    padding: '1px 6px',
    borderRadius: '3px',
    background: theme.colors.bgHighlight,
    color: theme.colors.muted,
    fontSize: theme.fontSizes.xs,
    fontFamily: theme.fonts.mono,
  },
};
