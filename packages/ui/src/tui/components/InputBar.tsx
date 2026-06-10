/**
 * InputBar.tsx — 输入栏（含输入历史）
 *
 * Alt+↑/↓ 浏览输入历史，Enter 提交。
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React, { useState, useRef, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { C } from '../colors.js';

const MAX_HISTORY = 100;

interface InputBarProps {
  onSubmit: (text: string) => void;
  disabled: boolean;
}

export function InputBar({ onSubmit, disabled }: InputBarProps) {
  const [buffer, setBuffer] = useState('');
  const inputRef = useRef('');
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  const savedDraftRef = useRef<string>('');

  const pushHistory = useCallback((text: string) => {
    const h = historyRef.current;
    // Deduplicate consecutive identical entries
    if (h.length > 0 && h[0] === text) return;
    h.unshift(text);
    if (h.length > MAX_HISTORY) h.pop();
  }, []);

  const navigateHistory = useCallback((dir: 'up' | 'down') => {
    const h = historyRef.current;
    if (h.length === 0) return;

    if (dir === 'up') {
      // Save current draft before navigating
      if (historyIdxRef.current === -1) {
        savedDraftRef.current = inputRef.current;
      }
      const next = Math.min(historyIdxRef.current + 1, h.length - 1);
      historyIdxRef.current = next;
      inputRef.current = h[next] ?? '';
      setBuffer(inputRef.current);
    } else {
      const next = historyIdxRef.current - 1;
      if (next < 0) {
        historyIdxRef.current = -1;
        inputRef.current = savedDraftRef.current;
      } else {
        historyIdxRef.current = next;
        inputRef.current = h[next] ?? '';
      }
      setBuffer(inputRef.current);
    }
  }, []);

  useInput((input, key) => {
    if (disabled) return;

    // Alt+Up: navigate history up
    if (key.upArrow && key.meta) {
      navigateHistory('up');
      return;
    }
    // Alt+Down: navigate history down
    if (key.downArrow && key.meta) {
      navigateHistory('down');
      return;
    }

    if (key.return) {
      const trimmed = inputRef.current.trim();
      if (trimmed) {
        pushHistory(trimmed);
        historyIdxRef.current = -1;
        onSubmit(trimmed);
        inputRef.current = '';
        setBuffer('');
      }
    } else if (key.backspace || key.delete) {
      inputRef.current = inputRef.current.slice(0, -1);
      setBuffer(inputRef.current);
      historyIdxRef.current = -1;
    } else if (input && !key.ctrl && !key.meta) {
      inputRef.current += input;
      setBuffer(inputRef.current);
      historyIdxRef.current = -1;
    }
  });

  return (
    <Box>
      {buffer ? <Text>{buffer}</Text> : <Text color={C.dim}>输入需求… (Alt+↑↓ 历史)</Text>}
      <Text color={C.dim}>▍</Text>
    </Box>
  );
}
