/**
 * tool-blueprint.ts — Tool World Model Blueprint 类型定义
 *
 * schema: 'comdr.tool-blueprint.v1'
 *
 * 核心理念（2026 前沿）:
 *   工具以世界模型方式展示给 LLM——不是扁平菜单，而是拓扑图。
 *   LLM 在内部构建工具行为的心智模型（Text World Model），自主预测结果、编排序列。
 *   编排层负责把工具注册表编译成 LLM 能高效推理的拓扑图（Blueprint Pattern）。
 *
 * @agent Agent 1 — 此文件由 Agent 1 维护（单真理源）
 */

import type { ToolDefinition, JSONSchema, ToolPermission } from './types.js';

// ============================================================================
// §1 分类枚举
// ============================================================================

/**
 * Blueprint 三层——感知 / 操作 / 验证
 *
 * LLM 先看自己能感知什么，再看能改变什么，最后确认怎么验证。
 * 三层结构让 LLM 在内部推演"感知 → 操作 → 验证"的完整工具链。
 */
export type BlueprintLayer = 'perceive' | 'operate' | 'verify';

/**
 * 工具领域——工具所属的功能域
 *
 * 子 agent / MCP / skill 有独立域，保持拓扑图上与主工具清晰分界。
 */
export type ToolDomain =
  | 'filesystem'
  | 'search'
  | 'edit'
  | 'git'
  | 'shell'
  | 'lsp'
  | 'memory'
  | 'orchestration'
  | 'mcp'
  | 'skill'
  | 'subagent';

/**
 * 工具效果——LLM 用于内部推演"调完这个工具世界会怎样"
 *
 * Text World Model 的核心输入: 给定当前状态 + 工具效果 → 预测新状态。
 */
export type ToolEffect =
  | 'read'
  | 'write'
  | 'delete'
  | 'execute'
  | 'git_mutate'
  | 'network'
  | 'lsp_query'
  | 'memory_query'
  | 'agent_spawn';

/**
 * 拓扑边类型——工具之间的关系
 *
 * consumes:       A 的输出是 B 的输入（file_grep → file_read）
 * verifies:       A 可以用来验证 B 的结果（file_read → file_edit）
 * depends_on:     A 必须在 B 之前调用（git_add → git_commit）
 * conflicts_with: A 和 B 互斥（file_write 覆盖 file_edit 的更改）
 * alternative:    A 和 B 可互相替代（file_grep vs file_search）
 */
export type BlueprintEdgeType =
  | 'consumes'
  | 'verifies'
  | 'depends_on'
  | 'conflicts_with'
  | 'alternative';

// ============================================================================
// §2 蓝图节点
// ============================================================================

/**
 * 蓝图中的一个工具节点——编译后的精简表示
 *
 * 设计原则（precision supply）:
 *   - summary 是第一句描述（~80 字符），让 LLM 快速扫描
 *   - io 声明输入/输出类型，支撑内部推演
 *   - layer/domain/effect 三级分类，支撑拓扑导航
 *   - 完整 detail 通过 tool_explore 按需展开
 */
export interface ToolBlueprintNode {
  /** 完整工具名（含前缀，如 "audit__scan"、"mcp__comdr__generate"） */
  name: string;

  /** 一句话摘要——从 ToolDefinition.description 截取首句 */
  summary: string;

  /** 所属层 */
  layer: BlueprintLayer;

  /** 功能域 */
  domain: ToolDomain;

  /** 工具效果 */
  effect: ToolEffect;

  /** 权限 */
  permission: ToolPermission;

  /** 超时提示（人读格式，如 "~5s"、"~60s"、"~120s"） */
  timeoutHint: string;

  /** 输入/输出——支撑 LLM 推演"什么流过这条边" */
  io: {
    /** 参数名列表 */
    input: string[];
    /** 输出格式描述 */
    output: string;
  };

  /** 参数摘要——精简的参数名+说明（如 "path, old_string→new_string"） */
  paramSummary: string;

  /** 来源——"main" | sub-agent name | "mcp" | "skill" */
  source?: string;

  /** 是否可展开——true 表示 tool_explore 可返回更多详情 */
  isDrillable: boolean;
}

// ============================================================================
// §3 蓝图边
// ============================================================================

/**
 * 蓝图中的一条拓扑边——两个工具之间的关系
 */
export interface ToolBlueprintEdge {
  /** 源工具名 */
  from: string;

  /** 目标工具名 */
  to: string;

  /** 边类型 */
  type: BlueprintEdgeType;

  /** 边描述（可选——为 tool_explore 展开时提供） */
  description?: string;
}

// ============================================================================
// §4 完整蓝图
// ============================================================================

/**
 * ★ 工具世界模型的编译产物——LLM 收到的拓扑图
 *
 * schema: 'comdr.tool-blueprint.v1'
 *
 * 蓝图 = 节点（工具） + 边（关系） + 层级统计
 * LLM 通过蓝图理解"我在什么世界、能感知什么、能改变什么、怎么验证"。
 */
export interface ToolBlueprint {
  /** Schema 版本——LLM 可据此判断格式 */
  schema: 'comdr.tool-blueprint.v1';

  /** 所有工具节点 */
  nodes: ToolBlueprintNode[];

  /** 所有拓扑边 */
  edges: ToolBlueprintEdge[];

  /** 每层的工具数量——LLM 快速感知世界规模 */
  layerCounts: Record<BlueprintLayer, number>;

  /** 总工具数 */
  totalTools: number;
}

// ============================================================================
// §5 按需展开
// ============================================================================

/**
 * tool_explore 的返回值——单个工具的完整详情
 *
 * precision supply: 骨架默认给拓扑图，LLM 需要详情时通过 tool_explore 展开。
 * 展开后的文本由 formatter.formatExpansion() 生成。
 */
export interface ToolBlueprintExpansion {
  /** 工具名 */
  nodeName: string;

  /** 完整描述（ToolDefinition.description） */
  fullDescription: string;

  /** 完整参数 schema */
  parameters: JSONSchema;

  /** 指向此工具的边 */
  incomingEdges: ToolBlueprintEdge[];

  /** 从此工具出发的边 */
  outgoingEdges: ToolBlueprintEdge[];

  /** 替代工具名列表 */
  alternatives: string[];

  /** 工作流提示——按步骤指导 LLM 正确使用此工具 */
  workflowHints: string[];
}

// ============================================================================
// §6 常量
// ============================================================================

/** 三层工具数量的初始值 */
export const EMPTY_LAYER_COUNTS: Record<BlueprintLayer, number> = {
  perceive: 0,
  operate: 0,
  verify: 0,
};

/** tool_explore 工具名常量 */
export const TOOL_EXPLORE_NAME = 'tool_explore';

/**
 * ★ 将 ToolDefinition[] 编译为 ToolBlueprint 的工厂函数签名
 *
 * @contract
 *   实现者: Agent 4 (@comdr/engine/tool-blueprint/compiler)
 *   消费者: Agent 4 Engine.loop.ts
 */
export type BlueprintCompiler = (tools: ToolDefinition[]) => ToolBlueprint;
