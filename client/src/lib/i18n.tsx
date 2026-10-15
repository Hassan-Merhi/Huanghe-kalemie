import { createContext, Fragment, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { setFormatLang } from "./format";

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
  // Number formatting reads the language too; set it before the children render.
  setFormatLang(lang);
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
  // Keyed by language so every number on screen is redrawn when it changes.
  return (
    <Ctx.Provider value={{ lang, setLang, t }}>
      <Fragment key={lang}>{children}</Fragment>
    </Ctx.Provider>
  );
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}

export function useT() {
  return useI18n().t;
}

/**
 * "1 account" / "2 accounts", "1 compte" / "2 comptes". French uses the singular for 0 and 1.
 * count(t, n, ["account", "accounts"], ["compte", "comptes"])
 */
export function count(t: I18n["t"], n: number, en: [string, string], fr: [string, string]): string {
  return t(`${n} ${n === 1 ? en[0] : en[1]}`, `${n} ${n < 2 ? fr[0] : fr[1]}`);
}
