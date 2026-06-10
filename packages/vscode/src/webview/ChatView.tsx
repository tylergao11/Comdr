/**
 * ChatView.tsx — 对话消息列表 (重写)
 *
 * 消息卡片: 用户名/Agent 名 + 结构化内容 (含可点击链接) + 工具卡片 + Diff 卡片
 * 自动滚动 + 流式增量渲染
 */

import { useRef, useEffect } from 'react';
import type { ChatMessage, ContentSegment, AppError } from './types.js';
import { LinkRenderer } from './LinkRenderer.js';
import { theme } from './styles.js';

interface ChatViewProps {
  messages: ChatMessage[];
  currentDelta: string;
  currentThinking: string;
  error: AppError | null;
  isRunning: boolean;
  activeDiff: { filePath: string; original: string; modified: string } | null;
  onAcceptDiff: (path: string) => void;
  onRejectDiff: (path: string) => void;
  onDismissDiff: () => void;
  onFileClick: (path: string, line?: number) => void;
  onRetry: () => void;
  onAbort: () => void;
}

export function ChatView({
  messages, currentDelta, currentThinking, error, isRunning,
  activeDiff, onAcceptDiff, onRejectDiff, onDismissDiff, onFileClick,
  onRetry, onAbort,
}: ChatViewProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, currentDelta, currentThinking, activeDiff]);

  return (
    <div ref={listRef} style={styles.list}>
      {messages.length === 0 && !currentDelta && !error && (
        <div style={styles.emptyState}>
          <p style={styles.emptyTitle}>Comdr</p>
          <p style={styles.emptyDesc}>
            DeepSeek V4 powered coding agent.<br />
            Type a task below to get started.
          </p>
        </div>
      )}

      {messages.map(msg => (
        <MessageCard
          key={msg.id}
          message={msg}
          onFileClick={onFileClick}
          onAcceptDiff={onAcceptDiff}
          onRejectDiff={onRejectDiff}
        />
      ))}

      {/* 流式增量 */}
      {(currentDelta || currentThinking) && (
        <StreamingCard
          text={currentDelta}
          thinking={currentThinking}
          isRunning={isRunning}
        />
      )}

      {/* Diff 审批 (★ 核心交互) */}
      {activeDiff && (
        <DiffCard
          filePath={activeDiff.filePath}
          original={activeDiff.original}
          modified={activeDiff.modified}
          onAccept={onAcceptDiff}
          onReject={onRejectDiff}
          onDismiss={onDismissDiff}
        />
      )}

      {/* 错误卡片 */}
      {error && (
        <div style={styles.errorCard}>
          <div style={styles.errorHeader}>
            <span>❌ Error</span>
            <span style={styles.errorTag}>{error.recoverable ? 'Recoverable' : 'Fatal'}</span>
          </div>
          <div style={styles.errorBody}>{error.message}</div>
          <div style={styles.errorActions}>
            {error.recoverable && (
              <button style={styles.actionButton} onClick={onRetry}>
                Retry
              </button>
            )}
            <button style={{ ...styles.actionButton, ...styles.dangerButton }} onClick={onAbort}>
              Abort
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Message Card ───────────────────────────────────────────────

function MessageCard({ message, onFileClick, onAcceptDiff, onRejectDiff }: {
  message: ChatMessage;
  onFileClick: (path: string, line?: number) => void;
  onAcceptDiff: (path: string) => void;
  onRejectDiff: (path: string) => void;
}): JSX.Element {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  return (
    <div style={{
      ...styles.card,
      ...(isUser ? styles.userCard : {}),
      ...(isSystem ? styles.systemCard : {}),
    }}>
      <div style={styles.cardHeader}>
        <span style={styles.roleTag}>
          {message.role === 'user' ? 'You' : message.role === 'system' ? 'System' : 'Comdr'}
        </span>
        <span style={styles.timestamp}>
          {new Date(message.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {/* 结构化内容 + 可点击链接 */}
      {message.parsedContent ? (
        <div style={styles.body}>
          <LinkRenderer
            segments={message.parsedContent.segments}
            onFileClick={onFileClick}
          />
        </div>
      ) : message.content ? (
        <div style={styles.body}>
          {message.content}
        </div>
      ) : null}

      {/* 工具调用卡片 */}
      {message.toolCall && (
        <ToolCard toolCall={message.toolCall} />
      )}

      {/* 内联 Diff */}
      {message.diff && (
        <InlineDiff
          filePath={message.diff.filePath}
          original={message.diff.original}
          modified={message.diff.modified}
          onAccept={onAcceptDiff}
          onReject={onRejectDiff}
        />
      )}
    </div>
  );
}

// ── Streaming Card ─────────────────────────────────────────────

function StreamingCard({ text, thinking, isRunning }: {
  text: string; thinking: string; isRunning: boolean;
}): JSX.Element {
  return (
    <div style={styles.streamingCard}>
      <div style={styles.cardHeader}>
        <span style={{ ...styles.roleTag, color: theme.colors.accent }}>
          Comdr {isRunning ? '●' : ''}
        </span>
      </div>
      {thinking && (
        <details style={styles.thinking}>
          <summary style={styles.thinkingLabel}>🧠 thinking...</summary>
          <div style={styles.thinkingBody}>{thinking}</div>
        </details>
      )}
      {text && <div style={styles.body}>{text}</div>}
      {!text && !thinking && <div style={{ color: theme.colors.muted }}>...</div>}
    </div>
  );
}

// ── Diff Card (★ 主 Diff 审批卡片) ─────────────────────────────

function DiffCard({ filePath, original, modified, onAccept, onReject, onDismiss }: {
  filePath: string; original: string; modified: string;
  onAccept: (path: string) => void; onReject: (path: string) => void; onDismiss: () => void;
}): JSX.Element {
  return (
    <div style={styles.diffCard}>
      <div style={styles.diffCardHeader}>
        <span>📝 {filePath}</span>
        <span style={{ ...styles.dot, color: theme.colors.ok }}>Shadow ✓</span>
      </div>
      <div style={styles.diffContainer}>
        <div style={styles.diffSide}>
          <div style={styles.diffLabel}>Original</div>
          <pre style={{ ...styles.diffCode, background: theme.colors.bgDiffRemoved }}>{original}</pre>
        </div>
        <div style={styles.diffSide}>
          <div style={styles.diffLabel}>Modified</div>
          <pre style={{ ...styles.diffCode, background: theme.colors.bgDiffAdded }}>{modified}</pre>
        </div>
      </div>
      <div style={styles.diffActions}>
        <button style={styles.acceptButton} onClick={() => onAccept(filePath)}>
          Accept
        </button>
        <button style={styles.rejectButton} onClick={() => onReject(filePath)}>
          Reject
        </button>
        <button style={styles.dismissButton} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ── Inline Diff (消息内嵌) ─────────────────────────────────────

function InlineDiff({ filePath, original, modified, onAccept, onReject }: {
  filePath: string; original: string; modified: string;
  onAccept: (path: string) => void; onReject: (path: string) => void;
}): JSX.Element {
  return (
    <div style={styles.inlineDiff}>
      <div style={styles.inlineDiffHeader}>{filePath}</div>
      <div style={styles.inlineDiffGrid}>
        <div style={styles.inlineDiffCol}>
          {original.split('\n').map((l, i) => (
            <div key={i} style={styles.inlineDiffRemoved}>{l}</div>
          ))}
        </div>
        <div style={styles.inlineDiffCol}>
          {modified.split('\n').map((l, i) => (
            <div key={i} style={styles.inlineDiffAdded}>{l}</div>
          ))}
        </div>
      </div>
      <div style={styles.inlineDiffActions}>
        <button style={styles.miniButton} onClick={() => onAccept(filePath)}>Accept</button>
        <button style={styles.miniButton} onClick={() => onReject(filePath)}>Reject</button>
      </div>
    </div>
  );
}

// ── Tool Card ──────────────────────────────────────────────────

function ToolCard({ toolCall }: {
  toolCall: NonNullable<ChatMessage['toolCall']>;
}): JSX.Element {
  const ok = toolCall.ok;
  const statusColor = ok === undefined ? theme.colors.accent
    : ok ? theme.colors.ok : theme.colors.err;
  const statusIcon = ok === undefined ? '◌' : ok ? '✓' : '✗';

  return (
    <div style={{ ...styles.toolCard, borderLeftColor: statusColor }}>
      <div style={styles.toolHeader}>
        <span style={{ color: statusColor }}>{statusIcon}</span>
        <span style={styles.toolName}>{toolCall.name}</span>
      </div>
      {toolCall.summary && (
        <div style={styles.toolSummary}>{toolCall.summary}</div>
      )}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px 16px',
  },

  // ── Card base ──
  card: {
    marginBottom: '10px',
    padding: '12px',
    borderRadius: '6px',
    borderLeft: `3px solid ${theme.colors.accent}`,
    background: theme.colors.bgCard,
  },
  userCard: {
    borderLeftColor: theme.colors.link,
  },
  systemCard: {
    borderLeftColor: theme.colors.warn,
    opacity: 0.85,
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '6px',
  },
  roleTag: {
    fontSize: theme.fontSizes.xs,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    color: theme.colors.fg,
  },
  timestamp: {
    fontSize: theme.fontSizes.xs,
    color: theme.colors.muted,
  },

  // ── Body ──
  body: {
    fontSize: theme.fontSizes.sm,
    lineHeight: '1.5',
    color: theme.colors.fg,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
  },

  // ── Streaming ──
  streamingCard: {
    marginBottom: '10px',
    padding: '12px',
    borderRadius: '6px',
    borderLeft: `3px solid ${theme.colors.accent}`,
    background: theme.colors.bgHighlight,
  },
  thinking: {
    marginBottom: '6px',
  },
  thinkingLabel: {
    fontSize: theme.fontSizes.xs,
    color: theme.colors.muted,
    cursor: 'pointer',
    fontFamily: theme.fonts.mono,
  },
  thinkingBody: {
    marginTop: '4px',
    padding: '8px',
    borderRadius: '4px',
    background: theme.colors.bgSurface,
    fontSize: theme.fontSizes.xs,
    fontFamily: theme.fonts.mono,
    color: theme.colors.muted,
    maxHeight: '120px',
    overflowY: 'auto',
  },

  // ── Diff Card ──
  diffCard: {
    marginBottom: '10px',
    border: `1px solid ${theme.colors.border}`,
    borderRadius: '6px',
    overflow: 'hidden',
  },
  diffCardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 12px',
    background: theme.colors.bgSurface,
    fontSize: theme.fontSizes.sm,
    fontWeight: 600,
    color: theme.colors.fg,
  },
  dot: { fontSize: theme.fontSizes.xs },
  diffContainer: {
    display: 'flex',
    gap: '1px',
    maxHeight: '300px',
    overflowY: 'auto',
  },
  diffSide: { flex: 1 },
  diffLabel: {
    padding: '4px 8px',
    fontSize: theme.fontSizes.xs,
    color: theme.colors.muted,
    background: theme.colors.bgSurface,
  },
  diffCode: {
    margin: 0,
    padding: '8px',
    fontSize: theme.fontSizes.xs,
    fontFamily: theme.fonts.mono,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
    color: theme.colors.fg,
    minHeight: '60px',
  },
  diffActions: {
    display: 'flex',
    gap: '8px',
    padding: '8px 12px',
  },
  acceptButton: {
    padding: '4px 16px',
    borderRadius: '3px',
    border: 'none',
    background: theme.colors.okButton,
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
    fontSize: theme.fontSizes.sm,
  },
  rejectButton: {
    padding: '4px 16px',
    borderRadius: '3px',
    border: 'none',
    background: theme.colors.dangerButton,
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
    fontSize: theme.fontSizes.sm,
  },
  dismissButton: {
    padding: '4px 16px',
    borderRadius: '3px',
    border: `1px solid ${theme.colors.border}`,
    background: 'transparent',
    color: theme.colors.muted,
    cursor: 'pointer',
    fontSize: theme.fontSizes.sm,
  },

  // ── Inline Diff ──
  inlineDiff: {
    marginTop: '8px',
    border: `1px solid ${theme.colors.border}`,
    borderRadius: '4px',
    overflow: 'hidden',
  },
  inlineDiffHeader: {
    padding: '4px 8px',
    fontSize: theme.fontSizes.xs,
    color: theme.colors.muted,
    background: theme.colors.bgSurface,
  },
  inlineDiffGrid: {
    display: 'flex',
    maxHeight: '150px',
    overflowY: 'auto',
  },
  inlineDiffCol: {
    flex: 1,
    fontFamily: theme.fonts.mono,
    fontSize: '10px',
  },
  inlineDiffRemoved: {
    padding: '1px 6px',
    background: theme.colors.bgDiffRemoved,
    color: theme.colors.err,
  },
  inlineDiffAdded: {
    padding: '1px 6px',
    background: theme.colors.bgDiffAdded,
    color: theme.colors.ok,
  },
  inlineDiffActions: {
    display: 'flex',
    gap: '4px',
    padding: '4px 8px',
  },
  miniButton: {
    padding: '2px 8px',
    borderRadius: '2px',
    border: `1px solid ${theme.colors.border}`,
    background: 'transparent',
    color: theme.colors.fg,
    cursor: 'pointer',
    fontSize: theme.fontSizes.xs,
  },

  // ── Tool Card ──
  toolCard: {
    marginTop: '8px',
    padding: '8px',
    borderRadius: '4px',
    borderLeft: '3px solid',
    background: theme.colors.bgSurface,
  },
  toolHeader: {
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
  },
  toolName: {
    fontSize: theme.fontSizes.sm,
    fontFamily: theme.fonts.mono,
    fontWeight: 600,
    color: theme.colors.fg,
  },
  toolSummary: {
    marginTop: '4px',
    fontSize: theme.fontSizes.xs,
    color: theme.colors.muted,
    whiteSpace: 'pre-wrap' as const,
  },

  // ── Error ──
  errorCard: {
    marginBottom: '10px',
    padding: '12px',
    borderRadius: '6px',
    border: `1px solid ${theme.colors.err}`,
    background: theme.colors.bgCard,
  },
  errorHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '6px',
    fontWeight: 600,
    color: theme.colors.err,
  },
  errorTag: {
    fontSize: theme.fontSizes.xs,
    padding: '1px 6px',
    borderRadius: '3px',
    background: theme.colors.err,
    color: '#fff',
  },
  errorBody: {
    fontSize: theme.fontSizes.sm,
    color: theme.colors.fg,
    marginBottom: '8px',
  },
  errorActions: {
    display: 'flex',
    gap: '8px',
  },
  actionButton: {
    padding: '4px 12px',
    borderRadius: '3px',
    border: 'none',
    background: theme.colors.accent,
    color: '#fff',
    cursor: 'pointer',
    fontSize: theme.fontSizes.sm,
  },
  dangerButton: {
    background: theme.colors.err,
  },

  // ── Empty ──
  emptyState: {
    textAlign: 'center' as const,
    padding: '48px 16px',
  },
  emptyTitle: {
    fontSize: '18px',
    fontWeight: 600,
    color: theme.colors.fg,
    margin: 0,
  },
  emptyDesc: {
    fontSize: theme.fontSizes.sm,
    color: theme.colors.muted,
    marginTop: '8px',
  },
};
