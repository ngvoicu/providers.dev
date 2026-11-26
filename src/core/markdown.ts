// The markdown version of a page: the page's own HTML, the same string a browser gets, written as markdown. Nothing
// here reads data or works anything out: every word and figure is one the page prints, in the page's order, so the
// markdown cannot say what the page does not. What it leaves out is what is not text of the page: forms, buttons,
// pictures drawn for the eye only (aria-hidden), what the page hides, and the raw JSON a page folds away that the API
// serves whole (`omit`). Screen-reader text (`sr-only`) stays: it is the page's words.
//
// The HTML is the site's own, made by src/core/*.ts and Astro: well formed, attributes quoted. The parser below reads
// that, and is tolerant of what it does not expect (an unclosed element is closed by its parent's end).

export interface MarkdownOptions {
  /** The page's absolute address: relative links and pictures are written against it, in full. */
  base: string;
  /** Leave out a folded `<details>` whose summary is this text (the raw JSON the API serves whole). */
  omit?: (summary: string) => boolean;
}

interface Element { tag: string; attrs: Record<string, string>; children: Node[] }
type Node = Element | string;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", mdash: "—", ndash: "–", hellip: "…", middot: "·", rarr: "→", larr: "←", nearr: "↗", copy: "©", times: "×", ge: "≥", le: "≤", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

/** The tree of an HTML fragment. Text is decoded; comments and doctypes are dropped. */
export function parseHtml(html: string): Element {
  const root: Element = { tag: "#root", attrs: {}, children: [] };
  const stack: Element[] = [root];
  let at = 0;
  const text = (value: string): void => { if (value) stack.at(-1)!.children.push(decodeEntities(value)); };
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open === -1) { text(html.slice(at)); break; }
    text(html.slice(at, open));
    if (html.startsWith("<!--", open)) { const end = html.indexOf("-->", open + 4); at = end === -1 ? html.length : end + 3; continue; }
    if (html[open + 1] === "!" || html[open + 1] === "?") { const end = html.indexOf(">", open); at = end === -1 ? html.length : end + 1; continue; }
    if (html[open + 1] === "/") {
      const end = html.indexOf(">", open);
      const name = html.slice(open + 2, end === -1 ? html.length : end).trim().toLowerCase();
      at = end === -1 ? html.length : end + 1;
      // Close up to the element of that name, if it is open; a stray end tag is ignored.
      const index = stack.findLastIndex((element) => element.tag === name);
      if (index > 0) stack.length = index;
      continue;
    }
    // A start tag: its name, then its attributes, values in double or single quotes or bare.
    const name = /^[a-zA-Z][\w:-]*/.exec(html.slice(open + 1, open + 64))?.[0];
    if (!name) { text("<"); at = open + 1; continue; }
    let cursor = open + 1 + name.length;
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    while (cursor < html.length) {
      while (/\s/.test(html[cursor] ?? "")) cursor++;
      if (html[cursor] === ">") { cursor++; break; }
      if (html.startsWith("/>", cursor)) { selfClosing = true; cursor += 2; break; }
      const attr = /^[^\s=>/]+/.exec(html.slice(cursor, cursor + 256))?.[0];
      if (!attr) { cursor++; continue; }
      cursor += attr.length;
      while (/\s/.test(html[cursor] ?? "")) cursor++;
      let value = "";
      if (html[cursor] === "=") {
        cursor++;
        while (/\s/.test(html[cursor] ?? "")) cursor++;
        const quote = html[cursor];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, cursor + 1);
          value = html.slice(cursor + 1, end === -1 ? html.length : end);
          cursor = end === -1 ? html.length : end + 1;
        } else {
          const bare = /^[^\s>]*/.exec(html.slice(cursor))![0];
          value = bare;
          cursor += bare.length;
        }
      }
      attrs[attr.toLowerCase()] = decodeEntities(value);
    }
    const element: Element = { tag: name.toLowerCase(), attrs, children: [] };
    stack.at(-1)!.children.push(element);
    at = cursor;
    if (RAW.has(element.tag)) {
      const end = html.toLowerCase().indexOf(`</${element.tag}`, at);
      element.children.push(html.slice(at, end === -1 ? html.length : end));
      const close = end === -1 ? html.length : html.indexOf(">", end);
      at = close === -1 ? html.length : close + 1;
      continue;
    }
    if (!VOID.has(element.tag) && !selfClosing) stack.push(element);
  }
  return root;
}

