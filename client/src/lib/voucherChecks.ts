import { useQueries, useQuery } from "@tanstack/react-query";
import Decimal from "decimal.js";
import { useAccounts, useMoneyAccounts, useRate } from "@/components/pickers";
import { owedOn, paymentSplit } from "@/lib/allocation";
import { de } from "@shared/french";
import { cdf, d, money, pct, usd } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Party } from "@/lib/types";

/** One line of a payment or receipt voucher, as the form holds it or as a pending voucher keeps it. */
export interface CheckLine {
  partyId: number | null;
  accountId: number | null;
  amount: string;
}

const isAmount = (s: string) => /^\d+(\.\d+)?$/.test(s.trim());

/** Above this many dollars (francs at the voucher's rate), a first payment to an account is asked about. */
export const FIRST_PAYMENT_ASK = 1000;

/**
 * The checks a payment or receipt voucher goes through before it is posted, shared by the voucher form and by
 * "Valider" on a pending voucher, so both ask the same questions:
 * - `unusual`: an account line far above what that account was paid in the past year ("Loyer" 14 000 $ when it
 *   was 1 400 $), or a payment taking most of the drawer at once;
 * - `overDebt`: a contact line for more than is owed, which becomes an advance or credit (the contact page's
 *   "Payer plus que ce qui est dû ?"), or paid to a contact who already owes the other way, whose debt it adds to
 *   (`overGrows` counts those lines);
 * - `short`: a payment the drawer cannot cover (the server refuses it).
 * They are questions, not refusals: a deliberate advance is still saved once confirmed.
 */
