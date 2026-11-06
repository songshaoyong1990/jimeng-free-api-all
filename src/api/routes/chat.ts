import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { tokenSplit } from '@/api/controllers/core.ts';
import { createCompletion, createCompletionStream } from '@/api/controllers/chat.ts';
import {
    createMuseChatCompletion,
    createMuseChatStream,
} from '@/api/controllers/muse2api.ts';
import { isMuse2APIChatModel, looksLikeMuse2APIKey } from '@/lib/muse2api-config.ts';
import db from '@/lib/database.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';

function resolveMuseHeaderToken(authorization: unknown) {
    const tokens = typeof authorization === 'string' ? tokenSplit(authorization) : [];
    return tokens.find((token) => looksLikeMuse2APIKey(token)) || '';
}

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
                .validate('body.base_url', v => _.isUndefined(v) || _.isString(v))

            const { model, messages, stream } = request.body;

            // Muse2API：文本 / 代码对话，直接透传 OpenAI Chat Completions
            if (isMuse2APIChatModel(model)) {
                const config = db.getMuse2APIConfig();
                const headerToken = resolveMuseHeaderToken(request.headers.authorization);
                const baseUrl = typeof request.body.base_url === 'string' && request.body.base_url.trim()
                    ? request.body.base_url.trim()
                    : config.baseUrl;
                if (stream) {
                    const upstream = await createMuseChatStream(messages, config, {
                        baseUrl,
                        headerToken,
                        model,
                    });
                    return new Response(upstream, { type: 'text/event-stream' });
                }
                return await createMuseChatCompletion(messages, config, {
                    baseUrl,
                    headerToken,
                    model,
                });
            }

            request.validate('headers.authorization', _.isString)
            // refresh_token切分
            const tokens = tokenSplit(request.headers.authorization);
            if (tokens.length === 0) {
                throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "Authorization token is empty");
            }
            // 随机挑选一个refresh_token
            const token = _.sample(tokens);
            if (stream) {
                const stream = await createCompletionStream(messages, token, model);
                return new Response(stream, {
                    type: "text/event-stream"
                });
            }
            else
                return await createCompletion(messages, token, model);
        }

    }

}
