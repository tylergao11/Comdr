/**
 * install-global.mjs — 将 comdr 安装到全局 PATH
 *
 * 在任何电脑上只需三步:
 *   pnpm install
 *   pnpm setup          (pnpm 自带——配 PATH，只需运行一次)
 *   pnpm -w run link    (build + 全局安装)
 *
 * 之后在任意目录:
 *   comdr "hello"
 */

import { execSync } from 'node:child_process';
import { writeFileSync, chmodSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const cliPath = resolve(rootDir, 'packages', 'ui', 'dist', 'cli.js');
const isWindows = process.platform === 'win32';

// ── 1. 找全局 bin 目录 ──
// 按优先级尝试多个来源

function findBinDir() {
  // 1) PNPM_HOME 环境变量
  const pnpmHome = process.env.PNPM_HOME;
  if (pnpmHome) {
    const d = resolve(pnpmHome, 'bin');
    if (existsSync(d)) return d;
  }

  // 2) 运行 pnpm bin -g（需 pnpm 在 PATH 中）
  try {
    const d = execSync('pnpm bin -g', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    if (d && existsSync(d)) return d;
  } catch { /* fall through */ }

  // 3) npm prefix fallback
  try {
    const prefix = execSync('npm config get prefix', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    if (prefix) {
      const d = isWindows ? prefix : resolve(prefix, 'bin');
      if (existsSync(d)) return d;
    }
  } catch { /* fall through */ }

  // 4) 平台标准位置
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local');
    return resolve(localAppData, 'pnpm', 'bin');
  } else {
    return resolve(homedir(), '.local', 'bin');
  }
}

const binDir = findBinDir();
mkdirSync(binDir, { recursive: true });

// ── 2. 创建 shim ──
if (isWindows) {
  const cmd = `@echo off\r\nnode "${cliPath}" %*\r\n`;
  const cmdPath = resolve(binDir, 'comdr.cmd');
  writeFileSync(cmdPath, cmd, 'ascii');
  console.log(`✓  comdr.cmd → ${cmdPath}`);
} else {
  const sh = `#!/usr/bin/env sh\nnode "${cliPath}" "$@"\n`;
  const shPath = resolve(binDir, 'comdr');
  writeFileSync(shPath, sh, { mode: 0o755 });
  chmodSync(shPath, 0o755);
  console.log(`✓  comdr → ${shPath}`);
}

// ── 3. 部署预置 World Models ──
const worldModelsDir = resolve(homedir(), '.comdr', 'world-models');
const sourceModelsDir = resolve(rootDir, 'world-models');
if (existsSync(sourceModelsDir)) {
  mkdirSync(worldModelsDir, { recursive: true });
  try {
    const files = readdirSync(sourceModelsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      copyFileSync(
        resolve(sourceModelsDir, file),
        resolve(worldModelsDir, file),
      );
    }
    console.log(`✓  World Models: ${files.length} 个框架知识已部署到 ${worldModelsDir}`);
  } catch (err) {
    console.log(`⚠  World Model 部署失败: ${err.message}`);
  }
}

// ── 4. 提示 PATH ──
const inPath = process.env.PATH?.split(isWindows ? ';' : ':').some(
  (p) => p.trim().toLowerCase() === binDir.toLowerCase(),
);
if (!inPath) {
  console.log(`\n⚠  请将以下路径加入 PATH:`);
  console.log(`   ${binDir}`);
  if (isWindows) {
    console.log(`   setx PATH "%PATH%;${binDir}"  (或运行 pnpm setup)`);
  } else {
    console.log(`   echo 'export PATH="${binDir}:$PATH"' >> ~/.bashrc`);
  }
}

console.log(`\n✓  安装完成 — 在任意目录运行 comdr 即可`);
