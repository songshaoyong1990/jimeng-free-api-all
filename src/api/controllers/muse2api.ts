import fs from "fs-extra";
import path from "path";
import mime from "mime";
import axios from "axios";
import { PassThrough } from "stream";
import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import {
  MUSE2API_DEFAULT_BASE_URL,
  MUSE2API_MODELS,
  isMuse2APIModelEnabled,
  looksLikeMuse2APIKey,
  normalizeMuse2APIBaseUrl,
  parseMuse2APIModel,
  type Muse2APIModelDef,
  type Muse2APIStoredConfig,
} from "@/lib/muse2api-config.ts";

/** 生图 / 生视频请求超时（muse2api 官方默认超时上限 600s） */
const IMAGE_TIMEOUT_MS = 360 * 1000;
const VIDEO_SUBMIT_TIMEOUT_MS = 120 * 1000;
const VIDEO_QUERY_TIMEOUT_MS = 45 * 1000;
const CHAT_TIMEOUT_MS = 360 * 1000;
const VIDEO_POLL_INTERVAL_MS = 3000;
const VIDEO_POLL_MAX = 400;

export type Muse2APIAuth = {
  baseUrl: string;
  apiKey: string;
};

/** 解析实际要访问的 muse2api 地址（请求 > 管理台 > 环境变量 > 默认） */
export function resolveMuse2APIBaseUrl(baseUrl?: string) {
  return normalizeMuse2APIBaseUrl(
    baseUrl || process.env.MUSE2API_BASE_URL || MUSE2API_DEFAULT_BASE_URL
  );
}

/**
 * 解析 muse2api 的 API Key：请求头（仅 m2a_ 前缀）> 管理台 > 环境变量。
 * 请求头里如果是即梦 session 之类，不会误发给 muse2api。
 */
export function resolveMuse2APIKey(
  config: Pick<Muse2APIStoredConfig, "apiKey">,
  headerToken?: string
) {
  const header = String(headerToken || "").trim();
  if (looksLikeMuse2APIKey(header)) return header;
  const saved = String(config.apiKey || "").trim();
  if (saved) return saved;
  return String(process.env.MUSE2API_KEY || "").trim();
}

export function resolveMuse2APIAuth(
  config: Pick<Muse2APIStoredConfig, "apiKey" | "baseUrl">,
  options: { baseUrl?: string; headerToken?: string } = {}
): Muse2APIAuth {
  return {
    baseUrl: resolveMuse2APIBaseUrl(options.baseUrl || config.baseUrl),
    apiKey: resolveMuse2APIKey(config, options.headerToken),
  };
}

function assertAuth(auth: Muse2APIAuth) {
  if (!auth.apiKey) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      "未提供 muse2api 密钥：请在管理台 Muse2API 页保存 API Key，或在请求头带 Authorization: Bearer m2a_...（也可设置环境变量 MUSE2API_KEY）"
    );
  }
}

/** 把 OpenAI 的 1024x1024 这类尺寸换算成画幅比例 */
export function ratioFromOpenAISize(size?: string) {
  const matched = String(size || "").match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!matched) return "";
  const width = Number(matched[1]);
  const height = Number(matched[2]);
  if (!width || !height) return "";
  const ratio = width / height;
  const candidates: [string, number][] = [
    ["1:1", 1],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
    ["3:2", 3 / 2],
    ["2:3", 2 / 3],
    ["21:9", 21 / 9],
  ];
  let best = "";
  let delta = 0.06;
  for (const [key, value] of candidates) {
    const diff = Math.abs(ratio - value);
    if (diff < delta) {
      best = key;
      delta = diff;
    }
  }
  return best;
}

/** 相对地址（/v1/media/xxx）补成绝对地址，便于客户端直接下载 */
export function absolutizeMuseUrl(url: string, baseUrl: string) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^(https?:|data:)/i.test(value)) return value;
  if (value.startsWith("/")) return `${normalizeMuse2APIBaseUrl(baseUrl)}${value}`;
  return value;
}

