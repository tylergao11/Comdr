// ============================================================
// AssemblyGateway — 主编排器
// 接收请求 → 调用 Commander → 解析 DSL → 执行命令 → 反馈
//
// State Window（状态窗口）：
//   上下文反馈不追加历史文本，而是维护一个 diff-based 窗口。
//   有变化 → 取最新状态覆盖同 key 条目；没变化 → 不动。最多 5 条。
//   保证 Commander 看到的永远是"当前引擎状态"而不是"历史文本坟墓"。
// ============================================================

import * as path from 'path';
import * as fs from 'fs';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(execCb);
import { AssemblyOptions, AssemblyResult, DslCommand, CmdResult, ExecutedCommand, CompileSpec, NoteEntry, ConsoleLogEntry, ExecutionEvent, ExecutionEventKind } from '../types.js';

// ===== State Window =====

interface StateEntry {
  /** 稳定 key，同 key 新值覆盖旧值 */
  key: string;
  /** 一行紧凑描述 */
  text: string;
}

const STATE_WINDOW_MAX = 5;

import { ToolCenter } from '../tool-center/tool-center.js';
import { CommanderState } from '../memory/session-memory.js';
import { AssetCache } from '../memory/asset-cache.js';
import { DocumentState } from '../memory/document-state.js';
import { SnapshotManager } from '../memory/undo-manager.js';
import { diffPrefab, PrefabDiffResult } from '../perception/prefab-diff.js';
import { resolveAssetValue, resolveAssetValues } from '../perception/asset-resolver.js';
import { callCommander } from './commander.js';
import { parseDslOutput } from '../dsl/parser.js';
import { formatCommandResults, formatChainFailure, buildTurnDelta } from '../dsl/formatter.js';
import { RefResolver } from '../model/cocos-world.js';
import { ComponentCatalog, createRefResolver } from '../model/component-catalog.js';
import { InternalAssetCatalog } from '../model/internal-catalog.js';
import { executeRetrieve } from '../context/retrieve-executor.js';
import { assemble, assembleSubtree } from '../translation/assembler/index.js';
import { generateSystemPrompt } from './prompt.js';
import { ERR_DSL_UNKNOWN_CMD, ERR_ASM_INVALID_SPEC, ERR_SCH_COMPONENT_NOT_FOUND, ERR_VAL_INVALID_ID_REF, ERR_INVALID_ARG, ERR_ASM_NO_COMPILED_JSON, ERR_GW_EXECUTION_ERROR, ERR_GW_UNRESOLVED_TEMPID } from '../errors/error-codes.js';

// ===== 常量 =====

import { GATEWAY_MAX_TURNS, GATEWAY_MAX_CONSECUTIVE_SAME_ERROR, TOKEN_LOG_MAX_BYTES } from '../foundation/constants.js';

const MAX_HISTORY_TURNS = 5;

// ===== 主编排入口 =====

export async function runAssemblyProcess(options: AssemblyOptions): Promise<AssemblyResult> {
  const gateway = new AssemblyGateway(options);
  return gateway.run();
}

export class AssemblyGateway {
  private opts: AssemblyOptions;
  private toolCenter!: ToolCenter;
  private snapshotManager!: SnapshotManager;
  private commanderMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  // compiledStore 只在单轮内有效（compile→write 必须在同一 Commander 输出中）。
  // compile case 写入 compiledStore，write case 读取。跨轮自动清空（compiledStore 每轮重建）。
  private _catalog!: ComponentCatalog;
  private _internalCatalog!: InternalAssetCatalog;
  private resolver!: RefResolver;
  private _diffs: PrefabDiffResult[] = [];
  private _rollbacks: Array<{ path: string; success: boolean; error?: string; consoleLogs?: ConsoleLogEntry[] }> = [];
  private _lastErrorKey = '';
  private _consecutiveSameError = 0;
  /** 跨轮编辑错误计数（不因 probe 成功重置），key = type:errorCode */
  private _editErrorCounts = new Map<string, number>();
  /** 已探测摘要：query → hit count */
  private _probeQueries = new Map<string, number>();
  /** 已知节点：name → fileId */
  private _knownNodes = new Map<string, string>();
  /** 状态窗口（diff-based，最多 5 条）：key → entry，保持插入顺序 */
  private _stateWindow: StateEntry[] = [];
  /** 上次 done() 任务摘要，新 task 启动时注入 session state */
  private _previousTaskSummary: string | null = null;

  constructor(options: AssemblyOptions) {
    this.opts = options;
  }

  async run(): Promise<AssemblyResult> {
    const { opts } = this;
    let round = 0;

    // 执行事件发射器（Gateway → execution-log.jsonl → Overlay）
    let eventSeq = 0;
    const emitEvent = (partial: { kind: ExecutionEventKind; round: number } & Partial<ExecutionEvent>) => {
      if (!opts.onExecutionEvent) return;
      opts.onExecutionEvent({
        schema: 'Comdr.execution-event.v1',
        seq: ++eventSeq,
        timestamp: new Date().toISOString(),
        ...partial,
      } as ExecutionEvent);
    };

    try {
      // 1. 初始化 ToolCenter
      this.toolCenter = new ToolCenter({ projectPath: opts.projectPath });
      const online = await this.toolCenter.start();
      if (!online) {
        return { ok: false, error: 'Bridge not connected. Make sure Cocos Creator is open with the comdr-cocos-bridge extension enabled.', status: 'error', round: 0 };
      }

      // 2. 读取 Bridge 心跳信息
      const bridgeInfo = this.toolCenter.getBridgeInfo();

      // 2a. 检查本地引擎源码 → 自动提取版本精确的 schema
      const engineSource = bridgeInfo?.editorCapabilities?.engineSource as Record<string, unknown> | undefined;
      if (engineSource?.available && typeof engineSource.path === 'string') {
        await tryAutoExtract(opts.projectPath, engineSource.path as string, (engineSource.version as string) || '');
      }

      // 2b. 统一加载组件目录（引擎 schema + 用户脚本 + knowledge）
      this._catalog = new ComponentCatalog();
      const catalogCount = this._catalog.load(opts.projectPath);
      if (catalogCount > 0) {
        process.stderr.write(`[comdr] ComponentCatalog: ${catalogCount} component types loaded\n`);
      }

      // 2c. 加载 internal 资产目录（内置默认图/材质等）
      const internalAssetsBridge = bridgeInfo?.editorCapabilities?.internalAssets as Record<string, { uuid: string; type: string; name: string }> | undefined;
      this._internalCatalog = new InternalAssetCatalog();
      const iaCount = this._internalCatalog.loadFromBridge(internalAssetsBridge, opts.projectPath);
      if (iaCount > 0) {
        const fromBridge = internalAssetsBridge ? Object.keys(internalAssetsBridge).length : 0;
        process.stderr.write(`[comdr] InternalAssetCatalog: ${iaCount} entries (${fromBridge} from bridge, ${iaCount - fromBridge} builtin)\n`);
      }
      this.resolver = createRefResolver(this._catalog);

      // 3. 同步 DocumentState + 状态窗口初始 doc 条目
      if (bridgeInfo?.openDocument) {
        opts.documentState.updateFromHeartbeat({
          openDocument: {
            kind: bridgeInfo.openDocument.kind,
            path: bridgeInfo.openDocument.path,
          },
          hasOpenDocument: bridgeInfo.hasOpenDocument,
        });
        // 初始 doc 条目写入状态窗口
        const docKind = bridgeInfo.openDocument.kind || 'prefab';
        const docPath = bridgeInfo.openDocument.path || '';
        if (docPath) {
          this._stateWindow.unshift({ key: 'doc', text: `${docKind}: ${docPath}` });
        }
      }

      // 5. 初始化 SnapshotManager
      this.snapshotManager = new SnapshotManager();

      // 6. 构造 session state 锚点消息（同一 session 内稳定，作为 cache_control 断点）
      const sessionState = buildSessionState(opts.documentState, this._catalog, this._previousTaskSummary);

      // 7. 构造初始消息列表：system | session锚点 | user request
      const systemPrompt = generateSystemPrompt(this._catalog);
      let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;

      if (opts.commanderSnapshot) {
        // 恢复 Commander 对话 — 复用完整消息历史 + 运行时状态
        const snap = opts.commanderSnapshot;
        messages = snap.messages.map((m) => ({ role: m.role, content: m.content })) as typeof messages;
        // Claude 对 Commander ask 的回答，作为新的 user message 注入
        messages.push({ role: 'user', content: opts.request });

        // 恢复 tempId 映射
        if (snap.tempIdMappings && Object.keys(snap.tempIdMappings).length > 0) {
          opts.sessionMemory.setTempIdMappings(snap.tempIdMappings);
        }
        // 恢复已探测节点
        if (snap.knownNodes) {
          for (const [name, fileId] of Object.entries(snap.knownNodes)) {
            this._knownNodes.set(name, fileId);
          }
        }
        // 恢复探测历史（避免重复探）
        if (snap.probeQueries) {
          for (const [query, count] of Object.entries(snap.probeQueries)) {
            this._probeQueries.set(query, count);
          }
        }
        process.stderr.write(`[comdr] Resumed session: ${snap.messages.length} messages, ${Object.keys(snap.tempIdMappings).length} tempIds, ${this._knownNodes.size} known nodes\n`);
      } else {
        messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: sessionState },
          { role: 'user', content: opts.request },
        ];
      }

      // 8. 主循环
      const allResults: ExecutedCommand[] = [];
      const allNotes: NoteEntry[] = [];

      // Session 累计 token（latest-tokens.json 展示用，不写每轮覆盖）
      let cumPrompt = 0, cumCompletion = 0, cumCacheHit = 0, cumCacheMiss = 0;

