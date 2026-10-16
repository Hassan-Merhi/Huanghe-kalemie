import { useQueries, useQuery } from "@tanstack/react-query";
import Decimal from "decimal.js";
import { useAccounts, useMoneyAccounts, useRate } from "@/components/pickers";
import { owedOn, paymentSplit } from "@/lib/allocation";
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

/**
 * The checks a payment or receipt voucher goes through before it is posted, shared by the voucher form and by
 * "Valider" on a pending voucher, so both ask the same questions:
 * - `unusual`: an account line far above what that account was paid in the past year ("Loyer" 14 000 $ when it
 *   was 1 400 $), or a payment taking most of the drawer at once;
 * - `overDebt`: a contact line for more than is owed, which becomes an advance or credit (the contact page's
 *   "Payer plus que ce qui est dû ?");
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
  lineAccounts.forEach((id, i) => {
    const rows = (history[i]?.data as { rows?: { debit: string }[] } | undefined)?.rows ?? [];
    const paid = rows.map((r) => d(r.debit)).filter((x) => x.gt(0));
    // A first payment to an account has nothing to compare with.
    if (paid.length) largestPaid.set(id, Decimal.max(...paid));
  });

  const unusual: string[] = [];
  if (kind === "payment" && enabled) {
    for (const l of lines) {
      const most = l.accountId && !l.partyId ? largestPaid.get(l.accountId) : undefined;
      const u = toUsd(d(l.amount));
      // Three times the most ever paid there: a rent that went up is not questioned, a zero too many is.
      if (!most || !u || !u.gt(most.times(3))) continue;
      const name = balances.data?.find((a) => a.id === l.accountId)?.name ?? "";
      // Francs typed are compared in dollars, as the past payments are kept: "14 000 000 FC (≈ 5 000,00 $)".
      unusual.push(t(`${name}: ${typed(d(l.amount))}, far more than usual (at most ${usd(most.toFixed(2))} in the past 12 months)`, `${name} : ${typed(d(l.amount))}, bien plus que d'habitude (au plus ${usd(most.toFixed(2))} sur les 12 derniers mois)`));
    }
    if (current && current.gt(0) && total.gt(current.times(0.5)) && total.lte(current) && account) {
      unusual.push(t(`This payment takes ${pct(total.dividedBy(current).times(100).toNumber(), 0)} of ${account.name} (${money(current.toFixed(2), currency)})`, `Ce paiement prend ${pct(total.dividedBy(current).times(100).toNumber(), 0)} de ${account.name} (${money(current.toFixed(2), currency)})`));
    }
  }
  const short = kind === "payment" && current && account && total.gt(current)
    ? t(`Not enough money: ${account.name} has ${money(current.toFixed(2), currency)}`, `Fonds insuffisants : ${account.name} n'a que ${money(current.toFixed(2), currency)}`)
    : null;

  // Contact lines: the same split as the contact page's payment dialog, one contact at a time.
  const partyOf = (id: number | null) => (id ? parties.data?.find((p) => p.id === id) : undefined);
  const byParty = new Map<number, Decimal>();
  for (const l of lines) if (l.partyId) byParty.set(l.partyId, (byParty.get(l.partyId) ?? d(0)).plus(d(l.amount).toDecimalPlaces(2)));
  const overDebt: string[] = [];
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
      const owedText = usd(owedUsd.toFixed(2));
      overDebt.push(
        kind === "receipt"
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

  return { unusual, overDebt, short, partyOf, total, currency, account, fallbackMemo };
}
