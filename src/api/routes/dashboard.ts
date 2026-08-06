import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import db from '@/lib/database.ts';
import { getCredit } from '@/api/controllers/core.ts';
import { analyzeRunningHubEntry } from '@/api/controllers/runninghub.ts';
import {
  loadDefaultRunningHubCatalog,
  mergeRunningHubEntries,
  parseRunningHubUrl,
  slimRunningHubEntry,
} from '@/lib/runninghub-config.ts';
import { inferOpenAIMapping, resolveOpenAIMapping } from '@/lib/openai-images-compat.ts';

function requireSession(request: Request) {
  const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
  if (!sessionId || !db.validateSession(sessionId)) {
    return null;
  }
  return sessionId;
}

function resolveRhAnalyzeKey(config: ReturnType<typeof db.getRunningHubConfig>) {
  if (config.apiKey?.trim()) return config.apiKey.trim();
  if (config.walletApiKey?.trim()) return config.walletApiKey.trim();
  return '';
}

async function analyzeAndBuildEntry(kind: 'app' | 'workflow', id: string) {
  const config = db.getRunningHubConfig();
  const apiKey = resolveRhAnalyzeKey(config);
  if (!apiKey) {
    const err: any = new Error('请先保存 RunningHub RH 币 API Key（或余额 Key），再添加链接进行分析');
    err.statusCode = 400;
    throw err;
  }
  const analyzed = await analyzeRunningHubEntry(kind, id, {
    baseUrl: config.baseUrl,
    apiKey,
  });
  const list = kind === 'app' ? config.rhApps : config.rhWorkflows;
  const prev = list.find((item) => item.id === id || (kind === 'app' ? item.appId : item.workflowId) === id);
  const fieldKeys = new Set((analyzed.fields || []).map((field) => `${field.nodeId}::${field.fieldName}`));
  const mergedParams: Record<string, string> = { ...(analyzed.rhParams || {}) };
  if (prev?.rhParams) {
    for (const [key, value] of Object.entries(prev.rhParams)) {
      if (fieldKeys.has(key) && value != null && String(value).trim() !== '') mergedParams[key] = String(value);
    }
  }
  const openaiMapping = resolveOpenAIMapping(
    analyzed.fields,
    prev?.openaiMapping || inferOpenAIMapping(analyzed.fields)
  );
  // 已有 images 映射时，把新分析出的 IMAGE 字段追加到末尾（空映射=显式不映射则不追加）
  const mappedImages = openaiMapping.images || [];
  if (mappedImages.length > 0) {
    const inferredImages = (inferOpenAIMapping(analyzed.fields).images || []).filter(Boolean);
    const extras = inferredImages.filter((key) => !mappedImages.includes(key));
    if (extras.length) openaiMapping.images = [...mappedImages, ...extras];
  }
  return slimRunningHubEntry(
    {
      id: analyzed.id,
      title: analyzed.title,
      enabled: prev?.enabled !== false,
      fields: analyzed.fields,
      rhParams: mergedParams,
      rhRandom: prev?.rhRandom,
      rhEmptyImage: prev?.rhEmptyImage,
      openaiMapping,
      instanceType: prev?.instanceType || '',
      payment: prev?.payment || 'coin',
      analysis: analyzed.analysis,
      analyzedAt: analyzed.analyzedAt,
      ...(kind === 'app' ? { appId: analyzed.id } : { workflowId: analyzed.id }),
    },
    kind
  );
}

