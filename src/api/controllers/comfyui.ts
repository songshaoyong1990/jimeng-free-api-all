import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import axios from "axios";
import FormData from "form-data";
import WebSocket from "ws";
import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import {
  COMFYUI_DEFAULT_BASE_URL,
  fieldKey,
  isComfyUIModel,
  parseComfyUIModel,
  type ComfyUIEntry,
  type ComfyUIFieldSummary,
} from "@/lib/comfyui-config.ts";
import {
  resolveOpenAIMapping,
  type RunningHubOpenAIMapping,
} from "@/lib/openai-images-compat.ts";

export { isComfyUIModel, parseComfyUIModel };

const POLL_INTERVAL_MS = 2000;
const HISTORY_RETRY_MS = 500;
const HISTORY_RETRY_MAX = 20;
/** WebSocket / 同步等待上限（H3 视频可能很长） */
const WAIT_TIMEOUT_MS = 45 * 60 * 1000;

type ComfyJobRecord = {
  promptId: string;
  baseUrl: string;
  model: string;
  createdAt: number;
};

/** 异步视频任务：prompt_id → Comfy 基址（进程内） */
const comfyJobs = new Map<string, ComfyJobRecord>();

export type GenerateComfyUIOptions = {
  images?: string[];
  videos?: string[];
  audios?: string[];
  filePath?: string;
  baseUrl?: string;
  n?: number;
  /** 秒；写入「视频时长」类节点（如 H3 PrimitiveFloat 259） */
  duration?: number;
  /** 画幅 16:9 等；写入 ResolutionSelector.aspect_ratio */
  ratio?: string;
  /** 720p/1080p/4k；映射到 megapixels（粗略） */
  resolution?: string;
  /** OpenAI size，如 1024x1024；可辅助推断比例 */
  size?: string;
  comfyParams?: Record<string, string>;
  openaiMapping?: RunningHubOpenAIMapping;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveBaseUrl(baseUrl?: string) {
  const fromEnv = process.env.COMFYUI_BASE_URL?.trim();
  return String(baseUrl || fromEnv || COMFYUI_DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "") || COMFYUI_DEFAULT_BASE_URL;
}

function isLinkInput(value: unknown) {
  return Array.isArray(value) && value.length >= 2 && (typeof value[0] === "string" || typeof value[0] === "number");
}

function inferRole(classType: string, fieldName: string, value: unknown): string {
  const ct = classType.toLowerCase();
  const fn = fieldName.toLowerCase();
  if (
    ct.includes("loadaudio") ||
    fn === "audio" ||
    fn.startsWith("ref_audio") ||
    (fn.includes("audio") && typeof value === "string")
  ) {
    return "audio";
  }
  if (
    ct.includes("loadvideo") ||
    ct.includes("vhs_loadvideo") ||
    fn === "video" ||
    fn.startsWith("ref_video") ||
    (fn.includes("video") && typeof value === "string")
  ) {
    return "video";
  }
  if (
    ct.includes("loadimage") ||
    fn === "image" ||
    fn.startsWith("ref_image") ||
    (fn.includes("image") && typeof value === "string")
  ) {
    return "image";
  }
  if (
    ct === "text" ||
    ct.includes("cliptext") ||
    ct.includes("prompt") ||
    fn === "text" ||
    fn === "prompt" ||
    fn === "positive"
  ) {
    return "prompt";
  }
  if (fn.includes("seed") || fn === "noise_seed") return "seed";
  if (fn === "steps" || fn.includes("step")) return "steps";
  if (fn === "width" || fn === "height" || fn === "size" || fn.includes("aspect")) return "size";
  return "param";
}

function coerceFieldValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mediaFieldForLinkedNode(workflowApi: Record<string, any>, linkedNodeId: string, prefer: "image" | "video" | "audio") {
  const node = workflowApi[linkedNodeId];
  if (!node?.inputs || typeof node.inputs !== "object") {
    return prefer === "video" ? "video" : prefer === "audio" ? "audio" : "image";
  }
  const inputs = node.inputs as Record<string, unknown>;
  if (prefer === "video" && "video" in inputs) return "video";
  if (prefer === "audio" && "audio" in inputs) return "audio";
  if ("image" in inputs) return "image";
  if ("video" in inputs) return "video";
  if ("audio" in inputs) return "audio";
  return prefer === "video" ? "video" : prefer === "audio" ? "audio" : "image";
}

/**
 * MiniMax H3 Ref2VA：按 ref_image_0..N / ref_video_* / ref_audio_* 连接顺序建立 OpenAI 映射，
 * 保证 images[0] 对应 <Picture 1> 而非 JSON 节点 id 乱序。
 */
function extractMiniMaxH3Mapping(workflowApi: Record<string, any>): RunningHubOpenAIMapping | null {
  let best: RunningHubOpenAIMapping | null = null;
  let bestScore = 0;
  for (const [, node] of Object.entries(workflowApi)) {
    if (!node || typeof node !== "object") continue;
    const classType = String((node as any).class_type || "");
    const inputs = (node as any).inputs;
    if (!inputs || typeof inputs !== "object") continue;
    const ct = classType.toLowerCase();
    const looksH3 =
      (ct.includes("minimax") && (ct.includes("reference") || ct.includes("ref2"))) ||
      Object.keys(inputs).some((k) => /^ref_images\.ref_image_\d+$/i.test(k));
    if (!looksH3) continue;

    const images: string[] = [];
    const videos: string[] = [];
    const audios: string[] = [];
    for (let i = 0; i < 32; i++) {
      const link =
        inputs[`ref_images.ref_image_${i}`] ?? inputs[`ref_image_${i}`] ?? inputs[`ref_images_${i}`];
      if (!isLinkInput(link)) continue;
      const srcId = String(link[0]);
      images.push(fieldKey(srcId, mediaFieldForLinkedNode(workflowApi, srcId, "image")));
    }
    for (let i = 0; i < 16; i++) {
      const link =
        inputs[`ref_videos.ref_video_${i}`] ?? inputs[`ref_video_${i}`] ?? inputs[`ref_videos_${i}`];
      if (!isLinkInput(link)) continue;
      const srcId = String(link[0]);
      videos.push(fieldKey(srcId, mediaFieldForLinkedNode(workflowApi, srcId, "video")));
    }
    for (let i = 0; i < 16; i++) {
      const link =
        inputs[`ref_audios.ref_audio_${i}`] ?? inputs[`ref_audio_${i}`] ?? inputs[`ref_audios_${i}`];
      if (!isLinkInput(link)) continue;
      const srcId = String(link[0]);
      audios.push(fieldKey(srcId, mediaFieldForLinkedNode(workflowApi, srcId, "audio")));
    }

    const prompt: string[] = [];
    const promptLink = inputs.prompt;
    if (isLinkInput(promptLink)) {
      const srcId = String(promptLink[0]);
      const srcNode = workflowApi[srcId];
      const srcInputs = srcNode?.inputs || {};
      if ("text" in srcInputs) prompt.push(fieldKey(srcId, "text"));
      else if ("prompt" in srcInputs) prompt.push(fieldKey(srcId, "prompt"));
      else if ("string" in srcInputs) prompt.push(fieldKey(srcId, "string"));
    }

    const score = images.length * 3 + videos.length * 2 + audios.length * 2 + prompt.length;
    if (score > bestScore) {
      bestScore = score;
      best = {
        prompt: prompt.length ? prompt : undefined,
        images: images.length ? images : undefined,
        videos: videos.length ? videos : undefined,
        audios: audios.length ? audios : undefined,
      };
    }
  }
  return bestScore > 0 ? best : null;
}

/** 从 ComfyUI API JSON 抽出可编辑字段 */
export function analyzeComfyUIWorkflowApi(
  workflowApi: Record<string, any>,
  opts?: { title?: string; id?: string }
): ComfyUIEntry {
  if (!workflowApi || typeof workflowApi !== "object") {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "无效的 ComfyUI API JSON");
  }

  const fields: ComfyUIFieldSummary[] = [];
  for (const [nodeId, node] of Object.entries(workflowApi)) {
    if (!node || typeof node !== "object") continue;
    const classType = String((node as any).class_type || "");
    const title = String((node as any)?._meta?.title || classType || nodeId);
    const inputs = (node as any).inputs;
    if (!inputs || typeof inputs !== "object") continue;

    for (const [fieldName, value] of Object.entries(inputs)) {
      if (isLinkInput(value)) continue;
      const role = inferRole(classType, fieldName, value);
      // 跳过巨大二进制感字段（H3 长提示词允许到约 4万字符）
      if (typeof value === "string" && value.length > 200000) continue;
      fields.push({
        nodeId,
        fieldName,
        fieldType: typeof value,
        label: `${title}.${fieldName}`,
        fieldValue: coerceFieldValue(value).slice(0, 4000),
        role,
        classType,
      });
    }
  }

  const promptFields = fields.filter((f) => f.role === "prompt");
  const imageFields = fields.filter((f) => f.role === "image");
  const videoFields = fields.filter((f) => f.role === "video");
  const audioFields = fields.filter((f) => f.role === "audio");
  const fieldViews = fields.map((f) => ({
    nodeId: f.nodeId,
    fieldName: f.fieldName,
    label: f.label,
    fieldType: f.fieldType,
    role: f.role,
  }));

  // H3：优先用 ref_* 连接顺序；否则按字段角色推断
  const h3Mapping = extractMiniMaxH3Mapping(workflowApi);
  const mapping = resolveOpenAIMapping(fieldViews, h3Mapping);

  // 默认 params：跳过 prompt/image/video/audio（由请求填充；未传则保留 workflow 内原值）
  const comfyParams: Record<string, string> = {};
  for (const field of fields) {
    if (field.role === "prompt" || field.role === "image" || field.role === "video" || field.role === "audio") {
      continue;
    }
    if (field.fieldValue != null && field.fieldValue !== "" && field.fieldValue !== "None") {
      comfyParams[fieldKey(field.nodeId, field.fieldName)] = field.fieldValue;
    }
  }

  const id =
    String(opts?.id || "").trim() ||
    `wf_${crypto.createHash("md5").update(JSON.stringify(Object.keys(workflowApi).sort())).digest("hex").slice(0, 10)}`;

  const title =
    String(opts?.title || "").trim() ||
    (h3Mapping
      ? `MiniMax H3 多参考（图${mapping.images?.length || 0}/视${mapping.videos?.length || 0}/音${mapping.audios?.length || 0}）`
      : `ComfyUI 工作流（${Object.keys(workflowApi).length} 节点）`);

  return {
    id,
    title,
    enabled: true,
    workflowApi,
    fields,
    comfyParams,
    openaiMapping: mapping,
    analysis: {
      fieldCount: fields.length,
      imageCount: mapping.images?.length || imageFields.length,
      promptCount: mapping.prompt?.length || promptFields.length,
      videoCount: mapping.videos?.length || videoFields.length,
      audioCount: mapping.audios?.length || audioFields.length,
      nodeCount: Object.keys(workflowApi).length,
      requiredCount: 0,
    },
    analyzedAt: new Date().toISOString(),
  };
}

