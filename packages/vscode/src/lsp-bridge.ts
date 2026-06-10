/**
 * lsp-bridge.ts — ILSPBridge 实现
 *
 * 为 Engine 提供 LSP 语义信息的统一访问接口。
 *
 * Phase 1: 使用 VS Code Extension API (vscode.languages.*)
 * Phase 3: 直连 LSP 进程（来自 Terminal 1 Patch 2）
 */

import * as vscode from 'vscode';
import { createHash } from 'node:crypto';

import type {
  ILSPBridge,
  IShadowWorkspace,
} from '@comdr/core/contracts';
import {
  LSPConnectionError,
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

export class LSPBridge implements ILSPBridge {
  constructor(private readonly shadowWS?: IShadowWorkspace) {}

  // ─── 私有工具 ─────────────────────────────────────────

  /**
   * 文件内容 → SHA256（前 16 字符）
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
code: typeof d.code === 'string' ? d.code : (typeof d.code === 'object' && d.code !== null && 'value' in d.code ? String((d.code as { value: unknown }).value) : ''),
      source: d.source ?? undefined,
    };
  }

  private mapSeverity(s: vscode.DiagnosticSeverity): LSPDiagnostic['severity'] {
    if (s === vscode.DiagnosticSeverity.Error) return LSP_SEVERITY.ERROR;
    if (s === vscode.DiagnosticSeverity.Warning) return LSP_SEVERITY.WARNING;
    return LSP_SEVERITY.HINT;
  }

  /**
   * vscode.SymbolKind → LSPSymbolInfo.kind 映射
   */
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

  /**
   * 简化版 import 解析——匹配前 200 行中的 import 语句
   */
  private parseImports(doc: vscode.TextDocument): LSPImportInfo[] {
    const imports: LSPImportInfo[] = [];
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

  // ─── ILSPBridge 实现 ───────────────────────────────

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
        'vscode.executeDocumentSymbolProvider',
        uri,
      ),
      this.snapshotDiagnostics(filePath).then(s => s.diagnostics),
    ]);

    const exports: LSPSymbolInfo[] = (symbols ?? []).map(s => ({
      name: s.name,
      kind: this.mapSymbolKind(s.kind),
      signature: '', // Phase 2: 通过 hover provider 获取签名
      line: s.location.range.start.line + 1,
    }));

    const imports = this.parseImports(doc);

    return {
      file: filePath,
      exports,
      imports,
      callers: [],    // Phase 1: 扩展 API 限制，Phase 3 通过 LSP 直连获取
      callees: [],    // Phase 1: 扩展 API 限制
      typeDependencies: [], // Phase 1: 扩展 API 限制
      diagnostics,
    };
  }

  async snapshotDiagnostics(filePath: string): Promise<DiagnosticSnapshot> {
    const uri = vscode.Uri.file(filePath);
    let content = '';
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
      content = doc.getText();
    } catch (err) {
      // ★ 文件无法打开 → 抛 LSPConnectionError 而非返回空快照。
      //   空快照会导致 caller 误以为"文件无诊断"，掩盖 LSP 连接问题。
      throw new LSPConnectionError(
        `Cannot open file for LSP diagnostics: ${filePath}`,
        filePath,
        err instanceof Error ? err : undefined,
      );
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
    // 确定性纯函数——可以写单元测试覆盖
    const key = (d: LSPDiagnostic) =>
      `L${d.line}:C${d.column}:${d.code ?? ''}:${d.message}`;

    const beforeSet = new Set(before.diagnostics.map(key));
    const afterSet = new Set(after.diagnostics.map(key));

    return {
      introduced: after.diagnostics.filter(d => !beforeSet.has(key(d))),
      fixed: before.diagnostics.filter(d => !afterSet.has(key(d))),
      unchanged: after.diagnostics.filter(d => beforeSet.has(key(d))),
    };
  }
}
