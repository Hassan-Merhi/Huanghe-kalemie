import { useState } from "react";
import { UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, SubmitButton } from "@/components/common";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useTheme, useThemeOptions, type ThemePreference } from "@/components/ThemeProvider";
import { useAuth } from "@/lib/auth";
import { useI18n, type Lang } from "@/lib/i18n";
import { roleLabel } from "@/lib/labels";

/** "Mon compte": language, theme and password, open to every role from the header. */
export function MyAccountButton() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={t("My account", "Mon compte")}>
        <UserRound className="h-4 w-4 sm:mr-1" />
        <span className="hidden max-w-[10rem] truncate sm:inline">{user.fullName}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("My account", "Mon compte")}</DialogTitle>
            <DialogDescription>{user.fullName} · {user.username} · {roleLabel(user.role, t)}</DialogDescription>
          </DialogHeader>
          <MyAccountForm onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function MyAccountForm({ onDone }: { onDone: () => void }) {
  const { lang, setLang, t } = useI18n();
  const { refresh } = useAuth();
  const { preference, setPreference } = useTheme();
  const themeOptions = useThemeOptions();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const langM = useApiMutation<{ language: Lang }>("PATCH", "/api/me", { onSuccess: (_r, b) => { setLang(b.language); refresh(); } });
  const pwM = useApiMutation<{ password: string; currentPassword: string }>("PATCH", "/api/me", {
    success: t("Password changed", "Mot de passe changé"),
    onSuccess: () => { setCurrent(""); setPassword(""); setConfirm(""); onDone(); },
  });
  const blocked = !current
    ? t("Enter your current password", "Saisissez votre mot de passe actuel")
    : password.length < 8
      ? t("The new password needs at least 8 characters", "Le nouveau mot de passe doit contenir au moins 8 caractères")
      : password !== confirm
        ? t("Repeat the new password exactly", "Répétez exactement le nouveau mot de passe")
        : null;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("Language", "Langue")}>
          <Select value={lang} onValueChange={(v) => langM.mutate({ language: v as Lang })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="fr">Français</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("Theme", "Thème")}>
          <Select value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {themeOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <form
        className="space-y-3 border-t pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) pwM.mutate({ password, currentPassword: current });
        }}
      >
        <p className="text-sm font-medium">{t("Change password", "Changer le mot de passe")}</p>
        <Field label={t("Current password", "Mot de passe actuel")} required>
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label={t("New password", "Nouveau mot de passe")} required error={password && password.length < 8 ? t("At least 8 characters", "Au moins 8 caractères") : null}>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label={t("Repeat it", "Répétez-le")} required error={confirm && confirm !== password ? t("The two do not match", "Les deux ne correspondent pas") : null}>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <SubmitButton type="submit" blocked={blocked} pending={pwM.isPending}>{t("Change password", "Changer le mot de passe")}</SubmitButton>
        </div>
      </form>
    </div>
  );
}
