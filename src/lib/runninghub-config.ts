import fs from "fs-extra";
import path from "path";
import { slimOpenAIMapping, type RunningHubOpenAIMapping } from "@/lib/openai-images-compat.ts";

export const RUNNINGHUB_DEFAULT_BASE_URL = "https://www.runninghub.cn";
export type { RunningHubOpenAIMapping };

export type RunningHubFieldSummary = {
  nodeId: string;
  fieldName: string;
  fieldType?: string;
  label?: string;
  fieldValue?: string;
  required?: boolean;
  enabled?: boolean;
  random_enabled?: boolean;
  role?: string;
  min?: string;
  max?: string;
  step?: string;
  options?: string[];
};

export type RunningHubEntry = {
  id: string;
  title: string;
  enabled?: boolean;
  appId?: string;
  workflowId?: string;
  note?: string;
  thumbnail?: string;
  fields?: RunningHubFieldSummary[];
  /** 节点参数编辑结果，key = nodeId::fieldName */
  rhParams?: Record<string, string>;
  /** 随机开关，key = nodeId::fieldName */
  rhRandom?: Record<string, boolean>;
  /** OpenAI 字段 → 节点字段映射 */
  openaiMapping?: RunningHubOpenAIMapping;
  instanceType?: string;
  payment?: string;
  /** 开启后返回的图片结果由服务端解码为 data URL 返回 */
  decode?: boolean;
  analysis?: {
    fieldCount: number;
    imageCount: number;
    promptCount: number;
    requiredCount: number;
  };
  analyzedAt?: string;
};

export type RunningHubStoredConfig = {
  apiKey: string;
  walletApiKey: string;
  baseUrl: string;
  defaultModel: string;
  rhApps: RunningHubEntry[];
  rhWorkflows: RunningHubEntry[];
};

export function encodeRunningHubModel(kind: "app" | "workflow", id: string) {
  return `${kind}:${String(id || "").trim()}`;
}

export function parseRunningHubModel(model: string): { kind: "app" | "workflow"; id: string } | null {
  const value = String(model || "").trim().replace(/^runninghub:/i, "");
  const match = /^(app|workflow):(.+)$/i.exec(value);
  if (!match) return null;
  const id = match[2].trim();
  if (!id) return null;
  return { kind: match[1].toLowerCase() as "app" | "workflow", id };
}

export function parseRunningHubUrl(input: string): { kind: "app" | "workflow"; id: string } | null {
  const value = String(input || "").trim();
  const appMatch = /\/run\/ai-app\/(\d+)/i.exec(value);
  if (appMatch) return { kind: "app", id: appMatch[1] };
  const workflowMatch = /\/run\/workflow\/(\d+)/i.exec(value);
  if (workflowMatch) return { kind: "workflow", id: workflowMatch[1] };
  const bare = /^(\d{8,})$/.exec(value);
  if (bare) return { kind: "app", id: bare[1] };
  return null;
}

function slimField(field: any): RunningHubFieldSummary | null {
  const nodeId = String(field?.nodeId || "").trim();
  const fieldName = String(field?.fieldName || "").trim();
  if (!nodeId || !fieldName) return null;
  const options = Array.isArray(field?.options)
    ? field.options.map((item: any) => String(item)).filter(Boolean)
    : undefined;
  return {
    nodeId,
    fieldName,
    fieldType: field?.fieldType ? String(field.fieldType) : undefined,
    label: field?.label ? String(field.label) : undefined,
    fieldValue: field?.fieldValue != null ? String(field.fieldValue) : undefined,
    required: field?.required === true,
    enabled: field?.enabled !== false,
    random_enabled: field?.random_enabled === true,
    role: field?.role ? String(field.role) : undefined,
    min: field?.min != null ? String(field.min) : undefined,
    max: field?.max != null ? String(field.max) : undefined,
    step: field?.step != null ? String(field.step) : undefined,
    options: options?.length ? options : undefined,
  };
}

function slimStringMap(input: any): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") out[key] = value;
    else if (value != null) out[key] = String(value);
  }
  return Object.keys(out).length ? out : undefined;
}

function slimBoolMap(input: any): Record<string, boolean> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function slimRunningHubEntry(entry: any, kind: "app" | "workflow"): RunningHubEntry | null {
  const id = String(entry?.id || (kind === "app" ? entry?.appId : entry?.workflowId) || "").trim();
  if (!id) return null;
  const fields = Array.isArray(entry?.fields)
    ? entry.fields.map(slimField).filter(Boolean) as RunningHubFieldSummary[]
    : undefined;
  const analysis = entry?.analysis && typeof entry.analysis === "object"
    ? {
        fieldCount: Number(entry.analysis.fieldCount) || fields?.length || 0,
        imageCount: Number(entry.analysis.imageCount) || 0,
        promptCount: Number(entry.analysis.promptCount) || 0,
        requiredCount: Number(entry.analysis.requiredCount) || 0,
      }
    : fields
      ? {
          fieldCount: fields.length,
          imageCount: fields.filter((item) => item.role === "image").length,
          promptCount: fields.filter((item) => item.role === "prompt").length,
          requiredCount: fields.filter((item) => item.required).length,
        }
      : undefined;
  return {
    id,
    title: String(entry?.title || (kind === "app" ? `AI 应用 ${id.slice(-6)}` : `工作流 ${id.slice(-6)}`)),
    enabled: entry?.enabled !== false,
    note: entry?.note ? String(entry.note) : undefined,
    thumbnail: entry?.thumbnail ? String(entry.thumbnail) : undefined,
    fields,
    rhParams: slimStringMap(entry?.rhParams),
    rhRandom: slimBoolMap(entry?.rhRandom),
    openaiMapping: slimOpenAIMapping(entry?.openaiMapping),
    instanceType: entry?.instanceType != null ? String(entry.instanceType) : undefined,
    payment: entry?.payment != null ? String(entry.payment) : undefined,
    decode: entry?.decode === true ? true : undefined,
    analysis,
    analyzedAt: entry?.analyzedAt ? String(entry.analyzedAt) : undefined,
    ...(kind === "app" ? { appId: String(entry?.appId || id) } : { workflowId: String(entry?.workflowId || id) }),
  };
}

