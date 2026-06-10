# Agent Task: Terminal 1 — VS Code Fork + Shadow Workspace

> 输入: `IShadowWorkspace` 接口契约（`@comdr/core/contracts.ts`）
> 输出: 3 个 VS Code OSS patch + 验证通过的 Shadow Workspace
> 不依赖: Terminal 2, Terminal 3（完全独立开发）

---

## 一、你的职责

实现 `Contract F1: IShadowWorkspace` —— 让 Agent 有一个"用户看不见的编辑器窗口"，
可以在里面随便改代码、跑 LSP、拿到诊断结果，验证通过后再合并给用户。

这是 Comdr 深度集成的核心差异化能力。没有它，LSP 验证就只能靠用户手动检查。

---

## 二、你要交付的东西

```
1. VS Code OSS 可构建的 fork 仓库
2. 3 个 patch 文件（清晰、可 review、可 rebase）
3. 验证脚本: 往隐藏窗口写代码 → LSP 返回诊断 → 3 轮修复 → mergeToUser
4. 实现 IShadowWorkspace 的 7 个方法
```

---

## 三、IShadowWorkspace 接口（你的实现目标）

```typescript
// @comdr/core/contracts.ts 中已定义

export interface IShadowWorkspace {
  create(projectPath: string): string;
  applyEdit(windowId: string, filePath: string, content: string): void;
  getDiagnostics(windowId: string, filePath: string): LSPDiagnostic[];
  getFileContext(windowId: string, filePath: string): LSPFileContext;
  mergeToUser(windowId: string, filePath: string): void;
  dispose(windowId: string): void;
}

// 类型定义在 @comdr/core/types.ts:
//   LSPDiagnostic, LSPFileContext, LSPSymbolInfo, LSPImportInfo,
//   LSPCallerInfo, LSPCalleeInfo, LSPTypeEdge, LSP_SEVERITY
```

---

## 四、3 个 Patch 详解

### Patch 1: hidden-editor-window（~100 行，最核心）

```
目的: 创建一个 show:false 的 Electron BrowserWindow，
      加载当前 VS Code 工作区，拥有独立的 LSP Server 实例。

文件: src/vs/workbench/contrib/comdr/ (新建目录)

需要做的事:
  1. 创建 BrowserWindow 时设置 show: false
  2. 加载当前 workspace 的相同文件夹
  3. 该窗口自动启动自己的 Language Server（VS Code 自动管理）
  4. 暴露 IPC 通道给 Extension Host:
     - comdr:create-shadow-window
     - comdr:dispose-shadow-window
     - comdr:apply-edit
     - comdr:get-diagnostics
     - comdr:get-file-context
     - comdr:merge-to-user

关键难点:
  ★ 两个 LSP 实例操作同一个项目不能冲突。
     解决: 隐藏窗口使用独立的 userDataDir 和 LSP 缓存目录。
  ★ 内存管理: 隐藏窗口不是轻量的。15 分钟无活动自动 dispose。
  ★ 参考: Cursor 的 Shadow Workspace 设计（已公开在 blog）。
          Void editor 的 hidden window 实现（GitHub: voideditor/void）。
```

### Patch 2: lsp-bridge-ipc（~80 行）

```
目的: 将隐藏窗口的 LSP 诊断流桥接到 Extension Host，
      让 ILSPBridge 的实现方（Terminal 2）能低延迟获取诊断。

文件: src/vs/workbench/api/common/extHostLanguageFeatures.ts

需要做的事:
  1. 在 Extension Host 侧新增一个事件监听器:
     onShadowDiagnostics(callback: (uri: string, diagnostics: Diagnostic[]) => void)
  2. 隐藏窗口的 LSP 诊断变化 → IPC → Extension Host → callback
  3. 不做限流（和用户侧的诊断不同，Agent 侧需要完整数据）

为什么需要这个 patch:
  ★ vscode.languages.getDiagnostics() 只返回用户窗口的诊断
  ★ 隐藏窗口的诊断无法通过标准 API 获取
  ★ 没有这个 patch，Terminal 2 的 lsp-bridge.ts 拿不到 Shadow Workspace 的诊断
```

### Patch 3: textmodel-write-hook（~60 行）

```
目的: 在 VS Code 的 TextModel 写入路径上插入一个拦截点，
      让 Agent 的 file_edit 操作可以被路由到 Shadow Workspace 而不是用户窗口。

文件: src/vs/editor/common/model/textModel.ts

需要做的事:
  1. 新增一个全局 hook:
     registerWriteHook(hook: (uri: string, content: string) => boolean)
     返回 true = 拦截到 Shadow Workspace，不写入用户窗口
     返回 false = 正常写入用户窗口
  2. Extension Host 注册 hook → Agent 写入自动路由到隐藏窗口
  3. 验证通过后 hook 返回 false → 正式写入用户窗口（mergeToUser）

为什么需要这个 patch:
  ★ 没有 hook，Agent 的 file_edit 直接改用户文件 → 没有 LSP 预检
  ★ 有这个 hook，Agent 写入 → 隐藏窗口 → LSP → 修正 → 再写入用户窗口
```

---

## 五、开发环境搭建

