/**
 * index.ts — napi-rs 桥接层
 *
 * 实现 INativeTools 契约 (Contract B)，
 * 将 Rust comdr-tools 的原生导出包装为 TypeScript 接口。
 *
 * 类型映射:
 *   Rust JsExecuteOptions  →  TS ToolExecuteOptions
 *   Rust JsExecuteResult   →  TS ToolExecuteResult
 *   Rust JsToolDefinition  →  TS ToolDefinition
 *
 * @agent Agent 3 — 此文件由 Agent 3 维护
 */

import { createRequire } from 'node:module';

import { validateJSONSchemaProperty, TOOL_PERMISSION, ERROR_CATEGORY } from '@comdr/core';

// ============================================================================
// §0 CJS 兼容——createRequire 安全包装
// ============================================================================
// esbuild 以 CJS 格式打包时 import.meta.url 为空，createRequire(undefined) 会抛
// "The argument 'filename' must be a file URL object..."。
// 这里在 CJS 环境下回退到 __filename（esbuild CJS bundle 中可用）。
function createSafeRequire(): NodeRequire {
  try {
    return createRequire(import.meta.url);
  } catch {
    // CJS bundle fallback
    const file = (typeof __filename !== 'undefined' && __filename)
      || `${process.cwd()}/noop.js`;
    return createRequire(file);
  }
}
import type {
  INativeTools,
  ToolExecuteOptions,
  ToolResult,
  ToolDefinition,
  ToolPermission,
  JSONSchema,
} from '@comdr/core';

// ============================================================================
// §1 加载原生模块
// ============================================================================

const require = createSafeRequire();

/**
 * napi-rs 原生模块导出:
 *   execute(opts)  → JsExecuteResult
 *   rollback(id)   → bool
 *   listTools()    → JsToolDefinition[]
 */
interface NativeModule {
  execute(opts: NativeExecuteOptions): NativeExecuteResult;
  rollback(snapshotId: string): boolean;
  forgetSnapshot(snapshotId: string): boolean;
  listTools(): NativeToolDefinition[];
  /** Bootstrap: scan project for symbols and references. Returns JSON string. */
  bootstrapProject(projectPath: string): string;
}

interface NativeExecuteOptions {
  name: string;
  arguments: Record<string, unknown>;
  projectPath?: string;
  timeoutMs: number;
}

interface NativeExecuteResult {
  ok: boolean;
  content: string | null;
  errorCategory?: string | null;
  diffSummary?: string | null;
  snapshotId?: string | null;
  durationMs?: number | null;
  // Step 6 Test Feedback
  testPassed?: number | null;
  testFailed?: number | null;
  testOutput?: string | null;
  testFile?: string | null;
}

interface NativeToolDefinition {
  name: string;
  description: string;
  /** serde_json::Value — 在 JS 侧已是普通对象 */
  parameters: Record<string, unknown>;
  permission: string;
  timeoutMs: number;
}

/**
 * 原生模块路径 — 相对于本包的编译产物 dist/ 目录
 */
const NATIVE_MODULE_PATH = '../../../crates/comdr-tools/comdr_tools.node';

let nativeModule: NativeModule;

try {
  nativeModule = require(NATIVE_MODULE_PATH) as NativeModule;
} catch (err) {
  // 原生模块不可用时的占位——所有调用返回错误
  console.warn(
    `[Comdr] Native tools module not loaded (${NATIVE_MODULE_PATH}): ${String(err)}. ` +
    'All tool calls will return errors. Run `pnpm build:tools` to compile the Rust module.',
  );
  nativeModule = {
    execute: () => ({
      ok: false,
      content: 'Native tools module (comdr-tools) not loaded. Run `pnpm build:tools` to compile the Rust module.',
      errorCategory: 'execution_error',
      diffSummary: null,
      snapshotId: null,
    }),
    rollback: () => false,
    forgetSnapshot: () => false,
    listTools: () => [],
    bootstrapProject: () => '{"symbols":[],"references":[],"files_scanned":[]}',
  };
}

// ============================================================================
// §2 NativeTools 类 — 实现 INativeTools 契约
// ============================================================================

export class NativeTools implements INativeTools {
  private readonly projectPath: string;

  constructor(projectPath: string = process.cwd()) {
    this.projectPath = projectPath;
  }

  /**
   * 执行工具（SDB 6 步管线）
   *
   * ★ 直接返回 ToolResult（不含中间层 ToolExecuteResult）。
   *    callId 和 toolName 由 opts 透传，Agent 4 无需再映射。
   */
  execute(opts: ToolExecuteOptions): ToolResult {
    const nativeOpts: NativeExecuteOptions = {
      name: opts.name,
      arguments: opts.arguments,
      projectPath: opts.projectPath ?? this.projectPath,
      timeoutMs: opts.timeoutMs,
    };

    const result = nativeModule.execute(nativeOpts);

    // Build testFeedback if Step 6 ran tests
    const hasTestFeedback = result.testPassed != null || result.testFailed != null;
    const testFeedback = hasTestFeedback ? {
      passed: result.testPassed ?? 0,
      failed: result.testFailed ?? 0,
      output: result.testOutput ?? undefined,
      testFile: result.testFile ?? undefined,
    } : undefined;

    return {
      callId: opts.callId,
      toolName: opts.name,
      ok: result.ok,
      content: result.content,
      errorCategory: validateErrorCategory(result.errorCategory),
      diffSummary: result.diffSummary ?? undefined,
      snapshotId: result.snapshotId ?? undefined,
      durationMs: result.durationMs ?? undefined,
      testFeedback,
    };
  }

