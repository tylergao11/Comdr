/**
 * ConfigSetup.tsx — 首次配置启动画面
 *
 * 当 API key 等必填字段缺失时显示，让用户在 UI 内完成配置。
 * 无需离开 VS Code 去编辑配置文件或环境变量。
 */

import { useState, useCallback } from 'react';
import type { WebviewMessage } from './types.js';
import { theme } from './styles.js';
import { vscodeApi } from './vscode-api.js';

interface ConfigSetupProps {
  missingFields: string[];
}

export function ConfigSetup({ missingFields }: ConfigSetupProps): JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com');
  const [model, setModel] = useState('deepseek-v4-pro');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsApiKey = missingFields.includes('llm.apiKey (required)');

  const handleSubmit = useCallback(() => {
    if (!apiKey.trim()) {
      setError('API Key is required');
      return;
    }
    setSubmitting(true);
    setError(null);

    vscodeApi.postMessage({
      type: 'submitConfig',
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim() || undefined,
      model: model.trim() || undefined,
    } as WebviewMessage);
  }, [apiKey, baseUrl, model]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !submitting) {
      handleSubmit();
    }
  }, [handleSubmit, submitting]);

  return (
    <div style={styles.wrapper}>
      <div style={styles.card}>
        {/* Header */}
        <div style={styles.header}>
          <h1 style={styles.title}>Comdr</h1>
          <p style={styles.subtitle}>
            DeepSeek V4 powered coding agent
          </p>
        </div>

        {/* Form */}
        <div style={styles.form}>
          {needsApiKey && (
            <div style={styles.field}>
              <label style={styles.label}>
                API Key <span style={styles.required}>*</span>
              </label>
              <input
                type="password"
                style={styles.input}
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
              />
              <span style={styles.hint}>
                Get your key at{' '}
                <a
                  href="https://platform.deepseek.com/api_keys"
                  style={styles.link}
                  target="_blank"
                  rel="noreferrer"
                >
                  platform.deepseek.com
                </a>
              </span>
            </div>
          )}

          <div style={styles.field}>
            <label style={styles.label}>Base URL</label>
            <input
              type="text"
              style={styles.input}
              placeholder="https://api.deepseek.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Model</label>
            <input
              type="text"
              style={styles.input}
              placeholder="deepseek-v4-pro"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>

          {error && (
            <div style={styles.errorBanner}>
              ⚠ {error}
            </div>
          )}

          <button
            style={{
              ...styles.button,
              opacity: submitting ? 0.6 : 1,
            }}
            disabled={submitting}
            onClick={handleSubmit}
          >
            {submitting ? 'Connecting...' : 'Connect'}
          </button>

          <p style={styles.footer}>
            Config is saved for this session.{' '}
            Create <code style={styles.code}>.comdr.toml</code> or set{' '}
            <code style={styles.code}>COMDR_API_KEY</code> env var for persistent config.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
  },
  card: {
    maxWidth: '420px',
    width: '100%',
  },
  header: {
    textAlign: 'center' as const,
    marginBottom: '32px',
  },
  title: {
    fontSize: '28px',
    fontWeight: 700,
    color: theme.colors.fg,
    margin: 0,
  },
  subtitle: {
    fontSize: theme.fontSizes.sm,
    color: theme.colors.muted,
    marginTop: '8px',
    marginBottom: 0,
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
  },
  field: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  label: {
    fontSize: theme.fontSizes.sm,
    fontWeight: 600,
    color: theme.colors.fg,
  },
  required: {
    color: theme.colors.err,
  },
  input: {
    padding: '8px 12px',
    border: `1px solid ${theme.colors.border}`,
    borderRadius: '4px',
    background: theme.colors.bgCard,
    color: theme.colors.fg,
    fontFamily: theme.fonts.mono,
    fontSize: theme.fontSizes.sm,
    outline: 'none',
  },
  hint: {
    fontSize: theme.fontSizes.xs,
    color: theme.colors.muted,
  },
  link: {
    color: theme.colors.link,
    textDecoration: 'none',
  },
  errorBanner: {
    padding: '8px 12px',
    borderRadius: '4px',
    background: theme.colors.bgDiffRemoved,
    color: theme.colors.err,
    fontSize: theme.fontSizes.sm,
  },
  button: {
    padding: '10px',
    borderRadius: '4px',
    border: 'none',
    background: theme.colors.accent,
    color: '#fff',
    fontSize: theme.fontSizes.md,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: '4px',
  },
  footer: {
    margin: 0,
    fontSize: theme.fontSizes.xs,
    color: theme.colors.muted,
    lineHeight: '1.5',
  },
  code: {
    fontFamily: theme.fonts.mono,
    fontSize: theme.fontSizes.xs,
    background: theme.colors.bgHighlight,
    padding: '1px 4px',
    borderRadius: '2px',
  },
};
