/**
 * extension.ts — Comdr VS Code Extension 入口
 *
 * 职责:
 *   1. 创建/管理 Engine 实例（单例）
 *   2. 注册 Webview Provider（Chat Panel）
 *   3. 连接 Shadow Workspace（Terminal 1 提供）
 *   4. 管理生命周期（activate/deactivate）
 *
 * @module @comdr/vscode
 */

import * as vscode from 'vscode';
import { Engine, createEngine, registerBuiltinSubAgents } from '@comdr/engine';
import { loadConfig, type AgentConfig } from '@comdr/core';
import { DeepSeekClient } from '@comdr/llm';
import type { IDeepSeekClient, IShadowWorkspace, ILSPBridge } from '@comdr/core/contracts';
import { ChatViewProvider, type EngineInitParams } from './webview/provider.js';
import { LSPBridge } from './lsp-bridge.js';
import { ShadowWorkspaceOrchestrator } from './shadow-workspace.js';
import { VSCodeToolRegistry } from './vscode-tools.js';
import { DisposableStore } from './utils/disposables.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── 诊断日志 ─────────────────────────────────────────
const DEBUG_LOG = join(tmpdir(), 'comdr-extension-debug.log');

function debugLog(msg: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  try {
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(DEBUG_LOG, line, { flag: 'a' });
  } catch {
    // 写文件失败也不能崩溃
  }
  console.log(`[Comdr] ${msg}`);
}

// ★ 模块加载的第一行——证明 extension.js 被 VS Code 成功 require 了
debugLog('Module loaded — extension.js required by VS Code Extension Host');

// ─── 模块级状态 ───────────────────────────────────────

let engine: Engine | null = null;
let chatViewProvider: ChatViewProvider | null = null;
let disposables: DisposableStore | null = null;
let vscodeToolRegistry: VSCodeToolRegistry | null = null;

/** 获取 VS Code 工具注册表（供 Engine 工具管线集成） */
export function getVSCodeToolRegistry(): VSCodeToolRegistry | null {
  return vscodeToolRegistry;
}

// ─── Mock Shadow Workspace ─────────────────────────────
// 联调期替换为 Terminal 1 的真实 Fork 实现

function createMockShadowWorkspace(): IShadowWorkspace {
  const files = new Map<string, string>();

  return {
    create(_projectPath: string): string {
      return 'mock-window';
    },
    applyEdit(_windowId: string, filePath: string, content: string): void {
      files.set(filePath, content);
    },
    getDiagnostics(_windowId: string, _filePath: string) {
      // Phase 1: mock 返回空诊断列表
      // 联调时: 调用真实 Fork 的 LSP 实例
      return [];
    },
    getFileContext(_windowId: string, _filePath: string) {
      // Phase 1: mock 返回空上下文
      return {
        file: _filePath,
        exports: [],
        imports: [],
        callers: [],
        callees: [],
        typeDependencies: [],
        diagnostics: [],
      };
    },
    mergeToUser(_windowId: string, filePath: string): void {
      const content = files.get(filePath);
      if (content !== undefined) {
        void vscode.workspace.fs.writeFile(
          vscode.Uri.file(filePath),
          Buffer.from(content, 'utf-8'),
        );
      }
    },
    dispose(_windowId: string): void {
      files.clear();
    },
  };
}

