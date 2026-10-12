import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Plus } from "lucide-react";
import { EmptyState, ErrorText, Field, Loading, Num, PageHeader } from "@/components/common";
import { LocationSelect, PartySelect } from "@/components/pickers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useAuth } from "@/lib/auth";
import { d, date, qty, usd } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type ContainerStatus = "draft" | "in_transit" | "arrived" | "finalized";

export interface ContainerRow {
  id: number;
  number: string;
  supplierId: number;
  supplierName?: string;
  status: ContainerStatus;
  currency: string;
  rateToUsd: string;
  locationId: number;
  shipDate: string | null;
  arrivalDate: string | null;
  offloadDate: string | null;
  notes: string | null;
  fobTotalUsd: string | null;
  expensesTotalUsd: string | null;
  landedTotalUsd: string | null;
  lineCount?: number;
  expensesUsd?: string;
}

export function useStatusLabel() {
  const t = useT();
  return (s: ContainerStatus) =>
    ({
      draft: t("Draft", "Brouillon"),
      in_transit: t("In transit", "En route"),
      arrived: t("Arrived", "Arrivé"),
      finalized: t("Offloaded", "Déchargé"),
    })[s] ?? s;
}

export function ContainerStatusBadge({ status }: { status: ContainerStatus }) {
  const label = useStatusLabel();
  const tone: Record<ContainerStatus, string> = {
    draft: "bg-muted text-muted-foreground border-transparent",
    in_transit: "bg-blue-100 text-blue-800 border-transparent dark:bg-blue-950 dark:text-blue-200",
    arrived: "bg-amber-100 text-amber-900 border-transparent dark:bg-amber-950 dark:text-amber-200",
    finalized: "bg-green-100 text-green-800 border-transparent dark:bg-green-950 dark:text-green-200",
  };
  return (
    <Badge variant="outline" className={cn(tone[status])}>
      {label(status)}
    </Badge>
  );
}

export default function Containers() {
  const t = useT();
  const { can } = useAuth();
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  const q = useQuery<ContainerRow[]>({ queryKey: ["/api/containers"] });
  const rows = q.data ?? [];

  return (
    <div>
      <PageHeader
        title={t("Containers", "Conteneurs")}
        description={t(
          "Imports from suppliers. Add the items and the costs (freight, duties, transport…), then offload into stock at landed cost.",
          "Importations des fournisseurs. Ajoutez les articles et les frais (fret, douane, transport…), puis déchargez en stock au coût de revient.",
        )}
        actions={
          can("manager") && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" /> {t("New container", "Nouveau conteneur")}
            </Button>
          )
        }
      />
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("No containers yet", "Aucun conteneur pour l'instant")}>
          {t("Create a container when you order goods from a supplier.", "Créez un conteneur quand vous commandez chez un fournisseur.")}
        </EmptyState>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Number", "Numéro")}</TableHead>
                    <TableHead>{t("Supplier", "Fournisseur")}</TableHead>
                    <TableHead>{t("Status", "Statut")}</TableHead>
                    <TableHead>{t("Arrival", "Arrivée")}</TableHead>
                    <TableHead className="text-right">{t("Lines", "Lignes")}</TableHead>
                    <TableHead className="text-right">{t("Expenses so far", "Frais à ce jour")}</TableHead>
                    <TableHead className="text-right">{t("Landed total", "Coût de revient total")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((c) => (
                    <TableRow key={c.id} className="cursor-pointer" onClick={() => navigate(`/containers/${c.id}`)}>
                      <TableCell className="font-medium">
                        <Link href={`/containers/${c.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                          {c.number}
                        </Link>
                      </TableCell>
                      <TableCell>{c.supplierName}</TableCell>
                      <TableCell>
                        <ContainerStatusBadge status={c.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{date(c.arrivalDate)}</TableCell>
                      <TableCell className="text-right"><Num>{qty(c.lineCount ?? 0)}</Num></TableCell>
                      <TableCell className="text-right"><Num>{usd(c.expensesUsd)}</Num></TableCell>
                      <TableCell className="text-right">
                        {c.status === "finalized" ? <Num className="font-medium">{usd(c.landedTotalUsd)}</Num> : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
      {creating && <NewContainerDialog onClose={() => setCreating(false)} onCreated={(id) => navigate(`/containers/${id}`)} />}
    </div>
  );
}

const CURRENCIES = ["USD", "CNY", "EUR", "AED", "INR", "TZS", "KES", "ZAR"];

function NewContainerDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const t = useT();
  const label = useStatusLabel();
  const [number, setNumber] = useState("");
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [locationId, setLocationId] = useState<number | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [rateToUsd, setRateToUsd] = useState("");
  const [shipDate, setShipDate] = useState("");
  const [arrivalDate, setArrivalDate] = useState("");
  const [status, setStatus] = useState<Exclude<ContainerStatus, "finalized">>("draft");
  const [notes, setNotes] = useState("");
  const create = useApiMutation<Record<string, unknown>, ContainerRow>("POST", "/api/containers", {
    success: t("Container created", "Conteneur créé"),
    onSuccess: (row) => onCreated(row.id),
  });
  const foreign = currency !== "USD";
  const rateOk = !foreign || d(rateToUsd).gt(0);
  const valid = number.trim() && supplierId && locationId && rateOk;

  function save() {
    create.mutate({
      number: number.trim(),
      supplierId,
      locationId,
      currency,
      rateToUsd: foreign ? d(rateToUsd).toString() : "1",
      status,
      shipDate: shipDate || null,
      arrivalDate: arrivalDate || null,
      notes: notes.trim() || null,
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("New container", "Nouveau conteneur")}</DialogTitle>
          <DialogDescription>{t("You can add the items and costs on the next screen.", "Vous ajouterez les articles et les frais à l'écran suivant.")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Container number", "Numéro du conteneur")}>
            <Input autoFocus value={number} onChange={(e) => setNumber(e.target.value)} placeholder="MSKU1234567" />
          </Field>
          <Field label={t("Supplier", "Fournisseur")}>
            <PartySelect types={["supplier"]} value={supplierId} onChange={(id) => setSupplierId(id)} />
          </Field>
          <Field label={t("Unload into", "Décharger à")}>
            <LocationSelect value={locationId} onChange={setLocationId} />
          </Field>
          <Field label={t("Status", "Statut")}>
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["draft", "in_transit", "arrived"] as const).map((s) => (
                  <SelectItem key={s} value={s}>{label(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("Invoice currency", "Devise de la facture")}>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {foreign ? (
            <Field
              label={t(`USD for 1 ${currency}`, `USD pour 1 ${currency}`)}
              hint={t(`Example: 1 CNY = 0.14 USD`, `Exemple : 1 CNY = 0,14 USD`)}
              error={rateToUsd && !rateOk ? t("Enter a rate above zero", "Entrez un taux supérieur à zéro") : null}
            >
              <Input inputMode="decimal" value={rateToUsd} onChange={(e) => setRateToUsd(e.target.value)} placeholder="0.14" />
            </Field>
          ) : (
            <div className="hidden sm:block" />
          )}
          <Field label={t("Ship date", "Date d'expédition")}>
            <Input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />
          </Field>
          <Field label={t("Expected / actual arrival", "Arrivée prévue / réelle")}>
            <Input type="date" value={arrivalDate} onChange={(e) => setArrivalDate(e.target.value)} />
          </Field>
          <Field label={t("Notes", "Notes")} className="sm:col-span-2">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "Annuler")}</Button>
          <Button onClick={save} disabled={!valid || create.isPending}>{t("Create", "Créer")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
