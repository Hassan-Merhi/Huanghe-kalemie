import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/i18n";

/** What the user picked. "system" = follow the device (nothing stored). */
export type ThemePreference = "light" | "dark" | "system";
/** What is actually shown. */
export type Theme = "light" | "dark";

type ThemeContextType = {
  /** The user's choice. */
  preference: ThemePreference;
  /** The theme actually applied (system resolved). */
  theme: Theme;
  setPreference: (p: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const QUERY = "(prefers-color-scheme: dark)";

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* storage blocked */
  }
  return "system";
}

function deviceTheme(): Theme {
  try {
    return window.matchMedia?.(QUERY).matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [device, setDevice] = useState<Theme>(() => {
    const d = deviceTheme();
    // Apply right away to avoid a flash of the wrong theme on first paint.
    const p = readPreference();
    applyTheme(p === "system" ? d : p);
    return d;
  });

  // Follow the device when it switches between light and dark.
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setDevice(mq.matches ? "dark" : "light");
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const theme: Theme = preference === "system" ? device : preference;

  useEffect(() => {
    applyTheme(theme);
    // Always print on paper colours, whatever the screen theme.
    const before = () => applyTheme("light");
    const after = () => applyTheme(theme);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, [theme]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    try {
      if (p === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", p);
    } catch {
      /* storage blocked */
    }
  }, []);

  return <ThemeContext.Provider value={{ preference, theme, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}

/** Labels for the three choices, shared by the header menu and Settings. */
export function useThemeOptions() {
  const { t } = useI18n();
  return [
    { value: "light" as const, label: t("Light", "Clair"), icon: Sun },
    { value: "dark" as const, label: t("Dark", "Sombre"), icon: Moon },
    { value: "system" as const, label: t("Auto (device)", "Auto (appareil)"), icon: Monitor },
  ];
}

/** Small header button opening a Light / Dark / Automatic menu. */
export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useI18n();
  const { preference, theme, setPreference } = useTheme();
  const options = useThemeOptions();
  const current = options.find((o) => o.value === preference) ?? options[2];
  const Icon = preference === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  const label = `${t("Theme", "Thème")}${t(":", "\u00a0:")} ${current.label}`;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className={className} aria-label={label}>
              <Icon className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("Theme", "Thème")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              <o.icon className="mr-2 h-4 w-4" />
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
