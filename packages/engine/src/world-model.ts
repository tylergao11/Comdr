/**
 * world-model.ts — COMDR.md 多源自动发现 + 分块检索
 *
 * 合并三个来源的 COMDR.md 内容，注入到每轮 prompt 的 L1 System Prompt 之后。
 *
 * 来源优先级（后面的追加到前面之后，不覆盖）:
 *   1. ~/.comdr/COMDR.md            — 用户全局编码偏好
 *   2. ~/.comdr/world-models/*.md   — 外部 Agent 安装的世界模型（Cocos、Comdr-Art 等）
 *   3. {projectPath}/COMDR.md       — 项目专属指令
 *
 * ★ 分块检索 (2026-06):
 *   大 world model（>WORLD_MODEL_CHUNK_MIN_CHARS 字符）按 ## 标题分块，
 *   用 BM25 + Contextual Prefix 检索相关 chunk 注入 prompt。
 *   小文件全量注入（避免过度工程化）。
 *
 * world-models/ 目录由各 Comdr Agent 安装时写入。
 * 例如 Comdr-Engine 安装后写入 cocos.md，Comdr-Art 写入 comdr-art.md。
 *
 * 注入位置: prompt.ts 中 L1 System Prompt 之后，L1.x <world_model_context>。
 * 同会话不变 → DeepSeek 前缀缓存友好。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SYSTEM } from '@comdr/core';
import type { ILSPBridge } from '@comdr/core/contracts';
import type { LSPFileContext } from '@comdr/core/types';
import {
  tokenize,
  BM25Scorer,
  contextualPrefix,
} from './retrieval.js';

// ============================================================================
// §1 类型
// ============================================================================

/**
 * World Model 的一个分块。
 */
export interface WorldModelChunk {
  /** 来源文件名（如 "cocos.md"） */
  source: string;
  /** 章节标题（如 "Component Lifecycle"），根级内容为空串 */
  heading: string;
  /** 分块正文 */
  content: string;
  /** 带 Contextual Prefix 的检索文本（用于 BM25 索引） */
  retrievalText: string;
}

/**
 * discoverAndRetrieve 的返回结果。
 */
export interface WorldModelResult {
  /** 合并后的完整 COMDR.md 文本（向后兼容，注入 L1 <project_instructions>） */
  fullText: string;
  /** 检索出的相关 chunk（注入 L1.x <world_model_context>） */
  relevantChunks: WorldModelChunk[];
  /** 是否执行了分块检索（false = 文件太小，全量注入） */
  didChunk: boolean;
}

// ============================================================================
// §2 分块
// ============================================================================

/**
 * 按 Markdown 标题拆分文本为 chunk。
 *
 * 分割点: # 或 ## 开头的行。
 * 每个 chunk 包含其标题行 + 标题后的正文内容。
 * 标题行本身保留在 content 中（作为上下文的一部分）。
 */
