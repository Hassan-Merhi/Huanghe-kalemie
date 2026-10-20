import { describe, expect, it } from "vitest";

describe("forty-seventh UI audit: a packing list with a \"Variante\" column", async () => {
  const { CONTAINER_FIELDS, readSheet, STOCK_FIELDS } = await import("../../client/src/lib/sheets");
  const csv = (text: string, name = "pl.csv") => new File([text], name, { type: "text/csv" });
  // The audit's file: mirrors left and right, tyres by size, no codes.
  const audit = "article;variante;code;quantité;prix unitaire;poids total;volume total\nRétroviseur;droit;;10;35;8;0,1\nRétroviseur;gauche;;10;35;8;0,1\nPneu;2.75-17;;40;120;400;0,8\nPneu;3.25-18;;40;130;400;0,8\n";

  it("reads \"Variante\" (or \"Variant\") as the size, so the two mirrors stay two stock lines", async () => {
    const { rows, found, ignored } = await readSheet(csv(audit), CONTAINER_FIELDS);
    expect(found).toContain("size");
    expect(rows.map((r) => r.size)).toEqual(["droit", "gauche", "2.75-17", "3.25-18"]);
    expect(ignored).toEqual([]);
    const { rows: stock } = await readSheet(csv("Article,Variant,Qty\nPneu,3.00-18,4\n"), STOCK_FIELDS);
    expect(stock[0].size).toBe("3.00-18");
  });

  it("names the columns no field reads, as written in the file, instead of dropping them silently", async () => {
    const { rows, ignored } = await readSheet(csv("article;Fournisseur ;code;quantité;prix unitaire;Remarque\nPneu;Kenda;P1;40;120;fragile\n"), CONTAINER_FIELDS);
    expect(ignored).toEqual(["Fournisseur", "Remarque"]);
    expect(rows[0]).toMatchObject({ name: "Pneu", sku: "P1", quantity: "40", unitPrice: "120" });
    // A blank header cell (an empty trailing column) is not a column to report.
    const { ignored: none } = await readSheet(csv("article;quantité;prix unitaire;\nPneu;40;120;\n"), CONTAINER_FIELDS);
    expect(none).toEqual([]);
  });
});
