import "server-only";

import type { ResultSetHeader } from "mysql2/promise";

/** Anything that can run a parameterized query: the pool itself, or one connection held for a transaction. */
export type Queryable = { query(sql: string, params?: unknown[]): Promise<[unknown, unknown]> };

export async function queryRows<T extends Record<string, unknown> = Record<string, unknown>>(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const [result] = await db.query(sql, params);
  return result as T[];
}

export async function queryRow<T extends Record<string, unknown> = Record<string, unknown>>(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await queryRows<T>(db, sql, params))[0];
}

export async function execute(db: Queryable, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [result] = await db.query(sql, params);
  return result as ResultSetHeader;
}
