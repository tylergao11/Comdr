/**
 * smart-truncate.ts — 智能压缩/截断工具集
 *
 * ★ 所有硬截断（blind slice(0, N)）的替代方案集中于此。
 *
 * 核心原则:
 *   1. 截断前先理解内容结构——错误信息、测试结果、diff hunk 都不能丢
 *   2. 保留边界完整——消息边界、句子边界、词边界、字符边界
 *   3. 信息密度优先——不是少输出字节，是保留最关键的语义
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ToolCall } from '@comdr/core/types';
import { SYSTEM } from '@comdr/core';

// ============================================================================
// §1 summarizeToolOutput — 智能 Tool Output 摘要
// ============================================================================

/**
 * 错误/失败关键词模式（按优先级）
 * 匹配到后提取该行 + 上下 1 行
 */
const ERROR_PATTERNS: readonly RegExp[] = [
  /(?<!\w)(?:fatal\s+)?error[s]?(?!\w)/i,
  /(?<!\w)(?:compilation\s+)?failed?(?!\w)/i,
  /(?<!\w)FAIL(?:ED|URE)?(?!\w)/,
  /(?<!\w)panic(?:ked)?(?!\w)/i,
  /(?<!\w)exception(?!\w)/i,
  /(?<!\w)cannot\s+(?:find|open|read|write|access|parse|resolve)/i,
  /(?<!\w)unable\s+to/i,
  /(?<!\w)denied(?!\w)/i,
  /(?<!\w)timed?\s*out(?!\w)/i,
];

/** 测试结果模式 */
const TEST_PATTERNS: readonly RegExp[] = [
  /(\d+)\s*\/\s*(\d+)\s*(?:tests?\s*)?(?:passed|failed|passing|failing)/i,
  /Tests?:?\s*\d+\s*(?:passed|failed)/i,
  /(\d+)\s*(?:passing|failing)/i,
  /(?:PASS|FAIL)\s+/,
];

/** 无意义首行模式（只是路径/分隔符，不能代表输出内容） */
const MEANINGLESS_FIRST_LINE: readonly RegExp[] = [
  /^[\/\\]/,
  /^[A-Za-z]:[\/\\]/,
  /^[-=]{3,}$/,
  /^\s*$/,
  /^\[mock\]/,
];

/** 内容过长时在省略号后保留的尾部字符数 */
const TAIL_KEEP_CHARS = 60;

/**
 * 对 tool output 做智能摘要。
 *
 * 优先级:
 *   1. 有错误/失败信号 → 提取错误行 + 上下文
 *   2. 有测试结果格式 → 提取测试汇总行
 *   3. 首行有意义 → 保留首行 + "…及 N 行更多"
 *   4. fallback → 词边界截断
 *
 * @param content  完整 tool output 内容
 * @param _toolName 工具名（保留参数，未来可能用于工具特定的提取策略）
 * @param maxChars 摘要最大字符数，默认 200
 */
export function summarizeToolOutput(
  content: string | null | undefined,
  _toolName?: string,
  maxChars: number = SYSTEM.SUMMARY_MAX_LENGTH,
): string {
  if (!content) return 'no output';

  const lines = content.split('\n');

  // ── 优先级 1: 错误/失败信号 ──
  const errorResult = extractErrorContext(lines, maxChars);
  if (errorResult) return errorResult;

  // ── 优先级 2: 测试结果 ──
  const testResult = extractTestSummary(content, maxChars);
  if (testResult) return testResult;

  // ── 优先级 3: 有意义的首行 ──
  const firstLine = lines[0] ?? '';
  if (firstLine && !MEANINGLESS_FIRST_LINE.some((p) => p.test(firstLine))) {
    if (firstLine.length <= maxChars) {
      const extra = lines.length > 1 ? ` …及 ${lines.length - 1} 行更多` : '';
      return firstLine + extra;
    }
    return wordBoundaryTruncate(firstLine, maxChars - 1) + '…';
  }

  // ── 优先级 4: fallback — 找第一个非空有意义行 ──
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !MEANINGLESS_FIRST_LINE.some((p) => p.test(trimmed))) {
      return wordBoundaryTruncate(trimmed, maxChars - 10) + `… (${lines.length} 行总计)`;
    }
  }

  // 彻底 fallback
  const fallback = wordBoundaryTruncate(content.trim() || 'no output', maxChars);
  return fallback;
}

/**
 * 从多行内容中提取错误上下文
 * @returns 格式化的错误摘要，无错误时返回 null
 */
