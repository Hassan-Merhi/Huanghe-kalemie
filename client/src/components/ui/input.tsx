import * as React from "react";
import { CalendarDays } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatLang } from "@/lib/format";

const BASE =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none md:text-sm";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    // Dates are always shown dd/mm/yyyy, whatever language the phone or browser is set to.
    if (type === "date") return <DateInput className={className} {...props} ref={ref} />;
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

export { Input, DateInput };
