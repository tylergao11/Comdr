/**
 * MessageLine.tsx — 单条消息渲染
 *
 * 支持 Markdown 代码块、行内代码、粗体渲染。
 *
 * @agent Agent 5 — TUI 渲染器
 */

import React from 'react';
import { Box, Text } from 'ink';
import { C } from '../colors.js';
import { truncate, countThinkingSegments, parseMarkdown } from '../utils.js';
import type { MarkdownSegment } from '../utils.js';
import type { MessageItem } from '../types.js';
import { DiffView } from './DiffView.js';

interface MessageLineProps {
  msg: MessageItem;
  expanded?: boolean;
  showDetail?: boolean;
}

export function MessageLine({ msg, expanded, showDetail }: MessageLineProps) {
  const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  switch (msg.type) {
    case 'separator':
      return (
        <Box paddingLeft={1}>
          <Text color={C.dim}>{'  ── ✦ ──'}</Text>
        </Box>
      );

    case 'thinking': {
      const segments = countThinkingSegments(msg.content);
      const label = msg.detail ?? `${segments.length} 段思考`;
      if (!expanded) {
        return (
          <Box paddingLeft={1}>
            <Text color={C.think}>💭 {label}</Text>
            <Text color={C.dim}>  Ctrl+T 展开</Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column" paddingLeft={1}>
          <Box>
            <Text color={C.think}>💭 {label}</Text>
            <Text color={C.dim}>  Ctrl+T 折叠</Text>
          </Box>
          {segments.map((seg, i) => (
            <Box key={i} paddingLeft={4}>
              <Text color={C.think} italic>{`#${i + 1}  ${truncate(seg, 120)}`}</Text>
            </Box>
          ))}
        </Box>
      );
    }

    case 'user':
      return (
        <Box paddingLeft={1}>
          <Text backgroundColor={C.accent} color="white" bold> {msg.content} </Text>
        </Box>
      );

    case 'text':
      return <MarkdownContent text={msg.content} />;

    case 'tool_call':
      return (
        <Box paddingLeft={1}>
          <Text color={C.dim}>{time}  </Text>
          <Text color={C.accent}>{msg.content}</Text>
          {msg.detail ? <Text color={C.dim}>  {truncate(msg.detail, 55)}</Text> : null}
        </Box>
      );

    case 'tool_result': {
      const ok = msg.content.startsWith('✓');
      return (
        <Box flexDirection="column" paddingLeft={3}>
          <Box>
            <Text color={ok ? C.good : C.bad}>{msg.content}</Text>
          </Box>
          {!ok && msg.detail && (
            <Box paddingLeft={2}>
              <Text color={C.dim}>{truncate(msg.detail, 120)}</Text>
            </Box>
          )}
          {/* ★ Diff view for successful file edits */}
          {ok && showDetail && msg.detail && (
            <Box paddingLeft={2} flexDirection="column">
              <DiffView content={msg.detail} maxLines={30} />
            </Box>
          )}
        </Box>
      );
    }

    case 'warning':
      return (
        <Box paddingLeft={1}>
          <Text color={C.warn}>{msg.content}</Text>
        </Box>
      );

    case 'error':
      return (
        <Box paddingLeft={1}>
          <Text color={C.bad}>{msg.content}</Text>
        </Box>
      );

    case 'info':
      return (
        <Box paddingLeft={1}>
          <Text color={C.dim}>{msg.content}</Text>
        </Box>
      );

    default:
      return (
        <Box paddingLeft={1}>
          <Text>{msg.content}</Text>
        </Box>
      );
  }
}

// ============================================================================
// MarkdownContent — 轻量 Markdown 渲染
// ============================================================================

function MarkdownContent({ text }: { text: string }) {
  // Quick check: if no markdown markers, render as plain text
  if (!text.includes('```') && !text.includes('`') && !text.includes('**')) {
    return (
      <Box paddingLeft={1}>
        <Text>{text}</Text>
      </Box>
    );
  }

  const segments = parseMarkdown(text);

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {segments.map((seg, i) => (
        <MarkdownSegment key={i} seg={seg} />
      ))}
    </Box>
  );
}

function MarkdownSegment({ seg }: { seg: MarkdownSegment }) {
  switch (seg.type) {
    case 'code':
      return <CodeBlock code={seg.content} language={seg.language} />;
    case 'inline_code':
      return (
        <Box>
          <Text backgroundColor={C.bg} color={C.accent}>{seg.content}</Text>
        </Box>
      );
    case 'bold':
      return (
        <Box>
          <Text bold>{seg.content}</Text>
        </Box>
      );
    case 'text':
    default:
      return (
        <Box>
          <Text>{seg.content}</Text>
        </Box>
      );
  }
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const lines = code.split('\n');
  const displayLines = lines.slice(0, 30); // Max 30 lines per code block
  const truncated = lines.length > 30;

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {language && (
        <Box>
          <Text color={C.dim}>{`┌─ ${language} ───`}</Text>
        </Box>
      )}
      <Box flexDirection="column" paddingLeft={2}>
        {displayLines.map((line, i) => (
          <Text key={i} color={C.think}>{line || ' '}</Text>
        ))}
        {truncated && (
          <Text color={C.dim}>... ({lines.length - 30} more lines)</Text>
        )}
      </Box>
      <Box>
        <Text color={C.dim}>└──</Text>
      </Box>
    </Box>
  );
}
