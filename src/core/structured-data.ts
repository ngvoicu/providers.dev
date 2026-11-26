// The structured data (JSON-LD, schema.org) of the three sites, built from the same answer as the page it is on. It
// claims nothing a page does not show: no rating, no review, no offer (a price on an entry is a provider's list price,
// not something providers.dev sells; the products are free), no date (the data has no date at which a page changed,
// and a publication's time is a build's clock), no person. Every address in it answers: the API is named by its
// documentation and its OpenAPI document, never /api/v1/ (404).
//
// One identity for the publisher on all three hosts: https://providers.dev/#organization.
import { SITE } from "./crawl.ts";
import type { PageMeta } from "./page-meta.ts";
import type { Meta } from "./schema.ts";

export type JsonLd = Record<string, unknown>;

export const ORGANIZATION_ID = `${SITE}/#organization`;
export const WEBSITE_ID = `${SITE}/#website`;
export const CATALOG_ID = `${SITE}/#catalog`;
export const API_ID = `${SITE}/docs/api/#api`;

/** The publisher, in full on the home page, by reference elsewhere on providers.dev, and named on the product sites. */
export const ORGANIZATION: JsonLd = {
  "@type": "Organization",
  "@id": ORGANIZATION_ID,
  name: "providers.dev",
  url: `${SITE}/`,
  logo: `${SITE}/apple-touch-icon.png`,
  email: "office@providers.dev",
};
const publisher = { "@id": ORGANIZATION_ID };

/**
 * A <script type="application/ld+json"> of one graph. `<`, `>` and `&` are written as escapes, so that no value can end
 * the script or start a comment; the JSON reads the same.
 */
export function jsonLdScript(graph: readonly JsonLd[]): string {
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph })
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<script type="application/ld+json">${json}</script>`;
}

/** A trail as the page shows it above its h1: name and absolute address of each step, the page itself last. */
export type Crumbs = readonly (readonly [name: string, url: string])[];

export function breadcrumbList(url: string, crumbs: Crumbs): JsonLd {
  return {
    "@type": "BreadcrumbList",
    "@id": `${url}#breadcrumb`,
    itemListElement: crumbs.map(([name, item], index) => ({ "@type": "ListItem", position: index + 1, name, item })),
  };
}

/** A page of a site: its address, its title and description, the site it is part of, its trail where it shows one. */
export function webPage(options: { type?: string; url: string; meta: PageMeta; website: string; crumbs?: Crumbs; more?: JsonLd }): JsonLd[] {
  const { type = "WebPage", url, meta, website, crumbs, more = {} } = options;
  const page: JsonLd = { "@type": type, "@id": url, url, name: meta.title, description: meta.description, inLanguage: "en", isPartOf: { "@id": website }, ...more };
  if (!crumbs) return [page];
  return [{ ...page, breadcrumb: { "@id": `${url}#breadcrumb` } }, breadcrumbList(url, crumbs)];
}

/** The home page: the publisher, the site, the catalog as a dataset and the page. Counts and version from its meta. */
export function homeGraph(meta: Meta, page: PageMeta): JsonLd[] {
  const url = `${SITE}/`;
  const pi = meta.pi.snapshot !== null;
  return [
    ORGANIZATION,
    { "@type": "WebSite", "@id": WEBSITE_ID, name: "providers.dev", url, description: "AI models as each provider exposes them: context window, maximum output, price and prompt caching, per provider and access method.", inLanguage: "en", publisher },
    {
      "@type": "Dataset",
      "@id": CATALOG_ID,
      name: "providers.dev catalog of AI models by provider and access method",
      description: `${page.description} Each quantity has one value; a warning marks where its sources disagree.`,
      url,
      version: meta.dataset_version,
      creator: publisher,
      publisher,
      isBasedOn: ["https://models.dev", ...(pi ? ["https://pi.dev/models"] : [])],
      license: `${SITE}/docs/licensing/`,
      isAccessibleForFree: true,
      variableMeasured: ["Context window", "Maximum output", "Price", "Cache lifetime, short", "Cache lifetime, long"],
      distribution: [
        { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE}/api.json` },
        { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE}/api/v1/catalog` },
      ],
    },
    ...webPage({ url, meta: page, website: WEBSITE_ID, more: { about: { "@id": CATALOG_ID } } }),
  ];
}