export function normalizeRunningHubEntries(entries: any[] | undefined, kind: "app" | "workflow"): RunningHubEntry[] {
  if (!Array.isArray(entries)) return [];
  const out: RunningHubEntry[] = [];
  for (const entry of entries) {
    const slim = slimRunningHubEntry(entry, kind);
    if (slim) out.push(slim);
  }
  return out;
}

export function mergeRunningHubEntries(current: RunningHubEntry[], incoming: RunningHubEntry[]): RunningHubEntry[] {
  const map = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    const prev = map.get(entry.id);
    map.set(entry.id, {
      ...prev,
      ...entry,
      enabled: entry.enabled !== false,
      title: entry.title || prev?.title || entry.id,
      fields: (entry.fields || []).length ? entry.fields : prev?.fields,
      rhParams: entry.rhParams || prev?.rhParams,
      rhRandom: entry.rhRandom || prev?.rhRandom,
      openaiMapping: entry.openaiMapping || prev?.openaiMapping,
      instanceType: entry.instanceType ?? prev?.instanceType,
      payment: entry.payment ?? prev?.payment,
      decode: entry.decode ?? prev?.decode,
      analysis: entry.analysis || prev?.analysis,
      analyzedAt: entry.analyzedAt || prev?.analyzedAt,
    });
  }
  return Array.from(map.values());
}

export function runningHubModelOptions(config: Pick<RunningHubStoredConfig, "rhApps" | "rhWorkflows">) {
  const apps = (config.rhApps || []).filter((entry) => entry.enabled !== false);
  const workflows = (config.rhWorkflows || []).filter((entry) => entry.enabled !== false);
  return [
    ...apps.map((entry) => encodeRunningHubModel("app", entry.appId || entry.id)),
    ...workflows.map((entry) => encodeRunningHubModel("workflow", entry.workflowId || entry.id)),
  ];
}

export function resolveRunningHubEntry(
  config: Pick<RunningHubStoredConfig, "rhApps" | "rhWorkflows">,
  model: string
): (RunningHubEntry & { kind: "app" | "workflow" }) | null {
  const parsed = parseRunningHubModel(model);
  if (!parsed) return null;
  const list = parsed.kind === "app" ? config.rhApps || [] : config.rhWorkflows || [];
  const entry = list.find((item) =>
    (parsed.kind === "app" ? item.appId || item.id : item.workflowId || item.id) === parsed.id
  );
  return entry ? { ...entry, kind: parsed.kind } : null;
}

export function isRunningHubModelEnabled(
  config: Pick<RunningHubStoredConfig, "rhApps" | "rhWorkflows">,
  model: string
) {
  const entry = resolveRunningHubEntry(config, model);
  if (!entry) {
    const parsed = parseRunningHubModel(model);
    if (!parsed) return false;
    const list = parsed.kind === "app" ? config.rhApps || [] : config.rhWorkflows || [];
    if (!list.length) return true;
    const known = list.some((item) =>
      (parsed.kind === "app" ? item.appId || item.id : item.workflowId || item.id) === parsed.id
    );
    return !known;
  }
  return entry.enabled !== false;
}

export function loadDefaultRunningHubCatalog(): { rhApps: RunningHubEntry[]; rhWorkflows: RunningHubEntry[] } {
  const candidates = [
    path.join(process.cwd(), "public", "runninghub", "default-catalog.json"),
    path.join(process.cwd(), "dist", "runninghub", "default-catalog.json"),
    path.join(path.dirname(process.argv[1] || ""), "runninghub", "default-catalog.json"),
  ];
  for (const filePath of candidates) {
    if (!fs.pathExistsSync(filePath)) continue;
    const raw = fs.readJsonSync(filePath);
    const provider = Array.isArray(raw) ? raw[0] : raw;
    return {
      rhApps: normalizeRunningHubEntries(provider?.rh_apps || provider?.rhApps || [], "app"),
      rhWorkflows: normalizeRunningHubEntries(provider?.rh_workflows || provider?.rhWorkflows || [], "workflow"),
    };
  }
  return { rhApps: [], rhWorkflows: [] };
}

export function isWalletPayment(payment: unknown, useWallet: unknown) {
  if (useWallet === true || useWallet === "true" || useWallet === 1 || useWallet === "1") return true;
  const value = String(payment || "").trim().toLowerCase();
  return value === "wallet" || value === "balance";
}
