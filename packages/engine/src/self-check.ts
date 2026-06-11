/**
 * self-check.ts — 自检管线
 *
 * ★ L2 自检——确定性规则检查，执行后验证，偏离即标记，不拦截。
 *
 * 来源：
 *   ContextCov (UW 2025)              — 从项目指令文件提取可执行检查
 *   Guardrails Over Gigabytes (2025)   — Guards as sensors not filters
 *   Specification as Quality Gate (2025) — 确定性验证 → AI 只审残余
 *
 * 设计原则：
 *   1. check() 是纯函数——不调 LLM
 *   2. 偏离 → 注入 [self-check] 消息，不阻止执行
 *   3. 同文件同规则同偏离去重——不刷屏
 *   4. 零样本 = 零消耗——不触发不检查
 *   5. 解析容错——不确定时不误报，宁可漏检不误检
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { ToolCall, ToolResult } from '@comdr/core/types';
import { SYSTEM } from '@comdr/core';
import { safeParseArgs } from './utils.js';

// ============================================================================
// §1 类型
// ============================================================================

export interface CheckRule {
  /** 规则标识 */
  id: string;
  /** 人类可读描述 */
  description: string;
  /**
   * 触发条件——返回 false 略过此规则。
   * 轻量检查（不读文件、不调 LLM）。
   */
  assess(call: ToolCall): boolean;
  /**
   * 执行检查。
   * @returns null = 通过；CheckIssue = 存在问题
   */
  check(call: ToolCall, result: ToolResult, ctx: CheckContext): CheckIssue | null;
}

export interface CheckIssue {
  /** 偏离级别 */
  severity: 'suggestion' | 'warning';
  /** 简短描述（注入 [self-check] 消息） */
  message: string;
  /** 可选：具体建议 */
  hint?: string;
}

export interface CheckContext {
  projectPath: string;
  /** 已扫描的文件列表（构造时 bootstrap + session 内新文件） */
  allFiles: string[];
  /** ★ 文件内容缓存——避免重复 IO（同 session 内文件不变） */
  fileCache: Map<string, string>;
}

// ============================================================================
// §2 预处理——字符级解析的安全基础
// ============================================================================

/**
 * 从行内容中剥离泛型参数 `<...>`。
 * 处理嵌套泛型：`Map<string, {value: number}>` → `Map`
 * 处理箭头泛型：`foo<T>()` → `foo()`
 */
function stripGenerics(line: string): string {
  let result = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '<') {
      depth++;
      continue;
    }
    if (ch === '>') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) {
      result += ch;
    }
  }
  return result;
}

/**
 * 剥离字符串字面量和模板字面量——防止 `${}` 和 `'{}'` 干扰 brace 计数。
 */