function extractErrorContext(
  lines: string[],
  maxChars: number,
): string | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (ERROR_PATTERNS.some((p) => p.test(line))) {
      // 取错误行 + 上下各 1 行上下文
      const contextStart = Math.max(0, i - 1);
      const contextEnd = Math.min(lines.length, i + 2);
      const contextLines = lines.slice(contextStart, contextEnd);

      const prefix = contextStart > 0
        ? `(L${contextStart + 1}) `
        : '';
      const suffix = contextEnd < lines.length
        ? `\n…及 ${lines.length - contextEnd} 行更多`
        : '';

      let result = prefix + contextLines.join('\n') + suffix;
      if (result.length > maxChars) {
        // 优先保留错误行本身，截断上下文
        const errorLine = line.length > maxChars - 20
          ? wordBoundaryTruncate(line, maxChars - 20) + '…'
          : line;
        result = `⚠ ${errorLine}`;
        if (suffix) result += suffix;
      }
      return result;
    }
  }
  return null;
}

/**
 * 从内容中提取测试结果汇总
 */
function extractTestSummary(
  content: string,
  maxChars: number,
): string | null {
  const results: string[] = [];

  for (const line of content.split('\n')) {
    for (const pattern of TEST_PATTERNS) {
      const m = line.match(pattern);
      if (m) {
        const summary = line.trim();
        if (summary.length <= maxChars) {
          results.push(summary);
        } else {
          results.push(wordBoundaryTruncate(summary, maxChars - 1) + '…');
        }
        break; // 一行只匹配一次
      }
    }
  }

  if (results.length === 0) return null;

  // 汇总多条测试行
  const combined = results.join('\n');
  if (combined.length <= maxChars) return combined;

  // 太多 → 只保留首尾
  return results[0]! + `\n…及 ${results.length - 1} 条测试结果`;
}

// ============================================================================
// §2 summarizeSegmentText — 消息段智能截断
// ============================================================================

/** 消息边界标记（`[role]` 格式） */
const MESSAGE_BOUNDARY_RE = /\n\[(?:system|user|assistant|tool)\]/g;

/**
 * 将对话段文本截断到 maxChars，但保证截断点在消息边界上。
 *
 * 始终保留最后一条完整消息（无论多长），
 * 前面的消息按从旧到新的顺序填充，超出部分丢弃并标记为截断。
 *
 * @param text     序列化的消息段文本
 * @param maxChars 最大字符数，默认 8000
 */
export function summarizeSegmentText(
  text: string,
  maxChars: number = SYSTEM.SUMMARY_INPUT_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;

  // 找所有消息边界位置
  const boundaries: number[] = [0];
  let m: RegExpExecArray | null;
  // 重置 lastIndex
  MESSAGE_BOUNDARY_RE.lastIndex = 0;
  while ((m = MESSAGE_BOUNDARY_RE.exec(text)) !== null) {
    boundaries.push(m.index);
  }

  // 最后一条消息（从尾部边界到末尾）始终保留
  const lastBoundary = boundaries.length > 1
    ? (boundaries[boundaries.length - 1] ?? 0)
    : 0;
  const lastMessage = text.slice(lastBoundary);

  // 剩余可用空间
  const availableForPrefix = maxChars - lastMessage.length - 30; // 30 = 截断标记
  if (availableForPrefix <= 0) {
    // 最后一条消息本身就超过限制 → 截断消息本身 + 标注
    return (
      `[truncated — 省略 ${boundaries.length - 1} 条前置消息]\n` +
      lastMessage.slice(0, maxChars - 50) +
      '\n[message truncated]'
    );
  }

  // 从旧到新填充前置消息
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

  const omittedCount = boundaries.length - 1 - keptMessages.length - 1; // -1 for last
  const prefix = keptMessages.join('');
  const truncationNote = omittedCount > 0
    ? `\n[truncated — 省略中间 ${omittedCount} 条消息]\n`
    : '';

  return prefix + truncationNote + lastMessage;
}

// ============================================================================
// §3 summarizeDiff — Head + Tail + Body Sample
// ============================================================================

/** diff 采样时保留的头部行数 */
const DIFF_HEAD_LINES = SYSTEM.DIFF_HEAD_LINES;
/** diff 采样时保留的尾部行数 */
const DIFF_TAIL_LINES = SYSTEM.DIFF_TAIL_LINES;
/** hunk header 模式 */
const HUNK_HEADER_RE = /^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@/;

