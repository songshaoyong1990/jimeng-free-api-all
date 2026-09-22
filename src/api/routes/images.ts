import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import { DEFAULT_MODEL, generateImagesWithRetry } from "@/api/controllers/images.ts";
import { generateRunningHubImages, isRunningHubModel } from "@/api/controllers/runninghub.ts";
import { generateComfyUIImages, isComfyUIModel } from "@/api/controllers/comfyui.ts";
import { tokenSplit } from "@/api/controllers/core.ts";
import util from "@/lib/util.ts";
import db from "@/lib/database.ts";
import { decodeDuckImage, imageMimeForExt } from "@/lib/duck-decode.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { isRunningHubModelEnabled, isWalletPayment, resolveRunningHubEntry } from "@/lib/runninghub-config.ts";
import { isComfyUIModelEnabled, resolveComfyUIEntry } from "@/lib/comfyui-config.ts";
import {
  applyOpenAIParamsToRh,
  collectOpenAIInputAudios,
  collectOpenAIInputImages,
  collectOpenAIInputVideos,
  normalizeOpenAIImageBody,
} from "@/lib/openai-images-compat.ts";
import logger from "@/lib/logger.ts";

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") out[key] = item;
    else if (item != null && typeof item !== "object") out[key] = String(item);
  }
  return Object.keys(out).length ? out : undefined;
}

function asBoolMap(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "boolean") out[key] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

function resolveAuthToken(authorization: unknown, fallbackKey?: string) {
  const tokens = typeof authorization === "string" ? tokenSplit(authorization) : [];
  if (tokens.length > 0) return _.sample(tokens) as string;
  if (fallbackKey?.trim()) return fallbackKey.trim();
  return "";
}

function resolveRunningHubAuthSource(
  authorization: unknown,
  rhConfig: ReturnType<typeof db.getRunningHubConfig>,
  body: Record<string, any>
) {
  const headerToken = resolveAuthToken(authorization);
  if (headerToken) return { token: headerToken, source: "header" as const };
  const useWallet = isWalletPayment(body.payment, body.use_wallet);
  if (useWallet) {
    return {
      token: rhConfig.walletApiKey?.trim() || "",
      source: "dashboard-wallet" as const,
    };
  }
  return {
    token: rhConfig.apiKey?.trim() || "",
    source: "dashboard-coin" as const,
  };
}

function resolveRunningHubToken(
  authorization: unknown,
  rhConfig: ReturnType<typeof db.getRunningHubConfig>,
  body: Record<string, any>
) {
  const { token, source } = resolveRunningHubAuthSource(authorization, rhConfig, body);
  if (source === "header") return token;

  const useWallet = source === "dashboard-wallet";
  if (useWallet) {
    if (!token) {
      throw new APIException(
        EX.API_REQUEST_PARAMS_INVALID,
        "请求选择了账户余额计费（payment=wallet），但管理台未配置余额 API Key"
      );
    }
    if (rhConfig.apiKey && rhConfig.walletApiKey && rhConfig.apiKey === rhConfig.walletApiKey) {
      throw new APIException(
        EX.API_REQUEST_PARAMS_INVALID,
        "RH 币 Key 与余额 Key 不能相同。消费级请只用 RH 币 Key，并把 payment 改为 RH 币（或不传）"
      );
    }
    return token;
  }

  if (!token) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      "未提供 Authorization，且管理台未配置 RunningHub RH 币 API Key"
    );
  }
  return token;
}

function isOptionalString(v: unknown) {
  return _.isUndefined(v) || _.isString(v);
}

function isOptionalStringOrArray(v: unknown) {
  return _.isUndefined(v) || _.isString(v) || _.isArray(v);
}

type ResolvedImage = {
  url: string;
  base64: string;
  stegoDecoded: boolean;
};

