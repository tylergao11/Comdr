/**
 * world-model.ts — COMDR.md 多源发现 + 分块检索
 *
 * ★ Trigram 向量检索替代 BM25。零模型、零正则。
 *
 * 来源优先级:
 *   1. ~/.comdr/COMDR.md            — 用户全局偏好
 *   2. ~/.comdr/world-models/*.md   — 外部 Agent 世界模型
 *   3. {projectPath}/COMDR.md       — 项目专属指令
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SYSTEM } from '@comdr/core';
import type { ILSPBridge } from '@comdr/core/contracts';
import type { LSPFileContext } from '@comdr/core/types';
import { textToVector, cosineSimilarity } from './trigram-index.js';

// ============================================================================
// §1 类型
// ============================================================================

export interface WorldModelChunk {
  source: string;
  heading: string | null;
  content: string;
  retrievalText: string;
}

export interface WorldModelResult {
  fullText: string;
  relevantChunks: WorldModelChunk[];
  didChunk: boolean;
}

// ============================================================================
// §2 分块
// ============================================================================

function chunkByHeading(text: string, source: string): WorldModelChunk[] {
  const lines = text.split('\n');
  const chunks: WorldModelChunk[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  function flush(): void {
    const content = currentLines.join('\n').trim();
    if (!content) return;
    const label = currentHeading ? `[${source} ${currentHeading}] ` : `[${source}] `;
    chunks.push({
      source,
      heading: currentHeading,
      content,
      retrievalText: label + content,
    });
  }

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,2}\s+(.+)/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1]!.trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return chunks;
}

// ============================================================================
// §3 检索缓存
// ============================================================================

interface CachedRetriever {
  chunks: WorldModelChunk[];
  vectors: Float32Array[];
  totalChars: number;
}

const retrieverCache = new Map<string, CachedRetriever>();

function getOrCreateRetriever(
  chunks: WorldModelChunk[],
  projectPath: string,
): CachedRetriever {
  const cached = retrieverCache.get(projectPath);
  if (cached && cached.chunks === chunks) return cached;

  const vectors = chunks.map((c) => textToVector(c.retrievalText));
  const totalChars = chunks.reduce((sum, c) => sum + c.content.length, 0);
  const entry: CachedRetriever = { chunks, vectors, totalChars };
  retrieverCache.set(projectPath, entry);
  return entry;
}

function retrieveChunks(
  query: string,
  retriever: CachedRetriever,
  topK: number,
): WorldModelChunk[] {
  const { chunks, vectors } = retriever;
  if (chunks.length === 0) return [];
  if (chunks.length === 1) return [chunks[0]!];

  const queryVec = textToVector(query);

  return chunks
    .map((chunk, i) => ({ chunk, score: cosineSimilarity(queryVec, vectors[i]!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.chunk);
}

// ============================================================================
// §4 发现 + 检索
// ============================================================================

export function discoverAndRetrieve(
  input: string,
  projectPath: string,
  comdrMdPath: string = 'COMDR.md',
): WorldModelResult {
  const { fullText, chunks } = discoverAllSources(projectPath, comdrMdPath);

  if (!fullText || chunks.length === 0) {
    return { fullText: '', relevantChunks: [], didChunk: false };
  }

  const retriever = getOrCreateRetriever(chunks, projectPath);
  if (retriever.totalChars < SYSTEM.WORLD_MODEL_CHUNK_MIN_CHARS) {
    return { fullText, relevantChunks: [], didChunk: false };
  }
  if (chunks.length <= 1) {
    return { fullText, relevantChunks: [], didChunk: false };
  }

  const relevantChunks = retrieveChunks(input, retriever, SYSTEM.WORLD_MODEL_RETRIEVAL_TOPK);
  return { fullText, relevantChunks, didChunk: true };
}

// ============================================================================
// §5 多源发现
// ============================================================================

function discoverAllSources(
  projectPath: string,
  comdrMdPath: string,
): { fullText: string; chunks: WorldModelChunk[] } {
  const sources: Array<{ content: string; label: string }> = [];

  // 1. 全局 ~/.comdr/COMDR.md
  const globalPath = join(homedir(), '.comdr', 'COMDR.md');
  if (existsSync(globalPath)) {
    sources.push({ content: readFileSync(globalPath, 'utf-8'), label: 'COMDR.md (global)' });
  }

  // 2. World Models ~/.comdr/world-models/*.md
  const wmDir = join(homedir(), '.comdr', 'world-models');
  if (existsSync(wmDir)) {
    try {
      for (const f of readdirSync(wmDir)) {
        if (f.endsWith('.md')) {
          const label = f.replace(/\.md$/, '');
          sources.push({ content: readFileSync(join(wmDir, f), 'utf-8'), label });
        }
      }
    } catch { /* 跳过 */ }
  }

  // 3. 项目 COMDR.md
  const projPath = join(projectPath, comdrMdPath);
  if (existsSync(projPath)) {
    sources.push({ content: readFileSync(projPath, 'utf-8'), label: 'COMDR.md (project)' });
  }

  const fullText = sources.map((s) => s.content).join('\n\n---\n\n');
  const chunks: WorldModelChunk[] = [];
  for (const src of sources) {
    chunks.push(...chunkByHeading(src.content, src.label));
  }

  return { fullText, chunks };
}

// ============================================================================
// §6 LSP
// ============================================================================

export async function buildLSPWorldChunks(
  lsp: ILSPBridge,
  filePaths: string[],
): Promise<LSPFileContext[]> {
  const contexts: LSPFileContext[] = [];
  for (const fp of filePaths) {
    try {
      const ctx = await lsp.getFileContext(fp);
      if (ctx) contexts.push(ctx);
    } catch { /* skip */ }
  }
  return contexts;
}

export function extractKeyFiles(
  stateWindow: Array<{ key: string; text: string }>,
): string[] {
  return stateWindow
    .filter((e) => e.key.startsWith('file:'))
    .map((e) => e.key.slice(5));
}

// ============================================================================
// §7 公开入口——同旧 API 兼容
// ============================================================================

export function discoverComdrMd(
  projectPath: string,
  comdrMdPath: string = 'COMDR.md',
): string {
  const { fullText } = discoverAllSources(projectPath, comdrMdPath);
  return fullText;
}
