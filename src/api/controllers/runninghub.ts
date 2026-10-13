import fs from "fs-extra";
import path from "path";
import axios from "axios";
import FormData from "form-data";
import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import {
  resolveOpenAIMapping,
  type RunningHubOpenAIMapping,
} from "@/lib/openai-images-compat.ts";

const DEFAULT_BASE_URL = "https://www.runninghub.cn";
const POLL_INTERVAL_MS = 2500;
const MAX_POLLS = 720;

export type RunningHubField = {
  nodeId?: string;
  fieldName?: string;
  fieldValue?: string;
  fieldType?: string;
  label?: string;
  enabled?: boolean;
  required?: boolean;
  random_enabled?: boolean;
  min?: string;
  max?: string;
  step?: string;
  options?: string[];
};

export type RunningHubNodeInfo = {
  nodeId: string;
  fieldName: string;
  fieldValue: string;
};

export type ParsedRunningHubModel = { kind: "app" | "workflow"; id: string };

export type GenerateRunningHubOptions = {
  filePath?: string;
  images?: string[];
  baseUrl?: string;
  instanceType?: string;
  /** OpenAI n，最多由路由层截断到 4 */
  n?: number;
  /** key = nodeId::fieldName */
  rhParams?: Record<string, string>;
  /** key = nodeId::fieldName，为 true 时对该 random 字段强制随机 */
  rhRandom?: Record<string, boolean>;
  /** key = nodeId::fieldName，为 true 时无图也提交 fieldValue:"" */
  rhEmptyImage?: Record<string, boolean>;
  /** OpenAI → 节点字段映射 */
  openaiMapping?: RunningHubOpenAIMapping;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRunningHubModel(model: string): ParsedRunningHubModel | null {
  const value = String(model || "").trim().replace(/^runninghub:/i, "");
  const match = /^(app|workflow):(.+)$/i.exec(value);
  if (!match) return null;
  const id = match[2].trim();
  if (!id) return null;
  return { kind: match[1].toLowerCase() as "app" | "workflow", id };
}

export function isRunningHubModel(model: string) {
  return parseRunningHubModel(model) !== null;
}

function resolveBaseUrl(baseUrl?: string) {
  const fromEnv = process.env.RUNNINGHUB_BASE_URL?.trim();
  const raw = String(baseUrl || fromEnv || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return raw.replace(/\/openapi\/v2$/i, "").replace(/\/openapi$/i, "") || DEFAULT_BASE_URL;
}

function rhEndpoint(baseUrl: string, apiPath: string) {
  const base = resolveBaseUrl(baseUrl);
  return `${base}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;
}

const RH_ERROR_MESSAGES: Record<string, string> = {
  NOT_FOUND: "RunningHub 应用或工作流不存在",
  TOKEN_INVALID: "RunningHub API Key 无效",
  INSUFFICIENT_BALANCE: "RunningHub 账户余额不足",
  TASK_CREATE_FAILED_BY_NOT_ENOUGH_WALLET: "RunningHub 账户余额不足",
  APIKEY_UNAUTHORIZED: "RunningHub API Key 无效或已失效",
  APIKEY_INVALID_NODE_INFO: "RunningHub 参数与工作流定义不匹配",
  APIKEY_TASK_STATUS_ERROR: "RunningHub 任务执行失败，请检查素材或参数后重试",
  APIKEY_UPLOAD_FAILED: "RunningHub 素材上传失败",
  CONTENT_VERIFICATION_FAILED: "RunningHub 内容审核未通过",
};

function formatRhError(msg: string) {
  const trimmed = String(msg || "").trim();
  return RH_ERROR_MESSAGES[trimmed] || trimmed || "RunningHub 请求失败";
}

function formatFailedReason(raw: any): string {
  const reason = raw?.data?.failedReason;
  if (!reason || typeof reason !== "object") return "";
  const node = reason.node_name || reason.nodeName || "";
  const type = reason.exception_type || reason.exceptionType || "";
  const msg = reason.message || reason.traceback || "";
  const parts = [node && `节点=${node}`, type && `异常=${type}`, msg && `详情=${summarizeValue(msg, 180)}`].filter(
    Boolean
  );
  return parts.join(" ");
}

function throwRh(msg: string): never {
  throw new APIException(EX.API_REQUEST_FAILED, formatRhError(msg));
}

function maskSecret(value: string) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "***";
  return `${text.slice(0, 4)}...${text.slice(-4)} (len=${text.length})`;
}

function summarizeValue(value: unknown, max = 96) {
  const text = value == null ? "" : String(value);
  if (!text) return "";
  if (text.startsWith("data:")) return `data:(${text.length} chars)`;
  if (/^https?:\/\//i.test(text) && text.length > max) return `${text.slice(0, max)}...`;
  if (text.length > max) return `${text.slice(0, max)}...(${text.length})`;
  return text;
}

function sanitizeRhBody(body: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...body };
  if (typeof out.apiKey === "string") out.apiKey = maskSecret(out.apiKey);
  if (Array.isArray(out.nodeInfoList)) {
    out.nodeInfoList = (out.nodeInfoList as RunningHubNodeInfo[]).map((item) => ({
      nodeId: item?.nodeId,
      fieldName: item?.fieldName,
      fieldValue: summarizeValue(item?.fieldValue),
    }));
  }
  return out;
}

function formatNodeInfoSummary(list: RunningHubNodeInfo[]) {
  return list
    .map((item) => `${item.nodeId}::${item.fieldName}=${summarizeValue(item.fieldValue, 48)}`)
    .join("; ");
}

async function postRh(baseUrl: string, apiPath: string, body: Record<string, unknown>) {
  const url = rhEndpoint(baseUrl, apiPath);
  const isPoll = apiPath.includes("/outputs");
  if (!isPoll) {
    logger.info(`[RunningHub] → POST ${apiPath} url=${url}`);
    logger.info(`[RunningHub] 请求体 ${JSON.stringify(sanitizeRhBody(body))}`);
  }
  let response;
  try {
    response = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 120000,
      validateStatus: () => true,
    });
  } catch (err: any) {
    logger.error(`[RunningHub] ✗ POST ${apiPath} 网络错误: ${err?.message || err}`);
    throwRh(err?.message || "RunningHub 网络请求失败");
  }
  if (response.status >= 400) {
    const msg =
      typeof response.data === "object" && response.data?.msg
        ? String(response.data.msg)
        : `RunningHub HTTP ${response.status}`;
    logger.error(`[RunningHub] ✗ POST ${apiPath} HTTP ${response.status} msg=${msg}`);
    logger.info(`[RunningHub] 错误响应全文: ${JSON.stringify(response.data)}`);
    throwRh(msg);
  }
  const data = response.data;
  if (!isPoll) {
    logger.info(
      `[RunningHub] ← POST ${apiPath} code=${data?.code ?? "-"} msg=${data?.msg || "ok"} taskId=${data?.data?.taskId || "-"}`
    );
  }
  return data;
}

function rhFieldKind(field: RunningHubField) {
  const type = String(field.fieldType || "").trim().toUpperCase();
  if (type === "IMAGE" || type.includes("IMAGE")) return "image";
  if (type === "VIDEO" || type.includes("VIDEO")) return "video";
  if (type === "AUDIO" || type.includes("AUDIO")) return "audio";
  if (type === "SLIDER") return "slider";
  if (["NUMBER", "FLOAT", "INTEGER", "INT"].includes(type) || type.includes("NUMBER")) return "number";
  if (["BOOLEAN", "BOOL"].includes(type)) return "boolean";
  const key = `${field.fieldName || ""} ${field.fieldValue || ""}`.toLowerCase();
  if (/\b(image|img|mask|photo|picture)\b/.test(key) || /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(key)) return "image";
  return "text";
}

function rhFieldRole(field: RunningHubField) {
  const kind = rhFieldKind(field);
  if (["image", "video", "audio", "number", "slider", "boolean"].includes(kind)) return kind;
  const text = `${field.fieldName || ""} ${field.label || ""}`.toLowerCase();
  if (/prompt|positive|negative|text|caption|description|关键词|提示词|正向|负向/.test(text)) return "prompt";
  return "text";
}

function rhDefaultValue(field: RunningHubField) {
  let value: unknown = field.fieldValue;
  if (Array.isArray(value)) value = value[0];
  if (value === undefined || value === null || typeof value === "object") return "";
  return String(value).trim();
}

function rhIsSeedLikeName(fieldName?: string, label?: string) {
  return /\b(seed|种子)\b/i.test(`${fieldName || ""} ${label || ""}`);
}

function rhRandomFieldValue(field: RunningHubField) {
  const step = Number(field.step);
  const isFloat = Number.isFinite(step) && step > 0 && step < 1;
  const looksSeed = rhIsSeedLikeName(field.fieldName, field.label);
  let min = Number.isFinite(Number(field.min)) ? Number(field.min) : null;
  let max = Number.isFinite(Number(field.max)) ? Number(field.max) : null;
  if (min === null) min = looksSeed ? 1 : 0;
  if (max === null || max <= min) max = looksSeed ? 4294967295 : 999999;
  let value = min + Math.random() * (max - min);
  if (isFloat) {
    const precision = Math.min(8, Math.max(1, String(field.step).split(".")[1]?.length || 2));
    return String(Number(value.toFixed(precision)));
  }
  return String(Math.floor(value));
}

function rhParamKey(nodeId: string, fieldName: string) {
  return `${nodeId}::${fieldName}`;
}

function extractFieldOptions(field: RunningHubField): string[] {
  if (Array.isArray(field.options) && field.options.length) {
    return field.options.map((item) => String(item)).filter(Boolean);
  }
  const raw = field.fieldValue as unknown;
  if (Array.isArray(raw)) return raw.map((item) => String(item)).filter(Boolean);
  return [];
}

function buildRunningHubNodeInfoList(options: {
  fields: RunningHubField[];
  prompt: string;
  uploadedImages: string[];
  rhParams?: Record<string, string>;
  rhRandom?: Record<string, boolean>;
  rhEmptyImage?: Record<string, boolean>;
  openaiMapping?: RunningHubOpenAIMapping;
}) {
  const fields = (options.fields || []).filter((field) => field.enabled !== false);
  const mapping = resolveOpenAIMapping(
    fields.map((field) => ({
      nodeId: String(field.nodeId || ""),
      fieldName: String(field.fieldName || ""),
      label: field.label,
      fieldType: field.fieldType,
      role: rhFieldRole(field),
      options: extractFieldOptions(field),
    })),
    options.openaiMapping
  );
  const promptKeys = new Set(mapping.prompt || []);
  const imageKeyOrder = mapping.images || [];
  const imageIndexByKey = new Map(imageKeyOrder.map((key, index) => [key, index]));
  const usePromptMap = promptKeys.size > 0;
  const useImageMap = imageKeyOrder.length > 0;

  const imageCursor = new Map<string, number>();
  const nodeInfoList: RunningHubNodeInfo[] = [];
  const promptText = options.prompt.trim();
  const rhParams = options.rhParams || {};
  const rhRandom = options.rhRandom || {};
  const rhEmptyImage = options.rhEmptyImage || {};

  for (const field of fields) {
    const nodeId = String(field.nodeId || "").trim();
    const fieldName = String(field.fieldName || "").trim();
    if (!nodeId || !fieldName) continue;
    const key = rhParamKey(nodeId, fieldName);
    const kind = rhFieldKind(field);
    const role = rhFieldRole(field);
    // rh_params 显式出现该 key（即使值为空）视为覆盖，不再回落到工作流默认值
    const hasOverride = Object.prototype.hasOwnProperty.call(rhParams, key);
    const override = hasOverride ? String(rhParams[key] ?? "").trim() : "";

    if (kind === "image") {
      // 默认：有图才提交；勾选 rhEmptyImage 后无图也传 fieldValue:""
      let value = "";
      if (hasOverride) {
        value = override;
      } else if (useImageMap) {
        const mappedIndex = imageIndexByKey.get(key);
        if (mappedIndex != null) value = options.uploadedImages[mappedIndex] || "";
        else if (rhEmptyImage[key] !== true) continue; // 未映射且未勾选空提交：跳过
      } else {
        const index = imageCursor.get("__seq__") || 0;
        imageCursor.set("__seq__", index + 1);
        value = options.uploadedImages[index] || "";
      }
      if (value) {
        nodeInfoList.push({ nodeId, fieldName, fieldValue: value });
      } else if (rhEmptyImage[key] === true) {
        nodeInfoList.push({ nodeId, fieldName, fieldValue: "" });
        logger.info(`[RunningHub] image→${key} 无图，勾选空提交 → fieldValue=""`);
      } else {
        logger.info(`[RunningHub] image→${key} 无图，跳过该节点`);
      }
      continue;
    }

    if (kind === "boolean") {
      const value = hasOverride ? override || "false" : rhDefaultValue(field) || "false";
      nodeInfoList.push({ nodeId, fieldName, fieldValue: value });
      continue;
    }

    if (kind !== "text" && kind !== "number" && kind !== "slider") continue;

    const isPromptTarget = usePromptMap ? promptKeys.has(key) : role === "prompt";
    if (isPromptTarget) {
      // 请求 prompt 优先；rh_params / 字段默认值仅在请求为空时兜底
      const value = promptText || (hasOverride ? override : "") || rhDefaultValue(field) || "";
      if (value) {
        nodeInfoList.push({ nodeId, fieldName, fieldValue: value });
        logger.info(
          `[RunningHub] prompt→${key} via=${promptText ? "request" : hasOverride && override ? "rh_params" : "field-default"} len=${value.length}`
        );
      } else {
        logger.warn(`[RunningHub] prompt→${key} 为空，已跳过`);
      }
      continue;
    }

    const forceRandom = rhRandom[key] === true;
    const forceFixed = rhRandom[key] === false;
    if (
      (kind === "number" || kind === "slider") &&
      field.random_enabled &&
      (forceRandom || (!forceFixed && !hasOverride))
    ) {
      nodeInfoList.push({ nodeId, fieldName, fieldValue: rhRandomFieldValue(field) });
      continue;
    }

    // 显式空覆盖 → 不提交该字段（避免空串回落成默认 en 之类）
    if (hasOverride) {
      if (override) nodeInfoList.push({ nodeId, fieldName, fieldValue: override });
      continue;
    }
    const value = rhDefaultValue(field);
    if (value) nodeInfoList.push({ nodeId, fieldName, fieldValue: value });
  }

  return nodeInfoList;
}

function extractOutputUrls(data: unknown): string[] {
  if (!data) return [];
  const urls: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("data:")) urls.push(trimmed);
  };
  if (Array.isArray(data)) {
    data.forEach((item) => {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        push(record.fileUrl);
        push(record.url);
        push(record.imageUrl);
      }
    });
    return _.uniq(urls);
  }
  if (typeof data === "object") {
    const record = data as Record<string, unknown>;
    ["fileUrl", "url", "imageUrl", "output", "outputs"].forEach((key) => {
      const value = record[key];
      if (Array.isArray(value)) value.forEach(push);
      else push(value);
    });
  }
  return _.uniq(urls);
}

function queryStatus(code: unknown) {
  if (code === 0 || code === "0") return "SUCCESS" as const;
  if (code === 804 || code === "804") return "RUNNING" as const;
  if (code === 813 || code === "813") return "QUEUED" as const;
  if (code === 805 || code === "805") return "FAILED" as const;
  return "UNKNOWN" as const;
}

function normalizeFields(fields: unknown): RunningHubField[] {
  if (!Array.isArray(fields)) return [];
  return fields.map((item) => {
    const field = (item || {}) as RunningHubField;
    return {
      ...field,
      nodeId: String(field.nodeId || ""),
      fieldName: String(field.fieldName || ""),
      enabled: field.enabled !== false,
    };
  });
}

function rhIsWorkflowLinkValue(value: unknown) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]);
}

function rhInferWorkflowFieldType(fieldName: string, fieldValue: string) {
  const key = `${fieldName || ""} ${fieldValue || ""}`.toLowerCase();
  if (/\b(image|img|mask|photo|picture)\b/.test(key) || /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(key)) return "IMAGE";
  if (/\b(video|movie|mp4)\b/.test(key) || /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(key)) return "VIDEO";
  if (/\b(audio|sound|music|voice)\b/.test(key) || /\.(mp3|wav|ogg|m4a|flac|aac)(\?|$)/i.test(key)) return "AUDIO";
  if (/^(true|false)$/i.test(String(fieldValue || ""))) return "BOOLEAN";
  if (String(fieldValue || "").trim() !== "" && !Number.isNaN(Number(fieldValue))) return "NUMBER";
  return "TEXT";
}

function workflowFieldsFromPromptJson(data: Record<string, unknown>): RunningHubField[] {
  const list: RunningHubField[] = [];
  Object.entries(data).forEach(([nodeId, nodeContent]) => {
    const inputs = (nodeContent as { inputs?: Record<string, unknown> })?.inputs || {};
    Object.entries(inputs).forEach(([fieldName, rawValue]) => {
      if (rhIsWorkflowLinkValue(rawValue)) return;
      let fieldValue: unknown = rawValue;
      if (fieldValue !== null && typeof fieldValue === "object") fieldValue = JSON.stringify(fieldValue);
      else if (fieldValue === undefined || fieldValue === null) fieldValue = "";
      else fieldValue = String(fieldValue);
      list.push({
        nodeId: String(nodeId),
        fieldName: String(fieldName),
        fieldValue: String(fieldValue),
        fieldType: rhInferWorkflowFieldType(fieldName, String(fieldValue)),
        enabled: true,
      });
    });
  });
  return list;
}

function workflowJsonFromInfo(raw: Record<string, unknown>) {
  const prompt = raw.prompt;
  if (typeof prompt === "string" && prompt.trim()) {
    try {
      return JSON.parse(prompt) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (prompt && typeof prompt === "object") return prompt as Record<string, unknown>;
  return {};
}

async function fetchAppFields(baseUrl: string, apiKey: string, webappId: string) {
  const info = await fetchAppInfo(baseUrl, apiKey, webappId);
  return info.fields;
}

async function fetchAppInfo(baseUrl: string, apiKey: string, webappId: string) {
  const query = new URLSearchParams({ apiKey, webappId });
  const response = await axios.get(rhEndpoint(baseUrl, `/api/webapp/apiCallDemo?${query.toString()}`), {
    timeout: 60000,
    validateStatus: () => true,
  });
  if (response.status >= 400) throwRh(response.data?.msg || `RunningHub HTTP ${response.status}`);
  const raw = response.data;
  if (raw?.code !== 0 && raw?.code !== "0" && raw?.code != null) throwRh(raw?.msg || "RunningHub 应用参数拉取失败");
  const data = raw?.data || {};
  let fields: RunningHubField[] = [];
  if (Array.isArray(data.nodeInfoList)) fields = normalizeFields(data.nodeInfoList);
  else if (Array.isArray(data)) fields = normalizeFields(data);
  else if (Array.isArray(data.nodeInfoListDemo)) fields = normalizeFields(data.nodeInfoListDemo);
  const title = String(data.name || data.webappName || data.title || data.appName || "").trim();
  return { fields, title };
}

async function fetchWorkflowFields(baseUrl: string, apiKey: string, workflowId: string) {
  const info = await fetchWorkflowInfo(baseUrl, apiKey, workflowId);
  return info.fields;
}

async function fetchWorkflowInfo(baseUrl: string, apiKey: string, workflowId: string) {
  const raw = await postRh(baseUrl, "/api/openapi/getJsonApiFormat", { apiKey, workflowId });
  if (raw?.code !== 0 && raw?.code !== "0") throwRh(raw?.msg || "RunningHub 工作流参数拉取失败");
  const data = (raw?.data || {}) as Record<string, unknown>;
  const workflowJson = workflowJsonFromInfo(data);
  const fields = workflowFieldsFromPromptJson(workflowJson);
  const title = String(data.name || data.workflowName || data.title || "").trim();
  return { fields, title, workflowJson };
}

export type RunningHubFieldSummary = {
  nodeId: string;
  fieldName: string;
  fieldType?: string;
  label?: string;
  fieldValue?: string;
  required?: boolean;
  enabled?: boolean;
  random_enabled?: boolean;
  role: string;
  min?: string;
  max?: string;
  step?: string;
  options?: string[];
};

export type RunningHubAnalyzeResult = {
  kind: "app" | "workflow";
  id: string;
  title: string;
  fields: RunningHubFieldSummary[];
  rhParams: Record<string, string>;
  analysis: {
    fieldCount: number;
    imageCount: number;
    promptCount: number;
    requiredCount: number;
  };
  analyzedAt: string;
};

function summarizeFields(fields: RunningHubField[]): RunningHubFieldSummary[] {
  return fields
    .map((field) => {
      const nodeId = String(field.nodeId || "").trim();
      const fieldName = String(field.fieldName || "").trim();
      if (!nodeId || !fieldName) return null;
      const options = extractFieldOptions(field);
      const defaultValue = rhDefaultValue(field);
      return {
        nodeId,
        fieldName,
        fieldType: field.fieldType ? String(field.fieldType) : undefined,
        label: field.label ? String(field.label) : undefined,
        fieldValue: defaultValue || undefined,
        required: field.required === true,
        enabled: field.enabled !== false,
        random_enabled: field.random_enabled === true,
        role: rhFieldRole(field),
        min: field.min != null ? String(field.min) : undefined,
        max: field.max != null ? String(field.max) : undefined,
        step: field.step != null ? String(field.step) : undefined,
        options: options.length ? options : undefined,
      } as RunningHubFieldSummary;
    })
    .filter(Boolean) as RunningHubFieldSummary[];
}

function buildDefaultRhParams(fields: RunningHubFieldSummary[]) {
  const params: Record<string, string> = {};
  for (const field of fields) {
    if (field.role === "image" || field.role === "video" || field.role === "audio" || field.role === "prompt") continue;
    if (field.enabled === false) continue;
    const key = rhParamKey(field.nodeId, field.fieldName);
    if (field.fieldValue) params[key] = field.fieldValue;
  }
  return params;
}

/** 拉取并分析 app/workflow 字段（添加链接后调用） */
export async function analyzeRunningHubEntry(
  kind: "app" | "workflow",
  id: string,
  options: { baseUrl?: string; apiKey: string }
): Promise<RunningHubAnalyzeResult> {
  const webappOrWorkflowId = String(id || "").trim();
  if (!webappOrWorkflowId) throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "缺少应用或工作流 ID");
  const apiKey = String(options.apiKey || "").trim();
  if (!apiKey) throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "请先在管理台配置 RunningHub API Key，再添加链接分析");

  const baseUrl = resolveBaseUrl(options.baseUrl);
  logger.info(`[RunningHub] 分析开始 ${kind}:${webappOrWorkflowId} base=${baseUrl} key=${maskSecret(apiKey)}`);
  const info =
    kind === "app"
      ? await fetchAppInfo(baseUrl, apiKey, webappOrWorkflowId)
      : await fetchWorkflowInfo(baseUrl, apiKey, webappOrWorkflowId);

  const fields = summarizeFields(info.fields);
  const title =
    info.title ||
    (kind === "app" ? `AI 应用 ${webappOrWorkflowId.slice(-6)}` : `工作流 ${webappOrWorkflowId.slice(-6)}`);
  const analysis = {
    fieldCount: fields.length,
    imageCount: fields.filter((item) => item.role === "image").length,
    promptCount: fields.filter((item) => item.role === "prompt").length,
    requiredCount: fields.filter((item) => item.required).length,
  };
  logger.info(
    `[RunningHub] 分析完成 ${kind}:${webappOrWorkflowId} title="${title}" fields=${analysis.fieldCount} image=${analysis.imageCount} prompt=${analysis.promptCount} required=${analysis.requiredCount}`
  );
  logger.debug(
    `[RunningHub] 字段摘要: ${fields
      .map((f) => `${f.nodeId}::${f.fieldName}(${f.role || f.fieldType || "?"}${f.required ? ",req" : ""})`)
      .join("; ")}`
  );

  return {
    kind,
    id: webappOrWorkflowId,
    title,
    fields,
    rhParams: buildDefaultRhParams(fields),
    analysis,
    analyzedAt: new Date().toISOString(),
  };
}

async function loadAssetBuffer(source: string): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  const value = source.trim();
  if (!value) throwRh("素材地址为空");

  if (value.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.+)$/i.exec(value);
    if (!match) throwRh("无效的 data URL");
    return {
      buffer: Buffer.from(match[2], "base64"),
      filename: "asset.bin",
      contentType: match[1] || "application/octet-stream",
    };
  }

  if (/^https?:\/\//i.test(value)) {
    const response = await axios.get(value, {
      responseType: "arraybuffer",
      timeout: 60000,
      validateStatus: () => true,
    });
    if (response.status >= 400) throwRh(`下载素材失败 HTTP ${response.status}`);
    const filename = value.split("/").pop()?.split("?")[0] || "asset.bin";
    return {
      buffer: Buffer.from(response.data),
      filename,
      contentType: String(response.headers["content-type"] || "application/octet-stream"),
    };
  }

  if (await fs.pathExists(value)) {
    const buffer = await fs.readFile(value);
    return {
      buffer,
      filename: path.basename(value) || "asset.bin",
      contentType: "application/octet-stream",
    };
  }

  throwRh(`不支持的素材地址：${value.slice(0, 80)}`);
}

async function uploadRhAsset(baseUrl: string, apiKey: string, source: string) {
  const asset = await loadAssetBuffer(source);
  const form = new FormData();
  form.append("apiKey", apiKey);
  form.append("fileType", "input");
  form.append("file", asset.buffer, {
    filename: asset.filename,
    contentType: asset.contentType,
  });
  const response = await axios.post(rhEndpoint(baseUrl, "/task/openapi/upload"), form, {
    headers: form.getHeaders(),
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });
  const raw = response.data;
  if (response.status >= 400 || (raw?.code !== 0 && raw?.code !== "0")) {
    logger.error(`[RunningHub] 上传失败 HTTP ${response.status} msg=${raw?.msg || "-"}`);
    throwRh(raw?.msg || "RunningHub 上传失败");
  }
  const fileName = raw?.data?.fileName;
  if (!fileName) throwRh("RunningHub 上传未返回 fileName");
  logger.info(`[RunningHub] 上传成功 fileName=${fileName} size=${asset.buffer.length}`);
  return String(fileName);
}

async function submitApp(
  baseUrl: string,
  apiKey: string,
  webappId: string,
  nodeInfoList: RunningHubNodeInfo[],
  instanceType = ""
) {
  const body: Record<string, unknown> = {
    apiKey,
    webappId,
    nodeInfoList,
  };
  if (instanceType.trim()) body.instanceType = instanceType.trim();
  const raw = await postRh(baseUrl, "/task/openapi/ai-app/run", body);
  if (raw?.code !== 0 && raw?.code !== "0") throwRh(raw?.msg || "RunningHub 提交失败");
  const taskId = raw?.data?.taskId;
  if (!taskId) throwRh("RunningHub 未返回 taskId");
  return String(taskId);
}

async function submitWorkflow(
  baseUrl: string,
  apiKey: string,
  workflowId: string,
  nodeInfoList: RunningHubNodeInfo[]
) {
  const body: Record<string, unknown> = {
    apiKey,
    workflowId,
    addMetadata: true,
  };
  if (nodeInfoList.length) body.nodeInfoList = nodeInfoList;
  const raw = await postRh(baseUrl, "/task/openapi/create", body);
  if (raw?.code !== 0 && raw?.code !== "0") throwRh(raw?.msg || "RunningHub 工作流提交失败");
  const taskId = raw?.data?.taskId;
  if (!taskId) throwRh("RunningHub 工作流未返回 taskId");
  return String(taskId);
}

function collectImageSources(options: GenerateRunningHubOptions) {
  const sources: string[] = [];
  if (options.filePath?.trim()) sources.push(options.filePath.trim());
  for (const item of options.images || []) {
    if (typeof item === "string" && item.trim()) sources.push(item.trim());
  }
  return _.uniq(sources);
}

/**
 * OpenAI /v1/images/generations|/edits 的 RunningHub 实现。
 * model 形如 app:{id} / workflow:{id}（可带 runninghub: 前缀）。
 * options.n > 1 时连续提交多次，合并 URL（单次失败则整请求失败）。
 */
export async function generateRunningHubImages(
  model: string,
  prompt: string,
  options: GenerateRunningHubOptions,
  apiKey: string
): Promise<string[]> {
  const parsed = parseRunningHubModel(model);
  if (!parsed) throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "无效的 RunningHub 模型名，请使用 app:{id} 或 workflow:{id}");
  if (!apiKey?.trim()) throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "RunningHub API Key 为空");
  if (!String(prompt || "").trim()) throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "prompt 不能为空");

  let n = Number(options.n);
  if (!Number.isFinite(n) || n < 1) n = 1;
  n = Math.min(4, Math.floor(n));

  const allUrls: string[] = [];
  for (let i = 0; i < n; i += 1) {
    if (n > 1) logger.info(`[RunningHub] 第 ${i + 1}/${n} 次生成`);
    const urls = await generateRunningHubImagesOnce(model, prompt, options, apiKey);
    allUrls.push(...urls);
    if (allUrls.length >= n) break;
  }
  return allUrls.slice(0, n);
}

async function generateRunningHubImagesOnce(
  model: string,
  prompt: string,
  options: GenerateRunningHubOptions,
  apiKey: string
): Promise<string[]> {
  const parsed = parseRunningHubModel(model)!;
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const key = apiKey.trim();
  const startedAt = Date.now();
  const rhParamCount = Object.keys(options.rhParams || {}).length;
  const rhRandomCount = Object.keys(options.rhRandom || {}).length;
  const imageSources = collectImageSources(options);

  logger.info(`[RunningHub] ══════ 生图开始 ══════`);
  logger.info(
    `[RunningHub] model=${parsed.kind}:${parsed.id} base=${baseUrl} key=${maskSecret(key)} instance=${options.instanceType || "-"}`
  );
  logger.info(
    `[RunningHub] prompt="${summarizeValue(prompt, 120)}" images=${imageSources.length} rh_params=${rhParamCount} rh_random=${rhRandomCount}`
  );
  if (rhParamCount) {
    logger.debug(`[RunningHub] rh_params=${JSON.stringify(options.rhParams)}`);
  }
  if (rhRandomCount) {
    logger.debug(`[RunningHub] rh_random=${JSON.stringify(options.rhRandom)}`);
  }

  try {
    logger.info(`[RunningHub] 加载字段 ${parsed.kind}:${parsed.id}`);
    const fields =
      parsed.kind === "app"
        ? await fetchAppFields(baseUrl, key, parsed.id)
        : await fetchWorkflowFields(baseUrl, key, parsed.id);
    logger.info(`[RunningHub] 字段数=${fields.length}`);

    const imageSlotCount = fields.filter((field) => rhFieldKind(field) === "image").length;
    const uploadLimit = imageSlotCount > 0 ? imageSlotCount : 0;
    if (imageSources.length > uploadLimit) {
      logger.warn(
        `[RunningHub] 参考图 ${imageSources.length} 张，图片字段 ${uploadLimit} 个，多余已忽略`
      );
    }
    const uploadedImages: string[] = [];
    for (const source of imageSources.slice(0, uploadLimit)) {
      logger.info(`[RunningHub] 上传素材 ${summarizeValue(source, 80)}`);
      uploadedImages.push(await uploadRhAsset(baseUrl, key, source));
    }

    const nodeInfoList = buildRunningHubNodeInfoList({
      fields,
      prompt,
      uploadedImages,
      rhParams: options.rhParams,
      rhRandom: options.rhRandom,
      rhEmptyImage: options.rhEmptyImage,
      openaiMapping: options.openaiMapping,
    });
    if (options.openaiMapping) {
      logger.info(
        `[RunningHub] openaiMapping prompt=${(options.openaiMapping.prompt || []).join(",") || "-"} images=${(options.openaiMapping.images || []).join(",") || "-"} size=${options.openaiMapping.size || "-"} quality=${options.openaiMapping.quality || "-"}`
      );
    }

    logger.info(`[RunningHub] 提交任务 fields=${fields.length} nodeInfo=${nodeInfoList.length}`);
    logger.info(`[RunningHub] nodeInfo: ${formatNodeInfoSummary(nodeInfoList) || "(空)"}`);
    logger.debug(`[RunningHub] nodeInfoList=${JSON.stringify(sanitizeRhBody({ nodeInfoList }).nodeInfoList)}`);

    const taskId =
      parsed.kind === "workflow"
        ? await submitWorkflow(baseUrl, key, parsed.id, nodeInfoList)
        : await submitApp(baseUrl, key, parsed.id, nodeInfoList, options.instanceType || "");
    logger.info(`[RunningHub] 已提交 taskId=${taskId}，开始轮询`);

    let lastStatus = "";
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      const raw = await postRh(baseUrl, "/task/openapi/outputs", { apiKey: key, taskId });
      const status = queryStatus(raw?.code);
      if (attempt === 0 || status !== lastStatus || attempt % 4 === 0) {
        logger.info(
          `[RunningHub] 轮询 #${attempt + 1} taskId=${taskId} status=${status} code=${raw?.code ?? "-"} msg=${raw?.msg || "-"} elapsed=${Date.now() - startedAt}ms`
        );
      }
      lastStatus = status;
      if (status === "SUCCESS") {
        const urls = extractOutputUrls(raw?.data);
        if (!urls.length) {
          logger.error(`[RunningHub] 成功但无输出 data=${summarizeValue(JSON.stringify(raw?.data), 300)}`);
          throwRh("RunningHub 任务成功但没有返回图片");
        }
        logger.info(
          `[RunningHub] 完成 urls=${urls.length} elapsed=${Date.now() - startedAt}ms first=${summarizeValue(urls[0], 100)}`
        );
        return urls;
      }
      if (status === "FAILED") {
        const detail = formatFailedReason(raw);
        const failMsg = detail
          ? `RunningHub 任务执行失败（${detail}）`
          : raw?.msg || raw?.data?.failedReason || "RunningHub 任务失败";
        logger.error(`[RunningHub] 任务失败 taskId=${taskId} msg=${raw?.msg || "-"} ${detail}`);
        logger.info(`[RunningHub] 失败响应全文: ${JSON.stringify(raw)}`);
        throwRh(failMsg);
      }
      if (attempt === MAX_POLLS - 1) {
        logger.error(`[RunningHub] 超时 taskId=${taskId} polls=${MAX_POLLS} elapsed=${Date.now() - startedAt}ms`);
        throwRh("RunningHub 任务超时，请稍后重试");
      }
      await delay(POLL_INTERVAL_MS);
    }

    throwRh("RunningHub 任务超时，请稍后重试");
  } catch (err: any) {
    if (!(err instanceof APIException)) {
      logger.error(`[RunningHub] 未捕获异常: ${err?.message || err}`);
    } else {
      logger.error(`[RunningHub] 生图失败 elapsed=${Date.now() - startedAt}ms: ${err.message}`);
    }
    throw err;
  }
}
