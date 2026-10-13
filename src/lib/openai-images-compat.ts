import _ from "lodash";
import logger from "@/lib/logger.ts";

export const OPENAI_IMAGE_MAX_N = 4;
/** quality 映射到 RunningHub App instanceType，而非节点字段 */
export const OPENAI_QUALITY_INSTANCE = "__instance_type__";

/** OpenAI 请求字段 → RH/Comfy 节点字段 key（nodeId::fieldName） */
export type RunningHubOpenAIMapping = {
  /** 接收 prompt 的节点字段（可多个） */
  prompt?: string[];
  /** 按顺序接收 image/images 的节点字段 */
  images?: string[];
  /** 按顺序接收 video/videos 的节点字段（Comfy VHS 等） */
  videos?: string[];
  /** 按顺序接收 audio/audios 的节点字段 */
  audios?: string[];
  /** 接收 size 的节点字段 */
  size?: string;
  /** 接收 quality：节点字段 key，或 OPENAI_QUALITY_INSTANCE */
  quality?: string;
};

export type OpenAIImageNormalized = {
  n: number;
  size: string;
  quality: string;
  responseFormat: "url" | "b64_json";
  ignoredKeys: string[];
};

export type RhSizeField = {
  nodeId: string;
  fieldName: string;
  label?: string;
  fieldType?: string;
  role?: string;
  options?: string[];
};

const KNOWN_OPENAI_KEYS = new Set([
  "model",
  "prompt",
  "n",
  "size",
  "quality",
  "response_format",
  "style",
  "user",
  "background",
  "input_fidelity",
  "output_format",
  "output_compression",
  "moderation",
  "partial_images",
  "stream",
  "image",
  "images",
  "video",
  "videos",
  "audio",
  "audios",
  "mask",
  // RH / 项目扩展（已知，不算「未知 OpenAI」）
  "negative_prompt",
  "ratio",
  "resolution",
  "sample_strength",
  "filePath",
  "filePaths",
  "file_paths",
  "base_url",
  "instance_type",
  "payment",
  "use_wallet",
  "rh_params",
  "rh_random",
  "rh_empty_image",
  "comfy_params",
  "duration",
  "seconds",
  "ratio",
  "resolution",
]);

function pushImageSource(out: string[], value: unknown) {
  if (typeof value === "string" && value.trim()) {
    out.push(value.trim());
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (typeof record.url === "string" && record.url.trim()) {
    out.push(record.url.trim());
    return;
  }
  if (typeof record.b64_json === "string" && record.b64_json.trim()) {
    const raw = record.b64_json.trim();
    out.push(raw.startsWith("data:") ? raw : `data:image/png;base64,${raw}`);
    return;
  }
  if (typeof record.data === "string" && record.data.trim()) {
    const raw = record.data.trim();
    out.push(raw.startsWith("data:") || /^https?:\/\//i.test(raw) ? raw : `data:image/png;base64,${raw}`);
  }
}

function collectFilePaths(files: unknown, keyPattern: RegExp): string[] {
  if (!files || typeof files !== "object") return [];
  const out: string[] = [];
  const pushFile = (file: any) => {
    if (!file) return;
    const path = file.filepath || file.path;
    if (typeof path === "string" && path.trim()) out.push(path.trim());
  };

  const record = files as Record<string, any>;
  for (const key of Object.keys(record)) {
    if (!keyPattern.test(key) && key !== "0") continue;
    const value = record[key];
    if (Array.isArray(value)) value.forEach(pushFile);
    else pushFile(value);
  }
  return out;
}

function collectFilePathsLegacy(files: unknown): string[] {
  return collectFilePaths(files, /^(image|images|mask|file|files)/i);
}

/** 从 OpenAI generations/edits 的 body + multipart 收集参考图来源 */
export function collectOpenAIInputImages(body: Record<string, any> = {}, files?: unknown): string[] {
  const images: string[] = [];
  const pushMany = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(pushMany);
      return;
    }
    pushImageSource(images, value);
  };
  pushMany(body.image);
  pushMany(body.images);
  pushMany(body.filePath);
  pushMany(body.filePaths);
  pushMany(body.file_paths);
  images.push(...collectFilePathsLegacy(files));
  return _.uniq(images);
}

/** 收集参考视频（body.video(s) + multipart video/videos） */
export function collectOpenAIInputVideos(body: Record<string, any> = {}, files?: unknown): string[] {
  const videos: string[] = [];
  pushImageSource(videos, body.video);
  if (Array.isArray(body.video)) body.video.forEach((item) => pushImageSource(videos, item));
  if (Array.isArray(body.videos)) body.videos.forEach((item) => pushImageSource(videos, item));
  videos.push(...collectFilePaths(files, /^(video|videos)/i));
  return _.uniq(videos);
}

