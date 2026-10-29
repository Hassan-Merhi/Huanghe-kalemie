import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Field, ErrorText, Loading, SubmitButton } from "@/components/common";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useT } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { CompanySwitcher } from "@/components/CompanySwitcher";

interface Company { id: number; name: string; isOriginal: boolean; createdAt: string }
interface Impact { id: number; name: string; records: number; counts: Record<string, number> }

export function CompaniesPanel() {
  const t = useT();
  const { user } = useAuth();
  const companies = useQuery<Company[]>({ queryKey: ["/api/companies"] });
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Company | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [force, setForce] = useState(false);
  const impact = useQuery<Impact>({
    queryKey: [`/api/companies/${selected?.id ?? 0}/impact`],
    enabled: !!selected,
  });
  const create = useApiMutation<{ name: string }>("POST", "/api/companies", {
    success: t("Company created", "Entreprise créée"),
    onSuccess: () => setName(""),
  });
  const remove = useApiMutation<{ id: number; name: string; force: boolean }>(
    "POST", (body) => `/api/companies/${body.id}/delete`, {
      success: t("Company deleted", "Entreprise supprimée"),
      onSuccess: () => close(),
    },
  );

  const hasRecords = (impact.data?.records ?? 0) > 0;
  const counts = Object.entries(impact.data?.counts ?? {}).filter(([, count]) => count > 0);
  const canDelete = !!selected && selected.id !== user?.companyId && confirmation === selected.name
    && !impact.isLoading && !impact.isError && (!hasRecords || force);

  function close() {
    setSelected(null);
    setConfirmation("");
    setForce(false);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Create company", "Créer une entreprise")}</CardTitle>
          <CardDescription>{t(
            "Each company gets separate users, products, inventory, sales and accounting. Switch between companies from the menu or sign-in screen.",
            "Chaque entreprise possède ses propres utilisateurs, articles, stocks, ventes et comptabilité. Changez d'entreprise depuis le menu ou à la connexion.",
          )}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end">
            <Field className="flex-1" label={t("Company name", "Nom de l'entreprise")} required>
              <Input maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("New company name", "Nom de la nouvelle entreprise")} />
            </Field>
            <SubmitButton blocked={!name.trim() ? t("Enter a company name", "Saisissez le nom de l'entreprise") : null}
              pending={create.isPending} onClick={() => create.mutate({ name: name.trim() })}>
              <Plus className="mr-1 h-4 w-4" /> {t("Create company", "Créer l'entreprise")}
            </SubmitButton>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Companies", "Entreprises")}</CardTitle>
          <CardDescription>{t(
            "Authorized owners can manage every company, including the original. Switch to another company before deleting the active one. The last company cannot be deleted.",
            "Les propriétaires autorisés peuvent gérer toutes les entreprises, y compris l'entreprise d'origine. Changez d'entreprise avant de supprimer celle qui est active. La dernière entreprise ne peut pas être supprimée.",
          )}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ErrorText error={companies.error} />
          {companies.isLoading ? <div className="p-4"><Loading /></div> : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>{t("Company", "Entreprise")}</TableHead>
                <TableHead className="text-right">{t("Action", "Action")}</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {(companies.data ?? []).map((company) => (
                  <TableRow key={company.id}>
                    <TableCell className="font-medium">{company.name}
                      {company.isOriginal && <span className="ml-2 text-xs text-muted-foreground">{t("(original)", "(origine)")}</span>}
                      {company.id === user?.companyId && <span className="ml-2 text-xs text-primary">{t("(current)", "(active)")}</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <CompanySwitcher targetCompanyId={company.id} />
                        <Button variant="outline" size="sm" disabled={company.id === user?.companyId || (companies.data?.length ?? 0) < 2}
                          title={company.id === user?.companyId ? t("Switch to another company before deleting", "Changez d'entreprise avant la suppression") : undefined}
                          onClick={() => { setSelected(company); setConfirmation(""); setForce(false); }}>
                          <Trash2 className="mr-1 h-4 w-4" /> {t("Delete", "Supprimer")}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("Delete company", "Supprimer l'entreprise")}: {selected?.name}</DialogTitle>
            <DialogDescription>{t(
              "This is permanent, including for the original company. All its users, inventory, sales, journals, backups and business records will be erased. Other companies remain intact.",
              "Cette opération est définitive, même pour l'entreprise d'origine. Ses utilisateurs, stocks, ventes, écritures, sauvegardes et autres données seront effacés. Les autres entreprises restent intactes.",
            )}</DialogDescription>
          </DialogHeader>
          {impact.isLoading ? <Loading /> : (
            <div className="space-y-4">
              <ErrorText error={impact.error} />
              {impact.data && (
                <div className="rounded-md border p-3 text-sm">
                  <p className="font-medium">{t("Business records found", "Enregistrements trouvés")}: {impact.data.records}</p>
                  {counts.length > 0 && (
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      {counts.map(([key, count]) => `${key.replaceAll("_", " ")}: ${count}`).join(" · ")}
                    </p>
                  )}
                </div>
              )}
              {hasRecords && (
                <label className="flex items-start gap-3 rounded-md border border-destructive/40 p-3 text-sm">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="mt-1" />
                  <span>{t(
                    "Force delete: permanently erase the company even though it contains business data.",
                    "Suppression forcée : effacer définitivement l'entreprise même si elle contient des données.",
                  )}</span>
                </label>
              )}
              <Field label={t("Type the exact company name to confirm", "Saisissez le nom exact de l'entreprise pour confirmer")} required>
                <Input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off" />
              </Field>
              <p className="text-xs text-muted-foreground">{t(
                "Export a backup before deleting. Deletion cannot be undone.",
                "Exportez une sauvegarde avant la suppression. Cette action est irréversible.",
              )}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={close}>{t("Cancel", "Annuler")}</Button>
            <Button variant="destructive" disabled={!canDelete || remove.isPending}
              onClick={() => selected && remove.mutate({ id: selected.id, name: confirmation, force: hasRecords && force })}>
              <Trash2 className="mr-1 h-4 w-4" />
              {remove.isPending ? t("Deleting…", "Suppression…") : hasRecords
                ? t("Delete company and all data", "Supprimer l'entreprise et toutes ses données")
                : t("Delete company", "Supprimer l'entreprise")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
