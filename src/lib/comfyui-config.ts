import { slimOpenAIMapping, type RunningHubOpenAIMapping } from "@/lib/openai-images-compat.ts";

export const COMFYUI_DEFAULT_BASE_URL = "http://127.0.0.1:8188";

export type ComfyUIFieldSummary = {
  nodeId: string;
  fieldName: string;
  fieldType?: string;
  label?: string;
  fieldValue?: string;
  role?: string;
  classType?: string;
};

export type ComfyUIEntry = {
  id: string;
  title: string;
  enabled?: boolean;
  note?: string;
  /** ComfyUI API 格式工作流（节点图） */
  workflowApi?: Record<string, any>;
  fields?: ComfyUIFieldSummary[];
  /** key = nodeId::fieldName */
  comfyParams?: Record<string, string>;
  openaiMapping?: RunningHubOpenAIMapping;
  /** 开启后返回的图片结果由服务端解码为 data URL 返回 */
  decode?: boolean;
  analysis?: {
    fieldCount: number;
    imageCount: number;
    promptCount: number;
    videoCount?: number;
    audioCount?: number;
    nodeCount: number;
    requiredCount?: number;
  };
  analyzedAt?: string;
};

export type ComfyUIStoredConfig = {
  baseUrl: string;
  defaultModel: string;
  workflows: ComfyUIEntry[];
};

export function encodeComfyUIModel(id: string) {
  return `comfy:${String(id || "").trim()}`;
}

export function parseComfyUIModel(model: string): { id: string } | null {
  const value = String(model || "")
    .trim()
    .replace(/^comfyui:/i, "")
    .replace(/^local-comfy:/i, "");
  const match = /^comfy:(.+)$/i.exec(value);
  if (!match) return null;
  const id = match[1].trim();
  return id ? { id } : null;
}

export function isComfyUIModel(model: string) {
  return parseComfyUIModel(model) !== null;
}

function slimStringMap(input: any): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") out[key] = value;
    else if (value != null && typeof value !== "object") out[key] = String(value);
  }
  return Object.keys(out).length ? out : undefined;
}

function slimField(field: any): ComfyUIFieldSummary | null {
  const nodeId = String(field?.nodeId || "").trim();
  const fieldName = String(field?.fieldName || "").trim();
  if (!nodeId || !fieldName) return null;
  return {
    nodeId,
    fieldName,
    fieldType: field?.fieldType ? String(field.fieldType) : undefined,
    label: field?.label ? String(field.label) : undefined,
    fieldValue: field?.fieldValue != null ? String(field.fieldValue) : undefined,
    role: field?.role ? String(field.role) : undefined,
    classType: field?.classType ? String(field.classType) : undefined,
  };
}

function slimWorkflowApi(input: any): Record<string, any> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  // 接受 ComfyUI API 图（键为节点 id）
  const keys = Object.keys(input);
  if (!keys.length) return undefined;
  const sample = input[keys[0]];
  if (!sample || typeof sample !== "object" || !("class_type" in sample || "inputs" in sample)) {
    return undefined;
  }
  return input as Record<string, any>;
}

export function slimComfyUIEntry(entry: any): ComfyUIEntry | null {
  const id = String(entry?.id || "").trim();
  if (!id) return null;
  const fields = Array.isArray(entry?.fields)
    ? (entry.fields.map(slimField).filter(Boolean) as ComfyUIFieldSummary[])
    : undefined;
  const workflowApi = slimWorkflowApi(entry?.workflowApi);
  const analysis =
    entry?.analysis && typeof entry.analysis === "object"
      ? {
          fieldCount: Number(entry.analysis.fieldCount) || fields?.length || 0,
          imageCount: Number(entry.analysis.imageCount) || 0,
          promptCount: Number(entry.analysis.promptCount) || 0,
          videoCount: Number(entry.analysis.videoCount) || 0,
          audioCount: Number(entry.analysis.audioCount) || 0,
          nodeCount: Number(entry.analysis.nodeCount) || (workflowApi ? Object.keys(workflowApi).length : 0),
        }
      : fields
        ? {
            fieldCount: fields.length,
            imageCount: fields.filter((item) => item.role === "image").length,
            promptCount: fields.filter((item) => item.role === "prompt").length,
            videoCount: fields.filter((item) => item.role === "video").length,
            audioCount: fields.filter((item) => item.role === "audio").length,
            nodeCount: workflowApi ? Object.keys(workflowApi).length : 0,
          }
        : undefined;
  return {
    id,
    title: String(entry?.title || `ComfyUI ${id}`),
    enabled: entry?.enabled !== false,
    note: entry?.note ? String(entry.note) : undefined,
    workflowApi,
    fields,
    comfyParams: slimStringMap(entry?.comfyParams),
    openaiMapping: slimOpenAIMapping(entry?.openaiMapping),
    decode: entry?.decode === true ? true : undefined,
    analysis,
    analyzedAt: entry?.analyzedAt ? String(entry.analyzedAt) : undefined,
  };
}

export function normalizeComfyUIEntries(entries: any[] | undefined): ComfyUIEntry[] {
  if (!Array.isArray(entries)) return [];
  const out: ComfyUIEntry[] = [];
  for (const entry of entries) {
    const slim = slimComfyUIEntry(entry);
    if (slim) out.push(slim);
  }
  return out;
}

export function mergeComfyUIEntries(current: ComfyUIEntry[], incoming: ComfyUIEntry[]): ComfyUIEntry[] {
  const map = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    const prev = map.get(entry.id);
    map.set(entry.id, {
      ...prev,
      ...entry,
      enabled: entry.enabled !== false,
      title: entry.title || prev?.title || entry.id,
      workflowApi: entry.workflowApi || prev?.workflowApi,
      fields: (entry.fields || []).length ? entry.fields : prev?.fields,
      comfyParams: entry.comfyParams || prev?.comfyParams,
      openaiMapping: entry.openaiMapping || prev?.openaiMapping,
      decode: entry.decode ?? prev?.decode,
      analysis: entry.analysis || prev?.analysis,
      analyzedAt: entry.analyzedAt || prev?.analyzedAt,
    });
  }
  return Array.from(map.values());
}

export function comfyUIModelOptions(config: Pick<ComfyUIStoredConfig, "workflows">) {
  return (config.workflows || [])
    .filter((entry) => entry.enabled !== false)
    .map((entry) => encodeComfyUIModel(entry.id));
}

export function resolveComfyUIEntry(
  config: Pick<ComfyUIStoredConfig, "workflows">,
  model: string
): ComfyUIEntry | null {
  const parsed = parseComfyUIModel(model);
  if (!parsed) return null;
  return (config.workflows || []).find((item) => item.id === parsed.id) || null;
}

export function isComfyUIModelEnabled(
  config: Pick<ComfyUIStoredConfig, "workflows">,
  model: string
) {
  const entry = resolveComfyUIEntry(config, model);
  if (!entry) {
    const parsed = parseComfyUIModel(model);
    if (!parsed) return false;
    const list = config.workflows || [];
    if (!list.length) return true;
    return !list.some((item) => item.id === parsed.id);
  }
  return entry.enabled !== false;
}

export function fieldKey(nodeId: string, fieldName: string) {
  return `${nodeId}::${fieldName}`;
}
