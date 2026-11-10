import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { format as formatNumber } from "numfmt";
import Papa from "papaparse";
import { columnLetters } from "@/lib/review";

/**
 * Spreadsheet → JSON model for the in-browser grid. Keeps, per cell, the value
 * as Excel would display it, the formula (if any) and basic formatting. Rows are
 * split into chunks so large sheets load progressively. Anything beyond the
 * limits is truncated *with a note*, never silently.
 */

export const CHUNK_ROWS = 500;
const MAX_ROWS_PER_SHEET = 100_000;
const MAX_COLS = 702; // A…ZZ
const MAX_CELLS_TOTAL = 2_000_000;

export type CellStyle = { b?: 1; i?: 1; u?: 1; color?: string; bg?: string; align?: "left" | "center" | "right"; wrap?: 1; size?: number };
/** [col, displayed text, formula, styleIndex, kind] — kind: n number, s string, b boolean, d date, e error. */
export type CellTuple = [number, string, string | null, number | null, "n" | "s" | "b" | "d" | "e"];
/** [row, height px or null, hidden 0/1, cells] */
export type RowTuple = [number, number | null, 0 | 1, CellTuple[]];

export type SheetMeta = {
  index: number;
  name: string;
  hidden: boolean;
  rows: number;
  cols: number;
  chunks: number;
  colWidths: number[];
  hiddenCols: number[];
  merges: string[];
  frozen: { rows: number; cols: number } | null;
  styles: CellStyle[];
  truncated: boolean;
  formulas: number;
};
export type SheetManifest = { version: 1; chunkRows: number; sheets: SheetMeta[]; notes: string[] };
export type SheetChunk = { sheet: number; chunk: number; data: { rows: RowTuple[] } };

const argbToHex = (argb?: string) => (argb && /^[0-9A-Fa-f]{8}$/.test(argb) ? `#${argb.slice(2).toUpperCase()}` : undefined);

function styleOf(cell: ExcelJS.Cell): CellStyle | null {
  const s: CellStyle = {};
  const f = cell.font;
  if (f?.bold) s.b = 1;
  if (f?.italic) s.i = 1;
  if (f?.underline) s.u = 1;
  const color = argbToHex((f?.color as { argb?: string } | undefined)?.argb);
  if (color && color !== "#000000") s.color = color;
  if (f?.size && f.size !== 11) s.size = f.size;
  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  if (fill?.type === "pattern" && fill.pattern === "solid") {
    const bg = argbToHex((fill.fgColor as { argb?: string } | undefined)?.argb);
    if (bg && bg !== "#FFFFFF") s.bg = bg;
  }
  const h = cell.alignment?.horizontal;
  if (h === "left" || h === "center" || h === "right") s.align = h;
  if (cell.alignment?.wrapText) s.wrap = 1;
  return Object.keys(s).length ? s : null;
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** Display text, formula and kind for one cell, the way Excel shows it. */
export function describeCell(cell: Pick<ExcelJS.Cell, "value" | "numFmt">, date1904 = false): { text: string; formula: string | null; kind: CellTuple[4] } {
  let value = cell.value as unknown;
  let formula: string | null = null;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const v = value as { formula?: string; sharedFormula?: string; result?: unknown; richText?: { text: string }[]; text?: string; error?: string; hyperlink?: string };
    if (v.formula || v.sharedFormula) {
      formula = `=${v.formula ?? v.sharedFormula}`;
      value = v.result;
      if (value && typeof value === "object" && "error" in (value as object)) value = { error: (value as { error: string }).error };
    } else if (v.richText) value = v.richText.map((r) => r.text).join("");
    else if (v.hyperlink !== undefined) value = v.text ?? v.hyperlink;
  }
  const fmt = cell.numFmt || "General";
  if (value == null) return { text: "", formula, kind: "s" };
  if (typeof value === "object" && "error" in (value as object)) return { text: String((value as { error: string }).error), formula, kind: "e" };
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE", formula, kind: "b" };
  if (value instanceof Date) {
    const serial = (value.getTime() - EXCEL_EPOCH) / 86_400_000 - (date1904 ? 1462 : 0);
    return { text: safeFormat(/[dmyhs]/i.test(fmt) ? fmt : "yyyy-mm-dd", serial), formula, kind: "d" };
  }
  if (typeof value === "number") return { text: safeFormat(fmt, value), formula, kind: "n" };
  return { text: String(value), formula, kind: "s" };
}

