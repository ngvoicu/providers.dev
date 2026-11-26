// What a page says, read from its HTML and from its markdown version apart, so that the two can be compared character
// by character and cell by cell. This reader shares no code with src/core/markdown.ts: it scans the HTML with its own
// expressions, and reads the markdown as text. Each side gives the same shape: the text outside tables in order, and
// each table as rows of cells. Spaces do not count (markdown sets apart what the page's styles set apart), nor do the
// marks markdown adds: emphasis, code, brackets, pipes, list and heading marks, the colon between a term and its text.

/** Elements whose content is not text of the page; the same list src/core/markdown.ts documents. */
const SKIP_TAGS = new Set(["script", "style", "svg", "template", "form", "input", "select", "option", "datalist", "textarea", "noscript", "dialog"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** The folded raw JSON a page shows and the API serves whole, left out of the markdown on purpose. */
export const RAW_JSON_FOLDS = ["Show the full entry as published", "Response schemas and headers", "Full JSON Schema"];

export interface PageText {
  /** The text outside tables, in order, without spaces or marks. */
  text: string;
  /** Each table: its rows (the head, read down each column, first), each row its cells, each cell its text. */
  tables: string[][][];
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) =>
    name[0] === "#" ? String.fromCodePoint(name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)) : NAMED[name.toLowerCase()] ?? whole);

/** A piece of text without spaces and without the marks markdown adds (taken out of the page's text alike). */
export function bare(text: string): string {
  return text.replace(/[\s\u00a0`*\\|[\]#>•:]/g, "");
}

const attr = (attrs: string, name: string): string | null => {
  const match = new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*"([^"]*)"|\\s*=\\s*'([^']*)'|(?=[\\s/>]|$))`, "i").exec(attrs);
  return match ? decode(match[1] ?? match[2] ?? "") : null;
};

interface Cell { text: string; rowspan: number; colspan: number }
interface Row { head: boolean; cells: Cell[] }

/** The text of the page's HTML, `<main>` only, as words and tables. Pictures give their words (alt, aria-label). */
export function htmlText(html: string, pictureWords: (text: string) => string = (text) => text): PageText {
  const start = html.indexOf("<main");
  const main = start === -1 ? html : html.slice(html.indexOf(">", start) + 1, html.lastIndexOf("</main>"));
  const folds = new RegExp(`<details[^>]*>\\s*<summary[^>]*>(?:${RAW_JSON_FOLDS.join("|")})</summary>[\\s\\S]*?</details>`, "g");
  const source = main.replace(/<!--[\s\S]*?-->/g, "").replace(folds, "");
  const out: PageText = { text: "", tables: [] };
  /** The open elements: name, whether skipped. */
  const stack: { tag: string; skip: boolean }[] = [];
  let lastPicture: string | null = null;
  let table: { rows: Row[]; caption: string } | null = null;
  let cell: Cell | null = null;
  let inHead = false;
  let inCaption = false;
  const emit = (text: string): void => {
    if (inCaption && table) table.caption += ` ${text}`;
    else if (cell) cell.text += ` ${text}`;
    else if (!table) out.text += bare(text);
  };
  for (const match of source.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g)) {
    const [, close, rawName, attrs = "", text] = match;
    const skipping = stack.some((item) => item.skip);
    if (text !== undefined) {
      if (!skipping) emit(decode(text));
      continue;
    }
    const tag = rawName!.toLowerCase();
    if (close) {
      const at = stack.map((item) => item.tag).lastIndexOf(tag);
      if (at !== -1) stack.length = at;
      if (skipping) continue;
      if ((tag === "td" || tag === "th") && cell) cell = null;
      if (tag === "thead") inHead = false;
      if (tag === "caption") inCaption = false;
      if (tag === "table" && table) {
        out.text += bare(table.caption);
        out.tables.push(tableRows(table.rows));
        table = null;
      }
      // Words never run across elements.
      emit(" ");
      continue;
    }
    const classes = (attr(attrs, "class") ?? "").split(/\s+/);
    const skip = SKIP_TAGS.has(tag) || attr(attrs, "aria-hidden") === "true" || attr(attrs, "hidden") !== null || classes.includes("hidden")
      || (tag === "button" && classes.some((name) => ["copy", "warn-sign", "icon-button"].includes(name)));
    const isVoid = VOID_TAGS.has(tag) || /\/\s*$/.test(attrs);
    if (!isVoid) stack.push({ tag, skip });
    if (skipping || skip) continue;
    if (tag === "img" || attr(attrs, "role") === "img") {
      const said = pictureWords((tag === "img" ? attr(attrs, "alt") : attr(attrs, "aria-label")) ?? "").replace(/\s+/g, " ").trim();
      if (said && said !== lastPicture) emit(said);
      if (said) lastPicture = said;
      // A drawing's own content is its label.
      if (tag !== "img" && !isVoid) stack[stack.length - 1]!.skip = true;
      continue;
    }
    if (tag === "table") table = { rows: [], caption: "" };
    else if (tag === "thead") inHead = true;
    else if (tag === "caption") inCaption = true;
    else if (tag === "tr" && table) table.rows.push({ head: inHead, cells: [] });
    else if ((tag === "td" || tag === "th") && table) {
      cell = { text: "", rowspan: Number(attr(attrs, "rowspan")) || 1, colspan: Number(attr(attrs, "colspan")) || 1 };
      table.rows.at(-1)?.cells.push(cell);
    }
    emit(" ");
  }
  return out;
}

