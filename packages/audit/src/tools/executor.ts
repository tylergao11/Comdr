// ============================================================
// ToolExecutor — Read-only tools for audit LLM
//
// ★ 复用主 Agent 工具层。Audit LLM 用只读工具自己查证据。
//   Comdr 模式下注入主 Agent 的 ToolExecContext。
//   独立模式下用基础 fs 实现。
// ============================================================

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';
import type { ToolDefinition, ToolCall, ToolResult } from '@comdr/core/types';

// ---- Tool Definitions ----

export const AUDIT_TOOLS: ToolDefinition[] = [
  {
    name: 'file_read',
    description: 'Read a file or portion of a file. Returns the content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to project root' },
        startLine: { type: 'number', description: 'Optional start line (1-based)' },
        endLine: { type: 'number', description: 'Optional end line (1-based, inclusive)' },
      },
      required: ['path'],
    },
    permission: 'read_only',
    timeoutMs: 5000,
  },
  {
    name: 'file_grep',
    description: 'Search for a regex pattern in files. Returns matching lines with file:line info.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for (case-insensitive)' },
        path: { type: 'string', description: 'Optional directory or file path to search in' },
      },
      required: ['pattern'],
    },
    permission: 'read_only',
    timeoutMs: 15000,
  },
  {
    name: 'file_glob',
    description: 'Find files matching a glob pattern.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' },
      },
      required: ['pattern'],
    },
    permission: 'read_only',
    timeoutMs: 10000,
  },
  {
    name: 'file_ls',
    description: 'List files and directories in a given path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path, relative to project root' },
      },
      required: ['path'],
    },
    permission: 'read_only',
    timeoutMs: 5000,
  },
];

// ---- Tool Executor ----

export interface IToolExecutor {
  execute(toolCall: ToolCall): Promise<ToolResult>;
}

/**
 * Standalone tool executor — basic fs-based implementations.
 * Used when audit runs independently (not in Comdr mode).
 */
export class StandaloneToolExecutor implements IToolExecutor {
  constructor(private projectRoot: string) {}

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const args = parseArgs(toolCall.function.arguments);

    switch (toolCall.function.name) {
      case 'file_read': return this.fileRead(args);
      case 'file_grep': return this.fileGrep(args);
      case 'file_glob': return this.fileGlob(args);
      case 'file_ls': return this.fileLs(args);
      default:
        return {
          ok: false,
          callId: toolCall.id,
          toolName: toolCall.function.name,
          content: `Unknown tool: ${toolCall.function.name}`,
          errorCategory: 'execution_error',
        };
    }
  }

  private resolve(p: string): string {
    const r = resolve(this.projectRoot, p);
    // Case-insensitive prefix check for Windows compatibility
    if (!r.toLowerCase().startsWith(this.projectRoot.toLowerCase())) {
      throw new Error(`Path traversal blocked: ${p}`);
    }
    return r;
  }

  private fileRead(args: Record<string, unknown>): ToolResult {
    const p = this.resolve(String(args.path));
    if (!existsSync(p)) {
      return { ok: false, callId: '', toolName: 'file_read', content: `File not found: ${args.path}`, errorCategory: 'execution_error' };
    }
    const lines = readFileSync(p, 'utf8').split('\n');
    const start = Math.max(0, (Number(args.startLine) || 1) - 1);
    const end = Math.min(lines.length, Number(args.endLine) || start + 201);
    const content = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
    return { ok: true, callId: '', toolName: 'file_read', content: content || '(empty)' };
  }

  private fileGrep(args: Record<string, unknown>): ToolResult {
    const pattern = String(args.pattern);
    const searchPath = args.path ? this.resolve(String(args.path)) : this.projectRoot;
    let re: RegExp;
    try { re = new RegExp(pattern, 'gi'); } catch {
      return { ok: false, callId: '', toolName: 'file_grep', content: `Invalid regex: ${pattern}`, errorCategory: 'execution_error' };
    }

    const results: string[] = [];
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.md', '.json', '.yaml', '.yml', '.toml'];

    const walk = (dir: string) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
        const fp = join(dir, e.name);
        if (e.isDirectory()) { walk(fp); continue; }
        if (!extensions.includes(extname(e.name))) continue;
        try {
          const content = readFileSync(fp, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i]!)) {
              results.push(`${relative(this.projectRoot, fp)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
              re.lastIndex = 0;
            }
          }
        } catch { /* skip unreadable */ }
      }
    };

    const stat = statSync(searchPath);
    if (stat.isDirectory()) walk(searchPath);
    else {
      try {
        const content = readFileSync(searchPath, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            results.push(`${relative(this.projectRoot, searchPath)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
            re.lastIndex = 0;
          }
        }
      } catch { return { ok: false, callId: '', toolName: 'file_grep', content: `Cannot read: ${args.path}`, errorCategory: 'execution_error' }; }
    }

    const capped = results.slice(0, 50);
    return { ok: true, callId: '', toolName: 'file_grep', content: capped.length > 0 ? capped.join('\n') : 'No matches found.' };
  }

  private fileGlob(args: Record<string, unknown>): ToolResult {
    const pattern = String(args.pattern);
    const base = this.projectRoot;
    const parts = pattern.replace(/\\/g, '/').split('/');
    const results: string[] = [];
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go'];

    const matchGlob = (dir: string, idx: number) => {
      if (idx >= parts.length) {
        if (exts.some(e => dir.endsWith(e))) results.push(relative(base, dir));
        return;
      }
      const seg = parts[idx]!;
      if (seg === '**') {
        matchGlob(dir, idx + 1);
        try {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
            const fp = join(dir, e.name);
            if (e.isDirectory()) { matchGlob(fp, idx); continue; }
            matchGlob(fp, idx + 1);
          }
        } catch { /* skip */ }
        return;
      }
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue;
          if (seg === '*' || seg === e.name || (seg.includes('*') && minimatchLike(e.name, seg))) {
            matchGlob(join(dir, e.name), idx + 1);
          }
        }
      } catch { /* skip */ }
    };

    matchGlob(base, 0);
    const capped = results.slice(0, 100);
    return { ok: true, callId: '', toolName: 'file_glob', content: capped.join('\n') || 'No files matched.' };
  }

  private fileLs(args: Record<string, unknown>): ToolResult {
    const p = this.resolve(String(args.path));
    if (!existsSync(p)) {
      return { ok: false, callId: '', toolName: 'file_ls', content: `Directory not found: ${args.path}`, errorCategory: 'execution_error' };
    }
    const entries = readdirSync(p, { withFileTypes: true });
    const lines = entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`);
    return { ok: true, callId: '', toolName: 'file_ls', content: lines.join('\n') };
  }
}

// ---- Helpers ----

function parseArgs(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

function minimatchLike(name: string, pattern: string): boolean {
  const re = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(name);
}

/**
 * ★ In Comdr mode, create a ToolExecutor that delegates to the main engine.
 * The adapter maps audit tool calls → main agent tool execution.
 */
export function createComdrToolExecutor(
  executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
): IToolExecutor {
  return {
    execute: async (tc: ToolCall) => {
      const args = parseArgs(tc.function.arguments);
      return executeTool(tc.function.name, args);
    },
  };
}
