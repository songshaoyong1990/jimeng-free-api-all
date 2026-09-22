import Request from '@/lib/request/Request.ts';
import { tokenSplit } from '@/api/controllers/core.ts';
import { listModelConfigs, toOpenAIModel } from '@/api/controllers/models.ts';
import db from '@/lib/database.ts';

export default {

    prefix: '/v1',

    get: {
        '/models': async (request: Request) => {
            const tokens = typeof request.headers.authorization === 'string'
                ? tokenSplit(request.headers.authorization)
                : [];
            const refresh = request.query.refresh === 'true' || request.query.refresh === '1';
            const type = request.query.type === 'image' || request.query.type === 'video'
                ? request.query.type
                : undefined;
            const models = await listModelConfigs(tokens[0], { refresh, type });
            const data = models.map(toOpenAIModel);

            // 附带管理台已启用的 RunningHub 应用/工作流
            if (!type || type === 'image') {
                const rh = db.getRunningHubConfigPublic();
                const existing = new Set(data.map((item) => item.id));
                for (const modelId of rh.models) {
                    if (existing.has(modelId)) continue;
                    const kind = modelId.startsWith('workflow:') ? 'workflow' : 'app';
                    const entry = kind === 'app'
                        ? rh.rhApps.find((item) => `app:${item.appId || item.id}` === modelId)
                        : rh.rhWorkflows.find((item) => `workflow:${item.workflowId || item.id}` === modelId);
                    data.push({
                        id: modelId,
                        object: 'model',
                        owned_by: 'runninghub',
                        description: entry?.title || `RunningHub ${kind}`,
                        name: entry?.title || modelId,
                        model_req_key: modelId,
                        supported_resolutions: [],
                        default_resolution: '',
                        source: 'runninghub',
                    });
                    existing.add(modelId);
                }

                const comfy = db.getComfyUIConfigPublic();
                for (const modelId of comfy.models) {
                    if (existing.has(modelId)) continue;
                    const entry = comfy.workflows.find((item) => `comfy:${item.id}` === modelId);
                    data.push({
                        id: modelId,
                        object: 'model',
                        owned_by: 'comfyui',
                        description: entry?.title || 'Local ComfyUI',
                        name: entry?.title || modelId,
                        model_req_key: modelId,
                        supported_resolutions: [],
                        default_resolution: '',
                        source: 'comfyui',
                    });
                }
            }

            return { data };
        }

    }
}