      emitEvent({ kind: 'session-start', round: 0, message: opts.request });

      while (true) {
        if (opts.signal?.aborted) {
          emitEvent({ kind: 'session-done', round, status: 'cancelled' });
          return { ok: false, error: 'Cancelled', status: 'cancelled', round, results: allResults, notes: allNotes.length > 0 ? allNotes : undefined };
        }
        if (round >= GATEWAY_MAX_TURNS) {
          emitEvent({ kind: 'session-done', round, status: 'error' });
          return { ok: false, error: `Exceeded max turns (${GATEWAY_MAX_TURNS})`, status: 'error', round, results: allResults, notes: allNotes.length > 0 ? allNotes : undefined };
        }

        round++;
        emitEvent({ kind: 'round-start', round });
        opts.sessionMemory?.nextTurn();

        // 调用 Commander
        let commanderOutput: string;
        try {
          const resp = await callCommander({
            messages,
            provider: opts.provider,
            model: opts.model,
            baseUrl: opts.baseUrl,
            apiKey: opts.apiKey,
            temperature: opts.temperature,
            signal: opts.signal,
          });
          commanderOutput = resp.text;
          // Token 用量日志 → ${projectPath}/temp/token-usage.log
          if (resp.usage) {
            // fs imported at module level
            const logDir = path.join(opts.projectPath, 'temp');
            const logPath = path.join(logDir, 'token-usage.log');
            const cacheInfo = (resp.raw?.usage as Record<string, unknown>) || {};
            const line = JSON.stringify({
              time: new Date().toISOString(),
              round,
              promptTokens: resp.usage.promptTokens,
              completionTokens: resp.usage.completionTokens,
              cacheHit: cacheInfo['prompt_cache_hit_tokens'] ?? cacheInfo['cache_read_input_tokens'] ?? 0,
              cacheMiss: cacheInfo['prompt_cache_miss_tokens'] ?? cacheInfo['cache_creation_input_tokens'] ?? 0,
              rawUsage: cacheInfo,
            });
            try { fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(logPath, line + '\n', 'utf8'); } catch (e) { process.stderr.write(`[comdr] token log write failed: ${(e as Error).message}\n`); }
            // token-usage.log 旋转：每轮检查，超过 500KB 保留最末 1000 行
            try {
              const stat = fs.statSync(logPath);
              if (stat.size > TOKEN_LOG_MAX_BYTES) {
                const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
                if (lines.length > 1000) {
                  fs.writeFileSync(logPath, lines.slice(-1000).join('\n') + '\n', 'utf8');
                }
              }
            } catch { /* rotation best-effort */ }
            // 同时写 latest-tokens.json 供 overlay 仪表台读取（session 累计）
            try {
              const tokenDir = path.join(opts.projectPath, 'temp', 'comdr');
              fs.mkdirSync(tokenDir, { recursive: true });
              const cacheHit: number = (cacheInfo['prompt_cache_hit_tokens'] ?? cacheInfo['cache_read_input_tokens'] ?? 0) as number;
              const cacheMiss: number = (cacheInfo['prompt_cache_miss_tokens'] ?? cacheInfo['cache_creation_input_tokens'] ?? 0) as number;
              cumPrompt += resp.usage.promptTokens;
              cumCompletion += resp.usage.completionTokens;
              cumCacheHit += cacheHit;
              cumCacheMiss += cacheMiss;
              fs.writeFileSync(path.join(tokenDir, 'latest-tokens.json'), JSON.stringify({
                promptTokens: cumPrompt,
                completionTokens: cumCompletion,
                cacheHitTokens: cumCacheHit,
                cacheMissTokens: cumCacheMiss,
                round,
              }), 'utf8');
            } catch { /* best-effort */ }
          }
        } catch (err) {
          emitEvent({ kind: 'session-error', round, error: `Commander error: ${(err as Error).message}` });
          return {
            ok: false,
            error: `Commander error: ${(err as Error).message}`,
            status: 'error',
            round,
            results: allResults,
            notes: allNotes.length > 0 ? allNotes : undefined,
          };
        }

        // 解析 DSL
        const parsed = parseDslOutput(commanderOutput);
        if (parsed.rawNotes && parsed.rawNotes.length > 0) {
          allNotes.push(...parsed.rawNotes);
        }

        if (parsed.commands.length === 0 && !parsed.done) {
          const warnPart = parsed.warnings && parsed.warnings.length > 0
            ? `\n# Warnings (commands ignored): ${parsed.warnings.join('; ')}`
            : '';
          messages.push({ role: 'assistant', content: commanderOutput || '(empty)' });
          messages.push({ role: 'user', content: `[no commands parsed — output >done() if finished]${warnPart}` });
          continue;
        }

        // 执行命令
        const roundResults: ExecutedCommand[] = [];
        let chainBroken = false;

        // compile→write 共享编译结果，放循环外避免每次重建。每轮重置为 null。
        const compiledStore: { json: unknown; spec: CompileSpec | null } = { json: null, spec: null };
        for (let i = 0; i < parsed.commands.length; i++) {
          const cmd = parsed.commands[i];
          const deps = {
            toolCenter: this.toolCenter,
            sessionMemory: opts.sessionMemory,
            assetCache: opts.assetCache,
            documentState: opts.documentState,
            undoManager: this.snapshotManager,
            resolver: this.resolver,
            compiledStore,
            projectPath: opts.projectPath,
            catalog: this._catalog,
            internalCatalog: this._internalCatalog,
          };

          // 破坏性操作前捕获 before 快照（以资源路径为 key，幂等）
          await this._captureBeforeIfNeeded(cmd);

          const t0 = Date.now();
          let result: CmdResult;
          try {
            result = await executeCommand(cmd, deps, opts.signal);
          } catch (err) {
            result = {
              ok: false,
              error: `Unexpected error: ${(err as Error).message}`,
              errorCode: ERR_GW_EXECUTION_ERROR,
              fatal: true,
            };
          }
          const elapsedMs = Date.now() - t0;

          roundResults.push({ command: cmd, result });
          allResults.push({ command: cmd, result });
          emitEvent({
            kind: 'command-executed',
            round,
            index: i,
            command: enrichCommand(cmd),
            result: { ok: result.ok, type: result.type, error: result.error, errorCode: result.errorCode },
            elapsedMs,
          });

          // Commander 发出 ask → 立即中断循环，将问题传给调用方（Claude）
          // 捕获完整对话快照，供下一轮 MCP 调用恢复
          if (result.ok && result.type === 'ask') {
            // 本轮剩余命令不再执行，ask 之后的内容无效
            roundResults.push({ command: cmd, result });
            allResults.push({ command: cmd, result });
            // 把含 ask 的 Commander 输出也推入 messages，下次恢复时有完整上下文
            messages.push({ role: 'assistant', content: commanderOutput });
            // 裁剪历史后再快照 — 避免每轮重发全量 token（trim 保留最近 MAX_HISTORY_TURNS 轮 + 摘要）
            this._trimHistory(messages);
            const snapshot = {
              messages: messages.map((m) => ({ role: m.role, content: m.content })),
              tempIdMappings: opts.sessionMemory.getTempIdMappings(),
              knownNodes: Object.fromEntries(this._knownNodes),
              probeQueries: Object.fromEntries(this._probeQueries),
              turn: round,
            };
            emitEvent({ kind: 'session-done', round, status: 'ask', ask: (result.data as Record<string, unknown>)?.question as string || '' });
            return {
              ok: true, status: 'ask', round, results: allResults,
              ask: { question: (result.data as Record<string, unknown>)?.question as string || '' },
              commanderSnapshot: snapshot,
            };
          }

          if (!result.ok) {
            // 跨轮编辑错误计数（不因 probe 成功重置），熔断上限内允许重试
            const errKey = `${cmd.type}:${result.errorCode || 'unknown'}`;
            const isEditError = ['set-prop', 'set-props', 'delete-node', 'reparent', 'add-comp', 'add-node'].includes(cmd.type);
            if (isEditError) {
              const prev = this._editErrorCounts.get(errKey) || 0;
              this._editErrorCounts.set(errKey, prev + 1);
            }
            // 连续相同错误检测 — 立即连续重复才触发
            if (errKey === this._lastErrorKey) {
              this._consecutiveSameError++;
            } else {
              this._lastErrorKey = errKey;
              this._consecutiveSameError = 1;
            }

            // 链断裂：回滚受影响的资源
            await this._rollbackAffectedResource(cmd);

            let feedback = formatChainFailure(
              roundResults.slice(0, -1),
              cmd,
              result,
              parsed.commands.slice(i + 1)
            );

            // 注入回滚时拉到的 Cocos 控制台日志，让 Commander 看到根因
            if (this._rollbacks.length > 0) {
              const lastRb = this._rollbacks[this._rollbacks.length - 1];
              if (lastRb.consoleLogs && lastRb.consoleLogs.length > 0) {
                const errors = lastRb.consoleLogs.filter(l => l.level === 'error');
                const warns = lastRb.consoleLogs.filter(l => l.level === 'warn');
                const parts: string[] = ['\n# Cocos Console (operation window):'];
                if (errors.length > 0) {
                  parts.push(`## Errors (${errors.length}):`);
                  for (const e of errors) parts.push(`  [error] ${e.message}`);
                }
                if (warns.length > 0) {
                  const wSuffix = warns.length > 5 ? ` — 共${warns.length}条，展示前5。全量: >probe(console)` : '';
                  parts.push(`## Warnings (${warns.length})${wSuffix}:`);
                  for (const w of warns.slice(0, 5)) parts.push(`  [warn] ${w.message}`);
                }
                if (!errors.length && !warns.length) {
                  const all = lastRb.consoleLogs;
                  const shown = all.slice(0, 5);
                  const note = all.length > 5 ? ` — 共${all.length}条，本次展示前5。全量查询: >probe(console)` : '';
                  parts.push(`## Console Logs${note}:`);
                  for (const o of shown) parts.push(`  [${o.level}] ${o.message}`);
                }
                feedback += '\n' + parts.join('\n');
              }
            }

            messages.push({ role: 'assistant', content: commanderOutput });
            messages.push({ role: 'user', content: feedback });

            // 熔断：连续同一错误 ≥ 上限，或跨轮累计同一编辑错误 ≥ 上限×2
            const cumulativeEditErrors = this._editErrorCounts.get(errKey) || 0;
            if (this._consecutiveSameError >= GATEWAY_MAX_CONSECUTIVE_SAME_ERROR || cumulativeEditErrors >= GATEWAY_MAX_CONSECUTIVE_SAME_ERROR * 2) {
              const reason = cumulativeEditErrors >= GATEWAY_MAX_CONSECUTIVE_SAME_ERROR * 2
                ? `Stuck: "${errKey}" occurred ${cumulativeEditErrors} times across rounds`
                : `Stuck: "${errKey}" x${this._consecutiveSameError} consecutive`;
              emitEvent({ kind: 'session-error', round, error: reason });
              return {
                ok: false,
                error: `${reason}. Last message: ${result.error || 'unknown'}`,
                status: 'error',
                round,
                results: allResults,
                notes: allNotes.length > 0 ? allNotes : undefined,
                rollbacks: this._rollbacks.length > 0 ? [...this._rollbacks] : undefined,
              };
            }

            chainBroken = true;
            break;
          }
        }

        // Auto-write: compile 成功但没有 write → Gateway 自动补 write，不依赖 LLM 记忆
        if (!chainBroken && compiledStore.json) {
          const hasWrite = roundResults.some((r) => r.command.type === 'write');
          if (!hasWrite) {
            const autoWriteCmd: DslCommand = {
              type: 'write',
              path: compiledStore.spec?.path || '',
            };
            const deps = {
              toolCenter: this.toolCenter,
              sessionMemory: opts.sessionMemory,
              assetCache: opts.assetCache,
              documentState: opts.documentState,
              undoManager: this.snapshotManager,
              resolver: this.resolver,
              compiledStore,
              projectPath: opts.projectPath,
              catalog: this._catalog,
              internalCatalog: this._internalCatalog,
            };
            const wrResult = await executeCommand(autoWriteCmd, deps, opts.signal);
            roundResults.push({ command: autoWriteCmd, result: wrResult });
            allResults.push({ command: autoWriteCmd, result: wrResult });
            emitEvent({
              kind: 'command-executed',
              round,
              index: roundResults.length - 1,
              command: enrichCommand(autoWriteCmd),
              result: { ok: wrResult.ok, type: 'write', error: wrResult.error, errorCode: wrResult.errorCode },
              elapsedMs: 0,
            });
            if (!wrResult.ok) {
              // write 失败 → 回滚 + 报错
              await this._rollbackAffectedResource(autoWriteCmd);
              const feedback = `Auto-write failed: ${wrResult.error || 'unknown'}\nThe compile succeeded but writing to disk failed. Check if the target path is valid.`;
              messages.push({ role: 'assistant', content: commanderOutput });
              messages.push({ role: 'user', content: feedback });
              chainBroken = true;
              const errKey = 'write:auto';
              this._consecutiveSameError = (this._lastErrorKey === errKey) ? this._consecutiveSameError + 1 : 1;
              this._lastErrorKey = errKey;
            }
          }
        }

        // Auto-save: 整个 session 有编辑但没有 save → Gateway 自动补
        if (!chainBroken && parsed.done) {
          const edited = allResults.some((r) => r.command.type === 'set-prop' || r.command.type === 'set-props' || r.command.type === 'add-comp' || r.command.type === 'add-node' || r.command.type === 'delete-node' || r.command.type === 'reparent' || r.command.type === 'duplicate' || r.command.type === 'set-active');
          const saved = allResults.some((r) => r.command.type === 'save');
          if (edited && !saved) {
            const autoSaveCmd: DslCommand = { type: 'save' };
            const svResult = await executeCommand(autoSaveCmd, {
              toolCenter: this.toolCenter, sessionMemory: opts.sessionMemory, assetCache: opts.assetCache,
              documentState: opts.documentState, undoManager: this.snapshotManager,
              resolver: this.resolver, compiledStore, projectPath: opts.projectPath,
              catalog: this._catalog, internalCatalog: this._internalCatalog,
            }, opts.signal);
            roundResults.push({ command: autoSaveCmd, result: svResult });
            allResults.push({ command: autoSaveCmd, result: svResult });
            emitEvent({ kind: 'command-executed', round, index: roundResults.length - 1,
              command: enrichCommand(autoSaveCmd),
              result: { ok: svResult.ok, type: 'save', error: svResult.error, errorCode: svResult.errorCode },
              elapsedMs: 0 });
          }
        }

        // Commander 声明完成且本轮命令全部成功 → 拍 after 快照 + diff + 保存任务摘要
        if (parsed.done && !chainBroken) {
          await this._finalizeSnapshots();
          // 保存 done() 摘要供下个 task 的 session state 注入
          if (parsed.doneReport?.summary) {
            this._previousTaskSummary = String(parsed.doneReport.summary);
          }
          const diffs = this._diffs.length > 0 ? this._diffs : undefined;
          const rollbacks = this._rollbacks.length > 0 ? this._rollbacks : undefined;
          emitEvent({ kind: 'session-done', round, status: 'completed', totalRounds: round, doneReport: parsed.doneReport });
          return { ok: true, status: 'completed', round, results: allResults, notes: allNotes.length > 0 ? allNotes : undefined, doneReport: parsed.doneReport, diffs: diffs ? diffs.map(d => ({ ...d })) as unknown as PrefabDiffResult[] : undefined, rollbacks };
        }

        // 如果本轮有 retrieve，将编译上下文注入为 user message，跳过常规反馈
        const retrieveResult = roundResults.find((r) => r.command.type === 'retrieve');
        if (retrieveResult?.result.ok && retrieveResult.result.data) {
          const ctxData = retrieveResult.result.data as { context?: string };
          const contextText = ctxData.context || '';
          if (contextText) {
            messages.push({ role: 'assistant', content: commanderOutput });
            messages.push({ role: 'user', content: contextText });
            this._trimHistory(messages);
            continue;
          }
        }

        // 无论成功失败，反馈给 Commander，让其决定下一步
        // 无论成功失败，反馈给 Commander，让其决定下一步
        if (!chainBroken) {
          // 本轮成功，重置连续错误计数（但保留跨轮编辑错误计数）
          this._lastErrorKey = '';
          this._consecutiveSameError = 0;

          // 更新累积状态：记录已探测的查询和已知节点
          this._updateCumulativeState(roundResults);

          const stateCtx = buildTurnDelta(opts.sessionMemory);
          const stateWindow = this._buildStateWindow();
          const warnPart = parsed.warnings && parsed.warnings.length > 0
            ? '\n# Warnings: ' + parsed.warnings.join('; ') + '\n'
            : '';
          const feedback = '# Results:\n' + formatCommandResults(roundResults, this._catalog) + warnPart + stateWindow + stateCtx;
          messages.push({ role: 'assistant', content: commanderOutput });
          messages.push({ role: 'user', content: feedback });
        }

        this._trimHistory(messages);
      }

    } catch (err) {
      emitEvent({ kind: 'session-error', round: round || 0, error: `Gateway error: ${(err as Error).message}` });
      return {
        ok: false,
        error: `Gateway error: ${(err as Error).message}`,
        status: 'error',
        round,
      };
    }
  }

  // ===== 快照生命周期 =====

  /** 破坏性操作前捕获 before 快照（以资源路径为 key，幂等）。
   *  只对编辑类命令生效——compile+write 创建新资产，无需回滚。 */
  private async _captureBeforeIfNeeded(cmd: DslCommand): Promise<void> {
    // 仅编辑命令需要快照
    const editTypes = ['set-prop', 'set-props', 'delete-node', 'reparent', 'duplicate', 'set-active', 'save', 'add-comp', 'add-node'];
    if (!editTypes.includes(cmd.type)) return;

    const targetPath = this._resolveCommandPath(cmd);
    if (!targetPath) return;

    // 已有快照则跳过（幂等）
    if (this.snapshotManager.hasBefore(targetPath)) return;

    try {
      const result = await this.toolCenter.submit({
        type: 'probe',
        payload: { probeType: 'serialize' },
      }, this.opts.signal);
      if (result.ok && result.data) {
        const data = result.data as Record<string, unknown>;
        // result.data 是 bridge 的包装 { ok: true, data: [...] }
        const innerData = data.data as unknown[];
        if (innerData && Array.isArray(innerData)) {
          const json = JSON.stringify(innerData);
          const kind = targetPath.endsWith('.scene') ? 'scene' : 'prefab';
          this.snapshotManager.captureBefore(targetPath, kind, json);
        }
      }
    } catch (e) {
      process.stderr.write(`[comdr] snapshot capture failed: ${(e as Error).message}\n`);
    }
  }

  /** done() 成功后：拍 after 快照 → diff */
  private async _finalizeSnapshots(): Promise<void> {
    const touched = this.snapshotManager.touchedPaths();
    for (const path of touched) {
      try {
        const result = await this.toolCenter.submit({
          type: 'probe',
          payload: { probeType: 'serialize' },
        }, this.opts.signal);
        if (result.ok && result.data) {
          const data = result.data as Record<string, unknown>;
          const innerData = data.data as unknown[];
          if (innerData && Array.isArray(innerData)) {
            const json = JSON.stringify(innerData);
            this.snapshotManager.captureAfter(path, json);
          }
        }
      } catch (e) {
        process.stderr.write(`[comdr] after-snapshot failed: ${(e as Error).message}\n`);
      }
    }

    // 对有 before+after 的资源做 diff
    const entries = this.snapshotManager.getAllEntries();
    for (const entry of entries) {
      if (entry.after && Array.isArray(entry.after)) {
        const diff = diffPrefab(entry.path, entry.before, entry.after);
        if (!diff.empty) {
          this._diffs.push(diff);
        }
      }
    }

    this.snapshotManager.clearAll();
  }

  /** 命令失败时回滚受影响的资源 */
  private async _rollbackAffectedResource(cmd: DslCommand): Promise<void> {
    const targetPath = this._resolveCommandPath(cmd);
    if (!targetPath) return;

    const snapshot = this.snapshotManager.peekBefore(targetPath);
    if (!snapshot) return;

    // 消耗快照
    const consumed = this.snapshotManager.consumeSnapshot(targetPath);
    const capturedAt = consumed?.capturedAt || 0;

    // 拉取操作时间窗口内的 console 错误+警告
    const consoleLogs = await this._pullConsoleLogs(capturedAt, 'warn');

    try {
      const writeResult = await this.toolCenter.submit({
        type: 'write',
        payload: { path: targetPath, json: snapshot.before },
      }, this.opts.signal);

      if (writeResult.ok) {
        this._rollbacks.push({ path: targetPath, success: true, consoleLogs });
      } else {
        this._rollbacks.push({
          path: targetPath,
          success: false,
          error: writeResult.error || 'Rollback write failed',
          consoleLogs,
        });
        // 写入失败：放回快照以允许重试
        this.snapshotManager.restoreSnapshot({
          path: targetPath,
          kind: snapshot.kind as 'prefab' | 'scene',
          before: snapshot.before,
          after: null,
          capturedAt: Date.now(),
        });
      }
    } catch (e) {
      this._rollbacks.push({
        path: targetPath,
        success: false,
        error: (e as Error).message,
        consoleLogs,
      });
    }
  }

  /** 拉取指定时间窗口内的 console 日志 */
  private async _pullConsoleLogs(
    since: number,
    level: string
  ): Promise<Array<{ level: string; message: string; timestamp: number }>> {
    try {
      const result = await this.toolCenter.submit({
        type: 'probe',
        payload: { probeType: 'console', level, since },
      }, this.opts.signal);
      if (result.ok && result.data) {
        const data = result.data as Record<string, unknown>;
        // bridge 返回: { ok: true, entries: [...], ... } 或直接是数组
        const entries = (data.entries || data) as Array<{
          level: string; message: string; timestamp: number;
        }>;
        if (Array.isArray(entries)) return entries;
      }
    } catch (e) {
      process.stderr.write(`[comdr] console pull failed: ${(e as Error).message}\n`);
    }
    return [];
  }

  /** 从命令中解析出目标资源路径 */
  private _resolveCommandPath(cmd: DslCommand): string {
    // 有显式 path 的命令：write, compile, open
    if (cmd.path || cmd.assetPath || cmd.dbUrl) {
      return cmd.path || cmd.assetPath || cmd.dbUrl || '';
    }
    // 编辑命令：从当前文档获取路径
    const editTypes = ['set-prop', 'set-props', 'delete-node', 'reparent', 'duplicate', 'set-active', 'save', 'add-comp', 'add-node'];
    if (editTypes.includes(cmd.type)) {
      const doc = this.opts.documentState?.getCurrent();
      if (doc && doc.kind !== 'none') {
        return doc.path || doc.dbUrl || '';
      }
    }
    return '';
  }

  /** 从本轮结果更新累积状态（已探测查询 + 已知节点）+ 状态窗口 */
  private _updateCumulativeState(roundResults: ExecutedCommand[]): void {
    for (const { command, result } of roundResults) {
      if (!result.ok) continue;
      // 记录 probe 查询
      if (command.type === 'probe') {
        const probeKind = command.probeType || '';
        const queryKey = command.name || command.path || command.query || command.pattern || '';
        if (queryKey) {
          this._probeQueries.set(`${probeKind}:${queryKey}`, (this._probeQueries.get(`${probeKind}:${queryKey}`) || 0) + 1);
        }
        // 从 find-in-doc 结果提取已知节点
        if (probeKind === 'find-in-doc' && result.data) {
          const data = result.data as Record<string, unknown>;
          const matches = data.matches as Array<Record<string, unknown>> | undefined;
          if (matches) {
            for (const m of matches) {
              const name = m.name as string;
              const fileId = m.fileId as string;
              if (name && fileId) this._knownNodes.set(name, fileId);
            }
          }
        }
      }
    }
    // 从本轮结果更新状态窗口
    this._updateStateWindow(roundResults);
  }

  /** 从本轮命令结果构建状态窗口条目（diff-based，同 key 覆盖，最多 5 条） */
  private _updateStateWindow(roundResults: ExecutedCommand[]): void {
    for (const { command, result } of roundResults) {
      const entries = this._extractStateEntries(command, result);
      for (const entry of entries) {
        this._upsertStateEntry(entry);
      }
    }
  }

  /** 从单条命令结果提取状态条目（可能 0-多条）。
   *  条目仅做身份标记，组件详情见 # Results: 中的 probe 结果。 */
  private _extractStateEntries(cmd: DslCommand, result: CmdResult): StateEntry[] {
    const entries: StateEntry[] = [];

    switch (cmd.type) {
      case 'open': {
        if (result.ok && result.data) {
          const d = result.data as Record<string, unknown>;
          const kind = d.kind || 'prefab';
          const name = d.name || cmd.assetPath || cmd.path || '';
          entries.push({ key: 'doc', text: `${kind}: ${name}` });
        }
        break;
      }
      case 'probe': {
        const kind = cmd.probeType || '';
        if (kind === 'find-in-doc' && result.ok && result.data) {
          const data = result.data as Record<string, unknown>;
          const matches = data.matches as Array<Record<string, unknown>> | undefined;
          if (matches) {
            for (const m of matches) {
              const name = (m.name as string) || '';
              const fileId = (m.fileId as string) || '';
              const idSuffix = fileId ? `(#${fileId})` : '';
              entries.push({ key: `node:${name || fileId}`, text: `${name}${idSuffix}` });
            }
          }
        }
        break;
      }
      case 'set-prop':
      case 'set-props': {
        if (result.ok) {
          const fileId = (cmd.nodeUuid || cmd.node || cmd.fileId || cmd.tempId || '') as string;
          const name = this._lookupNodeName(fileId);
          const label = name || fileId;
          if (!label) break; // 空目标不追踪
          const idSuffix = name ? `(#${fileId})` : '';
          const changed = cmd.type === 'set-props'
            ? ' [props]'
            : ` [${cmd.property}]`;
          entries.push({ key: `node:${label}`, text: `${label}${idSuffix}${changed}` });
        }
        break;
      }
      case 'add-comp': {
        if (result.ok) {
          const fileId = (cmd.nodeUuid || cmd.node || cmd.fileId || cmd.tempId || '') as string;
          const compType = (cmd.component || cmd.compType || '') as string;
          const name = this._lookupNodeName(fileId);
          const label = name || fileId;
          if (!label) break;
          const idSuffix = name ? `(#${fileId})` : '';
          entries.push({ key: `node:${label}`, text: `${label}${idSuffix} [+${compType}]` });
        }
        break;
      }
      case 'add-node': {
        if (result.ok) {
          const name = (cmd.name as string) || '';
          const compType = (cmd.component as string) || '';
          const tempId = (cmd.tempId as string) || '';
          entries.push({ key: `node:${name || tempId}`, text: `${name}(@${tempId}): ${compType}` });
        }
        break;
      }
      case 'delete-node': {
        if (result.ok) {
          const fileId = (cmd.nodeUuid || cmd.node || cmd.fileId || cmd.tempId || '') as string;
          const name = this._lookupNodeName(fileId);
          const label = name || fileId;
          if (!label) break;
          // 移除对应的 node: 条目 + 可能有 stale del: 条目
          this._removeStateEntry(`node:${label}`);
          if (name && name !== label) this._removeStateEntry(`node:${name}`);
          entries.push({ key: `del:${label}`, text: `deleted: ${label}` });
        }
        break;
      }
      case 'compile': {
        if (result.ok && result.data) {
          const specPath = cmd.spec?.path || cmd.path || '';
          const stats = (result.data as Record<string, unknown>).stats as Record<string, number> | undefined;
          const nodeCount = stats?.nodes ?? cmd.spec?.nodes?.length ?? 0;
          entries.push({ key: `asset:${specPath}`, text: `prefab: ${specPath} (${nodeCount} nodes, compiled)` });
        }
        break;
      }
      case 'write': {
        if (result.ok) {
          const wp = cmd.path || cmd.dbUrl || '';
          entries.push({ key: `asset:${wp}`, text: `written: ${wp}` });
        }
        break;
      }
      case 'save': {
        // save 不产生独立状态条目——只是标记所有变更已持久化
        break;
      }
    }

    return entries;
  }

  /** 插入或覆盖状态条目（同 key 覆盖，保持插入顺序，超出上限移除最旧）。
   *  新 node:* 条目自动清理同名的 del:* 条目（重建场景）。 */
  private _upsertStateEntry(entry: StateEntry): void {
    const idx = this._stateWindow.findIndex((e) => e.key === entry.key);
    if (idx >= 0) {
      // 覆盖：删旧值，新值插到最前面
      this._stateWindow.splice(idx, 1);
    }
    // 若新增的是 node:* 条目，清理对应的 del:* 条目（重建场景）
    if (entry.key.startsWith('node:')) {
      const nodeName = entry.key.slice(5); // 去掉 "node:" 前缀
      const delIdx = this._stateWindow.findIndex((e) => e.key === `del:${nodeName}`);
      if (delIdx >= 0) this._stateWindow.splice(delIdx, 1);
    }
    this._stateWindow.unshift(entry);
    // 超上限移除最旧的
    while (this._stateWindow.length > STATE_WINDOW_MAX) {
      this._stateWindow.pop();
    }
  }

  /** 移除指定 key 的状态条目 */
  private _removeStateEntry(key: string): void {
    const idx = this._stateWindow.findIndex((e) => e.key === key);
    if (idx >= 0) this._stateWindow.splice(idx, 1);
  }

  /** 根据 fileId 在 _knownNodes 里反向查找节点名 */
  private _lookupNodeName(fileId: string): string {
    for (const [name, id] of this._knownNodes) {
      if (id === fileId) return name;
    }
    return '';
  }

  /** 构建状态窗口摘要文本，替代旧的累积摘要 */
  private _buildStateWindow(): string {
    if (this._stateWindow.length === 0) return '';

    const lines: string[] = ['# State:'];
    for (const entry of this._stateWindow) {
      lines.push(`  ${entry.text}`);
    }

    // 附上紧凑的错误提示（如有）
    if (this._editErrorCounts.size > 0) {
      const errs = [...this._editErrorCounts.entries()]
        .map(([k, v]) => `${k}(x${v})`)
        .join(' ');
      lines.push(`# ! ${errs} — do NOT retry`);
    }

    return '\n' + lines.join('\n') + '\n';
  }

  /** 裁剪对话历史，保持最多 MAX_HISTORY_TURNS 个来回，注入状态摘要。
   *  messages[0] = system, messages[1] = session锚点 — 不裁剪，永久保留。 */
  private _trimHistory(
    messages: Array<{ role: string; content: string }>
  ): void {
    // 跳过 system + 第一条 user (context)
    if (messages.length < 3) return;
    const body = messages.slice(2);

    if (body.length <= MAX_HISTORY_TURNS * 2) return;

    // 保留最近 N 个来回
    const keep = body.slice(-MAX_HISTORY_TURNS * 2);
    const trimmed = body.length - keep.length;

    // 构建状态摘要
    const parts: string[] = [`# Earlier turns summarized: ${Math.ceil(trimmed / 2)} turns omitted.`];

    const tempIds = this.opts.sessionMemory?.getTempIdMappings();
    if (tempIds && Object.keys(tempIds).length > 0) {
      const all = Object.entries(tempIds);
      const shown = all.slice(0, 20).map(([k, v]) => `${k}→${v}`).join(', ');
      const note = all.length > 20 ? ` — 共${all.length}个，本次展示前20。引用任意@tempId即可使用` : ` — 共${all.length}个`;
      parts.push(`# Active tempId mappings: ${shown}${note}`);
    }

    const doc = this.opts.documentState?.getCurrent();
    if (doc && doc.kind !== 'none') {
      parts.push(`# Current document: ${doc.kind}=${doc.name || doc.path || ''}`);
    }
    parts.push(`# project=${this.opts.projectPath}`);

    // 状态窗口（若不为空则附带，避免压缩后丢失引擎状态）
    const sw = this._buildStateWindow();
    if (sw) parts.push(sw.trim());

    const summary = parts.join('\n');

    messages.splice(2, messages.length - 2); // 删除旧 body
    // 将摘要注入到保留的第一条消息中，避免连续同角色消息
    if (keep.length > 0) {
      keep[0] = { ...keep[0], content: summary + '\n\n' + keep[0].content };
    } else {
      messages.push({ role: 'user', content: summary });
    }
    messages.push(...keep);
  }
}

