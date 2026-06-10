# Agent Task: Terminal 2 — @comdr/vscode 包 + Webview

> 输入: `IShadowWorkspace` 契约 (Terminal 1 实现) + `ILSPBridge` 契约 (你要实现) + 新类型
> 输出: `packages/vscode` 完整包 + VS Code 扩展 .vsix
> 依赖: Terminal 1 的 Fork 实现（联调时），Terminal 3 的 Engine 改造（联调时）
> 独立开发: mock IShadowWorkspace → 写完整代码 → 联调时替换为真实实现

---

## 一、你的职责

你是 Terminal 1（Fork）和 Terminal 3（Engine）之间的**连接层**。

```
Terminal 1 (Fork)                     Terminal 3 (Engine)
  IShadowWorkspace                        ILSPBridge
       │                                       │
       └──── Terminal 2 (你) ──────────────────┘
              实现 ILSPBridge
              消费 IShadowWorkspace
              管理 VS Code 能力
              提供 Webview UI
```

具体:
1. **实现 ILSPBridge**——让 Engine 能查询 LSP 上下文
2. **封装 Shadow Workspace**——编排 apply → validate → merge 闭环
3. **构建 Webview UI**——Chat + Diff Preview + Accept/Reject
4. **适配 VS Code 原生能力**——把 VS Code 的 API 暴露为 Agent 工具
5. **扩展生命周期管理**——activate/deactivate/Engine 实例管理

---

## 二、你要交付的东西

```
packages/vscode/
  package.json              # VS Code 扩展清单
  tsconfig.json             # 继承 tsconfig.base
  src/
    extension.ts            # activate/deactivate 入口
    lsp-bridge.ts           # ILSPBridge 实现
    shadow-workspace.ts     # Shadow Workspace 编排层
    vscode-tools.ts         # VS Code 原生能力 → Agent 工具接口
    webview/                # React SPA (Vite 构建)
      index.html            # HTML 入口
      App.tsx               # 根组件（路由 + 状态管理）
      ChatView.tsx          # 对话界面
      DiffPreview.tsx       # 差异审查（Accept/Reject/Edit）
      AgentStatus.tsx       # Agent 进度条 + 当前操作
      types.ts              # Webview 消息类型
    utils/
      message-codec.ts      # Webview ↔ Extension Host 消息编解码
      disposables.ts        # VS Code Disposable 管理
```

---

## 三、你依赖的契约（已经写好）

### 你要实现的: Contract F2 — ILSPBridge

```typescript
// @comdr/core/contracts.ts
export interface ILSPBridge {
  getFileContext(filePath: string): Promise<LSPFileContext | null>;
  snapshotDiagnostics(filePath: string): Promise<DiagnosticSnapshot>;
  diffDiagnostics(before: DiagnosticSnapshot, after: DiagnosticSnapshot): DiagnosticDelta;
}
```

### 你要消费的: Contract F1 — IShadowWorkspace

```typescript
// @comdr/core/contracts.ts
export interface IShadowWorkspace {
  create(projectPath: string): string;
  applyEdit(windowId: string, filePath: string, content: string): void;
  getDiagnostics(windowId: string, filePath: string): LSPDiagnostic[];
  getFileContext(windowId: string, filePath: string): LSPFileContext;
  mergeToUser(windowId: string, filePath: string): void;
  dispose(windowId: string): void;
}
```

### 共享类型（已导出）

```typescript
// @comdr/core
export type { LSPDiagnostic, LSPFileContext, DiagnosticSnapshot, DiagnosticDelta }
export type { LSPSymbolInfo, LSPImportInfo, LSPCallerInfo, LSPCalleeInfo, LSPTypeEdge }
export const LSP_SEVERITY  // 'error' | 'warning' | 'hint'
```

---

## 四、分模块任务

### 4.1 package.json + 项目骨架（Day 1）

