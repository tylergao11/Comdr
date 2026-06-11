// ============================================================
// Assembler Stage 5: Clean
// 纯函数 clean(json) → PrefabJson
// 清除所有内部临时标记，输出干净的 Cocos prefab JSON
// ============================================================

import { PrefabJson, AssemblyStats, NODE_LIKE_TYPES } from '../../model/cocos-world.js';

/** 清除内部标记：tempId, _comdr_tempId, _nestedSource, _nestedRoot, _prefabInstance, __id__ */
export function clean(json: PrefabJson): PrefabJson {
  const visited = new Set<unknown>();

  function deepClean(obj: unknown): void {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
    visited.add(obj);

    if (Array.isArray(obj)) {
      for (const item of obj) deepClean(item);
      return;
    }

    const record = obj as Record<string, unknown>;

    // 删除内部标记
    delete record.tempId;
    delete record._rawProps;
    delete record._comdr_tempId;
    delete record._nestedSource;
    delete record._nestedRoot;
    delete record._prefabInstance;

    // 隐式 ID：数组下标即 ID，不输出显式 __id__。
    // Cocos 引擎通过数组位置隐式确定每个对象的 ID，反序列化时自动重建 __id__。
    // 只对有 __type__ 的真实对象删除，保留 { __id__: N } 引用标记（这些是引用连线，不是对象 ID）。
    // 嵌套 prefab 引用 { __id__: N } 指向外部 prefab 节点 — 这些通过 PrefabInstance 机制
    // 在编辑器打开时解析，不受 __id__ 删除影响。
    if (record.__type__) {
      delete record.__id__;
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        deepClean(value);
      }
    }
  }

  for (const obj of json) deepClean(obj);
  return json;
}

/** 统计组装结果 */
export function computeStats(json: PrefabJson): AssemblyStats {
  let nodes = 0;
  let components = 0;

  for (const obj of json) {
    const typeName = obj.__type__ as string | undefined;
    if (!typeName) continue;

    if (NODE_LIKE_TYPES.has(typeName)) {
      nodes++;
      continue;
    }

    // 跳过基础设施类型
    if (
      typeName === 'cc.Prefab' ||
      typeName === 'cc.PrefabInfo' ||
      typeName === 'cc.CompPrefabInfo' ||
      typeName === 'cc.PrefabInstance' ||
      typeName === 'cc.TargetInfo' ||
      typeName === 'CCPropertyOverrideInfo' ||
      typeName === 'cc.ClickEvent'
    ) continue;

    // 跳过值类型
    if (
      typeName === 'cc.Vec2' || typeName === 'cc.Vec3' || typeName === 'cc.Vec4' ||
      typeName === 'cc.Size' || typeName === 'cc.Color' ||
      typeName === 'cc.Quat' || typeName === 'cc.Rect'
    ) continue;

    // 引擎组件 (cc.Xxx) 和脚本组件 (压缩 UUID) 都计入
    components++;
  }

  return { nodes, components, totalObjects: json.length };
}
