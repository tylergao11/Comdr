/**
 * ActiveTools.tsx — 活跃工具指示器
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React from 'react';
import { Box, Text } from 'ink';
import { C } from '../colors.js';
import { toolDisplayName } from '../utils.js';
import type { ToolCall } from '@comdr/core';

interface ActiveToolsProps {
  tools: Map<string, { call: ToolCall; status: string }>;
}

export function ActiveTools({ tools }: ActiveToolsProps) {
  if (tools.size === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {Array.from(tools.values()).map(t => {
        const isMCP = t.call.function.name === 'mcp_call' || t.call.function.name.startsWith('mcp__');
        return (
          <Box key={t.call.id}>
            <Text color={C.warn}>⏳ </Text>
            <Text color={isMCP ? C.accent : undefined}>
              {toolDisplayName(t.call.function.name, t.call.function.arguments)}
            </Text>
            <Text color={C.dim}> — {isMCP ? 'connecting...' : 'executing...'}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
