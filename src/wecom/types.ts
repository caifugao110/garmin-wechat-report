/**
 * WeCom 对话式助手相关环境变量类型
 *
 * 让 src/wecom/* 各模块共享同一份 Env 契约，主 worker.ts 的 Env interface 继承即可。
 */

/**
 * 企业微信自建应用基础配置（接收消息回调 + 主动消息发送都需要）
 *
 * 全部标记为可选：Worker 可能在未配置对话链路时仍运行（仅做日报推送），
 * 由 handleCallback 入口处统一做存在性检查并返回错误。
 */
export interface WecomAppEnv {
  /** 企业 ID（我的企业 → 企业信息） */
  WECOM_CORP_ID?: string;
  /** 自建应用 Secret（应用详情页） */
  WECOM_CORP_SECRET?: string;
  /** 自建应用 AgentId */
  WECOM_AGENT_ID?: string;
  /** 接收消息 API 的 Token（自填，用于验签） */
  WECOM_TOKEN?: string;
  /** 接收消息 API 的 EncodingAESKey（43 字符，自填） */
  WECOM_ENCODING_AES_KEY?: string;
}

/** 对话链路用到的额外配置（Garmin 凭据 + AI 调用） */
export interface WecomChatEnv extends WecomAppEnv {
  GARMIN_USERNAME?: string;
  GARMIN_PASSWORD?: string;
  GARMIN_OAUTH1_TOKEN?: string;
  GARMIN_OAUTH1_TOKEN_SECRET?: string;
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
}
