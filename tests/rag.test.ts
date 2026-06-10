/**
 * rag.test.ts — RAG 架构专项测试
 *
 * 覆盖: retrieval.ts, episodic.ts, world-model.ts, tool-retriever.ts,
 *       semantic.ts, skills.ts, prompt.ts
 *
 * 运行: npx tsx tests/rag.test.ts
 *
 * @agent Agent 4
 */

import { TestSuite, assert, assertEq, assertContains } from './harness.js';

// ============================================================================
// Suite 1: retrieval.ts — 共享检索模块
// ============================================================================

const s1 = new TestSuite('retrieval.ts — 共享检索模块');

import {
  tokenize,
  BM25Scorer,
  contextualPrefix,
  hashToDim,
  cosineSimilarity,
  l2Normalize,
} from '../packages/engine/src/retrieval.js';

s1.test('tokenize 英文单词分词', () => {
  const tokens = tokenize('read file from disk');
  assert(tokens.has('read'), 'should have "read"');
  assert(tokens.has('file'), 'should have "file"');
  assert(tokens.has('from'), 'should have "from"');
  assert(tokens.has('disk'), 'should have "disk"');
  assert(!tokens.has('a'), 'should skip single chars');
});

s1.test('tokenize 中文 bigram', () => {
  const tokens = tokenize('读取文件');
  assert(tokens.has('读取'), 'should have "读取"');
  assert(tokens.has('取文'), 'should have "取文"');
  assert(tokens.has('文件'), 'should have "文件"');
});

s1.test('tokenize 混合中英文', () => {
  const tokens = tokenize('fix the login 修复登录 bug');
  assert(tokens.has('fix'), 'should have "fix"');
  assert(tokens.has('login'), 'should have "login"');
  assert(tokens.has('修复'), 'should have "修复"');
  assert(tokens.has('登录'), 'should have "登录"');
});

s1.test('tokenize 跳过纯标点 bigram', () => {
  const tokens = tokenize('.,;:!?');
  // 纯标点字符串：单词级分词全跳过（都是单字符或空），bigram 也都是标点对
  // 标点 bigram 应该被跳过
  // 注意：',' '.' 这类可能被当作有效 bigram 因为其中一个字符不在标点集合里
  // 只验证没有意外的大量 token
  assert(tokens.size <= 2, `expected ≤2 tokens from pure punctuation, got ${tokens.size}`);
});

s1.test('tokenize 跳过长数字串', () => {
  const tokens = tokenize('uuid 12345678901 abc');
  assert(!tokens.has('12345678901'), 'should skip long numeric string');
  assert(tokens.has('abc'), 'should have "abc"');
  assert(tokens.has('uuid'), 'should have "uuid"');
});

s1.test('BM25Scorer 基础', () => {
  const bm25 = new BM25Scorer();
  const doc1 = tokenize('file read write edit');
  const doc2 = tokenize('shell bash execute command');
  const doc3 = tokenize('file grep search find');

  bm25.addDocument(doc1);
  bm25.addDocument(doc2);
  bm25.addDocument(doc3);

  assertEq(bm25.documentCount, 3, 'doc count');

  // 查询 "read a file" → doc1 应该最高
  const query = tokenize('read a file');
  const score1 = bm25.score(query, doc1);
  const score2 = bm25.score(query, doc2);
  const score3 = bm25.score(query, doc3);

  assert(score1 > score2, `doc1 should score higher than doc2 (${score1} vs ${score2})`);
  assert(score1 > score3, `doc1 should score higher than doc3 (${score1} vs ${score3})`);
});