// ===== 命令执行器 =====

interface CommandDeps {
  toolCenter: ToolCenter;
  sessionMemory: CommanderState;
  assetCache: AssetCache;
  documentState: DocumentState;
  undoManager: SnapshotManager;
  resolver: RefResolver;
  compiledStore: { json: unknown; spec: CompileSpec | null };
  projectPath: string;
  catalog: ComponentCatalog;
  internalCatalog: InternalAssetCatalog;
}

// ===== Session State 锚点消息（缓存锚，同一 task 内不变） =====

/** 构造 session state 锚点消息。
 *  同一 task 内稳定不变，作为 cache_control 断点锁定缓存前缀。
 *  内容仅含：当前文档引用 + 脚本列表 + 上次任务摘要。不包含文档树快照。 */
function buildSessionState(documentState: DocumentState, catalog: ComponentCatalog, previousTaskSummary?: string | null): string {
  const lines: string[] = [];
  lines.push('[session]');

  const doc = documentState.getCurrent();
  if (doc && doc.kind !== 'none') {
    lines.push(`doc: ${doc.path || doc.dbUrl} (${doc.kind})`);
  } else {
    lines.push('doc: none');
  }

  const scripts = catalog.listScripts();
  if (scripts.length > 0) {
    const names = scripts.slice(0, 30).map((s) => s.identity.name);
    const suffix = scripts.length > 30 ? ` (+${scripts.length - 30} more)` : '';
    lines.push(`scripts (${scripts.length}): ${names.join(', ')}${suffix}`);
  }

  if (previousTaskSummary) {
    lines.push(`prev: ${previousTaskSummary}`);
  }

  return lines.join(' | ');
}

