/**
 * ConfirmDialog.tsx — 确认对话框
 *
 * Agent 模式下，破坏性操作暂停确认。
 * Modal overlay，Enter 确认，Esc 取消。
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { C } from '../colors.js';
import { truncate } from '../utils.js';
import type { PendingConfirm } from '../types.js';

interface ConfirmDialogProps {
  confirm: PendingConfirm;
  onApprove: () => void;
  onDeny: () => void;
}

export function ConfirmDialog({ confirm, onApprove, onDeny }: ConfirmDialogProps) {
  const [selected, setSelected] = useState<'approve' | 'deny'>('deny');

  useInput((input, key) => {
    if (key.return) {
      if (selected === 'approve') onApprove();
      else onDeny();
      return;
    }
    if (key.escape) {
      onDeny();
      return;
    }
    if (input === 'y' || input === 'Y') {
      onApprove();
      return;
    }
    if (input === 'n' || input === 'N') {
      onDeny();
      return;
    }
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      setSelected(s => s === 'approve' ? 'deny' : 'approve');
    }
  });

  const argsStr = JSON.stringify(confirm.args, null, 2);
  const truncatedArgs = truncate(argsStr, 200);

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={C.warn} paddingLeft={2} paddingRight={2}>
      <Box marginBottom={1}>
        <Text bold color={C.warn}>⚠ 确认执行危险操作</Text>
      </Box>

      <Box marginBottom={1}>
        <Text bold>工具: </Text>
        <Text color={C.accent}>{confirm.toolName}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold>参数:</Text>
        <Box paddingLeft={2}>
          <Text color={C.dim}>{truncatedArgs}</Text>
        </Box>
      </Box>

      <Box marginBottom={1}>
        <Box marginRight={2}>
          <Text color={selected === 'approve' ? C.good : C.dim}>
            {selected === 'approve' ? '▶ ' : '  '}
            [Enter] 确认执行
          </Text>
        </Box>
        <Box>
          <Text color={selected === 'deny' ? C.bad : C.dim}>
            {selected === 'deny' ? '▶ ' : '  '}
            [Esc/n] 取消
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