function applyValueType(prev: unknown, next: string): unknown {
  if (typeof prev === "number") {
    const n = Number(next);
    return Number.isFinite(n) ? n : prev;
  }
  if (typeof prev === "boolean") {
    return next === "true" || next === "1";
  }
  return next;
}

export function applyParamsToWorkflow(
  workflowApi: Record<string, any>,
  params?: Record<string, string>
) {
  const clone = _.cloneDeep(workflowApi);
  if (!params) return clone;
  for (const [key, value] of Object.entries(params)) {
    const sep = key.indexOf("::");
    if (sep <= 0) continue;
    const nodeId = key.slice(0, sep);
    const fieldName = key.slice(sep + 2);
    if (!clone[nodeId]?.inputs || !(fieldName in clone[nodeId].inputs)) continue;
    clone[nodeId].inputs[fieldName] = applyValueType(clone[nodeId].inputs[fieldName], value);
  }
  return clone;
}

async function readMediaBuffer(
  source: string,
  fallbackExt = ".png"
): Promise<{ buffer: Buffer; filename: string }> {
  if (/^https?:\/\//i.test(source)) {
    const res = await axios.get(source, { responseType: "arraybuffer", timeout: 120000 });
    const ext = path.extname(new URL(source).pathname) || fallbackExt;
    return { buffer: Buffer.from(res.data), filename: `upload${ext}` };
  }
  if (source.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.+)$/i.exec(source);
    if (!match) throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "无效的 data URL 媒体");
    const mime = match[1].toLowerCase();
    let ext = fallbackExt;
    if (mime.includes("jpeg") || mime.includes("jpg")) ext = ".jpg";
    else if (mime.includes("webp")) ext = ".webp";
    else if (mime.includes("png")) ext = ".png";
    else if (mime.includes("mp4")) ext = ".mp4";
    else if (mime.includes("webm")) ext = ".webm";
    else if (mime.includes("wav")) ext = ".wav";
    else if (mime.includes("mpeg") || mime.includes("mp3")) ext = ".mp3";
    else if (mime.includes("audio")) ext = ".wav";
    else if (mime.includes("video")) ext = ".mp4";
    return { buffer: Buffer.from(match[2], "base64"), filename: `upload${ext}` };
  }
  const buffer = await fs.readFile(source);
  return { buffer, filename: path.basename(source) || `upload${fallbackExt}` };
}

