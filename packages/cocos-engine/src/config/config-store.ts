// ============================================================
// ConfigStore — 多提供商网关配置管理
// 存储位置: ~/.comdr/gateway.config.json
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { readJsonUtf8, writeJsonAtomic, cloneJson } from '../foundation/value-kit.js';

// ===== 类型 =====

export interface ProviderConfig {
  baseUrl: string;
  model: string;
  fastModel: string;
  strongModel: string;
  baseUrlMode: string;
  callMode: 'normal' | 'streaming';
  thinking: string;
  reasoningEffort: string;
  cacheProfile: string;
  apiKeyEnv: string;
  apiKey: string;
  timeoutMs: number;
}

export interface GatewayConfig {
  schema: 'Comdr.gateway-config.v1';
  configPath: string;
  defaultProvider: string;
  providers: Record<string, ProviderConfig>;
  defaults: {
    timeoutMs: number;
    audit: boolean;
  };
}

export interface ActiveProvider extends ProviderConfig {
  provider: string;
  hasApiKey: boolean;
}

export const MODEL_TIERS = {
  fast: 'fast',
  balanced: 'balanced',
  strong: 'strong',
} as const;

export type ModelTier = keyof typeof MODEL_TIERS;

// ===== 默认配置 =====

const CONFIG_SCHEMA = 'Comdr.gateway-config.v1';
const OLD_CONFIG_SCHEMA = 'Cmdr.gateway-config.v1'; // 旧版本兼容
const DEFAULT_CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.comdr'
);
const OLD_CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.cmdr'
);
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, 'gateway.config.json');
const OLD_CONFIG_PATH = path.join(OLD_CONFIG_DIR, 'gateway.config.json');

const DEFAULT_OPENAI: ProviderConfig = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  fastModel: 'gpt-4o-mini',
  strongModel: 'gpt-4o',
  baseUrlMode: 'path',
  callMode: 'normal',
  thinking: 'disabled',
  reasoningEffort: 'medium',
  cacheProfile: 'claude-default',
  apiKeyEnv: 'OPENAI_API_KEY',
  apiKey: '',
  timeoutMs: 120000,
};

const DEFAULT_ANTHROPIC: ProviderConfig = {
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-sonnet-4-6',
  fastModel: 'claude-haiku-4-5-20251001',
  strongModel: 'claude-opus-4-8',
  baseUrlMode: 'path',
  callMode: 'normal',
  thinking: 'disabled',
  reasoningEffort: 'medium',
  cacheProfile: 'claude-default',
  apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN',
  apiKey: '',
  timeoutMs: 120000,
};

function defaultConfig(configPath?: string): GatewayConfig {
  return {
    schema: CONFIG_SCHEMA,
    configPath: configPath || DEFAULT_CONFIG_PATH,
    defaultProvider: 'anthropic',
    providers: {
      anthropic: { ...DEFAULT_ANTHROPIC },
      openai: { ...DEFAULT_OPENAI },
    },
    defaults: {
      timeoutMs: 120000,
      audit: false,
    },
  };
}

// ===== 加载/保存 =====

let _config: GatewayConfig | null = null;

export function loadGatewayConfig(options?: Partial<{ configPath: string }>): GatewayConfig {
  if (_config) return _config;

  const configPath = options?.configPath || DEFAULT_CONFIG_PATH;
  let data = readJsonUtf8(configPath) as GatewayConfig | null;

  // 迁移：新路径无数据时尝试旧路径 (cmdr → comdr 重命名兼容)
  if (!data) {
    const oldPath = options?.configPath
      ? options.configPath.replace(/[\\/]\.comdr[\\/]/, (sep: string) => `${sep}.cmdr${sep}`)
      : OLD_CONFIG_PATH;
    const oldData = readJsonUtf8(oldPath) as GatewayConfig | null;
    if (oldData && ((oldData as unknown as Record<string,unknown>).schema === OLD_CONFIG_SCHEMA || (oldData as unknown as Record<string,unknown>).schema === CONFIG_SCHEMA)) {
      data = { ...oldData, schema: CONFIG_SCHEMA };
      // 写入新位置
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      writeJsonAtomic(configPath, data, true);
    }
  }

  if (data && ((data as unknown as Record<string,unknown>).schema === CONFIG_SCHEMA || (data as unknown as Record<string,unknown>).schema === OLD_CONFIG_SCHEMA)) {
    // 合并默认值（保证新增字段存在）
    const defaults = defaultConfig(configPath);
    _config = {
      ...defaults,
      ...data,
      providers: { ...defaults.providers, ...data.providers },
      defaults: { ...defaults.defaults, ...data.defaults },
    };
  } else {
    _config = defaultConfig(configPath);
  }

  return _config;
}

