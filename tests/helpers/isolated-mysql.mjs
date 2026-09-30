import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import ts from "typescript";

const root = new URL("../../", import.meta.url);
export const readSource = file => readFile(new URL(file, root), "utf8");
export const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

export async function loadTestModule(file, imports = {}) {
  let code = ts.transpileModule(await readSource(file), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace('import "server-only";', "");
  for (const [specifier, replacement] of Object.entries(imports)) {
    code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
  }
  assert.doesNotMatch(code, /from ["']@\//, `unstubbed dependency in ${file}`);
  const url = moduleUrl(code);
  return { exports: await import(url), url };
}

export async function isolatedMysqlConfig() {
  const socket = process.env.PID_AUDIT_MYSQL_SOCKET;
  if (socket) {
    assert.match(socket, /^\/private\/tmp\/pid-audit-mysql-[A-Za-z0-9]+\/mysql\.sock$/);
    assert.equal(await realpath(path.dirname(socket)), path.dirname(socket));
    assert.equal((await lstat(path.dirname(socket))).uid, process.getuid());
    assert.ok((await lstat(socket)).isSocket());
    // A private, socket-only test server. Never use the project's MYSQL_*.
    return { socketPath: socket, user: "root", connectTimeout: 5000 };
  }
  assert.equal(process.env.FEISHU_DELIVERY_MYSQL_TEST, "isolated-test-only",
    "Database tests require the disposable MySQL service (see deploy/smoke-test.sh), or PID_AUDIT_MYSQL_SOCKET. Production MYSQL_* settings are never used.");
  return { host: "delivery-test-mysql", user: "root", password: "isolated-ci-only", connectTimeout: 5000 };
}

/** Fresh real MySQL schema per test. Cleanup only drops the database we created. */
export async function createIsolatedDatabase(t) {
  const config = await isolatedMysqlConfig();
  const name = `audit_${randomUUID().replaceAll("-", "")}`;
  const admin = await mysql.createConnection(config);
  let pool;
  let created = false;
  globalThis.__isolatedMysqlPools ||= new Map();
  t.after(async () => {
    try {
      await pool?.end();
      if (created) await admin.query(`DROP DATABASE \`${name}\``);
    } finally {
      globalThis.__isolatedMysqlPools.delete(name);
      await admin.end();
    }
  });
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  created = true;
  pool = mysql.createPool({ ...config, database: name, multipleStatements: true, connectionLimit: 6 });
  const schema = await readSource("lib/db/schema.sql");
  const reapplySchema = () => pool.query(schema);
  await reapplySchema();
  globalThis.__isolatedMysqlPools.set(name, pool);
  const imports = {
    "@/lib/db/pool": moduleUrl(`export const getPool = async () => globalThis.__isolatedMysqlPools.get(${JSON.stringify(name)});`),
    "@/lib/types": (await loadTestModule("lib/types.ts")).url,
  };
  const database = await loadTestModule("lib/database.ts", imports);
  await database.exports.getDb();
  const load = (file, extra = {}) => loadTestModule(file, { "@/lib/database": database.url, ...extra });
  return {
    database: database.exports, databaseUrl: database.url, pool, load, reapplySchema,
    rows: async (sql, params = []) => (await pool.query(sql, params))[0],
    row: async (sql, params = []) => (await pool.query(sql, params))[0][0],
  };
}