/** ComfyUI 统一上传到 input；图片/视频/音频均走 /upload/image */
async function uploadMediaToComfy(
  baseUrl: string,
  source: string,
  fallbackExt = ".png"
): Promise<string> {
  const { buffer, filename } = await readMediaBuffer(source, fallbackExt);
  const form = new FormData();
  form.append("image", buffer, { filename });
  form.append("overwrite", "true");
  const res = await axios.post(`${baseUrl}/upload/image`, form, {
    headers: form.getHeaders(),
    timeout: 180000,
    maxBodyLength: Infinity,
  });
  const name = res.data?.name || res.data?.filename;
  if (!name) {
    throw new APIException(EX.API_REQUEST_FAILED, `ComfyUI 上传失败: ${JSON.stringify(res.data)}`);
  }
  const subfolder = res.data?.subfolder ? String(res.data.subfolder).replace(/\/+$/, "") : "";
  return subfolder ? `${subfolder}/${name}` : String(name);
}

async function bindMediaToSlots(
  baseUrl: string,
  params: Record<string, string>,
  sources: string[],
  keys: string[],
  kind: "image" | "video" | "audio"
) {
  if (!sources.length || !keys.length) {
    if (sources.length && !keys.length) {
      logger.warn(`[ComfyUI] 收到 ${sources.length} 个${kind}，但工作流未映射 ${kind}s 槽位，已忽略`);
    }
    return;
  }
  if (sources.length > keys.length) {
    logger.warn(`[ComfyUI] ${kind} ${sources.length} 个，可写入槽位仅 ${keys.length}，多余将忽略`);
  }
  const ext = kind === "video" ? ".mp4" : kind === "audio" ? ".wav" : ".png";
  for (let i = 0; i < Math.min(sources.length, keys.length); i++) {
    const uploaded = await uploadMediaToComfy(baseUrl, sources[i], ext);
    params[keys[i]] = uploaded;
    logger.info(`[ComfyUI] 已上传${kind} ${i + 1} → ${keys[i]} = ${uploaded}`);
  }
}

