/**
 * DiffView.tsx — Diff 可视化组件
 *
 * 解析 diff 文本，绿色 +行，红色 -行。
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React from 'react';
import { Box, Text } from 'ink';
import { C } from '../colors.js';
import { parseDiffLines } from '../utils.js';
import type { DiffLine } from '../utils.js';

interface DiffViewProps {
  content: string;
  maxLines?: number;
}

export function DiffView({ content, maxLines = 30 }: DiffViewProps) {
  // Check if content looks like a diff
  if (!content.includes('+') && !content.includes('-') && !content.includes('@@')) {
    // Not a diff — render as plain detail
    const lines = content.split('\n').slice(0, maxLines);
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i} color={C.dim}>{line.slice(0, 120)}</Text>
        ))}
        {content.split('\n').length > maxLines && (
          <Text color={C.dim}>... truncated</Text>
        )}
      </Box>
    );
  }

  const diffLines = parseDiffLines(content);
  const displayLines = diffLines.slice(0, maxLines);

  return (
    <Box flexDirection="column">
      {displayLines.map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
      {diffLines.length > maxLines && (
        <Text color={C.dim}>... ({diffLines.length - maxLines} more lines)</Text>
      )}
    </Box>
  );
}

function DiffLine({ line }: { line: DiffLine }) {
  switch (line.type) {
    case 'add':
      return (
        <Text color={C.good}>{line.text.slice(0, 120)}</Text>
      );
    case 'remove':
      return (
        <Text color={C.bad}>{line.text.slice(0, 120)}</Text>
      );
    case 'header':
      return (
        <Text bold color={C.info}>{line.text.slice(0, 120)}</Text>
      );
    case 'context':
    default:
      return (
        <Text color={C.dim}>{line.text.slice(0, 120)}</Text>
      );
  }
}
