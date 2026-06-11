/**
 * subagent-registry.ts — 子智能体注册中心
 *
 * ★ 主引擎通过此注册中心发现子智能体、注册其工具、分发工具调用。
 *   子智能体实现 ISubAgent 契约（@comdr/core/contracts.ts Contract F）。
 *
 * 设计:
 *   - 子智能体注册时自动前缀其工具名（"audit__scan"、"cocos__create_node"）
 *   - LLM 通过工具名区分不同子智能体
 *   - 工具调用时自动剥离前缀，分发到对应子智能体
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ToolDefinition, ToolResult } from '@comdr/core/types';
import type { ISubAgent, SubAgentToolResult } from '@comdr/core/contracts';

// ============================================================================
// §1 SubAgentRegistry
// ============================================================================

export class SubAgentRegistry {
  private readonly agents: Map<string, ISubAgent> = new Map();
  /** toolPrefix → agent name 反向映射 */
  private readonly prefixMap: Map<string, string> = new Map();

  /**
   * 注册子智能体。
   *
   * @param agent  实现 ISubAgent 的子智能体实例
   */
  register(agent: ISubAgent): void {
    const { name, toolPrefix } = agent.manifest;
    this.agents.set(name, agent);
    this.prefixMap.set(toolPrefix, name);
  }

  /**
   * 获取所有子智能体提供的工具定义（已加前缀）。
   */
  getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const agent of this.agents.values()) {
      const prefix = agent.manifest.toolPrefix;
      for (const tool of agent.getTools()) {
        tools.push({
          ...tool,
          name: `${prefix}__${tool.name}`,
          description: `[${agent.manifest.name}] ${tool.description}`,
        });
      }
    }
    return tools;
  }

  /**
   * 检查工具调用是否属于某个子智能体。
   *
   * @returns { agent, toolName } 或 null（不是子智能体工具）
   */
  resolve(toolName: string): { agent: ISubAgent; toolName: string } | null {
    // ★ 检查是否匹配任何已注册 prefix
    for (const [prefix, agentName] of this.prefixMap) {
      if (toolName.startsWith(`${prefix}__`)) {
        const agent = this.agents.get(agentName);
        if (agent) {
          return {
            agent,
            toolName: toolName.slice(prefix.length + 2), // 剥离 "prefix__"
          };
        }
      }
    }
    return null;
  }

  /**
   * 执行子智能体工具调用。
   */
  async executeTool(
    fullToolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const resolved = this.resolve(fullToolName);
    if (!resolved) {
      return {
        ok: false,
        callId: '',
        toolName: fullToolName,
        content: `Unknown sub-agent tool: ${fullToolName}`,
        errorCategory: 'execution_error',
      };
    }

    try {
      return await resolved.agent.executeTool(resolved.toolName, args);
    } catch (err) {
      return {
        ok: false,
        callId: '',
        toolName: fullToolName,
        content: `Sub-agent [${resolved.agent.manifest.name}] error: ${err instanceof Error ? err.message : String(err)}`,
        errorCategory: 'execution_error',
      };
    }
  }

  /**
   * 获取已注册的子智能体名称列表。
   */
  getRegisteredNames(): string[] {
    return [...this.agents.keys()];
  }

  /**
   * 子智能体数量。
   */
  get size(): number {
    return this.agents.size;
  }

  /**
   * ★ 将所有已注册子智能体复制到另一个 registry。
   *   用于 forkEngine()——子 Engine 共享父 Engine 的子智能体。
   */
  copyTo(target: SubAgentRegistry): void {
    for (const agent of this.agents.values()) {
      target.register(agent);
    }
  }
}
