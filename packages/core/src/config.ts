/**
 * config.ts — 分层配置加载
 *
 * 优先级: 环境变量 > ./.comdr.toml > ~/.comdr/config.toml > 硬编码默认值
 * 合并策略: 浅合并，高优先级字段完全覆盖低优先级
 *
 * 环境变量映射:
 *   COMDR_API_KEY          → llm.apiKey
 *   COMDR_BASE_URL         → llm.baseUrl
 *   COMDR_MODEL            → llm.model
 *   COMDR_MAX_TOKENS       → llm.maxTokens
 *   COMDR_THINKING         → llm.thinking.type ("enabled" | "disabled")
 *   COMDR_REASONING_EFFORT → llm.thinking.effort ("high" | "max")
 *   COMDR_MAX_TURNS        → agent.maxTurns
 *   COMDR_TOKEN_BUDGET     → agent.tokenBudget
 *   COMDR_PERMISSION_MODE  → agent.permissionMode
 *
 * @agent Agent 1 — 此文件由 Agent 1 维护
 */

import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseToml } from 'smol-toml';

import type {
  AgentConfig,
  ThinkingConfig,
  PermissionMode,
  MCPServerConfig,
} from './types.js';
import {
  THINKING_TYPE,
  THINKING_EFFORT,
  PERMISSION_MODE as PERM_MODE,
} from './types.js';
import { ConfigValidationError } from './contracts.js';

// ============================================================================
// §1 默认值（README 定义）
// ============================================================================

const DEFAULTS: AgentConfig = {
  llm: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    maxTokens: 8192,
    thinking: { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.HIGH },
  },
  project: {
    projectPath: '',
    skillsDir: 'skills',
    mcpServers: [],
    comdrMdPath: 'comdr.md',
  },
  agent: {
    maxTurns: 50,
    tokenBudget: 200_000,
    permissionMode: PERM_MODE.CONFIRM_DESTRUCTIVE,
  },
};

// ============================================================================
// §2 类型定义
// ============================================================================

/**
 * TOML 文件中可能出现的部分配置结构
 */
interface TomlLLMConfig {
  api_key?: string;
  base_url?: string;
  model?: string;
  max_tokens?: number;
  thinking?: ThinkingConfig;
}

interface TomlAgentConfig {
  max_turns?: number;
  token_budget?: number;
  permission_mode?: PermissionMode;
}

interface TomlMCPServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  hint?: string;
}

interface TomlProjectConfig {
  skills_dir?: string;
  mcp_servers?: TomlMCPServer[];
  comdr_md_path?: string;
}

interface ComdrToml {
  llm?: TomlLLMConfig;
  agent?: TomlAgentConfig;
  project?: TomlProjectConfig;
}

// ============================================================================
// §3 加载函数
// ============================================================================

/**
 * 加载并验证配置
 *
 * 加载链:
 *   1. DEFAULTS (硬编码默认值)
 *   2. ~/.comdr/config.toml (全局用户配置)
 *   3. ./.comdr.toml (项目级配置) — 覆盖
 *   4. 环境变量 — 覆盖
 *   5. 验证
 *
 * @param projectPath 项目根目录
 * @returns 合并后的完整配置
 * @throws ConfigValidationError 必填字段缺失时
 */
export function loadConfig(projectPath: string): AgentConfig {
  const config: AgentConfig = structuredClone(DEFAULTS);
  config.project.projectPath = projectPath;

  // Layer 1: ~/.comdr/config.toml
  const globalPath = pathResolve(homedir(), '.comdr', 'config.toml');
  mergeTomlFile(config, globalPath);

  // Layer 2: ./.comdr.toml
  const localPath = pathResolve(projectPath, '.comdr.toml');
  mergeTomlFile(config, localPath);

  // Layer 3: 环境变量覆盖
  mergeEnvVars(config);

  // 验证
  validateConfig(config);

  return config;
}

/**
 * 重新加载（热更新，仅非破坏性字段）
 * 当前简化实现: 完全重新加载。
 */
export function reloadConfig(projectPath: string): AgentConfig {
  return loadConfig(projectPath);
}

// ============================================================================
// §4 合并逻辑
// ============================================================================

/**
 * ★ 校验 TOML 解析出的 thinking 值是否符合 ThinkingConfig 联合类型
 *
 * TOML 解析返回的是 plain object，不是 TS 可辨识联合。
 * 此函数防止 `{ type: "invalid" }` 或 `{ type: "enabled" }`（缺 effort）穿透到运行时。
 *
 * @returns 合法的 ThinkingConfig
 * @throws ConfigValidationError 值不合法时
 */