const BLOCK = new Set(["address", "article", "aside", "blockquote", "caption", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"]);
/** Never text of the page: scripts, styles, drawings, controls, and the forms that hold them. */
const SKIP = new Set(["script", "style", "svg", "template", "form", "input", "select", "option", "datalist", "textarea", "noscript", "head", "title", "meta", "link", "source", "dialog"]);
/** Buttons that are only controls (copy a value, open a warning, switch the theme): what they open is in the page. */
const CONTROL_CLASSES = ["copy", "warn-sign", "icon-button"];

const classes = (element: Element): string[] => (element.attrs.class ?? "").split(/\s+/).filter(Boolean);

function skipped(element: Element): boolean {
  if (SKIP.has(element.tag)) return true;
  if (element.attrs["aria-hidden"] === "true" || "hidden" in element.attrs) return true;
  const list = classes(element);
  // Tailwind's `hidden` alone hides an element at every width (`hidden lg:block` is a copy for wide screens only).
  if (list.includes("hidden")) return true;
  if (element.tag === "button" && list.some((name) => CONTROL_CLASSES.includes(name))) return true;
  return false;
}

/** A picture's words, without an e-mail address of a sample screen: the site names office@providers.dev only. */
export function pictureWords(text: string): string {
  return text.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (address) => (address.toLowerCase() === "office@providers.dev" ? address : "an e-mail address"));
}

interface Context {
  options: MarkdownOptions;
  /** The words of the last picture written: the dark copy of a light screenshot is not written again. */
  lastPicture: string | null;
}

/** Whether an element holds a block anywhere in what is written of it. */
function holdsBlock(node: Node): boolean {
  if (typeof node === "string" || skipped(node)) return false;
  if (node.tag === "img" || node.attrs.role === "img") return false;
  return BLOCK.has(node.tag) || node.children.some(holdsBlock);
}

const isBlock = (node: Node): boolean => typeof node !== "string" && !skipped(node) && (BLOCK.has(node.tag) || holdsBlock(node));

function absolute(href: string, ctx: Context): string {
  try {
    return new URL(href, ctx.options.base).toString();
  } catch {
    return href;
  }
}

/** Text as markdown reads it literally. */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([`*[\]<])/g, "\\$1")
    .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (match) => match.replace("_", "\\_"));
}

function codeSpan(text: string): string {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value.trim()) return "";
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/**
 * A line of a drawn terminal inside `<pre>`: a span the page's styles set on a line of its own (`pmx-t-row`,
 * `t-line`). The line ends where it ends, as the page shows it.
 */
const ownLine = (element: Element): boolean => classes(element).some((name) => /(^|-)(row|line)$/.test(name));

/** The plain text of an element, as written (for code and for a summary's words). */
function plain(node: Node): string {
  if (typeof node === "string") return node;
  if (skipped(node)) return "";
  if (node.tag === "br") return "\n";
  const text = node.children.map(plain).join("");
  return ownLine(node) && !text.endsWith("\n") ? `${text}\n` : text;
}

const wrap = (mark: string, text: string): string => {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return match[2] ? `${match[1]}${mark}${match[2]}${mark}${match[3]}` : text;
};

function linkTarget(href: string): string {
  return /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent).replace(/ /g, "%20")}>` : href;
}

function picture(element: Element, ctx: Context): string {
  const words = pictureWords((element.tag === "img" ? element.attrs.alt : element.attrs["aria-label"]) ?? "").replace(/\s+/g, " ").trim();
  if (!words || words === ctx.lastPicture) return "";
  ctx.lastPicture = words;
  if (element.tag === "img" && element.attrs.src) return `![${escapeText(words)}](${linkTarget(absolute(element.attrs.src, ctx))})`;
  return `*${escapeText(words)}*`;
}

/**
 * Inline content as one line of markdown. `sep` is what a block inside it becomes: a line break in a paragraph, `<br>`
 * in a table's cell, a space in a heading. Two elements side by side with nothing between them are set apart by a
 * space, as the page's styles set them apart.
 */
function inline(nodes: readonly Node[], ctx: Context, sep: string, inCode = false): string {
  let out = "";
  let lastElement = false;
  const add = (piece: string, element: boolean): void => {
    if (!piece) return;
    if (element && lastElement && out && !/\s$/.test(out) && !/^\s/.test(piece) && !out.endsWith(sep) && !piece.startsWith(sep)) out += " ";
    out += piece;
    lastElement = element;
  };
  for (const node of nodes) {
    if (typeof node === "string") { add(inCode ? node : escapeText(node.replace(/\s+/g, " ")), false); continue; }
    if (skipped(node)) continue;
    add(inlineElement(node, ctx, sep), true);
  }
  return out;
}

function inlineElement(element: Element, ctx: Context, sep: string): string {
  if (element.tag === "img" || element.attrs.role === "img") return picture(element, ctx);
  switch (element.tag) {
    case "br": return sep === " " ? " " : sep;
    case "code": case "kbd": case "samp": return codeSpan(plain(element));
    case "pre": return codeSpan(plain(element));
    case "strong": case "b": return wrap("**", inline(element.children, ctx, sep));
    case "em": case "i": return wrap("*", inline(element.children, ctx, sep));
    case "small": return ` ${inline(element.children, ctx, sep).trim()}`;
    case "a": {
      const text = inline(element.children, ctx, sep).trim();
      const href = element.attrs.href;
      if (!href) return text;
      const target = absolute(href, ctx);
      return text ? `[${text}](${linkTarget(target)})` : "";
    }
    case "details": {
      const summary = element.children.find((child): child is Element => typeof child !== "string" && child.tag === "summary");
      const words = summary ? plain(summary).replace(/\s+/g, " ").trim() : "";
      if (ctx.options.omit?.(words)) return "";
      return blockSeparated(element.children, ctx, sep);
    }
    case "li": return `${sep === "<br>" ? "• " : ""}${blockSeparated(element.children, ctx, sep)}`;
    case "dt": return blockSeparated(element.children, ctx, sep);
    case "dd": return blockSeparated(element.children, ctx, sep);
    default:
      return BLOCK.has(element.tag) || holdsBlock(element) ? blockSeparated(element.children, ctx, sep) : inline(element.children, ctx, sep);
  }
}

/** Inline content whose blocks are each set on their own line (`sep`); a term and what it is stay on one line. */
function blockSeparated(nodes: readonly Node[], ctx: Context, sep: string): string {
  let out = "";
  let run: Node[] = [];
  let term = false;
  const push = (text: string, after: string): void => {
    if (!text) return;
    out += out ? `${after}${text}` : text;
  };
  const flush = (): void => {
    push(inline(run, ctx, sep).replace(/ {2,}/g, " ").trim(), sep);
    run = [];
  };
  for (const node of nodes) {
    if (isBlock(node)) {
      flush();
      const element = node as Element;
      const text = inlineElement(element, ctx, sep).replace(/ {2,}/g, " ").trim();
      push(text, element.tag === "dd" && term ? ": " : sep);
      if (text) term = element.tag === "dt";
    } else run.push(node);
  }
  flush();
  return out;
}

/** Markdown blocks of block content, each a string, in order. */
function blocks(nodes: readonly Node[], ctx: Context): string[] {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = (): void => {
    const text = paragraph(run, ctx);
    if (text) out.push(text);
    run = [];
  };
  for (const node of nodes) {
    if (isBlock(node)) {
      flush();
      out.push(...block(node as Element, ctx));
    } else run.push(node);
  }
  flush();
  return out;
}

/** A run of inline content as a paragraph; a line that markdown would read as a heading, quote or list is escaped. */
function paragraph(nodes: readonly Node[], ctx: Context): string {
  const text = inline(nodes, ctx, "\n").split("\n").map((line) => line.replace(/ {2,}/g, " ").trim()).filter(Boolean).join("\n");
  return text.replace(/^(#{1,6}\s|>|[-+]\s)/gm, "\\$1").replace(/^(\d+)([.)]\s)/gm, "$1\\$2");
}

function block(element: Element, ctx: Context): string[] {
  const tag = element.tag;
  if (/^h[1-6]$/.test(tag)) {
    const text = inline(element.children, ctx, " ").replace(/\s+/g, " ").trim();
    return text ? [`${"#".repeat(Number(tag[1]))} ${text}`] : [];
  }
  if (element.attrs.role === "img") { const words = picture(element, ctx); return words ? [words] : []; }
  const list = classes(element);
  switch (tag) {
    case "hr": return ["---"];
    case "pre": {
      const text = plain(element).replace(/^\n/, "").replace(/\s+$/, "");
      if (!text) return [];
      const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
      const fence = "`".repeat(longest + 1);
      return [`${fence}${text.trimStart().startsWith("{") || text.trimStart().startsWith("[") ? "json" : ""}\n${text}\n${fence}`];
    }
    case "ul": case "ol": return [listOf(element.children.filter((child): child is Element => typeof child !== "string" && child.tag === "li" && !skipped(child)), tag === "ol", ctx)].filter(Boolean);
    case "dl": return [definitions(element, ctx)].filter(Boolean);
    case "table": return table(element, ctx);
    case "details": {
      const summary = element.children.find((child): child is Element => typeof child !== "string" && child.tag === "summary");
      const words = summary ? plain(summary).replace(/\s+/g, " ").trim() : "";
      if (ctx.options.omit?.(words)) return [];
      const head = summary ? inline(summary.children, ctx, " ").replace(/\s+/g, " ").trim() : "";
      return [...(head ? [`**${head}**`] : []), ...blocks(element.children.filter((child) => child !== summary), ctx)];
    }
    case "blockquote": return blocks(element.children, ctx).map((text) => text.replace(/^/gm, "> "));
    default:
      // The tiles of an entry's page: one item each, its label, its value and what is under it.
      if (list.includes("tiles")) return [listOf(element.children.filter((child): child is Element => typeof child !== "string" && classes(child).includes("tile")), false, ctx)].filter(Boolean);
      return blocks(element.children, ctx);
  }
}

/** A list: each item's blocks under its marker, the lines after the first set in by the marker's width. */
function listOf(items: readonly Element[], ordered: boolean, ctx: Context): string {
  return items
    .map((item, at) => {
      const marker = ordered ? `${at + 1}. ` : "- ";
      const text = blocks(item.children, ctx).join("\n");
      if (!text) return "";
      const pad = " ".repeat(marker.length);
      return marker + text.split("\n").map((line, index) => (index === 0 || !line ? line : pad + line)).join("\n");
    })
    .filter(Boolean)
    .join("\n");
}

/** A list of terms: one item per term, "term: what it is". */
function definitions(element: Element, ctx: Context): string {
  const pairs: { term: Element[]; detail: Element[] }[] = [];
  const visit = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (typeof node === "string" || skipped(node)) continue;
      if (node.tag === "dt") pairs.push({ term: [node], detail: [] });
      else if (node.tag === "dd") (pairs.at(-1) ?? (pairs.push({ term: [], detail: [] }), pairs.at(-1)!)).detail.push(node);
      else visit(node.children);
    }
  };
  visit(element.children);
  return pairs
    .map(({ term, detail }) => {
      const head = term.map((item) => inline(item.children, ctx, " ").replace(/\s+/g, " ").trim()).join(" ");
      const body = detail.flatMap((item) => blocks(item.children, ctx)).join("\n");
      const lines = `${head}${head && body ? ": " : ""}${body}`.split("\n");
      return `- ${lines.map((line, index) => (index === 0 || !line ? line : `  ${line}`)).join("\n")}`;
    })
    .join("\n");
}

/**
 * A table as a markdown table: one row per row, a cell's blocks on lines of their own (`<br>`). A cell that spans rows
 * is written in each row it spans, so that every row reads whole; one that spans columns is written in its first
 * column, and the others it covers stay empty. The head is the rows of `thead`, read down each column.
 */
function table(element: Element, ctx: Context): string[] {
  const head: Element[] = [];
  const body: Element[] = [];
  let caption = "";
  const visit = (nodes: readonly Node[], inHead: boolean): void => {
    for (const node of nodes) {
      if (typeof node === "string" || skipped(node)) continue;
      if (node.tag === "caption") caption = inline(node.children, ctx, " ").replace(/\s+/g, " ").trim();
      else if (node.tag === "tr") (inHead ? head : body).push(node);
      else if (node.tag === "thead") visit(node.children, true);
      else visit(node.children, inHead);
    }
  };
  visit(element.children, false);
  const grid = (rows: readonly Element[]): string[][] => {
    const cells: string[][] = [];
    const taken: boolean[][] = [];
    rows.forEach((row, y) => {
      cells[y] ??= [];
      taken[y] ??= [];
      let x = 0;
      for (const cell of row.children) {
        if (typeof cell === "string" || skipped(cell) || (cell.tag !== "td" && cell.tag !== "th")) continue;
        while (taken[y]![x]) x++;
        const text = blockSeparated(cell.children, ctx, "<br>").replace(/\n/g, " ").replace(/\|/g, "\\|").trim();
        const width = Math.max(1, Number(cell.attrs.colspan) || 1);
        const height = Math.max(1, Number(cell.attrs.rowspan) || 1);
        for (let dy = 0; dy < height && y + dy < rows.length; dy++) {
          for (let dx = 0; dx < width; dx++) {
            (cells[y + dy] ??= [])[x + dx] = dx === 0 ? text : "";
            (taken[y + dy] ??= [])[x + dx] = true;
          }
        }
        x += width;
      }
    });
    return cells.map((row) => Array.from(row, (cell) => cell ?? ""));
  };
  const headRows = grid(head);
  const bodyRows = grid(body);
  // A cell that spans more columns than the table has (colspan="8" on a table of 7) adds none.
  const used = (row: readonly string[]): number => row.findLastIndex((cell) => cell !== "") + 1;
  const width = Math.max(1, ...headRows.map((row) => row.length), ...bodyRows.map(used));
  const header = Array.from({ length: width }, (_, x) => [...new Set(headRows.map((row) => row[x] ?? "").filter(Boolean))].join(" "));
  const line = (row: readonly string[]): string => `| ${Array.from({ length: width }, (_, x) => row[x] ?? "").join(" | ")} |`;
  const rows = [line(header), `|${" --- |".repeat(width)}`, ...bodyRows.map(line)];
  return [...(caption ? [caption] : []), rows.join("\n")];
}

/** The markdown of an HTML fragment of the site. */
export function htmlToMarkdown(html: string, options: MarkdownOptions): string {
  const ctx: Context = { options, lastPicture: null };
  return blocks(parseHtml(html).children, ctx).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The part of a page inside one element, found by its opening tag (`<main`, `<footer`), or null. */
export function elementHtml(html: string, tag: string): string | null {
  const start = html.indexOf(`<${tag}`);
  if (start === -1) return null;
  const open = html.indexOf(">", start);
  const end = html.lastIndexOf(`</${tag}>`);
  return open === -1 || end === -1 || end < open ? null : html.slice(open + 1, end);
}
