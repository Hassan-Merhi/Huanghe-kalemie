import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, ListPlus, Pencil, Search } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, PageHeader, SubmitButton } from "@/components/common";
import { Textarea } from "@/components/ui/textarea";
import { useLocations } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { engineKey, engineRepeats } from "@/lib/engines";
import { cn } from "@/lib/utils";
import { count, useT } from "@/lib/i18n";
import type { MotorcycleUnit } from "@/lib/types";

type Unit = MotorcycleUnit & { attributes?: Record<string, string> };

export default function Motorcycles() {
  const t = useT();
  const { can } = useAuth();
  const [status, setStatus] = useState<"in_stock" | "sold" | "removed" | "all">("in_stock");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [model, setModel] = useState("all");
  const [editing, setEditing] = useState<Unit | null>(null);
  const [bulk, setBulk] = useState<Unit[] | null>(null);
  const [oneByOne, setOneByOne] = useState(false);
  const { data: locations = [] } = useLocations();
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const q = useQuery<Unit[]>({ queryKey: ["/api/units", { status: status === "all" ? undefined : status, search: debounced || undefined }] });
  const all = q.data ?? [];
  const models = useMemo(() => Array.from(new Set(all.map((u) => u.productName))).sort(), [all]);
  const rows = all.filter((u) => model === "all" || u.productName === model);
  const missing = rows.filter((u) => !u.chassisNo && u.status === "in_stock");
  const others = rows.filter((u) => !(!u.chassisNo && u.status === "in_stock"));
  // Bikes still to register, one row per model, colour and place (not twenty identical rows).
  const missingGroups = useMemo(() => {
    const m = new Map<string, Unit[]>();
    for (const u of missing) {
      const k = `${u.sku}|${u.locationId}`;
      m.set(k, [...(m.get(k) ?? []), u]);
    }
    return Array.from(m.values());
  }, [missing]);
  const locName = (id: number) => locations.find((l) => l.id === id)?.name ?? `#${id}`;
  const isManager = can("manager");

  const countByModel = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of rows) if (u.status === "in_stock") m.set(u.productName, (m.get(u.productName) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const table = (list: Unit[], highlight: boolean) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("Model", "Modèle")}</TableHead>
          <TableHead>{t("Chassis no.", "N° de châssis")}</TableHead>
          <TableHead>{t("Engine no.", "N° de moteur")}</TableHead>
          <TableHead>{t("Colour", "Couleur")}</TableHead>
          <TableHead>{t("Status", "Statut")}</TableHead>
          <TableHead>{t("Location", "Emplacement")}</TableHead>
          <TableHead>{t("Sale", "Vente")}</TableHead>
          {isManager && <TableHead />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.map((u) => (
          <TableRow key={u.id} className={highlight ? "bg-amber-50 dark:bg-amber-950/30" : undefined}>
            <TableCell>
              <span className="font-medium">{u.productName}</span>
              <div className="text-xs text-muted-foreground">{u.label !== "Standard" ? `${u.label} · ` : ""}{u.sku}</div>
            </TableCell>
            <TableCell className="whitespace-nowrap font-mono text-xs">
              {u.chassisNo ?? <span className="font-sans text-amber-800 dark:text-amber-400">{t("Not registered", "Non saisi")}</span>}
            </TableCell>
            <TableCell className="whitespace-nowrap font-mono text-xs">{u.engineNo ?? "—"}</TableCell>
            <TableCell>{u.color ?? "—"}</TableCell>
            <TableCell>
              {u.status === "sold" ? (
                <Badge variant="secondary">{t("Sold", "Vendue")}</Badge>
              ) : u.status === "removed" ? (
                <Badge variant="destructive">{t("Removed", "Retirée")}</Badge>
              ) : (
                <Badge variant="outline">{t("In stock", "En stock")}</Badge>
              )}
            </TableCell>
            <TableCell>{locName(u.locationId)}</TableCell>
            <TableCell>
              {u.saleId ? <Link href={`/sales/${u.saleId}`} className="text-primary hover:underline">{t("View sale", "Voir la vente")}</Link> : "—"}
            </TableCell>
            {isManager && (
              <TableCell className="text-right">
                {highlight ? (
                  <Button size="sm" variant="outline" onClick={() => setEditing(u)}>{t("Register", "Saisir")}</Button>
                ) : (
                  <Button variant="ghost" size="icon" aria-label={t(`Edit ${u.chassisNo ?? "motorcycle"}`, `Modifier ${u.chassisNo ?? "la moto"}`)} onClick={() => setEditing(u)}><Pencil className="h-4 w-4" /></Button>
                )}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  return (
    <div>
      <PageHeader
        title={t("Motorcycles", "Motos")}
        description={t(
          "Every motorcycle is tracked by its chassis and engine number. A motorcycle cannot be sold until its chassis number is entered.",
          "Chaque moto est suivie par son numéro de châssis et de moteur. Une moto ne peut pas être vendue tant que son numéro de châssis n'est pas saisi.",
        )}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_200px_200px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" aria-label={t("Search a motorcycle", "Chercher une moto")} placeholder={t("Chassis or engine number", "N° de châssis ou de moteur")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger aria-label={t("Status", "Statut")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="in_stock">{t("In stock", "En stock")}</SelectItem>
            <SelectItem value="sold">{t("Sold", "Vendues")}</SelectItem>
            <SelectItem value="removed">{t("Removed from stock", "Retirées du stock")}</SelectItem>
            <SelectItem value="all">{t("All", "Toutes")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger aria-label={t("Model", "Modèle")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("All models", "Tous les modèles")}</SelectItem>
            {models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {countByModel.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {countByModel.map(([name, n]) => (
            <Badge key={name} variant={model === name ? "default" : "outline"} className="cursor-pointer" onClick={() => setModel(model === name ? "all" : name)}>
              {name}{t(":", "\u00a0:")} {n} {t("in stock", "en stock")}
            </Badge>
          ))}
        </div>
      )}

      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("No motorcycles found", "Aucune moto trouvée")}>
          {t("Motorcycles arrive with a container offload or an opening-stock adjustment.", "Les motos arrivent par le déchargement d'un conteneur ou un ajustement de stock d'ouverture.")}
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {missing.length > 0 && (
            <div className="space-y-3">
              <Alert className="border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{count(t, missing.length, ["motorcycle", "motorcycles"], ["moto", "motos"])} {t("without a chassis number", "sans numéro de châssis")}</AlertTitle>
                <AlertDescription>
                  {isManager
                    ? t("Register the chassis number (from the frame) so these motorcycles can be sold.", "Saisissez le numéro de châssis (sur le cadre) pour pouvoir vendre ces motos.")
                    : t("Ask a manager to register the chassis number before selling these motorcycles.", "Demandez à un gérant de saisir le numéro de châssis avant de vendre ces motos.")}
                </AlertDescription>
              </Alert>
              <Card>
                <CardContent className="divide-y p-0">
                  {missingGroups.map((g) => {
                    const u = g[0];
                    return (
                      <div key={`${u.sku}|${u.locationId}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                        <div className="min-w-0">
                          <p className="font-medium">{u.productName}{u.label !== "Standard" ? ` · ${u.label}` : ""}</p>
                          <p className="text-xs text-muted-foreground">{u.sku} · {locName(u.locationId)}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-medium text-amber-800 dark:text-amber-300">{count(t, g.length, ["to register", "to register"], ["à saisir", "à saisir"])}</span>
                          {isManager && (
                            <Button size="sm" variant="outline" onClick={() => (g.length === 1 ? setEditing(u) : setBulk(g))}>
                              <ListPlus className="mr-1 h-4 w-4" /> {t("Enter chassis numbers", "Saisir les châssis")}
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
              <div className="flex flex-wrap gap-2">
                {isManager && missingGroups.length > 1 && (
                  <Button onClick={() => setBulk(missing)}>
                    <ListPlus className="mr-1 h-4 w-4" /> {t("Enter all chassis numbers", "Saisir tous les numéros de châssis")}
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setOneByOne((v) => !v)}>
                  {oneByOne ? t("Hide the list", "Masquer la liste") : t("Show them one by one", "Voir une par une")}
                </Button>
              </div>
              {oneByOne && <Card className="overflow-x-auto">{table(missing, true)}</Card>}
            </div>
          )}
          {others.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">{t(`Motorcycles (${others.length})`, `Motos (${others.length})`)}</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto p-0">{table(others, false)}</CardContent>
            </Card>
          )}
        </div>
      )}

      {editing && <UnitDialog unit={editing} onClose={() => setEditing(null)} />}
      {bulk && <BulkDialog units={bulk} onClose={() => setBulk(null)} />}
    </div>
  );
}

function UnitDialog({ unit, onClose }: { unit: Unit; onClose: () => void }) {
  const t = useT();
  const [chassisNo, setChassisNo] = useState(unit.chassisNo ?? "");
  const [engineNo, setEngineNo] = useState(unit.engineNo ?? "");
  const [color, setColor] = useState(unit.color ?? "");
  const sold = unit.status === "sold";
  const m = useApiMutation("PATCH", `/api/units/${unit.id}`, { success: t("Motorcycle saved", "Moto enregistrée"), onSuccess: onClose });
  // An engine number already on another bike is asked about (an edit keeping the saved one is not).
  const all = useQuery<Unit[]>({ queryKey: ["/api/units", { status: undefined, search: undefined }] });
  const engineRepeat = engineKey(engineNo) === engineKey(unit.engineNo) ? null : engineRepeats(t, [{ id: unit.id, engineNo }], all.data ?? []).get(0) ?? null;
  const [askEngine, setAskEngine] = useState(false);
  function save(confirmed = false) {
    if (engineRepeat && !confirmed) return setAskEngine(true);
    setAskEngine(false);
    m.mutate({
      ...(!sold && { chassisNo: chassisNo.trim() || null }),
      engineNo: engineNo.trim() || null,
      color: color.trim() || null,
    });
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{unit.chassisNo ? t("Edit motorcycle", "Modifier la moto") : t("Register chassis number", "Saisir le numéro de châssis")}</DialogTitle>
          <DialogDescription>{unit.productName}{unit.label !== "Standard" ? ` · ${unit.label}` : ""} · {unit.sku}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field
            label={t("Chassis no.", "N° de châssis")}
            hint={sold ? t("The chassis number of a sold motorcycle cannot be changed.", "Le numéro de châssis d'une moto vendue ne peut pas être modifié.") : t("Saved in capital letters. Must be unique.", "Enregistré en majuscules. Doit être unique.")}
          >
            <Input autoFocus={!sold} disabled={sold} className="font-mono uppercase" value={chassisNo} onChange={(e) => setChassisNo(e.target.value)} />
          </Field>
          <Field label={t("Engine no.", "N° de moteur")}>
            <Input className={cn("font-mono uppercase", engineRepeat && "border-amber-500")} value={engineNo} onChange={(e) => setEngineNo(e.target.value)} />
          </Field>
          {engineRepeat && <p className="text-sm text-amber-800 dark:text-amber-400" data-testid="engine-repeat">{engineRepeat}</p>}
          <Field label={t("Colour", "Couleur")}>
            <Input value={color} onChange={(e) => setColor(e.target.value)} />
          </Field>
          {m.error && <ErrorText error={m.error} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <Button disabled={m.isPending} onClick={() => save()}>
            {t("Save", "Enregistrer")}
          </Button>
        </DialogFooter>
      </DialogContent>
      <EngineRepeatAlert repeats={engineRepeat ? [engineRepeat] : []} open={askEngine} onCancel={() => setAskEngine(false)} onConfirm={() => save(true)} />
    </Dialog>
  );
}

interface BulkRow { chassisNo: string; engineNo: string; color: string }

/** Chassis numbers for many motorcycles at once, typed or pasted from a spreadsheet (one bike per line). */
function BulkDialog({ units, onClose }: { units: Unit[]; onClose: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<BulkRow[]>(() => units.map((u) => ({ chassisNo: "", engineNo: u.engineNo ?? "", color: u.color ?? "" })));
  const [paste, setPaste] = useState("");
  const m = useApiMutation<{ units: { id: number; chassisNo: string; engineNo: string | null; color: string | null }[] }>("POST", "/api/units/bulk", {
    success: t("Chassis numbers saved", "Numéros de châssis enregistrés"),
    onSuccess: onClose,
    // Refused because a number was registered meanwhile (on another phone): the list is read again, so the
    // line it names is marked and the save waits for it to be corrected. The dialog says it, not a toast.
    onError: (e) => {
      if (!(e instanceof ApiError && e.status === 409)) return;
      void all.refetch();
      return true;
    },
  });
  // The chassis numbers already registered, to mark a line before saving; the server still checks every number.
  const all = useQuery<Unit[]>({ queryKey: ["/api/units", { status: undefined, search: undefined }] });
  const taken = new Map((all.data ?? []).filter((u) => u.chassisNo).map((u) => [u.chassisNo!.toUpperCase(), u.id]));
  // Any change clears a refusal from the last save: it named a number that may no longer be typed.
  const set = (i: number, k: keyof BulkRow, v: string) => {
    m.reset();
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  };

  function applyPaste() {
    m.reset();
    const lines = paste.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    setRows((rs) =>
      rs.map((r, i) => {
        const cells = lines[i]?.split(/\t|;|,/).map((c) => c.trim());
        if (!cells) return r;
        return { chassisNo: cells[0] ?? r.chassisNo, engineNo: cells[1] || r.engineNo, color: cells[2] || r.color };
      }),
    );
    setPaste("");
  }

  const filled = rows.map((r, i) => ({ ...r, unit: units[i] })).filter((r) => r.chassisNo.trim());
  const keys = filled.map((r) => r.chassisNo.trim().toUpperCase());
  const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
  const takenBy = (r: BulkRow, i: number) => {
    const id = taken.get(r.chassisNo.trim().toUpperCase());
    return id !== undefined && id !== units[i].id;
  };
  const used = filled.find((r) => takenBy(r, units.indexOf(r.unit)));
  // The same engine number twice, or already on another bike: marked and asked about, not refused.
  const engines = engineRepeats(t, rows.map((r, i) => ({ id: units[i].id, engineNo: r.engineNo, saved: !!r.chassisNo.trim() })), all.data ?? []);
  const [askEngine, setAskEngine] = useState(false);
  function save(confirmed = false) {
    if (engines.size && !confirmed) return setAskEngine(true);
    setAskEngine(false);
    m.mutate({ units: filled.map((r) => ({ id: r.unit.id, chassisNo: r.chassisNo.trim(), engineNo: r.engineNo.trim() || null, color: r.color.trim() || null })) });
  }
  const blocked = !filled.length
    ? t("Enter at least one chassis number", "Saisissez au moins un numéro de châssis")
    : dupe
      ? t(`${dupe} is typed twice`, `${dupe} est saisi deux fois`)
      : used
        ? t(`Chassis number ${used.chassisNo.trim().toUpperCase()} is already registered`, `Le numéro de châssis ${used.chassisNo.trim().toUpperCase()} est déjà enregistré`)
        : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Enter chassis numbers", "Saisir les numéros de châssis")}</DialogTitle>
          <DialogDescription>
            {t(
              "Fill in the bikes you have checked; empty lines are left for later. Everything is saved together, or nothing if a number is already used.",
              "Remplissez les motos vérifiées\u00a0; les lignes vides restent pour plus tard. Tout est enregistré ensemble, ou rien si un numéro est déjà utilisé.",
            )}
          </DialogDescription>
        </DialogHeader>
        <Field
          label={t("Paste from a spreadsheet (optional)", "Coller depuis un tableur (facultatif)")}
          hint={t("One bike per line: chassis, then engine and colour if you have them.", "Une moto par ligne\u00a0: châssis, puis moteur et couleur si vous les avez.")}
        >
          <Textarea rows={3} className="font-mono text-xs" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"LHJ123456789\tEN1234\tRouge"} />
        </Field>
        {paste.trim() && (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={applyPaste}>{t("Fill the lines below", "Remplir les lignes ci-dessous")}</Button>
          </div>
        )}
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={units[i].id} className="grid grid-cols-2 gap-2 rounded-md border p-2 sm:grid-cols-[1.2fr_1.4fr_1fr_0.8fr] sm:items-center sm:border-0 sm:p-0">
              <div className="col-span-2 text-sm sm:col-span-1">
                <span className="font-medium">{units[i].productName}</span>
                <span className="text-xs text-muted-foreground"> · {units[i].label !== "Standard" ? units[i].label : units[i].sku}</span>
              </div>
              <Input className="col-span-2 font-mono uppercase placeholder:normal-case placeholder:font-sans sm:col-span-1" aria-label={t(`Chassis no., bike ${i + 1} (${units[i].productName})`, `N° de châssis, moto ${i + 1} (${units[i].productName})`)} placeholder={t("Chassis no.", "N° de châssis")} aria-invalid={takenBy(r, i) || undefined} value={r.chassisNo} onChange={(e) => set(i, "chassisNo", e.target.value)} />
              <Input className={cn("font-mono uppercase placeholder:normal-case placeholder:font-sans", engines.has(i) && "border-amber-500")} title={engines.get(i)} aria-label={t(`Engine no., bike ${i + 1} (${units[i].productName})`, `N° de moteur, moto ${i + 1} (${units[i].productName})`)} placeholder={t("Engine no.", "N° de moteur")} value={r.engineNo} onChange={(e) => set(i, "engineNo", e.target.value)} />
              <Input aria-label={t(`Colour, bike ${i + 1} (${units[i].productName})`, `Couleur, moto ${i + 1} (${units[i].productName})`)} placeholder={t("Colour", "Couleur")} value={r.color} onChange={(e) => set(i, "color", e.target.value)} />
            </div>
          ))}
        </div>
        {engines.size > 0 && (
          <ul className="space-y-0.5 text-sm text-amber-800 dark:text-amber-400" data-testid="engine-repeat">
            {[...new Set(engines.values())].map((text) => <li key={text}>{text}</li>)}
          </ul>
        )}
        {/* Once the refused line is marked, the note by the button names it: the box would say it twice. */}
        {m.error && !(used && m.error.message.includes(used.chassisNo.trim().toUpperCase())) && <ErrorText error={m.error} />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <SubmitButton
            blocked={blocked}
            pending={m.isPending}
            onClick={() => save()}
          >
            {filled.length > 0 ? t(`Save ${filled.length}`, `Enregistrer ${filled.length}`) : t("Save", "Enregistrer")}
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
      <EngineRepeatAlert repeats={[...new Set(engines.values())]} open={askEngine} onCancel={() => setAskEngine(false)} onConfirm={() => save(true)} />
    </Dialog>
  );
}

/** Asks before saving an engine number that is already on another bike, or typed twice. */
function EngineRepeatAlert({ repeats, open, onCancel, onConfirm }: { repeats: string[]; open: boolean; onCancel: () => void; onConfirm: () => void }) {
  const t = useT();
  return (
    <AlertDialog open={open && repeats.length > 0} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Same engine number twice?", "Même numéro de moteur en double\u00a0?")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-1">
              {repeats.map((text) => <p key={text}>{text}.</p>)}
              <p>{t("Check the number on the engine: it prints on the sale and its documents.", "Vérifiez le numéro sur le moteur\u00a0: il est imprimé sur la vente et ses documents.")}</p>
            </div>
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
