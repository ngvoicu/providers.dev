// Presentation only: all descriptions, fields and examples come from the served OpenAPI JSON.
import { escapeHtml as e, exact } from "./format.ts";
import type { Documentation } from "./resources.ts";
import type { Meta } from "./schema.ts";

/** The fields of /api/v1/meta that authored text can name in a slot. */
const META_SLOTS = { stale_after_days: (meta: Meta) => exact(meta.stale_after_days) } as const;

/**
 * Authored text is compiled with the templates and holds no published value: where it states one, it names the field
 * of /api/v1/meta in a slot, `<span data-meta="stale_after_days"><code>stale_after_days</code></span>`. A page prints
 * the field there, from the meta it read for this response.
 */
export function fillMetaSlots(document: Documentation, meta: Meta): Documentation {
  const body_html = document.body_html.replace(/<span data-meta="([a-z_]+)">(?:<code>[a-z_]+<\/code>)?<\/span>/g, (slot, name: string) =>
    name in META_SLOTS ? `<span data-meta="${name}">${META_SLOTS[name as keyof typeof META_SLOTS](meta)}</span>` : slot);
  return { ...document, body_html };
}

type Schema = Record<string, unknown>;
export interface OpenApiDocument {
  info: { title: string; version: string; description: string };
  paths: Record<string, { get: { summary: string; description?: string; parameters?: (Schema & { name: string; in: string; description?: string; required?: boolean; schema: Schema })[]; responses: Record<string, Schema> } }>;
  components: { schemas: Record<string, Schema> };
  "x-guide"?: { id: string; title: string; paragraphs: string[] }[];
}

function typeText(schema: Schema = {}): string {
  if (typeof schema.$ref === "string") return schema.$ref.split("/").at(-1)!;
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as Schema[]).map(typeText).join(" | ");
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (schema.type === "array") return `${typeText(schema.items as Schema)}[]`;
  return typeof schema.type === "string" ? schema.type : "any";
}

/** Text of the OpenAPI document as HTML: escaped, with `code` in backticks set as code. */
const inline = (text: string): string => e(text).replace(/`([^`]+)`/g, "<code>$1</code>");

export function documentHtml(document: Documentation): string {
  const links = document.toc.map((item) => `<a href="#${e(item.id)}">${e(item.label)}</a>`).join("");
  // The contents sit beside the text where there is room, and under the title where there is not.
  return `<div class="grid gap-10 lg:grid-cols-[13rem_minmax(0,1fr)]"><aside class="hidden lg:block"><nav class="toc" aria-label="On this page"><p>On this page</p>${links}</nav></aside><article class="min-w-0"><header class="prose"><h1>${e(document.title)}</h1><p class="lead !mt-3">${inline(document.lead)}</p></header><nav class="toc toc-inline lg:hidden" aria-label="On this page"><p>On this page</p>${links}</nav>${document.body_html}</article></div>`;
}

export function openapiHtml(document: OpenApiDocument): string {
  const guide = document["x-guide"] ?? [];
  const toc = [...guide.map(({ id, title }) => ({ id, label: title })), { id: "endpoints", label: "Endpoints" }, { id: "fields", label: "Response schemas" }];
  const endpoints = Object.entries(document.paths).map(([path, { get }]) => `<section class="mt-8"><h3><code>GET ${e(path)}</code></h3><p>${e(get.summary)}</p>${get.description ? `<p class="hint mt-2">${inline(get.description)}</p>` : ""}
    ${get.parameters?.length ? `<div class="scroll mt-3"><table class="facts stack-phone"><thead><tr><th>Parameter</th><th>Location</th><th>Value</th><th>Meaning</th></tr></thead><tbody>${get.parameters.map((param) => `<tr><th class="nowrap" data-label="Parameter"><code>${e(param.name)}</code>${param.required ? " *" : ""}</th><td data-label="Location">${e(param.in)}</td><td data-label="Value"><code>${e(typeText(param.schema))}</code>${param.schema.default !== undefined ? `<div class="hint">Default: ${e(String(param.schema.default))}</div>` : ""}</td><td class="span-row" data-label="Meaning">${e(param.description ?? "")}</td></tr>`).join("")}</tbody></table></div>` : ""}
    <details class="mt-3"><summary>Response schemas and headers</summary><pre>${e(JSON.stringify(get.responses, null, 2))}</pre></details></section>`).join("");
  const fields = Object.entries(document.components.schemas).map(([name, schema]) => {
    const variants = (Array.isArray(schema.anyOf) ? schema.anyOf : [schema]) as Schema[];
    const rows = variants.flatMap((variant) => {
      const required = new Set((variant.required as string[]) ?? []);
      const properties = (variant.properties ?? {}) as Record<string, Schema>;
      const prefix = variants.length > 1 ? `${typeText(properties.kind)}.` : "";
      return Object.entries(properties).map(([key, field]) => `<tr><th class="nowrap" data-label="Field (* required)"><code>${e(prefix + key)}${required.has(key) ? "*" : ""}</code></th><td class="span-row" data-label="Type"><code>${e(typeText(field))}</code></td><td class="span-row" data-label="Meaning">${e(String(field.description ?? ""))}</td></tr>`);
    });
    return `<section class="mt-8" id="${e(name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase())}"><h3>${e(name)}</h3><p class="hint mt-2">${e(String(schema.description ?? ""))}</p>${rows.length ? `<div class="scroll mt-3"><table class="facts stack-phone"><thead><tr><th>Field (* required)</th><th>Type</th><th>Meaning</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` : ""}${Array.isArray(schema.examples) ? schema.examples.map((example) => `<details class="mt-3"><summary>Example (fictional)</summary><pre>${e(JSON.stringify(example, null, 2))}</pre></details>`).join("") : ""}<details class="mt-3"><summary>Full JSON Schema</summary><pre>${e(JSON.stringify(schema, null, 2))}</pre></details></section>`;
  }).join("");
  return documentHtml({ title: "API", description: document.info.description, lead: document.info.description, toc, body_html: `<p class="hint mt-3">Version ${e(document.info.version)} · <a href="/api/v1/openapi.json">OpenAPI JSON</a></p>${guide.map((section) => `<section class="prose"><h2 id="${e(section.id)}">${e(section.title)}</h2>${section.paragraphs.map((p) => `<p>${inline(p)}</p>`).join("")}</section>`).join("")}<h2 id="endpoints">Endpoints</h2>${endpoints}<h2 id="fields">Response schemas</h2>${fields}` });
}
