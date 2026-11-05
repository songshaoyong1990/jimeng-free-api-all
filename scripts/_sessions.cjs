const Database = require("better-sqlite3");
const db = new Database("e:/projecte/jimeng-free-api-all/data/jimeng.db", { readonly: true });
console.log(db.prepare("SELECT id, user_id, expires_at FROM sessions ORDER BY rowid DESC LIMIT 10").all());
console.log("now", new Date().toISOString());
