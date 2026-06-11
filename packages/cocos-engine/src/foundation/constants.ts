// ============================================================
// Comdr 全局常量 — 所有硬编码值单一定义点
// 每个常量必须有明确的"为什么是这个值"的注释
// ============================================================

// 版本号由 scripts/stamp-version.ts 自动生成，每次构建前运行
export { VERSION } from './version.js';

// ===== 展示截断 =====
// 目标：节省 LLM 上下文 token，避免把数千字的探测结果塞进 prompt。
// 这些值只影响 Commander 看到的反馈文本，不影响 Bridge 实际返回的数据。

/** UUID 展示前缀长度（如 abc12345）。36 字符的 UUID 没必要全展示，前 8 位已足够区分。 */
export const DISPLAY_UUID_PREFIX = 8;
/** Overlay UI 名字展示截断。浮层卡片宽度有限，24 字符刚好不换行。 */
export const DISPLAY_NAME_MAX = 24;
/** ask() 问题在状态摘要中的截断。80 字符足够概括问题，再多应该在下一轮对话中展开。 */
export const DISPLAY_ASK_MAX = 80;
/** Diff 单属性值截断。颜色、位置等典型值都在 40 字符内，超长文本（如 Label.string）会被截掉多余部分。 */
export const DIFF_VALUE_MAX = 40;
/** Diff 对象序列化截断。cc.Vec2 约 20 字符，cc.Color 约 60 字符，60 覆盖常见值类型。 */
export const DIFF_OBJ_MAX = 60;

// ===== 列表上限 =====
// 目标：防止大量数据（数千个资产、数百个脚本）塞进 LLM 上下文或 Overlay 卡片。
// 这些限制不丢失数据——超出部分只是不在 LLM 反馈或 Overlay 摘要里展示。

/** Bridge 心跳中的脚本摘要条目上限。只给 Overlay 仪表盘看一眼。 */
export const LIST_HEARTBEAT_SCRIPTS = 50;
/** 回滚状态中展示的控制台 warn/error 条数。显示最近 5 条，不需要完整日志。 */
export const LIST_CONSOLE_DISPLAY = 5;
/** 回滚时从 Bridge 拉取的控制台日志条数。50 条覆盖操作前后的上下文。 */
export const LIST_CONSOLE_PULL = 50;
// ===== 缓冲区 =====
// 目标：防止内存无限增长。循环缓冲区策略，旧数据自动丢弃。

/** 控制台日志内存缓冲区最大条数。500 条在内存中可忽略不计（<1MB），同时保留调试上下文。 */
export const BUFFER_CONSOLE_LOGS = 500;
/** 编辑历史最大深度。50 次操作覆盖典型编辑会话，超过则丢弃最早记录。 */
export const BUFFER_EDIT_HISTORY = 50;

// ===== 事件摘要 =====
// 目标：Overlay 浮层是一个 380×240 的小窗口，不能显示大段 JSON。
// 事件日志文件（execution-log.jsonl）由 Overlay 轮询，裁剪防止文件膨胀。

/** 事件 data 字符串截断。Overlay 卡片只能显示 ~80 字符，200 已经给够。 */
export const EVENT_STRING_MAX = 200;
/** 事件 data 数组预览项数。显示前 3 项让用户知道"有哪些东西"。 */
export const EVENT_ARRAY_PREVIEW = 3;
/** 事件 data 数组透传阈值。≤10 项的数组整体展示，不裁剪。 */
export const EVENT_ARRAY_PASS_THROUGH = 10;
/** 事件 data 对象 key 透传阈值。≤20 个 key 的对象整体展示。 */
export const EVENT_OBJ_KEYS_MAX = 20;
/** 事件 data 对象 key 预览数。超过阈值时显示前 10 个 key 名。 */
export const EVENT_OBJ_KEYS_PREVIEW = 10;

// ===== 节点树序列化 =====
// 目标：ctx() 探测不要序列化整个场景。大场景可能有数万节点，必须设上限。

/** 节点树序列化最大节点数。240 覆盖典型 UI 层级（10 层 × 每层 20 个节点）。 */
export const TREE_MAX_NODES = 240;
/** 节点树最大遍历深度。6 层覆盖 Panel→ScrollView→view→content→item→label。 */
export const TREE_MAX_DEPTH = 6;
/** 节点详情中组件列表截断。16 个组件远超实际（通常 3-6 个），纯防御。 */
export const TREE_MAX_COMPONENTS = 16;

