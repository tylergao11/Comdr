/**
 * LinkRenderer.tsx — 结构化内容渲染 + 悬浮预览 (审计修订版)
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { ContentSegment, LSPDiagnosticMsg } from './types.js';
import { theme } from './styles.js';

// ============================================================================
// useHover — 共享 hover 逻辑（150ms 延迟关闭，防止鼠标过渡时消失）
// ============================================================================

function useHover(delayMs = 150) {
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onEnter = useCallback(() => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } setHovered(true); }, []);
  const onLeave = useCallback(() => { timer.current = setTimeout(() => setHovered(false), delayMs); }, [delayMs]);
  return { hovered, onEnter, onLeave };
}

// ============================================================================
// LinkRenderer
// ============================================================================

interface LinkRendererProps {
  segments: ContentSegment[];
  onFileClick?: (path: string, line?: number) => void;
  lspDiags?: Map<string, LSPDiagnosticMsg[]>;
}

export function LinkRenderer({ segments, onFileClick, lspDiags }: LinkRendererProps): JSX.Element {
  return (
    <span>
      {segments.map((seg, i) => {
        switch (seg.type) {
          case 'text': return <span key={i}>{seg.text}</span>;
          case 'fileRef': return <FileLink key={i} path={seg.path} line={seg.line} display={seg.display} onClick={onFileClick} />;
          case 'symbolRef': return <SymbolLink key={i} symbol={seg.symbol} display={seg.display} />;
          case 'lspRef': return <LSPLink key={i} count={seg.count} severity={seg.severity} filePath={seg.filePath} display={seg.display} diags={lspDiags?.get(seg.filePath)} />;
          case 'shadowRef': return <ShadowLink key={i} errorsFixed={seg.errorsFixed} errorsIntroduced={seg.errorsIntroduced} display={seg.display} />;
          case 'turnRef': return <TurnLink key={i} turn={seg.turn} display={seg.display} />;
          default: { const f = seg as { display: string }; return <span key={i}>{f.display ?? ''}</span>; }
        }
      })}
    </span>
  );
}

// ── File Link ──────────────────────────────────────────────────

function FileLink({ path, line, display, onClick }: {
  path: string; line?: number; display: string;
  onClick?: (p: string, l?: number) => void;
}): JSX.Element {
  const h = useCallback(() => { onClick?.(path, line); }, [path, line, onClick]);
  return <span style={S.link} onClick={h} title={`Open ${path}${line ? `:${line}` : ''}`}>[{display}]</span>;
}

// ── Symbol Link ────────────────────────────────────────────────

function SymbolLink({ symbol, display }: { symbol: string; display: string }): JSX.Element {
  const { hovered, onEnter, onLeave } = useHover();
  return (
    <span style={P.rel}>
      <span style={S.sym} onMouseEnter={onEnter} onMouseLeave={onLeave}>{display}</span>
      {hovered && <HoverCard title={`Symbol: ${symbol}`} body="Click to jump to definition" position="above" onClose={() => {}} onMouseEnter={onEnter} />}
    </span>
  );
}

// ── LSP Link ───────────────────────────────────────────────────

function LSPLink({ count, severity, filePath, display, diags }: {
  count: number; severity: string; filePath: string; display: string; diags?: LSPDiagnosticMsg[];
}): JSX.Element {
  const { hovered, onEnter, onLeave } = useHover();
  const c = severity === 'error' ? theme.colors.err : severity === 'warning' ? theme.colors.warn : theme.colors.muted;
  const body = diags
    ? diags.slice(0, 5).map(d => `L${d.line}: ${d.message}`).join('\n')
        + (diags.length > 5 ? `\n... +${diags.length - 5} more` : '')
    : `${count} ${severity}(s)`;
  return (
    <span style={P.rel}>
      <span style={{ ...S.link, color: c, cursor: 'pointer' }} onMouseEnter={onEnter} onMouseLeave={onLeave}>[{display}]</span>
      {hovered && <HoverCard title={`LSP: ${count} ${severity}(s) in ${filePath || 'file'}`} body={body} position="above" onClose={() => {}} onMouseEnter={onEnter} />}
    </span>
  );
}

// ── Shadow Link ────────────────────────────────────────────────

function ShadowLink({ errorsFixed, errorsIntroduced, display }: {
  errorsFixed: number; errorsIntroduced: number; display: string;
}): JSX.Element {
  const { hovered, onEnter, onLeave } = useHover();
  const ok = errorsIntroduced === 0;
  const c = ok ? theme.colors.ok : theme.colors.warn;
  return (
    <span style={P.rel}>
      <span style={{ ...S.link, color: c, cursor: 'pointer' }} onMouseEnter={onEnter} onMouseLeave={onLeave}>[{display}]</span>
      {hovered && <HoverCard title="Shadow Workspace" body={`${errorsFixed} fixed\n${errorsIntroduced} introduced\n${ok ? 'All clear' : 'New errors!'}`} position="above" onClose={() => {}} onMouseEnter={onEnter} />}
    </span>
  );
}

// ── Turn Link ──────────────────────────────────────────────────

function TurnLink({ turn, display }: { turn: number; display: string }): JSX.Element {
  return <span style={{ ...S.link, color: theme.colors.muted }} title={`Turn ${turn}`}>[{display}]</span>;
}

// ── Hover Card ─────────────────────────────────────────────────

interface HoverCardProps {
  title: string; body: string; position: 'above' | 'below';
  onClose: () => void; onMouseEnter?: () => void;
}

export function HoverCard({ title, body, position, onClose, onMouseEnter }: HoverCardProps): JSX.Element {
  return (
    <div style={{ ...S.hCard, bottom: position === 'above' ? '100%' : undefined, top: position === 'below' ? '100%' : undefined }}
      onMouseLeave={onClose} onMouseEnter={onMouseEnter}>
      <div style={S.hTitle}>{title}</div>
      <div style={S.hBody}>{body}</div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────

const P = { rel: { position: 'relative' } as React.CSSProperties };

const S: Record<string, React.CSSProperties> = {
  link: { color: theme.colors.link, cursor: 'pointer', fontFamily: theme.fonts.mono, fontSize: theme.fontSizes.xs },
  sym: { fontFamily: theme.fonts.mono, color: theme.colors.accent, cursor: 'pointer', padding: '1px 2px', borderRadius: '2px', background: theme.colors.bgHighlight },
  hCard: { position: 'absolute', left: 0, zIndex: 100, minWidth: '280px', maxWidth: '420px', padding: '10px 12px', borderRadius: '6px', background: theme.colors.bgCard, border: `1px solid ${theme.colors.border}`, boxShadow: '0 4px 12px rgba(0,0,0,0.4)', whiteSpace: 'pre-wrap', pointerEvents: 'auto' },
  hTitle: { fontSize: theme.fontSizes.sm, fontWeight: 600, color: theme.colors.fg, marginBottom: '6px', borderBottom: `1px solid ${theme.colors.border}`, paddingBottom: '4px' },
  hBody: { fontSize: theme.fontSizes.sm, color: theme.colors.fg, fontFamily: theme.fonts.mono, lineHeight: '1.4' },
};