/** 收集参考音频（body.audio(s) + multipart audio/audios） */
export function collectOpenAIInputAudios(body: Record<string, any> = {}, files?: unknown): string[] {
  const audios: string[] = [];
  pushImageSource(audios, body.audio);
  if (Array.isArray(body.audio)) body.audio.forEach((item) => pushImageSource(audios, item));
  if (Array.isArray(body.audios)) body.audios.forEach((item) => pushImageSource(audios, item));
  audios.push(...collectFilePaths(files, /^(audio|audios)/i));
  return _.uniq(audios);
}

export function normalizeOpenAIImageBody(body: Record<string, any> = {}): OpenAIImageNormalized {
  const ignoredKeys = Object.keys(body || {}).filter((key) => !KNOWN_OPENAI_KEYS.has(key));
  if (ignoredKeys.length) {
    logger.debug(`[OpenAIImages] 忽略未知字段: ${ignoredKeys.join(", ")}`);
  }

  let n = Number(body.n);
  if (!Number.isFinite(n) || n < 1) n = 1;
  n = Math.floor(n);
  if (n > OPENAI_IMAGE_MAX_N) {
    logger.warn(`[OpenAIImages] n=${n} 超过上限 ${OPENAI_IMAGE_MAX_N}，已截断`);
    n = OPENAI_IMAGE_MAX_N;
  }

  const size = typeof body.size === "string" ? body.size.trim() : "";
  const quality = typeof body.quality === "string" ? body.quality.trim().toLowerCase() : "";
  const responseFormat =
    String(body.response_format || "url").trim().toLowerCase() === "b64_json" ? "b64_json" : "url";

  return { n, size, quality, responseFormat, ignoredKeys };
}

function fieldKey(field: RhSizeField) {
  const nodeId = String(field.nodeId || "").trim();
  const fieldName = String(field.fieldName || "").trim();
  return nodeId && fieldName ? `${nodeId}::${fieldName}` : "";
}

function fieldLooksLikeSize(field: RhSizeField) {
  const name = String(field.fieldName || "").toLowerCase();
  const text = `${field.fieldName || ""} ${field.label || ""} ${field.role || ""}`.toLowerCase();
  // batch_size 含 size 字样，但不是画面尺寸
  if (/batch[_-]?size|steps|cfg|seed|denoise|strength/.test(name)) return false;
  return /(^|[^a-z])(size|aspect|ratio|width|height)([^a-z]|$)|分辨率|尺寸|比例|(^|[^a-z])(宽|高)([^a-z]|$)/.test(
    text
  );
}

function findFieldKeyByName(fields: RhSizeField[] | undefined, fieldName: string) {
  const target = fieldName.toLowerCase();
  const hit = (fields || []).find((field) => String(field.fieldName || "").toLowerCase() === target);
  return hit ? fieldKey(hit) : "";
}

function isWidthFieldName(name: string) {
  return /^(custom_)?width$|^w$/i.test(String(name || "").trim());
}

function isHeightFieldName(name: string) {
  return /^(custom_)?height$|^h$/i.test(String(name || "").trim());
}

/** 同节点上的成对宽/高字段（如 custom_width ↔ custom_height） */
function findSiblingDimensionKey(
  fields: RhSizeField[] | undefined,
  field: RhSizeField,
  want: "width" | "height"
) {
  const nodeId = String(field.nodeId || "");
  if (!nodeId) return "";
  const hit = (fields || []).find((item) => {
    if (String(item.nodeId || "") !== nodeId) return false;
    const name = String(item.fieldName || "");
    return want === "width" ? isWidthFieldName(name) : isHeightFieldName(name);
  });
  return hit ? fieldKey(hit) : "";
}

/** 按字段角色推断默认 OpenAI → 节点映射（可被管理台覆盖） */
export function inferOpenAIMapping(fields: RhSizeField[] | undefined): RunningHubOpenAIMapping {
  const list = Array.isArray(fields) ? fields : [];
  const prompt = list.filter((f) => f.role === "prompt").map(fieldKey).filter(Boolean);
  const images = list.filter((f) => f.role === "image").map(fieldKey).filter(Boolean);
  const videos = list.filter((f) => f.role === "video").map(fieldKey).filter(Boolean);
  const audios = list.filter((f) => f.role === "audio").map(fieldKey).filter(Boolean);
  const sizeField = list.find(
    (f) => fieldLooksLikeSize(f) && f.role !== "image" && f.role !== "prompt" && f.role !== "video" && f.role !== "audio"
  );
  return {
    prompt: prompt.length ? prompt : undefined,
    images: images.length ? images : undefined,
    videos: videos.length ? videos : undefined,
    audios: audios.length ? audios : undefined,
    size: sizeField ? fieldKey(sizeField) || undefined : undefined,
    quality: OPENAI_QUALITY_INSTANCE,
  };
}