const H3_RATIO_TO_ASPECT: Record<string, string> = {
  "16:9": "16:9 (Widescreen)",
  "9:16": "9:16 (Portrait)",
  "1:1": "1:1 (Square)",
  "4:3": "4:3 (Standard)",
  "3:4": "3:4 (Portrait)",
  "21:9": "21:9 (Ultrawide)",
};

function ratioFromOpenAISize(size: string) {
  const m = String(size || "").match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!m) return "";
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return "";
  if (w === h) return "1:1";
  if (Math.abs(w / h - 16 / 9) < 0.08) return "16:9";
  if (Math.abs(w / h - 9 / 16) < 0.08) return "9:16";
  if (Math.abs(w / h - 4 / 3) < 0.08) return "4:3";
  if (Math.abs(w / h - 3 / 4) < 0.08) return "3:4";
  if (Math.abs(w / h - 21 / 9) < 0.12) return "21:9";
  return "";
}

function megapixelsFromResolution(resolution: string) {
  const r = String(resolution || "").trim().toLowerCase();
  if (r === "4k" || r === "2160p") return "2";
  if (r === "1080p" || r === "1k") return "1";
  if (r === "720p") return "0.4";
  if (r === "480p") return "0.25";
  return "";
}

function findComfyFieldKey(
  fields: ComfyUIFieldSummary[] | undefined,
  pred: (f: ComfyUIFieldSummary) => boolean
) {
  const hit = (fields || []).find(pred);
  return hit ? fieldKey(hit.nodeId, hit.fieldName) : "";
}

/**
 * 把 duration / ratio / resolution / size 落到 H3 常见节点：
 * - PrimitiveFloat「视频时长（秒）」.value
 * - ResolutionSelector.aspect_ratio / megapixels
 */
