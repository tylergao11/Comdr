// ============================================================
// Overlay Launcher — 自动拉起桌面悬浮窗
// 原 mcp-server 逻辑上移至 core，供子 agent 直接调用
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { OVERLAY_ALIVE_MAX_AGE_MS, OVERLAY_LOCK_TIMEOUT_MS } from '../foundation/constants.js';

/** 确保 Overlay 在运行 — 幂等，可重复调用 */
export function ensureOverlayRunning(projectPath: string): void {
  const { HOME, USERPROFILE } = process.env;
  const home = HOME || USERPROFILE || '.';
  const alivePath = path.join(home, '.comdr', 'overlay-alive');
  const configPath = path.join(home, '.comdr', 'overlay-config.json');
  const lockPath = path.join(home, '.comdr', 'overlay-launching.lock');

  try {
    // 同步 project_path 到 overlay 配置
    try {
      let cfg: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
      if (cfg.project_path !== projectPath) {
        cfg.project_path = projectPath;
        const dir = path.join(home, '.comdr');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      }
    } catch {
      // 非致命
    }

    // 心跳有效 → overlay 还活着
    if (fs.existsSync(alivePath)) {
      const age = Date.now() - Number(fs.readFileSync(alivePath, 'utf8'));
      if (age < OVERLAY_ALIVE_MAX_AGE_MS) {
        try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch { /* */ }
        return;
      }
    }

    // 原子锁
    if (!acquireOverlayLock(lockPath)) return;

    const bin = findOverlayBinary();
    if (!bin) {
      try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch { /* */ }
      return;
    }

    const proc = spawn(bin, [], { detached: true, stdio: 'ignore', shell: true });
    proc.unref();
    process.stderr.write(`[comdr] Overlay launched: ${bin}\n`);
  } catch (e) {
    process.stderr.write(`[comdr] overlay launch failed: ${(e as Error).message}\n`);
  }
}

function acquireOverlayLock(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, String(Date.now()));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        const age = Date.now() - Number(fs.readFileSync(lockPath, 'utf8'));
        if (age > OVERLAY_LOCK_TIMEOUT_MS) {
          fs.unlinkSync(lockPath);
          return acquireOverlayLock(lockPath);
        }
      } catch { /* */ }
      return false;
    }
    return false;
  }
}

function findOverlayBinary(): string | null {
  const exeName = process.platform === 'win32' ? 'comdr-overlay.exe' : 'comdr-overlay';

  // 1. 环境变量
  const envPath = process.env.COMDR_OVERLAY_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  // 2. ~/.comdr/overlay/
  const { HOME, USERPROFILE } = process.env;
  const home = HOME || USERPROFILE || '.';
  const stdPath = path.join(home, '.comdr', 'overlay', exeName);
  if (fs.existsSync(stdPath)) return stdPath;

  // 3. monorepo 开发环境
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const distBin = path.join(dir, 'packages', 'overlay', 'dist-bin', exeName);
    if (fs.existsSync(distBin)) return distBin;
    const base = path.join(dir, 'packages', 'overlay', 'src-tauri', 'target');
    for (const profile of ['release', 'debug']) {
      const exe = path.join(base, profile, exeName);
      if (fs.existsSync(exe)) return exe;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 4. cwd
  const cwd = process.cwd();
  const cwdDistBin = path.join(cwd, 'packages', 'overlay', 'dist-bin', exeName);
  if (fs.existsSync(cwdDistBin)) return cwdDistBin;
  const fromCwd = path.join(cwd, 'packages', 'overlay', 'src-tauri', 'target');
  for (const profile of ['release', 'debug']) {
    const exe = path.join(fromCwd, profile, exeName);
    if (fs.existsSync(exe)) return exe;
  }

  return null;
}
