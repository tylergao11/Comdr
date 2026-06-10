/**
 * message-codec.ts — Webview ↔ Extension Host 消息编解码
 *
 * 提供安全的序列化/反序列化，确保消息类型在 postMessage 边界不丢失。
 *
 * @design
 *   VS Code Webview 的 postMessage 走结构化克隆算法，
 *   type 字段使用字符串字面量，保证 === 判断在两侧一致。
 */

import type { ExtensionMessage, WebviewMessage } from '../webview/types.js';

/**
 * 编码 Extension → Webview 消息，附带版本标记和序列号
 */
export function encodeMessage(
  msg: ExtensionMessage,
): Record<string, unknown> {
  return {
    ...msg,
    _v: 1,
    _ts: Date.now(),
  };
}

/**
 * 解码 Webview → Extension 消息
 * 验证消息格式，返回 null 表示非法消息
 */
export function decodeMessage(
  raw: unknown,
): WebviewMessage | null {
  if (!raw || typeof raw !== 'object') return null;

  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== 'string') return null;

  // 基础类型检查——type 必须匹配已知消息类型集合
  switch (msg.type) {
    case 'userInput':
      if (typeof msg.text !== 'string') return null;
      return { type: 'userInput', text: msg.text };
    case 'acceptDiff':
      if (typeof msg.filePath !== 'string') return null;
      return { type: 'acceptDiff', filePath: msg.filePath };
    case 'rejectDiff':
      if (typeof msg.filePath !== 'string') return null;
      return { type: 'rejectDiff', filePath: msg.filePath, reason: typeof msg.reason === 'string' ? msg.reason : undefined };
    case 'abortTask':
      return { type: 'abortTask' };
    case 'retryFix':
      if (typeof msg.filePath !== 'string') return null;
      return { type: 'retryFix', filePath: msg.filePath, instruction: typeof msg.instruction === 'string' ? msg.instruction : undefined };
    default:
      return null;
  }
}