export function slimOpenAIMapping(input: any): RunningHubOpenAIMapping | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: RunningHubOpenAIMapping = {};
  let touched = false;
  // 键存在且值不是 undefined 即视为用户已配置（含空串/空数组 = 显式不映射）
  if ("prompt" in input && input.prompt !== undefined) {
    touched = true;
    out.prompt = Array.isArray(input.prompt)
      ? input.prompt.map((item: unknown) => String(item || "").trim()).filter(Boolean)
      : [];
  }
  if ("images" in input && input.images !== undefined) {
    touched = true;
    out.images = Array.isArray(input.images)
      ? input.images.map((item: unknown) => String(item || "").trim()).filter(Boolean)
      : [];
  }
  if ("videos" in input && input.videos !== undefined) {
    touched = true;
    out.videos = Array.isArray(input.videos)
      ? input.videos.map((item: unknown) => String(item || "").trim()).filter(Boolean)
      : [];
  }
  if ("audios" in input && input.audios !== undefined) {
    touched = true;
    out.audios = Array.isArray(input.audios)
      ? input.audios.map((item: unknown) => String(item || "").trim()).filter(Boolean)
      : [];
  }
  if ("size" in input && input.size !== undefined) {
    touched = true;
    out.size = typeof input.size === "string" ? input.size.trim() : "";
  }
  if ("quality" in input && input.quality !== undefined) {
    touched = true;
    out.quality = typeof input.quality === "string" ? input.quality.trim() : "";
  }
  return touched ? out : undefined;
}

/** 用已保存映射覆盖推断结果；无效 key 剔除。已保存的空值 = 显式不映射，不回落推断。 */
export function resolveOpenAIMapping(
  fields: RhSizeField[] | undefined,
  saved?: RunningHubOpenAIMapping | null
): RunningHubOpenAIMapping {
  const inferred = inferOpenAIMapping(fields);
  const valid = new Set((fields || []).map(fieldKey).filter(Boolean));
  const filterKeys = (keys?: string[]) => (keys || []).filter((key) => valid.has(key));
  const hasSaved = saved != null && typeof saved === "object";

  const prompt = hasSaved && "prompt" in saved ? filterKeys(saved.prompt) : inferred.prompt;
  const images = hasSaved && "images" in saved ? filterKeys(saved.images) : inferred.images;
  const videos = hasSaved && "videos" in saved ? filterKeys(saved.videos) : inferred.videos;
  const audios = hasSaved && "audios" in saved ? filterKeys(saved.audios) : inferred.audios;

  let size = hasSaved && "size" in saved ? String(saved.size || "").trim() : inferred.size || "";
  if (size && !valid.has(size)) {
    size = hasSaved && "size" in saved ? "" : inferred.size || "";
  }

  let quality =
    hasSaved && "quality" in saved
      ? String(saved.quality || "").trim()
      : inferred.quality || OPENAI_QUALITY_INSTANCE;
  if (quality && quality !== OPENAI_QUALITY_INSTANCE && !valid.has(quality)) {
    quality = hasSaved && "quality" in saved ? "" : OPENAI_QUALITY_INSTANCE;
  }

  // 显式保存过的字段保留空串/空数组，方便 slim/再分析时不要丢「不映射」
  return {
    prompt: hasSaved && "prompt" in saved ? prompt || [] : prompt?.length ? prompt : undefined,
    images: hasSaved && "images" in saved ? images || [] : images?.length ? images : undefined,
    videos: hasSaved && "videos" in saved ? videos || [] : videos?.length ? videos : undefined,
    audios: hasSaved && "audios" in saved ? audios || [] : audios?.length ? audios : undefined,
    size: hasSaved && "size" in saved ? size : size || undefined,
    quality: hasSaved && "quality" in saved ? quality : quality || undefined,
  };
}

