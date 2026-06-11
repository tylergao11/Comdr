/**
 * skills.ts — 渐进式 Skills 加载
 *
 * 来源：Live-SWE-agent 运行时工具生成 + Claude Code Skills 系统
 *
 * ★ 启动只注入 name + description（渐进式）
 * LLM 调用 skill → 正文注入下一轮
 *
 * ★ 新增：Live-SWE-agent 式的运行时 Skill 创建
 * Agent 可以创建自己的 skill（Python/Bash 脚本），
 * 立即成为下一轮可用的工具。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

import type {
  ToolDefinition,
  JSONSchema,
  SkillManifest,
} from '@comdr/core/types';
import { TOOL_PERMISSION, SYSTEM } from '@comdr/core';
import { ADVANCED_TOOLS } from './tools/advanced-tools.js';

// ============================================================================
// §1 类型定义
// ============================================================================

interface RuntimeSkill {
  path: string;
  definition: ToolDefinition;
  body: string | null;
  createdAt: number;
}

// ============================================================================
// §2 SkillsLoader 类
// ============================================================================

export class SkillsLoader {
  /** 静态 skill 注册表（从文件系统加载） */
  private registry: Map<string, SkillManifest> = new Map();

  /** 运行时 skill 注册表 */
  private runtimeSkills: Map<string, RuntimeSkill> = new Map();

  /** 已注入正文的 skill 集合 */
  private expandedSkills: Set<string> = new Set();

  // --------------------------------------------------------------------------
  // 静态 skill 管理
  // --------------------------------------------------------------------------

  /**
   * 注册静态 skill（从 SKILL.md 文件解析）
   */
  registerSkill(manifest: SkillManifest): void {
    this.registry.set(manifest.name, manifest);
  }

  /**
   * 批量注册
   */
  registerSkills(manifests: SkillManifest[]): void {
    for (const m of manifests) {
      this.registerSkill(m);
    }
  }

  /**
   * ★ 渐进式加载：标记 skill 正文已在 prompt 中注入
   * 下次 buildToolDefinitions 时包含完整正文
   */
  expandSkill(name: string): void {
    this.expandedSkills.add(name);
  }

  // --------------------------------------------------------------------------
  // 运行时 skill 管理
  // --------------------------------------------------------------------------

  /**
   * ★ Live-SWE-agent 式运行时工具创建
   * Agent 写了脚本后，自动注册为可调用 tool
   */
  registerRuntimeSkill(
    path: string,
    definition: Omit<ToolDefinition, 'parameters'> & {
      parameters?: JSONSchema;
    },
    body?: string,
  ): void {
    this.runtimeSkills.set(definition.name, {
      path,
      definition: {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters ?? {
          type: 'object',
          properties: {
            args: {
              type: 'string',
              description: 'Arguments to pass to the script',
            },
          },
        },
        permission: TOOL_PERMISSION.REQUIRES_APPROVAL,
        timeoutMs: SYSTEM.DEFAULT_SKILL_TIMEOUT_MS,
      },
      body: body ?? null,
      createdAt: Date.now(),
    });
  }

  /**
   * 注销运行时 skill
   */
  unregisterRuntimeSkill(name: string): void {
    this.runtimeSkills.delete(name);
  }

  // --------------------------------------------------------------------------
  // 工具定义导出
  // --------------------------------------------------------------------------

  /**
   * 获取所有活跃工具定义（包括内建 + 运行时）
   */
  activeTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    // 内建工具（始终可用）
    tools.push(...BUILTIN_TOOLS);

    // ★ 高级工具（TS 层工具——tool_search, file_search, memory_recall, symbol_find, shell_test）
    tools.push(...ADVANCED_TOOLS);

    // 静态 skill（渐进式：正文未注入时只提供 name + description）
    for (const [, skill] of this.registry) {
      const isExpanded = this.expandedSkills.has(skill.name);

      tools.push({
        name: `skill__${skill.name}`,
        description: isExpanded && skill.body
          ? `${skill.description}\n\n---\n${skill.body}`
          : `${skill.description} (invoke to load full instructions)`,
        parameters: {
          type: 'object',
          properties: {
            args: {
              type: 'string',
              description: `Arguments for the ${skill.name} skill`,
            },
          },
        },
        permission: TOOL_PERMISSION.REQUIRES_APPROVAL,
        timeoutMs: SYSTEM.EXPANDED_SKILL_TIMEOUT_MS,
      });
    }

    // 运行时 skill
    for (const [, skill] of this.runtimeSkills) {
      tools.push({
        ...skill.definition,
        name: `runtime__${skill.definition.name}`,
        description: `[Runtime] ${skill.definition.description} (created at turn)`,
      });
    }

    return tools;
  }

  // @phase2 预留方法已删除——activeToolNames/isSkillTool/isStaticSkill/extractSkillName/getSkillManifest。
  // 渐进式 skill 展开在需要时重新实现。

  // --------------------------------------------------------------------------
  // Skills 文件系统扫描
  // --------------------------------------------------------------------------

  /**
   * ★ 递归扫描 skills 目录，加载所有 SKILL.md 文件
   *
   * SKILL.md 格式:
   *   ---
   *   name: my-skill
   *   description: Does something useful
   *   triggers: [build, compile]
   *   ---
   *
   *   # My Skill
   *   Full skill body here...
   *
   * 渐进式加载: 启动时只注册 name + description，
   * LLM 调用后 expandSkill() 注入正文。
   *
   * @param dirPath  技能目录路径（如 "skills/" 或绝对路径）
   * @returns        加载的 skill 数量
   */
  scanDirectory(dirPath: string): number {
    if (!existsSync(dirPath)) return 0;

    this._scanRecursive(dirPath, dirPath);
    return this.registry.size;
  }

  /**
   * 递归扫描子目录
   */
  private _scanRecursive(
    rootDir: string,
    currentDir: string,
  ): void {
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        this._scanRecursive(rootDir, fullPath);
      } else if (
        stat.isFile() &&
        (entry === 'SKILL.md' || entry === 'skill.md')
      ) {
        try {
          const manifest = this.parseSkillFile(fullPath);
          if (manifest) {
            this.registerSkill(manifest);
          }
        } catch {
          // 解析失败 → 跳过
        }
      }
    }
  }

  /**
   * 解析单个 SKILL.md 文件
   */
  private parseSkillFile(filePath: string): SkillManifest | null {
    const raw = readFileSync(filePath, 'utf-8');

    // 提取 frontmatter（--- 分隔）
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const fmText = fmMatch[1]!;
    const body = raw.slice(fmMatch[0].length).trim() || null;

    // 简单 YAML-style frontmatter 解析（无需 yaml 依赖）
    const fm = this.parseFrontmatter(fmText);

    const name = typeof fm.name === 'string' ? fm.name : basename(dirname(filePath));
    const description = typeof fm.description === 'string' ? fm.description : `${name} skill`;

    // 解析 triggers（逗号分隔字符串或 YAML 数组）
    let triggers: string[] = [];
    if (Array.isArray(fm.triggers)) {
      triggers = fm.triggers.map(String);
    } else if (typeof fm.triggers === 'string') {
      triggers = fm.triggers.split(/[,[\]]/).map((s: string) => s.trim()).filter(Boolean);
    }

    return {
      name,
      description,
      triggers,
      body,
      filePath,
    };
  }

  /**
   * 极简 YAML 解析器：支持 key: value、数组、嵌套对象。
   *
   * 支持格式:
   *   key: value
   *   key: "quoted value"
   *   key: [inline, array]
   *   key:
   *     - item1
   *     - item2
   *   key:
   *     subkey1: val1
   *     subkey2: val2
   *
   * 不需要 js-yaml 依赖。
   */
  private parseFrontmatter(
    text: string,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = text.split('\n');

    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      const trimmed = line.trim();
      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) { i++; continue; }

      // 测缩进（用于判断嵌套层级）
      const indent = line.length - line.trimStart().length;

      // 尝试匹配 key: value
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) { i++; continue; }

      const key = trimmed.slice(0, colonIdx).trim();
      const rest = trimmed.slice(colonIdx + 1).trim();

      // ── 内联值 ──
      if (rest !== '' && rest !== '[]') {
        // 去引号
        const value = (
          (rest.startsWith('"') && rest.endsWith('"')) ||
          (rest.startsWith("'") && rest.endsWith("'"))
        ) ? rest.slice(1, -1) : rest;

        // 内联数组: "[a, b, c]"
        if (value.startsWith('[') && value.endsWith(']')) {
          result[key] = value
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim().replace(/^["']|["']$/g, ''));
          i++;
          continue;
        }

        result[key] = value;
        i++;
        continue;
      }

      // ── 多行值（空 rest 表示 "key:" 后续行是嵌套内容）──
      // 收集后续缩进更深（或同级缩进 + `- ` 前缀）的行
      const childLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const childLine = lines[j]!;
        const childTrimmed = childLine.trim();
        if (!childTrimmed || childTrimmed.startsWith('#')) { j++; continue; }

        const childIndent = childLine.length - childLine.trimStart().length;
        // 比当前行缩进深 或 同级且以 "- " 开头 → 属于此 key
        const isDeeper = childIndent > indent;
        const isList = childTrimmed.startsWith('- ') && childIndent >= indent;
        if (isDeeper || isList) {
          // 去掉前导空格 / "- " 前缀，保留原始缩进关系
          childLines.push(childTrimmed.replace(/^- /, ''));
          j++;
        } else {
          break;
        }
      }

      if (childLines.length === 0) {
        // 空 key → 设为空数组
        result[key] = [];
        i++;
        continue;
      }

      // 判断是数组（所有子行都以 `- ` 开头）还是嵌套对象
      const allListItems = childLines.every(
        (_, idx) => {
          const orig = lines[i + 1 + idx]!.trim();
          return orig.startsWith('- ');
        },
      );

      if (allListItems) {
        // YAML 数组
        result[key] = childLines.map((s) => {
          const v = s.trim();
          return (v.startsWith('"') && v.endsWith('"')) ||
                 (v.startsWith("'") && v.endsWith("'"))
            ? v.slice(1, -1) : v;
        });
      } else {
        // 嵌套对象 → 递归解析
        const nestedText = childLines.join('\n');
        result[key] = this.parseFrontmatter(nestedText);
      }

      i = j; // 跳过已处理的子行
    }

    return result;
  }

  // matchTriggers + BM25 语义检索已删除——LLM 自己决定何时调用 skill 工具。

  // --------------------------------------------------------------------------
  // 生命周期
  // --------------------------------------------------------------------------

  /**
   * 清空运行时 skill 和展开状态（新会话）
   */
  reset(): void {
    this.runtimeSkills.clear();
    this.expandedSkills.clear();
  }

  // getStats() 已删除——@phase2 预留，在需要时重新实现。
}

