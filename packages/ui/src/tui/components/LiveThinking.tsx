/**
 * LiveThinking.tsx — 流式 thinking 进行中
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React from 'react';
import { Box, Text } from 'ink';
import { C } from '../colors.js';
import { truncate, countThinkingSegments } from '../utils.js';

interface LiveThinkingProps {
  text: string;
  blink: boolean;
  show: boolean;
}

export function LiveThinking({ text, blink, show }: LiveThinkingProps) {
  if (!text) return null;
  const lastLine = text.split('\n').filter(Boolean).pop() ?? text;
  const segCount = countThinkingSegments(text).length;

  if (!show) {
    return (
      <Box paddingLeft={1} height={1}>
        <Text color={C.think}>💭 </Text>
        <Text color={C.dim}>{segCount} 段 · Ctrl+T 展开</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box>
        <Text color={C.think}>💭 </Text>
        <Text color={C.think} italic>{truncate(lastLine, 200)}</Text>
        <Text color={C.accent}>{blink ? '▍' : ' '}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color={C.dim}>{segCount} 段 · Ctrl+T 折叠</Text>
      </Box>
    </Box>
  );
}
