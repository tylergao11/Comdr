// ============================================================
// KnowledgeData — 组件知识库数据（编译时内嵌，运行时零文件依赖）
// 源文件：src/knowledge/component-knowledge.json
// 嵌入原因：dist 构建不复制 JSON 文件，运行时 __dirname 不可靠
// ============================================================

import { ComponentKnowledge } from '../model/component-catalog.js';

const KNOWLEDGE_DATA: Record<string, ComponentKnowledge> = {
  "cc.UITransform": {
    "autoAdd": true,
    "description": "2D 节点必备的变换组件",
    "defaults": { "width": 100, "height": 100, "anchorX": 0.5, "anchorY": 0.5 },
  },
  "cc.Sprite": {
    "requires": ["cc.UITransform"],
    "description": "精灵渲染组件",
    "defaults": { "_spriteFrame": "internal:default-ui/default-sprite-sprite-frame", "type": 0 },
  },
  "cc.Label": {
    "requires": ["cc.UITransform"],
    "description": "文本渲染组件",
    "defaults": { "fontSize": 24, "lineHeight": 30, "horizontalAlign": 1, "verticalAlign": 1 },
  },
  "cc.Button": {
    "requires": ["cc.UITransform"],
    "description": "按钮组件，通常子节点带 Label",
    "children": [
      {
        "id": "label", "name": "Label", "required": false,
        "autoCreateCondition": "button node has no child with cc.Label",
        "components": [
          { "type": "cc.UITransform" },
          { "type": "cc.Label", "props": { "string": "Button", "fontSize": 24 } },
        ],
      },
    ],
    "defaults": {
      "transition": 0, "interactable": true,
      "_normalSprite": "internal:default-ui/default-btn-normal-sprite-frame",
      "_pressedSprite": "internal:default-ui/default-btn-pressed-sprite-frame",
      "_disabledSprite": "internal:default-ui/default-btn-disabled-sprite-frame",
    },
  },
  "cc.ScrollView": {
    "requires": ["cc.UITransform"],
    "description": "滚动视图，自动创建 view → content 子结构",
    "children": [
      {
        "id": "view", "name": "view", "required": true,
        "components": [
          { "type": "cc.UITransform" },
          { "type": "cc.Mask", "props": { "type": 0 } },
        ],
        "children": [
          {
            "id": "content", "name": "content", "required": true,
            "components": [
              { "type": "cc.UITransform" },
              { "type": "cc.Layout", "optional": true, "props": { "type": 2, "resizeMode": 1 } },
            ],
          },
        ],
      },
    ],
    "refs": { "content": { "targetType": "node", "targetChild": "content" } },
    "defaults": { "horizontal": true, "vertical": true, "bounceDuration": 0.23, "brake": 0.75, "elastic": true, "inertia": true, "cancelInnerEvents": true },
  },
  "cc.Toggle": {
    "requires": ["cc.UITransform"],
    "description": "开关组件，自动创建 Background + Checkmark 子结构",
    "children": [
      {
        "id": "background", "name": "Background", "required": true,
        "components": [
          { "type": "cc.UITransform", "props": { "width": 40, "height": 40 } },
          { "type": "cc.Sprite", "props": { "type": 0, "_spriteFrame": "internal:default-ui/default-toggle-normal-sprite-frame" } },
        ],
        "children": [
          {
            "id": "checkmark", "name": "Checkmark", "required": true,
            "components": [
              { "type": "cc.UITransform", "props": { "width": 40, "height": 40 } },
              { "type": "cc.Sprite", "props": { "type": 0, "_spriteFrame": "internal:default-ui/default-toggle-checkmark-sprite-frame" } },
            ],
          },
        ],
      },
      {
        "id": "label", "name": "Label", "required": false,
        "components": [
          { "type": "cc.UITransform" },
          { "type": "cc.Label", "props": { "fontSize": 24 } },
        ],
      },
    ],
    "refs": { "checkMark": { "targetType": "node", "targetChild": "checkmark" } },
    "defaults": { "isChecked": false, "interactable": true },
  },
  "cc.Layout": {
    "requires": ["cc.UITransform"],
    "description": "自动布局组件",
    "defaults": { "type": 0, "resizeMode": 0, "spacingX": 0, "spacingY": 0, "paddingLeft": 0, "paddingRight": 0, "paddingTop": 0, "paddingBottom": 0 },
  },
  "cc.Widget": {
    "requires": ["cc.UITransform"],
    "conflicts": ["cc.Layout"],
    "description": "对齐挂件，与 Layout 互斥",
    "defaults": { "alignMode": 2, "isAbsLeft": true, "isAbsRight": true, "isAbsTop": true, "isAbsBottom": true },
  },
  "cc.EditBox": {
    "requires": ["cc.UITransform"],
    "description": "文本输入框",
    "defaults": {
      "maxLength": 255, "inputMode": 0, "returnType": 0,
      "_background": "internal:default-ui/default-editbox-bg-sprite-frame",
    },
  },
  "cc.ScrollBar": {
    "requires": ["cc.UITransform"],
    "description": "滚动条组件",
    "defaults": {
      "direction": 1, "enableAutoHide": false, "autoHideTime": 1,
      "_handleSprite": "internal:default-ui/default-scrollbar-sprite-frame",
    },
  },
  "cc.Slider": {
    "requires": ["cc.UITransform"],
    "description": "滑动条",
    "defaults": { "progress": 0, "interactable": true },
  },
  "cc.PageView": {
    "requires": ["cc.UITransform"],
    "description": "页面视图，自动创建 view → content 子结构",
    "children": [
      {
        "id": "view", "name": "view", "required": true,
        "components": [
          { "type": "cc.UITransform" },
          { "type": "cc.Mask", "props": { "type": 0 } },
        ],
        "children": [
          {
            "id": "content", "name": "content", "required": true,
            "components": [
              { "type": "cc.UITransform" },
              { "type": "cc.Layout", "optional": true },
            ],
          },
        ],
      },
    ],
    "refs": { "content": { "targetType": "node", "targetChild": "content" } },
    "defaults": { "bounceDuration": 0.23, "brake": 0.75, "elastic": true, "inertia": true, "cancelInnerEvents": true },
  },
  "cc.Canvas": {
    "description": "渲染根节点，每个场景必须有一个。设计分辨率通过本节点的 cc.UITransform._contentSize 控制（用 set-prop component=cc.UITransform property=contentSize），适配模式通过 fitHeight/fitWidth 控制",
    "constraint": "must be placed on a node without any ancestor that has cc.RenderRoot2D",
    "defaults": {
      "cameraComponent": null,
      "alignCanvasWithScreen": true,
      "fitHeight": false,
      "fitWidth": false
    },
    "children": []
  },
  "cc.Mask": {
    "requires": ["cc.UITransform"],
    "description": "遮罩组件",
    "defaults": { "type": 0, "inverted": false, "segments": 64, "alphaThreshold": 0.1 },
  },
  "cc.Graphics": {
    "requires": ["cc.UITransform"],
    "description": "矢量绘图组件",
    "defaults": { "lineWidth": 1, "lineJoin": 2, "lineCap": 0, "miterLimit": 10 },
  },
  "cc.RichText": {
    "requires": ["cc.UITransform"],
    "description": "富文本组件",
    "defaults": { "fontSize": 24, "lineHeight": 30, "horizontalAlign": 1, "verticalAlign": 1, "maxWidth": 0 },
  },
  "cc.ProgressBar": {
    "requires": ["cc.UITransform"],
    "description": "进度条",
    "children": [
      {
        "id": "bar", "name": "bar", "required": false,
        "components": [
          { "type": "cc.UITransform" },
          { "type": "cc.Sprite", "props": { "type": 3, "_spriteFrame": "internal:default-ui/default-progressbar-sprite-frame" } },
        ],
      },
    ],
    "refs": { "barSprite": { "targetType": "node", "targetChild": "bar" } },
    "defaults": { "progress": 0, "mode": 0, "reverse": false, "totalLength": 1 },
  },
  "cc.ToggleContainer": {
    "requires": ["cc.UITransform"],
    "description": "多选一容器，子节点应为 Toggle",
    "defaults": { "allowSwitchOff": false },
  },
  "cc.PageViewIndicator": {
    "requires": ["cc.UITransform"],
    "description": "PageView 指示器",
    "defaults": { "spacing": 10, "spriteFrame": "internal:default-ui/default-sprite-sprite-frame" },
  },
  "cc.UIOpacity": {
    "requires": ["cc.UITransform"],
    "description": "UI 透明度控制",
    "defaults": { "opacity": 255 },
  },
  "cc.Camera": {
    "description": "摄像机组件",
    "defaults": { "clearFlags": 7, "depth": 1, "far": 1000, "near": 0.1, "fov": 45, "orthoSize": 10, "projection": 1 },
  },
  "cc.Animation": {
    "description": "动画组件",
    "defaults": { "playOnLoad": false, "wrapMode": 2, "speed": 1 },
  },
  "cc.ParticleSystem": {
    "description": "粒子系统",
    "defaults": { "playOnLoad": false, "prewarm": false, "simulationSpeed": 1 },
  },
  "cc.AudioSource": {
    "description": "音频源",
    "defaults": { "playOnLoad": false, "loop": false, "volume": 1 },
  },
  "cc.VideoPlayer": {
    "requires": ["cc.UITransform"],
    "description": "视频播放器",
    "defaults": { "keepAspectRatio": true, "isFullscreen": false, "loop": false, "volume": 1 },
  },
  "cc.WebView": {
    "requires": ["cc.UITransform"],
    "description": "WebView 嵌入组件",
    "defaults": { "url": "" },
  },
};

export function getKnowledgeData(): Record<string, ComponentKnowledge> {
  return KNOWLEDGE_DATA;
}