// ===== 本地组件名修正（Gateway 本地执行，不进 LLM） =====

interface ResolveResult {
  resolved: string;
  corrected: boolean;
  from: string;
  /** 多个候选时列出所有匹配项，供 Commander 选择。非空时表示歧义，不应静默修正。 */
  ambiguous?: string[];
}

/** 组件名逐级解析：精确 → 模糊 → 失败。
 *  模糊匹配到多项时返回 ambiguous 列表，Gateway 反馈给 Commander 选择，不静默修正。 */
function resolveComponentLocally(rawType: string, catalog: ComponentCatalog): ResolveResult | null {
  if (!rawType) return null;

  // Level 1: 精确匹配
  const exact = catalog.resolve(rawType);
  if (exact && catalog.get(exact)) {
    if (exact !== rawType) {
      return { resolved: exact, corrected: true, from: rawType };
    }
    return { resolved: exact, corrected: false, from: rawType };
  }

  // Level 2: 模糊匹配 — 返回全部候选，不允许静默多选一
  const matches = catalog.fuzzyFindAll(rawType);
  if (matches.length === 0) return null;

  if (matches.length === 1) {
    return { resolved: matches[0], corrected: true, from: rawType };
  }

  // 多项匹配 → 将 list 交给 Commander，不做修正
  return { resolved: rawType, corrected: false, from: rawType, ambiguous: matches };
}

