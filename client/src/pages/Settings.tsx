import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Download, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader, SubmitButton } from "@/components/common";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth, type Role } from "@/lib/auth";
import { useI18n, useT, type Lang } from "@/lib/i18n";
import { cdf, d, date as fmtDate, money, usd } from "@/lib/format";
import type { Account, Category, Location, Partner, Settings as ShopSettings } from "@/lib/types";
import { accountTypeLabel } from "@/pages/Reports";
import { roleLabel } from "@/lib/labels";
import { journalTypeLabel } from "@/pages/ContactDetail";

type T = (en: string, fr: string) => string;

interface UserRow { id: number; username: string; fullName: string; role: Role; partnerId: number | null; language: Lang; active: boolean }
interface AuditRow { id: number; userId: number | null; username: string | null; fullName: string | null; action: string; entity: string; entityId: number | null; data: unknown; createdAt: string }

export default function Settings() {
  const t = useT();
  const [tab, setTab] = useState("shop");
  return (
    <div>
      <PageHeader title={t("Settings", "Paramètres")} description={t("Shop, users, places, categories, the chart of accounts, backups and the activity log.", "Boutique, utilisateurs, emplacements, catégories, plan comptable, sauvegardes et journal d'activité.")} />
      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto pb-1">
          <TabsList>
            <TabsTrigger value="shop">{t("Shop", "Boutique")}</TabsTrigger>
            <TabsTrigger value="users">{t("Users", "Utilisateurs")}</TabsTrigger>
            <TabsTrigger value="locations">{t("Locations", "Emplacements")}</TabsTrigger>
            <TabsTrigger value="categories">{t("Categories", "Catégories")}</TabsTrigger>
            <TabsTrigger value="accounts">{t("Chart of accounts", "Plan comptable")}</TabsTrigger>
            <TabsTrigger value="backup">{t("Backup", "Sauvegarde")}</TabsTrigger>
            <TabsTrigger value="audit">{t("Activity log", "Journal d'activité")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="shop"><ShopTab /></TabsContent>
        <TabsContent value="users"><UsersTab /></TabsContent>
        <TabsContent value="locations"><NamedListTab kind="locations" /></TabsContent>
        <TabsContent value="categories"><NamedListTab kind="categories" /></TabsContent>
        <TabsContent value="accounts"><AccountsTab /></TabsContent>
        <TabsContent value="backup"><BackupTab /></TabsContent>
        <TabsContent value="audit"><AuditTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------- Shop

function ShopTab() {
  const t = useT();
  const q = useQuery<ShopSettings>({ queryKey: ["/api/settings"] });
  const [shopName, setShopName] = useState("");
  const [rate, setRate] = useState("");
  const [footer, setFooter] = useState("");
  const [tolerance, setTolerance] = useState("3");
  const [cashierPct, setCashierPct] = useState("10");
  const [managerPct, setManagerPct] = useState("20");
  const [belowCost, setBelowCost] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setShopName(String(q.data.shopName ?? ""));
    setRate(String(q.data.defaultCdfRate ?? ""));
    setFooter(String(q.data.receiptFooter ?? ""));
    setTolerance(String(q.data.rateTolerancePct ?? "3"));
    setCashierPct(String(q.data.cashierDiscountPct ?? "10"));
    setManagerPct(String(q.data.managerDiscountPct ?? "20"));
    setBelowCost(q.data.managerBelowCost === true);
  }, [q.data]);
  const pctOk = (v: string) => /^\d{1,3}(\.\d{1,2})?$/.test(v.trim()) && Number(v) <= 100;
  const m = useApiMutation("PATCH", "/api/settings", { success: t("Settings saved", "Paramètres enregistrés") });
  const toleranceOk = /^\d{1,2}(\.\d{1,2})?$/.test(tolerance.trim());
  const pctError = (v: string) => (v.trim() && !pctOk(v) ? t("Enter a percentage from 0 to 100", "Saisissez un pourcentage de 0 à 100") : null);
  const blocked = !shopName.trim()
    ? t("Enter the shop name", "Saisissez le nom de la boutique")
    : !d(rate).gt(0)
      ? t("Enter a default rate above zero", "Saisissez un taux par défaut supérieur à zéro")
      : !toleranceOk
        ? t("Enter the allowed gap (0 to 99 %)", "Saisissez l'écart permis (0 à 99\u00a0%)")
        : !pctOk(cashierPct) || !pctOk(managerPct)
          ? t("Enter the biggest discounts (0 to 100 %)", "Saisissez les remises maximales (0 à 100\u00a0%)")
          : null;
  if (q.isLoading) return <Loading />;
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="text-base">{t("Shop", "Boutique")}</CardTitle>
        <CardDescription>{t("Shown on receipts and statements.", "Affiché sur les reçus et relevés.")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ErrorText error={q.error} />
        <Field label={t("Shop name", "Nom de la boutique")} required><Input value={shopName} onChange={(e) => setShopName(e.target.value)} /></Field>
        <Field
          label={t("Default CDF rate (CDF per 1 USD)", "Taux par défaut (FC pour 1 $)")}
          hint={q.data?.latestRate ? t(`Latest daily rate: ${cdf(q.data.latestRate.cdfPerUsd)} on ${fmtDate(q.data.latestRate.date)}. The default is used only for days before any daily rate.`, `Dernier taux du jour : ${cdf(q.data.latestRate.cdfPerUsd)} le ${fmtDate(q.data.latestRate.date)}. Le taux par défaut sert seulement s'il n'y a aucun taux du jour.`) : undefined}
          error={rate.trim() && !d(rate).gt(0) ? t("Enter a rate above zero", "Saisissez un taux supérieur à zéro") : null}
          required
        >
          <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
        <Field
          label={t("Allowed gap from the day's rate (%)", "Écart permis avec le taux du jour (%)")}
          hint={t("A franc amount typed with a rate further from the day's rate than this is refused.", "Un montant en francs saisi avec un taux plus éloigné du taux du jour est refusé.")}
          error={tolerance.trim() && !toleranceOk ? t("Enter a number from 0 to 99", "Saisissez un nombre de 0 à 99") : null}
          required
        >
          <Input inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Cashier: biggest discount (%)", "Caissier\u00a0: remise maximale (%)")} error={pctError(cashierPct)} required>
            <Input inputMode="decimal" value={cashierPct} onChange={(e) => setCashierPct(e.target.value)} />
          </Field>
          <Field label={t("Manager: biggest discount (%)", "Gérant\u00a0: remise maximale (%)")} error={pctError(managerPct)} required>
            <Input inputMode="decimal" value={managerPct} onChange={(e) => setManagerPct(e.target.value)} />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            "Measured on each line against the item's price. The owner has no limit. Nobody but the owner sells below cost unless allowed below.",
            "Calculée sur chaque ligne par rapport au prix de l'article. Le propriétaire n'a pas de limite. Personne d'autre que le propriétaire ne vend sous le coût, sauf autorisation ci-dessous.",
          )}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={belowCost} onCheckedChange={setBelowCost} /> {t("Managers may sell below cost", "Les gérants peuvent vendre sous le coût")}
        </label>
        <Field label={t("Receipt footer", "Pied de reçu")}><Textarea rows={3} maxLength={300} value={footer} onChange={(e) => setFooter(e.target.value)} /></Field>
        <div className="flex justify-end">
          <SubmitButton
            blocked={blocked}
            pending={m.isPending}
            onClick={() =>
              m.mutate({
                shopName: shopName.trim(),
                defaultCdfRate: d(rate).toString(),
                receiptFooter: footer,
                rateTolerancePct: tolerance.trim(),
                cashierDiscountPct: cashierPct.trim(),
                managerDiscountPct: managerPct.trim(),
                managerBelowCost: belowCost,
              })
            }
          >
            {t("Save", "Enregistrer")}
          </SubmitButton>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- Users

function UsersTab() {
  const t = useT();
  const q = useQuery<UserRow[]>({ queryKey: ["/api/users"] });
  const partnersQ = useQuery<Partner[]>({ queryKey: ["/api/partners"] });
  const [editing, setEditing] = useState<UserRow | "new" | null>(null);
  const rows = q.data ?? [];
  const partnerName = (id: number | null) => partnersQ.data?.find((p) => p.id === id)?.name;
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}><Plus className="mr-1 h-4 w-4" /> {t("Add user", "Ajouter un utilisateur")}</Button>
      </div>
      <ErrorText error={q.error} />
      {q.isLoading ? <Loading /> : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Username", "Identifiant")}</TableHead>
                    <TableHead>{t("Full name", "Nom complet")}</TableHead>
                    <TableHead>{t("Role", "Rôle")}</TableHead>
                    <TableHead>{t("Language", "Langue")}</TableHead>
                    <TableHead>{t("Status", "Statut")}</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="font-mono text-sm">{u.username}</TableCell>
                      <TableCell>{u.fullName}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {roleLabel(u.role, t)}
                        {u.role === "partner" && partnerName(u.partnerId) && <span className="block text-xs text-muted-foreground">{partnerName(u.partnerId)}</span>}
                      </TableCell>
                      <TableCell className="uppercase">{u.language}</TableCell>
                      <TableCell>{u.active ? <Badge variant="outline">{t("Active", "Actif")}</Badge> : <Badge variant="secondary">{t("Inactive", "Inactif")}</Badge>}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" onClick={() => setEditing(u)} aria-label={t("Edit", "Modifier")}><Pencil className="h-4 w-4" /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
      {editing && <UserDialog user={editing === "new" ? null : editing} partners={partnersQ.data ?? []} onClose={() => setEditing(null)} />}
    </div>
  );
}