/**
 * 对 unified diff 做 head + tail + body sample 截断。
 *
 * 策略:
 *   - 前 DIFF_HEAD_LINES 行完整保留（文件路径 + 开头的 hunk）
 *   - 后 DIFF_TAIL_LINES 行完整保留（尾部 hunk）
 *   - 中间部分：保留 hunk header 行 + 其后的 3 行，其余省略
 *
 * @param diff     unified diff 文本
 * @param maxLines 输出最大行数，默认 200
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

  // 中间部分采样：保留 hunk header + 接下来的 3 行
  const sampled: string[] = [];
  let inHunk = false;
  let hunkLinesRemaining = 0;
  let skippedHunks = 0;
  let lastWasHunkHeader = false;

  for (const line of middle) {
    if (HUNK_HEADER_RE.test(line)) {
      // 新的 hunk header
      if (inHunk && hunkLinesRemaining > 0) {
        sampled.push(`  ... (omitted)`);
      }
      sampled.push(line);
      inHunk = true;
      hunkLinesRemaining = 3; // 保留 header 后 3 行
      lastWasHunkHeader = true;
      skippedHunks++;
    } else if (inHunk && hunkLinesRemaining > 0) {
      sampled.push(line);
      hunkLinesRemaining--;
    } else if (inHunk && hunkLinesRemaining === 0 && lastWasHunkHeader) {
      // 第一个被跳过的行 → 不再输出省略标记（hunk header 后的 `... (omitted)` 已标记）
      lastWasHunkHeader = false;
    }
  }

  const totalOmitted = middle.length - sampled.length;
  const separator = totalOmitted > 0
    ? [`... (${totalOmitted} diff lines omitted, ${skippedHunks} hunks sampled)`]
    : [];

  const result = [...head, ...separator, ...sampled, ...tail];

  // 安全网：如果采样后仍超过 maxLines，硬截到 maxLines
  if (result.length > maxLines) {
    // 优先保留 head 和 tail
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
// §4 deriveStableKey — 防碰撞 Key 派生
// ============================================================================

/**
 * FNV-1a 32-bit hash（纯 JS，零依赖）
 */
