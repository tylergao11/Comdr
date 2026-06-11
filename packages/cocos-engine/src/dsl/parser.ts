// ============================================================
// DSL Parser — Commander 输出文本 → 命令对象数组
// 格式: >cmd(args); >cmd(args)
// ============================================================

import { DslCommand, ParsedDslOutput, NoteEntry, CompileSpec, NodeSpec, DslCommandType } from '../types.js';

/** compile 块内使用的内部命令类型（node/comp/child 不暴露到公共 DslCommandType） */
type CompileBlockCmd = { type: string; [key: string]: unknown };

const VALID_STANDALONE_CMDS: ReadonlySet<string> = new Set<DslCommandType>([
  'probe', 'detail', 'open', 'schema',
  'compile', 'write', 'save', 'undo',
  'add-node', 'add-comp',
  'set-prop', 'set-props', 'delete-node', 'reparent', 'duplicate', 'set-active',
  'note', 'ask', 'done', 'help',
]);

/** 标准化文本 + 按 ; 分割，检测缺少 ; 时用 > 作为辅助分隔符 */
export function splitTokens(text: string): string[] {
  // 仅规范化换行和首尾空白，不在引号内合并空格
  const cleaned = text.replace(/[\r\n]+/g, ' ').trim();

  const tokens: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  let escapeNext = false;
  let inObj = 0; // { } 嵌套
  let inArr = 0; // [ ] 嵌套

  for (const ch of cleaned) {
    if (escapeNext) {
      current += ch;
      escapeNext = false;
      continue;
    }
    if (inQuote) {
      if (ch === '\\') { escapeNext = true; }
      else if (ch === inQuote) { inQuote = null; current += ch; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
    } else if (ch === '{') {
      inObj++;
      current += ch;
    } else if (ch === '}') {
      inObj--;
      current += ch;
    } else if (ch === '[') {
      inArr++;
      current += ch;
    } else if (ch === ']') {
      inArr--;
      current += ch;
    } else if (ch === ';' && inObj === 0 && inArr === 0) {
      const token = current.trim();
      if (token) tokens.push(token);
      current = '';
    } else {
      current += ch;
    }
  }

  const remaining = current.trim();
  if (remaining) tokens.push(remaining);

  // 恢复逻辑：Commander 忘记分号时尝试按 > 拆分（best-effort，不可靠——字符串内 ) > 会导致误切割）
  if (tokens.length === 1 && (tokens[0].match(/>/g) || []).length > 1) {
    process.stderr.write(`[comdr] DSL recovery triggered — Commander may have omitted ';' separators. Input: ${tokens[0].slice(0, 200)}\n`);
    // 策略1: split on ) followed by > (most reliable — ) terminates commands, > starts new)
    const recovered: string[] = [];
    const parts = tokens[0].split(/\)\s*(?=>)/g);
    for (let i = 0; i < parts.length; i++) {
      let part = parts[i].trim();
      if (!part) continue;
      if (i < parts.length - 1) part += ')';
      if (part) recovered.push(part);
    }
    if (recovered.length > 1) return recovered;

    // 策略2: split on whitespace before > (lower confidence — may break on strings containing " >")
    const altParts = tokens[0].split(/\s+(?=>)/g);
    const altRecovered = altParts.filter((p) => p.trim());
    if (altRecovered.length > 1) return altRecovered;
  }

  return tokens;
}

/** 解析单个 token: >name(args) → { name, args } */
export function parseToken(token: string): { name: string; args: Record<string | number, unknown> } | null {
  // 去掉所有前导 >（容错：Commander 有时多打 >）
  const t = token.replace(/^>+/, '').trim();

  // 匹配 name(args)
  const match = t.match(/^([a-zA-Z][\w-]*)\s*\((.*)\)$/s);
  if (!match) return null;

  const name = match[1];
  const argsStr = match[2];
  const args = parseArgs(argsStr);

  return { name, args };
}

/** 解析参数列表 */
export function parseArgs(argsStr: string): Record<string | number, unknown> {
  const args: Record<string | number, unknown> = {};

  if (!argsStr.trim()) return args;

  let posIdx = 0;
  const parts = splitByComma(argsStr);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;

    const eqIdx = part.indexOf('=');
    if (eqIdx > 0 && part[eqIdx - 1] !== '\\' && !isInsideQuotes(part, eqIdx)) {
      const key = part.slice(0, eqIdx).trim();
      const valStr = part.slice(eqIdx + 1).trim();
      args[key] = coerceVal(valStr);
    } else {
      args[posIdx++] = coerceVal(part);
    }
  }

  return args;
}