/** 可选对鸭子图做隐写解密；失败则回退原图 */
async function resolveOutputImage(
  url: string,
  responseFormat: "url" | "b64_json",
  decode: boolean,
  password = ""
): Promise<ResolvedImage> {
  if (!decode && responseFormat === "url") {
    return { url, base64: "", stegoDecoded: false };
  }
  const buffer = await util.fetchFileBuffer(url);
  if (decode) {
    try {
      const result = decodeDuckImage(buffer, password);
      if (result.kind === "image" && result.buffer) {
        const mime = imageMimeForExt(result.ext);
        const base64 = result.buffer.toString("base64");
        logger.info(`[Images] 隐写解密成功 ext=${result.ext} bytes=${result.buffer.length}`);
        return { url: `data:${mime};base64,${base64}`, base64, stegoDecoded: true };
      }
      logger.warn(`[Images] 隐写解密得到非图片 kind=${result.kind} ext=${result.ext}，回退原图`);
    } catch (error) {
      logger.warn(`[Images] 隐写解密失败，回退原图: ${(error as Error)?.message || error}`);
    }
  }
  return { url, base64: buffer.toString("base64"), stegoDecoded: false };
}

async function buildOpenAIImageResponse(
  imageUrls: string[],
  responseFormat: "url" | "b64_json",
  decode = false,
  password = ""
) {
  const resolved = await Promise.all(
    imageUrls.map((url) => resolveOutputImage(url, responseFormat, decode, password))
  );
  const data =
    responseFormat === "b64_json"
      ? resolved.map((item) => ({ b64_json: item.base64 }))
      : resolved.map((item) => ({ url: item.url }));
  return {
    created: util.unixTimestamp(),
    data,
    _meta: {
      stegoDecodedCount: resolved.filter((item) => item.stegoDecoded).length,
    },
  };
}

async function handleRunningHubImages(request: Request, endpoint: "generations" | "edits") {
  const body = request.body || {};
  const rhConfig = db.getRunningHubConfig();
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "prompt 不能为空");
  }

  const bodyModel = typeof body.model === "string" ? body.model : undefined;
  const model =
    bodyModel ||
    (rhConfig.defaultModel && isRunningHubModel(rhConfig.defaultModel) ? rhConfig.defaultModel : "");
  if (!model || !isRunningHubModel(model)) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      endpoint === "edits"
        ? "RunningHub /v1/images/edits 需要 model 为 app:{id} 或 workflow:{id}（本阶段不支持即梦 edits）"
        : "无效的 RunningHub 模型名，请使用 app:{id} 或 workflow:{id}"
    );
  }

  if (!isRunningHubModelEnabled(rhConfig, model)) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      `RunningHub 模型 ${model} 已在管理台禁用，请到 RunningHub 页启用后再调用`
    );
  }

  const savedEntry = resolveRunningHubEntry(rhConfig, model);
  const openai = normalizeOpenAIImageBody(body);
  const paymentBody = {
    ...body,
    payment: body.payment || savedEntry?.payment,
  };
  const authMeta = resolveRunningHubAuthSource(request.headers.authorization, rhConfig, paymentBody);
  const token = resolveRunningHubToken(request.headers.authorization, rhConfig, paymentBody);
  if (!token) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "Authorization token is empty");
  }

  const requestRhParams = asStringMap(body.rh_params);
  const requestRhRandom = asBoolMap(body.rh_random);
  const requestRhEmptyImage = asBoolMap(body.rh_empty_image);
  const requestHasInstanceType = typeof body.instance_type === "string" && body.instance_type.trim() !== "";
  const mapped = applyOpenAIParamsToRh(savedEntry?.fields, requestRhParams || savedEntry?.rhParams, {
    size: openai.size,
    quality: openai.quality,
    instanceType: requestHasInstanceType ? body.instance_type : savedEntry?.instanceType || "",
    requestHasInstanceType,
    mapping: savedEntry?.openaiMapping,
  });

  const imageList = collectOpenAIInputImages(body, request.files);
  if (endpoint === "edits" && !imageList.length) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "edits 需要至少一张参考图（image / images / multipart）");
  }

  logger.info(
    `[Images] /${endpoint} backend=RunningHub model=${model} auth=${authMeta.source} n=${openai.n} size=${openai.size || "-"} quality=${openai.quality || "-"} images=${imageList.length} response_format=${openai.responseFormat} map.size=${mapped.mapping.size || "-"} map.quality=${mapped.mapping.quality || "-"}`
  );

  const imageUrls = await generateRunningHubImages(
    model,
    prompt,
    {
      images: imageList,
      baseUrl: typeof body.base_url === "string" ? body.base_url : rhConfig.baseUrl,
      instanceType: mapped.instanceType,
      n: openai.n,
      rhParams: mapped.rhParams,
      rhRandom: requestRhRandom || savedEntry?.rhRandom,
      rhEmptyImage: requestRhEmptyImage || savedEntry?.rhEmptyImage,
      openaiMapping: mapped.mapping,
    },
    token
  );

  const decode = savedEntry?.decode === true;
  const duckPassword =
    (mapped.rhParams && mapped.rhParams["216::password"]) ||
    (savedEntry?.rhParams && savedEntry.rhParams["216::password"]) ||
    "";
  logger.info(
    `[Images] /${endpoint} 完成 model=${model} urls=${imageUrls.length} decode=${decode}（以上 first=... 为 RH 原始地址，隐写解密在构造响应时进行）`
  );

  try {
    db.recordCall(token, model, 0);
    imageUrls.forEach((url) => {
      if (url) db.saveMedia("image", url, model, prompt, token);
    });
  } catch (e) {
    // ignore
  }

  const built = await buildOpenAIImageResponse(imageUrls, openai.responseFormat, decode, duckPassword);
  const { _meta, ...response } = built;
  const firstItem: any = response.data[0] || {};
  const firstKind = firstItem.b64_json
    ? "b64_json"
    : String(firstItem.url || "").startsWith("data:")
      ? _meta.stegoDecodedCount > 0
        ? "data-url(隐写已解密)"
        : "data-url(未隐写/解密失败回退)"
      : "http-url(未解码)";
  logger.info(
    `[Images] /${endpoint} 响应 model=${model} count=${response.data.length} response_format=${openai.responseFormat} decode=${decode} stego=${_meta.stegoDecodedCount}/${response.data.length} first=${firstKind}`
  );
  return response;
}

