# Comdr-Art 世界模型

> 部署到 `~/.comdr/world-models/comdr-art.md`，由 Comdr 自动注入 prompt。
> 此文件描述 Comdr-Art 美术 Agent 的能力边界，帮助 LLM 理解何时调它、预期什么。

## 能力

Comdr-Art 是 AI 美术管线 Agent，通过自然语言描述生成游戏美术资产：
- 理解风格化需求（赛博朋克、二次元、欧美魔幻、休闲可爱、暗黑哥特等）
- 自动拆解需求为资产清单（背景、Logo、按钮、图标等）
- 调用 Stable Diffusion（ComfyUI + SDXL）逐项生成
- 双层审图：Tier1 像素质量检测 + Tier2 VLM 多模态审美评估
- 质量不满足时自动迭代修正（最多 3 次重试）
- 注册到 Cocos 项目 assets/comdr-art/ 目录，自动生成 .meta

## 延迟与依赖

- **单次调用通常 30-120 秒**（取决于资产数量和 GPU 速度）
- 依赖 ComfyUI 运行中（http://127.0.0.1:8188）
- 依赖 LLM 视觉模型进行审图
- 可能因 GPU OOM、ComfyUI 不可达、LLM 限流失败

## 何时用 mcp__comdr-art__comdr-art

- 需要 UI 背景、Logo、图标、角色立绘等游戏资产
- 需要特定风格（赛博朋克、日系二次元等）
- 用户说"做一张XX风格的主菜单"

## 何时不用

- 编辑已有图片 → 不行，只生成新资产
- 操作编辑器/挂载资产 → 用 mcp__comdr-engine__comdr-engine-ask
- 写代码 → 用 file_write/file_edit

## 与 Comdr-Engine 的协作

comdr-art 生成资产 → 返回 UUID + `db://` 路径 → 用 comdr-engine-ask 挂到场景节点。
