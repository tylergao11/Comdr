/**
 * TokenGauge.tsx — Token 用量可视化进度条
 *
 * 颜色随用量变化: 绿(<50%) → 黄(50-80%) → 橙(80-95%) → 红(>95%)
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React from 'react';
import { Box, Text } from 'ink';
import { C } from '../colors.js';
import { formatTokens, getGaugeColor } from '../utils.js';

interface TokenGaugeProps {
  used: number;
  budget: number;
  cols: number;
}

const GAUGE_WIDTH_RATIO = 0.4; // Use 40% of terminal width for the gauge bar

export function TokenGauge({ used, budget, cols }: TokenGaugeProps) {
  if (budget <= 0) return null;

  const ratio = Math.min(used / budget, 1);
  const percent = Math.round(ratio * 100);
  const color = getGaugeColor(ratio);

  const barWidth = Math.max(10, Math.floor(cols * GAUGE_WIDTH_RATIO));
  const filled = Math.floor(ratio * barWidth);
  const empty = barWidth - filled;

  // Build bar segments using different block chars for visual smoothness
  const filledBar = '█'.repeat(filled);
  const emptyBar = '░'.repeat(empty);

  return (
    <Box height={1} paddingLeft={1}>
      <Text color={C.dim}>Miss: </Text>
      <Text color={color}>[{filledBar}{emptyBar}]</Text>
      <Text color={C.dim}>{` ${percent}%  `}</Text>
      <Text>{formatTokens(used)}/{formatTokens(budget)}</Text>
    </Box>
  );
}
