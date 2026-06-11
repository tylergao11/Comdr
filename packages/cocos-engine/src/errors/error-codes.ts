// ============================================================
// @comdr/core/errors — 集中式错误码
// 每个模块的错误码有唯一前缀，方便日志检索
// ============================================================

// ----- 通用 -----
export const ERR_UNKNOWN = 'E_UNKNOWN';
export const ERR_CANCELLED = 'E_CANCELLED';
export const ERR_INVALID_ARG = 'E_INVALID_ARG';

// ----- 项目上下文 (PC) -----
export const ERR_PC_NO_COCOS_PROJECT = 'PC_NO_COCOS_PROJECT';
export const ERR_PC_WORKSPACE_NOT_COCOS = 'PC_WORKSPACE_NOT_COCOS';
export const ERR_PC_PATH_NOT_FOUND = 'PC_PATH_NOT_FOUND';

// ----- 配置 (CFG) -----
export const ERR_CFG_NO_API_KEY = 'CFG_NO_API_KEY';
export const ERR_CFG_NO_PROVIDER = 'CFG_NO_PROVIDER';
export const ERR_CFG_INVALID_CONFIG = 'CFG_INVALID_CONFIG';

// ----- Commander (CMD) -----
export const ERR_CMD_NETWORK = 'CMD_NETWORK';
export const ERR_CMD_RATE_LIMIT = 'CMD_RATE_LIMIT';
export const ERR_CMD_AUTH = 'CMD_AUTH';
export const ERR_CMD_SERVER_ERROR = 'CMD_SERVER_ERROR';
export const ERR_CMD_MAX_RETRIES = 'CMD_MAX_RETRIES';

// ----- DSL (DSL) -----
export const ERR_DSL_UNKNOWN_CMD = 'DSL_UNKNOWN_CMD';

// ----- ToolCenter / Bridge (BR) -----
export const ERR_BR_BRIDGE_OFFLINE = 'BR_BRIDGE_OFFLINE';
export const ERR_BR_TASK_FAILED = 'BR_TASK_FAILED';
export const ERR_BR_TASK_TIMEOUT = 'BR_TASK_TIMEOUT';
export const ERR_BR_INVALID_RESPONSE = 'BR_INVALID_RESPONSE';

// ----- Assembler (ASM) -----
export const ERR_ASM_INVALID_SPEC = 'ASM_INVALID_SPEC';
export const ERR_ASM_MISSING_TEMPID = 'ASM_MISSING_TEMPID';
export const ERR_ASM_DUPLICATE_TEMPID = 'ASM_DUPLICATE_TEMPID';
export const ERR_ASM_MULTI_ROOT = 'ASM_MULTI_ROOT';
export const ERR_ASM_NO_ROOT = 'ASM_NO_ROOT';
export const ERR_ASM_INVALID_PARENT = 'ASM_INVALID_PARENT';
export const ERR_ASM_UNKNOWN_COMPONENT = 'ASM_UNKNOWN_COMPONENT';
export const ERR_ASM_UNRESOLVED_REF = 'ASM_UNRESOLVED_REF';
export const ERR_ASM_NO_COMPILED_JSON = 'ASM_NO_COMPILED_JSON';
export const ERR_ASM_WRAPPER_ID = 'ASM_WRAPPER_ID';

// ----- Gateway (GW) -----
export const ERR_GW_EXECUTION_ERROR = 'GW_EXECUTION_ERROR';
export const ERR_GW_UNRESOLVED_TEMPID = 'GW_UNRESOLVED_TEMPID';

// ----- Validator (VAL) -----
export const ERR_VAL_NOT_ARRAY = 'VAL_NOT_ARRAY';
export const ERR_VAL_MISSING_TYPE = 'VAL_MISSING_TYPE';
export const ERR_VAL_INVALID_ID_REF = 'VAL_INVALID_ID_REF';
export const ERR_VAL_UNKNOWN_TYPE = 'VAL_UNKNOWN_TYPE';

// ----- Script (SCR) -----
export const ERR_SCR_METHOD_NOT_FOUND = 'SCR_METHOD_NOT_FOUND';
export const ERR_SCR_SCRIPT_NOT_FOUND = 'SCR_SCRIPT_NOT_FOUND';

// ----- Schema (SCH) -----
export const ERR_SCH_COMPONENT_NOT_FOUND = 'SCH_COMPONENT_NOT_FOUND';
export const ERR_SCH_CACHE_LOAD_FAILED = 'SCH_CACHE_LOAD_FAILED';

// ----- 工厂函数 -----

export interface ComdrError {
  code: string;
  message: string;
  needMoreContext?: boolean;
  fatal?: boolean;
  detail?: unknown;
}

export function makeError(
  code: string,
  message: string,
  opts?: { needMoreContext?: boolean; fatal?: boolean; detail?: unknown }
): ComdrError {
  return {
    code,
    message,
    needMoreContext: opts?.needMoreContext,
    fatal: opts?.fatal,
    detail: opts?.detail,
  };
}

export function toErrResult(err: ComdrError): import('../types.js').ErrResult {
  return {
    ok: false,
    error: err.message,
    errorCode: err.code,
    needMoreContext: err.needMoreContext,
    fatal: err.fatal,
  };
}