function pickSizeValue(field: RhSizeField, size: string) {
  if (!size) return "";
  const wh = size.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  const name = String(field.fieldName || "").toLowerCase();
  // INT 宽高字段：OpenAI 的 512x512 拆成单边数字
  if (wh && isWidthFieldName(name)) return wh[1];
  if (wh && isHeightFieldName(name)) return wh[2];

  const options = (field.options || []).map((item) => String(item));
  if (options.length) {
    const exact = options.find((item) => item === size || item.toLowerCase() === size.toLowerCase());
    if (exact) return exact;
    // 1024x1024 → 1:1 一类粗匹配
    const ratioHint =
      size === "1024x1024" || size === "512x512" || size === "256x256"
        ? "1:1"
        : size === "1536x1024" || size === "1792x1024"
          ? "3:2"
          : size === "1024x1536" || size === "1024x1792"
            ? "2:3"
            : "";
    if (ratioHint) {
      const hit = options.find((item) => item.includes(ratioHint) || item.replace(/\s/g, "") === ratioHint);
      if (hit) return hit;
    }
  }
  return size;
}

/**
 * 按 openaiMapping 把 OpenAI size/quality 落到 RH rhParams / instanceType。
 * quality=high 且映射到 instance_type、未显式传 instance 时倾向 plus。
 */
export function applyOpenAIParamsToRh(
  fields: RhSizeField[] | undefined,
  rhParams: Record<string, string> | undefined,
  options: {
    size?: string;
    quality?: string;
    instanceType?: string;
    requestHasInstanceType?: boolean;
    mapping?: RunningHubOpenAIMapping | null;
  }
) {
  const nextParams: Record<string, string> = { ...(rhParams || {}) };
  const mapping = resolveOpenAIMapping(fields, options.mapping);
  const size = String(options.size || "").trim();
  const fieldByKey = new Map((fields || []).map((field) => [fieldKey(field), field]));

  if (size) {
    const wh = size.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    const widthKey = findFieldKeyByName(fields, "width");
    const heightKey = findFieldKeyByName(fields, "height");
    const mappedSize = mapping.size && !/batch[_-]?size/i.test(mapping.size) ? mapping.size : "";

    if (wh && widthKey && heightKey) {
      nextParams[widthKey] = wh[1];
      nextParams[heightKey] = wh[2];
      // 避免错误的 size→batch_size 覆盖
      if (mapping.size && /batch[_-]?size/i.test(mapping.size)) delete nextParams[mapping.size];
      logger.info(`[OpenAIImages] size=${size} → ${widthKey}=${wh[1]}, ${heightKey}=${wh[2]}`);
    } else if (mappedSize && fieldByKey.has(mappedSize)) {
      const field = fieldByKey.get(mappedSize)!;
      // pickSizeValue 对 width/height/custom_* 会把 512x512 拆成单边 INT，其它字段逻辑不变
      nextParams[mappedSize] = pickSizeValue(field, size);
      // 兼容：映射到单边 INT 时，尽量补同节点另一边（不覆盖已有 rh_params）
      if (wh) {
        const name = String(field.fieldName || "");
        if (isHeightFieldName(name)) {
          const sibling = findSiblingDimensionKey(fields, field, "width");
          if (sibling && !Object.prototype.hasOwnProperty.call(nextParams, sibling)) nextParams[sibling] = wh[1];
        } else if (isWidthFieldName(name)) {
          const sibling = findSiblingDimensionKey(fields, field, "height");
          if (sibling && !Object.prototype.hasOwnProperty.call(nextParams, sibling)) nextParams[sibling] = wh[2];
        }
      }
      logger.info(`[OpenAIImages] size=${size} → ${mappedSize}=${nextParams[mappedSize]} (映射)`);
    } else {
      logger.warn(`[OpenAIImages] size=${size} 未配置有效映射字段，已忽略`);
    }
  }

  let instanceType = String(options.instanceType || "").trim();
  const quality = String(options.quality || "").trim().toLowerCase();
  if (quality) {
    if (mapping.quality === OPENAI_QUALITY_INSTANCE) {
      if (!options.requestHasInstanceType && quality === "high" && !instanceType) {
        instanceType = "plus";
        logger.info(`[OpenAIImages] quality=high → instanceType=plus (映射)`);
      }
    } else if (mapping.quality && fieldByKey.has(mapping.quality)) {
      nextParams[mapping.quality] = quality;
      logger.info(`[OpenAIImages] quality=${quality} → ${mapping.quality} (映射)`);
    } else {
      logger.warn(`[OpenAIImages] quality=${quality} 未配置有效映射，已忽略`);
    }
  }

  return { rhParams: nextParams, instanceType, mapping };
}