function applyVideoGeometryParams(
  params: Record<string, string>,
  fields: ComfyUIFieldSummary[] | undefined,
  options: Pick<GenerateComfyUIOptions, "duration" | "ratio" | "resolution" | "size">
) {
  const durationRaw = options.duration;
  if (durationRaw != null && Number.isFinite(Number(durationRaw)) && Number(durationRaw) > 0) {
    const durationKey =
      findComfyFieldKey(
        fields,
        (f) =>
          /时长|duration|seconds?/i.test(`${f.label || ""} ${f.fieldName || ""}`) &&
          (f.fieldName === "value" || f.role === "param" || f.role === "number")
      ) ||
      findComfyFieldKey(
        fields,
        (f) =>
          /primitivefloat/i.test(f.classType || "") &&
          f.fieldName === "value" &&
          /时长|秒|video.*dur/i.test(f.label || "")
      );
    if (durationKey) {
      params[durationKey] = String(Number(durationRaw));
      logger.info(`[ComfyUI] duration=${durationRaw}s → ${durationKey}`);
    } else {
      logger.warn(`[ComfyUI] 收到 duration=${durationRaw} 但未找到「视频时长」节点字段`);
    }
  }

  let ratio = String(options.ratio || "").trim();
  if (!ratio && options.size) ratio = ratioFromOpenAISize(options.size);
  if (ratio) {
    const aspectKey = findComfyFieldKey(
      fields,
      (f) =>
        f.fieldName === "aspect_ratio" ||
        (/ResolutionSelector/i.test(f.classType || "") && /aspect|ratio/i.test(f.fieldName || "")) ||
        /aspect[_ ]?ratio|画幅|比例/i.test(`${f.label || ""} ${f.fieldName || ""}`)
    );
    if (aspectKey) {
      const mapped = H3_RATIO_TO_ASPECT[ratio] || ratio;
      params[aspectKey] = mapped;
      logger.info(`[ComfyUI] ratio=${ratio} → ${aspectKey}=${mapped}`);
    } else {
      logger.warn(`[ComfyUI] 收到 ratio=${ratio} 但未找到 ResolutionSelector.aspect_ratio`);
    }
  }

  const mp = megapixelsFromResolution(options.resolution || "");
  if (mp) {
    const mpKey = findComfyFieldKey(
      fields,
      (f) =>
        f.fieldName === "megapixels" ||
        (/megapixel/i.test(f.fieldName || "") && /ResolutionSelector/i.test(f.classType || ""))
    );
    if (mpKey) {
      params[mpKey] = mp;
      logger.info(`[ComfyUI] resolution=${options.resolution} → ${mpKey}=${mp}`);
    }
  }
}

function collectHistoryMedia(baseUrl: string, historyItem: any): string[] {
  const urls: string[] = [];
  const outputs = historyItem?.outputs || {};
  for (const nodeOut of Object.values(outputs) as any[]) {
    if (!nodeOut || typeof nodeOut !== "object") continue;
    for (const key of ["videos", "gifs", "images", "audio"]) {
      const list = nodeOut[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item?.filename) continue;
        const params = new URLSearchParams({
          filename: String(item.filename),
          subfolder: String(item.subfolder || ""),
          type: String(item.type || "output"),
        });
        urls.push(`${baseUrl}/view?${params.toString()}`);
      }
    }
  }
  return urls;
}

function toComfyWsUrl(baseUrl: string, clientId: string) {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = `clientId=${encodeURIComponent(clientId)}`;
  return u.toString();
}

/**
 * 官方推荐：先连 /ws?clientId=…，再 POST /prompt（同一 client_id），
 * 等 executing(node=null) 或 execution_success，再拉 /history。
 */
function openComfyWebSocket(baseUrl: string, clientId: string): Promise<WebSocket> {
  const wsUrl = toComfyWsUrl(baseUrl, clientId);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error(`ComfyUI WebSocket 连接超时: ${wsUrl}`));
    }, 15000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitPromptDoneOnWs(
  ws: WebSocket,
  promptId: string,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new APIException(EX.API_REQUEST_FAILED, `ComfyUI 任务超时（>${Math.round(timeoutMs / 60000)} 分钟）`));
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return; // preview frames
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const type = msg?.type;
      const d = msg?.data || {};
      if (d.prompt_id && d.prompt_id !== promptId) return;

      if (type === "execution_error" && d.prompt_id === promptId) {
        cleanup();
        reject(
          new APIException(
            EX.API_REQUEST_FAILED,
            `ComfyUI 执行失败: ${JSON.stringify(d).slice(0, 500)}`
          )
        );
        return;
      }
      // 完成信号：executing + node=null，或 execution_success
      if (type === "execution_success" && d.prompt_id === promptId) {
        cleanup();
        resolve();
        return;
      }
      if (type === "executing" && d.prompt_id === promptId && (d.node === null || d.node === undefined)) {
        cleanup();
        resolve();
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("ComfyUI WebSocket 在任务完成前关闭"));
    };

    function cleanup() {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }

    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

