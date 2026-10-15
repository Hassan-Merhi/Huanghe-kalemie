import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Pencil, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PARTY_LABELS } from "@/components/pickers";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, StatCard, SubmitButton } from "@/components/common";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { useT, count } from "@/lib/i18n";
import { cdf, d, qty as fmtQty, usd } from "@/lib/format";
import type { Party } from "@/lib/types";
import { cn } from "@/lib/utils";

type PartyType = Party["type"];

/** Balance in plain words. Debit-positive: positive = they owe us, negative = we owe them. */
export interface ForeignBalance {
  currency: "CDF" | "CNY";
  native: string;
  usd: string;
}
/** "56 000 FC owed to them", "1 200 CNY they owe us"… Negative native = we owe the contact. */
export function foreignText(f: ForeignBalance, t: (en: string, fr: string) => string) {
  const amount = f.currency === "CDF" ? cdf(d(f.native).abs().toString()) : `${fmtQty(d(f.native).abs().toString())} CNY`;
  return d(f.native).isNegative() ? t(`${amount} owed to them`, `${amount} à leur payer`) : t(`${amount} they owe`, `${amount} qu'ils doivent`);
}


export function BalanceWords({ balance, className }: { balance: string; className?: string }) {
  const t = useT();
  const b = d(balance);
  if (b.isZero()) return <span className={cn("text-muted-foreground", className)}>{t("Settled", "Soldé")}</span>;
  if (b.isPositive()) {
    return <span className={cn("font-medium text-amber-700 dark:text-amber-400", className)}>{t(`owes us ${usd(b.toFixed(2))}`, `nous doit ${usd(b.toFixed(2))}`)}</span>;
  }
  return <span className={cn("font-medium text-blue-700 dark:text-blue-400", className)}>{t(`we owe ${usd(b.abs().toFixed(2))}`, `nous devons ${usd(b.abs().toFixed(2))}`)}</span>;
}

const COUNT_WORDS: Record<PartyType, [[string, string], [string, string]]> = {
  customer: [["customer", "customers"], ["client", "clients"]],
  supplier: [["supplier", "suppliers"], ["fournisseur", "fournisseurs"]],
  agent: [["agent", "agents"], ["agent", "agents"]],
  employee: [["employee", "employees"], ["employé", "employés"]],
};