// ─── activate / deactivate ─────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  debugLog('activate() called — entering activation');
  disposables = new DisposableStore();

  try {
    // 1. 获取项目根目录
    const workspaceFolders = vscode.workspace.workspaceFolders;
    debugLog(`workspaceFolders: ${workspaceFolders?.length ?? 0} folders`);
    if (!workspaceFolders || workspaceFolders.length === 0) {
      debugLog('No workspace folder open — will show guidance in webview');
    }
    const projectPath = workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    debugLog(`projectPath: ${projectPath}`);

    // 2. 加载配置（允许 API key 缺失——在 UI 内展示配置错误）
    let config: AgentConfig | null = null;
    let configError: string | null = null;
    try {
      config = loadConfig(projectPath);
      debugLog(`Config loaded OK, model=${config.llm.model}`);
    } catch (err) {
      configError = String(err);
      debugLog(`Config error: ${configError}`);
    }

    // 3. 创建 LLM 客户端（仅在 config 有效时）
    let engineInstance: Engine | null = null;

    if (config) {
      debugLog('Creating DeepSeekClient + Engine...');
      const llm = new DeepSeekClient(config.llm);
      const contextLLM = config.project.contextModel
        ? new DeepSeekClient({ ...config.llm, model: config.project.contextModel })
        : undefined;
      engineInstance = createEngine(llm, config, null, null, contextLLM);
      engine = engineInstance;

      // ★ 注册内置子智能体
      await registerBuiltinSubAgents(engineInstance);
      debugLog('Engine created OK');
    } else {
      debugLog('Skipping Engine creation — no valid config, will show setup UI');
    }

    // 4. 连接 Shadow Workspace（开发期: mock 实现）
    const shadowWS: IShadowWorkspace = createMockShadowWorkspace();

    // 5. 创建 LSP Bridge
    const lspBridge: ILSPBridge = new LSPBridge(shadowWS);

    // ★ 连接 LSP Bridge → Engine self-correct 管线
    if (engine) {
      engine.setLSPBridge(lspBridge);
    }

    // 6. 创建 Shadow Workspace Orchestrator
    new ShadowWorkspaceOrchestrator(shadowWS, projectPath);

    // 7. 创建 VS Code 工具注册表（★ 存储引用供 Engine 工具管线集成）
    vscodeToolRegistry = new VSCodeToolRegistry();

    // 8. 注册 Webview Panel（★ 无论 config 是否有效都注册）
    const onInitEngine = configError
      ? async (params: EngineInitParams): Promise<Engine> => {
          const mergedConfig: AgentConfig = {
            llm: {
              apiKey: params.apiKey,
              baseUrl: params.baseUrl ?? 'https://api.deepseek.com',
              model: params.model ?? 'deepseek-v4-pro',
              maxTokens: 8192,
              thinking: { type: 'enabled' as const, effort: 'high' as const },
            },
            project: {
              projectPath,
              skillsDir: 'skills',
              mcpServers: [],
              comdrMdPath: 'COMDR.md',
              contextModel: undefined,
            },
            agent: {
              maxTurns: 50,
              tokenBudget: 200_000,
              permissionMode: 'confirm_destructive' as const,
            },
          };
          const newLlm = new DeepSeekClient(mergedConfig.llm);
          const newEngine = createEngine(newLlm, mergedConfig, null, null);
          engine = newEngine;

          // ★ 连接 LSP Bridge
          newEngine.setLSPBridge(lspBridge);

          // ★ 注册内置子智能体
          await registerBuiltinSubAgents(newEngine);
          return newEngine;
        }
      : null;

    chatViewProvider = new ChatViewProvider(
      context.extensionUri,
      engineInstance,
      lspBridge,
      shadowWS,
      configError,
      onInitEngine,
    );

    disposables.add(
      vscode.window.registerWebviewViewProvider(
        'comdr.chatView',
        chatViewProvider,
      ),
    );

    debugLog('View provider registered for comdr.chatView');
  } catch (fatalErr) {
    debugLog(`FATAL activation error: ${String(fatalErr)}`);
    void vscode.window.showErrorMessage(
      `Comdr activation failed: ${String(fatalErr)}`,
    );
    return;
  }

  // 9. 注册命令
  disposables.add(
    vscode.commands.registerCommand('comdr.openChat', () => {
      void vscode.commands.executeCommand(
        'workbench.view.extension.comdr',
      );
    }),
  );

  disposables.add(
    vscode.commands.registerCommand('comdr.newTask', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'What do you want Comdr to do?',
        placeHolder: 'e.g., Create a new React component...',
        ignoreFocusOut: true,
      });
      if (input && chatViewProvider) {
        await chatViewProvider.startTask(input);
      }
    }),
  );

  // 10. 注册到 VS Code 订阅
  context.subscriptions.push(disposables);
  debugLog('Extension activated successfully!');

  // ★ 通知用户扩展已就绪 + 自动弹出 Comdr 面板
  debugLog('Showing ready notification + scheduling view open...');
  const openAction = 'Open Chat';
  void vscode.window.showInformationMessage('Comdr is ready. Start coding!', openAction).then(choice => {
    if (choice === openAction) {
      void vscode.commands.executeCommand('workbench.view.extension.comdr');
    }
  });

  // 延迟弹出面板（等待 view container 注册完成）
  setTimeout(() => {
    void vscode.commands.executeCommand('workbench.view.extension.comdr');
  }, 500);
}

export function deactivate(): void {
  debugLog('deactivate() called');
  engine?.destroy();
  engine = null;
  chatViewProvider = null;
  vscodeToolRegistry = null;
  disposables?.dispose();
  disposables = null;
}