/** 按逗号分割，尊重引号和括号 */
export function splitByComma(str: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  let escapeNext = false;
  let depth = 0;

  for (const ch of str) {
    if (escapeNext) { current += ch; escapeNext = false; continue; }
    if (inQuote) {
      if (ch === '\\') { escapeNext = true; }
      else if (ch === inQuote) { inQuote = null; current += ch; }
      else { current += ch; }
    } else if (ch === '\\') {
      // 反斜杠转义：跳过反斜杠本身，下一个字符当普通字面量
      escapeNext = true;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
    } else if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);

  return parts;
}

function isInsideQuotes(str: string, idx: number): boolean {
  let inQuote: string | null = null;
  for (let i = 0; i < idx; i++) {
    if (inQuote) {
      if (str[i] === inQuote) inQuote = null;
    } else if (str[i] === '"' || str[i] === "'") {
      inQuote = str[i];
    }
  }
  return inQuote !== null;
}

/** 将 DSL key=value 格式字符串转换为 JSON 对象 */
function convertDslToJson(v: string): unknown {
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    const items = splitByComma(inner).map((item) => {
      const trimmed = item.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        return convertDslToJson(trimmed);
      }
      return coerceVal(trimmed);
    });
    return items;
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return {};
    const obj: Record<string, unknown> = {};
    const parts = splitByComma(inner);
    for (const part of parts) {
      const trimmed = part.trim();
      const eqIdx = trimmed.indexOf('=');
      const colonIdx = trimmed.indexOf(':');
      // key=value（DSL 格式）或 key:value（JSON-like 格式）
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let valStr = trimmed.slice(eqIdx + 1).trim();
        obj[key] = coerceVal(valStr);
      } else if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        let valStr = trimmed.slice(colonIdx + 1).trim();
        obj[key] = coerceVal(valStr);
      } else {
        // 无 key=value 或 key:value → 尝试作为 JSON key
        try {
          Object.assign(obj, JSON.parse(`{${trimmed}}`));
        } catch { /* JSON parse skipped — not a valid JSON expression */ }
      }
    }
    return obj;
  }
  return coerceVal(v);
}

/** 类型强制转换 */
export function coerceVal(v: string): unknown {
  v = v.trim();

  // 去除首尾引号
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }

  // 布尔
  if (v === 'true') return true;
  if (v === 'false') return false;

  // null
  if (v === 'null' || v === 'nil') return null;

  // 数字（含溢出/NaN 防御 — 非法数值回退为字符串）
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    const n = parseFloat(v);
    return (isFinite(n) && !isNaN(n)) ? n : v;
  }

  // JSON 对象/数组
  if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
    try {
      return JSON.parse(v);
    } catch {
      // JSON.parse 失败 → 尝试转换 DSL key=value 格式
      try {
        return convertDslToJson(v);
      } catch {
        process.stderr.write(`[comdr] DSL coerceVal: both JSON.parse and convertDslToJson failed for: ${v.slice(0, 120)}\n`);
        return v;
      }
    }
  }

  return v;
}

// ===== 主解析入口 =====