function describeHttpError(status: number, payload: any) {
  const detail =
    payload?.error?.message ||
    payload?.detail ||
    payload?.msg ||
    payload?.message ||
    (typeof payload === "string" ? payload : "");
  const text = String(detail || "").slice(0, 300);
  if (status === 401) return "muse2api 鉴权失败（API Key 无效或已轮换）";
  if (status === 403) return `muse2api 拒绝访问（403）${text ? `: ${text}` : ""}`;
  if (status === 409) return `muse2api 任务冲突（409）${text ? `: ${text}` : ""}`;
  if (status === 422) return `muse2api 请求参数不合法（422）${text ? `: ${text}` : ""}`;
  if (status === 429) return "muse2api 队列已满，请稍后重试";
  if (status >= 500) return `muse2api 上游失败（${status}）${text ? `: ${text}` : ""}`;
  return `muse2api 请求失败（HTTP ${status}）${text ? `: ${text}` : ""}`;
}

async function museRequest(
  auth: Muse2APIAuth,
  method: "get" | "post",
  apiPath: string,
  options: { data?: any; timeoutMs?: number } = {}
) {
  assertAuth(auth);
  const url = `${auth.baseUrl}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;
  const startedAt = Date.now();
  let response;
  try {
    response = await axios.request({
      method,
      url,
      data: options.data,
      headers: {
        Authorization: `Bearer ${auth.apiKey}`,
        ...(options.data ? { "Content-Type": "application/json" } : {}),
      },
      timeout: options.timeoutMs || 60 * 1000,
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  } catch (error: any) {
    const code = error?.code || "";
    const message =
      code === "ECONNREFUSED"
        ? `无法连接 muse2api（${auth.baseUrl}），请确认容器已启动`
        : code === "ETIMEDOUT" || String(error?.message || "").includes("timeout")
          ? `muse2api 请求超时（${Math.round((options.timeoutMs || 60000) / 1000)}s）`
          : `muse2api 网络错误: ${error?.message || error}`;
    logger.error(`[Muse2API] ✗ ${method.toUpperCase()} ${apiPath} ${message}`);
    throw new APIException(EX.API_REQUEST_FAILED, message);
  }

  const elapsed = Date.now() - startedAt;
  if (response.status >= 400) {
    const message = describeHttpError(response.status, response.data);
    logger.error(`[Muse2API] ✗ ${method.toUpperCase()} ${apiPath} ${response.status} ${elapsed}ms ${message}`);
    throw new APIException(EX.API_REQUEST_FAILED, message);
  }
  logger.info(`[Muse2API] ← ${method.toUpperCase()} ${apiPath} ${response.status} ${elapsed}ms`);
  return response.data;
}

function isLocalPath(value: string) {
  if (/^(https?:|data:)/i.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  return true;
}

function looksLikeRawBase64(value: string) {
  const text = value.replace(/\s+/g, "");
  return text.length > 128 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

/**
 * koa-body 的 multipart 临时文件名通常没有扩展名，按文件头识别类型，
 * 否则会生成 data:application/octet-stream，muse2api 会把图片当成普通文档。
 */
function detectMediaMime(buffer: Buffer, filePath: string) {
  const head = buffer.subarray(0, 16);
  const text = head.toString("latin1");
  const starts = (...values: number[]) =>
    values.every((value, index) => buffer[index] === value);

  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (text.startsWith("GIF8")) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  if (text.startsWith("BM")) return "image/bmp";
  if (text.startsWith("II*\u0000") || text.startsWith("MM\u0000*")) return "image/tiff";
  if (text.slice(4, 8) === "ftyp") return "video/mp4";
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE") return "audio/wav";
  if (text.startsWith("ID3") || starts(0xff, 0xfb)) return "audio/mpeg";
  if (text.startsWith("%PDF")) return "application/pdf";
  if (text.startsWith("OggS")) return "audio/ogg";
  return mime.getType(path.basename(filePath)) || "application/octet-stream";
}

/**
 * 把参考素材统一成 muse2api 可接受的 URL / data URL。
 * 管理台上传的 multipart 文件是本地临时路径，muse2api 默认禁止读取服务器本地文件。
 */
export async function prepareMuseReferences(sources: string[] = []): Promise<string[]> {
  const out: string[] = [];
  for (const raw of sources) {
    const value = String(raw || "").trim();
    if (!value) continue;
    if (/^(https?:|data:)/i.test(value) || looksLikeRawBase64(value)) {
      out.push(value);
      continue;
    }
    if (!isLocalPath(value)) {
      out.push(value);
      continue;
    }
    const absolutePath = path.resolve(value);
    if (!(await fs.pathExists(absolutePath))) {
      throw new APIException(EX.API_FILE_URL_INVALID, `参考素材不存在: ${absolutePath}`);
    }
    const buffer = await fs.readFile(absolutePath);
    const contentType = detectMediaMime(buffer, absolutePath);
    out.push(`data:${contentType};base64,${buffer.toString("base64")}`);
  }
  return out;
}

function extractMediaUrls(payload: any, baseUrl: string) {
  const list: any[] = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : payload?.data
        ? [payload.data]
        : [];
  const urls: string[] = [];
  for (const item of list) {
    const url =
      typeof item === "string"
        ? item
        : item?.url || item?.image_url || item?.video_url || (item?.b64_json ? "" : "");
    if (typeof url === "string" && url.trim()) urls.push(absolutizeMuseUrl(url, baseUrl));
  }
  if (!urls.length) {
    const fallback = payload?.url || payload?.result?.url || payload?.video?.url;
    if (typeof fallback === "string" && fallback.trim()) {
      urls.push(absolutizeMuseUrl(fallback, baseUrl));
    }
  }
  return _.uniq(urls);
}

export type GenerateMuseImageOptions = {
  /** 参考图：URL / data URL / 本地路径 */
  images?: string[];
  /** OpenAI size，如 1024x1024；也可直接传 16:9 */
  size?: string;
  aspectRatio?: string;
  /** 上游采样次数（muse2api 每次只出一张，这里循环提交） */
  n?: number;
  timeout?: number;
  extra?: string;
  baseUrl?: string;
  headerToken?: string;
};

/** 生图：POST /v1/images/generations（同步返回） */
export async function generateMuseImages(
  model: string,
  prompt: string,
  options: GenerateMuseImageOptions,
  config: Muse2APIStoredConfig
): Promise<string[]> {
  const def = parseMuse2APIModel(model);
  if (!def || def.type !== "image") {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, `无效的 muse2api 生图模型: ${model}`);
  }
  if (!isMuse2APIModelEnabled(config, def.id)) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      `muse2api 模型 ${def.id} 已在管理台禁用，请到 Muse2API 页启用后再调用`
    );
  }
  if (!String(prompt || "").trim()) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "prompt 不能为空");
  }

  const auth = resolveMuse2APIAuth(config, {
    baseUrl: options.baseUrl,
    headerToken: options.headerToken,
  });
  assertAuth(auth);

  let count = Number(options.n);
  if (!Number.isFinite(count) || count < 1) count = 1;
  count = Math.min(4, Math.floor(count));

  const images = await prepareMuseReferences(options.images || []);
  const urls: string[] = [];

  for (let index = 0; index < count; index += 1) {
    if (count > 1) logger.info(`[Muse2API] 第 ${index + 1}/${count} 次生图`);
    const payload = await museRequest(auth, "post", "/v1/images/generations", {
      data: {
        model: def.upstream,
        prompt,
        n: 1,
        ...(options.size ? { size: options.size } : {}),
        ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
        response_format: "url",
        ...(options.timeout ? { timeout: options.timeout } : {}),
        ...(images.length ? { images: images.map((url) => ({ url })) } : {}),
        ...(options.extra ? { extra: options.extra } : {}),
      },
      timeoutMs: IMAGE_TIMEOUT_MS,
    });
    const batch = extractMediaUrls(payload, auth.baseUrl);
    if (!batch.length) {
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "muse2api 未返回图片地址");
    }
    urls.push(...batch);
    if (urls.length >= count) break;
  }

  logger.info(
    `[Muse2API] 生图完成 model=${def.id} refs=${images.length} urls=${urls.length} first=${
      urls[0] ? urls[0].slice(0, 100) : "-"
    }`
  );
  return urls.slice(0, count);
}

export type MuseVideoOptions = {
  images?: string[];
  duration?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: string;
  timeout?: number;
  extra?: string;
  baseUrl?: string;
  headerToken?: string;
};

/** 提交视频任务：POST /v1/videos，返回上游 task id */
export async function submitMuseVideo(
  model: string,
  prompt: string,
  options: MuseVideoOptions,
  config: Muse2APIStoredConfig
): Promise<string> {
  const def = parseMuse2APIModel(model);
  if (!def || def.type !== "video") {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      `muse2api 视频请使用 model=muse:video 或 muse-video（当前: ${model}）`
    );
  }
  if (!isMuse2APIModelEnabled(config, def.id)) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      `muse2api 模型 ${def.id} 已在管理台禁用，请到 Muse2API 页启用后再调用`
    );
  }
  if (!String(prompt || "").trim()) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "prompt 不能为空");
  }

  const auth = resolveMuse2APIAuth(config, {
    baseUrl: options.baseUrl,
    headerToken: options.headerToken,
  });
  assertAuth(auth);

  const images = await prepareMuseReferences(options.images || []);
  const payload = await museRequest(auth, "post", "/v1/videos", {
    data: {
      model: def.upstream,
      prompt,
      ...(options.duration ? { duration: options.duration } : {}),
      ...(options.size ? { size: options.size } : {}),
      ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
      ...(options.resolution ? { resolution: options.resolution } : {}),
      ...(options.timeout ? { timeout: options.timeout } : {}),
      ...(images.length ? { images: images.map((url) => ({ url })) } : {}),
      ...(options.extra ? { extra: options.extra } : {}),
    },
    timeoutMs: VIDEO_SUBMIT_TIMEOUT_MS,
  });

  const taskId = String(payload?.id || payload?.task_id || "").trim();
  if (!taskId) {
    throw new APIException(EX.API_VIDEO_GENERATION_FAILED, "muse2api 未返回任务 id");
  }
  logger.info(
    `[Muse2API] 视频任务已提交 model=${def.id} task=${taskId} duration=${
      options.duration ?? "-"
    } refs=${images.length}`
  );
  return taskId;
}

export function encodeMuseTaskId(taskId: string) {
  return `muse-${taskId}`;
}

export function parseMuseTaskId(id: string): string | null {
  const value = String(id || "").trim();
  if (!value.toLowerCase().startsWith("muse-")) return null;
  const rest = value.slice("muse-".length).trim();
  return rest || null;
}

export function isMuseTaskId(id: string) {
  return parseMuseTaskId(id) !== null;
}

export type MuseVideoQueryResult =
  | { status: "in_progress"; progress?: number }
  | { status: "completed"; url: string }
  | { status: "failed"; message: string };

/** 查询视频任务：GET /v1/videos/{task_id} */
export async function queryMuseVideo(
  taskId: string,
  config: Muse2APIStoredConfig,
  options: { baseUrl?: string; headerToken?: string } = {}
): Promise<MuseVideoQueryResult> {
  const auth = resolveMuse2APIAuth(config, {
    baseUrl: options.baseUrl,
    headerToken: options.headerToken,
  });
  assertAuth(auth);

  const payload = await museRequest(auth, "get", `/v1/videos/${encodeURIComponent(taskId)}`, {
    timeoutMs: VIDEO_QUERY_TIMEOUT_MS,
  });

  const rawStatus = String(payload?.status || "").toLowerCase();
  const progress = Number(payload?.progress);
  const url =
    payload?.url ||
    payload?.result?.url ||
    payload?.video?.url ||
    "";

  if (rawStatus === "failed" || rawStatus === "error") {
    return {
      status: "failed",
      message: String(payload?.error || payload?.message || "muse2api 视频生成失败"),
    };
  }
  if (url && (rawStatus === "completed" || rawStatus === "succeeded" || rawStatus === "success" || rawStatus === "done" || rawStatus === "")) {
    return { status: "completed", url: absolutizeMuseUrl(String(url), auth.baseUrl) };
  }
  if (url) {
    return { status: "completed", url: absolutizeMuseUrl(String(url), auth.baseUrl) };
  }
  if (rawStatus === "completed" || rawStatus === "succeeded" || rawStatus === "success" || rawStatus === "done") {
    return { status: "failed", message: "muse2api 任务已完成但没有返回视频地址" };
  }
  return {
    status: "in_progress",
    progress: Number.isFinite(progress) ? progress : undefined,
  };
}

/** 同步等待视频完成（供 /v1/videos/generations 使用） */
export async function waitForMuseVideo(
  taskId: string,
  config: Muse2APIStoredConfig,
  options: { baseUrl?: string; headerToken?: string; timeoutMs?: number } = {}
): Promise<string> {
  const deadline = Date.now() + (options.timeoutMs || 11 * 60 * 1000);
  let attempt = 0;
  while (Date.now() < deadline && attempt < VIDEO_POLL_MAX) {
    attempt += 1;
    const state = await queryMuseVideo(taskId, config, options);
    if (state.status === "completed") return state.url;
    if (state.status === "failed") {
      throw new APIException(EX.API_VIDEO_GENERATION_FAILED, state.message);
    }
    if (attempt % 5 === 0) {
      logger.info(
        `[Muse2API] 视频轮询 #${attempt} task=${taskId} progress=${state.progress ?? "-"}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
  }
  throw new APIException(EX.API_VIDEO_GENERATION_FAILED, "muse2api 视频生成超时");
}

