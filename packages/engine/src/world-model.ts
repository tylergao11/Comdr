/**
 * world-model.ts — comdr.md 多源自动发现
 *
 * 合并三个来源的 comdr.md 内容，注入到每轮 prompt 的 L1 System Prompt 之后。
 *
 * 来源优先级（后面的追加到前面之后，不覆盖）:
 *   1. ~/.comdr/comdr.md            — 用户全局编码偏好
 *   2. ~/.comdr/world-models/*.md   — 外部 Agent 安装的世界模型（Cocos、Comdr-Art 等）
 *   3. {projectPath}/comdr.md       — 项目专属指令
 *
 * world-models/ 目录由各 Comdr Agent 安装时写入。
 * 例如 Comdr-Engine 安装后写入 cocos.md，Comdr-Art 写入 comdr-art.md。
 *
 * 注入位置: prompt.ts 中 L1 System Prompt 之后，同会话不变 → DeepSeek 前缀缓存友好。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 多源发现并合并 comdr.md 内容。
 *
 * @param projectPath  项目根目录
 * @param comdrMdPath  项目级 comdr.md 的相对路径（默认 "comdr.md"）
 * @returns 合并后的完整 comdr.md 内容。所有来源都不存在时返回空串。
 */
export function discoverComdrMd(
  projectPath: string,
  comdrMdPath: string = 'comdr.md',
): string {
  const sections: string[] = [];
  const home = homedir();

  // 1. 全局: ~/.comdr/comdr.md
  const globalPath = join(home, '.comdr', 'comdr.md');
  if (existsSync(globalPath)) {
    const content = safeRead(globalPath);
    if (content) sections.push(content);
  }

  // 2. World models: ~/.comdr/world-models/*.md
  const worldModelsDir = join(home, '.comdr', 'world-models');
  if (existsSync(worldModelsDir)) {
    try {
      const files = readdirSync(worldModelsDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      for (const file of files) {
        const content = safeRead(join(worldModelsDir, file));
        if (content) {
          const label = file.replace(/\.md$/, '');
          sections.push(`## ${label}\n\n${content}`);
        }
      }
    } catch {
      // 目录存在但不可读 → 跳过
    }
  }

  // 3. 项目级: {projectPath}/comdr.md
  const projectPath_ = join(projectPath, comdrMdPath);
  if (existsSync(projectPath_)) {
    const content = safeRead(projectPath_);
    if (content) sections.push(content);
  }

  return sections.join('\n\n---\n\n');
}

/**
 * 安全读取文件内容，失败返回 null。
 */
function safeRead(path: string): string | null {
  try {
    const content = readFileSync(path, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}