export function saveGatewayConfig(
  input: Partial<GatewayConfig>,
  options?: { configPath?: string }
): GatewayConfig {
  const config = loadGatewayConfig(options);
  const merged: GatewayConfig = {
    ...config,
    ...input,
    providers: { ...config.providers, ...input.providers },
    defaults: { ...config.defaults, ...input.defaults },
  };

  const configPath = options?.configPath || config.configPath || DEFAULT_CONFIG_PATH;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeJsonAtomic(configPath, merged, true);

  _config = merged;
  return merged;
}

// ===== Claude Code 主机检测 =====

/** Claude Code 作为主机时自动注入的凭据，无需用户额外配置 */
function detectClaudeCodeCredentials(): {
  apiKey: string;
  baseUrl: string;
  model: string;
  fastModel: string;
  strongModel: string;
} {
  const token = process.env['ANTHROPIC_AUTH_TOKEN'] || '';
  const baseUrl = process.env['ANTHROPIC_BASE_URL'] || '';
  const model = process.env['ANTHROPIC_MODEL'] || '';
  const fastModel = process.env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] || '';
  const strongModel = process.env['ANTHROPIC_DEFAULT_OPUS_MODEL'] || '';
  return { apiKey: token, baseUrl, model, fastModel, strongModel };
}

// ===== 活动提供商 =====

export function getActiveProvider(config?: GatewayConfig): ActiveProvider {
  const cfg = config || loadGatewayConfig();
  const providerName = cfg.defaultProvider || 'anthropic';
  const provider = cfg.providers[providerName]
    || cfg.providers['anthropic']
    || (() => { throw new Error('No provider configured — missing anthropic default'); })();

  // Claude Code 自动凭据检测：如果主机已注入 ANTHROPIC_AUTH_TOKEN，自动使用
  const ccCreds = detectClaudeCodeCredentials();

  // API Key 优先级：显式配置 > 提供商 env var > Claude Code 注入
  const apiKey = provider.apiKey
    || process.env[provider.apiKeyEnv]
    || ccCreds.apiKey
    || '';
  const hasApiKey = apiKey.length > 0;

  // Base URL 优先级：Claude Code 注入 > 显式配置
  const effectiveBaseUrl = ccCreds.baseUrl || provider.baseUrl;

  // 根据 Claude Code 注入的 baseUrl 自动推断真实 API 格式
  let effectiveProvider = providerName;
  if (ccCreds.baseUrl) {
    // /anthropic 路径 → Anthropic Messages API 格式
    if (ccCreds.baseUrl.endsWith('/anthropic') || ccCreds.baseUrl.includes('api.anthropic.com')) effectiveProvider = 'anthropic';
    // 否则走 OpenAI 兼容格式（/v1 路径等）
    else if (ccCreds.baseUrl.endsWith('/v1') || ccCreds.baseUrl.includes('/v1/')) effectiveProvider = 'openai';
  }

  // 模型优先级：Claude Code 注入的 model 优先（跟随主机配置）
  // 剥掉 Claude Code 内部标记如 [1m]（API 不认）
  const cleanModel = (m: string) => m.replace(/\[\d+m\]/g, '').trim();
  const effectiveModel = cleanModel(ccCreds.model || provider.model);
  const effectiveFastModel = cleanModel(ccCreds.fastModel || provider.fastModel);
  const effectiveStrongModel = cleanModel(ccCreds.strongModel || provider.strongModel);

  return {
    ...provider,
    provider: effectiveProvider,
    baseUrl: effectiveBaseUrl,
    model: effectiveModel,
    fastModel: effectiveFastModel,
    strongModel: effectiveStrongModel,
    apiKey,
    hasApiKey,
  };
}

/** 解析 Commander 使用的模型名 */
export function resolveCommanderModel(provider: ActiveProvider, tier: ModelTier = 'balanced'): string {
  switch (tier) {
    case 'fast':
      return provider.fastModel || provider.model;
    case 'strong':
      return provider.strongModel || provider.model;
    default:
      return provider.model;
  }
}

export function getConfig(): GatewayConfig | null {
  return _config;
}