function UserDialog({ user, partners, onClose }: { user: UserRow | null; partners: Partner[]; onClose: () => void }) {
  const t = useT();
  const { user: me } = useAuth();
  const [username, setUsername] = useState(user?.username ?? "");
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "cashier");
  const [partnerId, setPartnerId] = useState<number | null>(user?.partnerId ?? null);
  const [language, setLanguage] = useState<Lang>(user?.language ?? "fr");
  const [active, setActive] = useState(user?.active ?? true);
  const [password, setPassword] = useState("");
  const create = useApiMutation("POST", "/api/users", { success: t("User added", "Utilisateur ajouté"), onSuccess: onClose });
  const update = useApiMutation("PATCH", `/api/users/${user?.id}`, { success: t("User saved", "Utilisateur enregistré"), onSuccess: onClose });
  const isSelf = !!user && user.id === me?.id;

  const pwOk = user ? password === "" || password.length >= 8 : password.length >= 8;
  const usernameOk = /^[a-zA-Z0-9._-]{3,60}$/.test(username);
  const blocked = !username
    ? t("Enter a username", "Saisissez un identifiant")
    : !usernameOk
      ? t("Fix the username", "Corrigez l'identifiant")
      : !fullName.trim()
        ? t("Enter the full name", "Saisissez le nom complet")
        : role === "partner" && !partnerId
          ? t("Choose the partner", "Choisissez l'associé")
          : !pwOk
            ? password ? t("The password needs at least 8 characters", "Le mot de passe doit faire au moins 8 caractères") : t("Enter a password", "Saisissez un mot de passe")
            : null;

  function save() {
    const body = {
      username,
      fullName: fullName.trim(),
      role,
      partnerId: role === "partner" ? partnerId : null,
      language,
      ...(password ? { password } : {}),
    };
    if (user) update.mutate({ ...body, active });
    else create.mutate(body);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{user ? t("Edit user", "Modifier l'utilisateur") : t("New user", "Nouvel utilisateur")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label={t("Username", "Identifiant")}
            hint={t("Letters, numbers, dot, dash", "Lettres, chiffres, point, tiret")}
            error={username && !usernameOk ? t("3 to 60 letters, numbers, dots or dashes", "3 à 60 lettres, chiffres, points ou tirets") : null}
            required
          >
            <Input value={username} onChange={(e) => setUsername(e.target.value.trim())} autoCapitalize="none" />
          </Field>
          <Field label={t("Full name", "Nom complet")} required><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
          <Field label={t("Role", "Rôle")}>
            <Select value={role} onValueChange={(v) => setRole(v as Role)} disabled={isSelf}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["owner", "manager", "cashier", "partner"] as Role[]).map((r) => <SelectItem key={r} value={r}>{roleLabel(r, t)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("Language", "Langue")}>
            <Select value={language} onValueChange={(v) => setLanguage(v as Lang)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="fr">Français</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {role === "partner" && (
            <Field label={t("Partner", "Associé")} className="sm:col-span-2" required hint={t("Read-only access to the whole business, linked to this partner.", "Accès en lecture seule à toute l'activité, rattaché à cet associé.")}>
              <Select value={partnerId ? String(partnerId) : ""} onValueChange={(v) => setPartnerId(Number(v))}>
                <SelectTrigger><SelectValue placeholder={t("Choose partner", "Choisir l'associé")} /></SelectTrigger>
                <SelectContent>
                  {partners.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field
            label={user ? t("New password (leave empty to keep)", "Nouveau mot de passe (vide = inchangé)") : t("Password", "Mot de passe")}
            className="sm:col-span-2"
            error={password && password.length < 8 ? t("At least 8 characters", "Au moins 8 caractères") : null}
            required={!user}
          >
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {user && (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={active} onCheckedChange={setActive} disabled={isSelf} /> {t("Can log in", "Peut se connecter")}
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton blocked={blocked} pending={create.isPending || update.isPending} onClick={save}>{t("Save", "Enregistrer")}</SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Locations & categories

function NamedListTab({ kind }: { kind: "locations" | "categories" }) {
  const t = useT();
  const url = `/api/${kind}`;
  const q = useQuery<(Location | Category)[]>({ queryKey: [url] });
  const [editing, setEditing] = useState<Location | Category | "new" | null>(null);
  const rows = q.data ?? [];
  const toggle = useApiMutation<{ id: number; active: boolean; parentId?: number | null }>("PATCH", (b) => `${url}/${b.id}`, { success: t("Saved", "Enregistré") });
  const title = kind === "locations" ? t("Locations (shop, warehouse…)", "Emplacements (boutique, dépôt…)") : t("Item categories", "Catégories d'articles");
  return (
    <Card className="max-w-2xl">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <Button size="sm" onClick={() => setEditing("new")}><Plus className="mr-1 h-4 w-4" /> {t("Add", "Ajouter")}</Button>
      </CardHeader>
      <CardContent className="p-0">
        <ErrorText error={q.error} />
        {q.isLoading ? <Loading /> : rows.length === 0 ? <div className="p-4"><EmptyState title={t("Nothing yet", "Rien pour l'instant")} /></div> : (
          <Table>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    {r.name}
                    {!r.active && <Badge variant="secondary" className="ml-2">{t("Inactive", "Inactif")}</Badge>}
                  </TableCell>
                  <TableCell className="w-48 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Switch
                        checked={r.active}
                        aria-label={t("Active", "Actif")}
                        onCheckedChange={(v) => toggle.mutate({ id: r.id, active: v, ...("parentId" in r ? { parentId: r.parentId } : {}) })}
                      />
                      <Button variant="ghost" size="icon" onClick={() => setEditing(r)} aria-label={t("Rename", "Renommer")}><Pencil className="h-4 w-4" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {editing && <NameDialog url={url} row={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function NameDialog({ url, row, onClose }: { url: string; row: Location | Category | null; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(row?.name ?? "");
  const create = useApiMutation("POST", url, { success: t("Saved", "Enregistré"), onSuccess: onClose });
  const update = useApiMutation("PATCH", `${url}/${row?.id}`, { success: t("Saved", "Enregistré"), onSuccess: onClose });
  function save() {
    // Categories: send the existing parent so the rename does not clear it.
    const extra = row && "parentId" in row ? { parentId: row.parentId } : {};
    if (row) update.mutate({ name: name.trim(), ...extra });
    else create.mutate({ name: name.trim() });
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{row ? t("Rename", "Renommer") : t("Add", "Ajouter")}</DialogTitle></DialogHeader>
        <Field label={t("Name", "Nom")} required><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && save()} /></Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton blocked={!name.trim() && t("Enter a name", "Saisissez un nom")} pending={create.isPending || update.isPending} onClick={save}>{t("Save", "Enregistrer")}</SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Chart of accounts

const ACCOUNT_TYPES: Account["type"][] = ["asset", "liability", "equity", "income", "cost_of_sales", "expense"];

function AccountsTab() {
  const t = useT();
  const q = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const rows = (q.data ?? []).filter((a) => showInactive || a.active);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm"><Switch checked={showInactive} onCheckedChange={setShowInactive} /> {t("Show inactive", "Afficher les inactifs")}</label>
        <Button onClick={() => setEditing("new")}><Plus className="mr-1 h-4 w-4" /> {t("Add account", "Ajouter un compte")}</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(
          "Add a running cost (e.g. “Security guard”) as type Running cost, or a new mobile money wallet as an Asset with “money account” on.",
          "Ajoutez un frais (ex. « Gardiennage ») avec le type Charge de fonctionnement, ou un nouveau portefeuille mobile money comme Actif avec « compte d'argent » activé.",
        )}
      </p>
      <ErrorText error={q.error} />
      {q.isLoading ? <Loading /> : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Code", "Code")}</TableHead>
                    <TableHead>{t("Name", "Nom")}</TableHead>
                    <TableHead>{t("Type", "Type")}</TableHead>
                    <TableHead>{t("Money", "Argent")}</TableHead>
                    <TableHead className="text-right">{t("Balance", "Solde")}</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="font-mono text-xs">{a.code}</TableCell>
                      <TableCell className="min-w-[180px]">
                        {a.name}
                        {a.systemKey && <Badge variant="outline" className="ml-2">{t("System", "Système")}</Badge>}
                        {!a.active && <Badge variant="secondary" className="ml-2">{t("Inactive", "Inactif")}</Badge>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{accountTypeLabel(a.type, t)}</TableCell>
                      <TableCell>{a.isMoney ? <Badge variant="outline">{a.currency === "CDF" ? "FC" : a.currency}</Badge> : ""}</TableCell>
                      <TableCell className="text-right">
                        <Num>{usd(a.balance)}</Num>
                        {a.isMoney && a.currency === "CDF" && <Num className="block text-xs text-muted-foreground">{money(a.nativeBalance, "CDF")}</Num>}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" onClick={() => setEditing(a)} aria-label={t("Edit", "Modifier")}><Pencil className="h-4 w-4" /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
      {editing && <AccountDialog account={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AccountDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const t = useT();
  const [code, setCode] = useState(account?.code ?? "");
  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<Account["type"]>(account?.type ?? "expense");
  const [isMoney, setIsMoney] = useState(account?.isMoney ?? false);
  const [currency, setCurrency] = useState<"USD" | "CDF">(account?.currency ?? "USD");
  const [active, setActive] = useState(account?.active ?? true);
  const create = useApiMutation("POST", "/api/accounts", { success: t("Account added", "Compte ajouté"), onSuccess: onClose });
  const update = useApiMutation("PATCH", `/api/accounts/${account?.id}`, { success: t("Account saved", "Compte enregistré"), onSuccess: onClose });
  const isSystem = !!account?.systemKey;

  function save() {
    if (account) update.mutate({ name: name.trim(), ...(isSystem ? {} : { active }) });
    else create.mutate({ code: code.trim(), name: name.trim(), type, isMoney: type === "asset" && isMoney, currency: type === "asset" && isMoney ? currency : "USD" });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{account ? t("Edit account", "Modifier le compte") : t("New account", "Nouveau compte")}</DialogTitle>
          {account && (
            <DialogDescription>
              {isSystem
                ? t("The app posts to this account automatically: it can be renamed but not switched off.", "L'application utilise ce compte automatiquement\u00a0: il peut être renommé mais pas désactivé.")
                : t("Code, type and currency cannot change once the account exists.", "Le code, le type et la devise ne changent plus une fois le compte créé.")}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
          <Field label={t("Code", "Code")} required={!account}><Input value={code} onChange={(e) => setCode(e.target.value)} disabled={!!account} placeholder="6150" /></Field>
          <Field label={t("Name", "Nom")} required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t("Type", "Type")} className="sm:col-span-2">
            <Select value={type} onValueChange={(v) => setType(v as Account["type"])} disabled={!!account}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ACCOUNT_TYPES.map((x) => <SelectItem key={x} value={x}>{accountTypeLabel(x, t)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          {type === "asset" && (
            <div className="space-y-2 sm:col-span-2">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={isMoney} onCheckedChange={setIsMoney} disabled={!!account} />
                {t("Money account (cash box, bank, mobile money)", "Compte d'argent (caisse, banque, mobile money)")}
              </label>
              {isMoney && (
                <Field label={t("Currency", "Devise")}>
                  <Select value={currency} onValueChange={(v) => setCurrency(v as "USD" | "CDF")} disabled={!!account}>
                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="CDF">CDF</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
          )}
          {type === "expense" && !account && (
            <p className="text-xs text-muted-foreground sm:col-span-2">
              {t("Running costs are charged only to the partner who pays the shop running costs at month close.", "Les frais de fonctionnement sont imputés uniquement à l'associé qui les supporte, à la clôture du mois.")}
            </p>
          )}
          {account && !isSystem && (
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Switch checked={active} onCheckedChange={setActive} /> {t("Active", "Actif")}
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton
            blocked={!account && !code.trim() ? t("Enter a code", "Saisissez un code") : !name.trim() && t("Enter a name", "Saisissez un nom")}
            pending={create.isPending || update.isPending}
            onClick={save}
          >
            {t("Save", "Enregistrer")}
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Backup

function BackupTab() {
  const t = useT();
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="text-base">{t("Backup", "Sauvegarde")}</CardTitle>
        <CardDescription>
          {t(
            "Download a file with all the data. Keep a copy every week on a USB key or a phone.",
            "Téléchargez un fichier avec toutes les données. Gardez-en une copie chaque semaine sur une clé USB ou un téléphone.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline">
          <a href="/api/backup" download>
            <Download className="mr-1 h-4 w-4" /> {t("Download a backup", "Télécharger une sauvegarde")}
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- Activity log

const ACTION_LABELS: Record<string, [string, string]> = {
  post: ["Posted", "Comptabilisé"],
  reverse: ["Reversed", "Contre-passé"],
  create: ["Created", "Créé"],
  update: ["Changed", "Modifié"],
  delete: ["Deleted", "Supprimé"],
  void: ["Cancelled", "Annulé"],
  cancel: ["Cancelled", "Annulé"],
  return: ["Return", "Retour"],
  set_rate: ["Rate set", "Taux fixé"],
  import: ["Imported", "Importé"],
  finalize: ["Posted", "Validé"],
  close: ["Closed", "Clôturé"],
  reopen: ["Reopened", "Rouvert"],
  update_lines: ["Lines changed", "Lignes modifiées"],
  add_cost: ["Cost added", "Frais ajouté"],
  update_cost: ["Cost changed", "Frais modifié"],
  remove_cost: ["Cost removed", "Frais retiré"],
  login: ["Signed in", "Connexion"],
};

const ENTITY_LABELS: Record<string, [string, string]> = {
  exchange_rate: ["Exchange rate", "Taux de change"],
  location: ["Location", "Emplacement"],
  category: ["Category", "Catégorie"],
  product: ["Item", "Article"],
  variant: ["Item variant", "Variante d'article"],
  motorcycle: ["Motorcycle", "Moto"],
  stock_transfer: ["Stock transfer", "Transfert de stock"],
  stock_adjustment: ["Stock adjustment", "Ajustement de stock"],
  contact: ["Contact", "Contact"],
  account: ["Account", "Compte"],
  container: ["Container", "Conteneur"],
  settings: ["Settings", "Paramètres"],
  user: ["User", "Utilisateur"],
  partners: ["Partners", "Associés"],
  period: ["Month", "Mois"],
  payroll_run: ["Payroll", "Paie"],
  voucher_draft: ["Optional voucher", "Pièce facultative"],
  items: ["Items", "Articles"],
  prices: ["Prices", "Prix"],
  container_lines: ["Container lines", "Lignes de conteneur"],
};

function AuditTab() {
  const t = useT();
  const { lang } = useI18n();
  const [userId, setUserId] = useState("all");
  const [entity, setEntity] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);
  const users = useQuery<UserRow[]>({ queryKey: ["/api/users"] }).data ?? [];
  const entities = useQuery<string[]>({ queryKey: ["/api/audit/entities"] }).data ?? [];
  const params = {
    userId: userId === "all" ? undefined : userId,
    entity: entity === "all" ? undefined : entity,
    from: /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : undefined,
    to: /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : undefined,
    q: debounced || undefined,
  };
  const q = useQuery<AuditRow[]>({ queryKey: ["/api/audit", params] });
  const rows = q.data ?? [];
  const fmt = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", { dateStyle: "short", timeStyle: "short", timeZone: "Africa/Lubumbashi" });
  const isPosting = (r: AuditRow) => r.action === "post" || r.action === "reverse";
  const entityText = (e: string) => {
    const m = ENTITY_LABELS[e];
    return m ? t(m[0], m[1]) : journalTypeLabel(e, t);
  };
  const actionText = (a: string) => {
    const m = ACTION_LABELS[a];
    return m ? t(m[0], m[1]) : a;
  };
  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field label={t("Who", "Qui")}>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("Everyone", "Tout le monde")}</SelectItem>
                {users.map((u) => <SelectItem key={u.id} value={String(u.id)}>{u.fullName || u.username}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("Type", "Type")}>
            <Select value={entity} onValueChange={setEntity}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("Everything", "Tout")}</SelectItem>
                {entities.map((e) => <SelectItem key={e} value={e}>{entityText(e)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("From", "Du")}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label={t("To", "Au")}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label={t("Search", "Chercher")}><Input value={search} placeholder={t("Number, name, amount…", "Numéro, nom, montant…")} onChange={(e) => setSearch(e.target.value)} /></Field>
        </CardContent>
      </Card>
      <ErrorText error={q.error} />
      {q.isLoading ? <Loading /> : rows.length === 0 ? <EmptyState title={t("Nothing matches", "Rien ne correspond")} /> : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("When", "Quand")}</TableHead>
                    <TableHead>{t("Who", "Qui")}</TableHead>
                    <TableHead>{t("What", "Quoi")}</TableHead>
                    <TableHead>{t("Details", "Détails")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const data = (r.data ?? {}) as { number?: string; memo?: string | null; total?: string; date?: string };
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap text-sm">{fmt.format(new Date(r.createdAt))}</TableCell>
                        <TableCell>{r.fullName || r.username || "—"}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="mr-1">{actionText(r.action)}</Badge>
                          {entityText(r.entity)}
                        </TableCell>
                        <TableCell className="max-w-md text-sm">
                          {isPosting(r) ? (
                            <span>
                              {r.entityId ? <Link href={`/vouchers/${r.entityId}`} className="font-mono text-primary hover:underline">{data.number}</Link> : data.number}
                              {data.date && <> · {fmtDate(data.date)}</>}
                              {data.total && <> · <Num>{usd(data.total)}</Num></>}
                              {data.memo && <span className="block text-xs text-muted-foreground">{data.memo}</span>}
                            </span>
                          ) : r.data != null ? (
                            <details>
                              <summary className="cursor-pointer text-xs text-muted-foreground">{t("Show", "Voir")}</summary>
                              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{JSON.stringify(r.data, null, 2)}</pre>
                            </details>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">{t("Shows the latest 500 matching actions. Every posting is logged with it, in the same save.", "Affiche les 500 dernières actions correspondantes. Chaque écriture est journalisée en même temps qu'elle est enregistrée.")}</p>
    </div>
  );
}
