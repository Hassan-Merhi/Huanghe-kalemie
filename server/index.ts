import express from "express";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import { createServer } from "http";
import { db } from "./db";
import { registerAuthRoutes, setupSession } from "./auth";
import { errorHandler } from "./http";
import { log } from "./log";
import { runMigrations } from "./migrate";
import { registerRoutes } from "./routes";
import { ensureSetup } from "./setup";

export async function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      // Vite's dev server injects inline scripts; enforce the policy in production only.
      contentSecurityPolicy: process.env.NODE_ENV !== "production" ? false : {
        useDefaults: true,
        directives: {
          "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
          "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          "img-src": ["'self'", "data:", "blob:"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  setupSession(app);
  registerAuthRoutes(app);
  registerRoutes(app);
  app.use("/api", (_req, res) => res.status(404).json({ message: "Not found" }));
  app.use(errorHandler);
  return app;
}

async function main() {
  await runMigrations(db);
  await db.transaction((tx) =>
    ensureSetup(tx, {
      ownerUsername: process.env.OWNER_USERNAME?.toLowerCase(),
      ownerPassword: process.env.OWNER_PASSWORD ?? (process.env.NODE_ENV === "production" ? undefined : "admin12345"),
      partnerAName: process.env.PARTNER_A_NAME,
      partnerBName: process.env.PARTNER_B_NAME,
      locationName: process.env.LOCATION_NAME,
    }),
  );
  const app = await createApp();
  const server = createServer(app);

  if (process.env.NODE_ENV === "production") {
    const dist = path.resolve(import.meta.dirname, "public");
    if (!fs.existsSync(dist)) throw new Error(`Build the client first: ${dist} is missing`);
    app.use(express.static(dist, { maxAge: "1h", index: false }));
    app.get("*", (_req, res) => res.sendFile(path.resolve(dist, "index.html")));
  } else {
    const { createServer: createVite } = await import("vite");
    const vite = await createVite({ server: { middlewareMode: true, hmr: { server } }, appType: "spa", configFile: path.resolve(import.meta.dirname, "..", "vite.config.ts") });
    app.use(vite.middlewares);
  }

  const port = Number(process.env.PORT ?? 5000);
  server.listen(port, "0.0.0.0", () => log(`Huanghe Kalemie listening on ${port}`));
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
