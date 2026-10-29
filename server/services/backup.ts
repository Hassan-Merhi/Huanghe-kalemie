import { createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync, gzipSync } from "zlib";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { backups, type BACKUP_KINDS } from "@shared/schema";
import { currentCompanyId, db, pool, runInCompany, type Tx } from "../db";
import { AppError } from "../errors";
import { todayIso } from "../http";
import { log } from "../log";
import { markSystemLines } from "./ledger";

/*
 * Full backups: every table in one consistent snapshot, users included (with their password hashes,
 * so a restored shop signs in as before). A restore rebuilds the tables from the file in one
 * transaction and checks that row counts and money totals came back exactly; otherwise nothing changes.
 */

export const BACKUP_FORMAT = 2;
/** Sign-in sessions, request keys and the snapshots themselves are not business data. */
const SKIP = ["user_sessions", "idempotency_keys", "backups", "companies"];
const KEEP_DAILY = 7;
const KEEP_BEFORE_RESTORE = 3;

export interface Totals {
  rows: Record<string, number>;
  debit: string;
  credit: string;
  stockValue: string;
  stockQty: string;
}

export interface BackupFile {
  format: number;
  exportedAt: string;
  migrations: number;
  totals: Totals;
  tables: Record<string, Record<string, unknown>[]>;
}

interface Column { name: string; type: string }

async function tables(tx: Tx): Promise<string[]> {
  const r = await tx.execute<{ table_name: string }>(sql`
    select table_name from information_schema.tables
    where table_schema = current_schema() and table_type = 'BASE TABLE'
    order by table_name
  `);
  return r.rows.map((x) => x.table_name).filter((t) => !SKIP.includes(t));
}

/** Tables ordered so each comes after the tables it points to. */
async function insertOrder(tx: Tx, names: string[]): Promise<string[]> {
  const fks = await tx.execute<{ child: string; parent: string }>(sql`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
    from pg_constraint c where c.contype = 'f' and c.connamespace = current_schema()::regnamespace
  `);
  const deps = new Map(names.map((n) => [n, new Set<string>()]));
  for (const { child, parent } of fks.rows) if (child !== parent && deps.has(child) && deps.has(parent)) deps.get(child)!.add(parent);
  const done: string[] = [];
  while (done.length < names.length) {
    const next = names.find((n) => !done.includes(n) && [...deps.get(n)!].every((p) => done.includes(p)));
    if (!next) throw new Error("Tables refer to each other in a loop");
    done.push(next);
  }
  return done;
}

async function columns(tx: Tx, table: string): Promise<Column[]> {
  const r = await tx.execute<{ column_name: string; data_type: string }>(sql`
    select column_name, data_type from information_schema.columns
    where table_schema = current_schema() and table_name = ${table} order by ordinal_position
  `);
  return r.rows.map((c) => ({ name: c.column_name, type: c.data_type }));
}

export async function totalsOf(tx: Tx, names?: string[]): Promise<Totals> {
  const rows: Record<string, number> = {};
  for (const t of names ?? (await tables(tx))) {
    const r = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(t)}`);
    rows[t] = r.rows[0].n;
  }
  const [m] = (await tx.execute<{ debit: string; credit: string }>(sql`
    select coalesce(sum(debit), 0)::numeric(18,2)::text as debit, coalesce(sum(credit), 0)::numeric(18,2)::text as credit from journal_lines
  `)).rows;
  const [s] = (await tx.execute<{ value: string; qty: string }>(sql`
    select coalesce(sum(stock_value), 0)::numeric(18,2)::text as value, coalesce(sum(stock_qty), 0)::numeric(18,3)::text as qty from variants
  `)).rows;
  return { rows, debit: m.debit, credit: m.credit, stockValue: s.value, stockQty: s.qty };
}

/** The whole shop as JSON text. Run inside a repeatable-read transaction so every table is from the same moment. */
export async function snapshot(tx: Tx): Promise<string> {
  const names = await tables(tx);
  const parts: string[] = [];
  for (const t of names) {
    const cols = await columns(tx, t);
    // Numbers travel as text so no digit is lost on the way.
    const select = sql.join(
      cols.map((c) => (c.type === "numeric" ? sql`${sql.identifier(c.name)}::text as ${sql.identifier(c.name)}` : sql.identifier(c.name))),
      sql`, `,
    );
    const order = cols.some((c) => c.name === "id") ? sql`order by id` : sql``;
    const r = await tx.execute<{ data: string }>(sql`
      select coalesce(json_agg(row_to_json(x)), '[]')::text as data from (select ${select} from ${sql.identifier(t)} ${order}) x
    `);
    parts.push(`${JSON.stringify(t)}:${r.rows[0].data}`);
  }
  const historySchema = currentCompanyId() === 1 ? "drizzle" : `company_${currentCompanyId()}`;
  const [mig] = (await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(historySchema)}.__drizzle_migrations`
  )).rows;
  const totals = await totalsOf(tx, names);
  return sign(`{"format":${BACKUP_FORMAT},"exportedAt":${JSON.stringify(new Date().toISOString())},"migrations":${mig.n},"totals":${JSON.stringify(totals)},"tables":{${parts.join(",")}}}`);
}