function chunkByHeadings(text: string, source: string): WorldModelChunk[] {
  const lines = text.split('\n');
  const chunks: WorldModelChunk[] = [];
  let currentHeading = '';
  let currentLines: string[] = [];
  let isFirstChunk = true;

  function flush() {
    const content = currentLines.join('\n').trim();
    if (!content) return;

    const retrievalText = contextualPrefix(content, {
      source,
      heading: currentHeading || undefined,
    });

    chunks.push({
      source,
      heading: currentHeading,
      content,
      retrievalText,
    });

    currentLines = [];
  }

  for (const line of lines) {
    // 检测标题行（# 或 ## 开头，后面跟空格）
    const headingMatch = line.match(/^#{1,2}\s+(.+)/);
    if (headingMatch) {
      // 第一个标题前的根级内容单独成一个 chunk
      if (isFirstChunk && currentLines.length > 0) {
        flush();
      }
      flush(); // 上一个 chunk 结束
      currentHeading = headingMatch[1]!.trim();
      currentLines.push(line);
      isFirstChunk = false;
    } else {
      currentLines.push(line);
    }
  }

  // 最后一个 chunk
  flush();

  return chunks;
}

// ============================================================================
// §3 检索
// ============================================================================

/**
 * 创建 World Model 检索器。
 *
 * 用 BM25 + Contextual Prefix 建索引。
 * 若 chunk 数 ≤ 1 或总字符数 < 阈值 → 返回空（调用方应全量注入）。
 */
function createWorldModelRetriever(chunks: WorldModelChunk[]): {
  retrieve: (input: string, topK: number) => WorldModelChunk[];
  totalChars: number;
} {
  const totalChars = chunks.reduce((sum, c) => sum + c.content.length, 0);

  const bm25 = new BM25Scorer();
  const docTokens: Map<string, number>[] = [];

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.retrievalText);
    bm25.addDocument(tokens);
    docTokens.push(tokens);
  }

  return {
    totalChars,
    retrieve(input: string, topK: number): WorldModelChunk[] {
      if (chunks.length === 0) return [];
      if (chunks.length === 1) return [chunks[0]!];

      const queryTokens = tokenize(input);

      const scored = chunks
        .map((chunk, i) => ({
          chunk,
          score: bm25.score(queryTokens, docTokens[i]!),
        }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      return scored.map((s) => s.chunk);
    },
  };
}

// ============================================================================
// §4 发现 + 检索（对外接口）
// ============================================================================

/**
 * 多源发现并合并 COMDR.md 内容。
 *
 * @param projectPath  项目根目录
 * @param comdrMdPath  项目级 COMDR.md 的相对路径（默认 "COMDR.md"）
 * @returns 合并后的完整 COMDR.md 内容。所有来源都不存在时返回空串。
 */
export function discoverComdrMd(
  projectPath: string,
  comdrMdPath: string = 'COMDR.md',
): string {
  const { fullText } = discoverAllSources(projectPath, comdrMdPath);
  return fullText;
}

// ============================================================================
// §4.5 Retriever 缓存（同 projectPath 复用 BM25 索引，避免每轮重建）
// ============================================================================

/** 缓存的 BM25 检索器 + 其关联 chunk 列表 */
let cachedRetriever: {
  projectPath: string;
  chunks: WorldModelChunk[];
  retriever: ReturnType<typeof createWorldModelRetriever>;
} | null = null;

/**
 * 获取或创建 BM25 检索器。
 * 同 projectPath 的 chunk 不变时复用缓存，避免每轮重建 token 索引。
 */
function getOrCreateRetriever(
  chunks: WorldModelChunk[],
  projectPath: string,
): ReturnType<typeof createWorldModelRetriever> {
  if (cachedRetriever && cachedRetriever.projectPath === projectPath) {
    // 检查 chunks 是否相同（引用相等或长度/来源相同——实际场景中不会变）
    if (cachedRetriever.chunks === chunks) {
      return cachedRetriever.retriever;
    }
  }
  const retriever = createWorldModelRetriever(chunks);
  cachedRetriever = { projectPath, chunks, retriever };
  return retriever;
}

/**
 * 多源发现 + 分块检索。
 *
 * 分别从各来源收集 chunk（保留正确的 source 名），
 * 用 BM25 + Contextual Prefix 检索 Top-K 相关 chunk。
 *
 * 若总字符数 < WORLD_MODEL_CHUNK_MIN_CHARS → 不分块，全量注入。
 *
 * @param input         用户输入（作为检索查询）
 * @param projectPath   项目根目录
 * @param comdrMdPath   项目级 COMDR.md 的相对路径
 * @returns             { fullText, relevantChunks, didChunk }
 */
export function discoverAndRetrieve(
  input: string,
  projectPath: string,
  comdrMdPath: string = 'COMDR.md',
): WorldModelResult {
  const { fullText, chunks } = discoverAllSources(projectPath, comdrMdPath);

  if (!fullText || chunks.length === 0) {
    return { fullText: '', relevantChunks: [], didChunk: false };
  }

  // 小文件不分块
  const totalChars = chunks.reduce((sum, c) => sum + c.content.length, 0);
  if (totalChars < SYSTEM.WORLD_MODEL_CHUNK_MIN_CHARS) {
    return { fullText, relevantChunks: [], didChunk: false };
  }

  // 只有 1 个 chunk 也不检索——内容太少，直接全量注入
  // ★ didChunk: false 告诉调用方：relevantChunks 为空不代表无内容
  if (chunks.length <= 1) {
    return { fullText, relevantChunks: [], didChunk: false };
  }

  // 检索（复用缓存，避免每轮重建 BM25 索引）
  const retriever = getOrCreateRetriever(chunks, projectPath);
  const relevantChunks = retriever.retrieve(
    input,
    SYSTEM.WORLD_MODEL_RETRIEVAL_TOPK,
  );

  return { fullText, relevantChunks, didChunk: true };
}

/**
 * ★ 共享的发现逻辑——三个来源的发现和 chunk 化在一个地方定义。
 *
 * discoverComdrMd() 和 discoverAndRetrieve() 都委托给此函数，
 * 确保格式化逻辑只有一份。
 */
function discoverAllSources(
  projectPath: string,
  comdrMdPath: string,
): { fullText: string; chunks: WorldModelChunk[] } {
  const home = homedir();
  const fullTextParts: string[] = [];
  const allChunks: WorldModelChunk[] = [];

  // 1. 全局: ~/.comdr/COMDR.md
  const globalPath = join(home, '.comdr', 'COMDR.md');
  if (existsSync(globalPath)) {
    const content = safeRead(globalPath);
    if (content) {
      fullTextParts.push(content);
      allChunks.push(...chunkByHeadings(content, 'COMDR.md (global)'));
    }
  }

  // 2. World models: ~/.comdr/world-models/*.md
  const worldModelsDir = join(home, '.comdr', 'world-models');
  if (existsSync(worldModelsDir)) {
    try {
      const files = readdirSync(worldModelsDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      for (const file of files) {
        const content = safeRead(join(worldModelsDir, file));
        if (content) {
          const label = file.replace(/\.md$/, '');
          fullTextParts.push(`## ${label}\n\n${content}`);
          // ★ 每个 world model 文件用自己的文件名作为 source
          allChunks.push(...chunkByHeadings(content, file));
        }
      }
    } catch {
      // 目录存在但不可读 → 跳过
    }
  }

  // 3. 项目级: {projectPath}/COMDR.md
  const projectMdPath = join(projectPath, comdrMdPath);
  if (existsSync(projectMdPath)) {
    const content = safeRead(projectMdPath);
    if (content) {
      fullTextParts.push(content);
      allChunks.push(...chunkByHeadings(content, 'COMDR.md'));
    }
  }

  return { fullText: fullTextParts.join('\n\n---\n\n'), chunks: allChunks };
}

// ============================================================================
// §4.5 LSP 语义管道（补充文本 World Model）
// ============================================================================

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
 *   prompt.setLSPContext(text);
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

// ============================================================================
// §5 辅助
// ============================================================================

/**
 * 安全读取文件内容，失败返回 null。
 */
function safeRead(path: string): string | null {
  try {
    const content = readFileSync(path, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}
