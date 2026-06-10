/**
 * Footer.tsx — 底部快捷键提示栏（上下文敏感）
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React from 'react';
import { Box, Text } from 'ink';
import { C } from '../colors.js';

interface FooterProps {
  running: boolean;
  searching: boolean;
  autoScrollLock: boolean;
}

export function Footer({ running, searching, autoScrollLock }: FooterProps) {
  if (searching) {
    return (
      <Box height={1} paddingLeft={1}>
        <Text color={C.dim}>Enter next  </Text>
        <Text color={C.dim}>Shift+Enter prev  </Text>
        <Text color={C.dim}>Esc exit search</Text>
      </Box>
    );
  }

  if (running) {
    return (
      <Box height={1} paddingLeft={1}>
        <Text color={C.dim}>Ctrl+C 中止  </Text>
        <Text color={C.dim}>Ctrl+T 思考  </Text>
        <Text color={C.dim}>Ctrl+P 面板</Text>
        {autoScrollLock && <Text color={C.warn}>  [Locked]</Text>}
      </Box>
    );
  }

  return (
    <Box height={1} paddingLeft={1}>
      <Text color={C.dim}>Ctrl+H help  </Text>
      <Text color={C.dim}>Ctrl+L new  </Text>
      <Text color={C.dim}>Ctrl+T think  </Text>
      <Text color={C.dim}>Ctrl+P panel  </Text>
      <Text color={C.dim}>Ctrl+F find  </Text>
      <Text color={C.dim}>Ctrl+1/2/3 tab  </Text>
      <Text color={C.dim}>↑↓ nav  </Text>
      <Text color={C.dim}>Ctrl+C exit</Text>
      {autoScrollLock && <Text color={C.warn}>  [Locked]</Text>}
    </Box>
  );
}
