/**
 * StatusLine.tsx — LLM 连接状态行
 *
 * 显示: 连接状态 · 流式阶段 · 缓存命中率 · 最后一轮耗时
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React from 'react';
import { Box, Text } from 'ink';
import { C } from '../colors.js';
import type { ConnectionPhase } from '../types.js';

interface StatusLineProps {
  phase: ConnectionPhase;
  cacheHitRate: number;
  running: boolean;
}

const PHASE_LABELS: Record<ConnectionPhase, { icon: string; label: string; color: string }> = {
  idle:       { icon: '○', label: 'Idle', color: C.dim },
  connecting: { icon: '◌', label: 'Connecting...', color: C.warn },
  thinking:   { icon: '●', label: 'Thinking...', color: C.think },
  generating: { icon: '●', label: 'Generating...', color: C.good },
  executing_tool: { icon: '●', label: 'Executing tool...', color: C.accent },
  completed:  { icon: '✓', label: 'Completed', color: C.good },
  error:      { icon: '✗', label: 'Error', color: C.bad },
};

export function StatusLine({ phase, cacheHitRate, running }: StatusLineProps) {
  const info = PHASE_LABELS[phase];

  return (
    <Box height={1} paddingLeft={1}>
      <Text color={info.color}>{info.icon} {info.label}</Text>
      {running && (
        <>
          <Text color={C.dim}>{' · '}</Text>
          {cacheHitRate > 0 && (
            <>
              <Text color={C.dim}>Cache: </Text>
              <Text color={C.good}>{Math.round(cacheHitRate * 100)}%</Text>
              <Text color={C.dim}>{' · '}</Text>
            </>
          )}
          <Text color={C.dim}>DeepSeek V4</Text>
        </>
      )}
    </Box>
  );
}