export function parseDslOutput(text: string): ParsedDslOutput {
  const commands: DslCommand[] = [];
  let done = false;
  let doneReport: Record<string, unknown> | undefined;
  const rawNotes: NoteEntry[] = [];
  const warnings: string[] = [];

  const tokens = splitTokens(text);
  let compileSpecs: CompileBlockCmd[] = [];

  for (const token of tokens) {
    const parsed = parseToken(token);
    if (!parsed) continue;

    const { name, args } = parsed;

    // done() — Commander 显式声明任务完成，可带汇报数据
    if (name === 'done') {
      done = true;
      if (Object.keys(args).length > 0) {
        doneReport = { ...args };
      }
      continue;
    }

    // note()
    if (name === 'note') {
      const kind = String(args.guess ? 'guess' : args.warn ? 'warn' : 'guess');
      // 支持位置参数: >note(text) 等价于 >note(guess=text)
      const noteText = String(
        args.guess || args.warn || args[0] || ''
      );
      rawNotes.push({ kind: kind as 'guess' | 'warn', text: noteText });
      continue;
    }

    // ask() — 反问调用方需要澄清
    if (name === 'ask') {
      commands.push({
        type: 'ask',
        // 支持位置参数: >ask(What next?) 等价于 >ask(question=What next?)
        question: String(args.question || args.q || args[0] || ''),
      });
      continue;
    }

    // compile 块命令
    if (name === 'compile') {
      // 如果有未完成的 compile 块，先提交
      flushCompileBlock(compileSpecs, commands);
      compileSpecs = [];

      const cmd: DslCommand = {
        type: 'compile',
        path: args.path as string | undefined,
        assetPath: args.assetPath as string | undefined,
        spec: { nodes: [] },
      };
      compileSpecs.push(cmd);
      continue;
    }

    // node / comp / child — 属 compile 块
    if (['node', 'comp', 'child'].includes(name)) {
      if (compileSpecs.length > 0) {
        compileSpecs.push({ ...args, type: name });
      } else {
        // 块外的 node/comp/child 无意义，告知 Commander
        warnings.push(`Command '>${name}' ignored: must be inside a compile block`);
      }
      continue;
    }

    // write 命令前先刷新 compile 块，保证 compile 在 write 之前执行
    if (name === 'write' && compileSpecs.length > 0) {
      flushCompileBlock(compileSpecs, commands);
      compileSpecs = [];
    }

    // 普通命令 — 拒绝不在合法命令集中的 name
    if (!VALID_STANDALONE_CMDS.has(name)) {
      warnings.push(`Unknown command '>${name}'`);
      continue;
    }
    const cmd: DslCommand = { ...args, type: name as DslCommandType };
    if (name === 'probe') {
      cmd.probeType = (args.probeType || args.type || args[0]) as string;
    }
    commands.push(cmd);
  }

  // 最后刷新 compile 块
  flushCompileBlock(compileSpecs, commands);

  return { commands, done, doneReport, rawNotes: rawNotes.length > 0 ? rawNotes : undefined, warnings: warnings.length > 0 ? warnings : undefined };
}

/** 将收集的 compile+node+comp+child 合并为一个 compile 命令 */
function flushCompileBlock(compileSpecs: CompileBlockCmd[], commands: DslCommand[]): void {
  if (compileSpecs.length === 0) return;

  // 找到 compile 命令
  const compileCmd = compileSpecs.find((c) => c.type === 'compile');
  if (!compileCmd) {
    // 没有 compile 但有 node/comp → 不应该出现（块外 node/comp 已被拒绝）
    // 保留为防御性路径
    commands.push(...(compileSpecs as unknown as DslCommand[]));
    return;
  }

  const spec: CompileSpec = {
    path: (compileCmd.path || compileCmd.assetPath) as string | undefined,
    nodes: [],
  };

  let currentNode: NodeSpec | null = null;

  for (const cmd of compileSpecs) {
    switch (cmd.type) {
      case 'compile':
        // 已处理
        break;
      case 'node':
        currentNode = {
          tempId: (cmd.tempId || cmd[0]) as string,
          name: (cmd.name || cmd.tempId || cmd[0] || 'Node') as string,
          parent: (cmd.parent || null) as string | null,
          prefab: cmd.prefab as string | undefined,
          active: cmd.active !== false,
          position: cmd.position as NodeSpec['position'],
          scale: cmd.scale as NodeSpec['scale'],
          contentSize: cmd.contentSize as NodeSpec['contentSize'],
          anchorPoint: cmd.anchorPoint as NodeSpec['anchorPoint'],
          components: [],
        };
        // 支持内联 components=[{type=cc.Label, props={...}}]
        const inlineComps = cmd.components;
        if (Array.isArray(inlineComps)) {
          for (const comp of inlineComps) {
            if (typeof comp === 'object' && comp !== null) {
              const c = comp as Record<string, unknown>;
              currentNode.components.push({
                type: (c.type || '') as string,
                props: (c.props || c) as Record<string, unknown>,
              });
            }
          }
        }
        spec.nodes.push(currentNode);
        break;
      case 'comp':
        if (currentNode) {
          const compType = (cmd.compType || cmd.component || cmd['1'] || '') as string;
          // 内联属性（如 string=Hello, fontSize=24）与显式 props={...} 合并
          const inlineProps: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(cmd)) {
            if (k === 'type' || k === 'compType' || k === 'component' || k === 'notes' || k === 'props') continue;
            if (/^\d+$/.test(k)) continue;
            if (typeof k === 'number') continue;
            inlineProps[k] = v;
          }
          const explicitProps = (cmd.props as Record<string, unknown>) || {};
          const mergedProps = Object.keys(inlineProps).length > 0
            ? { ...explicitProps, ...inlineProps }
            : explicitProps;
          currentNode.components.push({ type: compType, props: mergedProps });
        }
        break;
    }
  }

  compileCmd.spec = spec;
  commands.push(compileCmd as unknown as DslCommand);
}