function safeFormat(fmt: string, n: number): string {
  try {
    return formatNumber(fmt, n);
  } catch {
    return String(n);
  }
}

class Builder {
  sheets: SheetMeta[] = [];
  chunks: SheetChunk[] = [];
  notes: string[] = [];
  cells = 0;

  add(meta: Omit<SheetMeta, "chunks" | "styles" | "truncated" | "formulas" | "index">, rows: Map<number, { h: number | null; hidden: boolean; cells: { col: number; cell: CellTuple; style: CellStyle | null }[] }>, truncated: boolean) {
    const index = this.sheets.length;
    const styles: CellStyle[] = [];
    const styleIds = new Map<string, number>();
    let formulas = 0;
    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
    const chunkMap = new Map<number, RowTuple[]>();
    for (const [r, row] of ordered) {
      const tuple: RowTuple = [r, row.h, row.hidden ? 1 : 0, []];
      for (const c of row.cells) {
        let sid: number | null = null;
        if (c.style) {
          const key = JSON.stringify(c.style);
          sid = styleIds.get(key) ?? styles.push(c.style) - 1;
          styleIds.set(key, sid);
        }
        if (c.cell[2]) formulas++;
        tuple[3].push([c.cell[0], c.cell[1], c.cell[2], sid, c.cell[4]]);
      }
      const ci = Math.floor(r / CHUNK_ROWS);
      (chunkMap.get(ci) ?? chunkMap.set(ci, []).get(ci)!).push(tuple);
    }
    const chunkCount = Math.max(1, Math.ceil(meta.rows / CHUNK_ROWS));
    for (let ci = 0; ci < chunkCount; ci++) this.chunks.push({ sheet: index, chunk: ci, data: { rows: chunkMap.get(ci) ?? [] } });
    this.sheets.push({ ...meta, index, chunks: chunkCount, styles, truncated, formulas });
  }
}

async function fromXlsx(path: string): Promise<Builder> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const date1904 = !!(wb.properties as { date1904?: boolean }).date1904;
  const b = new Builder();
  for (const ws of wb.worksheets) {
    const rowsTotal = ws.rowCount;
    const colsTotal = ws.columnCount;
    const rowLimit = Math.min(rowsTotal, MAX_ROWS_PER_SHEET);
    const colLimit = Math.min(colsTotal, MAX_COLS);
    let truncated = rowsTotal > rowLimit || colsTotal > colLimit;
    const rows = new Map<number, { h: number | null; hidden: boolean; cells: { col: number; cell: CellTuple; style: CellStyle | null }[] }>();
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const r = rowNumber - 1;
      if (r >= rowLimit) return;
      if (b.cells >= MAX_CELLS_TOTAL) {
        truncated = true;
        return;
      }
      const entry = { h: row.height ? Math.round((row.height * 4) / 3) : null, hidden: !!row.hidden, cells: [] as { col: number; cell: CellTuple; style: CellStyle | null }[] };
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const c = colNumber - 1;
        if (c >= colLimit) return;
        const d = describeCell(cell, date1904);
        const style = styleOf(cell);
        if (!d.text && !d.formula && !style) return;
        entry.cells.push({ col: c, cell: [c, d.text, d.formula, null, d.kind], style });
        b.cells++;
      });
      if (entry.cells.length || entry.hidden || entry.h) rows.set(r, entry);
    });
    const colWidths: number[] = [];
    const hiddenCols: number[] = [];
    for (let c = 1; c <= colLimit; c++) {
      const col = ws.getColumn(c);
      colWidths.push(col.width ? Math.round(col.width * 7 + 5) : 72);
      if (col.hidden) hiddenCols.push(c - 1);
    }
    const view = ws.views?.[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
    const merges = ((ws.model as { merges?: string[] }).merges ?? []).filter((m) => typeof m === "string");
    b.add(
      {
        name: ws.name,
        hidden: ws.state !== "visible",
        rows: Math.max(1, rowLimit),
        cols: Math.max(1, colLimit),
        colWidths,
        hiddenCols,
        merges,
        frozen: view?.state === "frozen" ? { rows: view.ySplit ?? 0, cols: view.xSplit ?? 0 } : null,
      },
      rows,
      truncated,
    );
    if (truncated) {
      b.notes.push(
        `Sheet "${ws.name}" is larger than the preview limit; only the first ${rowLimit.toLocaleString("en")} rows × ${columnLetters(colLimit - 1)} columns are shown. Download the original for everything.`,
      );
    }
  }
  const missing = b.sheets.reduce((n, s) => n + s.formulas, 0);
  if (missing) {
    // Formulas are kept verbatim; their displayed values come from the file's saved results.
    b.notes.push(`${missing.toLocaleString("en")} formula cell${missing === 1 ? "" : "s"} show the values saved in the file. Select a cell to see its formula.`);
  }
  return b;
}

