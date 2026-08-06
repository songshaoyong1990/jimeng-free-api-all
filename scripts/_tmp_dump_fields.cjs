const Database = require("better-sqlite3");
const db = new Database("./data/jimeng.db", { readonly: true });
const wf = db.prepare("SELECT value FROM settings WHERE key = ?").get("runninghub.rhWorkflows");
if (!wf) {
  console.log("no workflows");
  process.exit(0);
}
const list = JSON.parse(wf.value);
const target = list.find((x) => String(x.id || x.workflowId || "").includes("2082205802806738945"));
if (!target) {
  console.log("target not found, count=", list.length);
  process.exit(0);
}
const fields = target.fields || [];
console.log(
  JSON.stringify(
    {
      fieldCount: fields.length,
      analyzedAt: target.analyzedAt,
      analysis: target.analysis,
      imageFields: fields
        .filter((f) => f.role === "image" || /image/i.test(f.fieldName || ""))
        .map((f) => `${f.nodeId}::${f.fieldName}`),
      nodeIds: [...new Set(fields.map((f) => f.nodeId))].sort((a, b) => Number(a) - Number(b)),
      fieldKeys: fields.map((f) => `${f.nodeId}::${f.fieldName}`),
    },
    null,
    2
  )
);
