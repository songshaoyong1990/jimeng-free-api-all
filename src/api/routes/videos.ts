import _ from 'lodash';
import axios from 'axios';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { tokenSplit } from '@/api/controllers/core.ts';
import {
    generateVideoWithRetry,
    queryVideoGenerationStatus,
    submitVideoWithRetry,
    DEFAULT_MODEL,
} from '@/api/controllers/videos.ts';
import {
    encodeComfyJobId,
    isComfyUIModel,
    isComfyPromptJobId,
    queryComfyUIJob,
    submitComfyUIJob,
} from '@/api/controllers/comfyui.ts';
import { isComfyUIModelEnabled, resolveComfyUIEntry } from '@/lib/comfyui-config.ts';
import {
    encodeMuseTaskId,
    fetchMuseMedia,
    isMuseTaskId,
    parseMuseTaskId,
    queryMuseVideo,
    ratioFromOpenAISize,
    resolveMuse2APIAuth,
    submitMuseVideo,
    waitForMuseVideo,
} from '@/api/controllers/muse2api.ts';
import { isMuse2APIModel, looksLikeMuse2APIKey, parseMuse2APIModel } from '@/lib/muse2api-config.ts';
import {
    collectOpenAIInputAudios,
    collectOpenAIInputImages,
    collectOpenAIInputVideos,
} from '@/lib/openai-images-compat.ts';
import util from '@/lib/util.ts';
import db from '@/lib/database.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';

function pickToken(request: Request) {
    const tokens = tokenSplit(request.headers.authorization);
    if (tokens.length === 0) {
        throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "Authorization token is empty");
    }
    return _.sample(tokens);
}

function tryPickToken(request: Request) {
    try {
        const tokens = tokenSplit(request.headers.authorization);
        return tokens.length ? (_.sample(tokens) as string) : "comfyui-local";
    } catch {
        return "comfyui-local";
    }
}

function asOptionalNumber(v: unknown) {
    return _.isUndefined(v) || _.isFinite(v) || (_.isString(v) && String(v).trim() !== "" && Number.isFinite(Number(v)));
}

function resolveVideoDuration(body: Record<string, any>) {
    const raw = body.duration != null && body.duration !== "" ? body.duration : body.seconds;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    return 10;
}

function collectFilePaths(request: Request, file_paths: string[] = []) {
    const filePaths = [...file_paths];
    const files = (request.files || {}) as Record<string, any>;
    if (!_.isEmpty(files)) {
        _.forEach(files, (file) => {
            const list = Array.isArray(file) ? file : file ? [file] : [];
            for (const item of list) {
                const path = item?.filepath || item?.path;
                if (typeof path === "string" && path.trim()) filePaths.push(path.trim());
            }
        });
    }
    return filePaths;
}

function collectVideoFrameSources(request: Request, body: Record<string, any> = {}) {
    const out: string[] = [];
    const push = (value: unknown) => {
        if (typeof value === "string" && value.trim()) out.push(value.trim());
    };
    push(body.image);
    if (Array.isArray(body.image)) body.image.forEach(push);
    if (Array.isArray(body.images)) body.images.forEach(push);
    if (Array.isArray(body.file_paths)) body.file_paths.forEach(push);
    if (typeof body.file_paths === "string" && body.file_paths.trim()) out.push(body.file_paths.trim());
    push(body.input_reference);
    if (Array.isArray(body.input_reference)) body.input_reference.forEach(push);
    out.push(...collectFilePaths(request, []));
    return _.uniq(out);
}

/**
 * Muse2API 的参考素材允许混放图片/视频/音频/文档（上游按 MIME 识别），
 * 这里保持“首帧/尾帧 → 其他图片 → 参考视频 → 参考音频 → 文档”的顺序。
 */
