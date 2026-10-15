import * as React from "react";
import { CalendarDays } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatLang, inputText, parseNumberInput } from "@/lib/format";

const BASE =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none md:text-sm";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    // Dates are always shown dd/mm/yyyy, whatever language the phone or browser is set to.
    if (type === "date") return <DateInput className={className} {...props} ref={ref} />;
    // Amounts and quantities accept "4,50" as well as "4.50" and read French-style.
    if ((props.inputMode === "decimal" || props.inputMode === "numeric") && (!type || type === "text")) return <DecimalInput className={className} {...props} ref={ref} />;
    // h-9 to match icon buttons and default buttons.
    return <input type={type} className={cn(BASE, className)} ref={ref} {...props} />;
  },
);
Input.displayName = "Input";

const toText = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

function parse(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{4})$/);
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * A date field typed as dd/mm/yyyy, with a calendar button that opens the phone's own picker.
 * Its value and onChange work like <input type="date">: an ISO date (yyyy-mm-dd) or "".
 */
const DateInput = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ className, value, onChange, min, max, disabled, ...props }, ref) => {
  const iso = typeof value === "string" ? value : "";
  const [text, setText] = React.useState(toText(iso));
  const picker = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => setText(toText(iso)), [iso]);
  const emit = (v: string) => onChange?.({ target: { value: v }, currentTarget: { value: v } } as React.ChangeEvent<HTMLInputElement>);
  const fr = formatLang() === "fr";
  return (
    <div className={cn("relative", className)}>
      <input
        {...props}
        ref={ref}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        disabled={disabled}
        placeholder={fr ? "jj/mm/aaaa" : "dd/mm/yyyy"}
        // Colours and borders given by the page apply to the field itself; margins stay on the wrapper.
        className={cn(BASE, "pr-9 tabular-nums", className?.split(/\s+/).filter((c) => !/^-?m[trblxy]?-/.test(c)).join(" "))}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parse(e.target.value);
          if (parsed && (!min || parsed >= String(min)) && (!max || parsed <= String(max))) emit(parsed);
          else if (!e.target.value.trim()) emit("");
        }}
        onBlur={() => setText(toText(iso))}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label={fr ? "Ouvrir le calendrier" : "Open calendar"}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50"
        onClick={() => {
          const el = picker.current;
          if (!el) return;
          try {
            el.showPicker();
          } catch {
            el.focus();
            el.click();
          }
        }}
      >
        <CalendarDays className="h-4 w-4" />
      </button>
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none absolute bottom-0 right-0 h-px w-px opacity-0"
        value={iso}
        min={min}
        max={max}
        onChange={(e) => emit(e.target.value)}
      />
    </div>
  );
});
DateInput.displayName = "DateInput";

/** Classes that size or place a field among its neighbours (kept on the wrapper of a number field). */
const LAYOUT = /^(?:[a-z0-9[\]-]+:)*!?(?:-?m[trblxy]?-|w-|min-w-|max-w-|flex-|basis-|grow|shrink|col-|row-|self-|justify-self-|order-|hidden$|block$|inline|absolute$|relative$|sticky$|top-|bottom-|left-|right-|inset-|z-)/;

/**
 * A number field that reads the way people write: "4,50", "4.50" or "1 234,5" all mean the same.
 * Its value and onChange carry the plain number text ("4.5", or "" when empty), so pages keep
 * working with exact decimals; what is shown is French-style ("1 234,5") once the field is left.
 * Text that is not a number is passed on as typed so the page can say what is wrong.
 */
const DecimalInput = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ className, value, onChange, onBlur, ...props }, ref) => {
  const plain = value === undefined || value === null ? "" : String(value);
  const [text, setText] = React.useState(() => inputText(plain));
  // The value this field last sent up: when it comes back unchanged, keep what the person typed ("4," stays "4,").
  const sent = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (plain !== sent.current) setText(inputText(plain));
    sent.current = null;
  }, [plain]);
  const unreadable = text.trim() !== "" && parseNumberInput(text) === null;
  const fr = formatLang() === "fr";
  const hintId = React.useId();
  // Size and placement classes go on the wrapper, so the field sits where it did; the rest styles the field.
  const classes = (className ?? "").split(/\s+/).filter(Boolean);
  const outer = classes.filter((c) => LAYOUT.test(c));
  const inner = classes.filter((c) => !LAYOUT.test(c));
  return (
    <span className={cn("relative block w-full", outer)}>
      <input
        {...props}
        ref={ref}
        type="text"
        autoComplete="off"
        className={cn(BASE, inner)}
        value={text}
        aria-invalid={unreadable || props["aria-invalid"] || undefined}
        aria-describedby={unreadable ? cn(hintId, props["aria-describedby"]) : props["aria-describedby"]}
        onChange={(e) => {
          const typed = e.target.value;
          setText(typed);
          const parsed = parseNumberInput(typed);
          const out = parsed === null ? typed : parsed;
          sent.current = out;
          if (out === plain) sent.current = null;
          onChange?.({ ...e, target: { value: out, name: e.target.name }, currentTarget: { value: out, name: e.target.name } } as unknown as React.ChangeEvent<HTMLInputElement>);
        }}
        onBlur={(e) => {
          setText(inputText(plain));
          onBlur?.(e);
        }}
      />
      {unreadable && (
        <span
          id={hintId}
          role="alert"
          className="pointer-events-none absolute left-0 top-full z-20 mt-1 whitespace-nowrap rounded border border-destructive bg-popover px-2 py-0.5 text-xs font-medium text-destructive shadow-sm"
        >
          {fr ? "Nombre non reconnu" : "Not a number"}
        </span>
      )}
    </span>
  );
});
DecimalInput.displayName = "DecimalInput";

export { Input, DateInput, DecimalInput };
