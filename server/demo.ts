/**
 * Fill an empty database with demo data so the screens can be tried out:
 * DATABASE_URL=… npm run seed:demo
 * Refuses to run when sales already exist.
 */
import { eq, sql } from "drizzle-orm";
import { accounts, containers, locations, motorcycleUnits, parties, partners, sales } from "@shared/schema";
import { db } from "./db";
import { runMigrations } from "./migrate";
import { ensureSetup } from "./setup";
import * as catalog from "./services/catalog";
import * as containerSvc from "./services/containers";
import * as salesSvc from "./services/sales";
import * as ops from "./services/operations";

function day(offset: number) {
  const d = new Date(Date.now() + 2 * 3600_000 - offset * 86400_000);
  return d.toISOString().slice(0, 10);
}

/** True when the shop has no items and no sales yet, so demo data cannot mix with real records. */
export async function isEmptyShop(): Promise<boolean> {
  const [{ count }] = await db.select({ count: sql<number>`(select count(*) from sales) + (select count(*) from products)`.mapWith(Number) }).from(sql`(select 1) as one`);
  return count === 0;
}

/** Adds the demo items, container, sales and expenses. Call only on an empty shop. */
export async function seedDemo(): Promise<void> {

  const accs = await db.select().from(accounts);
  const acc = (key: string) => accs.find((a) => a.systemKey === key || a.code === key)!.id;
  const [loc] = await db.select().from(locations).limit(1);
  const [partnerA] = await db.select().from(partners).orderBy(partners.id).limit(1);
  const cats = await db.execute<{ id: number; name: string }>(sql`select id, name from categories`);
  const cat = (name: string) => cats.rows.find((c) => c.name === name)?.id ?? null;
  const userId = 1;

  const [supplier] = await db.insert(parties).values({ type: "supplier", name: "Huanghe Group (Chongqing)", phone: "+86 23 0000 0000" }).returning();
  const [agent] = await db.insert(parties).values({ type: "agent", name: "Transit Lubumbashi SARL", phone: "+243 990 000 000" }).returning();
  const [customer] = await db.insert(parties).values({ type: "customer", name: "Garage Mwamba", phone: "+243 970 111 222" }).returning();

  const bike = await db.transaction((tx) =>
    catalog.createProduct(tx, {
      name: "Huanghe HH150-8",
      categoryId: cat("Motos"),
      tracksSerials: true,
      variants: [
        { attributes: { Colour: "Red" }, sellPrice: "1450" },
        { attributes: { Colour: "Black" }, sellPrice: "1450" },
      ],
    }),
  );
  const tyre = await db.transaction((tx) =>
    catalog.createProduct(tx, {
      name: "Tyre",
      categoryId: cat("Pneus et chambres à air"),
      variants: [
        { attributes: { Size: "2.75-17" }, sellPrice: "22", reorderLevel: "10", barcode: "2000000000017" },
        { attributes: { Size: "3.00-17" }, sellPrice: "25", reorderLevel: "10", barcode: "2000000000024" },
        { attributes: { Size: "3.00-18" }, sellPrice: "27", reorderLevel: "10", barcode: "2000000000031" },
      ],
    }),
  );
  const pads = await db.transaction((tx) =>
    catalog.createProduct(tx, {
      name: "Brake pads",
      categoryId: cat("Freins"),
      unit: "set",
      variants: [
        { attributes: { Position: "Front" }, sellPrice: "6", reorderLevel: "20" },
        { attributes: { Position: "Rear" }, sellPrice: "5", reorderLevel: "20" },
      ],
    }),
  );
  const oil = await db.transaction((tx) =>
    catalog.createProduct(tx, { name: "Engine oil 4T", categoryId: cat("Huiles et lubrifiants"), unit: "litre", variants: [{ attributes: { Size: "1L" }, sellPrice: "5" }] }),
  );

  await db.transaction((tx) => ops.partnerContribution(tx, { date: day(40), partnerId: partnerA.id, accountId: acc("cash_usd"), amount: "60000" }, userId));

  await db.transaction((tx) =>
    ops.transferMoney(tx, { date: day(40), fromAccountId: acc("cash_usd"), fromAmount: "1000", toAccountId: acc("cash_cdf"), toAmount: "2800000", rate: "2800", memo: "Change USD to CDF" }, userId),
  );
  const [c] = await db
    .insert(containers)
    .values({ number: "HHU-2026-001", supplierId: supplier.id, locationId: loc.id, status: "arrived", shipDate: day(70), arrivalDate: day(32) })
    .returning();
  await db.transaction((tx) =>
    containerSvc.replaceLines(tx, c.id, [
      { variantId: bike.variants[0].id, quantity: "20", unitPrice: "820", weightKg: "2400", volumeCbm: "30" },
      { variantId: bike.variants[1].id, quantity: "20", unitPrice: "820", weightKg: "2400", volumeCbm: "30" },
      { variantId: tyre.variants[0].id, quantity: "200", unitPrice: "9", weightKg: "800", volumeCbm: "6" },
      { variantId: tyre.variants[1].id, quantity: "200", unitPrice: "10.5", weightKg: "900", volumeCbm: "6" },
      { variantId: tyre.variants[2].id, quantity: "100", unitPrice: "11", weightKg: "480", volumeCbm: "3" },
      { variantId: pads.variants[0].id, quantity: "500", unitPrice: "1.6", weightKg: "150", volumeCbm: "0.5" },
      { variantId: pads.variants[1].id, quantity: "500", unitPrice: "1.3", weightKg: "150", volumeCbm: "0.5" },
      { variantId: oil.variants[0].id, quantity: "600", unitPrice: "2", weightKg: "560", volumeCbm: "1" },
    ]),
  );
  await db.transaction(async (tx) => {
    await containerSvc.addExpense(tx, c.id, { date: day(60), type: "freight", amount: "6500", currency: "USD", method: "volume", paidFromAccountId: acc("cash_usd") }, userId);
    await containerSvc.addExpense(tx, c.id, { date: day(35), type: "duties", amount: "5200", currency: "USD", method: "value", payablePartyId: agent.id }, userId);
    await containerSvc.addExpense(tx, c.id, { date: day(33), type: "transport", description: "Lubumbashi → Kalemie", amount: "3000", currency: "USD", method: "weight", paidFromAccountId: acc("cash_usd") }, userId);
    await containerSvc.addExpense(tx, c.id, { date: day(32), type: "offload_labour", amount: "560000", currency: "CDF", rate: "2800", method: "quantity", paidFromAccountId: acc("cash_cdf") }, userId);
  });
  await db.transaction((tx) => containerSvc.finalizeContainer(tx, c.id, day(31), userId));
  await db.transaction((tx) => ops.payParty(tx, { date: day(30), partyId: supplier.id, accountId: acc("cash_usd"), amount: "30000" }, userId));

  // Register chassis numbers for half the bikes.
  const units = await db.select().from(motorcycleUnits).orderBy(motorcycleUnits.id);
  for (let i = 0; i < units.length; i += 2) {
    await db.update(motorcycleUnits).set({ chassisNo: `LHJPCK${String(100000 + i)}`, engineNo: `162FMJ${String(500000 + i)}` }).where(eq(motorcycleUnits.id, units[i].id));
  }

  // Sales over the last month.
  const sellable = units.filter((_, i) => i % 2 === 0);
  for (let k = 0; k < 24; k++) {
    const when = day(29 - k);
    const lines: salesSvc.SaleLineInput[] = [
      { variantId: tyre.variants[k % 3].id, qty: String(1 + (k % 4)), unitPrice: tyre.variants[k % 3].sellPrice },
      { variantId: pads.variants[k % 2].id, qty: String(2 + (k % 3)), unitPrice: pads.variants[k % 2].sellPrice },
      { variantId: oil.variants[0].id, qty: String(1 + (k % 5)), unitPrice: "5" },
    ];
    if (k % 3 === 0 && sellable.length) {
      const u = sellable.shift()!;
      lines.push({ variantId: u.variantId, unitId: u.id, qty: "1", unitPrice: "1450" });
    }
    const total = lines.reduce((s, l) => s + Number(l.qty) * Number(l.unitPrice), 0);
    const credit = k % 7 === 3;
    await db.transaction((tx) =>
      salesSvc.createSale(
        tx,
        {
          date: when,
          locationId: loc.id,
          customerId: credit ? customer.id : null,
          lines,
          payments: credit ? [] : k % 2 === 0 ? [{ accountId: acc("cash_usd"), amount: String(total) }] : [{ accountId: acc("cash_cdf"), amount: String(total * 2800), rate: "2800" }],
        },
        userId,
      ),
    );
  }

  await db.transaction(async (tx) => {
    await ops.createExpense(tx, { date: day(28), accountId: acc("6000"), description: "Shop rent", amount: "600", paidFromAccountId: acc("cash_usd") }, userId);
    await ops.createExpense(tx, { date: day(5), accountId: acc("6010"), description: "Staff salaries", amount: "900", paidFromAccountId: acc("cash_usd") }, userId);
    await ops.createExpense(tx, { date: day(12), accountId: acc("6070"), description: "Generator fuel", amount: "196000", rate: "2800", paidFromAccountId: acc("cash_cdf") }, userId);
  });
  console.log("Demo data created.");
}

async function main() {
  await runMigrations(db);
  await db.transaction((tx) => ensureSetup(tx, { ownerPassword: process.env.OWNER_PASSWORD ?? "admin12345" }));
  if (!(await isEmptyShop())) throw new Error("This database already has items or sales; demo data is only for an empty one.");
  await seedDemo();
  process.exit(0);
}

if (process.argv[1]?.endsWith("demo.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