function collectMuseReferenceSources(request: Request, body: Record<string, any> = {}) {
    const out: string[] = [];
    const push = (value: unknown) => {
        if (typeof value === "string" && value.trim()) {
            out.push(value.trim());
            return;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const record = value as Record<string, any>;
        const url = record.url || record.image_url || record.video_url || record.audio_url || record.file_url;
        if (typeof url === "string" && url.trim()) out.push(url.trim());
        else if (typeof record.b64_json === "string" && record.b64_json.trim()) out.push(record.b64_json.trim());
        else if (typeof record.data === "string" && record.data.trim()) out.push(record.data.trim());
    };
    const pushMany = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(push);
        else push(value);
    };
    // 首尾帧必须排在最前：上游默认把第一张图当作起始画面。
    pushMany(body.first_frame);
    pushMany(body.last_frame);
    pushMany(body.file_paths);
    pushMany(body.filePaths);
    pushMany(body.image);
    pushMany(body.images);
    pushMany(body.image_url);
    pushMany(body.input_reference);
    pushMany(body.videos);
    pushMany(body.audios);
    pushMany(body.files);

    const files = (request.files || {}) as Record<string, any>;
    const pushFiles = (pattern: RegExp) => {
        for (const [key, value] of Object.entries(files)) {
            if (!pattern.test(key) && key !== "0") continue;
            const list = Array.isArray(value) ? value : [value];
            for (const item of list) {
                const filePath = item?.filepath || item?.path;
                if (typeof filePath === "string" && filePath.trim()) out.push(filePath.trim());
            }
        }
    };
    pushFiles(/^(image|images|first|last)/i);
    pushFiles(/^(video|videos)/i);
    pushFiles(/^(audio|audios)/i);
    pushFiles(/^(file|files)/i);
    // 不去重：首帧与尾帧允许是同一张图，去重会让上游少一张参考。
    return out;
}

function mapQueryToOpenAiStatus(result: Awaited<ReturnType<typeof queryVideoGenerationStatus>>) {
    if (result.status === "completed") {
        return { status: "completed" as const, url: result.url };
    }
    if (result.status === "failed") {
        return { status: "failed" as const, error: { message: result.message } };
    }
    return { status: "in_progress" as const };
}

async function submitComfyVideoJob(request: Request) {
    const body = request.body || {};
    const prompt = String(body.prompt || "").trim();
    if (!prompt) {
        throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "prompt 不能为空");
    }
    const model = typeof body.model === "string" ? body.model : "";
    if (!model || !isComfyUIModel(model)) {
        throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "无效的 ComfyUI 模型，请使用 comfy:{id}");
    }
    const comfyConfig = db.getComfyUIConfig();
    if (!isComfyUIModelEnabled(comfyConfig, model)) {
        throw new APIException(EX.API_REQUEST_PARAMS_INVALID, `ComfyUI 模型 ${model} 已禁用`);
    }
    const entry = resolveComfyUIEntry(comfyConfig, model);
    if (!entry?.workflowApi) {
        throw new APIException(EX.API_REQUEST_PARAMS_INVALID, `未找到工作流 ${model}`);
    }

    const duration = resolveVideoDuration(body);
    const ratio = typeof body.ratio === "string" ? body.ratio.trim() : "";
    const resolution = typeof body.resolution === "string" ? body.resolution.trim() : "";
    const images = collectOpenAIInputImages(body, request.files);
    const videos = collectOpenAIInputVideos(body, request.files);
    const audios = collectOpenAIInputAudios(body, request.files);

    const { promptId } = await submitComfyUIJob(
        model,
        prompt,
        {
            images,
            videos,
            audios,
            baseUrl: typeof body.base_url === "string" ? body.base_url : comfyConfig.baseUrl,
            duration,
            ratio: ratio || undefined,
            resolution: resolution || undefined,
            comfyParams: entry.comfyParams,
            openaiMapping: entry.openaiMapping,
        },
        entry
    );

    try {
        db.recordCall(tryPickToken(request), model, 0);
    } catch {
        /* ignore */
    }

    return {
        id: encodeComfyJobId(promptId),
        object: "video",
        status: "in_progress",
        model,
        created_at: util.unixTimestamp(),
        backend: "comfyui",
    };
}

// ==================== Muse2API ====================

function resolveMuseHeaderToken(request: Request) {
    const tokens = tokenSplit(request.headers.authorization || "");
    return tokens.find((token) => looksLikeMuse2APIKey(token)) || "";
}

