import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { log } from "./log";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
});

export const db = drizzle(pool, { schema });

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
const runOnce = db.transaction.bind(db);
db.transaction = async (fn, config) => {
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