/*
 * A backup carries a seal made with this server's secret, so a file edited by hand (capital moved
 * from one partner to the other, say) is noticed before it replaces the books.
 */
const SEAL = ',"signature":"';
function sealKey(): string {
  return process.env.BACKUP_KEY || process.env.SESSION_SECRET || "huanghe-kalemie-dev";
}
function seal(body: string): string {
  return createHmac("sha256", sealKey()).update(body).digest("hex");
}
function sign(body: string): string {
  return `${body.slice(0, -1)}${SEAL}${seal(body)}"}`;
}
/** True when the text carries a seal from this server and nothing changed since. */
export function verifySeal(text: string): boolean {
  const at = text.lastIndexOf(SEAL);
  if (at < 0) return false;
  const given = text.slice(at + SEAL.length, -2);
  const expected = seal(`${text.slice(0, at)}}`);
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function takeSnapshot(): Promise<string> {
  return db.transaction((tx) => snapshot(tx), { isolationLevel: "repeatable read", accessMode: "read only" });
}

const bad = (en: string, fr: string) => new AppError(400, en, "BAD_BACKUP", fr);

/** Reads a backup file (plain or gzipped) and checks it looks like one of ours. */
export function parseBackup(raw: Buffer | string): BackupFile & { sealed: boolean } {
  let text: string;
  try {
    const buf = typeof raw === "string" ? Buffer.from(raw) : raw;
    text = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString("utf8");
  } catch {
    throw bad("This file could not be read", "Ce fichier ne peut pas être lu");
  }
  let file: BackupFile;
  try {
    file = JSON.parse(text);
  } catch {
    throw bad("This is not a backup file", "Ce n'est pas un fichier de sauvegarde");
  }
  if (!file || typeof file !== "object" || !file.tables || typeof file.tables !== "object") throw bad("This is not a backup file", "Ce n'est pas un fichier de sauvegarde");
  if (file.format !== BACKUP_FORMAT || !file.totals) {
    throw bad(
      "This backup is from an older version without users or totals; it cannot be restored automatically",
      "Cette sauvegarde vient d'une ancienne version, sans utilisateurs ni totaux ; elle ne peut pas être restaurée automatiquement",
    );
  }
  return Object.assign(file, { sealed: verifySeal(text.trimEnd()) });
}

/** True when the shop has no business data yet (only what setup creates). */
export async function isEmptyShop(tx: Tx) {
  const [r] = (await tx.execute<{ n: number }>(sql`
    select ((select count(*) from journals) + (select count(*) from products) + (select count(*) from sales) + (select count(*) from parties))::int as n
  `)).rows;
  return r.n === 0;
}

export interface RestoreResult {
  tables: number;
  rows: number;
  checks: { label: string; expected: string; actual: string; ok: boolean }[];
}

function compareTotals(expected: Totals, actual: Totals): RestoreResult["checks"] {
  const checks = Object.entries(expected.rows).map(([t, n]) => ({ label: t, expected: String(n), actual: String(actual.rows[t] ?? "—"), ok: actual.rows[t] === n }));
  for (const k of ["debit", "credit", "stockValue", "stockQty"] as const) {
    checks.push({ label: k, expected: expected[k], actual: actual[k], ok: expected[k] === actual[k] });
  }
  return checks;
}

/**
 * Rebuilds every table from the file. Without `replace` the shop must be empty (a new database);
 * with it, all current data is replaced. Throws, leaving everything as it was, if any total differs.
 */
export async function restore(tx: Tx, file: BackupFile, opts: { replace: boolean }): Promise<RestoreResult> {
  if (!opts.replace && !(await isEmptyShop(tx))) {
    throw new AppError(409, "This shop already has data; choose to replace everything to restore over it", "NOT_EMPTY", "Cette boutique contient déjà des données ; choisissez de tout remplacer pour restaurer par-dessus");
  }
  const names = await tables(tx);
  const unknown = Object.keys(file.tables).filter((t) => !names.includes(t));
  if (unknown.length) throw bad(`The backup has tables this version does not know: ${unknown.join(", ")}`, `La sauvegarde contient des tables inconnues de cette version : ${unknown.join(", ")}`);

  await tx.execute(sql`truncate ${sql.join(names.map((t) => sql.identifier(t)), sql`, `)} restart identity cascade`);
  let rowCount = 0;
  for (const t of await insertOrder(tx, names)) {
    const rows = file.tables[t];
    if (!rows?.length) continue;
    const have = new Set((await columns(tx, t)).map((c) => c.name));
    // Columns the file does not have (an older backup) take their default value.
    const cols = Object.keys(rows[0]).filter((c) => have.has(c));
    const list = sql.join(cols.map((c) => sql.identifier(c)), sql`, `);
    for (let i = 0; i < rows.length; i += 2000) {
      const chunk = JSON.stringify(rows.slice(i, i + 2000));
      await tx.execute(sql`insert into ${sql.identifier(t)} (${list}) select ${list} from json_populate_recordset(null::${sql.identifier(t)}, ${chunk}::json)`);
    }
    rowCount += rows.length;
    // A backup made before lines kept their kind: the lines the books wrote get it back.
    if (t === "journal_lines" && !cols.includes("kind")) await markSystemLines(tx);
    if (have.has("id")) {
      await tx.execute(sql`select setval(pg_get_serial_sequence(${t}, 'id'), coalesce((select max(id) from ${sql.identifier(t)}), 1), (select count(*) > 0 from ${sql.identifier(t)}))`);
    }
  }
  const checks = compareTotals(file.totals, await totalsOf(tx, Object.keys(file.totals.rows)));
  const wrong = checks.filter((c) => !c.ok);
  if (wrong.length) {
    throw new AppError(
      422,
      `The restored data does not match the backup (${wrong.map((c) => c.label).join(", ")}); nothing was changed`,
      "RESTORE_MISMATCH",
      `Les données restaurées ne correspondent pas à la sauvegarde (${wrong.map((c) => c.label).join(", ")}) ; rien n'a été modifié`,
    );
  }
  // The journal number sequence only once every check passed, as the last write: it belongs to no table,
  // so the truncate above does not restart it within the transaction and its setval is not undone by a
  // rollback. Set before a refused restore, it would leave the numbers behind the journals still in place,
  // and every posting after it would fail on a duplicate number. (The ids' sequences were restarted by
  // the truncate, so theirs roll back with it.)
  // Journal numbers carry on after the restored ones (a backup made before A22 still has the "journal"
  // counter row). Into an empty shop they never go back either: a number already given stays given.
  await tx.execute(sql`
    select setval('journal_number_seq', greatest(n, 1), n > 0) from (select greatest(
      coalesce((select value from counters where key = 'journal'), 0),
      coalesce((select max(substring(number from 3)::bigint) from journals where number ~ '^J-[0-9]{1,18}$'), 0),
      ${opts.replace ? sql`0` : sql`(select case when is_called then last_value else last_value - 1 end from journal_number_seq)`}
    ) as n) x
  `);
  // Everyone signs in again against the restored users.
  const [{ sessions }] = (await tx.execute<{ sessions: string | null }>(
    sql`select to_regclass('public.user_sessions')::text as sessions`
  )).rows;
  if (sessions) {
    const companyId = currentCompanyId();
    if (companyId === 1) {
      await tx.execute(sql`delete from public.user_sessions where sess->>'companyId' is null or sess->>'companyId' = '1'`);
    } else {
      await tx.execute(sql`delete from public.user_sessions where sess->>'companyId' = ${String(companyId)}`);
    }
  }
  return { tables: Object.keys(file.tables).length, rows: rowCount, checks };
}

// ---------------------------------------------------------------- Snapshots kept in the database

export async function saveSnapshot(kind: (typeof BACKUP_KINDS)[number]) {
  const text = await takeSnapshot();
  const data = gzipSync(Buffer.from(text));
  const day = todayIso();
  const [row] = await db
    .insert(backups)
    .values({ kind, day, data, size: data.length })
    .onConflictDoNothing()
    .returning({ id: backups.id });
  const keep = kind === "daily" ? KEEP_DAILY : KEEP_BEFORE_RESTORE;
  const recent = await db.select({ id: backups.id }).from(backups).where(eq(backups.kind, kind)).orderBy(desc(backups.id)).limit(keep);
  await db.delete(backups).where(and(eq(backups.kind, kind), notInArray(backups.id, recent.map((r) => r.id))));
  return row?.id ?? null;
}

/** Takes today's snapshot if there is none yet. Safe to call often: the day is unique, so a second one is dropped. */
export async function ensureDailySnapshot() {
  const [have] = await db.select({ id: backups.id }).from(backups).where(and(eq(backups.kind, "daily"), eq(backups.day, todayIso())));
  if (have) return;
  const id = await saveSnapshot("daily");
  if (id) log("daily backup saved", { id });
}

export function scheduleDailySnapshots() {
  const run = () => {
    void (async () => {
      const result = await pool.query<{ id: number }>("SELECT id FROM public.companies WHERE status='ready'");
      for (const row of result.rows) {
        try {
          await runInCompany(row.id, () => ensureDailySnapshot());
        } catch (error) {
          log("daily company backup failed", { companyId: row.id, error: String(error) });
        }
      }
    })().catch((e) => log("daily backup failed", { error: String(e) }));
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}

export async function listSnapshots() {
  return db
    .select({ id: backups.id, kind: backups.kind, day: backups.day, size: backups.size, createdAt: backups.createdAt })
    .from(backups)
    .orderBy(desc(backups.createdAt));
}

export async function snapshotFile(id: number) {
  const [row] = await db.select().from(backups).where(eq(backups.id, id));
  if (!row) throw new AppError(404, "Backup not found", "NOT_FOUND", "Sauvegarde introuvable");
  return row;
}
