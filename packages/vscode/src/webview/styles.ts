/**
 * styles.ts — Comdr Webview 主题
 *
 * 所有颜色使用 VS Code CSS 自定义属性，自动适配亮/暗主题。
 * 常量值作为 fallback。
 */

export const theme = {
  colors: {
    fg:           'var(--vscode-editor-foreground, #d4d4d4)',
    muted:        'var(--vscode-descriptionForeground, #a0a0a0)',
    accent:       'var(--vscode-textLink-foreground, #3794ff)',
    link:         'var(--vscode-textLink-foreground, #3794ff)',
    ok:           'var(--vscode-terminal-ansiGreen, #4ec9b0)',
    warn:         'var(--vscode-terminal-ansiYellow, #cca700)',
    err:          'var(--vscode-errorForeground, #f14c4c)',
    border:       'var(--vscode-panel-border, #3c3c3c)',
    bg:           'var(--vscode-sideBar-background, #252526)',
    bgSurface:    'var(--vscode-editor-background, #1e1e1e)',
    bgCard:       'var(--vscode-input-background, #3c3c3c)',
    bgHighlight:  'var(--vscode-list-hoverBackground, #2a2d2e)',
    bgDiffRemoved:'var(--vscode-diffEditor-removedTextBackground, #3b1b1b)',
    bgDiffAdded:  'var(--vscode-diffEditor-insertedTextBackground, #1b3b1b)',
    okButton:     'var(--vscode-terminal-ansiGreen, #4ec9b0)',
    dangerButton: 'var(--vscode-errorForeground, #f14c4c)',
  },
  fonts: {
    sans: 'var(--vscode-font-family, system-ui, sans-serif)',
    mono: 'var(--vscode-editor-font-family, "Cascadia Code", Consolas, monospace)',
  },
  fontSizes: {
    xs:  '11px',
    sm:  '13px',
    md:  '15px',
    lg:  '18px',
  },
} as const;
