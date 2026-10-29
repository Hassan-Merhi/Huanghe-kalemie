import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorText, Field } from "@/components/common";
import { api, queryClient } from "@/lib/api";
import { useAuth, type User } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";

/**
 * Switching companies is an authenticated sign-in to the target company,
 * never a client-supplied tenant header. Each company has separate users and
 * credentials. Clear all cached ledgers after the server rotates the session.
 */
export function CompanySwitcher({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  const { t, setLang } = useI18n();
  const companies = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/auth/companies"], staleTime: 300_000,
  });
  const available = (companies.data ?? []).filter((company) => company.id !== user?.companyId);
  const [isOpen, setIsOpen] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function open() {
    if (!available.length) return;
    setTargetId(String(available[0].id));
    setUsername(user?.username ?? "");
    setPassword("");
    setError(null);
    setIsOpen(true);
  }

  async function switchCompany(event: React.FormEvent) {
    event.preventDefault();
    if (!targetId || !username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api<User>("POST", "/api/auth/login", {
        companyId: Number(targetId), username: username.trim(), password,
      });
      if (next.language === "fr" || next.language === "en") setLang(next.language);
      queryClient.clear();
      queryClient.setQueryData(["/api/auth/me"], next);
      // A full navigation also discards forms and local state belonging to the
      // previous company, so no stale books leak onto the next screen.
      window.location.assign("/");
    } catch (cause) {
      setError(cause);
      setBusy(false);
    }
  }

  if (!user || !available.length) return null;
  return (
    <>
      <Button type="button" variant={compact ? "ghost" : "outline"} size="sm"
        className={compact ? "mt-1 h-7 justify-start gap-1 px-1 text-xs text-sidebar-foreground/80 hover:text-sidebar-foreground" : "gap-2"}
        onClick={open}>
        <ArrowLeftRight className="h-3.5 w-3.5" />
        {t("Switch company", "Changer d'entreprise")}
      </Button>
      <Dialog open={isOpen} onOpenChange={(value) => { if (!busy) setIsOpen(value); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Switch company", "Changer d'entreprise")}</DialogTitle>
            <DialogDescription>
              {t(
                "Each company's accounts are private. Sign in with a username and password for the company you want to open.",
                "Chaque entreprise possède ses propres comptes. Connectez-vous avec les identifiants de l'entreprise à ouvrir.",
              )}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={switchCompany} className="space-y-4">
            <Field label={t("Company", "Entreprise")} required>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {available.map((company) => (
                    <SelectItem key={company.id} value={String(company.id)}>{company.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("Username", "Nom d'utilisateur")} required>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" />
            </Field>
            <Field label={t("Password", "Mot de passe")} required>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </Field>
            <ErrorText error={error} />
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={() => setIsOpen(false)}>
                {t("Cancel", "Annuler")}
              </Button>
              <Button type="submit" disabled={busy || !targetId || !username.trim() || !password}>
                <ArrowLeftRight className="mr-1 h-4 w-4" />
                {busy ? t("Switching…", "Changement…") : t("Switch company", "Changer d'entreprise")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