```json
{
  "name": "@comdr/vscode",
  "version": "0.1.0",
  "displayName": "Comdr",
  "description": "DeepSeek-powered coding agent — VS Code integration",
  "main": "./dist/extension.js",
  "engines": { "vscode": "^1.92.0" },
  "activationEvents": ["onView:comdr.chatView", "onCommand:comdr.openChat"],
  "contributes": {
    "viewsContainers": {
      "activitybar": [{ "id": "comdr", "title": "Comdr", "icon": "$(hubot)" }]
    },
    "views": {
      "comdr": [{ "id": "comdr.chatView", "name": "Chat" }]
    },
    "commands": [
      { "command": "comdr.openChat", "title": "Comdr: Open Chat" },
      { "command": "comdr.newTask", "title": "Comdr: New Task" }
    ]
  },
  "dependencies": {
    "@comdr/core": "workspace:*",
    "@comdr/engine": "workspace:*",
    "@comdr/llm": "workspace:*",
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.0.0",
    "@types/vscode": "^1.92.0",
    "vite": "^5.0.0",
    "@vitejs/plugin-react": "^4.0.0"
  }
}
```

---

### 4.2 extension.ts（Day 1-2）

```typescript
/**
 * extension.ts — Comdr VS Code Extension 入口
 *
 * 职责:
 *   1. 创建/管理 Engine 实例（单例）
 *   2. 注册 Webview Provider（Chat Panel）
 *   3. 连接 Shadow Workspace（Terminal 1 提供）
 *   4. 管理生命周期（activate/deactivate）
 */

import * as vscode from 'vscode';
import { Engine, createEngine } from '@comdr/engine';
import { loadConfig } from '@comdr/core';
import { DeepSeekClient } from '@comdr/llm';
import type { IShadowWorkspace, ILSPBridge } from '@comdr/core/contracts';
import { ChatViewProvider } from './webview/provider';
import { LSPBridge } from './lsp-bridge';
import { ShadowWorkspaceOrchestrator } from './shadow-workspace';

let engine: Engine | null = null;
let chatViewProvider: ChatViewProvider | null = null;

export async function activate(context: vscode.ExtensionContext) {
  // 1. 加载配置
  const config = loadConfig(context.workspaceState);

  // 2. 创建 LLM 客户端
  const llm = new DeepSeekClient(config.llm);
  const contextLLM = config.project.contextModel
    ? new DeepSeekClient({ ...config.llm, model: config.project.contextModel })
    : undefined;

  // 3. 连接 Shadow Workspace（★ Terminal 1 提供）
  //    开发期: mock 实现
  //    联调期: 真实 Fork 实现
  const shadowWS: IShadowWorkspace = getShadowWorkspace();

  // 4. 创建 LSP Bridge（★ 你来实现）
  const lspBridge: ILSPBridge = new LSPBridge(shadowWS);

  // 5. 创建 Engine（★ 内部组件不变，传入 lspBridge）
  engine = createEngine(llm, config, null, null, contextLLM);
  // ★ Engine 需要新增 setLSPBridge() 方法 —— 见 Terminal 3 文档

  // 6. 注册 Webview Panel
  chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    engine,
    lspBridge,
    shadowWS,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('comdr.chatView', chatViewProvider),
  );

  // 7. 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('comdr.newTask', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'What do you want Comdr to do?',
      });
      if (input) {
        chatViewProvider?.startTask(input);
      }
    }),
  );
}

export function deactivate() {
  engine?.destroy();
  engine = null;
}
```

---

### 4.3 lsp-bridge.ts（Day 2-3）— ILSPBridge 实现