  /**
   * 回滚到指定快照（恢复文件 + 移除快照）
   */
  rollback(snapshotId: string): boolean {
    return nativeModule.rollback(snapshotId);
  }

  /**
   * 丢弃快照（仅移除，不恢复文件）。
   * self-correct 成功后清理原始快照。
   */
  discardSnapshot(snapshotId: string): boolean {
    return nativeModule.forgetSnapshot(snapshotId);
  }

  /**
   * 列出所有注册工具的定义
   */
  listTools(): ToolDefinition[] {
    const native = nativeModule.listTools();
    return native.map(mapToolDefinition);
  }
}

// ============================================================================
// §3 类型映射函数
// ============================================================================

// 有效的 ErrorCategory 值——与 @comdr/core ErrorCategory 类型保持同步
const VALID_ERROR_CATEGORIES = new Set([
  ERROR_CATEGORY.SCHEMA_INVALID,
  ERROR_CATEGORY.PERMISSION_DENIED,
  ERROR_CATEGORY.TIMEOUT,
  ERROR_CATEGORY.FILE_NOT_FOUND,
  ERROR_CATEGORY.TEST_FAILED,
  ERROR_CATEGORY.DIFF_MISMATCH,
  ERROR_CATEGORY.SNAPSHOT_FAILED,
  ERROR_CATEGORY.ROLLBACK_FAILED,
  ERROR_CATEGORY.EXECUTION_ERROR,
]);

/**
 * 验证并透传 error_category 字符串。
 * Rust 侧直接发出 ErrorCategory 值，这里只做白名单校验。
 */
function validateErrorCategory(
  cat?: string | null,
): ToolResult['errorCategory'] {
  if (!cat) return undefined;
  // has() 参数类型为 ErrorCategory（文字联合），因此 cat as 是外部信任的狭窄转换
  if (!(VALID_ERROR_CATEGORIES as ReadonlySet<string>).has(cat)) return undefined;
  return cat as ToolResult['errorCategory'];
}

/**
 * NativeToolDefinition → ToolDefinition
 */
function mapToolDefinition(native: NativeToolDefinition): ToolDefinition {
  // 将 parameters 转为 JSONSchema
  const parameters: JSONSchema = {
    type: 'object',
    properties: {},
  };

  if (
    native.parameters &&
    typeof native.parameters === 'object' &&
    !Array.isArray(native.parameters)
  ) {
    const params = native.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, unknown> | undefined;
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        const validated = validateJSONSchemaProperty(value);
        if (validated) {
          parameters.properties![key] = validated;
        }
      }
    }
    const required = params.required;
    if (Array.isArray(required) && required.every((v): v is string => typeof v === 'string') && required.length > 0) {
      parameters.required = required;
    }
  }

  return {
    name: native.name,
    description: native.description,
    parameters,
    permission: mapPermission(native.permission),
    timeoutMs: native.timeoutMs,
  };
}

/**
 * 字符串 → ToolPermission
 */
function mapPermission(p: string): ToolPermission {
  switch (p) {
    case TOOL_PERMISSION.READ_ONLY:
      return TOOL_PERMISSION.READ_ONLY;
    case TOOL_PERMISSION.DESTRUCTIVE:
      return TOOL_PERMISSION.DESTRUCTIVE;
    case TOOL_PERMISSION.REQUIRES_APPROVAL:
      return TOOL_PERMISSION.REQUIRES_APPROVAL;
    default:
      return TOOL_PERMISSION.REQUIRES_APPROVAL;
  }
}

// ============================================================================
// §4 工厂函数
// ============================================================================

/**
 * 创建 NativeTools 实例
 *
 * @param projectPath 项目根目录（用于相对路径解析和快照存储）
 */
export function createNativeTools(
  projectPath?: string,
): INativeTools {
  return new NativeTools(projectPath);
}

// ============================================================================
// §5 Bootstrap — 项目静态分析
// ============================================================================

/**
 * Bootstrap 返回的类型定义。
 * 与 Rust bootstrap::BootstrapReport 保持同步。
 */
export interface BootstrapSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'module' | 'variable';
  file_path: string;
  location: string | null;
  exported: boolean;
}

export interface BootstrapReference {
  from_name: string;
  from_file: string;
  to_name: string;
  to_file: string | null;
  ref_type: 'imports' | 'calls';
}

export interface BootstrapReport {
  symbols: BootstrapSymbol[];
  references: BootstrapReference[];
  files_scanned: string[];
}

/**
 * 扫描项目目录，提取所有符号和引用。
 *
 * 调用 Rust 层 pattern-based 解析器。
 * 若 Rust 模块未编译 → 静默降级，返回空 report。
 *
 * @param projectPath  项目根目录的绝对路径
 * @returns            BootstrapReport（JSON 解析后的对象）
 */
export function bootstrapProject(projectPath: string): BootstrapReport {
  try {
    const json = nativeModule.bootstrapProject(projectPath);
    const parsed = JSON.parse(json) as BootstrapReport;
    // 验证结构
    if (!Array.isArray(parsed.symbols) || !Array.isArray(parsed.references) || !Array.isArray(parsed.files_scanned)) {
      return { symbols: [], references: [], files_scanned: [] };
    }
    return parsed;
  } catch (err) {
    // Rust 模块未编译 或 解析失败 → 静默降级
    return { symbols: [], references: [], files_scanned: [] };
  }
}

export { nativeModule as _nativeModule };
