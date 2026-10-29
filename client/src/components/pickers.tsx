import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useFieldLabelledBy } from "@/components/ui/field-label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Field } from "@/components/common";
import { useI18n, useT } from "@/lib/i18n";
import { accountLabel, containerRateRefusal, convertedNote, convertTypedAmount, d, money, perUsdText, todayLocal, usd, usdPerUnit, qty as fmtQty } from "@/lib/format";
import { api, invalidateAll, withQuery } from "@/lib/api";
import type { Account, Category, Location, Party, Settings, VariantRow } from "@/lib/types";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { accountText } from "@/lib/systemText";
import { duplicateParty } from "@/lib/labels";
import { capitalize, monthText } from "@shared/french";

/**
 * The chart of accounts (or `/api/accounts/balances`), with the default accounts named in the language
 * shown ("Caisse FC" reads "Cash FC" in English, as on the Accounts page). Only for display and picking:
 * a form that renames an account starts from the name as stored.
 */
export function useAccounts(path: "/api/accounts" | "/api/accounts/balances" = "/api/accounts", opts: { enabled?: boolean } = {}) {
  const { lang } = useI18n();
  const select = useCallback((rows: Account[]) => (lang === "en" ? rows.map((a) => ({ ...a, name: accountText(a.name, lang) })) : rows), [lang]);
  return useQuery<Account[], Error, Account[]>({ queryKey: [path], select, enabled: opts.enabled });
}

/** Cash boxes, bank and mobile money accounts. */
export function useMoneyAccounts() {
  const q = useAccounts();
  return { ...q, data: (q.data ?? []).filter((a) => a.isMoney && a.active) };
}

/**
 * Money account picker. Managers and partners see each account's balance in the list, as on the
 * vouchers form, so a payment is not taken from an empty box; the till leaves it out (`showBalance`).
 */
