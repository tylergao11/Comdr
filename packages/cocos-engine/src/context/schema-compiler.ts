// ============================================================
// Schema Compiler — ComponentEntry → CompiledSchema
// 属性分类: 关键属性 | 引用属性 | 隐藏
// ============================================================

import { ComponentEntry, KnowledgeChildNode } from '../model/component-catalog.js';
import { RefResolver } from '../model/cocos-world.js';
import { CompiledSchema, CompiledProperty, CompiledRefProperty, CompiledKnowledgeChild } from './types.js';

/** 系统内部属性 — 不展示给 LLM */
const INFRA_PROPERTIES = new Set([
  '_name', '_objFlags', '_id', '_enabled', 'enabled', 'node',
  '__prefab__', '__editorExtras__', '_target', '_prefab',
]);

/** 从 ComponentEntry 编译为 CompiledSchema */
export function compileSchema(entry: ComponentEntry, resolver?: RefResolver): CompiledSchema {
  const { identity, schema, knowledge } = entry;

  const keyProperties: CompiledProperty[] = [];
  const refProperties: CompiledRefProperty[] = [];
  let hiddenCount = 0;

  for (const prop of schema) {
    const name = prop.name;

    // 跳过基础设施属性
    if (INFRA_PROPERTIES.has(name)) {
      hiddenCount++;
      continue;
    }

    // 检测引用类型
    const refKind = classifyRef(identity.rawType, name, resolver);
    if (refKind) {
      refProperties.push({
        name: stripUnderscore(name),
        refType: refKind,
      });
      continue;
    }

    // 关键属性: 简单类型且用户可见
    if (isDisplayableType(prop.type)) {
      keyProperties.push({
        name: stripUnderscore(name),
        type: prop.type,
        default: prop.default,
      });
    } else {
      hiddenCount++;
    }
  }

  const totalProperties = schema.length;

  return {
    type: identity.rawType,
    description: identity.isScript ? `用户脚本: ${identity.name}` : knowledge?.description,
    isScript: identity.isScript || undefined,
    keyProperties,
    refProperties: refProperties.length > 0 ? refProperties : undefined,
    totalProperties,
    requires: knowledge?.requires,
    conflicts: knowledge?.conflicts,
    children: knowledge?.children ? compileKnowledgeChildren(knowledge.children) : undefined,
  };
}

/** 从 knowledge children 编译 */
function compileKnowledgeChildren(children: KnowledgeChildNode[]): CompiledKnowledgeChild[] {
  return children.map((child) => ({
    type: child.name,
    optional: !child.required,
    components: child.components.map((c) => ({
      type: c.type,
      optional: c.optional,
      props: c.props,
    })),
    children: child.children ? compileKnowledgeChildren(child.children) : undefined,
  }));
}

/** 判断属性类型是否可展示 */
function isDisplayableType(type: string): boolean {
  switch (type) {
    case 'string':
    case 'int':
    case 'float':
    case 'number':
    case 'bool':
    case 'boolean':
      return true;
    default:
      return false;
  }
}

/** 检测引用类型 */
function classifyRef(
  componentType: string,
  propName: string,
  resolver?: RefResolver,
): 'node' | 'component' | 'asset' | null {
  if (!resolver) return null;
  if (resolver.isNodeRef(componentType, propName)) return 'node';
  if (resolver.isComponentRef(componentType, propName)) return 'component';
  if (resolver.isAssetRef(componentType, propName)) return 'asset';
  return null;
}

/** 去掉 Cocos 序列化的 _ 前缀，返回 DSL 中使用的属性名 */
function stripUnderscore(name: string): string {
  return name.startsWith('_') ? name.slice(1) : name;
}
