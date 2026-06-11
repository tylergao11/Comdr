// ============================================================
// ProbeProtocol — 统一的 Bridge 查询协议
// 所有 Bridge 查询走此接口，返回形状统一
// ============================================================

import { CocosAsset, CocosNode, CocosComponent, PropertySchema } from './cocos-world.js';

// ===== 查询请求 =====

export type ProbeKind =
  | 'project-summary'
  | 'assets'
  | 'asset'
  | 'asset-search'
  | 'find-in-doc'
  | 'node-detail'
  | 'document-serialize'
  | 'schema'
  | 'scripts'
  | 'console'
  | 'property';

export interface ProbeRequest {
  kind: ProbeKind;

  // 资产相关
  path?: string;
  paths?: string[];
  pattern?: string;

  // 节点相关
  name?: string;
  fileId?: string;

  // 组件/Schema
  componentType?: string;
  property?: string;

  // 控制台
  level?: string;
  limit?: number;

  // 杂项
  query?: string;

  // 自由扩展
  [key: string]: unknown;
}

// ===== 查询响应 =====

export interface ProbeResponse {
  ok: boolean;
  kind: ProbeKind;
  error?: string;
  errorCode?: string;

  // 统一的数据载体
  data?: ProbeData;
}

/** 所有探针返回的数据联合类型 */
export type ProbeData =
  | ProjectSummaryData
  | AssetListData
  | AssetDetailData
  | FindInDocData
  | NodeDetailData
  | DocumentData
  | SchemaData
  | ScriptListData
  | ConsoleData
  | PropertyData;

// ===== 各探针数据形状 =====

export interface ProjectSummaryData {
  kind: 'project-summary';
  scenes: number;
  prefabs: number;
  scripts: number;
  scriptList?: Array<{ name: string; path: string; compressedId: string }>;
}

export interface AssetListData {
  kind: 'assets';
  path: string;
  entries: Array<{
    name: string;
    path: string;
    isDir: boolean;
    uuid?: string;
  }>;
}

export interface AssetDetailData {
  kind: 'asset';
  path: string;
  uuid: string;
  importer: string;
  subAssets?: Array<{ name: string; uuid: string }>;
}

export interface FindInDocData {
  kind: 'find-in-doc';
  matches: Array<{
    fileId: string;
    name: string;
    path: string;
    components: string[];  // __type__ 列表
    childCount: number;
  }>;
}

/** ProbeData 联合成员 — 通过 ProbeData 间接使用，非直接 import */
export interface NodeDetailData {
  kind: 'node-detail';
  fileId: string;
  name: string;
  active: boolean;
  components: Array<{
    __type__: string;
    fileId?: string;
    enabled?: boolean;
  }>;
  children: Array<{ fileId: string; name: string }>;
}

export interface DocumentData {
  kind: 'document';
  path: string;
  json: unknown[];
  rootFileId: string;
  nodeCount: number;
}

export interface SchemaData {
  kind: 'schema';
  componentType: string;
  isScript: boolean;
  className?: string;
  properties: PropertySchema[];
}

export interface ScriptListData {
  kind: 'scripts';
  path: string;
  scripts: Array<{
    name: string;
    path: string;
    compressedId: string;
    methods: string[];
    properties: string[];
  }>;
}

export interface ConsoleData {
  kind: 'console';
  entries: Array<{
    level: string;
    message: string;
    timestamp: number;
  }>;
}

export interface PropertyData {
  kind: 'property';
  fileId: string;
  componentType: string;
  property: string;
  value: unknown;
}