function stripStringLiterals(line: string): string {
  // 移除单引号字符串
  let result = line.replace(/'[^']*'/g, "''");
  // 移除双引号字符串
  result = result.replace(/"[^"]*"/g, '""');
  // 移除模板字面量（含嵌套 `${}`）
  result = result.replace(/`(?:[^`\\]|\\.)*`/g, '``');
  return result;
}

/**
 * 为 brace 计数做预处理：剥离泛型 + 剥离字符串 + 剥离正则字面量。
 */
function forBraceCounting(line: string): string {
  let cleaned = stripStringLiterals(line);
  cleaned = stripGenerics(cleaned);
  // 剥离正则字面量中的 {}：/{\/gi 等
  cleaned = cleaned.replace(/\/[^/]*\{[^/]*\/g?,?/g, '//');
  return cleaned;
}

// ============================================================================
// §3 骨架提取
// ============================================================================

/**
 * 控制流关键字——方法签名检测中排除。
 */
const CONTROL_FLOW_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch',
  'try', 'finally', 'throw', 'return', 'break', 'continue', 'typeof',
  'new', 'delete', 'void', 'yield', 'await', 'import', 'export',
]);

/**
 * 从文件名提取角色后缀。
 * "FXJController.ts" → "Controller"
 * "ShopController.ts" → "Controller"
 *
 * 验证规则：提取到的后缀必须在同目录下匹配 ≥2 个文件，否则返回空。
 *
 * 算法：取 basename 中末尾大写字母开头+连续小写字母的单词。
 */
function extractRoleSuffix(filePath: string, allFiles: string[], projectPath: string): string {
  const name = basename(filePath, '.ts');
  const match = name.match(/[A-Z][a-z]+/g);
  if (!match || match.length === 0) return '';
  const suffix = match[match.length - 1];
  if (!suffix) return '';

  // 验证：同目录下是否有 ≥2 个同后缀文件
  const targetDir = dirname(filePath).replace(/\\/g, '/');
  const count = allFiles.filter((f) => {
    const fDir = dirname(f).replace(/\\/g, '/');
    return fDir === targetDir && f.endsWith(`${suffix}.ts`);
  }).length;

  // ★ 需要至少 2 个同类文件才触发检查——这意味着刚创建的文件
  //   （同目录仅 1 个）不会触发。这是设计上的冷启动限制：检查需兄弟文件
  //   作为参考基线。随着项目增长会自然解决。
  return count >= 2 ? suffix : '';
}

/**
 * 从文件内容提取结构签章。
 *
 * ★ 解析策略：预处理剥离泛型/字符串后计数 brace 深度，容忍常见 TypeScript 模式。
 * 不确定的边界宁可漏过——不误报比不漏检更重要。
 *
 * 提取内容：
 *   - import 语句
 *   - @decorator 行
 *   - class 声明行（含 extends）
 *   - 方法签名（不含方法体）
 */
function extractStructure(content: string): string[] {
  const lines: string[] = [];
  const raw = content.split('\n');

  let inMethodBody = 0;
  let captureNextLine = false;

  for (const rawLine of raw) {
    const line = rawLine.trim();
    if (!line) continue;

    // import 行
    if (line.startsWith('import ')) {
      lines.push(line);
      continue;
    }

    // @decorator 行
    if (line.startsWith('@')) {
      lines.push(line);
      continue;
    }

    // class/interface 声明行
    if (/\b(class|interface)\s+\w+/.test(line)) {
      lines.push(line);
      continue;
    }

    // ★ 预处理后计数 brace——避免泛型/字符串/正则干扰
    const cleaned = forBraceCounting(line);
    const opens = (cleaned.match(/\{/g) ?? []).length;
    const closes = (cleaned.match(/\}/g) ?? []).length;

    if (inMethodBody > 0) {
      inMethodBody += opens - closes;
      if (inMethodBody <= 0) {
        inMethodBody = 0;
      }
      continue;
    }

    // 方法签名检测
    if (isMethodSignature(line)) {
      lines.push(line);
      captureNextLine = true;
      inMethodBody += opens - closes;
      continue;
    }

    // 捕获方法体的第一行（纯文本，非注释）
    if (captureNextLine && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*')) {
      lines.push(`  ${line}`);
      captureNextLine = false;
      continue;
    }
  }

  return lines;
}

/**
 * 判断是否是方法签名行。
 *
 * ★ 排除控制流关键字，减少误匹配。
 */
function isMethodSignature(line: string): boolean {
  // 以访问修饰符或 async/static 开头 → 几乎肯定是方法
  if (/^(public|private|protected|async|static)/.test(line)) return true;

  // 不含 ( → 肯定不是
  if (!line.includes('(')) return false;

  // 以常见控制流关键字开头 → 不是方法
  const firstWord = line.match(/^(\w+)/);
  if (firstWord && firstWord[1] && CONTROL_FLOW_KEYWORDS.has(firstWord[1])) return false;

  // 看起来像方法调用/函数声明：以 word( 开头，且不是在注释中
  // ★ 排除：赋值右边、对象属性、箭头函数
  if (
    /^\w+\s*\(/.test(line) &&
    !line.includes('=>')        // 不是箭头函数内联
  ) {
    return true;
  }

  return false;
}

// ============================================================================
// §4 归一化与合并
// ============================================================================

/**
 * 归一化代码行——替换标识符和字符串字面量为占位符。
 *
 * - PascalCase 标识符 → Xxx（类名、类型名）
 * - camelCase 标识符 → xxx（方法名、变量名）
 * - 字符串字面量 → '...' / "..." / `...`
 * - import 路径 → './...'
 */
function normalizeLine(line: string): string {
  return line
    // 先处理字符串（防止字符串内的标识符被替换）
    .replace(/'[^']*'/g, "'...'")
    .replace(/"[^"]*"/g, '"..."')
    .replace(/`[^`]*`/g, '`...`')
    // import 路径
    .replace(/from\s+['"]\.\/[^'"]+['"]/g, "from './...'")
    .replace(/from\s+['"]\.\.\/[^'"]+['"]/g, "from '../...'")
    // PascalCase → Xxx
    .replace(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g, 'Xxx')
    // 单个大写开头单词（可能是类型注解）
    .replace(/:\s*[A-Z][a-zA-Z]+\b/g, ': Xxx')
    // camelCase 方法调用
    .replace(/\b[a-z]+[A-Z][a-zA-Z]*\b/g, 'xxx');
}