function validateTomlThinking(
  raw: unknown,
  sourcePath: string,
): ThinkingConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigValidationError(
      `${sourcePath}: llm.thinking must be a table, got ${typeof raw}`,
      ['llm.thinking'],
    );
  }
  const t = raw as Record<string, unknown>;
  const type = t.type;
  if (type !== THINKING_TYPE.ENABLED && type !== THINKING_TYPE.DISABLED) {
    throw new ConfigValidationError(
      `${sourcePath}: llm.thinking.type must be '${THINKING_TYPE.ENABLED}' or '${THINKING_TYPE.DISABLED}', got '${String(type)}'`,
      ['llm.thinking.type'],
    );
  }
  if (type === THINKING_TYPE.ENABLED) {
    const effort = t.effort;
    if (effort !== THINKING_EFFORT.HIGH && effort !== THINKING_EFFORT.MAX) {
      throw new ConfigValidationError(
        `${sourcePath}: llm.thinking.effort must be '${THINKING_EFFORT.HIGH}' or '${THINKING_EFFORT.MAX}' when thinking is enabled, got '${String(effort)}'`,
        ['llm.thinking.effort'],
      );
    }
    return { type: THINKING_TYPE.ENABLED, effort };
  }
  return { type: THINKING_TYPE.DISABLED };
}

/**
 * 从 TOML 文件读取并合并到 config
 * 文件不存在 → 静默跳过
 */
function mergeTomlFile(config: AgentConfig, filePath: string): void {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    // 文件不存在，跳过
    return;
  }

  let parsed: ComdrToml;
  try {
    parsed = parseToml(raw) as ComdrToml;
  } catch (err) {
    // TOML 解析失败——用户应该知道配置写错了
    console.warn(`Comdr: failed to parse ${filePath}: ${String(err)}`);
    return;
  }

  if (parsed.llm) {
    if (parsed.llm.api_key !== undefined) config.llm.apiKey = parsed.llm.api_key;
    if (parsed.llm.base_url !== undefined) config.llm.baseUrl = parsed.llm.base_url;
    if (parsed.llm.model !== undefined) config.llm.model = parsed.llm.model;
    if (parsed.llm.max_tokens !== undefined) config.llm.maxTokens = parsed.llm.max_tokens;
    if (parsed.llm.thinking !== undefined) {
      config.llm.thinking = validateTomlThinking(parsed.llm.thinking, filePath);
    }
  }

  if (parsed.agent) {
    if (parsed.agent.max_turns !== undefined) config.agent.maxTurns = parsed.agent.max_turns;
    if (parsed.agent.token_budget !== undefined) config.agent.tokenBudget = parsed.agent.token_budget;
    if (parsed.agent.permission_mode !== undefined) config.agent.permissionMode = parsed.agent.permission_mode;
  }

  if (parsed.project) {
    if (parsed.project.skills_dir !== undefined) config.project.skillsDir = parsed.project.skills_dir;
    if (parsed.project.comdr_md_path !== undefined) config.project.comdrMdPath = parsed.project.comdr_md_path;
    if (parsed.project.mcp_servers !== undefined) {
      config.project.mcpServers = parsed.project.mcp_servers.map(
        (s): MCPServerConfig => ({
          name: s.name,
          command: s.command,
          args: s.args ?? [],
          env: s.env,
          hint: s.hint,
        }),
      );
    }
  }
}

/**
 * 环境变量覆盖
 */
