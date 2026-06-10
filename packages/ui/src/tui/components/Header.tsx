/**
 * Header.tsx — 顶部状态栏
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React from 'react';
import { Box, Text } from 'ink';
import { C } from '../colors.js';
import { formatTokens } from '../utils.js';
import type { UIState } from '../types.js';

export function Header({ status }: { status: UIState['status'] }) {
  const modeLabel = status.mode === 'plan' ? 'plan' : status.mode === 'yolo' ? 'yolo' : 'agent';
  const modeColor = status.mode === 'plan' ? C.dim : status.mode === 'yolo' ? C.warn : C.accent;
  return (
    <Box height={1} paddingLeft={1}>
      <Text bold color={C.accent}>Comdr v0.3</Text>
      <Text color={C.dim}>{' · '}</Text>
      <Text>turn {status.turn}/{status.maxTurns}</Text>
      <Text color={C.dim}>{' · '}</Text>
      <Text>{formatTokens(status.tokensUsed)}/{formatTokens(status.tokenBudget)} miss</Text>
      <Text color={C.dim}>{' · '}</Text>
      <Text color={modeColor}>{modeLabel}</Text>
    </Box>
  );
}