async function executeCommand(cmd: DslCommand, deps: CommandDeps, signal?: AbortSignal): Promise<CmdResult> {
  const { toolCenter, sessionMemory, assetCache, documentState, undoManager, resolver, projectPath } = deps;

  switch (cmd.type) {
    // ===== 检索（唯一上下文获取方式） =====
    case 'retrieve': {
      return executeRetrieve(cmd, {
        catalog: deps.catalog,
        internalCatalog: deps.internalCatalog,
        assetCache: deps.assetCache,
        documentState: deps.documentState,
        resolver: deps.resolver,
        projectPath: deps.projectPath,
        toolCenter: { submit: (task: Record<string, unknown>, sig?: AbortSignal) => toolCenter.submit(task as unknown as Parameters<typeof toolCenter.submit>[0], sig) },
        signal,
      });
    }

    // ===== 旧查询（已废弃，parser 不再生成，保留以兼容旧类型） =====
    case 'probe': {
      // spread all DSL fields → Bridge payload，不再逐字段手写
      const cmdObj = cmd as Record<string, unknown>;
      const payload: Record<string, unknown> = { probeType: cmd.probeType || 'assets' };
      for (const key of Object.keys(cmdObj)) {
        if (key === 'type' || key === 'probeType') continue;
        payload[key] = cmdObj[key];
      }
      const probeResult = await toolCenter.submit({ type: 'probe', payload }, signal);
      // probe(scripts) 成功后 reload catalog — 新脚本可被立即发现
      if (probeResult.ok && (payload.probeType === 'scripts' || payload.path === 'scripts')) {
        try {
          const count = deps.catalog.load(projectPath);
          if (count > 0) {
            process.stderr.write(`[comdr] catalog reloaded after probe(scripts): ${count} types\n`);
          }
        } catch (e) {
          process.stderr.write(`[comdr] catalog reload failed: ${(e as Error).message}\n`);
        }
      }
      return probeResult;
    }

    case 'detail': {
      return toolCenter.submit({type: 'probe',
        payload: { probeType: 'node-detail', nodeUuid: cmd.nodeUuid || cmd.node },
      }, signal);
    }

    case 'schema': {
      const rawType = (cmd.component || 'cc.Node') as string;
      const correction = resolveComponentLocally(rawType, deps.catalog);
      if (!correction) {
        return { ok: false, error: `Component not found: ${rawType}`, errorCode: ERR_SCH_COMPONENT_NOT_FOUND };
      }
      if (correction.ambiguous && correction.ambiguous.length > 0) {
        return {
          ok: false,
          error: `Ambiguous: "${rawType}" matches multiple components: ${correction.ambiguous.join(', ')}. Please specify the exact type.`,
          errorCode: ERR_SCH_COMPONENT_NOT_FOUND,
        };
      }
      const compType = correction.resolved;
      const entry = deps.catalog.get(compType)!;
      const props: Record<string, { type: string }> = {};
      for (const f of entry.schema) props[f.name] = { type: f.type };
      const result: CmdResult = {
        ok: true, type: 'schema',
        data: {
          component: compType,
          properties: props,
          isScript: entry.identity.isScript || undefined,
        },
      };
      if (correction.corrected) {
        result.autoCorrected = { from: correction.from, to: correction.resolved };
      }
      return result;
    }

    case 'open': {
      const assetPath = cmd.assetPath || cmd.path;
      if (!assetPath) {
        return { ok: false, error: 'Missing path', errorCode: ERR_INVALID_ARG };
      }
      const result = await toolCenter.submit({type: 'open',
        payload: { path: assetPath },
      }, signal);
      if (result.ok) {
        const docData = (result.data as Record<string, unknown>) || {};
        const rawKind = docData.kind as string | undefined;
        if (!rawKind || (rawKind !== 'prefab' && rawKind !== 'scene')) {
          return { ok: false, error: `Invalid document kind: "${rawKind}". Expected "prefab" or "scene".`, errorCode: 'GW_INVALID_DOC_KIND' };
        }
        const kind = rawKind;
        const dbUrl = (docData.dbUrl || docData.path || assetPath) as string;
        if (kind === 'prefab') {
          documentState.openPrefab(dbUrl, docData.assetUuid as string, docData.rootNodeUuid as string, docData.name as string);
        } else {
          documentState.openScene(dbUrl, docData.assetUuid as string, docData.rootNodeUuid as string, docData.name as string);
        }
      }
      return result;
    }

    // ===== 编译 =====
    case 'compile': {
      if (!cmd.spec || !cmd.spec.nodes || cmd.spec.nodes.length === 0) {
        return { ok: false, error: 'Compile has no nodes. Add at least one: >node(R1, name=X).', errorCode: ERR_ASM_INVALID_SPEC };
      }

      // 资产路径自动解析：组件属性中的 assets/xxx 路径 → UUID（含子资产 @f9941 等后缀）
      // 浅拷贝 spec 避免 mutate 原始输入（retry 时 spec 状态不变）
      const specForResolve: CompileSpec = {
        ...cmd.spec,
        nodes: cmd.spec.nodes.map((n) => ({
          ...n,
          components: n.components.map((c) => ({ ...c, props: { ...c.props } })),
        })),
      };
      await resolveAssetSpec(specForResolve, toolCenter, projectPath, signal, deps.catalog);
      // 用拷贝后的 spec 继续组装
      cmd.spec = specForResolve;

      // 嵌套 prefab 路径 → UUID 解析
      for (const node of cmd.spec.nodes) {
        if (node.prefab && !node.prefabUuid) {
          try {
            // fs imported at module level
            const metaPath = path.join(projectPath, node.prefab + '.meta');
            if (fs.existsSync(metaPath)) {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
              if (meta.uuid) node.prefabUuid = meta.uuid as string;
            }
          } catch (e) {
            process.stderr.write(`[comdr] prefab .meta read failed for ${node.prefab}: ${(e as Error).message}\n`);
          }
        }
      }

      // 组件名本地修正：遍历所有 comp type，精确→模糊，不浪费 LLM 轮次
      const compCorrections: Array<{ from: string; to: string }> = [];
      for (const node of cmd.spec.nodes) {
        for (const comp of node.components) {
          const correction = resolveComponentLocally(comp.type, deps.catalog);
          if (correction?.ambiguous && correction.ambiguous.length > 0) {
            return {
              ok: false,
              error: `Ambiguous: "${comp.type}" matches multiple: ${correction.ambiguous.join(', ')}. Pick one.`,
              errorCode: 'ASM_UNKNOWN_COMPONENT',
            };
          }
          if (correction?.corrected) {
            compCorrections.push({ from: correction.from, to: correction.resolved });
            comp.type = correction.resolved;
          } else if (!correction) {
            return {
              ok: false,
              error: `Unknown component type: "${comp.type}". Use >schema() to verify available types.`,
              errorCode: 'ASM_UNKNOWN_COMPONENT',
            };
          }
        }
      }

      // 使用新组装管线：enrich + build + serialize + clean（纯函数，无线程状态）
      const assemblyResult = assemble(cmd.spec, deps.catalog, resolver, (assetPath: string) => {
        try {

          const fullPath = path.join(projectPath, assetPath);
          if (!fs.existsSync(fullPath)) return null;
          const content = fs.readFileSync(fullPath, 'utf8').replace(/^﻿/, '');
          return JSON.parse(content) as Record<string, unknown>[];
        } catch {
          return null;
        }
      }, deps.internalCatalog);
      if (!assemblyResult.ok) {
        return {
          ok: false,
          error: assemblyResult.error,
          errorCode: assemblyResult.errorCode,
        };
      }

      // 存入编译缓存（供 write 步骤读取）
      deps.compiledStore.json = assemblyResult.json;
      deps.compiledStore.spec = cmd.spec;

      const compileResult: CmdResult = {
        ok: true,
        type: 'compile',
        data: {
          stats: assemblyResult.stats,
          path: cmd.spec.path,
        },
      };
      if (compCorrections.length > 0) {
        compileResult.autoCorrected = compCorrections[0];
        if (compCorrections.length > 1) {
          compileResult.notes = [{ kind: 'warn', text: `${compCorrections.length} type corrections: ${compCorrections.map((c) => `${c.from}→${c.to}`).join(', ')}` }];
        }
      }
      // 收集被丢弃的属性名（模板中不存在的 key），告知 Commander
      const allDropped: string[] = [];
      if (Array.isArray(assemblyResult.json)) {
        for (const obj of assemblyResult.json) {
          const dropped = (obj as Record<string, unknown>)._comdr_dropped as string[] | undefined;
          if (dropped) allDropped.push(...dropped);
        }
      }
      if (allDropped.length > 0) {
        compileResult.notes = [{ kind: 'warn', text: `Unknown property(s) ignored: ${[...new Set(allDropped)].join(', ')}` }];
      }
      return compileResult;
    }

    // ===== 写入 =====
    case 'write': {
      let compiledJson = deps.compiledStore.json;
      if (!compiledJson) {
        return { ok: false, error: 'No compiled JSON found. Did you forget >compile() before >write()? The compile step generates the prefab structure that write needs.', errorCode: ERR_ASM_NO_COMPILED_JSON };
      }

      const writePath = cmd.path || cmd.dbUrl || deps.compiledStore.spec?.path || '';
      // compile→write 以显式路径为目标：路径匹配当前文档 或 文件已存在 → 覆盖
      // 文档状态丢失时（重连等）回退到文件系统检查，避免创建 _1 _2 等副本
      const currentDoc = documentState.getCurrent();
      const docMatch = (currentDoc?.path === writePath || currentDoc?.dbUrl === writePath);
      const fsExists = writePath ? (() => { try { return fs.existsSync(path.join(projectPath, writePath)); } catch { return false; } })() : false;
      const overwrite = docMatch || fsExists;

      const result = await toolCenter.submit({type: 'write',
        payload: { path: writePath, json: compiledJson, overwrite },
      }, signal);

      if (result.ok) {
        sessionMemory.setTempIdMappings(
          (result.data as Record<string, string>) || {}
        );
        undoManager.clearSnapshot(writePath);
      }

      return result;
    }

    // ===== 编辑 =====
    case 'set-prop':
    case 'set-props': {
      const editType = cmd.editType || cmd.type;
      // 解析 @tempId 为真实 UUID
      const { resolved: resolvedCmd, unresolved } = resolveCommandRefs(cmd, sessionMemory);
      if (unresolved.length > 0) {
        return {
          ok: false,
          error: `Unresolved tempId reference(s): ${unresolved.map((id) => '@' + id).join(', ')}. Use @tempId to reference nodes created earlier in this session (e.g. @R1).`,
          errorCode: ERR_GW_UNRESOLVED_TEMPID,
        };
      }

      // 组件名本地修正（精确 → 模糊），不进 LLM
      const rawCompType = (resolvedCmd.component || resolvedCmd.compType || '') as string;
      let compType = '';
      let compAutoCorrected = false;
      let compFrom = '';
      if (rawCompType) {
        const correction = resolveComponentLocally(rawCompType, deps.catalog);
        if (correction?.ambiguous && correction.ambiguous.length > 0) {
          return {
            ok: false,
            error: `Ambiguous: "${rawCompType}" matches multiple: ${correction.ambiguous.join(', ')}. Pick one.`,
            errorCode: 'ASM_UNKNOWN_COMPONENT',
          };
        }
        if (correction) {
          compType = correction.resolved;
          compAutoCorrected = correction.corrected;
          compFrom = correction.from;
        } else {
          compType = rawCompType;
        }
      }
      // 解析后的标准化类型回写到命令，确保 Bridge 收到正确值
      if (compType) {
        resolvedCmd.component = compType;
        (resolvedCmd as Record<string, unknown>)['compType'] = compType;
      }
      if (compType && editType === 'set-prop' && resolvedCmd.property) {
        try {
          const assetResult = await resolveAssetValue(
            compType, resolvedCmd.property as string, resolvedCmd.value, toolCenter, signal, null, projectPath, deps.catalog,
          );
          resolvedCmd.value = assetResult.resolved;
        } catch (e) {
          return { ok: false, error: (e as Error).message, errorCode: 'ASM_ASSET_RESOLVE_FAILED' };
        }
      } else if (compType && editType === 'set-props') {
        const props = (resolvedCmd.props || resolvedCmd.values || {}) as Record<string, unknown>;
        if (props && Object.keys(props).length > 0) {
          try {
            const { props: resolvedProps } = await resolveAssetValues(compType, props, toolCenter, signal, null, projectPath, deps.catalog);
            resolvedCmd.props = resolvedProps;
          } catch (e) {
            return { ok: false, error: (e as Error).message, errorCode: 'ASM_ASSET_RESOLVE_FAILED' };
          }
        }
      }

      const gwPayload: Record<string, unknown> = {
        editType,
        node: resolvedCmd.node || resolvedCmd.nodeUuid || resolvedCmd.fileId || resolvedCmd.tempId || resolvedCmd['0'],
        component: resolvedCmd.component || resolvedCmd.compType,
        property: resolvedCmd.property,
        value: resolvedCmd.value,
        props: resolvedCmd.props || resolvedCmd.values,
        parent: resolvedCmd.parent,
        name: resolvedCmd.name,
        active: resolvedCmd.active,
      };

      // DIAG: dump Gateway→Bridge payload（排查 set-props 传输问题）
      if (editType === 'set-props' || editType === 'set-prop') {
        try {
          const diagDir = path.join(projectPath, 'temp', 'comdr');
          fs.mkdirSync(diagDir, { recursive: true });
          fs.writeFileSync(path.join(diagDir, 'gw-setprops-diag.json'), JSON.stringify({
            rawCompType: rawCompType || '',
            resolvedCompType: compType,
            compAutoCorrected,
            rawProps: (resolvedCmd.props || resolvedCmd.values || resolvedCmd['0']),
            resolvedProps: resolvedCmd.props || resolvedCmd.values,
            rawNode: cmd.node || cmd.nodeUuid || cmd.fileId || cmd.tempId || '',
            resolvedNode: gwPayload.node,
            fullPayload: gwPayload,
          }, null, 2), 'utf8');
        } catch (_) { /* best-effort */ }
      }

      const editResult = await toolCenter.submit({type: 'edit',
        payload: gwPayload,
      });
      if (compAutoCorrected) {
        (editResult as CmdResult).autoCorrected = { from: compFrom, to: compType };
      }
      return editResult;
    }
    case 'add-node': {
      if (!(cmd as Record<string, unknown>).component) {
        return { ok: false, error: 'add-node requires a component type. Use >schema(component=cc.Type) to find valid types, then write e.g. add-node(..., component=cc.Sprite).', errorCode: ERR_INVALID_ARG };
      }
      const addCorrection = resolveComponentLocally(cmd.component as string, deps.catalog);
      if (addCorrection?.ambiguous && addCorrection.ambiguous.length > 0) {
        return { ok: false, error: `Ambiguous: "${cmd.component}" matches multiple: ${addCorrection.ambiguous.join(', ')}. Pick one.`, errorCode: 'ASM_UNKNOWN_COMPONENT' };
      }
      const addNodeComp = (addCorrection?.resolved || cmd.component) as string;
      // 从 add-node 参数构建 CompileSpec，经 assembleSubtree 生成可附加的子树
      const addNodeProps = extractComponentProps(cmd);
      const addTempId = (cmd.tempId as string) || '_add';
      const addNodeSpec: CompileSpec = {
        nodes: [{
          tempId: addTempId,
          name: (cmd.name as string) || 'Node',
          parent: null,
          components: [{ type: addNodeComp, props: addNodeProps }],
        }],
      };
      const subtreeResult = assembleSubtree(addNodeSpec, deps.catalog, deps.resolver, deps.internalCatalog);
      const addNodeResult = await toolCenter.submit({type: 'edit',
        payload: {
          editType: 'add-node-tree',
          parent: cmd.parent,
          tempId: cmd.tempId || addTempId,
          name: cmd.name,
          component: addNodeComp,
          props: cmd.props || (cmd as Record<string, unknown>),
          subtree: subtreeResult.ok ? subtreeResult.json : undefined,
          idMap: subtreeResult.ok ? (subtreeResult as { idMap?: Record<string, number> }).idMap || {} : {},
        },
      }, signal);
      // 提取 tempId → fileId 映射，写入 sessionMemory 以供后续 set-prop(@R1) 引用
      if (addNodeResult.ok && addNodeResult.data) {
        const mappings = (addNodeResult.data as Record<string, unknown>).mappings as Record<string, string> | undefined;
        if (mappings && Object.keys(mappings).length > 0) {
          sessionMemory.setTempIdMappings(mappings);
        }
      }
      if (addCorrection?.corrected) {
        (addNodeResult as CmdResult).autoCorrected = { from: addCorrection.from, to: addCorrection.resolved };
      }
      return addNodeResult;
    }
    case 'add-comp': {
      if (!(cmd as Record<string, unknown>).component) {
        return { ok: false, error: 'add-comp requires a component type. Use >schema(component=cc.Type) to find valid types, then write e.g. add-comp(..., component=cc.Sprite).', errorCode: ERR_INVALID_ARG };
      }
      const acCorrection = resolveComponentLocally(cmd.component as string, deps.catalog);
      if (acCorrection?.ambiguous && acCorrection.ambiguous.length > 0) {
        return { ok: false, error: `Ambiguous: "${cmd.component}" matches multiple: ${acCorrection.ambiguous.join(', ')}. Pick one.`, errorCode: 'ASM_UNKNOWN_COMPONENT' };
      }
      const addCompType = acCorrection?.resolved || cmd.component;
      // 从 DSL 命令中提取纯组件属性，过滤元数据字段
      const addCompProps = extractComponentProps(cmd);
      const acResult = await toolCenter.submit({type: 'edit',
        payload: {
          editType: 'add-component',
          node: cmd.node || cmd.nodeUuid || cmd.fileId || cmd.tempId || cmd['0'],
          component: addCompType,
          props: addCompProps,
        },
      }, signal);
      if (acCorrection?.corrected) {
        (acResult as CmdResult).autoCorrected = { from: acCorrection.from, to: acCorrection.resolved };
      }
      return acResult;
    }
    case 'delete-node':
    case 'reparent':
    case 'duplicate':
    case 'set-active': {
      const editType = cmd.editType || cmd.type;
      // 解析 @tempId 为真实 UUID
      const { resolved: resolvedCmd, unresolved } = resolveCommandRefs(cmd, sessionMemory);
      if (unresolved.length > 0) {
        return {
          ok: false,
          error: `Unresolved tempId reference(s): ${unresolved.map((id) => '@' + id).join(', ')}. Use @tempId to reference nodes created earlier in this session (e.g. @R1).`,
          errorCode: ERR_GW_UNRESOLVED_TEMPID,
        };
      }
      const rawEditComp = (resolvedCmd.component || resolvedCmd.compType) as string | undefined;
      const editComp = rawEditComp ? deps.catalog.resolve(rawEditComp) : undefined;
      return toolCenter.submit({type: 'edit',
        payload: {
          editType,
          node: resolvedCmd.nodeUuid || resolvedCmd.node || resolvedCmd.tempId,
          component: editComp,
          property: resolvedCmd.property,
          value: resolvedCmd.value,
          props: resolvedCmd.props || resolvedCmd.values,
          parent: resolvedCmd.parent,
          name: resolvedCmd.name,
          active: resolvedCmd.active,
        },
      });
    }

    // ===== 撤销 =====
    // ===== 反问 =====
    case 'ask': {
      return {
        ok: true,
        type: 'ask',
        data: { question: cmd.question || '' },
      };
    }

    // ===== 帮助 =====
    case 'help': {
      const topic = (cmd as Record<string, unknown>).topic as string || (cmd as Record<string, unknown>)[0] as string || '';
      return { ok: true, type: 'help', data: { topic, text: buildHelpText(topic) } };
    }

    case 'undo': {
      // 1. 新多资源快照系统：取当前打开文档路径，查对应快照
      const currentDoc = documentState.getCurrent();
      const docPath = currentDoc?.dbUrl || currentDoc?.path;
      if (docPath) {
        const snapshot = undoManager.consumeSnapshot(docPath);
        if (snapshot) {
          const result = await toolCenter.submit({type: 'write',
            payload: { path: docPath, json: snapshot.before, assetType: snapshot.kind, overwrite: true },
          }, signal);
          if (!result.ok) {
            // 写入失败，恢复快照以允许重试
            undoManager.restoreSnapshot(snapshot);
          }
          return result;
        }
      }
      // 2. 回退到旧单槽位 API（兼容过渡）
      const backup = undoManager.peekBackup();
      if (!backup) {
        return { ok: false, error: 'Nothing to undo. Undo only works after edit commands (set-prop, delete-node, etc.) on an open document.', errorCode: ERR_INVALID_ARG };
      }
      undoManager.getBackup(); // 消耗备份
      const result = await toolCenter.submit({type: 'write',
        payload: { path: backup.filePath, json: backup.json, assetType: backup.assetType, overwrite: true },
      }, signal);
      if (!result.ok) {
        // 写入失败，恢复备份以允许重试
        undoManager.restoreBackup(backup);
      }
      return result;
    }

    // ===== 保存 =====
    case 'save': {
      return toolCenter.submit({type: 'save', payload: {} }, signal);
    }

    default:
      return {
        ok: false,
        error: `Unknown command type: ${cmd.type}`,
        errorCode: ERR_DSL_UNKNOWN_CMD,
      };
  }
}