```typescript
/**
 * lsp-bridge.ts — ILSPBridge 实现
 *
 * 为 Engine 提供 LSP 语义信息的统一访问接口。
 *
 * Phase 1: 使用 VS Code Extension API (vscode.languages.*)
 * Phase 3: 直连 LSP 进程（来自 Terminal 1 Patch 2）
 */

import * as vscode from 'vscode';
import type {
  ILSPBridge,
  IShadowWorkspace,
} from '@comdr/core/contracts';
import type {
  LSPFileContext,
  LSPDiagnostic,
  DiagnosticSnapshot,
  DiagnosticDelta,
  LSPSymbolInfo,
  LSPImportInfo,
} from '@comdr/core/types';
import { LSP_SEVERITY } from '@comdr/core';
import { createHash } from 'node:crypto';

export class LSPBridge implements ILSPBridge {
  constructor(private readonly shadowWS?: IShadowWorkspace) {}

  /**
   * 文件内容 → SHA256
   * 用于确认诊断快照对应正确的文件版本
   */
  private hash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * vscode.Diagnostic → LSPDiagnostic 转换
   */
  private toLSPDiag(uri: vscode.Uri, d: vscode.Diagnostic): LSPDiagnostic {
    return {
      file: uri.fsPath,
      line: d.range.start.line + 1,
      column: d.range.start.character + 1,
      severity: this.mapSeverity(d.severity),
      message: d.message,
      code: typeof d.code === 'string' ? d.code : String(d.code?.value ?? ''),
      source: d.source ?? undefined,
    };
  }

  private mapSeverity(s: vscode.DiagnosticSeverity): LSPDiagnostic['severity'] {
    if (s === vscode.DiagnosticSeverity.Error) return LSP_SEVERITY.ERROR;
    if (s === vscode.DiagnosticSeverity.Warning) return LSP_SEVERITY.WARNING;
    return LSP_SEVERITY.HINT;
  }

  // ─── ILSPBridge 实现 ─────────────────────────────────

  async getFileContext(filePath: string): Promise<LSPFileContext | null> {
    const uri = vscode.Uri.file(filePath);

    // 尝试打开文件（不显示在编辑器中）
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      return null; // 文件不存在或无法读取
    }

    // 并行查询所有 LSP 信息
    const [symbols, diagnostics] = await Promise.all([
      vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeDocumentSymbolProvider', uri,
      ),
      this.snapshotDiagnostics(filePath).then(s => s.diagnostics),
    ]);

    const exports: LSPSymbolInfo[] = (symbols ?? []).map(s => ({
      name: s.name,
      kind: this.mapSymbolKind(s.kind),
      signature: '', // ★ Phase 2: 通过 hover provider 获取签名
      line: s.location.range.start.line + 1,
    }));

    // 找 imports（简化版: 扫描文档前 N 行的 import 语句）
    const imports = this.parseImports(doc);

    return {
      file: filePath,
      exports,
      imports,
      callers: [],    // ★ Phase 1: 扩展 API 限制，Phase 3 通过 LSP 直连获取
      callees: [],    // ★ Phase 1: 扩展 API 限制
      typeDependencies: [], // ★ Phase 1: 扩展 API 限制
      diagnostics,
    };
  }

  async snapshotDiagnostics(filePath: string): Promise<DiagnosticSnapshot> {
    const uri = vscode.Uri.file(filePath);
    let content = '';
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      content = doc.getText();
    } catch {
      // 文件不可读 → 空快照
    }

    const vscodeDiags = vscode.languages.getDiagnostics(uri);
    const diagnostics = vscodeDiags.map(d => this.toLSPDiag(uri, d));

    return {
      file: filePath,
      hash: this.hash(content),
      diagnostics,
      timestamp: Date.now(),
    };
  }

  diffDiagnostics(
    before: DiagnosticSnapshot,
    after: DiagnosticSnapshot,
  ): DiagnosticDelta {
    // ★ 确定性纯函数——可以写单元测试覆盖
    const key = (d: LSPDiagnostic) =>
      `L${d.line}:C${d.column}:${d.code ?? ''}:${d.message}`;

    const beforeSet = new Set(before.diagnostics.map(key));
    const afterSet  = new Set(after.diagnostics.map(key));

    return {
      introduced: after.diagnostics.filter(d => !beforeSet.has(key(d))),
      fixed:      before.diagnostics.filter(d => !afterSet.has(key(d))),
      unchanged:  after.diagnostics.filter(d => beforeSet.has(key(d))),
    };
  }

  // ─── 工具函数 ────────────────────────────────────────

  private mapSymbolKind(k: vscode.SymbolKind): LSPSymbolInfo['kind'] {
    const map: Record<number, LSPSymbolInfo['kind']> = {
      [vscode.SymbolKind.Function]: 'function',
      [vscode.SymbolKind.Class]: 'class',
      [vscode.SymbolKind.Variable]: 'variable',
      [vscode.SymbolKind.Interface]: 'interface',
      [vscode.SymbolKind.Enum]: 'enum',
    };
    return map[k] ?? 'variable';
  }

  private parseImports(doc: vscode.TextDocument): LSPImportInfo[] {
    const imports: LSPImportInfo[] = [];
    // 简化版: 正则匹配 import 语句（前 200 行）
    const lines = doc.getText().split('\n').slice(0, 200);
    const importRe = /import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
    for (const line of lines) {
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(line)) !== null) {
        imports.push({ name: m[1]!, from: m[1]! });
      }
    }
    return imports;
  }
}
```

