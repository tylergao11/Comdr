# Cocos Creator 世界模型

> 部署到 `~/.comdr/world-models/cocos.md`，由 Comdr 自动注入 prompt。
> 此文件描述 Cocos Creator 引擎的编辑器世界模型，帮助 LLM 理解何时用 comdr-engine-ask MCP 工具。

## 五个基础元素

- **Asset** — 文件资源（UUID + 路径 + 类型 + 子资产）。每个资源有 `.meta` 文件。
- **Node** — 层级容器（fileId + 名称 + 父子关系 + 组件列表）。scene 和 prefab 都是 Node 树。
- **Component** — 类型化数据。引擎组件以 `cc.` 前缀开头（如 `cc.Sprite`），自定义脚本用 23 位压缩 UUID。
- **Value** — 属性值（原始类型 | Vec2/Vec3/Color | 引用 | 数组）。
- **Reference** — 关系连线（`__id__` = 内部节点引用，`__uuid__` = 资产引用）。

## 何时用 comdr-engine-ask

- 创建/编辑 prefab 或 scene 结构
- 添加/移除/配置组件（cc.Sprite, cc.Button, cc.Label 等）
- 挂载自定义脚本到节点
- 设置组件属性（spriteFrame, string, color 等）
- 查询项目中的 prefab/scene/asset UUID

## 何时不用

- 写 TypeScript 脚本代码 → 直接用 file_write/file_edit
- 文件/目录操作 → 用 shell_bash 或 file_* 工具
- 生成图片/美术资产 → 用 mcp__comdr-art__comdr-art

## 与 Comdr-Art 的协作

comdr-art 生成资产后返回 `db://` 路径和 UUID，用 comdr-engine-ask 把这些资产挂到场景中。