async function handleComfyUIImages(request: Request, endpoint: "generations" | "edits") {
  const body = request.body || {};
  const comfyConfig = db.getComfyUIConfig();
  let prompt = String(body.prompt || "").trim();
  if (!prompt) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "prompt 不能为空");
  }

  const bodyModel = typeof body.model === "string" ? body.model : undefined;
  const model =
    bodyModel ||
    (comfyConfig.defaultModel && isComfyUIModel(comfyConfig.defaultModel) ? comfyConfig.defaultModel : "");
  if (!model || !isComfyUIModel(model)) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      "无效的 ComfyUI 模型名，请使用 comfy:{id}"
    );
  }

  if (!isComfyUIModelEnabled(comfyConfig, model)) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      `ComfyUI 模型 ${model} 已在管理台禁用，请到 ComfyUI 页启用后再调用`
    );
  }

  const savedEntry = resolveComfyUIEntry(comfyConfig, model);
  if (!savedEntry?.workflowApi) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      `未找到工作流 ${model}，请先在管理台导入 ComfyUI API JSON`
    );
  }

  // 请求 prompt 为占位时，允许回落编辑器保存的默认长提示词（H3）
  if (prompt === "placeholder" || prompt === "-") {
    const keys = savedEntry.openaiMapping?.prompt || [];
    const defaults = savedEntry.comfyParams || {};
    const fromDefault = keys.map((k) => defaults[k]).find((v) => String(v || "").trim());
    if (fromDefault) prompt = String(fromDefault).trim();
  }

  const openai = normalizeOpenAIImageBody(body);
  const requestComfyParams = asStringMap(body.comfy_params) || asStringMap(body.rh_params);
  const imageList = collectOpenAIInputImages(body, request.files);
  const videoList = collectOpenAIInputVideos(body, request.files);
  const audioList = collectOpenAIInputAudios(body, request.files);
  if (endpoint === "edits" && !imageList.length && !videoList.length) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      "edits 需要至少一张参考图/视频（image / video / multipart）"
    );
  }
  const mappedImageSlots = Array.isArray(savedEntry?.openaiMapping?.images)
    ? savedEntry.openaiMapping.images.filter(Boolean).length
    : 0;
  const mappedVideoSlots = Array.isArray(savedEntry?.openaiMapping?.videos)
    ? savedEntry.openaiMapping.videos.filter(Boolean).length
    : 0;
  const mappedAudioSlots = Array.isArray(savedEntry?.openaiMapping?.audios)
    ? savedEntry.openaiMapping.audios.filter(Boolean).length
    : 0;

  const durationRaw = body.duration != null && body.duration !== "" ? body.duration : body.seconds;
  const durationNum = Number(durationRaw);
  const duration = Number.isFinite(durationNum) && durationNum > 0 ? durationNum : undefined;
  const ratio = typeof body.ratio === "string" ? body.ratio.trim() : "";
  const resolution = typeof body.resolution === "string" ? body.resolution.trim() : "";

  logger.info(
    `[Images] /${endpoint} backend=ComfyUI model=${model} n=${openai.n} images=${imageList.length}/${mappedImageSlots} videos=${videoList.length}/${mappedVideoSlots} audios=${audioList.length}/${mappedAudioSlots} duration=${duration ?? "-"} ratio=${ratio || "-"} resolution=${resolution || "-"} response_format=${openai.responseFormat}`
  );

  const imageUrls = await generateComfyUIImages(
    model,
    prompt,
    {
      images: imageList,
      videos: videoList,
      audios: audioList,
      baseUrl: typeof body.base_url === "string" ? body.base_url : comfyConfig.baseUrl,
      n: openai.n,
      duration,
      ratio: ratio || undefined,
      resolution: resolution || undefined,
      size: openai.size || undefined,
      comfyParams: requestComfyParams || savedEntry.comfyParams,
      openaiMapping: savedEntry.openaiMapping,
    },
    savedEntry
  );

  const decode = savedEntry?.decode === true;
  try {
    const token = resolveAuthToken(request.headers.authorization) || "comfyui-local";
    db.recordCall(token, model, 0);
    imageUrls.forEach((url) => {
      if (!url) return;
      const isVideo = /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url) || /[?&]filename=[^&]*\.(mp4|webm)/i.test(url);
      db.saveMedia(isVideo ? "video" : "image", url, model, prompt, token);
    });
  } catch (e) {
    // ignore
  }

  logger.info(`[Images] /${endpoint} ComfyUI 完成 model=${model} urls=${imageUrls.length} decode=${decode}`);
  const built = await buildOpenAIImageResponse(imageUrls, openai.responseFormat, decode, "");
  const { _meta, ...response } = built;
  return response;
}

