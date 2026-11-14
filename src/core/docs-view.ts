// Presentation only: all descriptions, fields and examples come from the served OpenAPI JSON.
import { escapeHtml as e } from "./format.ts";
import type { Documentation } from "./resources.ts";

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

export function documentHtml(document: Documentation): string {
  return `<div class="grid gap-10 lg:grid-cols-[13rem_minmax(0,1fr)]"><aside class="hidden lg:block"><nav class="toc" aria-label="On this page"><p>On this page</p>${document.toc.map((item) => `<a href="#${e(item.id)}">${e(item.label)}</a>`).join("")}</nav></aside><article class="min-w-0"><header class="prose"><h1>${e(document.title)}</h1><p class="lead !mt-3">${e(document.lead)}</p></header>${document.body_html}</article></div>`;
}

export function openapiHtml(document: OpenApiDocument): string {
  const guide = document["x-guide"] ?? [];
  const toc = [...guide.map(({ id, title }) => ({ id, label: title })), { id: "endpoints", label: "Endpoints" }, { id: "fields", label: "Response schemas" }];
  const endpoints = Object.entries(document.paths).map(([path, { get }]) => `<section class="mt-8"><h3><code>GET ${e(path)}</code></h3><p>${e(get.summary)}</p>${get.description ? `<p class="hint mt-2">${e(get.description)}</p>` : ""}
    ${get.parameters?.length ? `<div class="scroll mt-3"><table class="facts"><thead><tr><th>Parameter</th><th>Location</th><th>Value</th><th>Meaning</th></tr></thead><tbody>${get.parameters.map((param) => `<tr><th><code>${e(param.name)}</code>${param.required ? " *" : ""}</th><td>${e(param.in)}</td><td><code>${e(typeText(param.schema))}</code>${param.schema.default !== undefined ? `<div class="hint">Default: ${e(String(param.schema.default))}</div>` : ""}</td><td>${e(param.description ?? "")}</td></tr>`).join("")}</tbody></table></div>` : ""}
    <details class="mt-3"><summary>Response schemas and headers</summary><pre>${e(JSON.stringify(get.responses, null, 2))}</pre></details></section>`).join("");
  const fields = Object.entries(document.components.schemas).map(([name, schema]) => {
    const variants = (Array.isArray(schema.anyOf) ? schema.anyOf : [schema]) as Schema[];
    const rows = variants.flatMap((variant) => {
      const required = new Set((variant.required as string[]) ?? []);
      const properties = (variant.properties ?? {}) as Record<string, Schema>;
      const prefix = variants.length > 1 ? `${typeText(properties.kind)}.` : "";
      return Object.entries(properties).map(([key, field]) => `<tr><th><code>${e(prefix + key)}${required.has(key) ? "*" : ""}</code></th><td><code>${e(typeText(field))}</code></td><td>${e(String(field.description ?? ""))}</td></tr>`);
    });
    return `<section class="mt-8" id="${e(name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase())}"><h3>${e(name)}</h3><p class="hint mt-2">${e(String(schema.description ?? ""))}</p>${rows.length ? `<div class="scroll mt-3"><table class="facts"><thead><tr><th>Field (* required)</th><th>Type</th><th>Meaning</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` : ""}${Array.isArray(schema.examples) ? schema.examples.map((example) => `<details class="mt-3"><summary>Example (fictional)</summary><pre>${e(JSON.stringify(example, null, 2))}</pre></details>`).join("") : ""}<details class="mt-3"><summary>Full JSON Schema</summary><pre>${e(JSON.stringify(schema, null, 2))}</pre></details></section>`;
  }).join("");
  return documentHtml({ title: "API", description: document.info.description, lead: document.info.description, toc, body_html: `<p class="hint mt-3">Version ${e(document.info.version)} · <a href="/api/v1/openapi.json">OpenAPI JSON</a></p>${guide.map((section) => `<section class="prose"><h2 id="${e(section.id)}">${e(section.title)}</h2>${section.paragraphs.map((p) => `<p>${e(p)}</p>`).join("")}</section>`).join("")}<h2 id="endpoints">Endpoints</h2>${endpoints}<h2 id="fields">Response schemas</h2>${fields}` });
}