async function fromDelimited(path: string, format: "csv" | "tsv", filename: string): Promise<Builder> {
  const text = (await readFile(path, "utf8")).replace(/^﻿/, "");
  const parsed = Papa.parse<string[]>(text, { delimiter: format === "tsv" ? "\t" : "", skipEmptyLines: false });
  const b = new Builder();
  const all = parsed.data;
  const rowLimit = Math.min(all.length, MAX_ROWS_PER_SHEET);
  const colsTotal = all.reduce((m, r) => Math.max(m, r.length), 0);
  const colLimit = Math.min(colsTotal, MAX_COLS);
  const rows = new Map<number, { h: null; hidden: false; cells: { col: number; cell: CellTuple; style: null }[] }>();
  for (let r = 0; r < rowLimit && b.cells < MAX_CELLS_TOTAL; r++) {
    const cells = all[r]
      .slice(0, colLimit)
      .map((v, c) => ({ col: c, cell: [c, v, null, null, v !== "" && Number.isFinite(Number(v)) ? "n" : "s"] as CellTuple, style: null }))
      .filter((x) => x.cell[1] !== "");
    b.cells += cells.length;
    if (cells.length) rows.set(r, { h: null, hidden: false, cells });
  }
  const truncated = all.length > rowLimit || colsTotal > colLimit;
  b.add(
    {
      name: filename.replace(/\.(csv|tsv)$/i, "").slice(0, 100) || "Sheet1",
      hidden: false,
      rows: Math.max(1, rowLimit),
      cols: Math.max(1, colLimit),
      colWidths: Array.from({ length: Math.max(1, colLimit) }, () => 96),
      hiddenCols: [],
      merges: [],
      frozen: null,
    },
    rows,
    truncated,
  );
  if (truncated) b.notes.push(`Only the first ${rowLimit.toLocaleString("en")} rows are shown. Download the original for everything.`);
  if (parsed.errors.length) b.notes.push(`${parsed.errors.length} row${parsed.errors.length === 1 ? " has" : "s have"} inconsistent quoting and may display differently.`);
  return b;
}

export async function buildSheetModel(path: string, format: "xlsx" | "csv" | "tsv", filename: string): Promise<{ manifest: SheetManifest; chunks: SheetChunk[] }> {
  const b = format === "xlsx" ? await fromXlsx(path) : await fromDelimited(path, format, filename);
  return { manifest: { version: 1, chunkRows: CHUNK_ROWS, sheets: b.sheets, notes: b.notes }, chunks: b.chunks };
}
