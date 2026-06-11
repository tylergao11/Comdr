// ============================================================
// Insertion Analyzer — 分析场景树，给出可插入位置的推荐排序
// ============================================================

import { CompiledNode, CompiledInsertionPoint } from './types.js';

/**
 * 分析场景树中的可插入位置
 * @param tree 编译后的节点树
 * @returns 排序的插入点列表: [推荐] → [可用] → [有限]
 */
export function analyzeInsertionPoints(
  tree: CompiledNode,
): CompiledInsertionPoint[] {
  const points: CompiledInsertionPoint[] = [];
  walkTree(tree, points);
  return sortPoints(points);
}

function walkTree(node: CompiledNode, points: CompiledInsertionPoint[]): void {
  // 分析当前节点是否为容器
  const insertion = evaluateNode(node);
  if (insertion) {
    points.push(insertion);
  }

  // 递归子节点
  for (const child of node.children) {
    walkTree(child, points);
  }
}

function evaluateNode(node: CompiledNode): CompiledInsertionPoint | null {
  const compTypes = node.components.map((c) => c.type);
  const currentChildren = node.children.map((c) => c.name);

  // 含 Layout → 推荐
  if (compTypes.some((t) => t === 'cc.Layout')) {
    const layoutComp = node.components.find((c) => c.type === 'cc.Layout');
    const type = layoutComp?.keyProps.type as number;
    const typeLabel = type === 1 ? 'horizontal' : type === 2 ? 'vertical' : 'none';
    return {
      parent: node.fileId,
      name: node.name,
      rank: 'recommended',
      description: `Layout:${typeLabel} 自动排列 → parent=${node.fileId}`,
      currentChildren,
    };
  }

  // Canvas 根节点 → 可用
  if (compTypes.some((t) => t === 'cc.Canvas')) {
    return {
      parent: node.fileId,
      name: node.name,
      rank: 'usable',
      description: `Canvas 根节点 → parent=${node.fileId}，需手动设 position`,
      currentChildren,
    };
  }

  // 含 Widget 的容器 → 有限
  if (compTypes.some((t) => t === 'cc.Widget')) {
    return {
      parent: node.fileId,
      name: node.name,
      rank: 'limited',
      description: `Widget 对齐节点 → parent=${node.fileId}，子节点需配合 Widget 约束`,
      currentChildren,
    };
  }

  // 已有子节点（非纯渲染节点）→ 可用
  if (node.children.length > 0) {
    // 排除纯渲染节点（只有 Sprite + UITransform 的叶子）
    const nonRender = compTypes.filter(
      (t) => t !== 'cc.UITransform' && t !== 'cc.Sprite' && t !== 'cc.PrefabInfo',
    );
    if (nonRender.length === 0) return null;

    return {
      parent: node.fileId,
      name: node.name,
      rank: 'usable',
      description: `已有 ${node.children.length} 个子节点 → parent=${node.fileId}，需手动设 position`,
      currentChildren,
    };
  }

  // 纯叶子节点 → 不推荐（跳过）
  return null;
}

/** 排序: recommended → usable → limited */
function sortPoints(points: CompiledInsertionPoint[]): CompiledInsertionPoint[] {
  const order = { recommended: 0, usable: 1, limited: 2 };
  points.sort((a, b) => order[a.rank] - order[b.rank]);
  return points;
}