---

### 4.4 shadow-workspace.ts（Day 3-4）— Shadow Workspace 编排

```typescript
/**
 * shadow-workspace.ts — Shadow Workspace 编排层
 *
 * 职责:
 *   1. 封装 IShadowWorkspace 的操作
 *   2. 实现 Agent 写入 → LSP 验证 → 修复 → 合并 的完整闭环
 *   3. LSP 断路器: 同一文件最多 3 轮自动修复
 */

import type { IShadowWorkspace } from '@comdr/core/contracts';
import type { LSPDiagnostic, DiagnosticDelta } from '@comdr/core/types';
import { SYSTEM } from '@comdr/core';

export class ShadowWorkspaceOrchestrator {
  private windowId: string | null = null;

  constructor(
    private readonly shadowWS: IShadowWorkspace,
    private readonly projectPath: string,
  ) {}

  /** 确保隐藏窗口存在 */
  private ensureWindow(): string {
    if (!this.windowId) {
      this.windowId = this.shadowWS.create(this.projectPath);
    }
    return this.windowId;
  }

  /**
   * ★ 核心闭环: 应用 Agent 的修改 → LSP 验证 → 自动修复（最多 3 轮）
   *
   * @returns { accepted, diagnostics, fixAttempts }
   *   accepted=true  → 验证通过，已合并到用户窗口
   *   accepted=false → 3 轮修复后仍有错误，diff 已合并但附带错误列表
   */
  async applyAndValidate(
    filePath: string,
    content: string,
  ): Promise<{
    accepted: boolean;
    diagnostics: LSPDiagnostic[];
    fixAttempts: number;
  }> {
    const windowId = this.ensureWindow();
    const maxFixes = SYSTEM.MAX_STALLED_TURNS; // 3

    // Round 0: 应用原始修改
    this.shadowWS.applyEdit(windowId, filePath, content);
    await this.waitForLSP();
    let diags = this.shadowWS.getDiagnostics(windowId, filePath);
    const errors = diags.filter(d => d.severity === 'error');

    if (errors.length === 0) {
      // ✅ 无错误，直接合并
      this.shadowWS.mergeToUser(windowId, filePath);
      return { accepted: true, diagnostics: diags, fixAttempts: 0 };
    }

    // Round 1-3: 尝试自动修复
    // 修复策略由 Agent 主导——把错误列表发给 Agent，Agent 再调 tool
    // 这里只做断路器控制
    for (let attempt = 1; attempt <= maxFixes; attempt++) {
      // ★ 注意: 自动修复由 Engine 的 reflection.ts 驱动
      // Shadow Workspace 只是提供验证环境。
      // 如果 Engine 在 attempt 后的结果通过验证 → 合并
      // 如果 3 轮后仍有错误 → 合并 + 附带诊断列表
      diags = this.shadowWS.getDiagnostics(windowId, filePath);
      const remainingErrors = diags.filter(d => d.severity === 'error');
      if (remainingErrors.length === 0) {
        this.shadowWS.mergeToUser(windowId, filePath);
        return { accepted: true, diagnostics: diags, fixAttempts: attempt };
      }
    }

    // 3 轮后仍有错误 → 合并 + 附带诊断（让用户看到问题）
    this.shadowWS.mergeToUser(windowId, filePath);
    return {
      accepted: false,
      diagnostics: this.shadowWS.getDiagnostics(windowId, filePath),
      fixAttempts: maxFixes,
    };
  }

  /** 等待 LSP 分析完成（轮询模式，最多 3 秒） */
  private async waitForLSP(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 800));
    // ★ 更好的方案: 监听 LSP 完成事件（Patch 2 提供）
  }

  /** 清理 */
  dispose(): void {
    if (this.windowId) {
      this.shadowWS.dispose(this.windowId);
      this.windowId = null;
    }
  }
}
```