function fnv1a(s: string): number {
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 从 tool call 派生稳定的、不碰撞的 key。
 *
 * 策略:
 *   - path-based: 保留完整 path（路径天然是 best key）
 *   - cmd-based:  提取命令名 + 关键参数 → 短则直接使用，长则追加 hash
 *   - fallback:   fnv1a(toolName + sortedArgs) → 永远不碰撞
 *
 * @param call    tool call 对象
 * @param maxLen  key 最大长度（超过则追加 hash），默认无限制
 */
export function deriveStableKey(
  call: ToolCall,
  maxLen?: number,
): string {
  const { name } = call.function;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch {
    // 非 JSON 参数 → fallback
  }

  const path = typeof args.path === 'string' ? args.path : undefined;
  const cmd = typeof args.command === 'string' ? args.command : undefined;

  // 策略 1: path-based — 完整路径
  if (path) {
    return `${name}:${path}`;
  }

  // 策略 2: cmd-based — 命令名 + 第一个实质性参数
  if (cmd) {
    const cleanCmd = cmd.replace(/\s+/g, ' ').trim();
    // 提取命令名（第一个词）+ 第一个非 flag 参数
    const parts = cleanCmd.split(' ');
    const cmdName = parts[0] ?? cmd;
    const firstArg = parts.find((p) => !p.startsWith('-')) ?? '';
    const base = firstArg
      ? `shell:${cmdName}_${firstArg}`
      : `shell:${cmdName}`;

    // 如果 key 已足够区分，直接返回
    if (!maxLen || base.length <= maxLen) {
      // 但 cmd 确实可能导致碰撞 → 追加短 hash
      const shortHash = fnv1a(cleanCmd).toString(36).slice(0, 4);
      return `${base}_${shortHash}`;
    }

    // key 太长 → 截断命令部分 + hash
    const truncatedBase = wordBoundaryTruncate(base, maxLen - 6);
    const hash = fnv1a(cleanCmd).toString(36).slice(0, 4);
    return `${truncatedBase}_${hash}`;
  }

  // 策略 3: fallback — hash 保证唯一性
  const signature = `${name}:${JSON.stringify(args, Object.keys(args).sort())}`;
  const hash = fnv1a(signature).toString(36);
  const fallback = `${name}:${hash}`;

  // 如果提供了 maxLen 且 fallback 超限，截断 name + hash
  if (maxLen && fallback.length > maxLen) {
    const truncatedName = name.slice(0, maxLen - hash.length - 2);
    return `${truncatedName}:${hash}`;
  }

  return fallback;
}

// ============================================================================
// §5 extractIntent — 智能意图提取
// ============================================================================

// 中英文动词模式
const INTENT_VERB_PATTERNS: readonly RegExp[] = [
  // 中文动词短语
  /(?:修复|添加|实现|重构|优化|删除|创建|编写|设计|调试|测试|部署|分析|搜索|查找|解释|翻译|转换|升级|迁移|配置|集成)[^\n。！？.!?]*/,
  // 英文动词短语
  /\b(?:fix|add|implement|refactor|optimize|remove|delete|create|write|build|design|debug|test|deploy|analyze|search|find|explain|translate|convert|upgrade|migrate|configure|integrate|update|change|modify|replace|move|rename|split|merge|extract)\s+[^\n.!?]+/i,
];

/**
 * 从用户输入中智能提取意图。
 *
 * 策略:
 *   1. 找第一个完整句子（以 `.` `。` `!` `？` `\n` 为界）
 *   2. 短句 → 直接返回
 *   3. 长句 → 用动词-名词模式定位核心语义，向两侧扩展
 *   4. fallback → 词边界截断
 *
 * @param input    用户原始输入
 * @param maxChars 最大输出字符数，默认 60
 */
export function extractIntent(
  input: string,
  maxChars: number = SYSTEM.INTENT_EXTRACT_MAX_LENGTH,
): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 策略 1: 完整短句
  const sentenceEnd = findSentenceEnd(trimmed);
  const firstSentence = sentenceEnd > 0
    ? trimmed.slice(0, sentenceEnd + 1).trim()
    : trimmed;

  if (firstSentence.length <= maxChars) return firstSentence;

  // 策略 2: 动词-名词定位
  for (const pattern of INTENT_VERB_PATTERNS) {
    const m = firstSentence.match(pattern);
    if (m && m[0]) {
      const verbPhrase = m[0];
      const matchStart = m.index ?? 0;

      // 向两侧扩展到 maxChars
      let start = matchStart;
      let end = matchStart + verbPhrase.length;

      const remaining = maxChars - verbPhrase.length;
      if (remaining > 0) {
        // 扩展左侧（取上下文前缀）
        const leftBudget = Math.min(remaining / 2, matchStart);
        start = Math.max(0, matchStart - Math.floor(leftBudget));
        // 扩展到词边界
        while (start > 0 && /\w/.test(trimmed[start - 1]!)) start--;

        // 扩展右侧
        const rightBudget = maxChars - (end - start);
        end = Math.min(trimmed.length, end + rightBudget);
        while (end < trimmed.length && /\w/.test(trimmed[end]!)) end++;
      }

      const extracted = trimmed.slice(start, end).trim();
      const prefix = start > 0 ? '…' : '';
      const suffix = end < trimmed.length ? '…' : '';
      return prefix + extracted + suffix;
    }
  }

  // 策略 3: 词边界截断
  return wordBoundaryTruncate(trimmed, maxChars - 1) + '…';
}

/**
 * 找到第一个句子结束位置
 * 支持中英文标点：`.`, `。`, `!`, `！`, `?`, `？`, `\n`
 */
function findSentenceEnd(text: string): number {
  const ends = ['.', '。', '!', '！', '?', '？', '\n'];
  let earliest = -1;
  for (const end of ends) {
    const idx = text.indexOf(end);
    if (idx >= 0 && (earliest < 0 || idx < earliest)) {
      earliest = idx;
    }
  }
  return earliest;
}

// ============================================================================
// §6 smartDisplayTruncate — 词/字边界安全展示截断
// ============================================================================

/**
 * 在词或字符边界处截断文本，保证不切断多字节字符。
 *
 * - ASCII/拉丁文本: 在空格/标点后截断（词边界）
 * - CJK 文本: 在字符边界截断
 * - emoji: 使用 Intl.Segmenter（Node 22+）或手动 grapheme 处理
 *
 * @param s      原始字符串
 * @param maxLen 最大长度（含省略号占位）
 */
