/**
 * vscode-tools.ts — VS Code 原生能力 → Agent 工具接口
 *
 * 将 VS Code Extension API 暴露为 Agent（Engine）可调用的工具。
 *
 * 与 @comdr/tools（Agent 3）的关系:
 *   - Comdr-Tools 管理文件系统操作（读写、git、shell）
 *   - VS Code Tools 管理 IDE 特有操作（打开编辑器、导航、符号查询）
 *
 * Phase 1 提供的工具:
 *   - vscode_open_editor: 在用户窗口中打开文件
 *   - vscode_reveal_line: 跳转到指定行
 *   - vscode_get_active_editor: 获取当前编辑器信息
 *   - vscode_show_message: 显示信息/警告/错误消息
 *   - vscode_execute_command: 执行 VS Code 命令
 *   - vscode_diff: 在 VS Code 中打开 diff 视图
 */

import * as vscode from 'vscode';
import type { ToolDefinition, ToolResult } from '@comdr/core/types';
import { TOOL_PERMISSION } from '@comdr/core';

export interface VSCodeToolFunc {
  (args: Record<string, unknown>, callId: string): ToolResult;
}

/**
 * VS Code 工具注册表
 */
export class VSCodeToolRegistry {
  private readonly tools = new Map<string, VSCodeToolFunc>();

  constructor() {
    this.registerBuiltinTools();
  }

  private registerBuiltinTools(): void {
    this.tools.set('vscode_open_editor', this.openEditor.bind(this));
    this.tools.set('vscode_reveal_line', this.revealLine.bind(this));
    this.tools.set('vscode_get_active_editor', this.getActiveEditor.bind(this));
    this.tools.set('vscode_show_message', this.showMessage.bind(this));
    this.tools.set('vscode_execute_command', this.executeCommand.bind(this));
    this.tools.set('vscode_diff', this.diff.bind(this));
  }

