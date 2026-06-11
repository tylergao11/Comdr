// ============================================================
// KV Cache 命中率测试 — 同规则两批次
//
// 用法: COMDR_DEBUG=llm DEEPSEEK_API_KEY=sk-xxx npx tsx test-cache.ts
// ============================================================

import { DialecticVerifier } from './src/dialectic/verifier.js';
import { DeepSeekClient } from '@comdr/llm';
import { THINKING_TYPE } from '@comdr/core';
import { StandaloneToolExecutor } from './src/tools/executor.js';
import type { Finding } from './src/finding.js';

const ROOT = process.cwd();

function makeFinding(file: string, line: number, snippet: string): Finding {
  return {
    id: `test-${line}`,
    severity: 'high',
    category: 'security',
    title: 'SQL Injection',
    description: 'User input concatenated into SQL query without parameterization.',
    file,
    line,
    snippet,
    rule: 'security/sql-injection',
    suggestion: 'Use parameterized queries.',
    confidence: 0.72,
    source: 'static',
  };
}

const findings = [
  makeFinding('packages/audit/src/pipeline.ts', 100, 'db.query("SELECT * FROM users WHERE id = " + userId)'),
  makeFinding('packages/audit/src/index.ts', 80, 'connection.execute("DELETE FROM logs WHERE ts < " + cutoff)'),
];

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('Set DEEPSEEK_API_KEY');
    process.exit(1);
  }

  const llm = new DeepSeekClient({
    apiKey,
    model: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com',
    maxTokens: 2000,
    thinking: { type: THINKING_TYPE.DISABLED },
  });
  const tools = new StandaloneToolExecutor(ROOT);
  const verifier = new DialecticVerifier({ maxFindingsPerBatch: 2 }, llm, tools);

  console.log('=== Batch 1 (expect cache MISS) ===');
  const r1 = await verifier.verifyBatch(findings);
  console.log(`  findings: ${r1.length}`);
  console.log(`  verdict: ${r1[0]?.verdict} (${r1[0]?.reasoning?.slice(0, 80)})`);
  console.log(`  tokens: ${r1[0]?.tokenUsage?.total}`);

  console.log('\n=== Batch 2 — same rule (expect cache HIT on system prompt) ===');
  const findings2 = [
    makeFinding('packages/audit/src/dialectic/verifier.ts', 200, 'pool.query("INSERT INTO t VALUES (" + val + ")")'),
  ];
  const r2 = await verifier.verifyBatch(findings2);
  console.log(`  findings: ${r2.length}`);
  console.log(`  verdict: ${r2[0]?.verdict}`);
  console.log(`  tokens: ${r2[0]?.tokenUsage?.total}`);

  console.log('\n=== Check DEBUG output above for cache hit/miss lines ===');
}

main().catch(console.error);
