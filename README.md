# Huanghe Motors Kalemie

Shop system for the Huanghe motorcycle and spare-parts shop in Kalemie: catalog with variants, containers with landed cost, point of sale, stock, expenses, double-entry accounting and the monthly 75/25 partner settlement. French and English.

Built on the same stack as MotoTrack (React + Vite + shadcn/ui, Express, Drizzle ORM, PostgreSQL), as a separate, lean app.

## What it does

| Area | What you can do |
|------|-----------------|
| Items | One item (name + category) with many variants: size, colour, position, fitment. Each variant has its own SKU, barcode, price, stock and cost. Motorcycles have one record per bike with chassis and engine number. |
| Containers | Enter the supplier invoice lines and every container expense (freight, duties, clearing, transport to Kalemie, handling…). See the landed cost per item before you confirm, then offload into stock. |
| Point of sale | Scan or search, pick the chassis for bikes, take USD cash, CDF cash, mobile money or a mix, sell on credit to a named customer, print an 80 mm receipt. |
| Stock | Weighted average cost per variant, opening stock, counts, damage/loss, transfers between locations, movement history, low-stock list. |
| Expenses | Rent, salaries, electricity and other running costs, paid or owed. |
| Money | Cash boxes (USD and CDF), mobile money, bank, transfers and currency exchange, customer payments, supplier and agent payments, partner capital and withdrawals. |
| Partners | Month close with the 75/25 split, partner statements, months locked once closed. |
| Reports | Dashboard, profit and loss, sales by item, daily cash report, trial balance, journal, account ledger, CSV export. |
| Users | Owner, manager, cashier and partner (read-only) roles. |

## The two rules the system is built around

**1. Container costs go into the item cost.** When a container is offloaded, each expense is split across the container lines (by purchase value by default; by quantity, weight, volume or to a single line if you choose), and each line's landed cost per unit is

```
(purchase value in USD + its share of every container expense) ÷ quantity
```

Amounts are split in cents with the largest-remainder method, so the landed total always equals purchase + expenses exactly. Example: $20,000 of goods (10 bikes at $1,500, 1,000 brake pads at $5) and $4,000 of expenses gives bikes at $1,800 and pads at $6. Both partners share these costs through cost of goods sold.

**2. Profit is split 75/25, running costs come off the 75% partner.** For each month:

```
gross profit   = sales − cost of goods sold − stock losses
partner A (75%) = 75% × gross profit − all operating expenses
partner B (25%) = 25% × gross profit
```

Example: gross profit $10,000 and running costs $2,000 gives A $5,500 and B $2,500. If running costs are more than A's share, A's result is negative and carries forward on A's account. Shares and who bears running costs are editable in Settings (they must add up to 100%).

## Accounting

Every operation posts a balanced journal; reports are read from the ledger.

| Operation | Debit | Credit |
|-----------|-------|--------|
| Container expense paid | Goods in transit | Cash / mobile money (or Payables to the agent) |
| Offload | Inventory (landed total) | Payables to supplier (purchase value), Goods in transit (expenses) |
| Sale | Cash / mobile money, Customers (credit part) | Sales |
| … and its cost | Cost of goods sold | Inventory |
| Return | Sales, Inventory | Cash or Customers, Cost of goods sold |
| Running expense | Expense account (rent, salaries…) | Cash (or Payables) |
| Partner capital in / withdrawal | Cash / Partner current account | Partner capital / Cash |
| Month close | Income accounts | Cost and expense accounts, partner current accounts (the split) |

- Base currency is USD. CDF accounts also keep the franc amount and the rate on each line; differences when changing money go to *Exchange differences* (shared, in gross profit).
- Stock value per variant is kept as total quantity and total value, so the Inventory account always equals the stock valuation (the Stock page shows the check).
- The cost of each sale line is fixed at the moment of sale, so past months never change.
- A closed month accepts no postings. Months close in order, and only the latest closed month can be reopened.
- Cancelling (sale, expense, container offload) posts a reversal; nothing is deleted.
- Every money amount uses exact decimal arithmetic (decimal.js), never floats.

## Run it

Requirements: Node 20+ and PostgreSQL 14+.

```bash
npm ci
cp .env.example .env          # set DATABASE_URL, SESSION_SECRET, OWNER_PASSWORD
export $(grep -v '^#' .env | xargs)
npm run dev                   # http://localhost:5000
```

Database migrations run automatically on start, and the first start creates the chart of accounts, the two partners, the Kalemie location, default categories and the owner login (`OWNER_USERNAME` / `OWNER_PASSWORD`; in development the default is `admin` / `admin12345`).

### Starting with existing stock and cash

1. Settings → set partner names, shop name, CDF rate; create users.
2. Stock → Adjust stock → kind *Opening stock*: enter each item's quantity and cost (and chassis numbers for bikes).
3. Reports → Journal → manual entry with *Opening balance* switched on for cash balances (or Money → partner capital if the partners are putting money in).

### Tests

```bash
npm test                                   # unit tests
TEST_DATABASE_URL=postgres://… npm test    # plus the full shop flow against a real database
```

The integration tests reset the database they are given, so point them at an empty test database.

### Deploy on Render

`render.yaml` sets up a web service and a PostgreSQL database. Set `OWNER_PASSWORD` (and partner names) in the Render dashboard before the first deploy.

## Project layout

```
shared/      schema (Drizzle), money helpers, landed cost and partner split (pure, unit tested)
server/      Express API, auth and roles, services (ledger, stock, containers, sales, periods, reports)
client/      React app (pages/, components/, lib/)
migrations/  SQL migrations (generated with drizzle-kit)
tests/       unit and integration tests
```

To change the schema: edit `shared/schema.ts`, then `npx drizzle-kit generate --name <change>` and commit the new migration.
