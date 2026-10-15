import * as React from "react"

import { cn } from "@/lib/utils"

/** Copy each column's heading onto its cells, so a phone can show every row as a labelled card. */
function labelCells(table: HTMLTableElement) {
  const heads = Array.from(table.querySelectorAll(":scope > thead > tr:last-child > th"));
  if (!heads.length) return;
  const labels = heads.map((h) => (h as HTMLElement).innerText?.trim() || h.textContent?.trim() || "");
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

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & {
    /** On phones, show each row as a card with the column names as labels (default on). */
    cards?: boolean
  }
>(({ className, cards = true, ...props }, ref) => {
  const inner = React.useRef<HTMLTableElement | null>(null)
  React.useLayoutEffect(() => {
    const table = inner.current
    if (!table || !cards) return
    labelCells(table)
    const observer = new MutationObserver(() => labelCells(table))
    observer.observe(table, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [cards])
  return (
    <div className="relative w-full overflow-auto">
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