/** muse2api 的 size 直接吃 16:9 / 1024x1024，这里把 ratio / size 互补一下 */
function resolveMuseFrameParams(body: Record<string, any>) {
    const size = typeof body.size === "string" ? body.size.trim() : "";
    const ratio = typeof body.ratio === "string" ? body.ratio.trim() : "";
    const extraAspect = typeof body.aspect_ratio === "string" ? body.aspect_ratio.trim() : "";
    const aspectRatio = ratio || extraAspect || ratioFromOpenAISize(size);
    return { size: size || ratio || extraAspect, aspectRatio };
}

function resolveVideoModel(body: Record<string, any>) {
    const bodyModel = typeof body.model === "string" ? body.model.trim() : "";
    if (bodyModel) return bodyModel;
    const museConfig = db.getMuse2APIConfig();
    if (parseMuse2APIModel(museConfig.defaultModel)?.type === "video") {
        return museConfig.defaultModel;
    }
    const comfyConfig = db.getComfyUIConfig();
    if (isComfyUIModel(comfyConfig.defaultModel)) return comfyConfig.defaultModel;
    return DEFAULT_MODEL;
}

async function submitMuseVideoJob(request: Request, model: string) {
    const body = request.body || {};
    const prompt = String(body.prompt || "").trim();
    if (!prompt) {
        throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "prompt 不能为空");
    }
    const config = db.getMuse2APIConfig();
    const headerToken = resolveMuseHeaderToken(request);
    const baseUrl = typeof body.base_url === "string" ? body.base_url : config.baseUrl;
    const auth = resolveMuse2APIAuth(config, { baseUrl, headerToken });
    const { size, aspectRatio } = resolveMuseFrameParams(body);
    const timeoutRaw = Number(body.timeout);
    // 不指定时让上游用它自己的默认时长（muse2api 默认 6 秒），不要用即梦的 10 秒覆盖。
    const durationRaw = body.duration != null && body.duration !== "" ? body.duration : body.seconds;
    const durationNum = Number(durationRaw);
    const duration = Number.isFinite(durationNum) && durationNum > 0 ? durationNum : undefined;

    const taskId = await submitMuseVideo(
        model,
        prompt,
        {
            images: collectMuseReferenceSources(request, body),
            duration,
            size,
            aspectRatio,
            resolution: typeof body.resolution === "string" ? body.resolution.trim() : "",
            timeout:
                Number.isFinite(timeoutRaw) && timeoutRaw > 0
                    ? Math.min(600, Math.floor(timeoutRaw))
                    : undefined,
            extra: typeof body.extra === "string" ? body.extra : undefined,
            baseUrl: auth.baseUrl,
            headerToken,
        },
        config
    );

    return {
        taskId,
        prompt,
        config,
        headerToken,
        baseUrl: auth.baseUrl,
        apiKey: auth.apiKey,
    };
}