// ============================================================================
// §3 内建工具定义
// ============================================================================

/**
 * 内建工具集——始终注册到 Agent 3
 *
 * 这些定义与 Agent 3 crates/comdr-tools 的实现保持一致。
 * Agent 3 未实现时，Engine 可以通过 mock 工具执行器运行。
 */
const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'file_read',
    description:
      'Read a file. Modes: "full" (default, offset/limit), "blueprint" (AOCI-style structured overview: imports, public API, internals, dependencies — ~300 tokens for any file), "summary" (symbol list), "selector" (specific symbol with context). Use blueprint for unfamiliar files — it gives the full picture without blowing context.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read',
        },
        mode: {
          type: 'string',
          description: '"full" (default), "summary" (symbol list), or "selector" (symbol definition with context)',
        },
        symbol: {
          type: 'string',
          description: 'Symbol name for selector mode',
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (full mode)',
        },
        limit: {
          type: 'number',
          description: 'Number of lines to read (full mode)',
        },
      },
      required: ['path'],
    },
    permission: TOOL_PERMISSION.READ_ONLY,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_FAST,
  },
  {
    name: 'file_write',
    description:
      'Write a file to the local filesystem, overwriting if one exists.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to write',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
    permission: TOOL_PERMISSION.DESTRUCTIVE,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_NORMAL,
  },
  {
    name: 'file_edit',
    description:
      'Perform exact string replacements in a file. ' +
      'old_string must match the file exactly, including indentation.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to modify',
        },
        old_string: {
          type: 'string',
          description: 'The text to replace',
        },
        new_string: {
          type: 'string',
          description: 'The text to replace it with',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences (default false)',
          default: false,
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    permission: TOOL_PERMISSION.DESTRUCTIVE,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_NORMAL,
  },
  {
    name: 'file_delete',
    description: 'Delete a file at the specified path.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to delete',
        },
      },
      required: ['path'],
    },
    permission: TOOL_PERMISSION.DESTRUCTIVE,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_FAST,
  },
  {
    name: 'file_glob',
    description: 'Fast file pattern matching. Supports glob patterns.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The glob pattern to match files against',
        },
        path: {
          type: 'string',
          description: 'The directory to search in',
        },
      },
      required: ['pattern'],
    },
    permission: TOOL_PERMISSION.READ_ONLY,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_NORMAL,
  },
  {
    name: 'file_grep',
    description:
      'Content search built on ripgrep. Supports full regex syntax.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The regular expression pattern to search for',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in',
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter files',
        },
      },
      required: ['pattern'],
    },
    permission: TOOL_PERMISSION.READ_ONLY,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_SEARCH,
  },
  {
    name: 'shell_bash',
    description:
      'Execute a bash command and return its output.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute',
        },
        timeout: {
          type: 'number',
          description: 'Optional timeout in milliseconds',
        },
      },
      required: ['command'],
    },
    permission: TOOL_PERMISSION.DESTRUCTIVE,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_SHELL,
  },
  {
    name: 'file_ls',
    description: 'List files and directories at the given path.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list (defaults to project root)',
        },
      },
    },
    permission: TOOL_PERMISSION.READ_ONLY,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_FAST,
  },
  {
    name: 'git_diff',
    description:
      'Show changes in the working directory (unified diff format).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Specific file or directory to diff (default: entire repo)',
        },
        staged: {
          type: 'boolean',
          description: 'Show staged changes instead of working directory changes',
          default: false,
        },
      },
    },
    permission: TOOL_PERMISSION.READ_ONLY,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_SEARCH,
  },
  {
    name: 'git_status',
    description: 'Show the working tree status (porcelain format).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Specific path to check status for',
        },
      },
    },
    permission: TOOL_PERMISSION.READ_ONLY,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_NORMAL,
  },
  {
    name: 'git_log',
    description: 'Show recent commit history.',
    parameters: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of recent commits to show (default: 20)',
          default: 20,
        },
      },
    },
    permission: TOOL_PERMISSION.READ_ONLY,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_NORMAL,
  },
  {
    name: 'git_add',
    description:
      'Stage files for commit. Accepts a single file path or an array of file paths.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'string',
          description: 'File path(s) to stage. String for single file, array for multiple.',
        },
      },
      required: ['files'],
    },
    permission: TOOL_PERMISSION.DESTRUCTIVE,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_NORMAL,
  },
  {
    name: 'git_commit',
    description: 'Commit staged changes with a message.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Commit message',
        },
      },
      required: ['message'],
    },
    permission: TOOL_PERMISSION.DESTRUCTIVE,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_SEARCH,
  },
  {
    name: 'git_revert',
    description:
      'Revert a commit by its hash. Creates a new commit that undoes the specified commit.',
    parameters: {
      type: 'object',
      properties: {
        commit: {
          type: 'string',
          description: 'Commit hash to revert',
        },
      },
      required: ['commit'],
    },
    permission: TOOL_PERMISSION.DESTRUCTIVE,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_SEARCH,
  },
  {
    name: 'lsp_symbols',
    description:
      'Search for symbol definitions (functions, classes, interfaces) in source files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File or directory to search for symbols',
        },
        query: {
          type: 'string',
          description: 'Symbol name to search for (substring match)',
        },
      },
      required: ['path'],
    },
    permission: TOOL_PERMISSION.READ_ONLY,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_ANALYSIS,
  },
  {
    name: 'lsp_diagnostics',
    description:
      'Check a source file for basic diagnostics (syntax errors, parse issues).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to check for diagnostics',
        },
      },
      required: ['path'],
    },
    permission: TOOL_PERMISSION.READ_ONLY,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_NORMAL,
  },
  {
    name: 'lsp_structure',
    description:
      'Show the code structure outline of a source file (imports, functions, classes, etc.).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to analyze',
        },
      },
      required: ['path'],
    },
    permission: TOOL_PERMISSION.READ_ONLY,
    timeoutMs: SYSTEM.TOOL_TIMEOUT_NORMAL,
  },
];