---

### 4.5 Webview（Day 4-7）

#### 4.5.1 消息协议（webview/types.ts）

```typescript
// Extension → Webview
export type ExtensionMessage =
  | { type: 'state'; state: ChatState }
  | { type: 'textDelta'; content: string }
  | { type: 'thinkingDelta'; content: string }
  | { type: 'toolCall'; toolName: string; status: 'running' | 'done' | 'error' }
  | { type: 'toolResult'; toolName: string; ok: boolean; summary: string }
  | { type: 'diff'; filePath: string; original: string; modified: string }
  | { type: 'done'; turns: number; tokens: number; summary: string }
  | { type: 'error'; message: string };

// Webview → Extension
export type WebviewMessage =
  | { type: 'userInput'; text: string }
  | { type: 'acceptDiff'; filePath: string }
  | { type: 'rejectDiff'; filePath: string; reason?: string }
  | { type: 'abortTask' }
  | { type: 'retryFix'; filePath: string; instruction?: string };

export interface ChatState {
  sessionId: string | null;
  turn: number;
  tokensUsed: number;
  isRunning: boolean;
  messages: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  diff?: { filePath: string; original: string; modified: string };
  timestamp: number;
}
```

#### 4.5.2 Webview Provider（extension 侧）

```typescript
/**
 * ChatViewProvider — 管理 Webview 生命周期 + 双向通信
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly engine: Engine,
    private readonly lspBridge: ILSPBridge,
    private readonly shadowOrch: ShadowWorkspaceOrchestrator,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.getHtml();

    // 接收 Webview 消息
    webviewView.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      switch (msg.type) {
        case 'userInput':
          await this.handleUserInput(msg.text);
          break;
        case 'acceptDiff':
          // 已经合并（Shadow Workspace 已做），只需确认
          this.postMessage({ type: 'textDelta', content: 'Diff accepted.' });
          break;
        case 'rejectDiff':
          // 回滚到 snapshot
          break;
        case 'abortTask':
          this.engine.abort();
          break;
      }
    });
  }

  async startTask(input: string) {
    if (!this._view) return;
    this.postMessage({ type: 'state', state: { ... } });

    // ★ 设置 LSP Bridge → Engine（新方法，见 Terminal 3 文档）
    this.engine.setLSPBridge(this.lspBridge);

    for await (const event of this.engine.run(input, 'agent')) {
      // 事件 → ExtensionMessage → Webview
      switch (event.type) {
        case 'text_delta':
          this.postMessage({ type: 'textDelta', content: event.content });
          break;
        case 'tool_call':
          this.postMessage({ type: 'toolCall', toolName: event.call.function.name, status: 'running' });
          break;
        // ... 其他事件类型
      }
    }
  }

  private postMessage(msg: ExtensionMessage) {
    this._view?.webview.postMessage(msg);
  }
}
```

