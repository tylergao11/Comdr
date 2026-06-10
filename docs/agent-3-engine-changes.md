# Agent Task: Terminal 3 — Engine 改造

> 输入: `ILSPBridge` 接口契约（由 Terminal 2 实现） + 新类型
> 输出: 3 个文件改动 (~150 行) + Engine.setLSPBridge() 新方法
> 不依赖: Terminal 1 (Fork) 完全不需要, Terminal 2 只在联调时需要
> 独立开发: mock ILSPBridge → 单元测试 → 联调时替换为真实实现

---

## 一、你的职责

把 LSP 语义能力集成到 Agent 循环里，改三个文件，每个 ~50 行。

```
当前 Engine 循环（9步）              改造后
══════════════════════════════      ══════════════════════════════
1. prompt.build()                  1. prompt.build()
                                      ★ + LSP 类型上下文注入 (L1.5)
2. planner.route()                 2. planner.route()
3. reasoning.inject()              3. reasoning.inject()
4. llm.chatStream()                4. llm.chatStream()
5. text → done                     5. text → done
6. tool_calls →                    6. tool_calls →
   a. reflection.intra()              a. reflection.intra()
   b. tools.execute()                 b. ★ LSP snapshot before
   c. reasoning.capture()             c. tools.execute()
   d. reflection.inter()              d. ★ LSP snapshot after
   e. memory.update()                 e. reasoning.capture()
                                      f. reflection.inter()
                                      g. ★ correctByLSP()  ← 新增纠正路径
                                      h. memory.update()
7. progress.measure()              7. progress.measure()
8. context.compact()               8. context.compact()
```

改了 3 个地方：
- **prompt.ts**: Agent 操作文件时，该文件的类型图/调用链自动注入上下文
- **reflection.ts**: 工具执行后，LSP 诊断差值决定接受/回滚/修正（确定性，不调 LLM）
- **world-model.ts**: 新增 LSP 语义管道，和现有文本 World Model 互补

---

## 二、前置：Engine 新增 setLSPBridge()

```
文件: packages/engine/src/loop.ts
位置: Engine 类的属性区 + 新增方法
行数: ~15 行
```

```typescript
// Engine 类新增属性:
import type { ILSPBridge } from '@comdr/core/contracts';

private lspBridge: ILSPBridge | null = null;

// Engine 类新增方法:
/**
 * ★ 设置 LSP 桥接——由 VS Code Extension (Terminal 2) 调用。
 * CLI 模式下为 null → LSP 相关功能静默降级。
 */
setLSPBridge(bridge: ILSPBridge | null): void {
  this.lspBridge = bridge;
}

// 然后需要在 prompt.ts, reflection.ts, world-model.ts 中
// 能访问到 lspBridge。方式: 
//   - prompt.ts: PromptConstructor 新增 setLSPBridge()
//   - reflection.ts: ReflectionEngine 新增 setLSPBridge()
//   - world-model.ts: discoverAndRetrieve 新增可选参数
//   或
//   - loop.ts 在调用这些模块的方法时把 lspBridge 作为参数传入

// ★ 推荐方案: 在 loop.ts 中调用 prompt.setLSPContext()，
//   把 lspBridge 的结果传给 prompt，保持各模块独立。
```

---

## 三、PromptConstructor 改造（~60 行）

```
文件: packages/engine/src/prompt.ts
改造点: 新增方法 + L1.5 层注入
行数: ~60 行
```

### 3.1 新增属性

```typescript
// PromptConstructor 类新增属性:
/** ★ LSP 结构化上下文——当前操作文件的类型图/调用链/诊断 */
private lspContext: string = '';
```

### 3.2 新增方法

