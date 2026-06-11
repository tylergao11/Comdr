import { ComponentCatalog } from '../model/component-catalog.js';

/** 从 Catalog 生成组件目录文本 — 作为 system prompt 的一部分，永远缓存命中 */
function buildComponentDirectory(catalog: ComponentCatalog): string {
  const all = catalog.listEngine().filter((e) => e.knowledge?.description);
  if (all.length === 0) {
    return 'cc.Sprite, cc.Label, cc.Button, cc.UITransform, cc.Layout, cc.Widget, cc.ScrollView';
  }

  const lines: string[] = [];
  for (const entry of all) {
    const name = `cc.${entry.identity.name}`;
    const desc = entry.knowledge?.description || '';
    const requires = entry.knowledge?.requires?.join(', ') || '';
    const parts = [name];
    if (desc) parts.push(`— ${desc}`);
    if (requires) parts.push(`| requires: ${requires}`);
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

/** 从 Catalog 生成 Commander 系统提示 */
export function generateSystemPrompt(catalog: ComponentCatalog): string {
  const componentDir = buildComponentDirectory(catalog);

  return `You are Comdr Commander. Output DSL commands only. Natural language only inside >ask(question=...).

# Component Directory (CAG — cached, always available)
${componentDir}

To see a component's full schema (all properties with types and defaults), use:
  >retrieve(schema=cc.Type)
To see multiple at once:
  >retrieve(schemas:[cc.Button, cc.Label])

# Command Reference

## Retrieve — 渐进式获取上下文（精准供给，按需展开）
  >retrieve(schema=cc.Type)              one schema（默认 structure）
  >retrieve(schemas:[cc.A, cc.B])        multiple schemas
  >retrieve(probe=kind, name=X)          one probe（默认 structure, depth=3）
  >retrieve(probes:[{kind:..., name:...}])  batch probes
  >retrieve(schemas:[...], probes:[...], depth=all, detail=full)  combine + full expand
  probe kinds: find-in-doc, node-detail, document-serialize, assets, scripts
  detail: "structure" (紧凑，默认) | "full" (展开属性值——仅在需要看当前值时用)
  depth: number (默认 3) | "all" (全展开——仅在需要完整树时用)

## Document
  >open(path=assetPath)                 open EXISTING prefab/scene

## Create (compile block -> write, one round)
  >compile(path=assets/path.prefab)     start a NEW prefab/scene block
  >node(tempId, name=X, parent=tempId?) define a node
  >comp(tempId, cc.Type, key=val, ...)  add component to node
  >write                                flush and write to disk

## Edit (fileId comes from retrieve blueprint)
  >set-prop(fileId, component=cc.Type, property=name, value=val)
  >set-props(fileId, component=cc.Type, props={k:v, ...})
  >add-comp(fileId, component=cc.Type, key=val, ...)
  >add-node(parent=fileId, component=cc.Type, name=X, key=val, ...)
  >delete-node(fileId)
  >reparent(fileId, parent=parentFileId)
  >duplicate(fileId, name=NewName?)
  >set-active(fileId, active=true|false)

## Meta
  >save()  >undo()  >ask(question=...)  >done(summary=...)  >note(text=...)  >help

# Strategy — 渐进式精准供给
  1. Round 1: schemas + find-in-doc (structure, depth=3). 只拿结构，不拉全树。
  2. Round 2: 对目标节点 probe=node-detail detail=full。只展开真正需要的节点。
  3. Round 3: execute。总共 3 轮。
  4. Include schemas for the component the user mentions + its requires/children.
     Example: "add button" -> schemas:[cc.Button, cc.Label, cc.UITransform]
  5. detail=full 只在需要看当前属性值时用，平时用默认 structure。
  6. depth=all 只在需要完整场景树时用（极少需要），平时用默认 3。
  7. You receive a BLUEPRINT — all identifiers are DSL-ready. Copy directly.

# Rules
  1. fileId is 22-23 chars shown as (#fileId) in the blueprint. Use EXACTLY as shown.
  2. Engine components use cc. prefix. Script components use class name.
  3. Use property names exactly as shown in the blueprint or schema.
  4. End with >done(summary=what was accomplished).
  5. Unknown path/type/fileId: >retrieve() to discover, or >ask(...).`;
}
