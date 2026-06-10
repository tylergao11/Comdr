/**
 * tool-retriever.ts — BM25 工具检索
 *
 * 按用户输入语义匹配相关工具，替代固定 toolPrefixes 过滤。
 * BM25 纯 JS、零依赖，18 个工具足够用。接口预留 dense embedding 升级。
 *
 * ★ 2026-06 升级: TF-IDF → BM25（高频词饱和），统一使用 retrieval.ts 共享模块。
 * ★ 支持增量添加 MCP 工具。
 *
 * @agent Agent 4 — 编排核心
 */

import type { ToolDefinition } from '@comdr/core/types';
import { ALL_TOOLS_SENTINEL, SYSTEM } from '@comdr/core';
import {
  tokenize,
  BM25Scorer,
  contextualPrefix,
} from './retrieval.js';

// ============================================================================
// §1 中文关键词增强
// ============================================================================

/**
 * 中英文关键词映射——补充工具描述中缺少的中文触发词。
 * BM25 靠 token 重叠匹配，中文输入需要中文关键词才能命中。
 */
const TOOL_KEYWORDS: Record<string, string> = {
  file_read: '读文件 读取 查看文件 看代码 read file cat',
  file_write: '写文件 创建文件 新建文件 生成文件 write file create',
  file_edit: '编辑文件 修改文件 改文件 替换 edit modify replace patch',
  file_delete: '删除文件 删文件 delete remove rm',
  file_glob: '查找文件 找文件 搜索文件 匹配文件 glob find pattern',
  file_grep: '搜索内容 搜代码 查找代码 搜索文本 grep search find',
  file_ls: '列出文件 列表 目录 ls list dir',
  shell_bash: '运行命令 执行 跑 shell bash run execute npm pnpm cargo',
  git_diff: '查看变更 差异 diff 改动 change',
  git_status: '查看状态 状态 status git',
  git_log: '查看日志 日志 提交记录 log history commit',
  git_add: '暂存 添加暂存 stage add git',
  git_commit: '提交 commit 提交代码',
  git_revert: '回滚 撤销 revert 恢复',
  lsp_symbols: '符号 定义 symbols lsp 结构',
  lsp_diagnostics: '诊断 错误 警告 diagnostics error warning lsp',
  lsp_structure: '代码结构 大纲 结构 lsp structure outline',
};

// ============================================================================
// §2 ToolRetriever 类
// ============================================================================

export class ToolRetriever {
  /** 已索引的工具名列表 */
  private readonly toolNames: string[] = [];
  /** BM25 评分器——维护 IDF 词表 */
  private readonly bm25 = new BM25Scorer();
  /** toolName → token 化文本 */
  private readonly toolTokens = new Map<string, Map<string, number>>();
  /** 兜底工具名列表 */
  private readonly fallback: string[];

  constructor(tools: ToolDefinition[]) {
    this.indexTools(tools);
    this.fallback = this.buildFallback(tools);
  }

  /**
   * ★ 增量添加工具（MCP 工具连接后调用）。
   */
  addTools(tools: ToolDefinition[]): void {
    this.indexTools(tools);
  }

  /**
   * 对工具列表建索引。
   */
  private indexTools(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      if (this.toolTokens.has(tool.name)) continue; // 已索引，跳过

      // ★ Contextual Prefix + 中文关键词增强
      const keywords = TOOL_KEYWORDS[tool.name] ?? '';
      const retrievalText = contextualPrefix(
        keywords ? `${tool.description} ${keywords}` : tool.description,
        { source: `tool:${tool.name}` },
      );

      // 分词 + 注册到 BM25
      const tokens = tokenize(retrievalText);
      this.bm25.addDocument(tokens);
      this.toolTokens.set(tool.name, tokens);
      this.toolNames.push(tool.name);
    }
  }

  /**
   * 构建兜底工具列表。
   */
  private buildFallback(tools: ToolDefinition[]): string[] {
    const preferred = ['file_read', 'file_grep', 'file_glob', 'shell_bash', 'file_ls'];
    return preferred.filter((n) => tools.some((t) => t.name === n));
  }

  /**
   * 检索 top-K 相关工具。
   *
   * @param input  用户输入
   * @param topK   返回工具数。-1 = 全量
   * @returns      工具名列表，按相关性降序
   */
  retrieve(input: string, topK: number): string[] {
    if (topK === -1) {
      return [...this.toolNames];
    }

    const queryTokens = tokenize(input);

    // 无信息查询 → 兜底
    if (queryTokens.size === 0) {
      return this.fallback.slice(0, topK);
    }

    // ★ BM25 评分排序
    const scores: Array<{ name: string; score: number }> = [];
    for (const [name, docTokens] of this.toolTokens) {
      const score = this.bm25.score(queryTokens, docTokens);
      scores.push({ name, score });
    }

    scores.sort((a, b) => b.score - a.score);

    // 取 top-K，score > TOOL_RETRIEVER_BM25_THRESHOLD 的
    const result: string[] = [];
    for (const s of scores) {
      if (result.length >= topK) break;
      if (s.score > SYSTEM.TOOL_RETRIEVER_BM25_THRESHOLD) {
        // ★ BM25 参数 k1/b 变化影响分数分布，此阈值需同步校准。
        //   BM25Scorer 默认 k1=1.2, b=0.75。
        //   k1 增大 → 高频词 TF 更易饱和 → 文档间分数差异缩小 → 阈值应降低。
        //   b 增大 → 长度归一化更强 → 长文档分数被压低 → 阈值应降低。
        //   当前阈值 0.01 极低，对 18-30 个内置工具池有效；
        //   引入大量 MCP 工具后应重新评估分数分布并调整此值。
        result.push(s.name);
      }
    }

    // 不足 topK 用兜底补
    if (result.length < Math.min(topK, 3)) {
      for (const name of this.fallback) {
        if (!result.includes(name) && result.length < topK) {
          result.push(name);
        }
      }
    }

    return result;
  }
}

// ============================================================================
// §3 工厂
// ============================================================================

/**
 * 从工具定义列表创建检索器
 */
export function createToolRetriever(tools: ToolDefinition[]): ToolRetriever {
  return new ToolRetriever(tools);
}
