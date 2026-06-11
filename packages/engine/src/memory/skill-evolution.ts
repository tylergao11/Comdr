/**
 * memory/skill-evolution.ts — 自我进化技能提炼
 *
 * ★ 论文依据: SIGA (2026.06) — Self-Evolving Coding-Agent Adapters
 *   核心直觉——coding agent 已知道如何导航文件、编辑代码，
 *   只需极薄的适配层。多次使用某工具后自动提炼最佳实践。
 *
 * 职责:
 *   1. 监听 ToolExperienceMemory —— 发现重复成功的模式
 *   2. 当模式积累 >= 3 次成功且 0 次相关失败 → 提升为 skill
 *   3. 注入 prompt（优先级低于用户手动 skill）
 *   4. 跨会话持久化
 *
 * 约束:
 *   - 不调 LLM —— skill 提炼是确定性的
 *   - 不写磁盘 —— 所有进化产物存在内存 + 持久化 JSON 里
 *   - 不覆盖用户 skill —— 同名冲突时用户 skill 胜
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ToolExperience } from './tool-experience.js';

// ============================================================================
// §1 类型
// ============================================================================

export interface EvolvedSkill {
  /** 唯一标识 */
  id: string;
  /** 一句话技能描述 */
  description: string;
  /** 触发条件——匹配 toolName */
  toolName: string;
  /** 证据——支撑此 skill 的经验数 */
  evidenceCount: number;
  /** 提炼时间 */
  createdAt: string;
}

// ============================================================================
// §2 提炼规则（确定性，不调 LLM）
// ============================================================================

interface SkillTemplate {
  /** 匹配函数——哪些经验能触发此 skill */
  match: (exp: ToolExperience) => boolean;
  /** 生成 skill id + description */
  produce: (exps: ToolExperience[]) => EvolvedSkill;
}

const TEMPLATES: SkillTemplate[] = [
  {
    // ★ file_edit with anchor → higher success rate
    match: (exp) =>
      exp.toolName === 'file_edit' &&
      exp.success &&
      exp.insight.includes('anchor'),
    produce: (exps) => ({
      id: 'evolved:file-edit-anchor',
      description:
        'Prefer the "anchor" parameter (hash from file_read output) for file_edit ' +
        'instead of copying old_string exactly. This avoids whitespace/indentation ' +
        'mismatch errors.',
      toolName: 'file_edit',
      evidenceCount: exps.length,
      createdAt: new Date().toISOString(),
    }),
  },
  {
    // ★ shell_test for structured test results
    match: (exp) =>
      exp.toolName === 'shell_test' &&
      exp.success,
    produce: (exps) => ({
      id: 'evolved:use-shell-test',
      description:
        'Use shell_test instead of shell_bash for running tests. ' +
        'shell_test returns structured pass/fail counts — no need to parse text output.',
      toolName: 'shell_test',
      evidenceCount: exps.length,
      createdAt: new Date().toISOString(),
    }),
  },
  {
    // ★ file_read before file_edit
    match: (exp) =>
      exp.toolName === 'file_read' &&
      exp.success &&
      !exp.insight.includes('anchor'), // only count non-anchor reads
    produce: (exps) => ({
      id: 'evolved:read-before-edit',
      description:
        'Always file_read a file (summary mode is enough) before file_edit ' +
        'to get accurate content and fresh anchor hashes.',
      toolName: 'file_read',
      evidenceCount: exps.length,
      createdAt: new Date().toISOString(),
    }),
  },
  {
    // ★ git_diff before git_commit
    match: (exp) =>
      exp.toolName === 'git_diff' &&
      exp.success,
    produce: (exps) => ({
      id: 'evolved:diff-before-commit',
      description:
        'Always run git_diff to review changes before git_commit. ' +
        'This catches unintended modifications.',
      toolName: 'git_diff',
      evidenceCount: exps.length,
      createdAt: new Date().toISOString(),
    }),
  },
];

// ============================================================================
// §3 SkillEvolution
// ============================================================================

/** 提炼阈值：至少 N 次匹配成功的经验才提升为 skill */
const EVOLVE_THRESHOLD = 3;

export class SkillEvolution {
  /** 已进化的技能 */
  private skills: Map<string, EvolvedSkill> = new Map();

  // --------------------------------------------------------------------------
  // feed()
  // --------------------------------------------------------------------------

  /**
   * 喂入工具经验，尝试提炼新 skill。
   *
   * @param allExperiences  当前所有工具经验（含刚记录的）
   * @returns 本轮新提炼的 skills（可能为空）
   */
  feed(allExperiences: ToolExperience[]): EvolvedSkill[] {
    const newSkills: EvolvedSkill[] = [];

    for (const template of TEMPLATES) {
      const matches = allExperiences.filter((exp) => template.match(exp));
      if (matches.length < EVOLVE_THRESHOLD) continue;

      // 检查是否已存在同 id skill（已进化过则跳过）
      const candidate = template.produce(matches);
      if (this.skills.has(candidate.id)) continue;

      // ★ 确认没有相关失败——所有匹配经验都是成功的
      const hasFailure = matches.some((exp) => !exp.success);
      if (hasFailure) continue;

      this.skills.set(candidate.id, candidate);
      newSkills.push(candidate);
    }

    return newSkills;
  }

  // --------------------------------------------------------------------------
  // getActiveSkills()
  // --------------------------------------------------------------------------

  /**
   * 获取所有已进化的 skill 描述，注入 prompt。
   * 返回空数组表示尚无进化 skill。
   */
  getActiveSkills(): EvolvedSkill[] {
    return [...this.skills.values()];
  }

  // --------------------------------------------------------------------------
  // 持久化
  // --------------------------------------------------------------------------

  serialize(): EvolvedSkill[] {
    return [...this.skills.values()];
  }

  deserialize(data: EvolvedSkill[]): void {
    this.skills.clear();
    for (const skill of data) {
      this.skills.set(skill.id, skill);
    }
  }

  /** skill 总数 */
  get size(): number {
    return this.skills.size;
  }
}
