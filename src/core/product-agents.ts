// The products' sites for agents: each page's markdown version, written from the page as built (its <main> and its
// footer, src/core/markdown.ts), and the site's llms.txt, made of its pages' own titles and descriptions. Run at build
// by scripts/finalize-site.ts; the Worker serves both as files of the site (worker/index.ts).
import { decodeEntities, elementHtml, htmlToMarkdown } from "./markdown.ts";
import type { ProductSite } from "./product-site.ts";

/** What a built page's head says: its title, its description, the site's name and the repository of its code. */
export function pageHead(html: string): { title: string; description: string; siteName: string; repository: string | null } {
  const pick = (pattern: RegExp): string => decodeEntities(pattern.exec(html)?.[1] ?? "").trim();
  let repository: string | null = null;
  for (const [, script] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const graph = (JSON.parse(script!) as { "@graph"?: Record<string, unknown>[] })["@graph"] ?? [];
    // The repository of the product itself: the source code whose target is the site's application.
    const own = graph.find((node) => node["@type"] === "SoftwareSourceCode" && node.targetProduct !== undefined);
    if (own && typeof own.codeRepository === "string") repository = own.codeRepository;
  }
  return {
    title: pick(/<title>([^<]*)<\/title>/),
    description: pick(/<meta name="description" content="([^"]*)"/),
    siteName: pick(/<meta property="og:site_name" content="([^"]*)"/),
    repository,
  };
}

/** The markdown version of a built page of a product's site: front matter, the page's main content, its footer. */
export function productMarkdown(site: ProductSite, path: string, html: string): string {
  const head = pageHead(html);
  const base = new URL(path, site.site).toString();
  const main = elementHtml(html, "main");
  if (main === null) throw new Error(`${base}: the built page has no <main>`);
  const footer = elementHtml(html, "footer");
  const front = ["---", `title: ${JSON.stringify(head.title)}`, `description: ${JSON.stringify(head.description)}`, `canonical: ${base}`, "---"].join("\n");
  return `${front}\n\n${htmlToMarkdown(main, { base })}\n${footer ? `\n---\n\n${htmlToMarkdown(footer, { base })}\n` : ""}`;
}

/** A product site's /llms.txt: the site's name and description, its pages in markdown, its code, and providers.dev's. */
export function productLlmsTxt(site: ProductSite, pages: readonly { path: string; html: string }[]): string {
  const heads = pages.map(({ path, html }) => ({ path, ...pageHead(html) }));
  const home = heads.find((page) => page.path === "/") ?? heads[0]!;
  const lines = [
    `# ${home.siteName}`,
    "",
    `> ${home.description}`,
    "",
    "Each page has a markdown version with the same content: add `index.html.md` to its address, or ask for the page with `Accept: text/markdown`.",
    "",
    "## Pages",
    "",
    ...heads.map((page) => `- [${page.title}](${new URL(`${page.path}index.html.md`, site.site).toString()}): ${page.description}`),
    ...(home.repository ? ["", "## Source code", "", `- [${home.repository.replace(/^https:\/\//, "")}](${home.repository})`] : []),
    "",
    "## Optional",
    "",
    "- [providers.dev](https://providers.dev/llms.txt): AI models as each provider and access method exposes them, with a read-only JSON API",
    "",
  ];
  return lines.join("\n");
}