/** A page of the catalog (a list, a provider, a model, an entry, the evidence): part of the site and of the dataset. */
export function catalogPage(url: string, meta: PageMeta, options: { type?: string; crumbs?: Crumbs } = {}): JsonLd[] {
  return webPage({ ...options, url, meta, website: WEBSITE_ID, more: { isPartOf: [{ "@id": WEBSITE_ID }, { "@id": CATALOG_ID }] } });
}

/** A document of the site: a technical article (methodology, contributing, the API's guide) or a plain page (licensing). */
export function documentGraph(url: string, meta: PageMeta, headline: string, article: boolean, about?: JsonLd): JsonLd[] {
  if (!article) return webPage({ url, meta, website: WEBSITE_ID });
  return webPage({ type: "TechArticle", url, meta, website: WEBSITE_ID, more: { headline, author: publisher, publisher, ...(about ? { about } : {}) } });
}

/** The API, on its documentation page: named by addresses that answer (its guide and its OpenAPI document). */
export function webApi(info: { title: string; description: string }): JsonLd {
  return {
    "@type": "WebAPI",
    "@id": API_ID,
    name: info.title,
    description: info.description.split(/(?<=\.)\s+/)[0],
    url: `${SITE}/docs/api/`,
    documentation: [`${SITE}/docs/api/`, `${SITE}/api/v1/openapi.json`],
    provider: publisher,
  };
}

// ---- the product sites (built by Astro; the page passes what it shows)

/** The publisher as a product site names it: the same identity, with its name and address. */
const PUBLISHER_NAMED: JsonLd = { "@type": "Organization", "@id": ORGANIZATION_ID, name: "providers.dev", url: `${SITE}/` };

export interface Product {
  /** The product site's root, "https://provimux.providers.dev". */
  site: string;
  name: string;
  /** The page's own description. */
  description: string;
  title: string;
  repository: string;
  /** The project it is built on, credited as the page credits it. */
  basedOn: { name: string; repository: string; author: JsonLd };
  more?: JsonLd;
}

/** A product's home: the site, the page, the application and its source code. Free (MIT); no offer, rating or review. */
export function productGraph(product: Product): JsonLd[] {
  const url = `${product.site}/`;
  const website = `${url}#website`;
  const software = `${url}#software`;
  const upstream = { "@type": "SoftwareSourceCode", "@id": product.basedOn.repository, name: product.basedOn.name, codeRepository: product.basedOn.repository, author: product.basedOn.author };
  return [
    PUBLISHER_NAMED,
    { "@type": "WebSite", "@id": website, name: product.name, url, inLanguage: "en", publisher },
    ...webPage({ url, meta: { title: product.title, description: product.description }, website, more: { about: { "@id": software } } }),
    {
      "@type": "SoftwareApplication",
      "@id": software,
      name: product.name,
      description: product.description,
      url,
      applicationCategory: "DeveloperApplication",
      isAccessibleForFree: true,
      license: "https://opensource.org/licenses/MIT",
      publisher,
      image: `${product.site}/og.png`,
      isBasedOn: { "@id": upstream["@id"] },
      ...product.more,
    },
    { "@type": "SoftwareSourceCode", "@id": `${url}#source`, name: product.name, codeRepository: product.repository, license: "https://opensource.org/licenses/MIT", targetProduct: { "@id": software }, isBasedOn: { "@id": upstream["@id"] } },
    upstream,
  ];
}

/** Another page of a product site, with the trail it shows (the product, then the page). */
export function productPage(site: string, path: string, meta: PageMeta, crumbs: Crumbs): JsonLd[] {
  return [PUBLISHER_NAMED, ...webPage({ url: new URL(path, site).toString(), meta, website: `${site}/#website`, crumbs, more: { publisher } })];
}
