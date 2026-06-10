/**
 * shadow-workspace.ts — Shadow Workspace 编排层
 *
 * 职责:
 *   1. 封装 IShadowWorkspace 的操作
 *   2. 实现 Agent 写入 → LSP 验证 → 修复 → 合并 的完整闭环
 *   3. LSP 断路器: 同一文件最多 3 轮自动修复
 */

import type { IShadowWorkspace } from '@comdr/core/contracts';
import type { LSPDiagnostic } from '@comdr/core/types';

export interface ApplyAndValidateResult {
  /** 验证通过则已合并到用户窗口 */
  accepted: boolean;
  /** 最终诊断列表（合并后） */
  diagnostics: LSPDiagnostic[];
  /** 实际自动修复次数 */
  fixAttempts: number;
}

export class ShadowWorkspaceOrchestrator {
  private windowId: string | null = null;

  constructor(
    private readonly shadowWS: IShadowWorkspace,
    private readonly projectPath: string,
  ) {}

  /**
   * 确保隐藏窗口存在
   */
  private ensureWindow(): string {
    if (!this.windowId) {
      this.windowId = this.shadowWS.create(this.projectPath);
    }
    return this.windowId;
  }

  /**
   * ★ 核心闭环: 应用 Agent 的修改 → LSP 验证（单次）。
   *
   * 注意: 此函数为"一次原子操作"——应用 → 等待 LSP → 读取诊断 → 返回。
   * 修正重试不由本函数管理，由调用方（Engine reflection.ts）负责:
   *   1. 调用 applyAndValidate() 获得诊断
   *   2. 有错误 → 构造修复 prompt → 调 LLM → 获得新 content
   *   3. 再次调用 applyAndValidate() 验证修复
   *   4. 最多重复 3 次（断路器）
   * 这种设计避免了"谁负责修复"的责任边界模糊，保证只在本函数内做合法性检查，
   * 而不做语义修复（那是 LLM 的工作）。
   *
   * ★ 合并策略: 无论是否有错误，错误的诊断都会返回。
   *   accepted=true  → 无错误，已合并到用户窗口
   *   accepted=false → 有 error 级别诊断，已合并但附带错误列表让用户感知
   *
   * @returns { accepted, diagnostics, fixAttempts }
   */
  async applyAndValidate(
    filePath: string,
    content: string,
  ): Promise<ApplyAndValidateResult> {
    const windowId = this.ensureWindow();

    // 应用修改
    this.shadowWS.applyEdit(windowId, filePath, content);
    await this.waitForLSP();
    const diags = this.shadowWS.getDiagnostics(windowId, filePath);
    const errors = diags.filter(d => d.severity === 'error');

    // ★ 无论是否有错误，都合并到用户窗口。
    //   有错误时 diagnostics 携带错误列表，调用方（Engine）据此决定下一步。
    this.shadowWS.mergeToUser(windowId, filePath);

    if (errors.length === 0) {
      return { accepted: true, diagnostics: diags, fixAttempts: 0 };
    }

    return { accepted: false, diagnostics: diags, fixAttempts: 0 };
  }

  /**
   * 直接合并到用户窗口（跳过验证）
   */
  mergeToUser(filePath: string): void {
    const windowId = this.ensureWindow();
    this.shadowWS.mergeToUser(windowId, filePath);
  }

  /**
   * 获取隐藏窗口中文件的 LSP 诊断
   */
  getDiagnostics(filePath: string): LSPDiagnostic[] {
    const windowId = this.ensureWindow();
    return this.shadowWS.getDiagnostics(windowId, filePath);
  }

  /**
   * 等待 LSP 分析完成（轮询模式，最多 3 秒，指数退避）。
   *
   * ★ 800ms 固定超时在大型文件上不够（LSP 可能还在解析），
   *   在小型文件上又过多。改为 polling + 指数退避:
   *     50ms → 100ms → 200ms → 400ms → 800ms → 1600ms (总 3.15s)
   *   更好的方案: Patch 2 监听 LSP 完成事件。
   */
  async waitForLSP(): Promise<void> {
    const maxAttempts = 6;
    const initialDelay = 50;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, initialDelay * Math.pow(2, i)));
      // Phase 2: 在此检查 LSP 是否完成（通过检查 pending 诊断）
    }
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.windowId) {
      this.shadowWS.dispose(this.windowId);
      this.windowId = null;
    }
  }
}
