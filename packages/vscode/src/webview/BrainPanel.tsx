/**
 * BrainPanel.tsx — Agent 大脑面板（悬浮/侧边）
 *
 * 展示:
 *   - DeepSeek 推理链
 *   - 记忆状态 (State/Intent Window)
 *   - Shadow Workspace 验证历史
 *
 * Paper 依据:
 *   VL/HCC 2025: "Can it justify itself" — 解释性是 agent UX 的关键维度
 *   Marron 2024: "IDE = Agent 管理平台"
 */

import { theme } from './styles.js';

interface BrainPanelProps {
  visible: boolean;
  thinkingDelta: string;
  turn: number;
  tokensUsed: number;
  modelBar: { model: string; thinking: boolean; cacheHitRate: number | null };
  shadowBar: { errorsFixed: number; errorsIntroduced: number } | null;
  onToggle: () => void;
}

export function BrainPanel({
  visible, thinkingDelta, turn, tokensUsed, modelBar, shadowBar, onToggle,
}: BrainPanelProps): JSX.Element {
  if (!visible) return <div />;

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span>Agent Brain</span>
        <span style={styles.close} onClick={onToggle}>✕</span>
      </div>

      {/* Model Info */}
      <Section title="Model">
        <InfoRow label="Model" value={modelBar.model} />
        <InfoRow label="Thinking" value={modelBar.thinking ? 'enabled' : 'disabled'} />
        {modelBar.cacheHitRate !== null && (
          <InfoRow label="Cache" value={`${(modelBar.cacheHitRate * 100).toFixed(0)}%`} />
        )}
        <InfoRow label="Turn" value={String(turn)} />
        <InfoRow label="Tokens" value={formatTokens(tokensUsed)} />
      </Section>

      {/* Thinking Chain */}
      {thinkingDelta && (
        <Section title="Thinking Chain">
          <div style={styles.thinkingContent}>{thinkingDelta}</div>
        </Section>
      )}

      {/* Shadow Workspace */}
      {shadowBar && (
        <Section title="Shadow Workspace">
          <div style={{ color: theme.colors.ok }}>
            ✓ {shadowBar.errorsFixed} errors fixed
          </div>
          <div style={{
            color: shadowBar.errorsIntroduced > 0 ? theme.colors.err : theme.colors.ok,
          }}>
            {shadowBar.errorsIntroduced > 0 ? '✗' : '✓'}
            {' '}{shadowBar.errorsIntroduced} errors introduced
          </div>
        </Section>
      )}

      {/* Placeholder for Phase 2 */}
      <Section title="Memory">
        <div style={{ color: theme.colors.muted, fontSize: theme.fontSizes.xs }}>
          State/Intent/Episodic — Phase 2
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={sectionStyles.section}>
      <div style={sectionStyles.title}>{title}</div>
      <div style={sectionStyles.body}>{children}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={sectionStyles.row}>
      <span style={sectionStyles.label}>{label}</span>
      <span style={sectionStyles.value}>{value}</span>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

const sectionStyles: Record<string, React.CSSProperties> = {
  section: {
    marginBottom: '12px',
  },
  title: {
    fontSize: theme.fontSizes.xs,
    fontWeight: 600,
    color: theme.colors.accent,
    textTransform: 'uppercase' as const,
    marginBottom: '4px',
    borderBottom: `1px solid ${theme.colors.border}`,
    paddingBottom: '2px',
  },
  body: {
    fontSize: theme.fontSizes.sm,
    color: theme.colors.fg,
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '2px 0',
  },
  label: {
    color: theme.colors.muted,
    fontSize: theme.fontSizes.xs,
  },
  value: {
    color: theme.colors.fg,
    fontSize: theme.fontSizes.xs,
    fontFamily: theme.fonts.mono,
  },
};

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: '280px',
    borderLeft: `1px solid ${theme.colors.border}`,
    background: theme.colors.bgCard,
    overflowY: 'auto' as const,
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
  thinkingContent: {
    fontSize: theme.fontSizes.xs,
    fontFamily: theme.fonts.mono,
    color: theme.colors.muted,
    whiteSpace: 'pre-wrap' as const,
    maxHeight: '200px',
    overflowY: 'auto',
    background: theme.colors.bgSurface,
    padding: '6px',
    borderRadius: '3px',
  },
};