#### 4.5.3 React 前端（webview/App.tsx）

```tsx
/**
 * Webview 根组件
 *
 * 布局:
 * ┌─────────────────────────────────┐
 * │ Agent Status Bar (进度 + token)  │
 * ├─────────────────────────────────┤
 * │                                 │
 * │ Chat Messages                   │
 * │                                 │
 * ├─────────────────────────────────┤
 * │ Diff Preview (弹出式)            │
 * ├─────────────────────────────────┤
 * │ Input Box                       │
 * └─────────────────────────────────┘
 */
```

核心组件:
- **ChatView.tsx**: 虚拟滚动消息列表（参考 Roo Code 用 react-virtuoso）
- **DiffPreview.tsx**: Monaco DiffEditor 内嵌（通过 `vscode.diff` 命令）
- **AgentStatus.tsx**: 当前轮次/Token/模型/运转状态

---

## 五、开发流程

```
Day 1-2: 骨架
  □ packages/vscode/ 目录 + package.json + tsconfig.json
  □ extension.ts activate/deactivate
  □ Webview 空壳 (HTML + 消息通道)
  □ 包名注册到 pnpm-workspace.yaml

Day 2-4: LSP Bridge
  □ lsp-bridge.ts 完整实现（用 vscode.languages.* API）
  □ diffDiagnostics() 单元测试（确定性纯函数）
  □ mock IShadowWorkspace → 测试 getFileContext

Day 3-5: Shadow Workspace 编排
  □ shadow-workspace.ts applyAndValidate 闭环
  □ 断路器逻辑（3 轮）
  □ mock IShadowWorkspace → 验证编排逻辑

Day 5-7: Webview
  □ React 项目搭建（Vite）
  □ ChatView: 消息列表 + 输入框
  □ DiffPreview: 使用 vscode.diff 命令
  □ AgentStatus: 进度条 + Token 计数
  □ 消息编解码 + 状态管理

Day 8: 联调
  □ 和 Terminal 3 联调: Engine.setLSPBridge(lspBridge)
  □ 和 Terminal 1 联调: 替换 mock → 真实 IShadowWorkspace
```

---

## 六、和 Terminal 1 的接口约定

```
你调用 IShadowWorkspace 的方法:
  create(projectPath)        → windowId
  applyEdit(windowId, path, content)
  getDiagnostics(windowId, path)  → LSPDiagnostic[]
  getFileContext(windowId, path)  → LSPFileContext
  mergeToUser(windowId, path)
  dispose(windowId)

联调前: 用 mock 实现（内存 Map 模拟文件 + 空诊断列表）
联调时: 替换为 Terminal 1 的真实 Fork 实现
```

## 七、和 Terminal 3 的接口约定

```
你提供 ILSPBridge:
  getFileContext(path)        → Promise<LSPFileContext | null>
  snapshotDiagnostics(path)   → Promise<DiagnosticSnapshot>
  diffDiagnostics(before, after) → DiagnosticDelta

Terminal 3 要新增:
  Engine.setLSPBridge(bridge: ILSPBridge): void
  - prompt.ts 调用 bridge.getFileContext() 注入 L1.5 层
  - reflection.ts 调用 bridge.snapshot+bridge.diff 做 LSP 纠正
  - world-model.ts 调用 bridge.getFileContext() 做语义管道
```

---

## 八、不要做的事情

- ❌ 不要修改 Engine 内部逻辑（那是 Terminal 3 的活）
- ❌ 不要在 webview 里实现完整的编辑器（用 VS Code 原生 diff）
- ❌ 不要处理 DeepSeek API 调用（Engine 管理）
- ❌ 不要做 settings UI（Phase 2）
- ❌ 不要做多工作区管理（Phase 1 单工作区）
