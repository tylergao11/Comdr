/**
 * parser.ts — Agent 输出内容解析器
 *
 * 将 Agent 输出的 Markdown 文本解析为结构化 ContentSegment 列表。
 * 识别文件引用、符号引用、LSP 诊断引用、Shadow Workspace 引用等。
 *
 * 从 reducer.ts 中抽取——保持单一职责。
 */

import type { ParsedContent, ContentSegment } from './types.js';

// ============================================================================
// 匹配模式
// ============================================================================

const PATTERNS: { re: RegExp; type: ContentSegment['type'] }[] = [
  // [src/file.ts] 或 [src/file.ts:42]
  { re: /\[(?:file:)?([^\]]+\.[a-z]{2,5}(?::\d+)?)\]/i, type: 'fileRef' as const },
  // 也匹配无扩展名文件 (如 [Dockerfile], [Makefile], [README])
  { re: /\[(?:file:)?([^\]]{2,100})\]/i, type: 'fileRef' as const },
  // [symbol: LoginHandler]
  { re: /\[symbol:\s*([^\]]+)\]/i, type: 'symbolRef' as const },
  // [LSP: 2 errors] 或 [LSP: 1 warning]
  { re: /\[LSP:\s*(\d+)\s*(errors?|warnings?|hints?)\s*\]/i, type: 'lspRef' as const },
  // [Shadow: 2 fixed, 0 introduced]
  { re: /\[Shadow:\s*(\d+)\s*fixed?,\s*(\d+)\s*introduced\]/i, type: 'shadowRef' as const },
  // [turn 5]
  { re: /\[turn\s*(\d+)\]/i, type: 'turnRef' as const },
];

/** 防止 parser 无限循环的安全上限 */
const MAX_SEGMENTS = 500;

// ============================================================================
// 入口
// ============================================================================

export function parseContent(text: string): ParsedContent | null {
  const segments = parseSegments(text);
  return segments.length > 0 ? { segments } : null;
}

// ============================================================================
// 实现
// ============================================================================

function parseSegments(text: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (segments.length >= MAX_SEGMENTS) {
      segments.push({ type: 'text', text: remaining });
      break;
    }

    let earliestMatch: { index: number; match: RegExpExecArray; patternKey: number } | null = null;

    for (let i = 0; i < PATTERNS.length; i++) {
      const { re } = PATTERNS[i]!;
      re.lastIndex = 0;
      const m = re.exec(remaining);
      if (m && m[0].length > 0 && (earliestMatch === null || m.index < earliestMatch.index)) {
        earliestMatch = { index: m.index, match: m, patternKey: i };
      }
    }

    if (!earliestMatch) {
      segments.push({ type: 'text', text: remaining });
      break;
    }

    const { index, match, patternKey } = earliestMatch;

    // 匹配前的文本
    if (index > 0) {
      segments.push({ type: 'text', text: remaining.slice(0, index) });
    }

    // 构建 segment
    const segment = buildSegment(patternKey, match);
    if (segment) {
      segments.push(segment);
    }

    remaining = remaining.slice(index + match[0].length);
  }

  return segments;
}

function buildSegment(patternKey: number, match: RegExpExecArray): ContentSegment | null {
  const type = PATTERNS[patternKey]!.type;

  switch (type) {
    case 'fileRef': {
      const raw = match[1]!;
      const colonIdx = raw.lastIndexOf(':');
      const hasSlash = raw.includes('/') || raw.includes('\\');
      // 区分 [C:\path] 中的冒号 (Windows 盘符) 和 [file:42] 中的行号冒号
      const isWinDriveLetter = colonIdx === 1 && !hasSlash;
      if (isWinDriveLetter) {
        return { type: 'fileRef', path: raw, display: raw };
      }
      const path = colonIdx > 0 ? raw.slice(0, colonIdx) : raw;
      const line = colonIdx > 0 ? parseInt(raw.slice(colonIdx + 1), 10) : undefined;
      return {
        type: 'fileRef',
        path,
        line: line && !isNaN(line) ? line : undefined,
        display: raw,
      };
    }
    case 'symbolRef':
      return { type: 'symbolRef', symbol: match[1]!, display: match[1]! };
    case 'lspRef':
      return {
        type: 'lspRef',
        count: parseInt(match[1]!, 10),
        severity: match[2]!.toLowerCase().startsWith('warn') ? 'warning'
          : match[2]!.toLowerCase().startsWith('hint') ? 'hint' : 'error',
        filePath: '',
        display: match[0],
      };
    case 'shadowRef':
      return {
        type: 'shadowRef',
        errorsFixed: parseInt(match[1]!, 10),
        errorsIntroduced: parseInt(match[2]!, 10),
        display: match[0],
      };
    case 'turnRef':
      return { type: 'turnRef', turn: parseInt(match[1]!, 10), display: match[0] };
    default:
      return null;
  }
}
