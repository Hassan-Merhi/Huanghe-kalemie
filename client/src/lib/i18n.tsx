import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "fr" | "en";

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** Pick the English or French text: t("Save", "Enregistrer"). */
  t: (en: string, fr: string) => string;
}

const Ctx = createContext<I18n | null>(null);

function initialLang(): Lang {
  try {
    const stored = localStorage.getItem("lang");
    if (stored === "fr" || stored === "en") return stored;
  } catch {
    /* storage blocked */
  }
  return "fr";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("lang", l);
    } catch {
      /* storage blocked */
    }
  }, []);
  const t = useCallback((en: string, fr: string) => (lang === "fr" ? fr : en), [lang]);
  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}

export function useT() {
  return useI18n().t;
}