// ===== IPC =====
// 目标：Bridge 文件通信的轮询参数。平衡响应速度和 CPU 开销。

/** Bridge inbox/outbox 轮询间隔 (ms)。250ms 是人类无感知的延迟 + CPU 友好的频率。 */
export const IPC_POLL_MS = 250;
/** Bridge 任务默认超时 (ms)。120s 覆盖最慢的批量资源写入操作。 */
export const IPC_TIMEOUT_MS = 120_000;
/** Bridge 心跳最大年龄 (ms)。超过 30s 认为 Bridge 已崩溃或 Cocos 已关闭。 */
export const IPC_HEARTBEAT_MAX_AGE_MS = 30_000;

// ===== LLM =====
// 目标：Commander API 调用的合理默认值。可被 gateway.config.json 覆盖。

/** Commander 默认 max_tokens。4096 覆盖 DSL 输出的典型长度（200-800 tokens）+ 安全余量。 */
export const LLM_MAX_TOKENS = 4096;
/** Commander 默认温度。0.3 在 DSL 翻译任务上给最低随机性，保持输出稳定。 */
export const LLM_TEMPERATURE = 0.3;
/** Commander 最大重试次数。3 次 + 指数退避覆盖瞬时网络错误和短暂限流。 */
export const LLM_MAX_RETRIES = 3;
/** 未知 probe 类型兜底截断上限 (bytes)。10KB 远超合法探针结果（最大 ~2KB 的组件属性），纯防御 10MB blob。 */
export const DISPLAY_FALLBACK_MAX = 10_000;

/** HTTP 错误详情截断。API 错误响应 body 可能是 HTML 页面，200 字符足够定位问题。 */
export const LLM_ERROR_DETAIL_MAX = 200;
/** Commander 连续相同错误上限。超过则终止 session，防止 LLM 死循环。 */
export const GATEWAY_MAX_CONSECUTIVE_SAME_ERROR = 2;
/** 单次对话最大轮数。超过则报错终止，不静默截断——保护 API 上下文窗口。
 *  20 轮覆盖典型工作流（probe→schema→compile→write→save）+ 2-3 次错误重试。
 *  复杂任务（多层嵌套 prefab 等）可能需要 30+ 轮，可通过 gateway.config.json 中
 *  maxTurns 字段覆盖。未配置时使用此默认值。 */
export const GATEWAY_MAX_TURNS = 20;
/** 会话摘要中最近创建资产展示条数。5 条足够 LLM 知道上次做了什么。 */
export const SESSION_RECENT_CREATIONS = 5;

// ===== Overlay =====
// 目标：悬浮窗进程管理和执行日志的生命周期参数。

/** Overlay 心跳文件最大有效年龄 (ms)。超过此值认为 overlay 进程已死，可重新拉起。 */
export const OVERLAY_ALIVE_MAX_AGE_MS = 10_000;
/** Overlay 拉起锁超时 (ms)。超过此值认为上次 spawn 失败，锁可被抢占。应 > OVERLAY_ALIVE_MAX_AGE_MS。 */
export const OVERLAY_LOCK_TIMEOUT_MS = 15_000;

// ===== 日志轮转 =====
// 目标：防止日志文件无限膨胀。

/** 单次执行日志文件最大字节数（~1MB）。超过后保留最末 500 行。 */
export const EXECUTION_LOG_MAX_BYTES = 1_000_000;
/** token-usage 日志文件最大字节数（500KB）。超过后保留最末 1000 行。 */
export const TOKEN_LOG_MAX_BYTES = 500_000;

// ===== 路径 =====
// 目标：集中定义 Comdr 使用的目录名，避免各处硬编码字符串。

/** Comdr 用户级数据目录名（位于 HOME 下）。桥接配置、overlay、session 等均在此目录。 */
export const COMDIR_USER_DIR = '.comdr';
/** Comdr 项目级数据目录名（位于项目 temp/ 下）。IPC inbox/outbox、心跳、执行日志均在此目录。 */
export const COMDIR_PROJECT_DIR = 'temp/comdr';
