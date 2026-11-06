export const MUSE2API_DEFAULT_BASE_URL = "http://127.0.0.1:18610";
/** 管理台 / API 里识别 muse2api Key 的前缀 */
export const MUSE2API_KEY_PREFIX = "m2a_";

export type Muse2APIModelType = "image" | "video" | "chat";

export type Muse2APIModelDef = {
  /** 对外模型名（写入 /v1/models，请求时也用它） */
  id: string;
  /** 上游 muse2api 的模型名 */
  upstream: string;
  type: Muse2APIModelType;
  name: string;
  description: string;
};

export const MUSE2API_MODELS: Muse2APIModelDef[] = [
  {
    id: "muse:image",
    upstream: "muse-image",
    type: "image",
    name: "Muse Image",
    description: "muse2api 文生图 / 参考图生图（网页免费额度）",
  },
  {
    id: "muse:video",
    upstream: "muse-video",
    type: "video",
    name: "Muse Video",
    description: "muse2api 文生视频 / 首帧图生视频（网页免费额度）",
  },
  {
    id: "muse:spark",
    upstream: "muse-spark",
    type: "chat",
    name: "Muse Spark",
    description: "muse2api 文本 / 代码对话（支持流式）",
  },
];

export type Muse2APIStoredConfig = {
  baseUrl: string;
  apiKey: string;
  /** 对外模型名，如 muse:image；空表示请求必须显式传 model */
  defaultModel: string;
  /** 对外模型名 → 是否启用 */
  models: Record<string, boolean>;
};

export type Muse2APIModelState = Muse2APIModelDef & { enabled: boolean };

const CANONICAL_BY_NAME: Record<string, string> = {
  // 前缀 / 简写
  "muse:image": "muse:image",
  "muse:img": "muse:image",
  "muse:image-generation": "muse:image",
  "muse:video": "muse:video",
  "muse:vid": "muse:video",
  "muse:videos": "muse:video",
  "muse:spark": "muse:spark",
  "muse:text": "muse:spark",
  "muse:chat": "muse:spark",
  // 上游原名（方便直接照抄 muse2api 文档）
  "muse-image": "muse:image",
  "muse-img": "muse:image",
  "muse-video": "muse:video",
  "muse-vid": "muse:video",
  "muse-videos": "muse:video",
  "muse-spark": "muse:spark",
  "muse-text": "muse:spark",
};

/** 归一化 Base URL：去空白、去尾斜杠、去掉误填的 /v1 */
export function normalizeMuse2APIBaseUrl(input?: string) {
  const raw = String(input || "").trim();
  if (!raw) return MUSE2API_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "").replace(/\/v1$/i, "") || MUSE2API_DEFAULT_BASE_URL;
}

/** 把 "muse:image" / "muse-image" / "muse2api:video" 等统一成对外模型名 */
export function canonicalMuse2APIModelId(model: string): string | null {
  const raw = String(model || "").trim().toLowerCase();
  if (!raw) return null;
  const stripped = raw.replace(/^muse2api:/, "");
  if (CANONICAL_BY_NAME[stripped]) return CANONICAL_BY_NAME[stripped];
  const withPrefix = stripped.startsWith("muse:") ? stripped : `muse:${stripped}`;
  return CANONICAL_BY_NAME[withPrefix] || null;
}

export function parseMuse2APIModel(model: string): Muse2APIModelDef | null {
  const id = canonicalMuse2APIModelId(model);
  if (!id) return null;
  return MUSE2API_MODELS.find((item) => item.id === id) || null;
}

export function isMuse2APIModel(model: string) {
  return parseMuse2APIModel(model) !== null;
}

export function isMuse2APIChatModel(model: string) {
  return parseMuse2APIModel(model)?.type === "chat";
}

/** 已启用的对外模型名列表 */
export function muse2apiModelOptions(config: Pick<Muse2APIStoredConfig, "models">) {
  return MUSE2API_MODELS.filter((model) => config.models?.[model.id] !== false).map((model) => model.id);
}

/** 模型是否可用（未登记过的默认放行，便于上游新增） */
export function isMuse2APIModelEnabled(
  config: Pick<Muse2APIStoredConfig, "models">,
  model: string
) {
  const parsed = parseMuse2APIModel(model);
  if (!parsed) return false;
  return config.models?.[parsed.id] !== false;
}

export function muse2apiModelStates(
  config: Pick<Muse2APIStoredConfig, "models">
): Muse2APIModelState[] {
  return MUSE2API_MODELS.map((model) => ({
    ...model,
    enabled: config.models?.[model.id] !== false,
  }));
}

/** 是否像 muse2api 的管理密钥（用于判断请求头里的 Key 是不是给 muse 的） */
export function looksLikeMuse2APIKey(value?: string) {
  return String(value || "").trim().startsWith(MUSE2API_KEY_PREFIX);
}
