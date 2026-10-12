import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/common";
import { useI18n, useT } from "@/lib/i18n";
import { d, todayLocal, usd, qty as fmtQty } from "@/lib/format";
import { api, invalidateAll, withQuery } from "@/lib/api";
import type { Account, Category, Location, Party, VariantRow } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Cash boxes, bank and mobile money accounts. */
export function useMoneyAccounts() {
  const q = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  return { ...q, data: (q.data ?? []).filter((a) => a.isMoney && a.active) };
}

export function MoneyAccountSelect({ value, onChange, placeholder }: { value: number | null; onChange: (id: number, account: Account) => void; placeholder?: string }) {
  const t = useT();
  const { data } = useMoneyAccounts();
  return (
    <Select value={value ? String(value) : ""} onValueChange={(v) => { const a = data.find((x) => x.id === Number(v)); if (a) onChange(a.id, a); }}>
      <SelectTrigger><SelectValue placeholder={placeholder ?? t("Choose account", "Choisir le compte")} /></SelectTrigger>
      <SelectContent>
        {data.map((a) => (
          <SelectItem key={a.id} value={String(a.id)}>{a.name} ({a.currency})</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AccountSelect({ value, onChange, types, placeholder }: { value: number | null; onChange: (id: number) => void; types?: Account["type"][]; placeholder?: string }) {
  const t = useT();
  const q = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const rows = (q.data ?? []).filter((a) => a.active && (!types || types.includes(a.type)));
  return (
    <Select value={value ? String(value) : ""} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger><SelectValue placeholder={placeholder ?? t("Choose account", "Choisir le compte")} /></SelectTrigger>
      <SelectContent>
        {rows.map((a) => (
          <SelectItem key={a.id} value={String(a.id)}>{a.code} · {a.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function useLocations() {
  return useQuery<Location[]>({ queryKey: ["/api/locations"] });
}

export function LocationSelect({ value, onChange }: { value: number | null; onChange: (id: number) => void }) {
  const { data = [] } = useLocations();
  useEffect(() => {
    const active = data.filter((l) => l.active);
    if (!value && active.length) onChange(active[0].id);
  }, [data, value, onChange]);
  return (
    <Select value={value ? String(value) : ""} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        {data.filter((l) => l.active).map((l) => (
          <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
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
      <SelectTrigger><SelectValue placeholder={t("Category", "Catégorie")} /></SelectTrigger>
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

/** Searchable customer / supplier / agent / employee picker with quick add. */
export function PartySelect({
  types,
  value,
  onChange,
  placeholder,
  allowCreate = true,
}: {
  types: Party["type"][];
  value: number | null;
  onChange: (id: number | null, party?: Party) => void;
  placeholder?: string;
  allowCreate?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const q = useQuery<Party[]>({ queryKey: ["/api/parties"] });
  const rows = (q.data ?? []).filter((p) => types.includes(p.type) && p.active);
  const selected = rows.find((p) => p.id === value);
  const filtered = rows.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()) || (p.phone ?? "").includes(search)).slice(0, 50);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
            <span className={cn("truncate", !selected && "text-muted-foreground")}>{selected ? selected.name : placeholder ?? t("Choose…", "Choisir…")}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[260px] p-2" align="start">
          <Input autoFocus placeholder={t("Search name or phone", "Chercher nom ou téléphone")} value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="mt-2 max-h-64 overflow-y-auto">
            {value && (
              <button className="w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted" onClick={() => { onChange(null); setOpen(false); }}>
                {t("Clear", "Effacer")}
              </button>
            )}
            {filtered.map((p) => (
              <button key={p.id} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => { onChange(p.id, p); setOpen(false); }}>
                <span className="truncate">{p.name}{p.phone ? <span className="text-muted-foreground"> · {p.phone}</span> : null}</span>
                {p.id === value && <Check className="h-4 w-4" />}
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
  async function save() {
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <Button onClick={save} disabled={!name.trim() || saving}>{t("Save", "Enregistrer")}</Button>
        </DialogFooter>
      </DialogContent>
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
    const hit = found.find((v) => v.barcode === exact || v.sku === exact.toUpperCase()) ?? (found.length === 1 ? found[0] : null);
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
        placeholder={placeholder ?? t("Scan barcode or search item, size, SKU", "Scanner ou chercher article, taille, code")}
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
              key={v.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(v)}
              className={cn("flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted", i === active && "bg-muted")}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{v.productName}{v.label !== "Standard" ? ` · ${v.label}` : ""}</span>
                <span className="block truncate text-xs text-muted-foreground">{v.sku}{v.barcode ? ` · ${v.barcode}` : ""}{v.categoryName ? ` · ${v.categoryName}` : ""}</span>
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
export function MonthSelect({ value, onChange, className }: { value: string; onChange: (month: string) => void; className?: string }) {
  const { lang } = useI18n();
  const options = useMemo(() => {
    const [y, m] = todayLocal().split("-").map(Number);
    const fmt = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    const list: { value: string; label: string }[] = [];
    for (let i = 1; i >= -24; i--) {
      const dt = new Date(Date.UTC(y, m - 1 + i, 1));
      const label = fmt.format(dt);
      list.push({ value: `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`, label: label.charAt(0).toUpperCase() + label.slice(1) });
    }
    // Keep an older month chosen elsewhere (e.g. from a link) selectable.
    if (value && !list.some((o) => o.value === value)) list.push({ value, label: value });
    return list;
  }, [lang, value]);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className}><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** CDF per USD for a date (that day's rate, else the latest before it, else the default). */
export function useRate(date: string) {
  return useQuery<{ date: string; cdfPerUsd: string; source: string }>({ queryKey: [`/api/exchange-rates/for/${date}`] });
}

/** Rate input state prefilled from the date's rate until the user edits it (a reload never overwrites a typed rate). */
export function useRateField(day: string) {
  const rateQ = useRate(day);
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