```bash
# 1. Clone VS Code OSS
git clone https://github.com/microsoft/vscode.git vscode-comdr
cd vscode-comdr

# 2. 选择基准版本（建议用最新的 release tag，不是 main）
git checkout $(git tag --sort=-v:refname | head -1)

# 3. 安装依赖
yarn install

# 4. 创建 patch 工作分支
git checkout -b comdr-shadow-workspace

# 5. 确认能编译
yarn compile

# 6. 验证能启动
./scripts/code.sh   # macOS/Linux
# 或 scripts\code.bat  # Windows
```

---

## 六、验证方式

### 6.1 独立验证（不依赖 Terminal 2/3）

写一个最小化的 VS Code 扩展（就放在 fork 仓库里做测试）:

```typescript
// test-shadow-workspace.ts
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  // 1. 创建隐藏窗口
  const windowId = comdr.createShadow('./test-project');

  // 2. 往隐藏窗口写文件
  comdr.applyEdit(windowId, 'src/test.ts', `
    function add(a: number, b: string): number {
      return a + b;  // 类型错误!
    }
  `);

  // 3. 等 LSP 返回诊断
  await sleep(2000);
  const diags = comdr.getDiagnostics(windowId, 'src/test.ts');
  // 期望: 1 个 type error (b: string 不能用于 a + b)

  // 4. 修复
  comdr.applyEdit(windowId, 'src/test.ts', `
    function add(a: number, b: number): number {
      return a + b;  // 正确
    }
  `);

  // 5. 再取诊断
  await sleep(2000);
  const diags2 = comdr.getDiagnostics(windowId, 'src/test.ts');
  // 期望: 0 个错误

  // 6. 合并到用户窗口
  comdr.mergeToUser(windowId, 'src/test.ts');

  // 7. 清理
  comdr.dispose(windowId);
}
```

### 6.2 验证通过标准

- [ ] 隐藏窗口创建成功（show:false，用户看不到）
- [ ] 隐藏窗口的 LSP Server 正常启动（TypeScript 类型检查可用）
- [ ] applyEdit 写入内容 → LSP 在 2 秒内返回诊断
- [ ] 诊断结果包含完整的 severity + line + column + message + code
- [ ] 用户窗口的 LSP 不受隐藏窗口影响（隔离）
- [ ] mergeToUser → 用户窗口出现正确的 diff
- [ ] dispose → 隐藏窗口进程退出，内存释放
- [ ] 15 分钟无活动 → 自动 dispose

---

## 七、IShadowWorkspace 方法实现指南

### create(projectPath: string): string

```
1. 创建新的 Electron BrowserWindow({ show: false })
2. 加载 VS Code workbench，workspace 指向 projectPath
3. 为新窗口分配独立的:
   - LSP 缓存目录（避免和用户窗口的 LSP 冲突）
   - userDataDir（避免设置污染）
4. 返回 windowId（UUID，用于后续方法定位窗口）
5. 启动 15 分钟 inactivity timer
```

### applyEdit(windowId, filePath, content)

```
1. 通过 windowId 找到隐藏窗口
2. 在该窗口中打开 filePath（如果还没打开）
3. 用 TextModel.setValue() 写入 content
4. 触发 LSP 重新分析
5. 不触发用户窗口的任何事件
```

### getDiagnostics(windowId, filePath)

```
1. 等待 LSP 完成分析（最多 3 秒）
2. 从隐藏窗口的 LSP 实例获取诊断
3. 转换为 LSPDiagnostic[] 格式（统一格式，不管语言）
4. 返回完整列表
```

### getFileContext(windowId, filePath)

```
1. 调用 LSP documentSymbol → 提取 exports
2. 调用 LSP hover（每个 export） → 提取类型签名
3. 调用 LSP references → 提取 callers
4. 调用 LSP callHierarchy/outgoingCalls → 提取 callees
5. 调用 LSP typeHierarchy → 提取 typeDependencies
6. 调用 getDiagnostics → 提取 diagnostics
7. 聚合为 LSPFileContext 返回

★ 这是 LSAP 论文的核心: 1 次调用替代 12 次 LSP 原子操作。
```

### mergeToUser(windowId, filePath)

```
1. 从隐藏窗口读取最终文件内容
2. 用 WorkspaceEdit 写入用户窗口
3. 用户窗口的编辑器自动显示 diff
4. 用户可以用 Accept/Reject 按钮决定是否采纳
```

### dispose(windowId)

```
1. 关闭隐藏 BrowserWindow
2. 终止该窗口的 LSP 进程（以及任何关联的子进程）
3. 清理临时文件
4. 从活跃窗口表中移除
```

---

## 八、不要做的事情

- ❌ 不要修改 VS Code 的 UI 或主题（这是 Comdr，不是新 IDE）
- ❌ 不要修改扩展加载逻辑（OpenVSX/Marketplace 不动）
- ❌ 不要碰 Debug Adapter、Terminal、SCM 等其他子系统
- ❌ 不要做多窗口管理优化（Phase 1 只需单隐藏窗口）
- ❌ 不要处理文件冲突（Terminal 2 负责编排 apply/validate/merge 流程）

---

## 九、参考资源

```
Cursor Shadow Workspace 设计:
  https://cursor.com/en-US/blog/shadow-workspace

Void editor 开源实现:
  https://github.com/voideditor/void
  src/vs/workbench/contrib/void/ (hidden window + diff apply)

Electron BrowserWindow 文档:
  https://www.electronjs.org/docs/latest/api/browser-window

VS Code Extension Host API:
  src/vs/workbench/api/common/extHost*.ts
```
