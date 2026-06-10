/**
 * RightPanel.tsx — 右侧上下文面板 (State / Intent / MCP)
 *
 * 响应式宽度，窄终端自动隐藏。
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React from 'react';
import { Box, Text } from 'ink';
import { C } from '../colors.js';
import { truncate, getPanelWidth, shouldShowRightPanel } from '../utils.js';
import { SERVER_STATUS } from '@comdr/core';
import type { UIState } from '../types.js';

interface RightPanelProps {
  state: UIState;
  rows: number;
  cols: number;
}

export function RightPanel({ state, rows, cols }: RightPanelProps) {
  if (!shouldShowRightPanel(cols)) return null;

  // Header(1) + StatusLine(1) + TokenGauge(1) + TabBar(1) + Divider(1) + Footer(1) + Input/Search(1 when idle)
  const chromeRows = state.running ? 6 : 7;
  const panelHeight = rows - chromeRows;
  if (panelHeight <= 0) return null;

  const width = getPanelWidth(cols);

  return (
    <Box flexDirection="column" width={width} height={panelHeight} borderStyle="single" borderColor={C.dim} paddingLeft={1}>
      {/* State Window */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={C.accent}>State</Text>
        {state.stateWindow.length === 0
          ? <Text color={C.dim}>  (empty)</Text>
          : state.stateWindow.slice(-8).map((e, i) => (
            <Text key={i} color={C.dim}>
              {'  '}{truncate(`${e.key}: ${e.text}`, 40)}
            </Text>
          ))}
      </Box>

      {/* Intent Window */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={C.accent}>Intent</Text>
        {state.intentWindow.length === 0
          ? <Text color={C.dim}>  (empty)</Text>
          : state.intentWindow.slice(-5).map((e, i) => (
            <Text key={i} color={C.dim}>
              {'  '}{truncate(e.why, 40)}
            </Text>
          ))}
      </Box>

      {/* MCP Status */}
      {state.mcpServers.length > 0 && (
        <Box flexDirection="column">
          <Text bold color={C.accent}>MCP</Text>
          {state.mcpServers.map(s => {
            const connected = s.status === SERVER_STATUS.CONNECTED;
            const color = connected ? C.good : s.status === SERVER_STATUS.ERROR ? C.bad : C.dim;
            const icon = connected ? '✓' : s.status === SERVER_STATUS.ERROR ? '✗' : '○';
            return (
              <Box key={s.name} flexDirection="column">
                <Text color={color}>
                  {'  '}{icon} {s.name}
                </Text>
                {s.error && (
                  <Text color={C.bad}>    {truncate(s.error, 60)}</Text>
                )}
                {s.tools.length > 0 && (
                  <Text color={C.dim}>    tools: {s.tools.join(', ')}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
