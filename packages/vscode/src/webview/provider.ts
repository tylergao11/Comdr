/**
 * provider.ts — Webview Provider（Extension Host 侧）
 * 将 Engine 事件流转换为 ExtensionMessage 推送到 Webview。
 */

import * as vscode from 'vscode';
import type { IEngine, ILSPBridge, IShadowWorkspace } from '@comdr/core/contracts';
import type { AgentEvent, RunMode, MCPServerStatus } from '@comdr/core/types';
import { AGENT_EVENT, RUN_MODE } from '@comdr/core';
import type { ExtensionMessage, WebviewMessage, ChatState, ChatMessage, MCPServerStatusMsg } from './types.js';
import { ShadowWorkspaceOrchestrator } from '../shadow-workspace.js';

let msgIdCounter = 0;
function nextMsgId(): string {
  return `msg_${Date.now()}_${++msgIdCounter}`;
}

function newMessage(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>): ChatMessage {
  return {
    id: nextMsgId(),
    parsedContent: null,
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Engine 初始化参数（从 webview submitConfig 传入） */
export interface EngineInitParams {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | null = null;
  private _engine: IEngine | null = null;
  private _chatState: ChatState = {
    sessionId: null,
    turn: 0,
    tokensUsed: 0,
    isRunning: false,
    messages: [],
  };
  private _shadowOrch: ShadowWorkspaceOrchestrator | null = null;
  private _configError: string | null;
  private _onInitEngine: ((params: EngineInitParams) => Promise<IEngine>) | null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    engine: IEngine | null,
    private readonly lspBridge?: ILSPBridge,
    shadowWS?: IShadowWorkspace,
    configError?: string | null,
    onInitEngine?: ((params: EngineInitParams) => Promise<IEngine>) | null,
  ) {
    this._engine = engine;
    this._configError = configError ?? null;
    this._onInitEngine = onInitEngine ?? null;
    if (shadowWS) {
      const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      this._shadowOrch = new ShadowWorkspaceOrchestrator(shadowWS, projectPath);
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
      ],
    };
    webviewView.webview.html = this.getHtml();
    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleWebviewMessage(msg));

    // ★ 如果激活时 config 有错误，发送 configRequired 让 UI 展示配置表单
    if (this._configError) {
      this._sendConfigRequired();
    }
  }

  /** 从 configError 解析缺失字段列表 */
  private _sendConfigRequired(): void {
    const missing: string[] = [];
    if (this._configError) {
      // 从 ConfigValidationError 中提取缺失字段
      for (const line of this._configError.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('- ') || trimmed.includes('required')) {
          missing.push(trimmed.replace(/^- /, '').trim());
        }
      }
    }
    if (missing.length === 0) {
      missing.push('llm.apiKey (required)');
    }
    this.postMessage({ type: 'configRequired', missingFields: missing });
  }

  /**
   * 构建 Webview HTML——加载 Vite 构建的 React App。
   *
   * CSP 策略:
   *   - script-src: 仅允许 webview.cspSource（VS Code 管理的本地资源）
   *   - style-src: 允许 webview.cspSource + 'unsafe-inline'（React 内联样式）
   *   - 其余全部 'none'（无外部网络访问）
   */
  getHtml(): string {
    if (!this._view) return '<html><body>Webview not ready</body></html>';

    const webview = this._view.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'assets', 'main.js'),
    );

    const csp = [
      "default-src 'none'",
      `script-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Comdr</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1e1e1e; color: #cccccc; font-family: system-ui, sans-serif; }
    #root { height: 100vh; overflow: hidden; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  get engine(): IEngine | null { return this._engine; }

  /** Start a task from user input */
  async startTask(input: string, mode: RunMode = RUN_MODE.AGENT): Promise<void> {
    if (!this._view) return;

    if (!this._engine) {
      this._sendConfigRequired();
      return;
    }

    // ★ 不可变：创建新数组而非 push
    const userMsg = newMessage({ role: 'user', content: input });
    this._chatState.messages = [...this._chatState.messages, userMsg];
    this._chatState.isRunning = true;
    this.postMessage({ type: 'state', state: { ...this._chatState } });

    try {
      for await (const event of this._engine.run(input, mode, this._chatState.sessionId ?? undefined)) {
        this.handleEngineEvent(event);
      }
    } catch (err) {
      this.postMessage({
        type: 'error',
        message: `Engine error: ${String(err)}`,
        recoverable: false,
      });
    } finally {
      this._chatState.isRunning = false;
    }
  }

  private handleEngineEvent(event: AgentEvent): void {
    switch (event.type) {
      case AGENT_EVENT.TEXT_DELTA:
        this.postMessage({ type: 'textDelta', content: event.content });
        break;

      case AGENT_EVENT.THINKING_DELTA:
        this.postMessage({ type: 'thinkingDelta', content: event.content });
        break;

      case AGENT_EVENT.TOOL_CALL:
        this.postMessage({
          type: 'toolCall',
          callId: event.call.id,
          toolName: event.call.function.name,
        });
        break;

      case AGENT_EVENT.TOOL_RESULT: {
        const r = event.result;
        this.postMessage({
          type: 'toolResult',
          callId: r.callId,
          toolName: r.toolName,
          ok: r.ok,
          summary: r.content?.slice(0, 200) ?? '',
          errorCategory: r.errorCategory,
        });
        // ★ 不再硬编码 shadowStatus——Shadow Workspace 验证是独立流程
        break;
      }

      case AGENT_EVENT.PROGRESS_WARNING:
        this._chatState.messages = [
          ...this._chatState.messages,
          newMessage({ role: 'system', content: event.message }),
        ];
        break;

      case AGENT_EVENT.SESSION_STARTED:
        this._chatState.sessionId = event.sessionId;
        this.postMessage({ type: 'sessionStarted', sessionId: event.sessionId });
        break;

      case AGENT_EVENT.TURN_BEGIN:
        this._chatState.turn = event.turn;
        break;

      case AGENT_EVENT.TOKEN_USAGE:
        this._chatState.tokensUsed += event.usage.promptTokens + event.usage.completionTokens;
        this.postMessage({
          type: 'tokenUsage',
          usage: {
            promptTokens: event.usage.promptTokens,
            completionTokens: event.usage.completionTokens,
            reasoningTokens: event.usage.reasoningTokens,
            cacheHitTokens: event.usage.cacheHitTokens,
            cacheMissTokens: event.usage.cacheMissTokens,
          },
          cacheHitRate: event.cacheHitRate,
        });
        break;

      case AGENT_EVENT.MCP_STATUS:
        this.postMessage({
          type: 'mcpStatus',
          servers: toMCPStatusMsg(event.servers),
        });
        break;

      case AGENT_EVENT.BOOTSTRAP_DONE:
        this._chatState.messages = [
          ...this._chatState.messages,
          newMessage({
            role: 'system',
            content: `Project loaded: ${event.symbolsFound} symbols, ${event.referencesFound} references, ${event.filesScanned} files`,
          }),
        ];
        break;

      case AGENT_EVENT.DONE:
        this._chatState.turn = event.result.turns;
        this._chatState.tokensUsed = event.result.tokensUsed;
        this.postMessage({
          type: 'done',
          turns: event.result.turns,
          tokens: event.result.tokensUsed,
          summary: event.result.summary,
          sessionId: event.result.sessionId,
        });
        break;

      case AGENT_EVENT.ERROR:
        this.postMessage({
          type: 'error',
          message: event.message,
          recoverable: event.recoverable,
        });
        break;
    }
  }

  private handleWebviewMessage(msg: WebviewMessage): void {
    switch (msg.type) {
      case 'userInput':
        this.startTask(msg.text);
        break;

      case 'submitConfig': {
        void this._handleSubmitConfig(msg.apiKey, msg.baseUrl, msg.model);
        break;
      }

      case 'requestConfigSetup': {
        this._sendConfigRequired();
        break;
      }

      case 'acceptDiff': {
        // ★ 将 diff 内容写入文件系统 / 通过 shadow workspace 合并
        // Phase 1: 直接接受（文件已通过 Shadow Workspace 合并到用户窗口）
        this.postMessage({
          type: 'textDelta',
          content: `Diff in ${msg.filePath} accepted.`,
        });
        break;
      }

      case 'rejectDiff': {
        // ★ 拒绝 diff —— 需要回滚。Phase 1: 通知用户
        this.postMessage({
          type: 'textDelta',
          content: `Diff in ${msg.filePath} rejected.`,
        });
        break;
      }

      case 'clickRef': {
        // ★ 链接点击 → 编辑器导航
        const ref = msg.ref;
        if (ref.kind === 'file') {
          const uri = vscode.Uri.file(ref.target);
          vscode.commands.executeCommand('vscode.open', uri, {
            selection: ref.line ? new vscode.Range(ref.line - 1, 0, ref.line - 1, 0) : undefined,
          });
        }
        break;
      }

      case 'abortTask':
        this._engine?.abort();
        break;
    }
  }

  /** 处理用户提交的配置，初始化 Engine */
  private async _handleSubmitConfig(
    apiKey: string,
    baseUrl?: string,
    model?: string,
  ): Promise<void> {
    if (!this._onInitEngine) {
      this.postMessage({
        type: 'error',
        message: 'Configuration not available. Reload the window.',
        recoverable: false,
      });
      return;
    }

    try {
      const newEngine = await this._onInitEngine({ apiKey, baseUrl, model });
      this._engine = newEngine;
      this._configError = null;
      // ★ 通知 webview 退出 setup 模式
      this.postMessage({ type: 'engineReady' });
    } catch (err) {
      this.postMessage({
        type: 'error',
        message: `Failed to initialize: ${String(err)}`,
        recoverable: true,
      });
    }
  }

  private postMessage(msg: ExtensionMessage): void {
    this._view?.webview.postMessage(msg);
  }
}

function toMCPStatusMsg(servers: MCPServerStatus[]): MCPServerStatusMsg[] {
  return servers.map(s => ({
    name: s.name,
    status: s.status as MCPServerStatusMsg['status'],
    tools: s.tools,
    activeTool: (s as MCPServerStatus & { activeTool?: string }).activeTool,
  }));
}
