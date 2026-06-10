/**
 * TabBar.tsx — Tab 切换栏
 *
 * Messages | Files | Logs
 * 快捷键: Ctrl+1/2/3 或 Ctrl+Tab / Ctrl+Shift+Tab
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React from 'react';
import { Box, Text } from 'ink';
import { C } from '../colors.js';
import type { TabId } from '../types.js';

interface TabDef {
  id: TabId;
  label: string;
  shortcut: string;
}

const TABS: TabDef[] = [
  { id: 'messages', label: 'Messages', shortcut: '1' },
  { id: 'files', label: 'Files', shortcut: '2' },
  { id: 'logs', label: 'Logs', shortcut: '3' },
];

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function TabBar({ activeTab, onTabChange }: TabBarProps) {
  return (
    <Box height={1} paddingLeft={1}>
      {TABS.map((tab, i) => {
        const isActive = tab.id === activeTab;
        return (
          <Box key={tab.id}>
            {i > 0 && <Text color={C.dim}>  </Text>}
            <Text
              color={isActive ? C.accent : C.dim}
              bold={isActive}
            >
              {isActive ? '[' : ' '}{tab.label}{isActive ? ']' : ' '}
            </Text>
          </Box>
        );
      })}
      <Text color={C.dim}>  Ctrl+1/2/3</Text>
    </Box>
  );
}
