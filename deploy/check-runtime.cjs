// Readiness probe: never imports application modules (which initialize schema).
const mysql = require("mysql2/promise");
const deadline = setTimeout(() => {
  console.error("Application/database readiness check timed out");
  process.exit(1);
}, 20000);
deadline.unref();

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    connectTimeout: 5000,
  });
  try {
    for (const sql of ["START TRANSACTION READ ONLY", "SELECT 1 FROM products LIMIT 1", "SELECT 1 FROM videos LIMIT 1", "ROLLBACK"]) {
      await connection.query({ sql, timeout: 5000 });
    }
  } finally {
    await connection.end();
  }
  const response = await fetch("http://127.0.0.1:3000/api/health", {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || (await response.json()).ok !== true) throw new Error("Health check failed");
  console.log("Application and database are ready");
}

main().catch(() => {
  // Driver errors can contain connection details. Do not emit the raw error.
  console.error("Application/database readiness check failed");
  process.exitCode = 1;
}).finally(() => clearTimeout(deadline));
