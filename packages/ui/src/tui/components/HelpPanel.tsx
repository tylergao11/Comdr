/**
 * HelpPanel.tsx — 帮助浮层
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React from 'react';
import { Box, Text } from 'ink';
import { C } from '../colors.js';

export function HelpPanel() {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={C.accent} paddingLeft={1} paddingRight={1}>
      <Text bold color={C.accent}>Keyboard Shortcuts</Text>
      <Text color={C.dim}>Ctrl+H   </Text><Text>Show this help</Text>
      <Text color={C.dim}>Ctrl+L   </Text><Text>New session</Text>
      <Text color={C.dim}>Ctrl+T   </Text><Text>Toggle thinking sections</Text>
      <Text color={C.dim}>Ctrl+P   </Text><Text>Toggle right panel</Text>
      <Text color={C.dim}>Ctrl+F   </Text><Text>Search messages</Text>
      <Text color={C.dim}>Ctrl+1/2/3 </Text><Text>Switch tabs (Messages/Files/Logs)</Text>
      <Text color={C.dim}>↑↓      </Text><Text>Navigate messages</Text>
      <Text color={C.dim}>Enter    </Text><Text>Expand selected message detail</Text>
      <Text color={C.dim}>Alt+↑↓   </Text><Text>Input history</Text>
      <Text color={C.dim}>Ctrl+C   </Text><Text>Abort & exit</Text>
    </Box>
  );
}
