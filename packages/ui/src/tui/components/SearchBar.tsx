/**
 * SearchBar.tsx — 消息搜索栏
 *
 * Ctrl+F 激活，输入搜索词实时高亮匹配。
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React, { useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { C } from '../colors.js';

interface SearchBarProps {
  active: boolean;
  query: string;
  matchCount: number;
  activeMatch: number;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onStop: () => void;
}

export function SearchBar({ active, query, matchCount, activeMatch, onQueryChange, onNext, onPrev, onStop }: SearchBarProps) {
  const bufferRef = useRef(query);

  useInput((input, key) => {
    if (!active) return;

    if (key.escape) {
      onStop();
      return;
    }

    if (key.return) {
      if (key.shift) {
        onPrev();
      } else {
        onNext();
      }
      return;
    }

    if (key.backspace || key.delete) {
      bufferRef.current = bufferRef.current.slice(0, -1);
      onQueryChange(bufferRef.current);
    } else if (input && !key.ctrl && !key.meta) {
      bufferRef.current += input;
      onQueryChange(bufferRef.current);
    }
  });

  if (!active) return null;

  return (
    <Box height={1} paddingLeft={1}>
      <Text color={C.accent} bold>Find: </Text>
      <Text>{query || ' '}</Text>
      <Text color={C.accent}>▍</Text>
      {query && (
        <Text color={C.dim}>
          {' '}{matchCount > 0 ? `${activeMatch + 1}/${matchCount}` : 'no matches'}
        </Text>
      )}
      <Text color={C.dim}>  Enter next · Shift+Enter prev · Esc exit</Text>
    </Box>
  );
}