export default {
  prefix: "/v1/images",

  post: {
    "/generations": async (request: Request) => {
      request
        .validate("body.model", isOptionalString)
        .validate("body.prompt", _.isString)
        .validate("body.n", (v) => _.isUndefined(v) || _.isFinite(v) || _.isString(v))
        .validate("body.size", isOptionalString)
        .validate("body.quality", isOptionalString)
        .validate("body.style", isOptionalString)
        .validate("body.user", isOptionalString)
        .validate("body.background", isOptionalString)
        .validate("body.input_fidelity", isOptionalString)
        .validate("body.output_format", isOptionalString)
        .validate("body.negative_prompt", isOptionalString)
        .validate("body.ratio", isOptionalString)
        .validate("body.resolution", isOptionalString)
        .validate("body.sample_strength", (v) => _.isUndefined(v) || _.isFinite(v))
        .validate("body.response_format", isOptionalString)
        .validate("body.filePath", isOptionalString)
        .validate("body.base_url", isOptionalString)
        .validate("body.instance_type", isOptionalString)
        .validate("body.payment", isOptionalString)
        .validate("body.use_wallet", (v) => _.isUndefined(v) || _.isBoolean(v) || _.isString(v) || _.isNumber(v))
        .validate("body.rh_params", (v) => _.isUndefined(v) || _.isObject(v))
        .validate("body.rh_random", (v) => _.isUndefined(v) || _.isObject(v))
        .validate("body.comfy_params", (v) => _.isUndefined(v) || _.isObject(v))
        .validate("body.duration", (v) => _.isUndefined(v) || _.isFinite(v) || _.isString(v))
        .validate("body.seconds", (v) => _.isUndefined(v) || _.isFinite(v) || _.isString(v))
        .validate("body.ratio", isOptionalString)
        .validate("body.resolution", isOptionalString)
        .validate("body.image", isOptionalStringOrArray)
        .validate("body.images", (v) => _.isUndefined(v) || _.isArray(v))
        .validate("body.video", isOptionalStringOrArray)
        .validate("body.videos", (v) => _.isUndefined(v) || _.isArray(v))
        .validate("body.audio", isOptionalStringOrArray)
        .validate("body.audios", (v) => _.isUndefined(v) || _.isArray(v));

      const rhConfig = db.getRunningHubConfig();
      const comfyConfig = db.getComfyUIConfig();
      const {
        model: bodyModel,
        prompt,
        negative_prompt: negativePrompt,
        ratio,
        resolution,
        sample_strength: sampleStrength,
        response_format,
        filePath: bodyFilePath,
      } = request.body;

      const model =
        bodyModel ||
        (rhConfig.defaultModel && isRunningHubModel(rhConfig.defaultModel)
          ? rhConfig.defaultModel
          : comfyConfig.defaultModel && isComfyUIModel(comfyConfig.defaultModel)
            ? comfyConfig.defaultModel
            : DEFAULT_MODEL);
      if (isRunningHubModel(model)) {
        return handleRunningHubImages(request, "generations");
      }
      if (isComfyUIModel(model)) {
        return handleComfyUIImages(request, "generations");
      }

      // —— 即梦路径保持原样 ——
      const token = resolveAuthToken(request.headers.authorization);
      if (!token) {
        throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "Authorization token is empty");
      }

      let filePath = bodyFilePath;
      // multipart multiples:true 时同名字段可能是数组；只取第一张给即梦参考图
      const files = (request.files || {}) as Record<string, any>;
      if (!filePath && !_.isEmpty(files)) {
        for (const key of Object.keys(files)) {
          const value = files[key];
          const list = Array.isArray(value) ? value : value ? [value] : [];
          for (const file of list) {
            const p = file?.filepath || file?.path;
            if (typeof p === "string" && p.trim()) {
              filePath = p.trim();
              break;
            }
          }
          if (filePath) break;
        }
      }

      const responseFormat = _.defaultTo(response_format, "url");
      logger.info(`[Images] /generations backend=Jimeng model=${model} response_format=${responseFormat}`);

      const imageUrls = await generateImagesWithRetry(
        model,
        prompt,
        {
          ratio,
          resolution,
          sampleStrength,
          negativePrompt,
          filePath,
        },
        token
      );

      logger.info(`[Images] /generations 完成 model=${model} urls=${imageUrls.length}`);

      try {
        db.recordCall(token, model, 0);
        imageUrls.forEach((url) => {
          if (url) db.saveMedia("image", url, model, prompt, token);
        });
      } catch (e) {
        // ignore
      }

      return buildOpenAIImageResponse(
        imageUrls,
        responseFormat === "b64_json" ? "b64_json" : "url"
      );
    },

    "/edits": async (request: Request) => {
      request
        .validate("body.model", isOptionalString)
        .validate("body.prompt", _.isString)
        .validate("body.n", (v) => _.isUndefined(v) || _.isFinite(v) || _.isString(v))
        .validate("body.size", isOptionalString)
        .validate("body.quality", isOptionalString)
        .validate("body.response_format", isOptionalString)
        .validate("body.image", isOptionalStringOrArray)
        .validate("body.images", (v) => _.isUndefined(v) || _.isArray(v))
        .validate("body.video", isOptionalStringOrArray)
        .validate("body.videos", (v) => _.isUndefined(v) || _.isArray(v))
        .validate("body.audio", isOptionalStringOrArray)
        .validate("body.audios", (v) => _.isUndefined(v) || _.isArray(v))
        .validate("body.duration", (v) => _.isUndefined(v) || _.isFinite(v) || _.isString(v))
        .validate("body.seconds", (v) => _.isUndefined(v) || _.isFinite(v) || _.isString(v))
        .validate("body.ratio", isOptionalString)
        .validate("body.resolution", isOptionalString)
        .validate("body.base_url", isOptionalString)
        .validate("body.instance_type", isOptionalString)
        .validate("body.payment", isOptionalString)
        .validate("body.use_wallet", (v) => _.isUndefined(v) || _.isBoolean(v) || _.isString(v) || _.isNumber(v))
        .validate("body.rh_params", (v) => _.isUndefined(v) || _.isObject(v))
        .validate("body.rh_random", (v) => _.isUndefined(v) || _.isObject(v))
        .validate("body.comfy_params", (v) => _.isUndefined(v) || _.isObject(v));

      const bodyModel = typeof request.body?.model === "string" ? request.body.model : "";
      if (isComfyUIModel(bodyModel) || (!bodyModel && isComfyUIModel(db.getComfyUIConfig().defaultModel))) {
        return handleComfyUIImages(request, "edits");
      }
      return handleRunningHubImages(request, "edits");
    },
  },
};