export function smartDisplayTruncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;

  // ★ Intl.Segmenter 提供 grapheme-cluster 级别的分割
  // Node 22 / Chrome 均支持
  let segmenter: Intl.Segmenter | undefined;
  try {
    segmenter = new Intl.Segmenter('zh-Hans-CN', { granularity: 'word' });
  } catch {
    // Fallback: 按 grapheme 分割（兼容旧 Node）
    try {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      // 极旧环境 → 只能按字符截断
      return s.slice(0, maxLen - 1) + '…';
    }
  }

  // 按 word/grapheme 收集边界
  const boundaries: number[] = [];
  for (const seg of segmenter.segment(s)) {
    boundaries.push(seg.index);
  }
  boundaries.push(s.length);

  // 目标位置（预留 1 个字符给省略号 "…"）
  const target = maxLen - 1;

  // 找 ≤ target 的最大边界
  let cutAt = 0;
  for (const b of boundaries) {
    if (b <= target) {
      cutAt = b;
    } else {
      break;
    }
  }

  // 如果截断点在单词中间（ASCII 文本），回退到上一个空格
  if (cutAt > 0 && cutAt < s.length) {
    const charBefore = s[cutAt - 1];
    const charAfter = s[cutAt];
    if (
      charBefore &&
      charAfter &&
      /\w/.test(charBefore) &&
      /\w/.test(charAfter)
    ) {
      // 在单词中间 → 往前找空格或标点
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
// §7 底层工具函数
// ============================================================================

/**
 * 在词边界截断文本。
 * 优先在空格/标点处断，其次在字符边界。
 */
function wordBoundaryTruncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;

  // 往前找最近的非字母数字字符
  for (let i = maxLen - 1; i > maxLen * 0.6; i--) {
    if (/[\s,.;:!?\-)\]}>'"\/\\]/.test(s[i]!)) {
      return s.slice(0, i + 1).trimEnd();
    }
  }

  // fallback: 字符边界截断
  return s.slice(0, maxLen);
}

// ============================================================================
// §8 scoreMessageImportance — 消息级重要性评分
// ============================================================================

/**
 * 对单条 tool result 消息打分 (0-100)，决定压缩级别。
 *
 * 来源: LongLLMLingua (2024) — 不同消息按相关度获得不同压缩率。
 *       CodeAndSeek (2026) — compactContextEvent() 对字段分级截断。
 *
 * @param content   tool result 的完整内容
 * @param toolName  工具名
 * @param _args     (保留) 工具参数——未来可用于路径感知的额外打分
 */
export function scoreMessageImportance(
  content: string | null,
  toolName: string,
  _args?: Record<string, unknown>,
): number {
  if (!content) return 0;
  let score = 30; // 基线

  // 含错误关键词
  if (ERROR_PATTERNS.some((p) => p.test(content))) {
    score += SYSTEM.MESSAGE_IMPORTANCE_ERROR_BONUS;
  }

  // 含测试结果
  if (TEST_PATTERNS.some((p) => p.test(content))) {
    score += SYSTEM.MESSAGE_IMPORTANCE_TEST_BONUS;
  }

  // 含 diff hunk
  if (HUNK_HEADER_RE.test(content) || content.includes('+++') || content.includes('---')) {
    score += SYSTEM.MESSAGE_IMPORTANCE_DIFF_BONUS;
  }

  // 内容过长 → 可能是噪音
  if (content.length > SYSTEM.MESSAGE_IMPORTANCE_LONG_THRESHOLD) {
    score += SYSTEM.MESSAGE_IMPORTANCE_LONG_PENALTY;
  }

  // 核心文件操作
  // 从工具名推断——写操作涉及的路径通常在 ToolCall.function.arguments 中
  // 这里从 toolName 做粗略判断：核心工具操作默认 +10
  const coreTools = ['file_write', 'file_edit', 'file_delete'];
  if (coreTools.includes(toolName)) {
    score += SYSTEM.MESSAGE_IMPORTANCE_CORE_FILE_BONUS;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * 根据 importance score 返回压缩级别 + 压缩后的内容。
 *
 * @returns { level, content } — 压缩级别 + 压缩后内容
 */
export function compressByLevel(
  content: string | null,
  toolName: string,
  _args?: Record<string, unknown>,
): { level: 'preserve' | 'summarize' | 'squash'; content: string } {
  const score = scoreMessageImportance(content, toolName, _args);
  const safeName = toolName || 'unknown';

  if (score >= SYSTEM.MESSAGE_IMPORTANCE_PRESERVE_THRESHOLD) {
    return { level: 'preserve', content: content ?? '' };
  }

  if (score >= SYSTEM.MESSAGE_IMPORTANCE_SUMMARIZE_THRESHOLD) {
    return {
      level: 'summarize',
      content: summarizeToolOutput(content, toolName),
    };
  }

  // squash: 极端压缩
  const short = content
    ? wordBoundaryTruncate(content.replace(/\n/g, ' '), 80)
    : 'no output';
  return {
    level: 'squash',
    content: `[squashed] ${safeName}: ${short}`,
  };
}