export default function Contacts() {
  const t = useT();
  const { can, user } = useAuth();
  const [, navigate] = useLocation();
  const [type, setType] = useState<PartyType>("customer");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Party | "new" | null>(null);
  const q = useQuery<Party[]>({ queryKey: ["/api/parties", { type, search: search.trim() || undefined }] });
  const rows = q.data ?? [];

  const owedToUs = rows.reduce((s, r) => (d(r.balance).isPositive() ? s.plus(r.balance) : s), d(0));
  const weOwe = rows.reduce((s, r) => (d(r.balance).isNegative() ? s.plus(d(r.balance).abs()) : s), d(0));

  const labels: Record<PartyType, string> = {
    customer: t("Customers", "Clients"),
    supplier: t("Suppliers", "Fournisseurs"),
    agent: t("Agents", "Agents"),
    employee: t("Employees", "Employés"),
  };

  return (
    <div>
      <PageHeader
        title={t("Customers and suppliers", "Clients et fournisseurs")}
        description={t(
          "Who owes the shop and whom the shop owes. Agents are clearing agents, transporters and similar.",
          "Qui doit à la boutique et à qui la boutique doit. Les agents sont les transitaires, transporteurs, etc.",
        )}
        actions={
          can("manager") && (
            <Button onClick={() => setEditing("new")}>
              <Plus className="mr-1 h-4 w-4" /> {t("Add", "Ajouter")}
            </Button>
          )
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={type} onValueChange={(v) => setType(v as PartyType)}>
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="customer">{labels.customer}</TabsTrigger>
            {user?.role !== "cashier" && <TabsTrigger value="supplier">{labels.supplier}</TabsTrigger>}
            {user?.role !== "cashier" && <TabsTrigger value="agent">{labels.agent}</TabsTrigger>}
            {user?.role !== "cashier" && <TabsTrigger value="employee">{labels.employee}</TabsTrigger>}
          </TabsList>
        </Tabs>
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder={t("Search name or phone", "Chercher nom ou téléphone")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
        <StatCard label={t("Contacts", "Contacts")} value={rows.length} />
        <StatCard label={t("They owe us", "Ils nous doivent")} value={usd(owedToUs.toFixed(2))} />
        <StatCard label={t("We owe them", "Nous leur devons")} value={usd(weOwe.toFixed(2))} />
      </div>

      <ErrorText error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title={t("Nobody here yet", "Personne pour l'instant")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Name", "Nom")}</TableHead>
                    <TableHead>{t("Phone", "Téléphone")}</TableHead>
                    <TableHead className="text-right">{t("Balance", "Solde")}</TableHead>
                    {can("manager") && <TableHead className="w-10" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((p) => (
                    <TableRow key={p.id} className="cursor-pointer" onClick={() => navigate(`/contacts/${p.id}`)}>
                      <TableCell className="font-medium">
                        {p.name}
                        {!p.active && <Badge variant="secondary" className="ml-2">{t("Inactive", "Inactif")}</Badge>}
                        {type === "employee" && (p.position || p.monthlySalary) && (
                          <span className="block text-xs text-muted-foreground">
                            {[p.position, p.monthlySalary ? `${usd(p.monthlySalary)} / ${t("month", "mois")}` : null].filter(Boolean).join(" · ")}
                          </span>
                        )}
                        {p.notes && <span className="block max-w-xs truncate text-xs text-muted-foreground">{p.notes}</span>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{p.phone}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <BalanceWords balance={p.balance} />
                        {p.foreign?.map((f) => <span key={f.currency} className="block text-xs text-muted-foreground">{t("of which", "dont")} {foreignText(f, t)}</span>)}
                      </TableCell>
                      {can("manager") && (
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Button variant="ghost" size="icon" onClick={() => setEditing(p)} aria-label={t("Edit", "Modifier")}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2}>{t("Total", "Total")} · {count(t, rows.length, ...COUNT_WORDS[type])}</TableCell>
                    <TableCell className="text-right">
                      <Num>
                        <span className="block">{t("owed to us", "à recevoir")} {usd(owedToUs.toFixed(2))}</span>
                        <span className="block">{t("we owe", "à payer")} {usd(weOwe.toFixed(2))}</span>
                      </Num>
                    </TableCell>
                    {can("manager") && <TableCell />}
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {editing && <PartyDialog type={type} party={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

export function PartyDialog({ type, party, onClose }: { type: PartyType; party: Party | null; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(party?.name ?? "");
  const [phone, setPhone] = useState(party?.phone ?? "");
  const [notes, setNotes] = useState(party?.notes ?? "");
  const [active, setActive] = useState(party?.active ?? true);
  const [position, setPosition] = useState(party?.position ?? "");
  const [monthlySalary, setMonthlySalary] = useState(party?.monthlySalary ? d(party.monthlySalary).toString() : "");
  const [startDate, setStartDate] = useState(party?.startDate?.slice(0, 10) ?? "");
  const isEmployee = (party?.type ?? type) === "employee";
  const create = useApiMutation("POST", "/api/parties", { success: t("Saved", "Enregistré"), onSuccess: onClose });
  const update = useApiMutation("PATCH", `/api/parties/${party?.id}`, { success: t("Saved", "Enregistré"), onSuccess: onClose });
  const label = PARTY_LABELS[party?.type ?? type];
  const busy = create.isPending || update.isPending;

  function save() {
    const body: Record<string, unknown> = { name: name.trim(), phone: phone.trim() || null, notes: notes.trim() || null, active };
    if (isEmployee) {
      body.position = position.trim() || null;
      body.monthlySalary = monthlySalary.trim() ? d(monthlySalary).toFixed(2) : null;
      body.startDate = startDate || null;
    }
    if (party) update.mutate(body);
    else create.mutate({ ...body, type });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{party ? t(`Edit ${label[0].toLowerCase()}`, `Modifier ${label[1].toLowerCase()}`) : t(label[2], label[3])}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label={t("Name", "Nom")} required>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("Phone", "Téléphone")}>
            <Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          {isEmployee && (
            <>
              <Field label={t("Position", "Poste")}>
                <Input value={position} onChange={(e) => setPosition(e.target.value)} placeholder={t("e.g. Mechanic, Seller", "ex. Mécanicien, Vendeur")} />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t("Monthly salary (USD)", "Salaire mensuel (USD)")}>
                  <Input inputMode="decimal" value={monthlySalary} onChange={(e) => setMonthlySalary(e.target.value)} placeholder="0.00" />
                </Field>
                <Field label={t("Start date", "Date d'embauche")}>
                  <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </Field>
              </div>
            </>
          )}
          <Field label={t("Notes", "Notes")}>
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={active} onCheckedChange={setActive} /> {t("Active", "Actif")}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton onClick={save} blocked={!name.trim() && t("Enter a name", "Saisissez un nom")} pending={busy}>{t("Save", "Enregistrer")}</SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
