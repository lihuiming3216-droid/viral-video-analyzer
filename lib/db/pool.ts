import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";
import mysql, { type Pool } from "mysql2/promise";

type DbGlobal = typeof globalThis & {
  __viralPool?: Pool;
  __viralSchemaReady?: Promise<void>;
};
const dbGlobal = globalThis as DbGlobal;

function connectionConfig() {
  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "viral_video_analyzer",
  };
}

async function applySchemaOnce() {
  const schemaPath = path.join(process.cwd(), "lib", "db", "schema.sql");
  const sql = readFileSync(schemaPath, "utf8");
  const connection = await mysql.createConnection({ ...connectionConfig(), multipleStatements: true });
  try {
    await connection.query(sql);
  } finally {
    await connection.end();
  }
}

/** Lazily create (and schema-initialize) the shared MySQL pool, once per process. */
export async function getPool(): Promise<Pool> {
  if (!dbGlobal.__viralPool) {
    dbGlobal.__viralPool = mysql.createPool({
      ...connectionConfig(),
      waitForConnections: true,
      connectionLimit: 10,
    });
  }
  if (!dbGlobal.__viralSchemaReady) {
    dbGlobal.__viralSchemaReady = applySchemaOnce();
  }
  await dbGlobal.__viralSchemaReady;
  return dbGlobal.__viralPool;
}