export default {
  prefix: '/dashboard',

  get: {
    '/status': async (request: Request) => {
      return {
        setupComplete: db.isSetupComplete()
      };
    },

    '/stats': async (request: Request) => {
      if (!requireSession(request)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      return db.getStats();
    },

    '/logs': async (request: Request) => {
      if (!requireSession(request)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      const level = request.query.level as string;
      const limit = parseInt(request.query.limit as string) || 100;
      return db.getLogs(level, limit);
    },

    '/media': async (request: Request) => {
      if (!requireSession(request)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      const page = parseInt(request.query.page as string) || 1;
      const limit = parseInt(request.query.limit as string) || 20;
      const type = request.query.type as string;
      return db.getMedia(page, limit, type);
    },

    '/credits': async (request: Request) => {
      if (!requireSession(request)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      const key = request.query.key as string;
      if (!key) {
        return { error: '缺少Key参数' };
      }
      try {
        const credits = await getCredit(key);
        return credits;
      } catch (e) {
        return { error: '查询失败', message: e.message };
      }
    },

    '/runninghub': async (request: Request) => {
      if (!requireSession(request)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      return db.getRunningHubConfigPublic();
    }
  },

  post: {
    '/setup': async (request: Request) => {
      if (db.isSetupComplete()) {
        return new Response({ error: '已完成初始化设置' }, { statusCode: 400 });
      }
      const { username, password } = request.body;
      if (!username || !password) {
        return new Response({ error: '用户名和密码不能为空' }, { statusCode: 400 });
      }
      if (password.length < 6) {
        return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      }
      db.createUser(username, password);
      return { success: true, message: '设置成功' };
    },

    '/login': async (request: Request) => {
      const { username, password } = request.body;
      const userId = db.validateUser(username, password);
      if (!userId) {
        return new Response({ error: '用户名或密码错误' }, { statusCode: 401 });
      }
      const sessionId = db.createSession(userId);
      return new Response(
        { success: true },
        { 
          statusCode: 200,
          headers: { 'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; Max-Age=86400` }
        }
      );
    },

    '/logout': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
      if (sessionId) {
        db.deleteSession(sessionId);
      }
      return new Response(
        { success: true },
        { 
          statusCode: 200,
          headers: { 'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0' }
        }
      );
    },

    '/password': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
      const userId = sessionId ? db.validateSession(sessionId) : null;
      if (!userId) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      const { newPassword } = request.body;
      if (!newPassword || newPassword.length < 6) {
        return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      }
      db.changePassword(userId, newPassword);
      return { success: true, message: '密码修改成功' };
    },

    '/runninghub': async (request: Request) => {
      if (!requireSession(request)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      const body = request.body || {};
      const data = db.saveRunningHubConfig({
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
        walletApiKey: typeof body.walletApiKey === 'string' ? body.walletApiKey : undefined,
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
        defaultModel: typeof body.defaultModel === 'string' ? body.defaultModel : undefined,
        rhApps: Array.isArray(body.rhApps) ? body.rhApps : undefined,
        rhWorkflows: Array.isArray(body.rhWorkflows) ? body.rhWorkflows : undefined,
        clearApiKey: Boolean(body.clearApiKey),
        clearWalletApiKey: Boolean(body.clearWalletApiKey),
      });
      return { success: true, message: 'RunningHub 配置已保存', data };
    },

    '/runninghub/import-catalog': async (request: Request) => {
      if (!requireSession(request)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      const catalog = loadDefaultRunningHubCatalog();
      if (!catalog.rhApps.length && !catalog.rhWorkflows.length) {
        return new Response({ error: '未找到默认目录文件 public/runninghub/default-catalog.json' }, { statusCode: 404 });
      }
      const current = db.getRunningHubConfig();
      const data = db.saveRunningHubConfig({
        rhApps: mergeRunningHubEntries(current.rhApps, catalog.rhApps),
        rhWorkflows: mergeRunningHubEntries(current.rhWorkflows, catalog.rhWorkflows),
      });
      return {
        success: true,
        message: `已导入默认目录（应用 ${catalog.rhApps.length} / 工作流 ${catalog.rhWorkflows.length}）`,
        data,
      };
    },

    '/runninghub/add-link': async (request: Request) => {
      if (!requireSession(request)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      const url = String(request.body?.url || '').trim();
      const parsed = parseRunningHubUrl(url);
      if (!parsed) {
        return new Response(
          { error: '请粘贴 RunningHub 的 AI 应用或工作流链接（/run/ai-app/... 或 /run/workflow/...）' },
          { statusCode: 400 }
        );
      }
      try {
        const entry = await analyzeAndBuildEntry(parsed.kind, parsed.id);
        if (!entry) {
          return new Response({ error: '无法解析条目' }, { statusCode: 400 });
        }
        const current = db.getRunningHubConfig();
        const data = db.saveRunningHubConfig(
          parsed.kind === 'app'
            ? { rhApps: mergeRunningHubEntries(current.rhApps, [entry]) }
            : { rhWorkflows: mergeRunningHubEntries(current.rhWorkflows, [entry]) }
        );
        const analysis = entry.analysis;
        return {
          success: true,
          message: `已添加并分析 ${parsed.kind === 'app' ? 'AI 应用' : '工作流'}：${entry.title}（字段 ${analysis?.fieldCount || 0}，图 ${analysis?.imageCount || 0}，提示词 ${analysis?.promptCount || 0}）`,
          kind: parsed.kind,
          entryId: entry.id,
          data,
        };
      } catch (e: any) {
        const msg = e?.errmsg || e?.message || '分析失败';
        const statusCode = e?.statusCode || (String(msg).includes('API Key') ? 400 : 502);
        return new Response({ error: msg }, { statusCode });
      }
    },

    '/runninghub/analyze': async (request: Request) => {
      if (!requireSession(request)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      const kind = String(request.body?.kind || '').trim() as 'app' | 'workflow';
      const id = String(request.body?.id || '').trim();
      if (kind !== 'app' && kind !== 'workflow') {
        return new Response({ error: 'kind 须为 app 或 workflow' }, { statusCode: 400 });
      }
      if (!id) {
        return new Response({ error: '缺少 id' }, { statusCode: 400 });
      }
      try {
        const entry = await analyzeAndBuildEntry(kind, id);
        if (!entry) {
          return new Response({ error: '无法解析条目' }, { statusCode: 400 });
        }
        const current = db.getRunningHubConfig();
        // 保留原启用状态
        const list = kind === 'app' ? current.rhApps : current.rhWorkflows;
        const prev = list.find((item) => item.id === id || (kind === 'app' ? item.appId : item.workflowId) === id);
        if (prev && prev.enabled === false) entry.enabled = false;
        const data = db.saveRunningHubConfig(
          kind === 'app'
            ? { rhApps: mergeRunningHubEntries(current.rhApps, [entry]) }
            : { rhWorkflows: mergeRunningHubEntries(current.rhWorkflows, [entry]) }
        );
        return {
          success: true,
          message: `已重新分析：字段 ${entry.analysis?.fieldCount || 0}，图 ${entry.analysis?.imageCount || 0}，提示词 ${entry.analysis?.promptCount || 0}`,
          kind,
          entryId: entry.id,
          data,
        };
      } catch (e: any) {
        const msg = e?.errmsg || e?.message || '分析失败';
        const statusCode = e?.statusCode || (String(msg).includes('API Key') ? 400 : 502);
        return new Response({ error: msg }, { statusCode });
      }
    },
  },

  delete: {
    '/logs': async (request: Request) => {
      if (!requireSession(request)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      db.clearLogs();
      return { success: true, message: '日志已清理' };
    }
  }
};
