/**
 * planner.ts — 停滞检测 + 思维升级
 *
 * ★ 关键词匹配已删除。LLM 自己理解用户意图，编排层不替 LLM 做任务分类。
 *   保留：defaultThinking() + replan() 停滞升级——这是 LLM 做不到的事。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ProgressSignal, ThinkingConfig } from '@comdr/core/types';
import { SYSTEM, THINKING_TYPE, THINKING_EFFORT } from '@comdr/core';

export class TaskPlanner {
  /** 默认 thinking 配置。LLM 自己决定想多深，编排层不预设。 */
  defaultThinking(): ThinkingConfig {
    return { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.HIGH };
  }

  /**
   * 停滞升级：连续停滞时升级 thinking effort 到 max。
   * LLM 检测不到自己陷入循环——这是编排层的确定性职责。
   */
  replan(
    current: ThinkingConfig,
    signal: ProgressSignal,
  ): ThinkingConfig | null {
    if (signal.stallCount >= SYSTEM.MAX_STALLED_TURNS || signal.loopPattern) {
      return { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.MAX };
    }
    return null;
  }
}