```typescript
/**
 * ★ 设置 LSP 结构化上下文（注入到 L1.5 层）
 *
 * 由 loop.ts 在每轮 prompt.build() 之前调用。
 * 参数来自 ILSPBridge.getFileContext() 的结果。
 *
 * 缓存策略: LSP 上下文基于文件内容——
 *   文件没改 → LSP 上下文不变 → 前缀缓存友好
 *   文件改了 → LSP 上下文更新（但其他静态区不变，只 miss 少量 tokens）
 *
 * @param fileContexts 当前轮次涉及的关键文件的 LSP 上下文
 *                     （来自 stateWindow 中最近操作的文件）
 */
setLSPContext(fileContexts: LSPFileContext[]): void {
  if (fileContexts.length === 0) {
    this.lspContext = '';
    return;
  }

  // ★ 格式化为 Agent 友好的 Markdown（参考 JetBrains PSI 论文的输出格式）
  const blocks: string[] = [];

  for (const ctx of fileContexts) {
    const fileName = ctx.file.split('/').pop() ?? ctx.file;

    const lines: string[] = [];
    lines.push(`### ${fileName}`);

    // Exports
    if (ctx.exports.length > 0) {
      const items = ctx.exports.map(
        e => `- \`${e.name}\` (${e.kind}) → ${e.signature || '(no signature)'}`
      );
      lines.push('**Exports:**', ...items);
    }

    // Imports
    if (ctx.imports.length > 0) {
      const items = ctx.imports.map(
        i => `- \`${i.name}\` from \`${i.from}\``
      );
      lines.push('**Imports:**', ...items);
    }

    // Callers (谁调用了这个文件)
    if (ctx.callers.length > 0) {
      const items = ctx.callers.map(
        c => `- \`${c.symbol}\` in \`${c.file}\`:${c.line}`
      );
      lines.push('**Callers:**', ...items);
    }

    // Callees (这个文件调用了谁)
    if (ctx.callees.length > 0) {
      const items = ctx.callees.map(
        c => `- \`${c.symbol}\` → \`${c.file}\``
      );
      lines.push('**Callees:**', ...items);
    }

    // Type Dependencies
    if (ctx.typeDependencies.length > 0) {
      const items = ctx.typeDependencies.map(
        t => `- \`${t.name}\` (${t.relation})`
      );
      lines.push('**Type Dependencies:**', ...items);
    }

    // Diagnostics
    if (ctx.diagnostics.length > 0) {
      const errors = ctx.diagnostics.filter(d => d.severity === 'error');
      const warnings = ctx.diagnostics.filter(d => d.severity === 'warning');
      if (errors.length > 0) {
        lines.push(`**Errors (${errors.length}):**`);
        errors.forEach(e => lines.push(`- L${e.line}: ${e.message} [${e.code ?? e.source ?? '?'}]`));
      }
      if (warnings.length > 0) {
        lines.push(`**Warnings (${warnings.length}):**`);
        warnings.forEach(w => lines.push(`- L${w.line}: ${w.message}`));
      }
    }

    blocks.push(lines.join('\n'));
  }

  this.lspContext = blocks.join('\n\n---\n\n');
  // ★ 不设上限——LSP 语义信息是高密度、高价值的。
  //   截断会丢失类型关系，反而让 Agent 犯错。
}
```

### 3.3 注入到 buildContextSuffix（L7 动态区）

```
文件位置: prompt.ts 第 373 行 buildContextSuffix 方法

在现有 entityContext 和 compactSummary 之后，新增 lspContext 块:
```

```typescript
// 在 buildContextSuffix() 方法中，extras 数组后面新增:
if (this.lspContext) {
  blocks.push(`<lsp>\n${this.lspContext}\n</lsp>`);
}

