const Database = require("better-sqlite3");
const db = new Database("e:/projecte/jimeng-free-api-all/data/jimeng.db", { readonly: true });
console.log("levels", db.prepare("SELECT level, COUNT(*) c FROM logs GROUP BY level").all());
console.log(
  "filtered",
  db
    .prepare(
      "SELECT id, level, message, created_at FROM logs WHERE message LIKE ? OR message LIKE ? OR level = ? ORDER BY id DESC LIMIT 30"
    )
    .all("%comfy%", "%dashboard%", "ERROR")
);
console.log("users", db.prepare("SELECT id, username FROM users").all());