// ===== help 命令文本 =====

function buildHelpText(topic: string): string {
  switch (topic) {
    case '':
    case 'list':
      return `Available commands — use >help(command) for details:
  probe, detail, open, schema
  compile, write, save, undo
  add-node, add-comp
  set-prop, set-props, delete-node, reparent, duplicate, set-active
  ask, done, help`;

    case 'probe':
      return `probe(kind, ...) — valid kinds and their params:
  project-summary                              no params
  assets           path=dir                    list files in directory
  asset            path=assetPath              resolve one asset
  asset-search     pattern=keyword             fuzzy search files
  find-in-doc      name=nodeName               search nodes in open document
  node-detail      fileId=#id                  full component tree of one node
  document-serialize                           dump open document as JSON
  scripts          path=dir (optional)         list user scripts
  console          level=logLevel, limit=N     read Cocos console
  property         fileId=#id, component=cc.X, property=name   read single property`;

    case 'open':
      return `open(path=assetPath) — open a scene or prefab. Path relative to assets/.
  Example: >open(path=scene/main.scene)`;

    case 'schema':
      return `schema(component=cc.Type) — get component property list.
  Engine components use cc. prefix: cc.Sprite, cc.Button, cc.UITransform.
  Script components use class name without prefix.`;

    case 'compile':
      return `compile block — create new node tree:
  >compile(path=assetPath)
  >node(R1, name=RootName)                     root node (no parent)
  >node(R2, name=ChildName, parent=R1)         child node
  >comp(R1, cc.UITransform, contentSize=(w,h)) add component to node
  >comp(R1, cc.Canvas)                         add component without props
  >write                                       flush compile and write to disk
  Use tempId (R1, R2...) for node refs within the block.`;

    case 'set-prop':
      return `set-prop — modify a property on an existing node:
  Component property (component= REQUIRED):
    >set-prop(#fileId, component=cc.Type, property=name, value=val)
  Node property (omit component=):
    >set-prop(#fileId, property=_name, value=NewName)
    >set-prop(#fileId, property=_active, value=false)
  fileId must be exact value (including #) from >probe results.`;

    case 'set-props':
      return `set-props — set multiple properties at once:
    >set-props(#fileId, component=cc.Type, props={key1:val1, key2:val2})`;

    case 'add-comp':
      return `add-comp(#fileId, component=cc.Type, key=val, ...) — add a component to existing node.
  fileId from probe, component= REQUIRED.`;

    case 'add-node':
      return `add-node(parent=#fileId, component=cc.Type, name=X, ...) — add a new node with one component.`;

    case 'delete-node':
      return `delete-node(#fileId) — remove a node. fileId from probe, verbatim with #.`;

    case 'reparent':
      return `reparent(#fileId, parent=#parentFileId) — move node to new parent.`;

    case 'duplicate':
      return `duplicate(#fileId, name=NewName) — clone a node.`;

    case 'set-active':
      return `set-active(#fileId, active=true|false) — activate or deactivate a node.`;

    case 'save':
      return `save() — save the open document to disk.`;

    case 'undo':
      return `undo() — revert the last edit operation.`;

    case 'ask':
      return `ask(question=...) — ask the user a question. Use when you need clarification.`;

    case 'done':
      return `done(summary=...) — mark task complete. Always include a summary of what was accomplished.`;

    case 'detail':
      return `detail(nodeUuid=...) — get full node detail by UUID.`;

    case 'note':
      return `note(kind, text) — attach a note (guess/warn) to the session.`;

    default:
      return `Unknown help topic: ${topic}. Use >help(list) to see available commands.`;
  }
}

