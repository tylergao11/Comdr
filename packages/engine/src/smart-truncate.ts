/**
 * smart-truncate.ts — 机械截断/格式化工具集
 *
 * ★ 纯机械操作——不猜内容重要性，不猜用户意图，不猜错误类型。
 *   LLM 自己判断什么重要。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ToolCall } from '@comdr/core/types';
import { SYSTEM } from '@comdr/core';

// ============================================================================
// §1 summarizeToolOutput — 工具输出摘要（纯机械截断）
// ============================================================================

/**
 * 对 tool output 做摘要——纯字符截断，不猜内容。
 *
 * @param content  完整 tool output
 * @param maxChars 最大字符数
 */
export function summarizeToolOutput(
  content: string | null | undefined,
  _toolName?: string,
  maxChars: number = SYSTEM.SUMMARY_MAX_LENGTH,
): string {
  if (!content) return 'no output';
  if (content.length <= maxChars) return content;

  const lines = content.split('\n');
  const firstLine = lines[0] ?? '';
  const extra = lines.length > 1 ? ` …及 ${lines.length - 1} 行更多` : '';

  if (firstLine.length + extra.length <= maxChars) {
    return firstLine + extra;
  }
  return wordBoundaryTruncate(firstLine, maxChars - 1) + '…';
}

// ============================================================================
// §2 summarizeSegmentText — 消息段机械截断
// ============================================================================

const MESSAGE_BOUNDARY_RE = /\n\[(?:system|user|assistant|tool)\]/g;

/**
 * 截断对话段到 maxChars，保证截断点在消息边界上。
 * 最后一条完整消息始终保留。
 */
export function summarizeSegmentText(
  text: string,
  maxChars: number = SYSTEM.SUMMARY_INPUT_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;

  const boundaries: number[] = [0];
  let m: RegExpExecArray | null;
  MESSAGE_BOUNDARY_RE.lastIndex = 0;
  while ((m = MESSAGE_BOUNDARY_RE.exec(text)) !== null) {
    boundaries.push(m.index);
  }

  const lastBoundary = boundaries.length > 1
    ? (boundaries[boundaries.length - 1] ?? 0)
    : 0;
  const lastMessage = text.slice(lastBoundary);

  const availableForPrefix = maxChars - lastMessage.length - 30;
  if (availableForPrefix <= 0) {
    return (
      `[truncated — 省略 ${boundaries.length - 1} 条前置消息]\n` +
      lastMessage.slice(0, maxChars - 50) +
      '\n[message truncated]'
    );
  }

  const keptMessages: string[] = [];
  let used = 0;
  for (let i = 1; i < boundaries.length - 1; i++) {
    const start = boundaries[i] ?? 0;
    const end = boundaries[i + 1] ?? text.length;
    const msg = text.slice(start, end);
    if (used + msg.length <= availableForPrefix) {
      keptMessages.push(msg);
      used += msg.length;
    } else {
      break;
    }
  }

  const omittedCount = boundaries.length - 1 - keptMessages.length - 1;
  const prefix = keptMessages.join('');
  const truncationNote = omittedCount > 0
    ? `\n[truncated — 省略中间 ${omittedCount} 条消息]\n`
    : '';

  return prefix + truncationNote + lastMessage;
}

// ============================================================================
// §3 summarizeDiff — diff 采样截断
// ============================================================================

const DIFF_HEAD_LINES = SYSTEM.DIFF_HEAD_LINES;
const DIFF_TAIL_LINES = SYSTEM.DIFF_TAIL_LINES;
const HUNK_HEADER_RE = /^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@/;

/**
 * 对 unified diff 做 head + tail + body sample 截断。
 */
