import * as React from "react"

import { cn } from "@/lib/utils"

/** Copy each column's heading onto its cells, so a phone can show every row as a labelled card. */
function labelCells(table: HTMLTableElement) {
  const heads = Array.from(table.querySelectorAll(":scope > thead > tr:last-child > th"));
  if (!heads.length) return;
  // A heading made of several lines (a cost and its method) can give its card label: a hidden heading's
  // text would otherwise run its lines together ("FretPar valeur d'achat").
  const labels = heads.map((h) => h.getAttribute("data-card-label") || (h as HTMLElement).innerText?.trim() || h.textContent?.trim() || "");
  table.querySelectorAll(":scope > tbody > tr, :scope > tfoot > tr").forEach((row) => {
    let col = 0;
    Array.from(row.children).forEach((cell) => {
      const label = labels[col] ?? "";
      if (cell.getAttribute("data-label") !== label) cell.setAttribute("data-label", label);
      // Nothing to read in the cell: a phone card leaves it out instead of showing a bare label.
      const blank = !(cell as HTMLElement).innerText?.trim() && !cell.querySelector("input, button, select, textarea, a, svg, img");
      if (blank !== cell.hasAttribute("data-blank")) cell.toggleAttribute("data-blank", blank);
      col += (cell as HTMLTableCellElement).colSpan || 1;
    });
  });
}

/**
 * Whether the last column holds only the row's actions (buttons, a menu): it then stays in view at the
 * right edge while a table too wide for its box scrolls ("Valider", "Supprimer" at 1024 px).
 */
function actionsColumn(table: HTMLTableElement) {
  const head = table.querySelector(":scope > thead > tr:last-child > th:last-child") as HTMLElement | null
  const cells = Array.from(table.querySelectorAll(":scope > tbody > tr > td:last-child")) as HTMLTableCellElement[]
  if (!head || !cells.length) return false
  const title = (head.innerText ?? head.textContent ?? "").trim()
  if (title && !/^actions?$/i.test(title)) return false
  return cells.every((cell) => {
    if ((cell.colSpan || 1) > 1) return true
    if (!cell.querySelector("button, a")) return !(cell.innerText ?? "").trim()
    // Nothing but the controls: their own text aside, the cell says nothing.
    const clone = cell.cloneNode(true) as HTMLElement
    clone.querySelectorAll("button, a").forEach((el) => el.remove())
    return !(clone.textContent ?? "").trim()
  })
}

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & {
    /** On phones, show each row as a card with the column names as labels (default on). */
    cards?: boolean
  }
>(({ className, cards = true, ...props }, ref) => {
  const inner = React.useRef<HTMLTableElement | null>(null)
  const box = React.useRef<HTMLDivElement | null>(null)
  // Columns hidden past the right edge: a fade there says the table scrolls.
  const [more, setMore] = React.useState(false)
  // Left of the actions column when it stays in view, so the fade never covers its buttons.
  const [fadeAt, setFadeAt] = React.useState(0)
  React.useLayoutEffect(() => {
    const table = inner.current
    if (!table || !cards) return
    labelCells(table)
    const observer = new MutationObserver(() => labelCells(table))
    observer.observe(table, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [cards])
  React.useLayoutEffect(() => {
    const table = inner.current
    const scroller = box.current
    if (!table || !scroller) return
    const check = () => {
      const overflow = scroller.scrollWidth > scroller.clientWidth + 1
      if (overflow !== scroller.hasAttribute("data-overflow")) scroller.toggleAttribute("data-overflow", overflow)
      const sticky = overflow && actionsColumn(table)
      if (sticky !== table.hasAttribute("data-sticky-end")) table.toggleAttribute("data-sticky-end", sticky)
      const end = sticky ? (table.querySelector(":scope > thead > tr:last-child > th:last-child") as HTMLElement | null)?.offsetWidth ?? 0 : 0
      setFadeAt(end)
      // With the actions column held, what is hidden is the columns under it, until the end is reached.
      setMore(overflow && scroller.scrollWidth - scroller.scrollLeft - scroller.clientWidth > 2)
    }
    check()
    scroller.addEventListener("scroll", check, { passive: true })
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(check) : null
    resize?.observe(scroller)
    resize?.observe(table)
    const mutation = new MutationObserver(check)
    mutation.observe(table, { childList: true, subtree: true })
    return () => {
      scroller.removeEventListener("scroll", check)
      resize?.disconnect()
      mutation.disconnect()
    }
  }, [])
  return (
    <div className="relative w-full">
      <div ref={box} className="table-scroll w-full overflow-auto">
        <table
          ref={(node) => {
            inner.current = node
            if (typeof ref === "function") ref(node)
            else if (ref) ref.current = node
          }}
          className={cn("w-full caption-bottom text-sm", cards && "table-cards", className)}
          {...props}
        />
      </div>
      <div
        aria-hidden
        data-testid="table-more-right"
        className={cn(
          "pointer-events-none absolute inset-y-0 w-8 bg-gradient-to-l from-black/10 to-transparent transition-opacity dark:from-black/50",
          more ? "opacity-100" : "opacity-0",
        )}
        style={{ right: fadeAt }}
      />
    </div>
  )
})
Table.displayName = "Table"

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />
))
TableHeader.displayName = "TableHeader"

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("[&_tr:last-child]:border-0", className)}
    {...props}
  />
))
TableBody.displayName = "TableBody"

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
      className
    )}
    {...props}
  />
))
TableFooter.displayName = "TableFooter"

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
      className
    )}
    {...props}
  />
))
TableRow.displayName = "TableRow"

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-12 px-4 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0",
      className
    )}
    {...props}
  />
))
TableHead.displayName = "TableHead"

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn("p-4 align-middle [&:has([role=checkbox])]:pr-0", className)}
    {...props}
  />
))
TableCell.displayName = "TableCell"

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn("mt-4 text-sm text-muted-foreground", className)}
    {...props}
  />
))
TableCaption.displayName = "TableCaption"

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