async function fetchHistoryItem(baseUrl: string, promptId: string) {
  const res = await axios.get(`${baseUrl}/history/${promptId}`, { timeout: 30000 });
  return res.data?.[promptId] || null;
}

/** execution_success 后 history 可能尚未落盘，短重试 */
async function collectMediaAfterDone(baseUrl: string, promptId: string): Promise<string[]> {
  for (let i = 0; i < HISTORY_RETRY_MAX; i++) {
    const item = await fetchHistoryItem(baseUrl, promptId);
    if (item) {
      if (item.status?.status_str === "error") {
        const messages = item.status?.messages || [];
        throw new APIException(
          EX.API_REQUEST_FAILED,
          `ComfyUI 执行失败: ${JSON.stringify(messages).slice(0, 500)}`
        );
      }
      const urls = collectHistoryMedia(baseUrl, item);
      if (urls.length) return urls;
      if (item.status?.completed === true || item.status?.status_str === "success") {
        // 已完成但 outputs 空：再等几拍
        if (i >= HISTORY_RETRY_MAX - 1) {
          throw new APIException(EX.API_REQUEST_FAILED, "ComfyUI 任务完成但未找到输出文件");
        }
      }
    }
    await delay(HISTORY_RETRY_MS);
  }
  throw new APIException(EX.API_REQUEST_FAILED, "ComfyUI 任务完成但未找到输出文件");
}

/** 仅作 WS 失败时的兜底 */
async function pollHistoryFallback(baseUrl: string, promptId: string): Promise<string[]> {
  const maxPolls = Math.ceil(WAIT_TIMEOUT_MS / POLL_INTERVAL_MS);
  for (let i = 0; i < maxPolls; i++) {
    const item = await fetchHistoryItem(baseUrl, promptId);
    if (item) {
      if (item.status?.status_str === "error") {
        const messages = item.status?.messages || [];
        throw new APIException(
          EX.API_REQUEST_FAILED,
          `ComfyUI 执行失败: ${JSON.stringify(messages).slice(0, 500)}`
        );
      }
      const urls = collectHistoryMedia(baseUrl, item);
      if (urls.length || item.status?.completed === true || item.status?.status_str === "success") {
        if (!urls.length) {
          throw new APIException(EX.API_REQUEST_FAILED, "ComfyUI 任务完成但未找到输出文件");
        }
        return urls;
      }
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new APIException(EX.API_REQUEST_FAILED, "ComfyUI 任务超时");
}

async function waitAndCollectOutputs(
  baseUrl: string,
  clientId: string,
  promptId: string,
  ws: WebSocket | null
): Promise<string[]> {
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.info(`[ComfyUI] WebSocket 等待完成 prompt_id=${promptId}`);
    await waitPromptDoneOnWs(ws, promptId);
    return collectMediaAfterDone(baseUrl, promptId);
  }
  logger.warn(`[ComfyUI] WebSocket 不可用，回退 HTTP 轮询 history prompt_id=${promptId}`);
  return pollHistoryFallback(baseUrl, promptId);
}

async function postComfyPrompt(
  baseUrl: string,
  workflow: Record<string, any>,
  clientId: string
): Promise<string> {
  const res = await axios.post(
    `${baseUrl}/prompt`,
    { prompt: workflow, client_id: clientId },
    { timeout: 60000 }
  );
  const promptId = String(res.data?.prompt_id || "");
  if (!promptId) {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      `ComfyUI /prompt 未返回 prompt_id: ${JSON.stringify(res.data).slice(0, 300)}`
    );
  }
  if (res.data?.node_errors && Object.keys(res.data.node_errors).length) {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      `ComfyUI 节点错误: ${JSON.stringify(res.data.node_errors).slice(0, 500)}`
    );
  }
  return promptId;
}

function rememberComfyJob(promptId: string, baseUrl: string, model: string) {
  comfyJobs.set(promptId, { promptId, baseUrl, model, createdAt: Date.now() });
  // 简单清理：超过 2 小时的任务
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of comfyJobs) {
    if (job.createdAt < cutoff) comfyJobs.delete(id);
  }
}

