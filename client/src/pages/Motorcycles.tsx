import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, Pencil, Search } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorText, Field, Loading, PageHeader } from "@/components/common";
import { useLocations } from "@/components/pickers";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
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
              {u.chassisNo ?? <span className="font-sans text-amber-700 dark:text-amber-400">{t("Not registered", "Non saisi")}</span>}
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
                  <Button size="sm" onClick={() => setEditing(u)}>{t("Register", "Saisir")}</Button>
                ) : (
                  <Button variant="ghost" size="icon" onClick={() => setEditing(u)}><Pencil className="h-4 w-4" /></Button>
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
          <Input className="pl-9" placeholder={t("Search chassis or engine number", "Chercher n° de châssis ou de moteur")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="in_stock">{t("In stock", "En stock")}</SelectItem>
            <SelectItem value="sold">{t("Sold", "Vendues")}</SelectItem>
            <SelectItem value="removed">{t("Removed from stock", "Retirées du stock")}</SelectItem>
            <SelectItem value="all">{t("All", "Toutes")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger><SelectValue /></SelectTrigger>
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
              {name}: {n} {t("in stock", "en stock")}
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
              <Card className="overflow-x-auto">{table(missing, true)}</Card>
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
            <Input className="font-mono uppercase" value={engineNo} onChange={(e) => setEngineNo(e.target.value)} />
          </Field>
          <Field label={t("Colour", "Couleur")}>
            <Input value={color} onChange={(e) => setColor(e.target.value)} />
          </Field>
          {m.error && <ErrorText error={m.error} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <Button
            disabled={m.isPending}
            onClick={() =>
              m.mutate({
                ...(!sold && { chassisNo: chassisNo.trim() || null }),
                engineNo: engineNo.trim() || null,
                color: color.trim() || null,
              })
            }
          >
            {t("Save", "Enregistrer")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