export default {

    prefix: '/v1/videos',

    post: {

        '': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.prompt', _.isString)
                .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
                .validate('body.resolution', v => _.isUndefined(v) || _.isString(v))
                .validate('body.duration', asOptionalNumber)
                .validate('body.seconds', asOptionalNumber)
                .validate('body.file_paths', v => _.isUndefined(v) || _.isArray(v) || _.isString(v))
                .validate('body.image', v => _.isUndefined(v) || _.isString(v) || _.isArray(v) || _.isObject(v))
                .validate('body.images', v => _.isUndefined(v) || _.isArray(v))
                .validate('body.input_reference', v => _.isUndefined(v) || _.isString(v) || _.isArray(v))
                .validate('body.videos', v => _.isUndefined(v) || _.isArray(v))
                .validate('body.audios', v => _.isUndefined(v) || _.isArray(v))
                .validate('body.files', v => _.isUndefined(v) || _.isArray(v));

            const body = request.body || {};
            const model = resolveVideoModel(body);

            // ComfyUI：异步入队，立刻返回 prompt_id（官方用法，避免 HTTP 长连接超时）
            if (isComfyUIModel(model)) {
                return submitComfyVideoJob(request);
            }

            // Muse2API：异步任务，立刻返回 muse-{task_id}
            if (isMuse2APIModel(model)) {
                const submitted = await submitMuseVideoJob(request, model);
                try {
                    db.recordCall(submitted.apiKey, model, 0);
                } catch (e) {
                    // 忽略数据库错误
                }
                return {
                    id: encodeMuseTaskId(submitted.taskId),
                    object: "video",
                    status: "in_progress",
                    model,
                    created_at: util.unixTimestamp(),
                    backend: "muse2api",
                };
            }

            request.validate('headers.authorization', _.isString);
            const token = pickToken(request);
            const {
                prompt,
                ratio,
                resolution,
            } = body;
            const duration = resolveVideoDuration(body);
            const filePaths = collectVideoFrameSources(request, body);
            const historyId = await submitVideoWithRetry(
                model,
                prompt,
                { ratio, resolution, duration, filePaths },
                token
            );

            try {
                db.recordCall(token, model, 0);
            } catch (e) {
                // 忽略数据库错误
            }

            return {
                id: historyId,
                object: "video",
                status: "in_progress",
                model,
                created_at: util.unixTimestamp(),
            };
        },

        '/generations': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.prompt', _.isString)
                .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
                .validate('body.resolution', v => _.isUndefined(v) || _.isString(v))
                .validate('body.duration', asOptionalNumber)
                .validate('body.seconds', asOptionalNumber)
                .validate('body.file_paths', v => _.isUndefined(v) || _.isArray(v) || _.isString(v))
                .validate('body.image', v => _.isUndefined(v) || _.isString(v) || _.isArray(v) || _.isObject(v))
                .validate('body.images', v => _.isUndefined(v) || _.isArray(v))
                .validate('body.input_reference', v => _.isUndefined(v) || _.isString(v) || _.isArray(v))
                .validate('body.videos', v => _.isUndefined(v) || _.isArray(v))
                .validate('body.audios', v => _.isUndefined(v) || _.isArray(v))
                .validate('body.files', v => _.isUndefined(v) || _.isArray(v))
                .validate('body.response_format', v => _.isUndefined(v) || _.isString(v));

            const body = request.body || {};
            const model = resolveVideoModel(body);
            const {
                prompt,
                ratio,
                resolution,
                response_format = "url"
            } = body;

            // Muse2API：提交后同步等待结果（长请求，客户端可改用 /v1/videos + 轮询）
            if (isMuse2APIModel(model)) {
                const submitted = await submitMuseVideoJob(request, model);
                const museUrl = await waitForMuseVideo(submitted.taskId, submitted.config, {
                    baseUrl: submitted.baseUrl,
                    headerToken: submitted.headerToken,
                });
                try {
                    db.recordCall(submitted.apiKey, model, 0);
                    db.saveMedia('video', museUrl, model, submitted.prompt, submitted.apiKey);
                } catch (e) {
                    // 忽略数据库错误
                }
                if (response_format === "b64_json") {
                    return {
                        created: util.unixTimestamp(),
                        data: [{
                            b64_json: await util.fetchFileBASE64(museUrl),
                            revised_prompt: submitted.prompt
                        }]
                    };
                }
                return {
                    created: util.unixTimestamp(),
                    data: [{
                        url: museUrl,
                        revised_prompt: submitted.prompt
                    }]
                };
            }

            request.validate('headers.authorization', _.isString);
            const token = pickToken(request);
            const duration = resolveVideoDuration(body);
            const filePaths = collectVideoFrameSources(request, body);

            const videoUrl = await generateVideoWithRetry(
                model,
                prompt,
                { ratio, resolution, duration, filePaths },
                token
            );

            try {
                db.recordCall(token, model, 0);
                if (videoUrl) db.saveMedia('video', videoUrl, model, prompt, token);
            } catch (e) {
                // 忽略数据库错误
            }

            if (response_format === "b64_json") {
                const videoBase64 = await util.fetchFileBASE64(videoUrl);
                return {
                    created: util.unixTimestamp(),
                    data: [{
                        b64_json: videoBase64,
                        revised_prompt: prompt
                    }]
                };
            } else {
                return {
                    created: util.unixTimestamp(),
                    data: [{
                        url: videoUrl,
                        revised_prompt: prompt
                    }]
                };
            }
        }

    },

    get: {

        '/:id/content': async (request: Request) => {
            const historyId = String(request.params.id || "");

            if (isComfyPromptJobId(historyId)) {
                const comfyConfig = db.getComfyUIConfig();
                const state = await queryComfyUIJob(historyId, comfyConfig.baseUrl);
                if (state.status === "failed") {
                    throw new APIException(EX.API_VIDEO_GENERATION_FAILED, state.message || "ComfyUI 失败");
                }
                if (state.status !== "completed" || !state.url) {
                    throw new APIException(EX.API_VIDEO_GENERATION_FAILED, "视频尚未生成完成");
                }
                const buffer = Buffer.from(
                    (await axios.get(state.url, { responseType: "arraybuffer", timeout: 120000 })).data
                );
                return new Response(buffer, { type: "mp4" });
            }

            if (isMuseTaskId(historyId)) {
                const taskId = parseMuseTaskId(historyId)!;
                const config = db.getMuse2APIConfig();
                const state = await queryMuseVideo(taskId, config, {
                    baseUrl: config.baseUrl,
                    headerToken: resolveMuseHeaderToken(request),
                });
                if (state.status === "failed") {
                    throw new APIException(EX.API_VIDEO_GENERATION_FAILED, state.message);
                }
                if (state.status !== "completed") {
                    throw new APIException(EX.API_VIDEO_GENERATION_FAILED, "视频尚未生成完成");
                }
                const buffer = await fetchMuseMedia(state.url);
                return new Response(buffer, { type: "mp4" });
            }

            request.validate('headers.authorization', _.isString);
            const token = pickToken(request);
            const state = await queryVideoGenerationStatus(historyId, token);
            if (state.status === "failed") {
                throw new APIException(EX.API_VIDEO_GENERATION_FAILED, state.message);
            }
            if (state.status !== "completed") {
                throw new APIException(EX.API_VIDEO_GENERATION_FAILED, "视频尚未生成完成");
            }
            const buffer = Buffer.from(
                (await axios.get(state.url, { responseType: "arraybuffer" })).data
            );
            return new Response(buffer, { type: "mp4" });
        },

        '/:id': async (request: Request) => {
            const historyId = String(request.params.id || "");

            if (isComfyPromptJobId(historyId)) {
                const comfyConfig = db.getComfyUIConfig();
                const state = await queryComfyUIJob(historyId, comfyConfig.baseUrl);
                if (state.status === "completed") {
                    return {
                        id: historyId,
                        object: "video",
                        status: "completed",
                        url: state.url,
                        model: state.model,
                        backend: "comfyui",
                    };
                }
                if (state.status === "failed") {
                    return {
                        id: historyId,
                        object: "video",
                        status: "failed",
                        error: { message: state.message },
                        model: state.model,
                        backend: "comfyui",
                    };
                }
                return {
                    id: historyId,
                    object: "video",
                    status: "in_progress",
                    model: state.model,
                    backend: "comfyui",
                };
            }

            if (isMuseTaskId(historyId)) {
                const taskId = parseMuseTaskId(historyId)!;
                const config = db.getMuse2APIConfig();
                const state = await queryMuseVideo(taskId, config, {
                    baseUrl: config.baseUrl,
                    headerToken: resolveMuseHeaderToken(request),
                });
                if (state.status === "completed") {
                    return {
                        id: String(historyId),
                        object: "video",
                        status: "completed",
                        progress: 100,
                        url: state.url,
                        result: { url: state.url },
                        backend: "muse2api",
                    };
                }
                if (state.status === "failed") {
                    return {
                        id: String(historyId),
                        object: "video",
                        status: "failed",
                        error: { message: state.message },
                        backend: "muse2api",
                    };
                }
                return {
                    id: String(historyId),
                    object: "video",
                    status: "in_progress",
                    progress: state.progress ?? 0,
                    backend: "muse2api",
                };
            }

            request.validate('headers.authorization', _.isString);
            const token = pickToken(request);
            const mapped = mapQueryToOpenAiStatus(
                await queryVideoGenerationStatus(historyId, token)
            );
            return {
                id: String(historyId),
                object: "video",
                ...mapped,
            };
        },

    }

}