export function encodeComfyJobId(promptId: string) {
  return `comfy-${promptId}`;
}

export function parseComfyJobId(id: string): string | null {
  const s = String(id || "").trim();
  if (s.startsWith("comfy-")) {
    const rest = s.slice("comfy-".length);
    return rest || null;
  }
  // 兼容：进程内已知的裸 prompt_id
  if (comfyJobs.has(s)) return s;
  return null;
}

export function isComfyPromptJobId(id: string) {
  return !!parseComfyJobId(id);
}

export async function queryComfyUIJob(
  jobId: string,
  baseUrlHint?: string
): Promise<{ status: "in_progress" | "completed" | "failed"; url?: string; urls?: string[]; message?: string; model?: string }> {
  const promptId = parseComfyJobId(jobId);
  if (!promptId) {
    return { status: "failed", message: "无效的 ComfyUI 任务 id" };
  }
  const job = comfyJobs.get(promptId);
  const baseUrl = resolveBaseUrl(baseUrlHint || job?.baseUrl);
  try {
    const item = await fetchHistoryItem(baseUrl, promptId);
    if (!item) {
      // 可能还在队列
      const q = await axios.get(`${baseUrl}/queue`, { timeout: 10000 });
      const running = (q.data?.queue_running || []).some((row: any[]) => row?.[1] === promptId);
      const pending = (q.data?.queue_pending || []).some((row: any[]) => row?.[1] === promptId);
      if (running || pending) return { status: "in_progress", model: job?.model };
      return { status: "in_progress", model: job?.model };
    }
    if (item.status?.status_str === "error") {
      return {
        status: "failed",
        message: JSON.stringify(item.status?.messages || []).slice(0, 500),
        model: job?.model,
      };
    }
    const urls = collectHistoryMedia(baseUrl, item);
    if (urls.length) {
      return { status: "completed", url: urls[0], urls, model: job?.model };
    }
    if (item.status?.completed === true || item.status?.status_str === "success") {
      return { status: "failed", message: "任务完成但未找到输出文件", model: job?.model };
    }
    return { status: "in_progress", model: job?.model };
  } catch (e: any) {
    return { status: "failed", message: e?.message || String(e), model: job?.model };
  }
}

/**
 * 准备可提交的 workflow（上传媒体、写 prompt/几何参数）。
 */
async function prepareComfyWorkflow(
  model: string,
  prompt: string,
  options: GenerateComfyUIOptions,
  entry: ComfyUIEntry
): Promise<{ baseUrl: string; workflow: Record<string, any>; params: Record<string, string> }> {
  const parsed = parseComfyUIModel(model);
  if (!parsed) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "无效的 ComfyUI 模型，请使用 comfy:{id}");
  }
  if (!entry.workflowApi) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, `工作流 ${parsed.id} 缺少 workflowApi，请重新导入分析`);
  }

  const baseUrl = resolveBaseUrl(options.baseUrl);
  const mapping = resolveOpenAIMapping(entry.fields as any, options.openaiMapping || entry.openaiMapping);
  const params: Record<string, string> = { ...(entry.comfyParams || {}), ...(options.comfyParams || {}) };

  const promptKeys = mapping.prompt?.length
    ? mapping.prompt
    : (entry.fields || [])
        .filter((f) => f.role === "prompt")
        .map((f) => fieldKey(f.nodeId, f.fieldName));
  if (String(prompt || "").trim()) {
    for (const key of promptKeys) {
      params[key] = prompt;
    }
  }

  const imageSources = [
    ...(options.filePath ? [options.filePath] : []),
    ...(options.images || []),
  ].filter(Boolean);
  const imageKeys = mapping.images?.length
    ? mapping.images
    : (entry.fields || [])
        .filter((f) => f.role === "image")
        .map((f) => fieldKey(f.nodeId, f.fieldName));
  const videoKeys = mapping.videos?.length
    ? mapping.videos
    : (entry.fields || [])
        .filter((f) => f.role === "video")
        .map((f) => fieldKey(f.nodeId, f.fieldName));
  const audioKeys = mapping.audios?.length
    ? mapping.audios
    : (entry.fields || [])
        .filter((f) => f.role === "audio")
        .map((f) => fieldKey(f.nodeId, f.fieldName));

  await bindMediaToSlots(baseUrl, params, imageSources, imageKeys, "image");
  await bindMediaToSlots(baseUrl, params, options.videos || [], videoKeys, "video");
  await bindMediaToSlots(baseUrl, params, options.audios || [], audioKeys, "audio");
  applyVideoGeometryParams(params, entry.fields, options);

  const workflow = applyParamsToWorkflow(entry.workflowApi, params);
  logger.info(
    `[ComfyUI] 工作流已准备 model=${model} base=${baseUrl} images=${imageSources.length}/${imageKeys.length} videos=${(options.videos || []).length}/${videoKeys.length} audios=${(options.audios || []).length}/${audioKeys.length}`
  );
  return { baseUrl, workflow, params };
}

