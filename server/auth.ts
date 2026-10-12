import bcrypt from "bcryptjs";
import connectPg from "connect-pg-simple";
import session from "express-session";
import type { Express, NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { users, type Role } from "@shared/schema";
import { db, pool } from "./db";
import { AppError, forbidden } from "./errors";
import { asyncHandler } from "./http";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

export interface SessionUser {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  partnerId: number | null;
  language: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export function setupSession(app: Express) {
  const secret = process.env.SESSION_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET is required in production");
  const PgStore = connectPg(session);
  app.set("trust proxy", 1);
  app.use(
    session({
      store: new PgStore({ pool, tableName: "user_sessions", createTableIfMissing: true }),
      secret: secret ?? "dev-only-secret-change-me",
      resave: false,
      saveUninitialized: false,
      name: "hk.sid",
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 12,
      },
    }),
  );

  app.use(
    asyncHandler(async (req, _res, next) => {
      if (req.session.userId) {
        const [u] = await db.select().from(users).where(eq(users.id, req.session.userId));
        if (u && u.active) {
          req.user = { id: u.id, username: u.username, fullName: u.fullName, role: u.role, partnerId: u.partnerId, language: u.language };
        } else {
          delete req.session.userId;
        }
      }
      next();
    }),
  );
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new AppError(401, "Please sign in", "UNAUTHENTICATED"));
  next();
}

/** Allow only these roles. Owner is always allowed. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(401, "Please sign in", "UNAUTHENTICATED"));
    if (req.user.role === "owner" || roles.includes(req.user.role)) return next();
    next(forbidden());
  };
}

export const loginSchema = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) });

export function registerAuthRoutes(app: Express) {
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

  app.post(
    "/api/auth/login",
    loginLimiter,
    asyncHandler(async (req, res) => {
      const body = loginSchema.parse(req.body);
      const [u] = await db.select().from(users).where(eq(users.username, body.username.trim().toLowerCase()));
      const ok = u && u.active && (await bcrypt.compare(body.password, u.passwordHash));
      if (!ok) throw new AppError(401, "Wrong username or password", "BAD_LOGIN");
      await new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
      req.session.userId = u.id;
      res.json({ id: u.id, username: u.username, fullName: u.fullName, role: u.role, partnerId: u.partnerId, language: u.language });
    }),
  );

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("hk.sid");
      res.json({ ok: true });
    });
  });

  app.get("/api/auth/me", (req, res) => {
    if (!req.user) return res.status(401).json({ message: "Please sign in" });
    res.json(req.user);
  });
}

export async function hashPassword(password: string) {
  if (password.length < 8) throw new AppError(400, "Passwords need at least 8 characters", "WEAK_PASSWORD");
  return bcrypt.hash(password, 12);
}
