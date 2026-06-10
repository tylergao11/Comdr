/**
 * LiveText.tsx — 流式 text 进行中
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React from 'react';
import { Box, Text } from 'ink';
import { C } from '../colors.js';

interface LiveTextProps {
  text: string;
  blink: boolean;
}

export function LiveText({ text, blink }: LiveTextProps) {
  if (!text) return null;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box>
        <Text>{text.slice(-500)}</Text>
        <Text color={C.accent}>{blink ? '▍' : ' '}</Text>
      </Box>
    </Box>
  );
}

// ============================================================================
// TransitionSeparator — Thinking ↔ Text 转场
// ============================================================================

export function TransitionSeparator({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <Box paddingLeft={1}>
      <Text color={C.dim}>{'  ── ✦ ──'}</Text>
    </Box>
  );
}
