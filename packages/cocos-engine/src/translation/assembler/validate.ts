// ============================================================
// Assembler Stage 1: Validate
// 纯函数 validate(spec) → ValidationError | null
// ============================================================

import { CompileSpec, NodeSpec } from '../../model/cocos-world.js';

export interface ValidationError {
  error: string;
  errorCode: string;
}

export function validate(spec: CompileSpec): ValidationError | null {
  if (!spec || !Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    return {
      error: 'Spec has no nodes',
      errorCode: 'ASM_INVALID_SPEC',
    };
  }

  const tempIds = new Set<string>();
  const roots: NodeSpec[] = [];

  for (const node of spec.nodes) {
    if (!node.tempId) {
      return {
        error: 'Node missing tempId. Every node in a compile block needs a tempId: >node(R1, name=X).',
        errorCode: 'ASM_MISSING_TEMPID',
      };
    }
    if (tempIds.has(node.tempId)) {
      return {
        error: `Duplicate tempId: ${node.tempId}`,
        errorCode: 'ASM_DUPLICATE_TEMPID',
      };
    }
    tempIds.add(node.tempId);

    if (!node.parent) {
      roots.push(node);
    } else if (!tempIds.has(node.parent)) {
      // parent must exist as a tempId in this spec (already seen or will be seen)
      // check if parent exists anywhere in spec
      if (!spec.nodes.some((n) => n.tempId === node.parent)) {
        return {
          error: `Parent "${node.parent}" not found for node ${node.tempId}`,
          errorCode: 'ASM_INVALID_PARENT',
        };
      }
    }
  }

  if (roots.length === 0) {
    return {
      error: 'No root node (node with no parent)',
      errorCode: 'ASM_NO_ROOT',
    };
  }
  if (roots.length > 1) {
    return {
      error: 'Multiple root nodes',
      errorCode: 'ASM_MULTI_ROOT',
    };
  }

  return null;
}
