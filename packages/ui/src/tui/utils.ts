/**
 * utils.ts — TUI 工具函数
 *
 * 纯函数，无副作用，无 React 依赖。
 *
 * @agent Agent 5 — TUI 渲染器
 */

// ============================================================================
// uid — 短随机 ID
// ============================================================================

export function uid(): string {
  return Math.random().toString(36).slice(2, 8);
}

// ============================================================================
// truncate — 词/字边界安全的展示截断
// ============================================================================

/**
 * 词/字边界安全的展示截断。
 * - 中文/emoji 安全：使用 Intl.Segmenter 避免切断多字节字符
 * - 英文在单词边界处断
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;

  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  } catch {
    return s.slice(0, max - 1) + '…';
  }

  const target = max - 1;
  let cutAt = 0;
  for (const seg of segmenter.segment(s)) {
    if (seg.index <= target) cutAt = seg.index;
    else break;
  }

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

// ============================================================================
// formatTokens — Token 数量格式化
// ============================================================================

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

// ============================================================================
// toolDisplayName — 工具名 → 人类可读 + emoji
// ============================================================================

const TOOL_DISPLAY_MAP: Record<string, string> = {
  file_read: '📖 read',
  file_write: '✏️ write',
  file_edit: '✏️ edit',
  file_glob: '🔍 glob',
  file_grep: '🔎 grep',
  file_ls: '📂 ls',
  shell_bash: '⚡ bash',
  shell_test: '🧪 test',
  file_search: '🔍 search',
  symbol_find: '🔬 symbol',
  memory_recall: '🧠 recall',
  tool_search: '🛠️ tools',
  git_diff: '📋 diff',
  git_status: '📋 status',
  git_log: '📋 log',
  git_add: '📋 add',
  git_commit: '📋 commit',
  git_revert: '↩ revert',
  lsp_symbols: '🔬 symbols',
  lsp_diagnostics: '🔬 diagnostics',
  lsp_structure: '🔬 structure',
};

export function toolDisplayName(name: string, argsJson?: string): string {
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

  // Handle mcp__server__tool format
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    if (parts.length >= 3) {
      return `📡 ${parts[1]} → ${parts.slice(2).join('__')}`;
    }
    return `📡 ${name}`;
  }

  return TOOL_DISPLAY_MAP[name] ?? `🔧 ${name}`;
}

// ============================================================================
// countThinkingSegments — 按空行分割 thinking 段
// ============================================================================

export function countThinkingSegments(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);
}

// ============================================================================
// parseDiffLines — 解析 diff 文本，返回着色行
// ============================================================================

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header';
  text: string;
}

export function parseDiffLines(diffText: string): DiffLine[] {
  const lines = diffText.split('\n');
  const result: DiffLine[] = [];
  for (const line of lines) {
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('@@')) {
      result.push({ type: 'header', text: line });
    } else if (line.startsWith('+')) {
      result.push({ type: 'add', text: line });
    } else if (line.startsWith('-')) {
      result.push({ type: 'remove', text: line });
    } else {
      result.push({ type: 'context', text: line });
    }
  }
  return result;
}

// ============================================================================
// parseMarkdown — 轻量 Markdown → 分段
// ============================================================================

export interface MarkdownSegment {
  type: 'text' | 'code' | 'inline_code' | 'bold';
  content: string;
  language?: string;
}

/**
 * 轻量 Markdown 解析。只处理:
 * 1. 代码块 (```lang ... ```)
 * 2. 行内代码 (`...`)
 * 3. 粗体 (**...**)
 */
export function parseMarkdown(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Text before code block
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index);
      segments.push(...parseInlineMarkdown(before));
    }
    // Code block
    const lang = match[1] || undefined;
    const code = match[2] || '';
    segments.push({ type: 'code', content: code, language: lang });
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code block
  if (lastIndex < text.length) {
    segments.push(...parseInlineMarkdown(text.slice(lastIndex)));
  }

  return segments;
}

function parseInlineMarkdown(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  // Combined regex: inline code, bold, or plain text
  const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    if (match[1]) {
      // Inline code
      segments.push({ type: 'inline_code', content: match[1].slice(1, -1) });
    } else if (match[2]) {
      // Bold
      segments.push({ type: 'bold', content: match[2].slice(2, -2) });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments;
}

// ============================================================================
// formatDuration — 毫秒 → 人类可读时长
// ============================================================================

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

// ============================================================================
// getGaugeColor — Token 用量 → 颜色
// ============================================================================

import { C } from './colors.js';

export function getGaugeColor(ratio: number): string {
  if (ratio < 0.5) return C.good;
  if (ratio < 0.8) return C.warn;
  if (ratio < 0.95) return C.accent;
  return C.bad;
}

// ============================================================================
// getPanelWidth — 响应式面板宽度比例
// ============================================================================

export function getPanelWidth(cols: number): string {
  if (cols < 80) return '0%';
  if (cols < 120) return '25%';
  if (cols < 160) return '30%';
  return '35%';
}

export function shouldShowRightPanel(cols: number): boolean {
  return cols >= 80;
}
