// ============================================================
// ProjectContext — Cocos Creator 项目自动发现
// 从 Comdr 移植的评分算法
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { normalizeSlash } from '../foundation/value-kit.js';

// ===== 类型 =====

export interface ProjectContextInput {
  mode?: 'discover' | 'validate';
  projectPath?: string;
  editorProjectPath?: string;
  cwd?: string;
  roots?: string[];
  maxDepth?: number;
}

export interface ProjectCandidate {
  schema: string;
  projectPath: string;
  projectName: string;
  score: number;
  markers: string[];
  source: string;
}

export interface ProjectContext {
  schema: string;
  status: string;
  kind: string;
  specialized: boolean;
  source: string;
  projectPath: string;
  projectName: string;
  reason: string;
  checkedPath: string;
  score: number;
  markers: string[];
  candidates: ProjectCandidate[];
  role: string;
  instruction: string;
}

const SCHEMA = 'Comdr.project-context.v1';

// ===== 评分 =====

const MARKER_FILES: Record<string, number> = {
  'project.json': 50,
  'assets/': 40,
  'settings/': 20,
  'packages/': 8,
  'local/': 5,
};

/** 对给定路径进行 Cocos 项目评分 */
export function scoreCocosProjectPath(projectPath: string): ProjectCandidate {
  const markers: string[] = [];
  let score = 0;

  for (const [file, points] of Object.entries(MARKER_FILES)) {
    const fullPath = path.join(projectPath, file);
    if (fs.existsSync(fullPath)) {
      markers.push(file);
      score += points;
    }
  }

  // 如果存在 .meta 文件额外加分
  try {
    const entries = fs.readdirSync(path.join(projectPath, 'assets'));
    const hasMeta = entries.some((e) => e.endsWith('.meta'));
    if (hasMeta) {
      markers.push('*.meta');
      score += 10;
    }
  } catch {
    // assets 不存在
  }

  const parts = normalizeSlash(projectPath).split('/');
  return {
    schema: SCHEMA,
    projectPath: normalizeSlash(projectPath),
    projectName: parts[parts.length - 1] || projectPath,
    score,
    markers,
    source: 'scored',
  };
}

// ===== 发现候选 =====

export function discoverCandidates(input: Partial<ProjectContextInput> = {}): ProjectCandidate[] {
  const cwd = input.cwd || process.cwd();
  const roots = input.roots || [cwd];
  const maxDepth = input.maxDepth || 3;
  const candidates: ProjectCandidate[] = [];

  for (const root of roots) {
    // 向上搜索
    let current = normalizeSlash(root);
    for (let i = 0; i < 5; i++) {
      const candidate = scoreCocosProjectPath(current);
      if (candidate.score >= 50) {
        // 有 project.json 就是强信号
        candidates.push(candidate);
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = normalizeSlash(parent);
    }

    // 向下搜索（最多 maxDepth 层）
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }
        const subPath = normalizeSlash(path.join(root, entry.name));
        _scanDir(subPath, maxDepth, candidates);
      }
    } catch {
      // 不可读目录
    }
  }

  // 按分数降序排序
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function _scanDir(dir: string, depth: number, candidates: ProjectCandidate[]): void {
  if (depth <= 0) return;
  const candidate = scoreCocosProjectPath(dir);
  if (candidate.score >= 70) {
    candidates.push(candidate);
    return; // 找到就停止深入
  }
  // 继续深入子目录
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      _scanDir(path.join(dir, entry.name), depth - 1, candidates);
    }
  } catch {
    // ignore
  }
}

// ===== 主入口 =====

export function resolveProjectContext(input: ProjectContextInput = {}): ProjectContext {
  const mode = input.mode || 'discover';

  // 验证模式
  if (mode === 'validate' && input.projectPath) {
    const candidate = scoreCocosProjectPath(input.projectPath);
    const specialized = candidate.score >= 70;
    return {
      schema: SCHEMA,
      status: specialized ? 'specialized_project_selected' : 'general_workspace',
      kind: specialized ? 'cocos_project' : 'general',
      specialized,
      source: 'validated',
      projectPath: normalizeSlash(input.projectPath),
      projectName: candidate.projectName,
      reason: specialized
        ? `Found Cocos project: ${candidate.projectName} (score: ${candidate.score})`
        : `Not a Cocos project (score: ${candidate.score}). Running in general mode.`,
      checkedPath: normalizeSlash(input.projectPath),
      score: candidate.score,
      markers: candidate.markers,
      candidates: [candidate],
      role: specialized
        ? 'Cocos Creator project — Comdr can operate scenes and prefabs.'
        : 'General workspace — provide a Cocos project path to enable Comdr.',
      instruction: specialized
        ? 'Use Comdr to create/edit UI, manage assets, operate the Cocos editor.'
        : 'Specify a Cocos project path to enable full Comdr capabilities.',
    };
  }

  // 发现模式
  const cwd = input.cwd || process.cwd();
  const candidates = discoverCandidates({ ...input, cwd });
  const best = candidates[0];

  if (best && best.score >= 70) {
    return {
      schema: SCHEMA,
      status: 'specialized_project_selected',
      kind: 'cocos_project',
      specialized: true,
      source: 'discovered',
      projectPath: best.projectPath,
      projectName: best.projectName,
      reason: `Auto-discovered Cocos project: ${best.projectName} (score: ${best.score})`,
      checkedPath: normalizeSlash(cwd),
      score: best.score,
      markers: best.markers,
      candidates,
      role: 'Cocos Creator project — Comdr can operate scenes and prefabs.',
      instruction: 'Use Comdr to create/edit UI, manage assets, operate the Cocos editor.',
    };
  }

  return {
    schema: SCHEMA,
    status: 'general_workspace',
    kind: 'general',
    specialized: false,
    source: 'discovered',
    projectPath: normalizeSlash(cwd),
    projectName: path.basename(cwd),
    reason: 'No Cocos project found. Running in general mode.',
    checkedPath: normalizeSlash(cwd),
    score: best?.score || 0,
    markers: best?.markers || [],
    candidates,
    role: 'General workspace.',
    instruction: 'Specify a Cocos project path to enable Comdr.',
  };
}

export function isSpecializedProjectContext(ctx: ProjectContext): boolean {
  return ctx.specialized;
}
