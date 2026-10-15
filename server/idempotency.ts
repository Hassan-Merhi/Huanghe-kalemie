import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { and, eq, lt, sql } from "drizzle-orm";
import { idempotencyKeys } from "@shared/schema";
import { db } from "./db";
import { log } from "./log";

/** A request still marked running after this long crashed; let a retry go through. */
const STALE_MS = 2 * 60 * 1000;
const KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * The browser sends a fresh Idempotency-Key with each form submit. The first request with a key
 * runs; a repeat of it while it runs gets 409 IN_PROGRESS, and a repeat after it succeeded gets
 * the same answer again without posting anything. A failed request frees its key for a retry.
 */
export function idempotency(): RequestHandler {
  return async (req, res, next) => {
    const key = req.get("Idempotency-Key");
    const userId = req.session?.userId;
    if (!key || req.method === "GET" || !userId || !/^[\w-]{8,100}$/.test(key)) return next();
    const bodyHash = createHash("sha256").update(JSON.stringify(req.body ?? null)).digest("hex");
    try {
      const inserted = await db
        .insert(idempotencyKeys)
        .values({ key, userId, method: req.method, path: req.originalUrl, bodyHash })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
      if (!inserted.length) {
        const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
        if (row && (row.userId !== userId || row.path !== req.originalUrl || row.method !== req.method || (row.bodyHash && row.bodyHash !== bodyHash))) {
          return res.status(422).json({ message: "This request key was already used for something else", messageFr: "Cette clé de requête a déjà servi pour autre chose", code: "IDEMPOTENCY_MISMATCH" });
        }
        if (row && row.status !== null) return res.status(row.status).json(row.response);
        if (row && Date.now() - row.createdAt.getTime() < STALE_MS) {
          return res.status(409).json({ message: "This is already being saved", messageFr: "Cette opération est déjà en cours d'enregistrement", code: "IN_PROGRESS" });
        }
        await db.update(idempotencyKeys).set({ createdAt: new Date() }).where(eq(idempotencyKeys.key, key));
      } else if (Math.random() < 0.02) {
        void db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(Date.now() - KEEP_MS))).catch(() => {});
      }
    } catch (e) {
      log(`idempotency check failed: ${(e as Error).message}`);
      return next();
    }

    let settled = false;
    const settle = async (status: number, body: unknown) => {
      if (settled) return;
      settled = true;
      try {
        if (status < 400) {
          await db
            .update(idempotencyKeys)
            .set({ status, response: body === undefined ? null : sql`${JSON.stringify(body)}::jsonb` })
            .where(eq(idempotencyKeys.key, key));
        } else {
          await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.key, key), sql`${idempotencyKeys.status} is null`));
        }
      } catch (e) {
        log(`idempotency save failed: ${(e as Error).message}`);
      }
    };
    const json = res.json.bind(res);
    // Record the answer before sending it, so a repeat that arrives next already finds it.
    res.json = ((body: unknown) => {
      void settle(res.statusCode, body).then(() => json(body));
      return res;
    }) as typeof res.json;
    res.on("close", () => void settle(res.headersSent ? res.statusCode : 500, undefined));
    next();
  };
}
