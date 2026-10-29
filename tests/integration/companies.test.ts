import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { hasDb, resetDatabase } from "./helpers";

/** Company boundaries must hold even when business records have overlapping numeric IDs. */
describe.skipIf(!hasDb)("Company workspaces", async () => {
  const { createApp } = await import("../../server/index");
  let server: Server;
  let url = "";

  function client() {
    let cookie = "";
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(url + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = response.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      const text = await response.text();
      return { status: response.status, data: text ? JSON.parse(text) : null };
    };
  }

  const root = client();
  const companyClient = client();

  beforeAll(async () => {
    await resetDatabase();
    const app = await createApp();
    server = app.listen(0);
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server?.close());

  it("keeps company data apart and requires force when deleting populated companies", async () => {
    const signedIn = await root("POST", "/api/auth/login", { username: "admin", password: "test-password-123" });
    expect(signedIn.status).toBe(200);
    expect(signedIn.data.companyId).toBe(1);

    const rootProduct = await root("POST", "/api/products", { name: "Original shop tyre", variants: [{ sellPrice: "12" }] });
    expect(rootProduct.status).toBe(201);

    const created = await root("POST", "/api/companies", { name: "Independent workshop" });
    expect(created.status).toBe(201);
    const id: number = created.data.id;
    expect(id).toBeGreaterThan(1);

    const login = await companyClient("POST", "/api/auth/login", {
      username: "admin", password: "test-password-123", companyId: id,
    });
    expect(login.status).toBe(200);
    expect(login.data.companyId).toBe(id);
    const empty = await companyClient("GET", "/api/products");
    expect(empty.status).toBe(200);
    expect(empty.data).toHaveLength(0);

    const tenantProduct = await companyClient("POST", "/api/products", {
      name: "Company-only wheel", variants: [{ sellPrice: "8" }],
    });
    expect(tenantProduct.status).toBe(201);

    const rootProducts = await root("GET", "/api/products");
    expect(rootProducts.status).toBe(200);
    expect(rootProducts.data.some((p: { name: string }) => p.name === "Original shop tyre")).toBe(true);
    expect(rootProducts.data.some((p: { name: string }) => p.name === "Company-only wheel")).toBe(false);

    const otherProducts = await companyClient("GET", "/api/products");
    expect(otherProducts.data.some((p: { name: string }) => p.name === "Company-only wheel")).toBe(true);
    expect(otherProducts.data.some((p: { name: string }) => p.name === "Original shop tyre")).toBe(false);

    const details = await root("GET", `/api/companies/${id}/impact`);
    expect(details.status).toBe(200);
    expect(details.data.counts.products).toBe(1);

    expect((await companyClient("GET", "/api/companies")).status).toBe(403);
    expect((await root("POST", `/api/companies/${id}/delete`, { name: "wrong name", force: true })).status).toBe(400);
    const normal = await root("POST", `/api/companies/${id}/delete`, { name: "Independent workshop", force: false });
    expect(normal.status).toBe(409);

    const deleted = await root("POST", `/api/companies/${id}/delete`, { name: "Independent workshop", force: true });
    expect(deleted.status).toBe(200);
    expect(deleted.data.deletedRecords).toBeGreaterThan(0);
    expect((await root("GET", "/api/products")).data.some((p: { name: string }) => p.name === "Original shop tyre")).toBe(true);
    expect((await companyClient("GET", "/api/products")).status).toBe(401);
    expect((await companyClient("POST", "/api/auth/login", {
      companyId: id, username: "admin", password: "test-password-123",
    })).status).toBe(401);
  }, 90_000);

  it("deletes a company without force when it has no business records", async () => {
    const created = await root("POST", "/api/companies", { name: "Empty second company" });
    expect(created.status).toBe(201);
    const id = created.data.id;
    expect((await root("GET", `/api/companies/${id}/impact`)).data.records).toBe(0);
    const deleted = await root("POST", `/api/companies/${id}/delete`, { name: "Empty second company", force: false });
    expect(deleted.status).toBe(200);
  }, 90_000);

  it("always protects the original company", async () => {
    expect((await root("POST", "/api/companies/1/delete", {
      name: "Huanghe Motors Kalemie", force: true,
    })).status).toBe(403);
  });
});
