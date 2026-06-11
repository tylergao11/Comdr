/**
 * memory/tool-experience.ts — 工具调用级经验记忆
 *
 * ★ 论文依据: Pushing the Limits of LLM Tool Calling (2026.06)
 *   核心发现——简单的经验知识（过去成功/失败的工具调用模式）
 *   比复杂 prompt engineering 更有效。
 *
 * 职责:
 *   1. 每次工具执行后记录: {tool, file, success, error, insight}
 *   2. LLM 调工具前检索相关历史经验 → 注入到上下文
 *   3. 跨会话持久化——随 EpisodicMemory 一起 serialize
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

// ============================================================================
// §1 类型
// ============================================================================

export interface ToolExperience {
  /** 工具名 */
  toolName: string;
  /** 目标文件路径（若有关） */
  file?: string;
  /** 工具执行是否成功 */
  success: boolean;
  /** 失败时的错误分类 */
  errorCategory?: string;
  /** 人类可读的经验教训 */
  insight: string;
  /** 发生时的会话 turn */
  turn: number;
  /** 时间戳 */
  timestamp: string;
}

// ============================================================================
// §2 经验生成规则（确定性，不调 LLM）
// ============================================================================

/**
 * 从工具调用结果中提炼经验教训。
 * 纯规则驱动——零 LLM 调用，零延迟。
 */
function deriveInsight(
  toolName: string,
  path: string | undefined,
  success: boolean,
  errorCategory: string | undefined,
): string {
  if (success) {
    if (toolName === 'file_edit') {
      return path
        ? `file_edit on ${path} succeeded. Prefer using 'anchor' parameter (hash from file_read) over exact old_string matching.`
        : 'file_edit succeeded. Using anchor hash instead of old_string improves reliability.';
    }
    if (toolName === 'shell_bash') {
      return 'shell_bash succeeded. For test results, prefer shell_test for structured pass/fail counts.';
    }
    if (toolName === 'file_write') {
      return path
        ? `file_write on ${path} succeeded. Always verify with file_read after writing.`
        : 'file_write succeeded. Verify content with file_read after writing.';
    }
    return `${toolName} executed successfully.`;
  }

  // Failure insights
  if (errorCategory === 'ANCHOR_NOT_FOUND' || errorCategory === 'ANCHOR_STALE') {
    return `${toolName} failed: anchor expired or not found. Always re-read the file with file_read before editing to get fresh anchors.`;
  }
  if (errorCategory === 'EXECUTION_FAILED' && toolName === 'file_edit') {
    return path
      ? `${toolName} on ${path} failed: old_string not found. Use file_read first to get the exact text, then use the 'anchor' hash next to each symbol.`
      : `${toolName} failed: old_string not found. Use file_read + anchor hash for reliable matching.`;
  }
  if (errorCategory === 'SCHEMA_INVALID') {
    return `${toolName} failed: invalid parameters. Check the required parameters with tool_explore("${toolName}").`;
  }
  if (errorCategory === 'PERMISSION_DENIED') {
    return `${toolName} failed: path outside project boundary. Use relative paths within the project.`;
  }
  if (errorCategory === 'TIMEOUT') {
    return `${toolName} timed out. Consider breaking the task into smaller steps.`;
  }
  return `${toolName} failed with ${errorCategory ?? 'unknown error'}. Check parameters and retry.`;
}

// ============================================================================
// §3 ToolExperienceMemory 类
// ============================================================================

export class ToolExperienceMemory {
  /** 按工具名索引的经验列表 */
  private store: Map<string, ToolExperience[]> = new Map();

  // --------------------------------------------------------------------------
  // record()
  // --------------------------------------------------------------------------

  /**
   * 记录一次工具调用的经验。
   */
  record(
    toolName: string,
    path: string | undefined,
    success: boolean,
    errorCategory: string | undefined,
    turn: number,
  ): ToolExperience {
    const insight = deriveInsight(toolName, path, success, errorCategory);

    const exp: ToolExperience = {
      toolName,
      file: path,
      success,
      errorCategory,
      insight,
      turn,
      timestamp: new Date().toISOString(),
    };

    const existing = this.store.get(toolName) ?? [];
    // 去重——同 tool + 同 file + 同 insight 的不重复记录
    const duplicate = existing.find(
      (e) => e.file === path && e.insight === insight && e.success === success,
    );
    if (!duplicate) {
      existing.push(exp);
      // 每种工具最多保留 20 条经验
      if (existing.length > 20) {
        existing.shift();
      }
    }
    this.store.set(toolName, existing);

    return exp;
  }

  // --------------------------------------------------------------------------
  // retrieve()
  // --------------------------------------------------------------------------

  /**
   * ★ 检索与当前工具调用上下文相关的历史经验。
   *
   * @param toolName  当前工具名
   * @param filePath  目标文件路径（可选，用于匹配同文件历史）
   * @param maxResults 最多返回几条
   */
  retrieve(
    toolName: string,
    filePath?: string,
    maxResults: number = 3,
  ): ToolExperience[] {
    const exps = this.store.get(toolName);
    if (!exps || exps.length === 0) return [];

    const queryLower = (filePath ?? '').toLowerCase();
    const queryKeywords = toolName.toLowerCase().split('_');

    const scored = exps.map((exp) => {
      let score = 0;
      // 同文件匹配 → 高权重
      if (filePath && exp.file && exp.file.toLowerCase().includes(queryLower)) {
        score += 10;
      }
      // 同工具 + 失败经验 → 中权重（教训比成功值得记）
      if (!exp.success) score += 3;
      // 时效性——越新的得分略高
      const age = Date.now() - new Date(exp.timestamp).getTime();
      if (age < 300_000) score += 2; // 5 分钟内
      // 关键词匹配
      for (const kw of queryKeywords) {
        if (exp.insight.toLowerCase().includes(kw)) score += 1;
      }
      return { exp, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((s) => s.exp);
  }

  // --------------------------------------------------------------------------
  // 持久化
  // --------------------------------------------------------------------------

  serialize(): ToolExperience[] {
    const all: ToolExperience[] = [];
    for (const exps of this.store.values()) {
      all.push(...exps);
    }
    return all;
  }

  deserialize(data: ToolExperience[]): void {
    this.store.clear();
    for (const exp of data) {
      const existing = this.store.get(exp.toolName) ?? [];
      existing.push(exp);
      this.store.set(exp.toolName, existing);
    }
  }

  /** 清空所有经验 */
  clear(): void {
    this.store.clear();
  }

  /** 获取所有经验（供 SkillEvolution 消费） */
  getAll(): ToolExperience[] {
    const all: ToolExperience[] = [];
    for (const exps of this.store.values()) {
      all.push(...exps);
    }
    return all;
  }

  /** 经验总数 */
  get size(): number {
    let count = 0;
    for (const exps of this.store.values()) {
      count += exps.length;
    }
    return count;
  }
}