/**
 * 合并多个文件的签章——只保留 ≥threshold 个文件共有的行。
 */
function mergeSkeletons(allLines: string[][], threshold: number): string[] {
  if (allLines.length < threshold) return [];

  const freq = new Map<string, number>();
  for (const lines of allLines) {
    const seen = new Set<string>();
    for (const line of lines) {
      const normalized = normalizeLine(line);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        freq.set(normalized, (freq.get(normalized) ?? 0) + 1);
      }
    }
  }

  const common: string[] = [];
  for (const [line, count] of freq) {
    if (count >= threshold) {
      common.push(`${line}  // [${count}/${allLines.length}]`);
    }
  }
  return common;
}

// ============================================================================
// §5 文件读取
// ============================================================================

/**
 * 从磁盘读取文件内容（带缓存）。
 */
function readCached(filePath: string, ctx: CheckContext): string | null {
  const cached = ctx.fileCache.get(filePath);
  if (cached !== undefined) return cached;

  const fullPath = join(ctx.projectPath, filePath);
  if (!existsSync(fullPath)) return null;
  try {
    const content = readFileSync(fullPath, 'utf-8');
    ctx.fileCache.set(filePath, content);
    return content;
  } catch {
    return null;
  }
}

/**
 * ★ 清除文件缓存——write/edit 操作后调用，确保 self-check 读到新内容而非旧缓存。
 */
export function invalidateFileCache(filePath: string, ctx: CheckContext): void {
  ctx.fileCache.delete(filePath);
}

// ============================================================================
// §6 内置规则
// ============================================================================

/**
 * sibling-consistency: 检查目标文件与同目录同类文件的结构一致性。
 *
 * ★ 阈值设计（避免假阳性）：
 *   - file_write (新文件): 只检查出现在全部兄弟文件中的方法（100% 共有）
 *   - file_edit (已有文件): 检查出现在 ≥80% 兄弟文件中的方法
 */