export function summarizeDiff(
  diff: string | null | undefined,
  maxLines: number = 200,
): string | null {
  if (!diff) return null;

  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;

  const head = lines.slice(0, DIFF_HEAD_LINES);
  const tail = lines.slice(-DIFF_TAIL_LINES);
  const middle = lines.slice(DIFF_HEAD_LINES, -DIFF_TAIL_LINES || undefined);

  const sampled: string[] = [];
  let inHunk = false;
  let hunkLinesRemaining = 0;
  let skippedHunks = 0;

  for (const line of middle) {
    if (HUNK_HEADER_RE.test(line)) {
      if (inHunk && hunkLinesRemaining > 0) {
        sampled.push(`  ... (omitted)`);
      }
      sampled.push(line);
      inHunk = true;
      hunkLinesRemaining = 3;
      skippedHunks++;
    } else if (inHunk && hunkLinesRemaining > 0) {
      sampled.push(line);
      hunkLinesRemaining--;
    }
  }

  const totalOmitted = middle.length - sampled.length;
  const separator = totalOmitted > 0
    ? [`... (${totalOmitted} diff lines omitted, ${skippedHunks} hunks sampled)`]
    : [];

  const result = [...head, ...separator, ...sampled, ...tail];

  if (result.length > maxLines) {
    const excess = result.length - maxLines;
    const sampledStart = head.length + separator.length;
    const sampledEnd = result.length - tail.length;
    const sampledSection = result.slice(sampledStart, sampledEnd);
    const keepSampled = Math.max(0, sampledSection.length - excess);
    return [
      ...head,
      ...separator,
      ...sampledSection.slice(0, keepSampled),
      ...tail,
    ].join('\n');
  }

  return result.join('\n');
}

// ============================================================================
// §4 deriveStableKey — 防碰撞 Key
// ============================================================================

function fnv1a(s: string): number {
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 从 tool call 派生稳定的 key。
 */
export function deriveStableKey(
  call: ToolCall,
  maxLen?: number,
): string {
  const { name } = call.function;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch { /* fallback */ }

  const path = typeof args.path === 'string' ? args.path : undefined;
  const cmd = typeof args.command === 'string' ? args.command : undefined;

  if (path) return path;

  if (cmd) {
    const cleanCmd = cmd.replace(/\s+/g, ' ').trim();
    const parts = cleanCmd.split(' ');
    const cmdName = parts[0] ?? cmd;
    const firstArg = parts.find((p) => !p.startsWith('-')) ?? '';
    const base = firstArg
      ? `shell:${cmdName}_${firstArg}`
      : `shell:${cmdName}`;

    if (!maxLen || base.length <= maxLen) {
      const shortHash = fnv1a(cleanCmd).toString(36).slice(0, 6);
      return `${base}_${shortHash}`;
    }
    const truncatedBase = wordBoundaryTruncate(base, maxLen - 8);
    const hash = fnv1a(cleanCmd).toString(36).slice(0, 6);
    return `${truncatedBase}_${hash}`;
  }

  const signature = `${name}:${JSON.stringify(args, Object.keys(args).sort())}`;
  const hash = fnv1a(signature).toString(36);
  const fallback = `${name}:${hash}`;

  if (maxLen && fallback.length > maxLen) {
    const truncatedName = name.slice(0, maxLen - hash.length - 2);
    return `${truncatedName}:${hash}`;
  }

  return fallback;
}

// ============================================================================
// §5 smartDisplayTruncate — 词/字边界安全截断
// ============================================================================

/**
 * 在词或字符边界处截断文本。
 */
export function smartDisplayTruncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;

  let segmenter: Intl.Segmenter | undefined;
  try {
    segmenter = new Intl.Segmenter('zh-Hans-CN', { granularity: 'word' });
  } catch {
    try {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      return s.slice(0, maxLen - 1) + '…';
    }
  }

  const boundaries: number[] = [];
  for (const seg of segmenter.segment(s)) {
    boundaries.push(seg.index);
  }
  boundaries.push(s.length);

  const target = maxLen - 1;
  let cutAt = 0;
  for (const b of boundaries) {
    if (b <= target) cutAt = b;
    else break;
  }

  if (cutAt > 0 && cutAt < s.length) {
    const charBefore = s[cutAt - 1];
    const charAfter = s[cutAt];
    if (
      charBefore && charAfter &&
      /\w/.test(charBefore) && /\w/.test(charAfter)
    ) {
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
// §6 底层工具
// ============================================================================

function wordBoundaryTruncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  for (let i = maxLen - 1; i > maxLen * 0.6; i--) {
    if (/[\s,.;:!?\-)\]}>'"\/\\]/.test(s[i]!)) {
      return s.slice(0, i + 1).trimEnd();
    }
  }
  return s.slice(0, maxLen);
}
