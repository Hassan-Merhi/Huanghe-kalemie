import { Fragment, cloneElement, isValidElement, useEffect, useId, useRef, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { FieldLabelContext } from "@/components/ui/field-label";
import { cn } from "@/lib/utils";
import { ambiguousReadings, exactMoney, money, refusedUnit, unitMismatchText } from "@/lib/format";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  // Each page gets its own browser tab title: "Caisse · Huanghe Kalemie".
  useEffect(() => {
    document.title = `${title} · Huanghe Kalemie`;
  }, [title]);
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2 sm:max-w-[60%] sm:shrink-0 sm:justify-end">{actions}</div>}
    </div>
  );
}

/**
 * A labelled form field. `required` puts a star after the label; `error` replaces the hint.
 * Every form uses this, so required fields and mistakes look the same everywhere.
 * A text field inside is tied to the label and marked required for screen readers (said once, not
 * "star" and then "required"); other controls get the word "required" as hidden text instead.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const t = useT();
  const id = useId();
  const noteId = `${id}-note`;
  const isTextField =
    isValidElement(children) && typeof children.type === "object" && TEXT_FIELDS.has((children.type as { displayName?: string }).displayName ?? "");
  const props = isTextField ? (children.props as Record<string, unknown>) : null;
  const fieldId = (props?.id as string | undefined) ?? id;
  const control = isTextField
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id: fieldId,
        "aria-required": required || undefined,
        "aria-invalid": error ? true : props?.["aria-invalid"],
        "aria-describedby": hint || error ? noteId : props?.["aria-describedby"],
      })
    : children;
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label id={`${id}-label`} htmlFor={isTextField ? fieldId : undefined}>
        {label}
        {required && <span className="ml-0.5 text-destructive" aria-hidden>*</span>}
        {required && !isTextField && <span className="sr-only"> ({t("required", "obligatoire")})</span>}
      </Label>
      <FieldLabelContext.Provider value={isTextField ? null : `${id}-label`}>{control}</FieldLabelContext.Provider>
      {hint && !error && <p id={noteId} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={noteId} className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
const TEXT_FIELDS = new Set(["Input", "Textarea", "DateInput", "DecimalInput"]);

/**
 * A button that says why it cannot be pressed. While `blocked` holds a reason the button is disabled
 * and the reason is shown next to it (above it on a phone); while `pending` it shows a spinner.
 */
export function SubmitButton({
  blocked,
  pending,
  children,
  className,
  ...props
}: ComponentProps<typeof Button> & { blocked?: string | null | false; pending?: boolean }) {
  const reason = blocked || null;
  return (
    <div className={cn("flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2", className)}>
      {reason && !pending && <p className="text-xs text-muted-foreground sm:text-right" role="status">{reason}</p>}
      <Button {...props} disabled={!!reason || pending || props.disabled}>
        {pending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
        {children}
      </Button>
    </div>
  );
}

/** `dense`: one of five cards in a row (Caisse du jour), a size smaller from 1024 px so "−1 472,00 $" keeps its "$". */
export function StatCard({ label, value, sub, tone, dense }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" | "warn" | "neutral"; dense?: boolean }) {
  return (
    <Card>
      <CardContent className="p-3 sm:p-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:text-xs">{label}</p>
        {/* A size step down between 1024 and 1280 px, where four cards sit beside the menu: "13 680,10 $" stays on one line. */}
        <p className={cn("mt-1 text-lg font-semibold tabular", dense ? "whitespace-nowrap sm:text-xl lg:text-lg xl:text-xl" : "break-words sm:text-2xl lg:text-xl xl:text-2xl", tone === "good" && "text-green-800 dark:text-green-400", tone === "bad" && "text-destructive", tone === "warn" && "text-amber-800 dark:text-amber-400")}>{value}</p>
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-2 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> {label ?? "…"}
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{message}</p>;
}

/** Right-aligned number cell. */
export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("tabular whitespace-nowrap", className)}>{children}</span>;
}

/** Francs change hands in whole notes: an FC amount with centimes is a typing slip (the server refuses it too). */
export function francDecimalsError(t: (en: string, fr: string) => string, currency: string | null | undefined, value: string): string | null {
  if (currency !== "CDF" || !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && !Number.isInteger(n) ? t("Franc amounts are whole numbers (no centimes)", "Les montants en FC sont des nombres entiers (sans centimes)") : null;
}

/**
 * What to say when a dollar or yuan field holds an amount it refused as ambiguous ("1.200"), instead of
 * "enter an amount above zero": "Précisez le montant : 1 200,00 $ ou 1,20 $".
 */
export function unclearAmount(t: (en: string, fr: string) => string, value: string | null | undefined, currency: string = "USD"): string | null {
  // "500 FC" refused by a dollar field: the page says what the field says.
  const unit = refusedUnit(value, currency === "CDF" || currency === "CNY" ? currency : "USD");
  if (unit) return unitMismatchText(unit, currency === "CDF" || currency === "CNY" ? currency : "USD");
  const r = ambiguousReadings(value);
  if (!r) return null;
  // The small reading exact: "4,125" is 4 125,00 ¥ or 4,125 ¥, not 4,13 ¥.
  const [big, small] = [money(r[0], currency), exactMoney(r[1], currency)];
  return t(`Say which amount: ${big} or ${small}`, `Précisez le montant : ${big} ou ${small}`);
}

/**
 * "Corriger" in a confirmation ("Un montant inhabituel ?") sends the person back to the field it asks about:
 * focus goes there with its text selected, to type over it, instead of being left on the page. Escape does the
 * same; "… quand même" leaves focus to the dialog. `field` is the field itself, or the `data-correct` key it
 * carries (rows of a table: `data-correct={`salary-${id}`}`). Spread `content` on AlertDialogContent and
 * `cancel` on AlertDialogCancel.
 */
export function useCorrectFocus(field: () => HTMLElement | string | null | undefined) {
  const correcting = useRef(false);
  return {
    cancel: { onClick: () => { correcting.current = true; } },
    content: {
      onEscapeKeyDown: () => { correcting.current = true; },
      onCloseAutoFocus: (e: Event) => {
        if (!correcting.current) return;
        correcting.current = false;
        const f = field();
        // The one on screen: a table and its phone cards may both carry the key.
        const el = typeof f === "string" ? Array.from(document.querySelectorAll<HTMLElement>(`[data-correct="${CSS.escape(f)}"]`)).find((x) => x.getClientRects().length > 0) : f;
        if (!el || !el.isConnected || (el as HTMLInputElement).disabled) return;
        e.preventDefault();
        el.focus();
        if (el instanceof HTMLInputElement) el.select();
      },
    },
  };
}

/** Document numbers in a text ("Vente S-000027 annulée") kept whole: a narrow card never breaks "J-/000044" at its hyphen. */
export function KeepNumbers({ text }: { text: string }) {
  const parts = text.split(/\b([A-Z]{1,4}-\d+)\b/);
  return (
    <>
      {parts.map((part, i) => (i % 2 ? <span key={i} className="whitespace-nowrap">{part}</span> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}