function mergeEnvVars(config: AgentConfig): void {
  const env = process.env;

  // API Key: COMDR_API_KEY > ANTHROPIC_AUTH_TOKEN (Claude runtime 透传)
  if (env.COMDR_API_KEY) config.llm.apiKey = env.COMDR_API_KEY;
  else if (env.ANTHROPIC_AUTH_TOKEN) config.llm.apiKey = env.ANTHROPIC_AUTH_TOKEN;

  if (env.COMDR_BASE_URL) config.llm.baseUrl = env.COMDR_BASE_URL;
  // ANTHROPIC_BASE_URL 指向 /anthropic 兼容端点，Comdr 用原生端点所以不采纳
  if (env.COMDR_MODEL) config.llm.model = env.COMDR_MODEL;
  if (env.COMDR_MAX_TOKENS) {
    const v = parseInt(env.COMDR_MAX_TOKENS, 10);
    if (!isNaN(v) && v > 0) config.llm.maxTokens = v;
  }
  if (env.COMDR_THINKING === THINKING_TYPE.ENABLED) {
    const effort = env.COMDR_REASONING_EFFORT === THINKING_EFFORT.MAX
      ? THINKING_EFFORT.MAX : THINKING_EFFORT.HIGH;
    config.llm.thinking = { type: THINKING_TYPE.ENABLED, effort };
  } else if (env.COMDR_THINKING === THINKING_TYPE.DISABLED) {
    config.llm.thinking = { type: THINKING_TYPE.DISABLED };
  } else if (env.COMDR_REASONING_EFFORT) {
    // 单独设置 effort 但不改 thinking type
    if (config.llm.thinking.type === THINKING_TYPE.ENABLED) {
      const effort = env.COMDR_REASONING_EFFORT === THINKING_EFFORT.MAX
        ? THINKING_EFFORT.MAX : THINKING_EFFORT.HIGH;
      config.llm.thinking = { type: THINKING_TYPE.ENABLED, effort };
    }
  }
  if (env.COMDR_MAX_TURNS) {
    const v = parseInt(env.COMDR_MAX_TURNS, 10);
    if (!isNaN(v) && v > 0) config.agent.maxTurns = v;
  }
  if (env.COMDR_TOKEN_BUDGET) {
    const v = parseInt(env.COMDR_TOKEN_BUDGET, 10);
    if (!isNaN(v) && v > 0) config.agent.tokenBudget = v;
  }
  if (env.COMDR_PERMISSION_MODE) {
    const mode = env.COMDR_PERMISSION_MODE;
    if (mode === PERM_MODE.AUTO_APPROVE_ALL || mode === PERM_MODE.CONFIRM_DESTRUCTIVE || mode === PERM_MODE.STRICT) {
      config.agent.permissionMode = mode;
    }
  }
}

// ============================================================================
// §5 验证
// ============================================================================

function validateConfig(config: AgentConfig): void {
  const errors: string[] = [];

  // LLM 必填字段
  if (!config.llm.apiKey) errors.push('llm.apiKey (required)');
  if (!config.llm.baseUrl) errors.push('llm.baseUrl (required)');
  if (!config.llm.model) errors.push('llm.model (required)');
  if (config.llm.maxTokens < 1) errors.push('llm.maxTokens must be >= 1');

  // ★ thinking 配置校验——DeepSeek 严格区分 enabled/disabled
  // 注：此处用逐值比较而非 discriminated union narrowing，
  // 因为 TOML/ENV 输入可能包含非法值，误判会导致运行时错误。
  const thinking = config.llm.thinking;
  const tType: string = thinking.type;
  if (tType === THINKING_TYPE.ENABLED) {
    const effort = (thinking as { effort?: unknown }).effort;
    if (effort !== THINKING_EFFORT.HIGH && effort !== THINKING_EFFORT.MAX) {
      errors.push(`llm.thinking.effort must be '${THINKING_EFFORT.HIGH}' or '${THINKING_EFFORT.MAX}' when thinking is enabled`);
    }
  } else if (tType === THINKING_TYPE.DISABLED) {
    // valid
  } else {
    errors.push(`llm.thinking.type must be '${THINKING_TYPE.ENABLED}' or '${THINKING_TYPE.DISABLED}', got '${String(tType)}'`);
  }

  // Agent 行为配置
  if (config.agent.maxTurns < 1) errors.push('agent.maxTurns must be >= 1');
  if (config.agent.tokenBudget < 1) errors.push('agent.tokenBudget must be >= 1');

  const validModes = [PERM_MODE.AUTO_APPROVE_ALL, PERM_MODE.CONFIRM_DESTRUCTIVE, PERM_MODE.STRICT];
  if (!validModes.includes(config.agent.permissionMode)) {
    errors.push(`agent.permissionMode must be one of: ${validModes.join(', ')}`);
  }

  // MCP Server 配置
  for (const s of config.project.mcpServers) {
    if (!s.name) errors.push('mcpServers: each server must have a name');
    if (!s.command) errors.push(`mcpServers[${s.name || '?'}]: command is required`);
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(
      `配置验证失败:\n  - ${errors.join('\n  - ')}`,
      errors,
    );
  }
}

// ============================================================================
// §6 Contract D: IConfigLoader 实现
// ============================================================================

/**
 * IConfigLoader 的实现实例
 * 外部使用者可通过此工厂函数创建绑定到特定 projectPath 的 loader
 */
export function createConfigLoader(projectPath: string) {
  return {
    load: () => loadConfig(projectPath),
    reload: () => reloadConfig(projectPath),
  };
}