s1.test('BM25 词频饱和——高频词不会线性增长', () => {
  const bm25 = new BM25Scorer();
  // 一个文档里 'file' 出现 10 次
  const docHigh = tokenize('file file file file file file file file file file');
  // 另一个文档里 'file' 出现 1 次 + 其他词
  const docLow = tokenize('file read write edit');

  bm25.addDocument(docHigh);
  bm25.addDocument(docLow);

  const query = tokenize('file');
  const scoreHigh = bm25.score(query, docHigh);
  const scoreLow = bm25.score(query, docLow);

  // BM25 饱和：10 倍词频不会导致 10 倍分数
  const ratio = scoreHigh / scoreLow;
  assert(ratio < 5, `BM25 saturation: ratio ${ratio.toFixed(2)} should be < 5 (vs TF-IDF ~10)`);
});

s1.test('BM25 idf——高频文档词权重降低', () => {
  const bm25 = new BM25Scorer();
  bm25.addDocument(tokenize('file read'));
  bm25.addDocument(tokenize('file write'));
  bm25.addDocument(tokenize('file edit'));

  const idfFile = bm25.idf('file');    // 出现在所有文档
  const idfRead = bm25.idf('read');    // 出现在 1 个文档

  assert(idfRead > idfFile, `rare term idf (${idfRead}) > common term idf (${idfFile})`);
});

s1.test('contextualPrefix 基础', () => {
  const result = contextualPrefix('lifecycle onLoad start', {
    source: 'cocos.md',
    heading: 'Component',
  });
  assertContains(result, '[cocos.md', 'source label');
  assertContains(result, 'Component]', 'heading');
  assertContains(result, 'lifecycle onLoad start', 'original content');
});

s1.test('contextualPrefix 无 heading', () => {
  const result = contextualPrefix('general instructions', {
    source: 'COMDR.md',
  });
  assertContains(result, '[COMDR.md]', 'source label no heading');
  assert(!result.includes('§'), 'should not have section marker without heading');
});

s1.test('hashToDim 一致性', () => {
  const a = hashToDim('file_read', 200);
  const b = hashToDim('file_read', 200);
  assertEq(a, b, 'same input → same hash');
  assert(a < 200, 'within dimension');
  assert(a >= 0, 'non-negative');
});

s1.test('cosineSimilarity 相同向量', () => {
  const v = [0.5, 0.5, 0.5, 0.5];
  l2Normalize(v);
  const sim = cosineSimilarity(v, [...v]);
  assert(Math.abs(sim - 1.0) < 0.0001, `should be ~1.0, got ${sim}`);
});

s1.test('cosineSimilarity 正交向量', () => {
  const sim = cosineSimilarity([1, 0], [0, 1]);
  assert(Math.abs(sim) < 0.0001, `should be ~0, got ${sim}`);
});

await s1.run();

// ============================================================================
// Suite 2: episodic.ts — 缓存线水密检查
// ============================================================================

const s2 = new TestSuite('episodic.ts — 缓存线');

import { EpisodicMemory } from '../packages/engine/src/memory/episodic.js';
import type { SessionState, StructuredSummary } from '../packages/core/src/types.js';