/** A table's rows as cells of words: a cell spanning rows is in each, one spanning columns in its first; the head rows read down each column. */
function tableRows(rows: Row[]): string[][] {
  const grid: (string | undefined)[][] = rows.map(() => []);
  rows.forEach((row, y) => {
    let x = 0;
    for (const item of row.cells) {
      while (grid[y]![x] !== undefined) x++;
      for (let dy = 0; dy < item.rowspan && y + dy < rows.length; dy++) for (let dx = 0; dx < item.colspan; dx++) grid[y + dy]![x + dx] = dx === 0 ? item.text : "";
      x += item.colspan;
    }
  });
  const said = (text: string | undefined): string => bare(text ?? "");
  const head = rows.flatMap((row, y) => (row.head ? [grid[y]!] : []));
  const body = rows.flatMap((row, y) => (row.head ? [] : [grid[y]!]));
  const width = Math.max(1, ...head.map((row) => row.length), ...body.map((row) => row.findLastIndex((text) => said(text) !== "") + 1));
  const header = Array.from({ length: width }, (_, x) => [...new Set(head.map((row) => said(row[x])).filter(Boolean))].join(""));
  return [header, ...body.map((row) => Array.from({ length: width }, (_, x) => said(row[x])))];
}

/** The text of a markdown version: its body only (no front matter, no footer), as text and tables. */
export function markdownText(markdown: string): PageText {
  let body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
  const footer = body.lastIndexOf("\n---\n");
  if (footer !== -1) body = body.slice(0, footer);
  const plain = (text: string): string => bare(text
    .replace(/<br>/g, " ")
    .replace(/!\[/g, "[")
    // A link's target, not a "](" of the text, whose bracket is escaped (an odd number of backslashes before it).
    .replace(/(?<!\\)((?:\\\\)*)\]\((?:<[^>]*>|[^)\s]*)\)/g, "$1]")
    .replace(/\\([\\`*_[\]<>#|+\-.)])/g, "$1"));
  const out: PageText = { text: "", tables: [] };
  let rows: string[][] | null = null;
  for (const line of body.split("\n")) {
    if (line.startsWith("| ") || line === "|") {
      if (/^\|( --- \|)+$/.test(line)) continue;
      // Cells are split at a | that is not escaped.
      (rows ??= []).push(line.slice(2, -2).split(/(?<!\\) \| /).map(plain));
      continue;
    }
    if (rows) { out.tables.push(rows); rows = null; }
    if (/^`{3,}\w*$/.test(line) || line === "---") continue;
    // A list's mark, a heading's: the markdown's, not the page's words.
    out.text += plain(line.replace(/^\s*(?:[-]|\d+\.)\s/, "").replace(/^#{1,6}\s/, ""));
  }
  if (rows) out.tables.push(rows);
  return out;
}