export const siblingConsistencyRule: CheckRule = {
  id: 'sibling-consistency',
  description: '检查目标文件与同目录同类文件的结构是否一致',

  assess(call: ToolCall): boolean {
    return call.function.name === 'file_write' || call.function.name === 'file_edit';
  },

  check(call: ToolCall, _result: ToolResult, ctx: CheckContext): CheckIssue | null {
    const args = safeParseArgs(call.function.arguments);
    const targetPath = typeof args.path === 'string' ? args.path : undefined;
    if (!targetPath) return null;

    // 提取角色后缀（含验证：同目录 ≥2 个同后缀文件）
    const suffix = extractRoleSuffix(targetPath, ctx.allFiles, ctx.projectPath);
    if (!suffix) return null;

    const targetDir = dirname(targetPath).replace(/\\/g, '/');

    // 找同目录同后缀的兄弟文件
    const siblings = ctx.allFiles.filter((f) => {
      if (f === targetPath) return false;
      const fDir = dirname(f).replace(/\\/g, '/');
      if (fDir !== targetDir) return false;
      return f.endsWith(`${suffix}.ts`);
    });

    if (siblings.length < 2) return null;

    const sample = siblings.slice(0, SYSTEM.SELF_CHECK_MAX_SIBLINGS);

    // 读兄弟文件
    const siblingContents: string[] = [];
    for (const sib of sample) {
      const content = readCached(sib, ctx);
      if (content) siblingContents.push(content);
    }
    if (siblingContents.length < 2) return null;

    // 读目标文件
    const targetContent = readCached(targetPath, ctx);
    if (!targetContent) return null;

    // 提取签章并合并
    const allSkeletons = siblingContents.map((c) => extractStructure(c));
    const isNewFile = call.function.name === 'file_write';

    // ★ file_write: 只检查全部兄弟都有的方法（threshold = 全部）
    // ★ file_edit: 检查 ≥80% 兄弟都有的方法
    const threshold = isNewFile
      ? siblingContents.length
      : Math.max(2, Math.ceil(siblingContents.length * 0.8));
    const common = mergeSkeletons(allSkeletons, threshold);
    if (common.length === 0) return null;

    const targetStructure = extractStructure(targetContent);

    // 检查缺失
    const missingMethods: string[] = [];
    for (const commonLine of common) {
      const pureLine = commonLine.replace(/\s*\/\/\s*\[\d+\/\d+\]$/, '').trim();
      if (
        pureLine.startsWith('import ') ||
        pureLine.startsWith('@') ||
        pureLine.includes('class ') ||
        pureLine.includes('interface ')
      ) continue;

      const normalized = normalizeLine(pureLine);
      const found = targetStructure.some(
        (t) => normalizeLine(t) === normalized,
      );
      if (!found) {
        missingMethods.push(pureLine);
      }
    }

    if (missingMethods.length > 0) {
      const methodList = missingMethods
        .slice(0, 2)
        .map((m) => `\`${m.trim().slice(0, 60)}\``)
        .join(', ');
      const total = siblingContents.length;
      return {
        severity: isNewFile ? 'warning' : 'suggestion',
        message: `${total} 个同类文件均有的方法，${basename(targetPath)} 中未找到: ${methodList}`,
        hint: isNewFile
          ? `新建的 ${suffix} 应遵循项目惯例`
          : `检查是否意外删除了 ${suffix} 角色的惯例方法`,
      };
    }

    return null;
  },
};

/**
 * file-size-guard: 检查单文件是否过大或多 class。
 *
 * ★ 始终从磁盘读取文件内容（文件刚被工具写入，保证是最新的）。
 */
export const fileSizeGuardRule: CheckRule = {
  id: 'file-size-guard',
  description: '检查单文件是否过大（行数/class 数）',

  assess(call: ToolCall): boolean {
    return call.function.name === 'file_write' || call.function.name === 'file_edit';
  },

  check(call: ToolCall, _result: ToolResult, ctx: CheckContext): CheckIssue | null {
    const args = safeParseArgs(call.function.arguments);
    const targetPath = typeof args.path === 'string' ? args.path : undefined;
    if (!targetPath) return null;

    // ★ 从磁盘读取——文件已由工具写入
    const content = readCached(targetPath, ctx);
    if (!content) return null;

    const lines = content.split('\n');
    const lineCount = lines.length;

    // 统计 class/interface 定义数——排除注释和字符串中的关键字
    // 简单过滤：移除注释行后再统计
    const codeOnly = lines
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*');
      })
      .join('\n');
    const classCount = (codeOnly.match(/\bclass\s+\w+/g) ?? []).length;

    if (
      lineCount > SYSTEM.SELF_CHECK_MAX_FILE_LINES &&
      classCount >= SYSTEM.SELF_CHECK_MAX_CLASSES_PER_FILE
    ) {
      return {
        severity: 'warning',
        message: `${basename(targetPath)}: ${lineCount} 行、${classCount} 个 class——建议拆分`,
        hint: '同类文件通常每文件 1-2 个 class',
      };
    }

    if (lineCount > SYSTEM.SELF_CHECK_MAX_FILE_LINES) {
      return {
        severity: 'suggestion',
        message: `${basename(targetPath)}: ${lineCount} 行（阈值 ${SYSTEM.SELF_CHECK_MAX_FILE_LINES} 行）`,
        hint: '考虑拆分为更小的模块',
      };
    }

    return null;
  },
};

// ============================================================================
// §7 规则注册
// ============================================================================

export const builtinRules: CheckRule[] = [
  siblingConsistencyRule,
  fileSizeGuardRule,
];