// ===== 辅助函数 =====

/** 如果 Bridge 发现了本地引擎 TS 源码，且版本与内置缓存不同，自动触发提取覆盖 */
async function tryAutoExtract(projectPath: string, engineSourcePath: string, engineVersion: string): Promise<void> {
  const tempDir = path.join(projectPath, 'temp', 'comdr');
  const cachePath = path.join(tempDir, 'component-cache.json');

  // 读取内置缓存版本
  let bundledVersion = '';
  try {
    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      bundledVersion = cache.version || '';
    }
  } catch { /* cache not yet readable */ }

  // 版本相同且缓存存在 → 跳过
  if (engineVersion && bundledVersion === engineVersion) {
    process.stderr.write(`[comdr] Schema cache matches engine ${engineVersion}, skip extraction\n`);
    return;
  }

  process.stderr.write(`[comdr] Engine source (${engineVersion || 'unknown'}), extracting schemas...\n`);

  try {
    // 查找提取脚本（相对于 monorepo 或打包位置）
    const scriptCandidates = [
      path.join(__dirname, '..', '..', '..', '..', 'scripts', 'extract-component-schema.ts'),
      path.join(process.cwd(), 'scripts', 'extract-component-schema.ts'),
    ];
    let scriptPath = scriptCandidates.find((p) => fs.existsSync(p));
    if (!scriptPath) {
      process.stderr.write('[comdr] extract-component-schema.ts not found, skip auto-extraction\n');
      return;
    }

    await execAsync(`npx tsx "${scriptPath}" "${engineSourcePath}" "${cachePath}"`, {
      timeout: 60_000,
    });
    process.stderr.write(`[comdr] Schema extraction complete → ${cachePath}\n`);
  } catch (e) {
    process.stderr.write(`[comdr] Auto-extraction failed: ${(e as Error).message}, using bundled cache\n`);
  }
}