/**
 * 异步提交（视频推荐）：只 POST /prompt，立刻返回 prompt_id，不阻塞 HTTP。
 * 客户端用 GET /v1/videos/{prompt_id} 查结果。
 */
export async function submitComfyUIJob(
  model: string,
  prompt: string,
  options: GenerateComfyUIOptions,
  entry: ComfyUIEntry
): Promise<{ promptId: string; baseUrl: string }> {
  const { baseUrl, workflow } = await prepareComfyWorkflow(model, prompt, options, entry);
  const clientId = crypto.randomUUID();
  // 异步路径仍先开 WS 再提交，保证队列事件可关联；提交后立刻断开，不等待
  let ws: WebSocket | null = null;
  try {
    ws = await openComfyWebSocket(baseUrl, clientId);
  } catch (e: any) {
    logger.warn(`[ComfyUI] 异步提交前 WS 连接失败（仍继续 /prompt）: ${e?.message || e}`);
  }
  try {
    const promptId = await postComfyPrompt(baseUrl, workflow, clientId);
    rememberComfyJob(promptId, baseUrl, model);
    logger.info(`[ComfyUI] 异步已入队 prompt_id=${promptId} model=${model}`);
    return { promptId, baseUrl };
  } catch (e: any) {
    if (e instanceof APIException) throw e;
    const msg = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 400) : e?.message || e;
    throw new APIException(EX.API_REQUEST_FAILED, `无法连接 ComfyUI（${baseUrl}）: ${msg}`);
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 同步生成：官方顺序 — 先 WS → POST /prompt → 等完成 → /history。
 * 适合出图；长视频请用 submitComfyUIJob + 轮询，避免上游 HTTP 超时。
 */
export async function generateComfyUIImages(
  model: string,
  prompt: string,
  options: GenerateComfyUIOptions,
  entry: ComfyUIEntry
): Promise<string[]> {
  const prepared = await prepareComfyWorkflow(model, prompt, options, entry);
  const { baseUrl, params } = prepared;
  const n = Math.max(1, Math.min(Number(options.n) || 1, 4));
  const allUrls: string[] = [];

  for (let run = 0; run < n; run++) {
    let promptWorkflow = prepared.workflow;
    if (run > 0) {
      const runParams = { ...params };
      for (const field of entry.fields || []) {
        if (field.role !== "seed") continue;
        runParams[fieldKey(field.nodeId, field.fieldName)] = String(Math.floor(Math.random() * 1e15));
      }
      promptWorkflow = applyParamsToWorkflow(entry.workflowApi!, runParams);
    }

    const clientId = crypto.randomUUID();
    let ws: WebSocket | null = null;
    try {
      ws = await openComfyWebSocket(baseUrl, clientId);
    } catch (e: any) {
      logger.warn(`[ComfyUI] WebSocket 连接失败，将回退轮询: ${e?.message || e}`);
      ws = null;
    }

    logger.info(`[ComfyUI] 提交 prompt model=${model} run=${run + 1}/${n} base=${baseUrl} (ws=${!!ws})`);
    let promptId = "";
    try {
      promptId = await postComfyPrompt(baseUrl, promptWorkflow, clientId);
      rememberComfyJob(promptId, baseUrl, model);
    } catch (e: any) {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      if (e instanceof APIException) throw e;
      const msg = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 400) : e?.message || e;
      throw new APIException(EX.API_REQUEST_FAILED, `无法连接 ComfyUI（${baseUrl}）: ${msg}`);
    }

    const urls = await waitAndCollectOutputs(baseUrl, clientId, promptId, ws);
    allUrls.push(...urls);
  }

  return allUrls;
}

export async function pingComfyUI(baseUrl?: string) {
  const url = resolveBaseUrl(baseUrl);
  const res = await axios.get(`${url}/system_stats`, { timeout: 5000 });
  return { ok: true, baseUrl: url, data: res.data };
}