export function MoneyAccountSelect({
  value,
  onChange,
  placeholder,
  showBalance = true,
  "aria-label": ariaLabel,
}: {
  value: number | null;
  onChange: (id: number, account: Account) => void;
  placeholder?: string;
  showBalance?: boolean;
  "aria-label"?: string;
}) {
  const t = useT();
  const { can } = useAuth();
  const { data } = useMoneyAccounts();
  const withBalance = showBalance && can("manager", "partner");
  const balances = useAccounts("/api/accounts/balances", { enabled: withBalance }).data;
  const balanceOf = (a: Account) => {
    const b = withBalance ? balances?.find((x) => x.id === a.id) : undefined;
    return b ? money(a.currency === "CDF" ? b.nativeBalance : b.balance, a.currency) : null;
  };
  return (
    <Select value={value ? String(value) : ""} onValueChange={(v) => { const a = data.find((x) => x.id === Number(v)); if (a) onChange(a.id, a); }}>
      <SelectTrigger aria-label={ariaLabel}><SelectValue placeholder={placeholder ?? t("Choose account", "Choisir le compte")} /></SelectTrigger>
      <SelectContent>
        {data.map((a) => {
          const bal = balanceOf(a);
          return (
            <SelectItem key={a.id} value={String(a.id)} extra={bal && <span className="ml-auto pl-3 text-xs text-muted-foreground tabular">{bal}</span>}>
              {accountLabel(a.name, a.currency)}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/** Lower case without accents, so "electricite" finds "Électricité". */
function fold(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** How well an account matches what was typed: the name itself, then a name starting with it, then a word starting with it. */
function matchRank(a: Account, query: string): number {
  if (!query) return 0;
  const name = fold(a.name);
  if (name === query || a.code === query) return 0;
  if (name.startsWith(query) || a.code.startsWith(query)) return 1;
  if (name.split(/[\s'’(),:-]+/).some((w) => w.startsWith(query))) return 2;
  return 3;
}

/** Everyday accounts first (expenses, income), opening balances and the partners' capital last. */
function typeRank(a: Account): number {
  if (a.systemKey === "opening_equity" || a.partnerId) return 5;
  return { expense: 0, income: 0, cost_of_sales: 1, liability: 2, asset: 3, equity: 4 }[a.type] ?? 3;
}

/**
 * Searchable account picker: typing filters by name or chart number. `hideCode` drops the chart
 * number from what is shown ("6000 · Loyer" → "Loyer") on pages for the shop, not the books; the
 * number still finds the account. `filter` narrows the list further.
 */
export function AccountSelect({
  value,
  onChange,
  types,
  placeholder,
  hideCode,
  filter,
  "aria-label": ariaLabel,
}: {
  value: number | null;
  onChange: (id: number) => void;
  types?: Account["type"][];
  placeholder?: string;
  hideCode?: boolean;
  filter?: (a: Account) => boolean;
  "aria-label"?: string;
}) {
  const t = useT();
  const q = useAccounts();
  const rows = (q.data ?? []).filter((a) => a.active && (!types || types.includes(a.type)) && (!filter || filter(a)));
  const selected = (q.data ?? []).find((a) => a.id === value);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const words = fold(search).split(/\s+/).filter(Boolean);
  const query = words.join(" ");
  const filtered = rows
    .filter((a) => words.every((w) => fold(`${a.code} ${a.name}`).includes(w)))
    .map((a) => ({ a, rank: [matchRank(a, query), typeRank(a)] }))
    .sort((x, y) => x.rank[0] - y.rank[0] || x.rank[1] - y.rank[1] || x.a.code.localeCompare(y.a.code))
    .map((x) => x.a)
    .slice(0, 80);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [search, open]);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const pick = (a: Account) => {
    onChange(a.id);
    setOpen(false);
    setSearch("");
  };
  const label = (a: Account) => (hideCode ? a.name : `${a.code} · ${a.name}`);
  const labelledBy = useFieldLabelledBy({ "aria-label": ariaLabel });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} aria-label={ariaLabel} aria-labelledby={labelledBy} className="w-full justify-between font-normal">
          <span className={cn("truncate", !selected && "text-muted-foreground")}>{selected ? label(selected) : placeholder ?? t("Choose account", "Choisir le compte")}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[260px] max-w-[calc(100vw-2rem)] p-2" align="start">
        <Input
          autoFocus
          placeholder={hideCode ? t("Search", "Chercher") : t("Search name or number", "Chercher nom ou numéro")}
          aria-label={t("Search accounts", "Chercher un compte")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={filtered[active] ? `${listId}-${filtered[active].id}` : undefined}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && filtered[active]) {
              e.preventDefault();
              pick(filtered[active]);
            }
          }}
        />
        <div ref={listRef} id={listId} className="mt-2 max-h-64 overflow-y-auto" role="listbox">
          {filtered.map((a, i) => (
            <button
              key={a.id}
              type="button"
              id={`${listId}-${a.id}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              className={cn("flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted", i === active && "bg-muted")}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(a)}
            >
              <span className="min-w-0 truncate">{a.name}</span>
              <span className="flex shrink-0 items-center gap-1">
                {!hideCode && <span className="text-xs text-muted-foreground tabular">{a.code}</span>}
                {a.id === value && <Check className="h-4 w-4" />}
              </span>
            </button>
          ))}
          {filtered.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">{t("No match", "Aucun résultat")}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function useLocations() {
  return useQuery<Location[]>({ queryKey: ["/api/locations"] });
}

export function LocationSelect({ value, onChange, excludeId, "aria-label": ariaLabel }: { value: number | null; onChange: (id: number) => void; excludeId?: number; "aria-label"?: string }) {
  const t = useT();
  const { data = [] } = useLocations();
  useEffect(() => {
    const active = data.filter((l) => l.active && l.id !== excludeId && (!l.parentId || data.some((p) => p.id === l.parentId && p.active)));
    if (!value && active.length) onChange(active[0].id);
  }, [data, value, onChange, excludeId]);
  return (
    <Select value={value ? String(value) : ""} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger aria-label={ariaLabel ?? t("Location", "Lieu")}><SelectValue /></SelectTrigger>
      <SelectContent>
        {data.filter((l) => l.active && l.id !== excludeId && (!l.parentId || data.some((p) => p.id === l.parentId && p.active))).map((l) => (
          <SelectItem key={l.id} value={String(l.id)}>{l.parentId ? `${data.find((p) => p.id === l.parentId)?.name ?? ""} / ` : ""}{l.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CategorySelect({ value, onChange, allowAll }: { value: number | null; onChange: (id: number | null) => void; allowAll?: boolean }) {
  const t = useT();
  const { data = [] } = useQuery<Category[]>({ queryKey: ["/api/categories"] });
  return (
    <Select value={value ? String(value) : "all"} onValueChange={(v) => onChange(v === "all" ? null : Number(v))}>
      {/* As a filter it stands alone, with no Field to name it. */}
      <SelectTrigger aria-label={allowAll ? t("Category", "Catégorie") : undefined}><SelectValue placeholder={t("Category", "Catégorie")} /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allowAll ? t("All categories", "Toutes les catégories") : t("No category", "Sans catégorie")}</SelectItem>
        {data.filter((c) => c.active).map((c) => (
          <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Display names per party type: [singular EN, singular FR, "new …" EN, "new …" FR] (French gender differs). */
export const PARTY_LABELS: Record<Party["type"], readonly [string, string, string, string]> = {
  customer: ["Customer", "Client", "New customer", "Nouveau client"],
  supplier: ["Supplier", "Fournisseur", "New supplier", "Nouveau fournisseur"],
  agent: ["Agent", "Agent", "New agent", "Nouvel agent"],
  employee: ["Employee", "Employé", "New employee", "Nouvel employé"],
};

/**
 * "Un client Garage Mwamba existe déjà": a contact typed again under the same name (case, accents and spaces aside)
 * or phone. Only a question: two people can share a name, so saving stays possible once confirmed.
 */
export function useDuplicateParty(name: string, phone: string | null | undefined, selfId?: number | null) {
  const t = useT();
  const q = useQuery<Party[]>({ queryKey: ["/api/parties"] });
  const found = q.data ? duplicateParty(q.data, { name, phone, selfId }) : null;
  if (!found) return null;
  const en = PARTY_LABELS[found.party.type][0].toLowerCase();
  const article = t(`${/^[aeiou]/.test(en) ? "An" : "A"} ${en}`, `Un ${PARTY_LABELS[found.party.type][1].toLowerCase()}`);
  return found.by === "name"
    ? t(`${article} ${found.party.name} already exists`, `${article} ${found.party.name} existe déjà`)
    : t(`${article} ${found.party.name} already has this phone number (${found.party.phone})`, `${article} ${found.party.name} a déjà ce numéro (${found.party.phone})`);
}

/** Asks before saving a contact that looks like one already there. */
export function DuplicatePartyAlert({ text, open, onCancel, onConfirm }: { text: string | null; open: boolean; onCancel: () => void; onConfirm: () => void }) {
  const t = useT();
  return (
    <AlertDialog open={open && !!text} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Same contact twice?", "Même contact en double\u00a0?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {text}. {t("Use the existing one, unless this really is someone else.", "Utilisez celui qui existe, sauf s'il s'agit vraiment d'une autre personne.")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Go back", "Revenir")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t("Save anyway", "Enregistrer quand même")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * "nous doit 52,00 $", "nous devons 1 450,00 $", "soldé": a contact's balance (debit-positive) in a few words.
 * A customer who paid ahead holds an avoir, said so as the till and the sale page say it: "avoir 17,00 $".
 */
function partyBalanceText(t: (en: string, fr: string) => string, balance: string | undefined, type?: Party["type"]): string | null {
  if (balance === undefined) return null;
  const b = d(balance);
  if (b.isZero()) return t("settled", "soldé");
  if (type === "customer" && b.isNegative()) return t(`credit ${usd(b.abs().toFixed(2))}`, `avoir ${usd(b.abs().toFixed(2))}`);
  return b.isPositive() ? t(`owes us ${usd(b.toFixed(2))}`, `nous doit ${usd(b.toFixed(2))}`) : t(`we owe ${usd(b.abs().toFixed(2))}`, `nous devons ${usd(b.abs().toFixed(2))}`);
}

/** Searchable customer / supplier / agent / employee picker with quick add. */
export function PartySelect({
  types,
  value,
  onChange,
  placeholder,
  allowCreate = true,
  "aria-label": ariaLabel,
}: {
  types: Party["type"][];
  value: number | null;
  onChange: (id: number | null, party?: Party) => void;
  placeholder?: string;
  allowCreate?: boolean;
  /** Defaults to the kind of contact ("Client"), so a screen reader names the field. */
  "aria-label"?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const q = useQuery<Party[]>({ queryKey: ["/api/parties"] });
  const rows = (q.data ?? []).filter((p) => types.includes(p.type) && p.active);
  const selected = rows.find((p) => p.id === value);
  const filtered = rows.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()) || (p.phone ?? "").includes(search)).slice(0, 50);
  // The highlighted row: Enter picks it, the arrow keys move it. The first match is highlighted as soon as one types.
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [search, open]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const pick = (p: Party) => {
    onChange(p.id, p);
    setOpen(false);
    setSearch("");
  };
  return (
    <>
      {/* Opened, the list is read again: the balances shown beside the choice are today's, not the cached ones. */}
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) void q.refetch(); }}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={`${ariaLabel ?? (types.length ? t(PARTY_LABELS[types[0]][0], PARTY_LABELS[types[0]][1]) : t("Contact", "Contact"))}${selected ? `${t(":", "\u00a0:")} ${selected.name}` : ""}`}
            className="w-full justify-between font-normal"
          >
            <span className={cn("truncate", !selected && "text-muted-foreground")}>{selected ? selected.name : placeholder ?? t("Choose…", "Choisir…")}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[260px] max-w-[calc(100vw-2rem)] p-2" align="start">
          <Input
            autoFocus
            placeholder={t("Search name or phone", "Chercher nom ou téléphone")}
            aria-label={t("Search name or phone", "Chercher nom ou téléphone")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            role="combobox"
            aria-expanded
            aria-activedescendant={filtered[active] ? `party-opt-${filtered[active].id}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && filtered[active]) {
                e.preventDefault();
                pick(filtered[active]);
              }
            }}
          />
          <div ref={listRef} className="mt-2 max-h-64 overflow-y-auto" role="listbox">
            {value && (
              <button className="w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted" onClick={() => { onChange(null); setOpen(false); }}>
                {t("Clear", "Effacer")}
              </button>
            )}
            {filtered.map((p, i) => (
              <button
                key={p.id}
                id={`party-opt-${p.id}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                className={cn("flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted", i === active && "bg-muted")}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(p)}
              >
                <span className="min-w-0">
                  <span className="block truncate">{p.name}</span>
                  {/* Who it is and where they stand, so two "Bahati" (a customer, an employee) read apart. */}
                  <span className="block text-xs text-muted-foreground tabular" data-testid="party-opt-info">
                    {[types.length > 1 ? t(PARTY_LABELS[p.type][0], PARTY_LABELS[p.type][1]) : null, partyBalanceText(t, p.balance, p.type), p.phone].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {p.id === value && <Check className="h-4 w-4 shrink-0" />}
              </button>
            ))}
            {filtered.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">{t("No match", "Aucun résultat")}</p>}
          </div>
          {allowCreate && (
            <Button variant="ghost" size="sm" className="mt-1 w-full justify-start" onClick={() => { setOpen(false); setCreating(true); }}>
              <Plus className="mr-1 h-4 w-4" /> {t("Add new", "Ajouter")}
            </Button>
          )}
        </PopoverContent>
      </Popover>
      {creating && (
        <QuickPartyDialog
          type={types[0]}
          initialName={search}
          onClose={() => setCreating(false)}
          onCreated={(p) => { onChange(p.id, p); setCreating(false); }}
        />
      )}
    </>
  );
}

function QuickPartyDialog({ type, initialName, onClose, onCreated }: { type: Party["type"]; initialName: string; onClose: () => void; onCreated: (p: Party) => void }) {
  const t = useT();
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const label = PARTY_LABELS[type];
  const duplicate = useDuplicateParty(name, phone);
  const [askDuplicate, setAskDuplicate] = useState(false);
  async function save(confirmed = false) {
    if (duplicate && !confirmed) return setAskDuplicate(true);
    setAskDuplicate(false);
    setSaving(true);
    setError(null);
    try {
      const p = await api<Party>("POST", "/api/parties", { type, name, phone: phone || null });
      await invalidateAll();
      onCreated({ ...p, balance: "0.00" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t(label[2], label[3])}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label={t("Name", "Nom")} error={error}><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t("Phone", "Téléphone")}><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></Field>
          {duplicate && <p className="text-sm text-amber-800 dark:text-amber-400" data-testid="party-duplicate">{duplicate}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <Button onClick={() => save()} disabled={!name.trim() || saving}>{t("Save", "Enregistrer")}</Button>
        </DialogFooter>
      </DialogContent>
      <DuplicatePartyAlert text={duplicate} open={askDuplicate} onCancel={() => setAskDuplicate(false)} onConfirm={() => save(true)} />
    </Dialog>
  );
}

/**
 * Search items by name, SKU, barcode or size. Pressing Enter on an exact barcode picks it
 * straight away, so a USB scanner works.
 */
export function VariantSearch({
  onPick,
  locationId,
  placeholder,
  autoFocus,
  showCost,
}: {
  onPick: (v: VariantRow) => void;
  locationId?: number | null;
  placeholder?: string;
  autoFocus?: boolean;
  showCost?: boolean;
}) {
  const t = useT();
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(term.trim()), 150);
    return () => clearTimeout(id);
  }, [term]);
  const q = useQuery<VariantRow[]>({
    queryKey: ["/api/variants", { search: debounced, locationId: locationId ?? undefined, limit: 30 }],
    enabled: debounced.length > 0,
  });
  const rows = useMemo(() => q.data ?? [], [q.data]);
  useEffect(() => setActive(0), [rows]);

  function pick(v: VariantRow) {
    onPick(v);
    setTerm("");
    setDebounced("");
    setOpen(false);
    inputRef.current?.focus();
  }

  async function onEnter() {
    const exact = term.trim();
    if (!exact) return;
    if (rows.length && debounced === exact) return pick(rows[active] ?? rows[0]);
    // Scanner typed faster than the debounce: look the code up directly.
    const found = await api<VariantRow[]>("GET", withQuery("/api/variants", { search: exact, locationId: locationId ?? undefined, limit: 5 }));
    const hit = found.find((v) => v.barcode === exact || v.sku === exact.toUpperCase() || v.matchedUnit?.chassisNo?.toUpperCase() === exact.toUpperCase()) ?? (found.length === 1 ? found[0] : null);
    if (hit) pick(hit);
    else setOpen(true);
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        autoFocus={autoFocus}
        className="pl-9"
        placeholder={placeholder ?? t("Scan or type an item", "Scanner ou taper un article")}
        aria-label={placeholder ?? t("Scan or type an item", "Scanner ou taper un article")}
        value={term}
        onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void onEnter(); }
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && debounced && (
        <div className="absolute z-50 mt-1 max-h-80 w-full overflow-y-auto rounded-md border bg-popover shadow-lg">
          {rows.length === 0 && !q.isFetching && <p className="p-3 text-sm text-muted-foreground">{t("Nothing found", "Rien trouvé")}</p>}
          {rows.map((v, i) => (
            <button
              key={v.matchedUnit ? `unit-${v.matchedUnit.id}` : v.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(v)}
              className={cn("flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted", i === active && "bg-muted")}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{v.productName}{v.label !== "Standard" ? ` · ${v.label}` : ""}</span>
                {/* A bike found by its chassis number says which one. */}
                {v.matchedUnit ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {t("Chassis", "Châssis")} <span className="font-mono">{v.matchedUnit.chassisNo}</span>
                    {v.matchedUnit.engineNo ? ` · ${t("engine", "moteur")} ${v.matchedUnit.engineNo}` : ""}{v.matchedUnit.color ? ` · ${v.matchedUnit.color}` : ""}
                  </span>
                ) : (
                  <span className="block truncate text-xs text-muted-foreground">{v.sku}{v.barcode ? ` · ${v.barcode}` : ""}{v.categoryName ? ` · ${v.categoryName}` : ""}</span>
                )}
              </span>
              <span className="shrink-0 text-right text-xs">
                <span className="block font-medium">{usd(v.sellPrice)}</span>
                <span className={cn("block", Number(v.locationQty) <= 0 ? "text-destructive" : "text-muted-foreground")}>
                  {t("Stock", "Stock")} {fmtQty(v.locationQty)}{showCost ? ` · ${t("cost", "coût")} ${usd(v.avgCost)}` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Month picker ("YYYY-MM"): next month plus the last 24, in the current language.
 * Replaces <input type="month">, which Safari and Firefox desktop do not support.
 */
/**
 * A month from the list. By default next month back to two years ago; `max` and `min` ("2026-10")
 * narrow it, e.g. to months that have ended or that have entries.
 */
export function MonthSelect({
  value,
  onChange,
  className,
  min,
  max,
  disabledReason,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (month: string) => void;
  className?: string;
  min?: string | null;
  max?: string | null;
  /** Why a month cannot be chosen (shown next to it, greyed out), or null when it can. */
  disabledReason?: (month: string) => string | null;
  "aria-label"?: string;
}) {
  const { lang } = useI18n();
  const options = useMemo(() => {
    const [y, m] = todayLocal().split("-").map(Number);
    const list: { value: string; label: string }[] = [];
    for (let i = 1; i >= -24; i--) {
      const dt = new Date(Date.UTC(y, m - 1 + i, 1));
      const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
      if ((max && key > max) || (min && key < min)) continue;
      list.push({ value: key, label: capitalize(monthText(key, lang)) });
    }
    // Keep an older month chosen elsewhere (e.g. from a link) selectable.
    if (value && !list.some((o) => o.value === value)) list.push({ value, label: capitalize(monthText(value, lang)) });
    return list;
  }, [lang, value, min, max]);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className} aria-label={ariaLabel}><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map((o) => {
          const reason = o.value === value ? null : disabledReason?.(o.value) ?? null;
          return (
            <SelectItem key={o.value} value={o.value} disabled={!!reason} extra={reason && <span className="ml-auto pl-3 text-xs">{reason}</span>}>
              {o.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/**
 * CDF per USD for a date (that day's rate, else the latest before it, else the default). `live` checks it
 * again every minute, for a page left open while the owner may change the rate (the till).
 */
export function useRate(date: string, opts: { live?: boolean } = {}) {
  return useQuery<{ date: string; cdfPerUsd: string; source: string; cnyPerUsd?: string | null }>({
    queryKey: [`/api/exchange-rates/for/${date}`],
    ...(opts.live ? { refetchInterval: 60_000 } : {}),
  });
}

// The container rate helpers live with the formatters (tested there); re-exported for the pages that import them here.
export { perUsdText, usdPerUnit } from "@/lib/format";

/**
 * The rate of a container invoiced in yuan or francs, typed the way the dashboard's rate card asks for it:
 * how many CNY (or FC) one dollar buys. The value passed in and out stays USD per 1 unit, as the
 * server keeps it. A new container starts from the rate on file, and a rate far from it is flagged.
 */
export function ContainerRateField({ currency, value, onChange, day = todayLocal(), className }: { currency: string; value: string; onChange: (rateToUsd: string) => void; day?: string; className?: string }) {
  const t = useT();
  const rateQ = useRate(day);
  const settings = useQuery<Settings>({ queryKey: ["/api/settings"] }).data;
  const onFile = currency === "CNY" ? rateQ.data?.cnyPerUsd ?? null : currency === "CDF" ? rateQ.data?.cdfPerUsd ?? null : null;
  const [text, setText] = useState(() => perUsdText(value));
  // Start from the rate on file when nothing is set yet.
  useEffect(() => {
    if (!text && !d(value).gt(0) && onFile && d(onFile).gt(0)) {
      setText(d(onFile).toString());
      onChange(usdPerUnit(onFile));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onFile]);
  const label = currency === "CDF" ? "FC" : currency;
  const typed = d(text);
  const tolerance = d(settings?.rateTolerancePct ?? "3");
  const gap = onFile && d(onFile).gt(0) && typed.gt(0) ? typed.minus(onFile).abs().dividedBy(onFile).times(100) : null;
  const far = gap !== null && gap.gt(tolerance);
  const refused = rateQ.data ? containerRateRefusal(t, currency, value, onFile, settings?.rateTolerancePct) : null;
  return (
    <Field
      className={className}
      label={t(`${label} for $1`, `${label} pour 1\u00a0$`)}
      required
      error={text && !typed.gt(0) ? t("Enter a rate above zero", "Saisissez un taux supérieur à zéro") : refused}
      hint={
        refused ? null : far ? (
          <span className="font-medium text-amber-800 dark:text-amber-400">
            {t(
              `Far from the rate on file ($1 = ${fmtQty(onFile)} ${label}, ${gap!.toDecimalPlaces(0).toString()}% apart): check the invoice`,
              `Loin du taux enregistré (1\u00a0$ = ${fmtQty(onFile)}\u00a0${label}, ${fmtQty(gap!.toDecimalPlaces(0).toString())}\u00a0% d'écart)\u00a0: vérifiez la facture`,
            )}
          </span>
        ) : onFile ? (
          t(`Rate on file: $1 = ${fmtQty(onFile)} ${label}`, `Taux enregistré\u00a0: 1\u00a0$ = ${fmtQty(onFile)}\u00a0${label}`)
        ) : currency === "CNY" ? (
          t("No yuan rate on file yet (about 7.1 CNY for $1); it can be entered on the dashboard", "Pas encore de taux du yuan (environ 7,1 CNY pour 1 $)\u00a0; il se saisit sur le tableau de bord")
        ) : null
      }
    >
      <Input
        inputMode="decimal"
        // A franc rate has no decimals worth typing: "2.808" is 2 808 FC, as at the till.
        thousands={currency === "CDF"}
        rate
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(usdPerUnit(e.target.value));
        }}
      />
    </Field>
  );
}

/** Why the server would refuse a container's rate (see containerRateRefusal), for the form's button to give too. */
export function useContainerRateRefusal(currency: string, rateToUsd: string, day: string = todayLocal()): string | null {
  const t = useT();
  const rate = useRate(day).data;
  const settings = useQuery<Settings>({ queryKey: ["/api/settings"] }).data;
  const onFile = currency === "CNY" ? rate?.cnyPerUsd ?? null : currency === "CDF" ? rate?.cdfPerUsd ?? null : null;
  // Until the day's rate has loaded, nothing is said: the server still checks it.
  if (!rate) return null;
  return containerRateRefusal(t, currency, rateToUsd, onFile, settings?.rateTolerancePct);
}

/**
 * Rate input state prefilled from the date's rate until the user edits it (a reload never overwrites a typed rate).
 * Checked again every minute, as at the till: a dialog left open follows a day's rate changed meanwhile, which
 * the server takes from staff in its place.
 */
export function useRateField(day: string) {
  const rateQ = useRate(day, { live: true });
  const [rate, setRateState] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched && rateQ.data?.cdfPerUsd) setRateState(d(rateQ.data.cdfPerUsd).toString());
  }, [rateQ.data?.cdfPerUsd, touched]);
  return {
    rate,
    touched,
    setRate: (v: string) => {
      setRateState(v);
      setTouched(true);
    },
  };
}

/**
 * A paying account (or a bill's currency) changed to another currency: the amount typed is converted at the
 * day's rate, or cleared when it cannot be, so 6 000 $ do not stay as 6 000 FC. `note` says which, under the
 * account, until an amount is typed again (`clear`).
 */
export function useCurrencySwitch(day: string) {
  const t = useT();
  const dayRate = useRate(day).data?.cdfPerUsd;
  const [note, setNote] = useState<string | null>(null);
  return {
    note,
    clear: () => setNote(null),
    /** The amount to keep once `from` became `to`. */
    convert: (amount: string, from: string | null | undefined, to: string | null | undefined): string => {
      if (!from || !to || from === to || !amount.trim()) {
        setNote(null);
        return amount;
      }
      const converted = convertTypedAmount(amount, from, to, dayRate);
      setNote(convertedNote(t, to, dayRate, converted !== null));
      return converted ?? "";
    },
  };
}

/** The note `useCurrencySwitch` gives, as the forms show it under the account. */
export function CurrencySwitchNote({ note }: { note: string | null }) {
  return note ? <p className="mt-1 text-xs text-amber-800 dark:text-amber-400" role="status">{note}</p> : null;
}

/**
 * Why a typed franc rate cannot be saved: more than the tolerance from the day's rate, which the server
 * refuses. The reason RateInput shows under the field, for the form's button to give too. Null when it can.
 */
export function useRateTooFar(day: string, value: string): string | null {
  const t = useT();
  const dayRate = d(useRate(day).data?.cdfPerUsd);
  const tolerance = d(useQuery<Settings>({ queryKey: ["/api/settings"] }).data?.rateTolerancePct ?? "3");
  const r = d(value);
  if (!dayRate.gt(0) || !r.gt(0) || !r.minus(dayRate).abs().dividedBy(dayRate).times(100).gt(tolerance)) return null;
  return t(
    `More than ${tolerance.toString()}% from the day's rate (${fmtQty(dayRate.toString())}): change the day's rate first`,
    `Plus de ${tolerance.toString()}\u00a0% d'écart avec le taux du jour (${fmtQty(dayRate.toString())})\u00a0: modifiez d'abord le taux du jour`,
  );
}

/**
 * Rate input for a franc amount: starts at the day's rate, says how far a typed rate is from it,
 * and warns before the server refuses one outside the allowed gap. Cashiers cannot change it.
 */
/**
 * `ownerOnly`: the server takes the day's rate from anyone but the owner here (sales, vouchers, customer
 * payments), so a manager sees it as text too rather than a rate the books would not use.
 */
export function RateInput({ day, value, onChange, className, ownerOnly }: { day: string; value: string; onChange: (v: string) => void; className?: string; ownerOnly?: boolean }) {
  const t = useT();
  const { user } = useAuth();
  const dayQ = useRate(day);
  const dayRate = d(dayQ.data?.cdfPerUsd);
  const r = d(value);
  const tooFar = useRateTooFar(day, value);
  const readOnly = user?.role === "cashier" || (!!ownerOnly && user?.role !== "owner");
  return (
    <div className={cn("space-y-1", className)}>
      {readOnly ? (
        // A cashier cannot change the rate: plain text, out of the Tab order, not a field that looks wrong.
        <p className="flex h-9 items-center rounded-md bg-muted/60 px-3 text-sm tabular-nums" aria-label={t("Rate (FC per $1)", "Taux (FC pour 1 $)")}>
          {fmtQty(value)}{"\u00a0"}FC/$
        </p>
      ) : (
        <Input inputMode="decimal" thousands rate value={value} onChange={(e) => onChange(e.target.value)} aria-label={t("Rate (FC per $1)", "Taux (FC pour 1 $)")} />
      )}
      {dayRate.gt(0) && (
        <p className={cn("text-xs", tooFar ? "text-destructive" : "text-muted-foreground")}>
          {tooFar
            ?? (readOnly || r.equals(dayRate)
              ? t("Rate of the day", "Taux du jour")
              : t(`Day's rate: ${fmtQty(dayRate.toString())}`, `Taux du jour : ${fmtQty(dayRate.toString())}`))}
        </p>
      )}
    </div>
  );
}
