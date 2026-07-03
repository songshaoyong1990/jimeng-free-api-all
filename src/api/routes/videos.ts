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

function collectFilePaths(request: Request, file_paths: string[] = []) {
    const filePaths = [...file_paths];
    // @ts-ignore
    const files = request.files || {};
    if (!_.isEmpty(files)) {
        _.forEach(files, (file) => {
            if (file) {
                const path = file.filepath || file.path;
                if (path) filePaths.push(path);
            }
        });
    }
    return filePaths;
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

export default {

    prefix: '/v1/videos',

    post: {

        '': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.prompt', _.isString)
                .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
                .validate('body.resolution', v => _.isUndefined(v) || _.isString(v))
                .validate('body.duration', v => _.isUndefined(v) || _.isFinite(v))
                .validate('body.file_paths', v => _.isUndefined(v) || _.isArray(v))
                .validate('headers.authorization', _.isString);

            const token = pickToken(request);
            const {
                model = DEFAULT_MODEL,
                prompt,
                ratio,
                resolution,
                duration = 10,
                file_paths = [],
            } = request.body;
            const filePaths = collectFilePaths(request, file_paths);
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
                .validate('body.duration', v => _.isUndefined(v) || _.isFinite(v))
                .validate('body.file_paths', v => _.isUndefined(v) || _.isArray(v))
                .validate('body.response_format', v => _.isUndefined(v) || _.isString(v))
                .validate('headers.authorization', _.isString);

            const token = pickToken(request);
            const {
                model = DEFAULT_MODEL,
                prompt,
                ratio,
                resolution,
                duration = 10,
                file_paths = [],
                response_format = "url"
            } = request.body;
            const filePaths = collectFilePaths(request, file_paths);

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
            request.validate('headers.authorization', _.isString);
            const token = pickToken(request);
            const historyId = request.params.id;
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
            request.validate('headers.authorization', _.isString);
            const token = pickToken(request);
            const historyId = request.params.id;
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
