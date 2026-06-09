/**
 * demo-tui.mjs — Comdr TUI 设计展示（非交互）
 * 展示新设计：两行状态栏 · thinking 折叠 · 转场分隔 · Memory 合并 · MCP 紧凑
 * 使用方式：cd packages/ui && node scripts/demo-tui.mjs
 */
import { render, Box, Text, Static } from 'ink';
import React from 'react';

const C = {
  accent:'#c46b3d', dim:'#888888', good:'#5a9e6f',
  warn:'#d4a853', bad:'#d4574a', think:'#9b8e7c', border:'#3a3a3a',
};
const trunc = (s,m) => s.length<=m ? s : s.slice(0,m-1)+'…';
const fmtTok = n => n>=1000?`${(n/1000).toFixed(1)}K`:String(n);

function Demo() {
  // ★ MCP 演示：使用真实 server 名
  const servers = [
    { name:'comdr-art',    status:'connected', transport:'stdio', uptime:52,  pid:28491 },
    { name:'comdr-engine', status:'connected', transport:'stdio', uptime:48,  pid:28503 },
    { name:'comdr-lsp',    status:'offline',   transport:'tcp',   error:'connection refused' },
  ];

  const msgs = [
    { id:'w', type:'info', content:'Comdr v0.1.0 — Agent · 逐步确认', ts:'23:45:01' },
    { id:'u', type:'text', content:'用赛博朋克风格给 MainScene 做主菜单', ts:'23:45:02' },
    { id:'t1', type:'thinking', content:'分析用户需求：生成 UI 资产需要调 comdr-art。\n\n确认 comdr-engine 连接正常，准备装配到 MainScene。', detail:'2 段思考: 分析用户需求：生成 UI 资产需要调 comdr-art。', ts:'23:45:02' },
    { id:'s1', type:'separator', content:'', ts:'23:45:03' },
    // ★ 使用真实 MCP 工具名: mcp__<server>__<tool>
    { id:'c1', type:'tool_call', content:'📡 mcp__comdr-art__comdr-art', detail:'{"request":"赛博朋克风格主菜单UI：暗色背景、霓虹Logo","projectPath":"/cocos-project","style":"cyberpunk"}', ts:'23:45:03' },
    { id:'r1', type:'tool_result', content:'✓ [ok] 5/5 assets — bg_main.png + logo_title.png', ts:'23:45:05' },
    { id:'t2', type:'thinking', content:'资产生成成功。现在装配到编辑器。', detail:'1 段思考: 资产生成成功。现在装配到编辑器。', ts:'23:45:05' },
    { id:'s2', type:'separator', content:'', ts:'23:45:05' },
    { id:'c2', type:'tool_call', content:'📡 mcp__comdr-engine__comdr-engine-ask', detail:'{"request":"bg_main 挂到 MainPanel cc.Sprite.spriteFrame","projectPath":"/cocos-project"}', ts:'23:45:05' },
    { id:'r2', type:'tool_result', content:'✓ [ok] MainPanel + TitleNode: spriteFrame 已挂载', ts:'23:45:06' },
    { id:'tx', type:'text', content:'主菜单已装配完成。赛博朋克风格背景 + 霓虹 Logo 已挂载到 MainScene。', ts:'23:45:06' },
    { id:'done', type:'info', content:'✓ Done — 2 turns · 4.8K tokens', ts:'23:45:07' },
  ];

  const pct = 2; const bar = '█'.repeat(Math.min(pct,12)) + '░'.repeat(12-Math.min(pct,12));
  const status = { turn:2, maxTurns:50, tokensUsed:4800, tokenBudget:200000, thinking:'high', mode:'agent', sessionId:'mcp-demo' };

  return React.createElement(Box, { flexDirection:'column', width:100 },

    // === Status Bar (new 2-row design) ===
    React.createElement(Box, { flexDirection:'column', paddingLeft:2, paddingRight:2 },
      React.createElement(Box, { justifyContent:'space-between' },
        React.createElement(Text, { color:C.accent, bold:true }, 'Comdr'),
        React.createElement(Box, { gap:2 },
          React.createElement(Text, null, '🤖 agent'),
          React.createElement(Text, { color:C.dim }, trunc(status.sessionId,10)),
        ),
      ),
      React.createElement(Box, { gap:2 },
        React.createElement(Text, { color:C.dim },
          'T', React.createElement(Text, { color:C.accent }, String(status.turn)), '/', String(status.maxTurns),
        ),
        React.createElement(Text, { color:C.dim },
          React.createElement(Text, null, bar+' '),
          React.createElement(Text, { color:C.accent }, fmtTok(status.tokensUsed)),
          '/', fmtTok(status.tokenBudget),
        ),
        React.createElement(Text, { color:C.dim }, '🧠 '+status.thinking),
      ),
    ),

    // === Body ===
    React.createElement(Box, { flexDirection:'row', paddingTop:1, paddingLeft:2, paddingRight:2, height:24 },

      // LEFT: Chat stream
      React.createElement(Box, { flexDirection:'column', flexGrow:1 },
        React.createElement(Static, { items:msgs }, msg => {
          const time = React.createElement(Text, { color:C.dim }, msg.ts+'  ');
          switch(msg.type) {
            case 'separator':
              return React.createElement(Box, { key:msg.id, paddingLeft:1 },
                React.createElement(Text, { color:C.dim }, '  ── ✦ ──'));
            case 'thinking':
              return React.createElement(Box, { key:msg.id, flexDirection:'column', paddingLeft:1 },
                React.createElement(Box, null,
                  React.createElement(Text, { color:C.think }, '▶ 💭 '+msg.detail)),
              );
            case 'text':
              return React.createElement(Box, { key:msg.id, paddingLeft:1 }, time,
                React.createElement(Text, null, msg.content));
            case 'tool_call':
              return React.createElement(Box, { key:msg.id, paddingLeft:1 }, time,
                React.createElement(Text, { color:C.accent }, msg.content),
                msg.detail ? React.createElement(Text, { color:C.dim }, '  '+trunc(msg.detail,50)) : null);
            case 'tool_result':
              return React.createElement(Box, { key:msg.id, paddingLeft:3 },
                React.createElement(Text, { color: msg.content.startsWith('✓')?C.good:C.bad }, msg.content));
            case 'info':
              return React.createElement(Box, { key:msg.id, paddingLeft:1 },
                React.createElement(Text, { color:C.dim }, msg.content));
            default:
              return React.createElement(Box, { key:msg.id, paddingLeft:1 },
                React.createElement(Text, null, msg.content));
          }
        }),
      ),

      // RIGHT: Memory + MCP
      React.createElement(Box, { width:30, flexDirection:'column', marginLeft:1 },

        React.createElement(Box, { flexDirection:'column', borderStyle:'single', borderColor:C.border, paddingLeft:1, paddingRight:1 },
          React.createElement(Box, null, React.createElement(Text, { bold:true, color:C.accent }, '📊 Memory')),
          React.createElement(Box, null, React.createElement(Text, { color:C.dim }, '─'.repeat(26))),
          React.createElement(Box, null,
            React.createElement(Text, { color:C.accent }, 'S '),
            React.createElement(Text, { color:C.dim }, trunc('file:src/MainScene.ts → bg_main.png attached', 22)),
          ),
          React.createElement(Box, null,
            React.createElement(Text, { color:C.accent }, 'S '),
            React.createElement(Text, { color:C.dim }, trunc('asset:logo_title.png → logo added', 22)),
          ),
          React.createElement(Box, null,
            React.createElement(Text, { color:C.think }, 'I '),
            React.createElement(Text, { color:C.dim }, trunc('→ 赛博朋克主菜单 UI', 22)),
          ),
        ),

        React.createElement(Box, { flexDirection:'column', borderStyle:'single', borderColor:C.border, paddingLeft:1, paddingRight:1, marginTop:1 },
          React.createElement(Box, null, React.createElement(Text, { bold:true, color:C.accent }, '📡 MCP')),
          React.createElement(Box, null, React.createElement(Text, { color:C.dim }, '─'.repeat(26))),
          ...servers.map(s =>
            React.createElement(Box, { key:s.name, flexDirection:'column' },
              React.createElement(Box, null,
                React.createElement(Text, {
                  color: s.status==='connected'?C.good : s.status==='connecting'?C.warn : s.status==='error'?C.bad : C.dim,
                }, `${s.status==='connected'?'◉':s.status==='connecting'?'◔':s.status==='error'?'✗':'○'} `),
                React.createElement(Text, null, s.name),
                React.createElement(Text, { color:C.dim }, `  ${s.transport==='stdio'?'🔌':'🌐'}`),
              ),
              React.createElement(Box, { paddingLeft:3 },
                React.createElement(Text, { color:C.dim },
                  s.status==='connected' ? `↑${Math.floor(s.uptime/60)}m${s.uptime%60}s` :
                  s.status==='connecting' ? 'connecting...' : ''),
                s.pid ? React.createElement(Text, { color:C.dim }, `  pid:${s.pid}`) : null,
              ),
              s.status==='error' && s.error
                ? React.createElement(Box, { paddingLeft:3 },
                    React.createElement(Text, { color:C.bad }, trunc(s.error, 22)))
                : null,
            ),
          ),
        ),
      ),
    ),

    // === Footer ===
    React.createElement(Box, { paddingLeft:2, paddingRight:2, paddingBottom:1 },
      React.createElement(Text, { color:C.accent, bold:true }, '→ '),
      React.createElement(Text, null, '用赛博朋克风格给 MainScene 做主菜单'),
      React.createElement(Text, { color:C.dim }, ' ▍'),
    ),
  );
}

render(React.createElement(Demo), { patchConsole:false, stdin:process.stdin, stdout:process.stdout });
setTimeout(() => process.exit(0), 2500);
