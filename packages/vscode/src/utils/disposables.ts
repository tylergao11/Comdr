/**
 * disposables.ts — VS Code Disposable 聚合管理
 *
 * 提供类型安全的 Disposable 注册和批量清理，
 * 避免 extension.ts 中逐条手动 dispose。
 */

import type { Disposable } from 'vscode';

/**
 * Disposable 集合——自动追踪并批量释放
 */
export class DisposableStore {
  private readonly disposables: Disposable[] = [];

  add<T extends Disposable>(disposable: T): T {
    this.disposables.push(disposable);
    return disposable;
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        // 忽略单个资源的释放错误，继续清理其余资源
      }
    }
    this.disposables.length = 0;
  }
}

/**
 * 创建一次性使用的 Disposable
 */
export function toDisposable(dispose: () => void): Disposable {
  return { dispose };
}
