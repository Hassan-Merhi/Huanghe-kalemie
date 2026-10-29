import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { log } from "./log";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const connectionOptions = {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
};

// Session storage and the original Kalemie company stay on the existing public pool.
export const pool = new pg.Pool(connectionOptions);
const scope = new AsyncLocalStorage<number>();
const tenantDbs = new Map<number, NodePgDatabase<typeof schema>>();
const tenantPools = new Map<number, pg.Pool>();

/** Only the authenticated session selects a company; callers cannot supply a tenant header. */
export function runInCompany<T>(companyId: number, fn: () => T): T {
  if (!Number.isSafeInteger(companyId) || companyId < 1) throw new Error("Invalid company");
  return scope.run(companyId, fn);
}

export function currentCompanyId() { return scope.getStore() ?? 1; }

function dbForCompany(companyId: number): NodePgDatabase<typeof schema> {
  if (companyId === 1) return primaryDb;
  let tenant = tenantDbs.get(companyId);
  if (tenant) return tenant;
  const tenantPool = new pg.Pool({ ...connectionOptions, max: 3, options: `-c search_path=company_${companyId}` });
  tenantPool.on("error", (e) => log("company database pool error", { companyId, error: String(e) }));
  tenant = drizzle(tenantPool, { schema });
  protectTransactions(tenant);
  tenantPools.set(companyId, tenantPool);
  tenantDbs.set(companyId, tenant);
  return tenant;
}

/** For provisioning and migrations: does not affect other requests' company context. */
export function isolatedDb(companyId: number): Db { return dbForCompany(companyId); }

export function forgetCompany(companyId: number) {
  const tenantPool = tenantPools.get(companyId);
  tenantDbs.delete(companyId);
  tenantPools.delete(companyId);
  if (tenantPool) void tenantPool.end().catch((e) => log("company pool close failed", { companyId, error: String(e) }));
}

const primaryDb = drizzle(pool, { schema });
protectTransactions(primaryDb);

/** All existing services can keep using `db` without accidentally querying another company. */
export const db = new Proxy(primaryDb, {
  get(_target, key) {
    const target = dbForCompany(currentCompanyId());
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as NodePgDatabase<typeof schema>;

/** A deadlock or a serialization failure: Postgres rolled the whole transaction back, so it can run again. */
const RETRYABLE = new Set(["40P01", "40001"]);
export const TRANSACTION_RETRIES = 3;
/** How many transactions were run again since the server started (the activity of the safety net). */
export const transactionRetries = { count: 0 };
const pgCode = (e: unknown) => (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;

/*
 * Every transaction is run again (up to three times, after a short random wait) when Postgres picks it
 * to break a deadlock or a serialization conflict, instead of answering 500. A retry is safe: the
 * callbacks only write to the database, which kept nothing of the failed try, and the Idempotency-Key
 * middleware records the response once, after the retries.
 */
function protectTransactions(target: NodePgDatabase<typeof schema>) {
  const runOnce = target.transaction.bind(target);
  target.transaction = async (fn, config) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await runOnce(async (tx) => {
          const result = await fn(tx);
          await runAtEnd(tx);
          return result;
        }, config);
      } catch (e) {
        const code = pgCode(e);
        if (attempt >= TRANSACTION_RETRIES || !code || !RETRYABLE.has(code)) throw e;
        transactionRetries.count++;
        log(`transaction retried after ${code}`, { attempt: attempt + 1 });
        await new Promise((r) => setTimeout(r, (10 + Math.random() * 40) * (attempt + 1)));
      }
    }
  };
}

/** Work a transaction does once everything else it was asked to do is written (see atTransactionEnd). */
const atEnd = new WeakMap<object, (() => Promise<void>)[]>();

/**
 * Run `fn` at the end of the transaction `tx`, after the rest of its work and before it commits (what a
 * posting dated before others leaves to restate, see postJournal). Outside a transaction it runs at once.
 */
export async function atTransactionEnd(tx: object, fn: () => Promise<void>): Promise<void> {
  if (typeof (tx as { rollback?: unknown }).rollback !== "function") return fn();
  const list = atEnd.get(tx);
  if (list) list.push(fn);
  else atEnd.set(tx, [fn]);
}

async function runAtEnd(tx: object) {
  for (let fn = atEnd.get(tx)?.shift(); fn; fn = atEnd.get(tx)?.shift()) await fn();
}

export type Db = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;