/** 对话补全（非流式）：直接返回上游的 OpenAI 格式响应 */
export async function createMuseChatCompletion(
  messages: any[],
  config: Muse2APIStoredConfig,
  options: { baseUrl?: string; headerToken?: string; model?: string } = {}
) {
  const auth = resolveMuse2APIAuth(config, {
    baseUrl: options.baseUrl,
    headerToken: options.headerToken,
  });
  assertAuth(auth);
  const def = parseMuse2APIModel(options.model || "muse:spark") || MUSE2API_MODELS[2];
  const payload = await museRequest(auth, "post", "/v1/chat/completions", {
    data: {
      model: def.upstream,
      messages,
      stream: false,
    },
    timeoutMs: CHAT_TIMEOUT_MS,
  });
  logger.info(`[Muse2API] 对话完成 model=${def.id} choices=${payload?.choices?.length || 0}`);
  return payload;
}

/** 对话补全（流式）：把上游 SSE 透传出去 */
export async function createMuseChatStream(
  messages: any[],
  config: Muse2APIStoredConfig,
  options: { baseUrl?: string; headerToken?: string; model?: string } = {}
) {
  const auth = resolveMuse2APIAuth(config, {
    baseUrl: options.baseUrl,
    headerToken: options.headerToken,
  });
  assertAuth(auth);
  const def = parseMuse2APIModel(options.model || "muse:spark") || MUSE2API_MODELS[2];

  const stream = new PassThrough();
  const url = `${auth.baseUrl}/v1/chat/completions`;
  logger.info(`[Muse2API] 对话流式请求 model=${def.id} messages=${messages.length}`);

  axios
    .post(
      url,
      { model: def.upstream, messages, stream: true },
      {
        headers: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        responseType: "stream",
        timeout: CHAT_TIMEOUT_MS,
        validateStatus: () => true,
      }
    )
    .then((response) => {
      if (response.status >= 400) {
        let raw = "";
        response.data.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        response.data.on("end", () => {
          let payload: any = raw;
          try {
            payload = JSON.parse(raw);
          } catch {
            /* 保留原始文本 */
          }
          const message = describeHttpError(response.status, payload);
          logger.error(`[Muse2API] 流式请求失败 ${response.status} ${message}`);
          stream.write(
            "data: " +
              JSON.stringify({
                error: { message, type: "upstream_error" },
              }) +
              "\n\n"
          );
          stream.end("data: [DONE]\n\n");
        });
        return;
      }
      response.data.pipe(stream);
    })
    .catch((error: any) => {
      const message =
        error?.code === "ECONNREFUSED"
          ? `无法连接 muse2api（${auth.baseUrl}），请确认容器已启动`
          : `muse2api 对话失败: ${error?.message || error}`;
      logger.error(`[Muse2API] ${message}`);
      stream.write(
        "data: " + JSON.stringify({ error: { message, type: "upstream_error" } }) + "\n\n"
      );
      stream.end("data: [DONE]\n\n");
    });

  return stream;
}

/** 连通性测试：拉 /v1/models */
export async function pingMuse2API(auth: Muse2APIAuth) {
  assertAuth(auth);
  const payload = await museRequest(auth, "get", "/v1/models", { timeoutMs: 15000 });
  const models = Array.isArray(payload?.data)
    ? payload.data.map((item: any) => String(item?.id || "")).filter(Boolean)
    : [];
  return {
    baseUrl: auth.baseUrl,
    models,
    object: payload?.object || "list",
  };
}

/** 下载 muse2api 生成的媒体，供 /v1/videos/{id}/content 使用 */
export async function fetchMuseMedia(url: string) {
  const absolute = /^https?:/i.test(url) ? url : absolutizeMuseUrl(url, resolveMuse2APIBaseUrl());
  const response = await axios.get(absolute, {
    responseType: "arraybuffer",
    timeout: 120000,
    maxContentLength: 300 * 1024 * 1024,
  });
  return Buffer.from(response.data);
}
