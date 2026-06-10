/**
 * vscode-api.ts — acquireVsCodeApi 单例
 *
 * VS Code 规定每个 webview 会话只能调用一次 acquireVsCodeApi()。
 * 此模块保证全局唯一调用。
 */

declare function acquireVsCodeApi(): {
  postMessage(msg: Record<string, unknown>): void;
  getState(): unknown;
  setState(state: unknown): void;
};

export const vscodeApi = acquireVsCodeApi();
