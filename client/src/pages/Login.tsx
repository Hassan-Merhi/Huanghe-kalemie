import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, ErrorText, SubmitButton } from "@/components/common";
import { ThemeToggle } from "@/components/ThemeProvider";
import { api, queryClient } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { User } from "@/lib/auth";

export default function Login() {
  const { t, lang, setLang } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await api<User>("POST", "/api/auth/login", { username, password });
      if (user.language) setLang(user.language);
      queryClient.setQueryData(["/api/auth/me"], user);
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="absolute right-3 top-3">
        <ThemeToggle />
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <span className="text-primary">HUANGHE</span> Kalemie
          </CardTitle>
          <p className="text-sm text-muted-foreground">{t("Sign in to continue", "Connectez-vous pour continuer")}</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <Field label={t("Username", "Nom d'utilisateur")} required>
              <Input autoFocus autoCapitalize="none" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label={t("Password", "Mot de passe")} required>
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <ErrorText error={error} />
            <SubmitButton
              type="submit"
              className="sm:flex-col sm:items-stretch [&>button]:w-full [&>p]:text-center"
              blocked={!username ? t("Enter your username", "Saisissez votre nom d'utilisateur") : !password ? t("Enter your password", "Saisissez votre mot de passe") : null}
              pending={busy}
            >
              {t("Sign in", "Se connecter")}
            </SubmitButton>
            <button type="button" className="w-full text-center text-xs text-muted-foreground" onClick={() => setLang(lang === "fr" ? "en" : "fr")}>
              {lang === "fr" ? "English" : "Français"}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
