const Database = require("better-sqlite3");
const axios = require("axios");

async function main() {
  const db = new Database("./data/jimeng.db", { readonly: true });
  const apiKey =
    (db.prepare("SELECT value FROM settings WHERE key = ?").get("runninghub.apiKey") || {}).value ||
    (db.prepare("SELECT value FROM settings WHERE key = ?").get("runninghub.walletApiKey") || {}).value ||
    "";
  const baseUrl =
    (db.prepare("SELECT value FROM settings WHERE key = ?").get("runninghub.baseUrl") || {}).value ||
    "https://www.runninghub.ai";
  if (!apiKey) {
    console.log("no api key");
    process.exit(1);
  }
  const workflowId = "2082205802806738945";
  const url = `${String(baseUrl).replace(/\/$/, "")}/api/openapi/getJsonApiFormat`;
  const res = await axios.post(
    url,
    { apiKey, workflowId },
    { timeout: 60000, validateStatus: () => true }
  );
  const raw = res.data || {};
  const data = raw.data || {};
  let prompt = data.prompt;
  if (typeof prompt === "string") {
    try {
      prompt = JSON.parse(prompt);
    } catch {
      prompt = {};
    }
  }
  const nodeIds = Object.keys(prompt || {}).sort((a, b) => Number(a) - Number(b));
  const fields = [];
  for (const nodeId of nodeIds) {
    const inputs = (prompt[nodeId] && prompt[nodeId].inputs) || {};
    const classType = prompt[nodeId] && prompt[nodeId].class_type;
    for (const [fieldName, rawValue] of Object.entries(inputs)) {
      const isLink = Array.isArray(rawValue) && rawValue.length === 2 && typeof rawValue[0] === "string";
      if (isLink) continue;
      fields.push({ nodeId, fieldName, classType, valueType: typeof rawValue });
    }
  }
  console.log(
    JSON.stringify(
      {
        httpStatus: res.status,
        code: raw.code,
        msg: raw.msg,
        dataKeys: Object.keys(data),
        nodeCount: nodeIds.length,
        nodeIds,
        fieldCount: fields.length,
        imageLike: fields.filter((f) => /image|img|mask/i.test(f.fieldName)).map((f) => `${f.nodeId}::${f.fieldName}(${f.classType})`),
        loadImageNodes: nodeIds
          .filter((id) => /LoadImage|Image/i.test(String((prompt[id] || {}).class_type || "")))
          .map((id) => ({ id, class_type: prompt[id].class_type, inputs: Object.keys(prompt[id].inputs || {}) })),
        fieldKeys: fields.map((f) => `${f.nodeId}::${f.fieldName}`),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