// ===== 资产路径解析 =====

/** 遍历 CompileSpec 中所有组件的 props，自动解析资产路径 → UUID（含子资产 @ 后缀） */
async function resolveAssetSpec(
  spec: CompileSpec,
  toolCenter: ToolCenter,
  projectPath: string,
  signal?: AbortSignal,
  catalog?: ComponentCatalog,
): Promise<void> {
  for (const node of spec.nodes) {
    for (const comp of node.components) {
      if (!comp.props || Object.keys(comp.props).length === 0) continue;
      const { props: resolved } = await resolveAssetValues(
        comp.type, comp.props, toolCenter, signal, null, projectPath, catalog,
      );
      comp.props = resolved;
    }
  }
}

/** 丰富命令信息供 Overlay 展示。字段名与 Overlay JS 的 buildSummary() 对齐。 */
function enrichCommand(cmd: DslCommand): { type: string; [key: string]: unknown } {
  const base: { type: string; [key: string]: unknown } = { type: cmd.type };
  switch (cmd.type) {
    case 'compile':
      if (cmd.spec) {
        base.targetPath = cmd.spec.path || '';
        base.nodeCount = cmd.spec.nodes?.length || 0;
        const comps = new Set<string>();
        cmd.spec.nodes?.forEach((n: { components?: Array<{ type: string }> }) => {
          n.components?.forEach((c: { type: string }) => { if (c.type) comps.add(c.type); });
        });
        if (comps.size > 0) base.components = [...comps];
      }
      break;
    case 'write':
      base.targetPath = cmd.path || '';
      break;
    case 'probe':
      base.probeType = cmd.probeType || '';
      base.probePath = cmd.path || cmd.name || '';
      break;
    case 'open':
      base.filePath = cmd.path || cmd.assetPath || '';
      break;
    case 'schema':
      base.component = cmd.component || '';
      break;
    case 'set-prop':
      base.property = cmd.property || '';
      base.value = cmd.value;
      break;
    case 'set-props':
      base.propCount = cmd.values ? Object.keys(cmd.values as Record<string, unknown>).length : (cmd.props ? Object.keys(cmd.props as Record<string, unknown>).length : 0);
      break;
    case 'delete-node':
      base.target = cmd.nodeUuid || cmd.tempId || '';
      break;
    case 'reparent':
      base.target = cmd.nodeUuid || cmd.tempId || '';
      base.newParent = cmd.parent || '';
      break;
    case 'duplicate':
      base.target = cmd.nodeUuid || cmd.tempId || '';
      break;
    case 'add-comp':
    case 'add-node':
      base.fileId = (cmd.node || cmd.nodeUuid || cmd.fileId || cmd.tempId || cmd['0']) as string || '';
      if (cmd.component) base.component = cmd.component;
      break;
    case 'set-active':
      base.target = cmd.nodeUuid || cmd.tempId || '';
      base.active = cmd.active;
      break;
    case 'detail':
      base.nodeUuid = cmd.nodeUuid || '';
      break;
    case 'ask':
      const q = (cmd.question || '');
      base.question = q.length > 80 ? q.slice(0, 77) + '...' : q;
      break;
  }
  return base;
}

/** 从 DSL 命令中提取纯组件属性，过滤掉命令元数据字段。
 *  Commander 可能用内联 key=value 写 props（如 isAlignTop=true），
 *  而不是包在 props={...} 里。 */
function extractComponentProps(cmd: DslCommand): Record<string, unknown> {
  if (cmd.props && typeof cmd.props === 'object') return cmd.props as Record<string, unknown>;
  const props: Record<string, unknown> = {};
  const metaKeys = new Set([
    'type', 'editType', 'node', 'nodeUuid', 'fileId', 'tempId',
    'component', 'compType', 'property', 'value', 'path',
    'probeType', 'parent', 'name', 'active',
  ]);
  for (const [k, v] of Object.entries(cmd)) {
    if (metaKeys.has(k)) continue;
    if (/^\d+$/.test(k)) continue;
    if (typeof k === 'number') continue;
    props[k] = v;
  }
  return props;
}

/** 解析命令中的 @tempId 引用为真实 UUID */
function resolveCommandRefs(cmd: DslCommand, sessionMemory: CommanderState): { resolved: DslCommand; unresolved: string[] } {
  const resolved = { ...cmd };
  const unresolved: string[] = [];

  function tryResolve(raw: string): string {
    if (!raw.startsWith('@')) return raw;
    const tempId = raw.slice(1);
    const real = sessionMemory.getRealUuid(tempId);
    if (real) return real;
    unresolved.push(tempId);
    return raw; // 保留原值，但记录未解析
  }

  if (resolved.nodeUuid && typeof resolved.nodeUuid === 'string' && resolved.nodeUuid.startsWith('@')) {
    resolved.nodeUuid = tryResolve(resolved.nodeUuid);
  }
  if (typeof (resolved as Record<string, unknown>)['node'] === 'string') {
    const nodeRef = (resolved as Record<string, unknown>)['node'] as string;
    (resolved as Record<string, unknown>)['node'] = tryResolve(nodeRef);
  }
  if (resolved.parent && typeof resolved.parent === 'string' && resolved.parent.startsWith('@')) {
    resolved.parent = tryResolve(resolved.parent);
  }

  return { resolved, unresolved };
}