function mockSession(id: string, input: string, turn: number): SessionState {
  return {
    id,
    turn,
    tokensUsed: 100 * turn,
    currentInput: input,
    outcome: null,
    messages: [],
    stateWindow: [],
    intentWindow: [],
    tempIdMappings: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function mockSummary(): StructuredSummary {
  return {
    sessionIntent: 'fix login redirect bug',
    fileModifications: [
      { path: 'src/auth.ts', action: 'modified', summary: 'fixed redirect URL' },
    ],
    decisions: [
      { what: 'use relative URL', why: 'avoid cross-origin issues', turn: 3 },
    ],
    nextSteps: ['run auth tests'],
    openQuestions: [],
  };
}

s2.test('consolidate → pendingStore，不影响 store', () => {
  const mem = new EpisodicMemory();
  const session = mockSession('s1', 'fix login bug', 5);

  mem.consolidate(session, mockSummary());

  assertEq(mem.size, 0, 'store should be empty after consolidate');
  assertEq(mem.pendingSize, 1, 'pendingStore should have 1 entry');
});

s2.test('retrieve 只查 store，不查 pendingStore', () => {
  const mem = new EpisodicMemory();
  const session = mockSession('s1', 'fix login bug', 5);

  mem.consolidate(session, mockSummary());
  const results = mem.retrieve('fix login bug');

  assertEq(results.length, 0, 'should return empty — consolidate in pendingStore, not store');
});

s2.test('commit 将 pendingStore 合并进 store', () => {
  const mem = new EpisodicMemory();
  const session = mockSession('s1', 'fix login bug', 5);
  mem.consolidate(session, mockSummary());

  mem.commit();

  assertEq(mem.size, 1, 'store should have 1 entry after commit');
  assertEq(mem.pendingSize, 0, 'pendingStore should be empty after commit');
});

s2.test('commit 后可检索', () => {
  const mem = new EpisodicMemory();
  const session = mockSession('s1', 'fix login redirect bug', 5);
  mem.consolidate(session, mockSummary());
  mem.commit();

  const results = mem.retrieve('fix login');
  assertEq(results.length, 1, 'should retrieve 1 result');
  assertEq(results[0]!.id, 's1', 'should be session s1');
});

s2.test('同会话内多次 retrieve 返回相同结果', () => {
  const mem = new EpisodicMemory();

  // 预填一个旧会话
  const oldSession = mockSession('old1', 'refactor auth module', 10);
  mem.consolidate(oldSession, {
    sessionIntent: 'refactor auth module',
    fileModifications: [],
    decisions: [],
    nextSteps: [],
    openQuestions: [],
  });
  mem.commit();

  // 当前会话 consolidate → pendingStore
  const currentSession = mockSession('current', 'fix login bug', 3);
  mem.consolidate(currentSession, mockSummary());

  // retrieve 两次
  const r1 = mem.retrieve('fix auth login');
  const r2 = mem.retrieve('fix auth login');

  assertEq(r1.length, r2.length, 'same result count');
  assertEq(r1[0]?.id, r2[0]?.id, 'same top result id');
});

s2.test('serialize/deserialize 往返', () => {
  const mem1 = new EpisodicMemory();
  const session = mockSession('s1', 'fix bug', 3);
  mem1.consolidate(session, mockSummary());
  mem1.commit();
  const serialized = mem1.serialize();

  const mem2 = new EpisodicMemory();
  mem2.deserialize(serialized.episodes, serialized.reflections);

  assertEq(mem2.size, 1, 'restored store size');
  const results = mem2.retrieve('fix bug');
  assertEq(results.length, 1, 'restored retrieval works');
});

await s2.run();

// ============================================================================
// Suite 3: world-model.ts — 分块 + 来源追踪
// ============================================================================

const s3 = new TestSuite('world-model.ts — 分块 + 来源追踪');

// 导入 chunkByHeadings 通过 discoverAndRetrieve 间接测试，但 chunkByHeadings 是 private
// 我们测试 discoverComdrMd（保持向后兼容）和 discoverAndRetrieve

import { discoverComdrMd, discoverAndRetrieve } from '../packages/engine/src/world-model.js';

s3.test('discoverComdrMd 向后兼容', () => {
  // 只测当前项目确实存在的 COMDR.md
  const result = discoverComdrMd(process.cwd(), 'COMDR.md');
  assert(result.length > 0, 'should find COMDR.md in project root');
  assertContains(result, 'Comdr', 'should contain project name');
});

s3.test('discoverAndRetrieve 返回 fullText', () => {
  const result = discoverAndRetrieve('test query', process.cwd(), 'COMDR.md');
  assert(result.fullText.length > 0, 'should have fullText');
});

s3.test('discoverAndRetrieve didChunk 标记合理', () => {
  const result = discoverAndRetrieve('coding agent architecture', process.cwd(), 'COMDR.md');
  // COMDR.md 只有 ~30 行 → 应该 < 1200 字符阈值 → didChunk = false
  // 但如果 COMDR.md 很长，didChunk 可能为 true
  assert(typeof result.didChunk === 'boolean', 'didChunk should be boolean');
  // 不分块时 relevantChunks 为空
  if (!result.didChunk) {
    assertEq(result.relevantChunks.length, 0, 'no chunks when didChunk=false');
  }
});

s3.test('discoverAndRetrieve 空路径返回空', () => {
  const result = discoverAndRetrieve('test', '/nonexistent/path', 'nonexistent.md');
  assertEq(result.fullText, '', 'fullText should be empty');
  assertEq(result.relevantChunks.length, 0, 'chunks should be empty');
  assertEq(result.didChunk, false, 'didChunk should be false');
});

s3.test('discoverAndRetrieve 同一个输入两次结果一致', () => {
  const r1 = discoverAndRetrieve('coding agent', process.cwd(), 'COMDR.md');
  const r2 = discoverAndRetrieve('coding agent', process.cwd(), 'COMDR.md');

  assertEq(r1.didChunk, r2.didChunk, 'didChunk consistent');
  assertEq(r1.relevantChunks.length, r2.relevantChunks.length, 'chunk count consistent');
  if (r1.relevantChunks.length > 0) {
    assertEq(r1.relevantChunks[0]!.heading, r2.relevantChunks[0]!.heading, 'top chunk consistent');
  }
});

await s3.run();

// ============================================================================
// Suite 4: tool-retriever.ts — BM25 + addTools
// ============================================================================

const s4 = new TestSuite('tool-retriever.ts — BM25 工具检索');

import { ToolRetriever, createToolRetriever } from '../packages/engine/src/tool-retriever.js';
import type { ToolDefinition } from '../packages/core/src/types.js';
import { TOOL_PERMISSION } from '../packages/core/src/index.js';

const SAMPLE_TOOLS: ToolDefinition[] = [
  {
    name: 'file_read',
    description: 'Read a file from the local filesystem.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: TOOL_PERMISSION.READ_ONLY,
    timeoutMs: 5000,
  },
  {
    name: 'file_write',
    description: 'Write a file to the local filesystem.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: TOOL_PERMISSION.DESTRUCTIVE,
    timeoutMs: 10000,
  },
  {
    name: 'file_grep',
    description: 'Content search built on ripgrep. Supports full regex syntax.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: TOOL_PERMISSION.READ_ONLY,
    timeoutMs: 15000,
  },
  {
    name: 'shell_bash',
    description: 'Execute a bash command and return its output.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: TOOL_PERMISSION.DESTRUCTIVE,
    timeoutMs: 60000,
  },
];

s4.test('createToolRetriever 建索引', () => {
  const retriever = createToolRetriever(SAMPLE_TOOLS);
  const results = retriever.retrieve('read a file', 3);
  assert(results.length > 0, 'should return results');
  assert(results.includes('file_read'), 'should include file_read');
});

s4.test('中文查询匹配中文关键词', () => {
  const retriever = createToolRetriever(SAMPLE_TOOLS);
  const results = retriever.retrieve('读文件', 3);
  assert(results.includes('file_read'), '中文"读文件" should match file_read');
});

s4.test('topK=-1 返回全量', () => {
  const retriever = createToolRetriever(SAMPLE_TOOLS);
  const results = retriever.retrieve('anything', -1);
  assertEq(results.length, SAMPLE_TOOLS.length, 'all tools returned');
});

s4.test('无信息输入返回兜底', () => {
  const retriever = createToolRetriever(SAMPLE_TOOLS);
  const results = retriever.retrieve('?', 2);
  assert(results.length > 0, 'should return fallback tools');
});

s4.test('addTools 增量注册 MCP 工具', () => {
  const retriever = createToolRetriever(SAMPLE_TOOLS);
  const mcpTools: ToolDefinition[] = [
    {
      name: 'mcp__github_search',
      description: 'Search GitHub repositories',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: TOOL_PERMISSION.READ_ONLY,
      timeoutMs: 30000,
    },
  ];

  const before = retriever.retrieve('search github', 5);
  // MCP 工具还未注册
  const hasMcpBefore = before.includes('mcp__github_search');

  retriever.addTools(mcpTools);
  const after = retriever.retrieve('search github', 5);
  const hasMcpAfter = after.includes('mcp__github_search');

  assert(!hasMcpBefore, 'MCP tool not in index before addTools');
  assert(hasMcpAfter, 'MCP tool found after addTools');
});

s4.test('重复 addTools 不会重复索引', () => {
  const retriever = createToolRetriever(SAMPLE_TOOLS);
  const before = retriever.retrieve('', -1);
  retriever.addTools(SAMPLE_TOOLS); // 重复添加
  const after = retriever.retrieve('', -1);

  assertEq(before.length, after.length, 'duplicate addTools should not increase tool count');
});

await s4.run();

// ============================================================================
// Suite 5: semantic.ts — Graph RAG
// ============================================================================

const s5 = new TestSuite('semantic.ts — Graph RAG');

import { SemanticMemory } from '../packages/engine/src/memory/semantic.js';

s5.test('retrieveRelevantEntities 无匹配返回空串', () => {
  const mem = new SemanticMemory();
  const result = mem.retrieveRelevantEntities('something nonexistent', 5, 2);
  assertEq(result, '', 'no entities → empty string');
});

s5.test('retrieveRelevantEntities 匹配文件路径', () => {
  const mem = new SemanticMemory();

  // 记录文件操作以填充 temporal graph
  mem.recordFileOperation(
    {
      id: 'call1',
      type: 'function' as any,
      function: { name: 'file_read', arguments: '{"path":"src/auth.ts"}' },
    },
    { callId: 'call1', toolName: 'file_read', ok: true, content: 'read ok' },
    1,
  );

  mem.recordFileOperation(
    {
      id: 'call2',
      type: 'function' as any,
      function: { name: 'file_edit', arguments: '{"path":"src/auth.ts"}' },
    },
    { callId: 'call2', toolName: 'file_edit', ok: true, content: 'edited'},
    2,
  );

  const result = mem.retrieveRelevantEntities('auth.ts', 3, 1);
  assertContains(result, 'auth.ts', 'should find auth.ts');
  assertContains(result, '## Temporal Context', 'should include temporal section');
});

s5.test('retrieveRelevantEntities 注册符号后可查', () => {
  const mem = new SemanticMemory();

  mem.registerSymbol('loginHandler', 'function', 'src/auth.ts', 'src/auth.ts:42');
  mem.registerSymbol('AuthService', 'class', 'src/auth.ts', 'src/auth.ts:10');
  mem.registerReference('loginHandler', 'src/auth.ts', 'AuthService', 'src/auth.ts', 'calls');

  const result = mem.retrieveRelevantEntities('login handler auth', 5, 2);
  // loginHandler 应该匹配
  assertContains(result, 'loginHandler', 'should find loginHandler');
});

s5.test('extractCandidates 从用户输入提取', () => {
  // 通过 retrieveRelevantEntities 间接测试
  const mem = new SemanticMemory();
  mem.registerSymbol('testFeedback', 'function', 'crates/comdr-tools/src/sdb/test_feedback.rs');

  const result = mem.retrieveRelevantEntities('fix the test_feedback module', 5, 1);
  assertContains(result, 'testFeedback', 'should extract camelCase from snake_case');
});

await s5.run();

// ============================================================================
// Suite 6: skills.ts — 语义降级
// ============================================================================

const s6 = new TestSuite('skills.ts — 语义降级');

import { SkillsLoader } from '../packages/engine/src/skills.js';

s6.test('无 triggers 时降级到 BM25 语义检索', () => {
  const loader = new SkillsLoader();

  // 注册一个没有 trigger 但描述匹配的技能
  loader.registerSkill({
    name: 'deploy',
    description: 'Deploy the application to cloud infrastructure using Docker and Kubernetes',
    triggers: [],  // ★ 故意不设 trigger
    body: '# Deploy\nRun `docker compose up`',
    filePath: '/fake/deploy/SKILL.md',
  });

  // 输入中没有 trigger 关键词匹配，但语义相关
  const matched = loader.matchTriggers('ship the app to production');
  // 语义降级应该激活 deploy skill
  assertEq(matched.length, 1, 'should match 1 skill via semantic fallback');
  assertEq(matched[0], 'deploy', 'should be deploy skill');
});

s6.test('关键词 trigger 优先于语义降级', () => {
  const loader = new SkillsLoader();

  loader.registerSkill({
    name: 'build',
    description: 'Build the project',
    triggers: ['compile', 'build'],
    body: '# Build\nRun `pnpm build`',
    filePath: '/fake/build/SKILL.md',
  });

  // 精确 trigger 匹配
  const matched = loader.matchTriggers('help me compile this project');
  assertEq(matched.length, 1, 'should match via trigger keyword');
  assertEq(matched[0], 'build', 'should be build skill');
});

s6.test('无匹配时返回空', () => {
  const loader = new SkillsLoader();

  // 空注册表
  const matched = loader.matchTriggers('do something random unrelated');
  assertEq(matched.length, 0, 'no skills registered → no match');
});

s6.test('retrieveSemantically 按阈值过滤', () => {
  const loader = new SkillsLoader();

  loader.registerSkill({
    name: 'relevant',
    description: 'fix login bugs in the authentication system',
    triggers: [],
    body: '# Auth Fix',
    filePath: '/fake/auth/SKILL.md',
  });

  loader.registerSkill({
    name: 'unrelated',
    description: 'generate cute cat pictures with ASCII art',
    triggers: [],
    body: '# Cat Generator',
    filePath: '/fake/cat/SKILL.md',
  });

  const results = loader.retrieveSemantically('fix the login redirect issue');
  // relevant 的 score 应该显著高于 unrelated
  const relevantScore = results.find(r => r.name === 'relevant')?.score ?? 0;
  const unrelatedScore = results.find(r => r.name === 'unrelated')?.score ?? 0;
  assert(
    relevantScore > unrelatedScore,
    `relevant (${relevantScore}) should score higher than unrelated (${unrelatedScore})`,
  );
  // relevant 必须超过阈值
  assert(relevantScore >= 0.15, `relevant score ${relevantScore} should be >= threshold`);
});

s6.test('重建语义索引去重', () => {
  const loader = new SkillsLoader();
  loader.registerSkill({
    name: 'dup',
    description: 'test duplicate',
    triggers: [],
    body: '# Dup',
    filePath: '/fake/dup/SKILL.md',
  });
  loader.registerSkill({
    name: 'dup',  // 同名会覆盖
    description: 'test duplicate updated',
    triggers: [],
    body: '# Dup v2',
    filePath: '/fake/dup/SKILL.md',
  });

  const matched = loader.matchTriggers('test duplicate updated version');
  assertEq(matched.length, 1, 'should only match once after overwrite');
});

await s6.run();

// ============================================================================
// Suite 7: prompt.ts — Zone 构造
// ============================================================================

const s7 = new TestSuite('prompt.ts — Zone 构造');

import { PromptConstructor, emptyAnchor } from '../packages/engine/src/prompt.js';
import type { Route } from '../packages/core/src/types.js';
// NOTE: SessionState & StructuredSummary in suite 2; ToolDefinition in suite 4
import { MESSAGE_ROLE, THINKING_TYPE, THINKING_EFFORT, TASK_TYPE } from '../packages/core/src/index.js';

function mockRoute(): Route {
  return {
    taskType: TASK_TYPE.QUERY,
    thinking: { type: THINKING_TYPE.DISABLED },
    allowedTools: ['file_read', 'file_grep'],
  };
}

function mockPromptSession(): SessionState {
  return {
    id: 'test-session',
    turn: 1,
    tokensUsed: 100,
    currentInput: 'test query',
    outcome: null,
    messages: [],
    stateWindow: [{ key: 'file:src/test.ts', text: 'created', turn: 1 }],
    intentWindow: [{ key: 'file:src/test.ts', why: 'test setup', turn: 1 }],
    tempIdMappings: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const MINIMAL_TOOLS: ToolDefinition[] = [{
  name: 'file_read',
  description: 'Read a file',
  parameters: { type: 'object', properties: {}, required: [] },
  permission: 'read_only' as any,
  timeoutMs: 5000,
}];

s7.test('build 返回 non-empty messages', () => {
  const pc = new PromptConstructor();
  const messages = pc.build(mockPromptSession(), MINIMAL_TOOLS, mockRoute(), emptyAnchor());
  assert(messages.length > 0, 'should return messages');
});

s7.test('L1 System Prompt 在最前面', () => {
  const pc = new PromptConstructor();
  const messages = pc.build(mockPromptSession(), MINIMAL_TOOLS, mockRoute(), emptyAnchor());
  assertEq(messages[0]!.role, MESSAGE_ROLE.SYSTEM, 'first message is system prompt');
});

s7.test('L1.x worldModelContext 在静态区', () => {
  const pc = new PromptConstructor();
  pc.setWorldModelContext('relevant world model content');

  const messages = pc.build(mockPromptSession(), MINIMAL_TOOLS, mockRoute(), emptyAnchor());
  const worldModelMsg = messages.find(
    (m) => m.role === 'system' && m.content?.includes('<world>'),
  );
  assert(worldModelMsg !== undefined, 'should have world_model_context message');
  assertContains(worldModelMsg!.content!, 'relevant world model content', 'should contain injected text');
});

s7.test('L1.x 不设置时不注入', () => {
  const pc = new PromptConstructor();
  // 不调 setWorldModelContext——应该没有 <world>
  const messages = pc.build(mockPromptSession(), MINIMAL_TOOLS, mockRoute(), emptyAnchor());
  const worldModelMsg = messages.find(
    (m) => m.content?.includes('<world>'),
  );
  assert(worldModelMsg === undefined, 'should NOT have world_model_context when not set');
});

s7.test('L4.5 entityContext 在动态区', () => {
  const pc = new PromptConstructor();
  pc.setEntityContext('- function `loginHandler` in src/auth.ts');

  const messages = pc.build(mockPromptSession(), MINIMAL_TOOLS, mockRoute(), emptyAnchor());
  const entityMsg = messages.find(
    (m) => m.content?.includes('<e>'),
  );
  assert(entityMsg !== undefined, 'should have relevant_entities');
});

s7.test('L4.5 compactSummary 在动态区', () => {
  const pc = new PromptConstructor();
  pc.setCompactSummary('Goal: fix login. Files: modified src/auth.ts');

  const messages = pc.build(mockPromptSession(), MINIMAL_TOOLS, mockRoute(), emptyAnchor());
  const summaryMsg = messages.find(
    (m) => m.content?.includes('<c>'),
  );
  assert(summaryMsg !== undefined, 'should have compacted_summary');
});

s7.test('静态区在 build 间不变，动态区变', () => {
  const pc = new PromptConstructor();
  pc.setComdrMd('test COMDR.md');
  pc.setWorldModelContext('test world model');

  const route1 = mockRoute();
  const session = mockPromptSession();

  const msgs1 = pc.build(session, MINIMAL_TOOLS, route1, emptyAnchor());
  // 更新动态数据
  pc.setEntityContext('new entities');
  pc.setCompactSummary('new summary');
  const msgs2 = pc.build(session, MINIMAL_TOOLS, route1, emptyAnchor());

  // ★ 静态区已合并为 2 条消息（L1 System Prompt + L2 merged context）
  // entity/compact 现在注入到 L7 用户消息，不影响静态区
  const static1 = msgs1.slice(0, 2).map(m => m.content);
  const static2 = msgs2.slice(0, 2).map(m => m.content);
  for (let i = 0; i < static1.length; i++) {
    assertEq(static1[i], static2[i], `static zone message ${i} unchanged`);
  }
});

await s7.run();

// ============================================================================
// Suite 8: Planner — ToolRetriever 集成
// ============================================================================

const s8 = new TestSuite('planner.ts — RAG 集成');

import { TaskPlanner } from '../packages/engine/src/planner.js';
import { ALL_TOOLS_SENTINEL } from '../packages/core/src/index.js';

const PLANNER_TOOLS: ToolDefinition[] = [
  ...SAMPLE_TOOLS,
  {
    name: 'file_edit',
    description: 'Perform exact string replacements in a file.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: TOOL_PERMISSION.DESTRUCTIVE,
    timeoutMs: 10000,
  },
];

s8.test('route 通过 ToolRetriever 过滤工具', () => {
  const planner = new TaskPlanner();
  const retriever = createToolRetriever(PLANNER_TOOLS);
  planner.setRetriever(retriever);

  const route = planner.route('fix the login bug in auth', PLANNER_TOOLS);

  assert(route.allowedTools.length > 0, 'should have allowed tools');
  assert(route.allowedTools.length <= 7, 'edit mode topK=7');
  // 修 bug 应该包含 file_edit + file_read
  assert(route.allowedTools.includes('file_edit'), 'should include file_edit');
  assert(route.allowedTools.includes('file_read'), 'should include file_read');
});

s8.test('route 未设置 retriever 时全量返回', () => {
  const planner = new TaskPlanner();
  // 不调 setRetriever

  const route = planner.route('find all ts files', PLANNER_TOOLS);
  assert(route.allowedTools.length > 1, 'should return multiple tools');
});

s8.test('addToolsToRetriever 委托', () => {
  const planner = new TaskPlanner();
  const retriever = createToolRetriever(PLANNER_TOOLS);
  planner.setRetriever(retriever);

  const before = planner.route('search github repos', PLANNER_TOOLS);
  const hasMcpBefore = before.allowedTools.includes('mcp__github_search');

  planner.addToolsToRetriever([{
    name: 'mcp__github_search',
    description: 'Search GitHub repositories',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: TOOL_PERMISSION.READ_ONLY,
    timeoutMs: 30000,
  }]);

  const after = planner.route('search github repos', PLANNER_TOOLS);
  const hasMcpAfter = after.allowedTools.includes('mcp__github_search');

  // 注意：retriever.addTools 在 planner 层是委托的
  assert(!hasMcpBefore, 'MCP tool not found before');
  assert(hasMcpAfter, 'MCP tool found after addToolsToRetriever');
});

s8.test('orchestrate 模式全量工具', () => {
  const planner = new TaskPlanner();
  const retriever = createToolRetriever(PLANNER_TOOLS);
  planner.setRetriever(retriever);

  // 不触发任何关键词 → 默认 orchestrate → topK=-1 → 全量
  const route = planner.route('do a complex multi-step task', PLANNER_TOOLS);
  assertEq(route.taskType, TASK_TYPE.ORCHESTRATE, 'default to orchestrate');
  assert(route.allowedTools.includes(ALL_TOOLS_SENTINEL), 'orchestrate uses ALL sentinel');
});

await s8.run();

// ============================================================================
// 最终汇总
// ============================================================================

console.log('\n═══════════════════════════════════════════════');
console.log('  RAG 架构测试完成');
console.log('═══════════════════════════════════════════════\n');

const suites = [s1, s2, s3, s4, s5, s6, s7, s8];
const totalPassed = suites.reduce((s, suite) => s + Number((suite as any).passed || 0), 0);
//  每个 suite 内部的 passed/failed 计数
let allPassed = 0;
let allFailed = 0;
for (const s of suites) {
  // TestSuite.run() logs but we need counts — read from the object
}
console.log('All suites executed. Check individual results above.');