// ★ 为什么放动态区而不是静态区:
//   LSP 上下文随 Agent 操作的文件变化。
//   但同一文件在内容未改时 LSP 上下文不变 → 同文件连续操作时缓存友好。
//   放在 L7 后缀比单独消息好——不切断前缀缓存边界。
```

### 3.4 需要新增的 import

```typescript
import type { LSPFileContext } from '@comdr/core/types';
```

---

## 四、ReflectionEngine 改造（~50 行）

```
文件: packages/engine/src/reflection.ts
改造点: 新增 correctByLSP() 方法 → 确定性诊断纠正
行数: ~50 行
```

### 4.1 新增方法

```typescript
/**
 * ★ LSP 诊断差值纠正——确定性、不调 LLM。
 *
 * 和 selfCorrect() 的关系:
 *   - correctByLSP(): 处理语法/类型错误（LSP 诊断差值 → 确定性决策）
 *   - selfCorrect():  处理逻辑/测试错误（reasoning + prefix completion → LLM 决策）
 *
 * 调用顺序（在 loop.ts 中）:
 *   1. snapshot before  →  D_before
 *   2. tool execute     →  改文件
 *   3. snapshot after   →  D_after
 *   4. correctByLSP(D_before, D_after) → 决策
 *      - 纯改善 → 接受
 *      - 纯恶化 → 回滚
 *      - 有改善有恶化 → 把新错误注入 Agent 反馈，让它再修
 *   5. 如果仍有 test_failed → selfCorrect()（LLM 路径）
 *
 * ★ Lanser-CLI 论文: 这本质上就是过程奖励信号。
 *   r = α*(errors_before - errors_after) + β*safety_check
 *
 * @returns 决策结果 + 反馈文本
 */
correctByLSP(
  before: DiagnosticSnapshot,
  after: DiagnosticSnapshot,
): LSPCorrectionDecision {
  const delta = this.computeDiagnosticDelta(before, after);

  // 计算分数（简化版 Lanser-CLI 奖励函数）
  const score =
    delta.fixed.length * 2    // 修复一个错误 = +2
    - delta.introduced.length * 3;  // 引入新错误 = -3（惩罚更重）

  if (score > 0 && delta.introduced.length === 0) {
    // ✅ 纯改善: 修复了 N 个错误，没引入新错误
    return {
      decision: 'accept',
      feedback: delta.fixed.length > 0
        ? `Fixed ${delta.fixed.length} LSP issue(s):\n${this.formatDiagnostics(delta.fixed)}`
        : 'No LSP issues introduced.',
    };
  }

  if (score < 0 && delta.fixed.length === 0) {
    // ❌ 纯恶化: 引入了 N 个新错误，没修复任何错误
    return {
      decision: 'rollback',
      feedback:
        `Introduced ${delta.introduced.length} new LSP issue(s):\n` +
        this.formatDiagnostics(delta.introduced),
    };
  }

  if (delta.introduced.length > 0) {
    // ⚠️ 混合: 有改善也有恶化 → 把新错误反馈给 Agent
    return {
      decision: 'retry',
      feedback:
        (delta.fixed.length > 0
          ? `Fixed ${delta.fixed.length} issue(s) but introduced ${delta.introduced.length} new one(s).\n`
          : `Introduced ${delta.introduced.length} new LSP issue(s).\n`) +
        `Please fix:\n${this.formatDiagnostics(delta.introduced)}`,
    };
  }

  // 无变化
  return { decision: 'accept', feedback: '' };
}

/**
 * ★ 计算诊断差值——确定性纯函数。
 * 可独立单元测试。
 */
private computeDiagnosticDelta(
  before: DiagnosticSnapshot,
  after: DiagnosticSnapshot,
): {
  introduced: LSPDiagnostic[];
  fixed: LSPDiagnostic[];
} {
  // 用 (line, column, code, message) 作为诊断的唯一标识
  const key = (d: LSPDiagnostic) =>
    `L${d.line}:C${d.column}:${d.code ?? ''}:${d.message}`;

  const beforeSet = new Set(before.diagnostics.map(key));
  const afterSet = new Set(after.diagnostics.map(key));

  return {
    introduced: after.diagnostics.filter(d => !beforeSet.has(key(d))),
    fixed: before.diagnostics.filter(d => !afterSet.has(key(d))),
  };
}