export function useVoucherChecks(input: { kind: string; day: string; accountId: number | null; rate: string | null; lines: CheckLine[]; enabled: boolean }) {
  const t = useT();
  const kind = input.kind === "payment" || input.kind === "receipt" ? input.kind : null;
  const enabled = input.enabled && !!kind;
  const { data: moneyAccounts } = useMoneyAccounts();
  const balances = useAccounts("/api/accounts/balances", { enabled });
  const parties = useQuery<Party[]>({ queryKey: ["/api/parties"], enabled });
  const dayRate = useRate(input.day).data;
  const account = moneyAccounts.find((a) => a.id === input.accountId) ?? null;
  const currency = account?.currency ?? "USD";
  const isCdf = currency === "CDF";
  const rate = input.rate && d(input.rate).gt(0) ? d(input.rate) : d(dayRate?.cdfPerUsd ?? 0);
  const lines = input.lines.filter((l) => isAmount(l.amount) && d(l.amount).gt(0));
  const total = lines.reduce((s, l) => s.plus(d(l.amount).toDecimalPlaces(2)), d(0));
  const toUsd = (x: Decimal) => (isCdf ? (rate.gt(0) ? x.dividedBy(rate) : null) : x);
  const bal = balances.data?.find((a) => a.id === input.accountId);
  const current = bal ? d(isCdf ? bal.nativeBalance : bal.balance) : null;
  const typed = (x: Decimal) => {
    const u = toUsd(x);
    return isCdf ? `${cdf(x.toFixed(0))}${u ? ` (≈\u00a0${usd(u.toFixed(2))})` : ""}` : usd(x.toFixed(2));
  };

  // What each account was paid in the past year.
  const yearAgo = `${Number(input.day.slice(0, 4)) - 1}${input.day.slice(4)}`.replace(/-02-29$/, "-02-28");
  const lineAccounts = kind === "payment" ? Array.from(new Set(lines.filter((l) => l.accountId && !l.partyId).map((l) => l.accountId!))) : [];
  const history = useQueries({
    queries: lineAccounts.map((id) => ({ queryKey: [`/api/accounts/${id}/ledger`, { from: yearAgo, to: input.day }], enabled: enabled && /^\d{4}-\d\d-\d\d$/.test(input.day), staleTime: 60_000 })),
  });
  const largestPaid = new Map<number, Decimal>();
  // Accounts whose past year was read and holds no payment at all.
  const firstPaid = new Set<number>();
  lineAccounts.forEach((id, i) => {
    const rows = (history[i]?.data as { rows?: { debit: string }[] } | undefined)?.rows ?? [];
    const paid = rows.map((r) => d(r.debit)).filter((x) => x.gt(0));
    if (paid.length) largestPaid.set(id, Decimal.max(...paid));
    else if (history[i]?.isSuccess) firstPaid.add(id);
  });

  const unusual: string[] = [];
  if (kind === "payment" && enabled) {
    for (const l of lines) {
      const most = l.accountId && !l.partyId ? largestPaid.get(l.accountId) : undefined;
      const u = toUsd(d(l.amount));
      // A first payment to an account has nothing to compare with: above FIRST_PAYMENT_ASK it is asked about
      // all the same ("Électricité et eau" 4 500 $ when 450 $ was meant).
      if (!most && u && l.accountId && !l.partyId && firstPaid.has(l.accountId) && u.gt(FIRST_PAYMENT_ASK)) {
        const name = balances.data?.find((a) => a.id === l.accountId)?.name ?? "";
        unusual.push(t(`${name}: ${typed(d(l.amount))}, a large first payment to this account (none in the past 12 months)`, `${name}\u00a0: ${typed(d(l.amount))}, un montant élevé pour un premier paiement sur ce compte (aucun sur les 12 derniers mois)`));
        continue;
      }
      // Three times the most ever paid there: a rent that went up is not questioned, a zero too many is.
      if (!most || !u || !u.gt(most.times(3))) continue;
      const name = balances.data?.find((a) => a.id === l.accountId)?.name ?? "";
      // Francs typed are compared in dollars, as the past payments are kept: "14 000 000 FC (≈ 5 000,00 $)".
      unusual.push(t(`${name}: ${typed(d(l.amount))}, far more than usual (at most ${usd(most.toFixed(2))} in the past 12 months)`, `${name} : ${typed(d(l.amount))}, bien plus que d'habitude (au plus ${usd(most.toFixed(2))} sur les 12 derniers mois)`));
    }
    if (current && current.gt(0) && total.gt(current.times(0.5)) && total.lte(current) && account) {
      unusual.push(t(`This payment takes ${pct(total.dividedBy(current).times(100).toNumber(), 0)} of ${account.name} (${money(current.toFixed(2), currency)})`, `Ce paiement prend ${pct(total.dividedBy(current).times(100).toNumber(), 0)} ${de(account.name)} (${money(current.toFixed(2), currency)})`));
    }
  }
  const short = kind === "payment" && current && account && total.gt(current)
    ? t(`Not enough money: ${account.name} has ${money(current.toFixed(2), currency)}`, `Fonds insuffisants : ${account.name} n'a que ${money(current.toFixed(2), currency)}`)
    : null;

  // Contact lines: the same split as the contact page's payment dialog, one contact at a time.
  const partyOf = (id: number | null) => (id ? parties.data?.find((p) => p.id === id) : undefined);
  // What settles everything owed to (or by) a contact, for the line's "Tout": in a dollar box the dollars owed
  // plus the francs owed at the voucher's rate, the figure the server settles all those francs for (contactLines:
  // "the dollars shown for all the francs owed settle all of them"), so it is the same figure the "more than is
  // owed" check reads, not the booked badge (3 290,10 $ booked, 3 289,91 $ today). In a franc box, the francs
  // owed when nothing is owed in dollars. Yuan owed are settled with "Yuans réglés" on the contact page: no "Tout".
  const settleAll = (id: number | null): { amount: string; usd: Decimal; fc: Decimal } | null => {
    const p = partyOf(id);
    if (!p || !kind || !account) return null;
    const owed = owedOn(p, kind);
    if (owed.cny.gt(0)) return null;
    if (isCdf) return owed.fc.gt(0) && owed.usd.isZero() && rate.gt(0) ? { amount: owed.fc.toFixed(0), usd: owed.fc.dividedBy(rate), fc: owed.fc } : null;
    if (owed.fc.gt(0) && !rate.gt(0)) return null;
    const all = owed.usd.plus(owed.fc.gt(0) ? owed.fc.dividedBy(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : 0);
    return all.gt(0) ? { amount: all.toFixed(2), usd: all, fc: owed.fc } : null;
  };

  const byParty = new Map<number, Decimal>();
  for (const l of lines) if (l.partyId) byParty.set(l.partyId, (byParty.get(l.partyId) ?? d(0)).plus(d(l.amount).toDecimalPlaces(2)));
  const overDebt: string[] = [];
  // Over-debt lines whose contact already owes the other way (a customer who owes us paid money): nothing is
  // "deducted next time", the debt grows. The confirmation's title and note say which.
  let overGrows = 0;
  let growsOnlyCustomers = true;
  const cnyRate = dayRate?.cnyPerUsd && d(dayRate.cnyPerUsd).gt(0) ? d(dayRate.cnyPerUsd) : null;
  if (kind && enabled && account && (!isCdf || rate.gt(0))) {
    for (const [id, amount] of Array.from(byParty)) {
      const p = partyOf(id);
      if (!p) continue;
      const owed = owedOn(p, kind);
      const customer = p.type === "customer";
      const cny = p.foreign?.find((f) => f.currency === "CNY");
      const split = paymentSplit({
        usd: isCdf ? amount.dividedBy(rate) : amount,
        francs: isCdf ? amount : null,
        rate: rate.gt(0) ? rate : null,
        owedUsd: owed.usd,
        owedFc: owed.fc,
        // The yuan owed are settled only by a payment to a supplier (payablesLines on the server).
        owedCny: kind === "payment" && !customer ? owed.cny : undefined,
        cnyRate: cnyRate ?? (cny && !d(cny.usd).isZero() ? d(cny.native).abs().dividedBy(d(cny.usd).abs()) : null),
      });
      const advance = split.find((x) => x.kind === "advance");
      // Under 100 FC left over is the notes' rounding.
      if (!advance || !(isCdf ? d(advance.usd).times(rate).gte(100) : d(advance.usd).gt(0))) continue;
      const owedUsd = split.filter((x) => x.kind !== "advance").reduce((s, x) => s.plus(x.usd), d(0));
      const paid = typed(amount);
      const over = usd(advance.usd);
      const some = owedUsd.gt(0);
      // Francs or yuan owed count here at the voucher's rate, the contact's badge at the rate they were booked at
      // (4 430,10 $ booked, 4 429,91 $ today): the figure says which, as on the contact page's "Payer".
      const booked = Decimal.max(kind === "receipt" ? d(p.balance) : d(p.balance).negated(), 0);
      const atRate = split.some((x) => x.kind === "cdf" || x.kind === "cny") && !owedUsd.toDecimalPlaces(2).eq(booked.toDecimalPlaces(2));
      const owedText = `${usd(owedUsd.toFixed(2))}${atRate ? t(" at today's rate", " au taux du jour") : ""}`;
      // What they already owe the other way: owed by them on a payment, owed to them on a receipt.
      const against = some ? d(0) : Decimal.max(kind === "payment" ? d(p.balance) : d(p.balance).negated(), 0);
      if (against.gt(0)) {
        overGrows++;
        if (!customer) growsOnlyCustomers = false;
      }
      const already = usd(against.toFixed(2));
      overDebt.push(
        against.gt(0)
          ? kind === "payment"
            ? t(`We pay ${paid} to ${p.name}; they already owe us ${already}: all of it adds to their debt`, `Nous versons ${paid} à ${p.name}\u00a0; il nous doit déjà ${already}\u00a0: tout s'ajoute à sa dette`)
            : t(`${p.name} pays ${paid}; we already owe them ${already}: all of it adds to what we owe them`, `${p.name} verse ${paid}\u00a0; nous lui devons déjà ${already}\u00a0: tout s'ajoute à notre dette envers lui`)
          : kind === "receipt"
          ? customer
            ? some
              ? t(`${p.name} pays ${paid}; they owe ${owedText}: ${over} will become credit for them`, `${p.name} paie ${paid} ; il doit ${owedText} : ${over} deviendront un avoir`)
              : t(`${p.name} pays ${paid}; they owe nothing: all of it will become credit for them`, `${p.name} paie ${paid} ; il ne doit rien : tout deviendra un avoir`)
            : some
              ? t(`${p.name} pays back ${paid}; they owe us ${owedText}: ${over} will be owed to them`, `${p.name} rembourse ${paid} ; il nous doit ${owedText} : ${over} deviendront une dette envers lui`)
              : t(`${p.name} pays back ${paid}; they owe us nothing: all of it will be owed to them`, `${p.name} rembourse ${paid} ; il ne nous doit rien : tout deviendra une dette envers lui`)
          : customer
            ? some
              ? t(`We pay ${paid} to ${p.name}; their credit is ${owedText}: ${over} will be owed by them`, `Nous versons ${paid} à ${p.name} ; son avoir est de ${owedText} : ${over} deviendront une dette du client`)
              : t(`We pay ${paid} to ${p.name}; they have no credit: all of it will be owed by them`, `Nous versons ${paid} à ${p.name} ; il n'a pas d'avoir : tout deviendra une dette du client`)
            : some
              ? t(`We pay ${paid} to ${p.name}; we owe ${owedText}: ${over} will become an advance`, `Nous payons ${paid} à ${p.name} ; nous devons ${owedText} : ${over} deviendront une avance`)
              : t(`We pay ${paid} to ${p.name}; we owe nothing: all of it will become an advance`, `Nous payons ${paid} à ${p.name} ; nous ne devons rien : tout deviendra une avance`),
      );
    }
  }

  // With no description, the day book reads the first line (as the server names the voucher): "Loyer + 1 autre".
  const first = input.lines.find((l) => l.partyId || l.accountId);
  const firstName = first ? (first.partyId ? partyOf(first.partyId)?.name : balances.data?.find((a) => a.id === first.accountId)?.name) : undefined;
  const others = input.lines.filter((l) => l.partyId || l.accountId).length - 1;
  const fallbackMemo = firstName ? `${firstName}${others > 0 ? ` + ${others} ${t(others > 1 ? "others" : "other", others > 1 ? "autres" : "autre")}` : ""}` : null;

  return { unusual, overDebt, overGrows, overGrowsCustomers: overGrows > 0 && growsOnlyCustomers, short, partyOf, settleAll, total, currency, account, fallbackMemo };
}