  /**
   * 列出所有注册的 VS Code 工具定义
   */
  listDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'vscode_open_editor',
        description: '在 VS Code 编辑器中打开指定文件',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: '文件绝对路径' },
            preview: { type: 'boolean', description: '是否以预览模式打开', default: true },
          },
          required: ['filePath'],
        },
        permission: TOOL_PERMISSION.READ_ONLY,
        timeoutMs: 5_000,
      },
      {
        name: 'vscode_reveal_line',
        description: '在 VS Code 编辑器中跳转到文件的指定行',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: '文件绝对路径' },
            line: { type: 'number', description: '行号（1-based）' },
          },
          required: ['filePath', 'line'],
        },
        permission: TOOL_PERMISSION.READ_ONLY,
        timeoutMs: 5_000,
      },
      {
        name: 'vscode_get_active_editor',
        description: '获取当前活动编辑器信息（文件路径、光标位置、选择范围）',
        parameters: {
          type: 'object',
          properties: {},
        },
        permission: TOOL_PERMISSION.READ_ONLY,
        timeoutMs: 3_000,
      },
      {
        name: 'vscode_show_message',
        description: '在 VS Code 中显示信息提示消息',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: '消息内容' },
            level: {
              type: 'string',
              description: '消息级别',
              enum: ['info', 'warning', 'error'],
              default: 'info',
            },
          },
          required: ['message'],
        },
        permission: TOOL_PERMISSION.READ_ONLY,
        timeoutMs: 3_000,
      },
      {
        name: 'vscode_execute_command',
        description: '执行任意 VS Code 命令',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'VS Code 命令 ID' },
            args: { type: 'string', description: '命令参数（JSON 字符串）' },
          },
          required: ['command'],
        },
        permission: TOOL_PERMISSION.REQUIRES_APPROVAL,
        timeoutMs: 10_000,
      },
      {
        name: 'vscode_diff',
        description: '在 VS Code 中打开差异对比视图',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Diff 视图标题' },
            originalPath: { type: 'string', description: '原始文件绝对路径' },
            modifiedPath: { type: 'string', description: '修改后文件绝对路径' },
          },
          required: ['title', 'originalPath', 'modifiedPath'],
        },
        permission: TOOL_PERMISSION.READ_ONLY,
        timeoutMs: 5_000,
      },
    ];
  }

  /**
   * 执行注册的 VS Code 工具
   */
  execute(name: string, args: Record<string, unknown>, callId: string): ToolResult {
    const fn = this.tools.get(name);
    if (!fn) {
      return {
        callId,
        toolName: name,
        ok: false,
        content: `[ERR] ${name} error=EXECUTION_ERROR Unknown VS Code tool: ${name}`,
        errorCategory: 'execution_error',
      };
    }

    try {
      return fn(args, callId);
    } catch (err) {
      return {
        callId,
        toolName: name,
        ok: false,
        content: `[ERR] ${name} error=EXECUTION_ERROR ${String(err)}`,
        errorCategory: 'execution_error',
      };
    }
  }

  // ─── 内置工具实现 ─────────────────────────────────

  private openEditor(args: Record<string, unknown>, callId: string): ToolResult {
    const filePath = String(args.filePath ?? '');
    if (!filePath) {
      return {
        callId,
        toolName: 'vscode_open_editor',
        ok: false,
        content: `[ERR] vscode_open_editor error=SCHEMA_INVALID filePath is required`,
        errorCategory: 'schema_invalid',
      };
    }

    const preview = args.preview !== false;
    void vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview });

    return {
      callId,
      toolName: 'vscode_open_editor',
      ok: true,
      content: `[OK] vscode_open_editor filePath=${filePath} preview=${preview}`,
    };
  }

  private revealLine(args: Record<string, unknown>, callId: string): ToolResult {
    const filePath = String(args.filePath ?? '');
    const line = Number(args.line ?? 0);

    if (!filePath || line < 1) {
      return {
        callId,
        toolName: 'vscode_reveal_line',
        ok: false,
        content: `[ERR] vscode_reveal_line error=SCHEMA_INVALID filePath and line(>=1) required`,
        errorCategory: 'schema_invalid',
      };
    }

    void vscode.window.showTextDocument(vscode.Uri.file(filePath)).then(editor => {
      const pos = new vscode.Position(line - 1, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    });

    return {
      callId,
      toolName: 'vscode_reveal_line',
      ok: true,
      content: `[OK] vscode_reveal_line filePath=${filePath} line=${line}`,
    };
  }

  private getActiveEditor(_args: Record<string, unknown>, callId: string): ToolResult {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return {
        callId,
        toolName: 'vscode_get_active_editor',
        ok: true,
        content: '[OK] vscode_get_active_editor filePath=null No active editor',
      };
    }

    const doc = editor.document;
    const cursor = editor.selection.active;
    return {
      callId,
      toolName: 'vscode_get_active_editor',
      ok: true,
      content: [
        `[OK] vscode_get_active_editor`,
        `filePath=${doc.uri.fsPath}`,
        `line=${cursor.line + 1}`,
        `column=${cursor.character + 1}`,
        `language=${doc.languageId}`,
        `selection=${editor.selection.isEmpty ? 'none' : `${editor.selection.start.line + 1}:${editor.selection.start.character + 1} → ${editor.selection.end.line + 1}:${editor.selection.end.character + 1}`}`,
      ].join(' '),
    };
  }

  private showMessage(args: Record<string, unknown>, callId: string): ToolResult {
    const message = String(args.message ?? '');
    const level = String(args.level ?? 'info');
    const toolName = 'vscode_show_message';

    if (!message) {
      return {
        callId,
        toolName,
        ok: false,
        content: `[ERR] ${toolName} error=SCHEMA_INVALID message is required`,
        errorCategory: 'schema_invalid',
      };
    }

    switch (level) {
      case 'info':
        void vscode.window.showInformationMessage(message);
        break;
      case 'warning':
        void vscode.window.showWarningMessage(message);
        break;
      case 'error':
        void vscode.window.showErrorMessage(message);
        break;
      default:
        void vscode.window.showInformationMessage(message);
    }

    return {
      callId,
      toolName,
      ok: true,
      content: `[OK] ${toolName} level=${level} message=${message.slice(0, 100)}`,
    };
  }

  private executeCommand(args: Record<string, unknown>, callId: string): ToolResult {
    const command = String(args.command ?? '');
    const toolName = 'vscode_execute_command';

    if (!command) {
      return {
        callId,
        toolName,
        ok: false,
        content: `[ERR] ${toolName} error=SCHEMA_INVALID command is required`,
        errorCategory: 'schema_invalid',
      };
    }

    let cmdArgs: unknown[] = [];
    if (typeof args.args === 'string') {
      try {
        cmdArgs = JSON.parse(args.args) as unknown[];
      } catch {
        cmdArgs = [args.args];
      }
    }

    void vscode.commands.executeCommand(command, ...cmdArgs);

    return {
      callId,
      toolName,
      ok: true,
      content: `[OK] ${toolName} command=${command}`,
    };
  }

  private diff(args: Record<string, unknown>, callId: string): ToolResult {
    const title = String(args.title ?? '');
    const originalPath = String(args.originalPath ?? '');
    const modifiedPath = String(args.modifiedPath ?? '');
    const toolName = 'vscode_diff';

    if (!title || !originalPath || !modifiedPath) {
      return {
        callId,
        toolName,
        ok: false,
        content: `[ERR] ${toolName} error=SCHEMA_INVALID title, originalPath, modifiedPath required`,
        errorCategory: 'schema_invalid',
      };
    }

    void vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(originalPath),
      vscode.Uri.file(modifiedPath),
      title,
    );

    return {
      callId,
      toolName,
      ok: true,
      content: `[OK] ${toolName} title=${title}`,
    };
  }
}