private formatDiagnostics(diags: LSPDiagnostic[]): string {
  return diags
    .map(d => `  L${d.line}:C${d.column} [${d.severity}] ${d.message}`)
    .join('\n');
}
```

### 4.2 新增类型（在 reflection.ts 内部定义）

```typescript
/** LSP 纠正决策 */
export interface LSPCorrectionDecision {
  /** 决策类型 */
  decision: 'accept' | 'rollback' | 'retry';
  /** 给 Agent 的反馈文本 */
  feedback: string;
}
```

### 4.3 需要新增的 import

```typescript
import type { LSPDiagnostic, DiagnosticSnapshot } from '@comdr/core/types';
```

---

## 五、World Model 改造（~40 行）

```
文件: packages/engine/src/world-model.ts
改造点: 新增 LSP 语义管道函数
行数: ~40 行
```

### 5.1 新增函数

```typescript
/**
 * ★ 构建 LSP 语义 World Model chunk。
 *
 * 和现有 discoverComdrMd() 的关系:
 *   - discoverComdrMd():     文本级 World Model（COMDR.md → BM25 检索）
 *   - buildLSPWorldChunks(): 语义级 World Model（LSP → 类型图/调用链）
 *
 *   两者互补——bootstrap(Rust) 做广度扫描，LSP 做深度分析。
 *
 * 用法:
 *   const chunks = await buildLSPWorldChunks(lspBridge, currentFile);
 *   const text = formatLSPChunksForPrompt(chunks);
 *   prompt.setLSPContext(text);  // 或通过 prompt.ts 的 setLSPContext 方法
 *
 * @param lspBridge  Terminal 2 提供的 LSP 桥接
 * @param filePaths  需要深度分析的文件路径列表
 * @returns          Agent 友好的 LSP 语义描述列表
 */
export async function buildLSPWorldChunks(
  lspBridge: ILSPBridge,
  filePaths: string[],
): Promise<LSPFileContext[]> {
  const results: LSPFileContext[] = [];

  for (const filePath of filePaths) {
    const ctx = await lspBridge.getFileContext(filePath);
    if (ctx) {
      results.push(ctx);
    }
  }

  return results;
}

/**
 * ★ 从 State Window 提取关键文件路径。
 * 用于决定哪些文件需要 LSP 深度分析。
 */
export function extractKeyFiles(stateWindow: { key: string }[]): string[] {
  return stateWindow
    .map(e => {
      // key 格式: "file:src/auth/login.ts" → "src/auth/login.ts"
      if (e.key.startsWith('file:')) {
        return e.key.slice(5);
      }
      return null;
    })
    .filter((p): p is string => p !== null);
}
```

### 5.2 需要新增的 import

```typescript
import type { ILSPBridge } from '@comdr/core/contracts';
import type { LSPFileContext } from '@comdr/core/types';
```

---

## 六、loop.ts 集成（~20 行）

```
文件: packages/engine/src/loop.ts
改造点: 在适当位置调用新增的 LSP 方法
行数: ~20 行
```

在 loop.ts 的主循环中需要在两个位置插入 LSP 相关调用：

### 6.1 Prompt 构建前：注入 LSP 上下文

```typescript
// loop.ts 主循环中，在 prompt.build() 之前（约第 410 行之前）:

// ★ LSP: 注入当前操作文件的语义上下文
if (this.lspBridge) {
  const keyFiles = extractKeyFiles(session.stateWindow);
  if (keyFiles.length > 0) {
    const lspContexts = await buildLSPWorldChunks(this.lspBridge, keyFiles);
    this.prompt.setLSPContext(lspContexts);
  }
}
```

### 6.2 工具执行前后：诊断快照 + 纠正

```typescript
// loop.ts 主循环中，工具执行区域（约第 530 行附近）:

// ★ LSP: 对每个 file_edit/file_write 工具调用，做诊断差值检查
if (this.lspBridge && call.function.name === 'file_edit') {
  const args = safeParseArgs(call.function.arguments);
  const filePath = typeof args.path === 'string' ? args.path : '';
  if (filePath) {
    // Before snapshot
    const before = await this.lspBridge.snapshotDiagnostics(filePath);

    // Execute tool
    const result = await this.executeToolAsync(call);

    // After snapshot
    const after = await this.lspBridge.snapshotDiagnostics(filePath);

    // ★ LSP 纠正路径（确定性，优于 LLM self-correct）
    const lspDecision = this.reflection.correctByLSP(before, after);
    if (lspDecision.decision === 'rollback') {
      // 纯恶化 → 回滚 + 注入反馈
      if (result.snapshotId) this.tools?.rollback(result.snapshotId);
      session.messages.push({
        role: MESSAGE_ROLE.SYSTEM,
        content: `[lsp-check] ${lspDecision.feedback} Changes rolled back.`,
      });
      continue; // 跳过此 tool 的后续处理
    } else if (lspDecision.decision === 'retry') {
      // 混合 → 注入反馈，让 Agent 再修
      session.messages.push({
        role: MESSAGE_ROLE.SYSTEM,
        content: `[lsp-check] ${lspDecision.feedback}`,
      });
    }
    // accept → 正常流程继续
  }
}
```

---

## 七、独立开发指南

Terminal 3 不依赖 Terminal 1 和 Terminal 2 的完整实现。

### 7.1 Mock ILSPBridge

```typescript
// mock-lsp-bridge.ts (放在 tests/ 目录)
import type { ILSPBridge } from '@comdr/core/contracts';
import type { LSPFileContext, DiagnosticSnapshot, DiagnosticDelta } from '@comdr/core/types';
import { createHash } from 'node:crypto';

export function createMockLSPBridge(
  fileContexts: Map<string, LSPFileContext>,
): ILSPBridge {
  return {
    async getFileContext(filePath: string): Promise<LSPFileContext | null> {
      return fileContexts.get(filePath) ?? null;
    },

    async snapshotDiagnostics(filePath: string): Promise<DiagnosticSnapshot> {
      const ctx = fileContexts.get(filePath);
      return {
        file: filePath,
        hash: createHash('sha256').update('mock').digest('hex').slice(0, 16),
        diagnostics: ctx?.diagnostics ?? [],
        timestamp: Date.now(),
      };
    },

    diffDiagnostics(before: DiagnosticSnapshot, after: DiagnosticSnapshot): DiagnosticDelta {
      const key = (d: any) => `L${d.line}:C${d.column}:${d.code ?? ''}:${d.message}`;
      const bSet = new Set(before.diagnostics.map(key));
      const aSet = new Set(after.diagnostics.map(key));
      return {
        introduced: after.diagnostics.filter(d => !bSet.has(key(d))),
        fixed: before.diagnostics.filter(d => !aSet.has(key(d))),
        unchanged: after.diagnostics.filter(d => bSet.has(key(d))),
      };
    },
  };
}
```

### 7.2 单元测试重点

```
prompt.ts 测试:
  □ setLSPContext([]) → lspContext 为空
  □ setLSPContext([ctx1]) → lspContext 包含 exports/imports/diagnostics
  □ build() → L7 消息包含 <lsp> 块
  □ 多次调用 build() 之间 lspContext 不变 → 前缀缓存友好

reflection.ts 测试:
  □ 纯改善 (修复了 2 个错误，没引入新错误) → accept
  □ 纯恶化 (引入了 3 个新错误) → rollback
  □ 混合 (修复了 2 个，引入了 1 个) → retry
  □ 无变化 → accept
  □ 空快照 → accept

world-model.ts 测试:
  □ extractKeyFiles([{key:'file:src/a.ts'}, {key:'file:src/b.ts'}]) → ['src/a.ts', 'src/b.ts']
  □ extractKeyFiles([{key:'tool:bash'}]) → []
```

---

## 八、不要做的事情

- ❌ 不要修改主循环的 9 步结构（LSP 是增强，不是重构）
- ❌ 不要触碰 reasoning.ts、context.ts、planner.ts、scheduler.ts
- ❌ 不要让 correctByLSP 调 LLM（它是确定性方法）
- ❌ 不要让 LSP 查询阻塞主循环超过 1 秒（用 await 但不用轮询）
- ❌ 不要在 CLI 模式下强制要求 LSP Bridge（静默降级，不影响终端使用）
- ❌ 不要修改 Static Zone 的结构（LSP 上下文放动态区 L7）
