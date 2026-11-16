// The structure of /api/v1: what a client's code depends on, read from the OpenAPI document the code generates.
// The record of it is committed (structure/api-v1.json, written by `npm run structure:update`), and so is the
// structure of 1.0.0 (structure/api-v1-1.0.0.json, never edited). The tests check that the document has exactly the
// recorded structure, and that the record only grows from 1.0.0 (`structureBreaks`).
//
// Structure: the paths and their methods; each parameter (where it is, whether it is required, its type, its allowed
// values, its range and default); each response (status, headers, media type, schema); each component schema. A
// schema keeps its types, which properties it has and which of them are optional, what may be null, enum and const
// values, formats and patterns (a pattern only where no format names the string), ranges, array items and map
// values. Not structure: descriptions, summaries, examples, the guide, the info block, the order of keys and of enum
// values.
import { ENDPOINTS } from "../../src/core/openapi.ts";
import type { ParamDoc } from "../../src/core/query.ts";

/** One schema, as recorded. */
export interface Node {
  /** A JSON type; "json" = any JSON value, "any" = anything. Absent on a union or a reference. */
  type?: string;
  nullable?: true;
  /** A component, by name. */
  ref?: string;
  /** A reference back to a schema that contains this one: 1 = the nearest. */
  recursive?: number;
  anyOf?: Node[];
  enum?: unknown[];
  const?: unknown;
  format?: string;
  pattern?: string;
  minimum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  minItems?: number;
  maximum?: number;
  exclusiveMaximum?: number;
  maxLength?: number;
  maxItems?: number;
  properties?: Record<string, Node>;
  /** On a property: it may be absent. */
  optional?: true;
  /** The values of the keys not listed in properties: a map, or an object open to more keys. */
  additional?: Node;
  items?: Node;
  /** A query parameter that takes a comma-separated list: its allowed values, or true for any. */
  list?: string[] | true;
  default?: unknown;
}

export interface Parameter {
  in: string;
  name: string;
  required: boolean;
  schema: Node;
}
export interface Response {
  headers: Record<string, Node>;
  content: Record<string, Node>;
}
export interface Operation {
  parameters: Record<string, Parameter>;
  responses: Record<string, Response>;
}
export interface Structure {
  paths: Record<string, Record<string, Operation>>;
  components: Record<string, Node>;
}

const LOWER = ["minimum", "exclusiveMinimum", "minLength", "minItems"] as const;
const UPPER = ["maximum", "exclusiveMaximum", "maxLength", "maxItems"] as const;
/** Keywords that are words for people, not structure. */
const PROSE = new Set(["description", "examples", "example", "title", "$comment", "summary"]);
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

type Schema = Record<string, unknown>;

const isObject = (value: unknown): value is Schema => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const sortValues = (values: unknown[]): unknown[] => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** A JSON value, as zod writes z.json(): recorded as type "json". */
const JSON_VALUE: Node = {
  anyOf: [{ type: "array", items: { recursive: 1 } }, { type: "boolean" }, { type: "number" }, { type: "object", additional: { recursive: 1 } }, { type: "string" }],
  nullable: true,
};

/** A schema of the document as recorded. `defs` are the local definitions of the component it is in. */
function node(schema: unknown, where: string, defs: Schema, stack: string[] = []): Node {
  if (schema === true || (isObject(schema) && Object.keys(schema).every((key) => PROSE.has(key)))) return { type: "any" };
  if (!isObject(schema)) throw new Error(`${where}: a schema that is not an object`);
  const out: Node = {};
  for (const [key, value] of Object.entries(schema)) {
    if (PROSE.has(key) || key === "$defs" || key === "propertyNames" || key === "required") continue;
    if (key === "$ref") {
      const ref = value as string;
      const local = /^#\/components\/schemas\/[^/]+\/\$defs\/(.+)$/.exec(ref);
      if (local) {
        // A local definition is written out where it is used, so that its generated name does not matter.
        const name = local[1]!;
        const depth = stack.lastIndexOf(name);
        if (depth >= 0) return { recursive: stack.length - depth };
        if (!(name in defs)) throw new Error(`${where}: ${ref} points at nothing`);
        return node(defs[name], where, defs, [...stack, name]);
      }
      const component = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
      if (!component) throw new Error(`${where}: a reference this record does not read: ${ref}`);
      out.ref = component[1]!;
    } else if (key === "type") {
      const types = (Array.isArray(value) ? value : [value]) as string[];
      const rest = types.filter((type) => type !== "null");
      if (rest.length === 0) out.type = "null";
      else if (types.includes("null")) out.nullable = true;
      if (rest.length === 1) out.type = rest[0]!;
      else if (rest.length > 1) out.anyOf = rest.map((type) => ({ type }));
    } else if (key === "anyOf" || key === "oneOf") {
      const branches = (value as unknown[]).map((branch, index) => node(branch, `${where}|${index}`, defs, stack));
      const kept = branches.filter((branch) => !(branch.type === "null" && Object.keys(branch).length === 1));
      if (kept.length < branches.length) out.nullable = true;
      if (kept.length === 1) Object.assign(out, kept[0], kept[0]!.nullable || out.nullable ? { nullable: true } : {});
      else out.anyOf = sortValues(kept) as Node[];
    } else if (key === "enum") {
      const values = value as unknown[];
      if (values.includes(null)) out.nullable = true;
      out.enum = sortValues(values.filter((item) => item !== null));
    } else if (key === "pattern" && schema.format !== undefined) {
      // A format says what the string is; the pattern beside it is how zod checks it, and can change with zod.
      continue;
    } else if (key === "const" || key === "format" || key === "pattern" || key === "default") {
      (out as Record<string, unknown>)[key] = value;
    } else if ((LOWER as readonly string[]).includes(key) || (UPPER as readonly string[]).includes(key)) {
      (out as Record<string, unknown>)[key] = value;
    } else if (key === "properties") {
      const required = new Set((schema.required as string[] | undefined) ?? []);
      out.properties = Object.fromEntries(
        Object.entries(value as Schema).map(([name, property]) => [name, { ...node(property, `${where}.${name}`, defs, stack), ...(required.has(name) ? {} : { optional: true as const }) }]),
      );
    } else if (key === "additionalProperties") {
      if (value !== false) out.additional = node(value, `${where}{*}`, defs, stack);
    } else if (key === "items") {
      out.items = node(value, `${where}[]`, defs, stack);
    } else {
      throw new Error(`${where}: the keyword ${key} is not read by scripts/lib/api-structure.ts. Say there whether it is structure.`);
    }
  }
  if (out.type === undefined && out.anyOf === undefined && out.ref === undefined && out.recursive === undefined && out.enum === undefined && out.const === undefined) {
    if (Object.keys(out).every((key) => key === "nullable")) return { type: "any" };
  }
  const { nullable, ...rest } = out;
  if (nullable && same(rest, { anyOf: JSON_VALUE.anyOf })) return { type: "json" };
  return { ...rest, ...(nullable ? { nullable } : {}) };
}

/** The structure of an OpenAPI document. `endpoints` give the allowed values of list parameters, which the document says in words. */
export function apiStructure(document: Record<string, unknown>, endpoints: readonly { path: string; params: readonly ParamDoc[] }[] = ENDPOINTS): Structure {
  const lists = new Map(endpoints.flatMap((endpoint) => endpoint.params.filter((param) => param.kind === "list").map((param) => [`${endpoint.path} ${param.name}`, param.values ? [...param.values].sort() : (true as const)] as const)));
  const paths: Structure["paths"] = {};
  for (const [path, item] of Object.entries(document.paths as Record<string, Schema>)) {
    paths[path] = {};
    for (const [method, raw] of Object.entries(item)) {
      if (!METHODS.includes(method)) continue;
      const operation = raw as { parameters?: Schema[]; responses: Record<string, Schema> };
      const where = `${method.toUpperCase()} ${path}`;
      const parameters: Operation["parameters"] = {};
      for (const parameter of operation.parameters ?? []) {
        const name = parameter.name as string;
        const place = parameter.in as string;
        const schema = node(parameter.schema, `${where} ${name}`, {});
        const list = place === "query" ? lists.get(`${path} ${name}`) : undefined;
        parameters[`${place}:${name}`] = { in: place, name, required: parameter.required === true, schema: list ? { ...schema, list } : schema };
      }
      const responses: Operation["responses"] = {};
      for (const [status, response] of Object.entries(operation.responses)) {
        const headers = Object.fromEntries(Object.entries((response.headers as Record<string, Schema> | undefined) ?? {}).map(([name, header]) => [name, node(header.schema, `${where} ${status} ${name}`, {})]));
        const content = Object.fromEntries(Object.entries((response.content as Record<string, Schema> | undefined) ?? {}).map(([type, media]) => [type, node(media.schema, `${where} ${status}`, {})]));
        responses[status] = { headers, content };
      }
      paths[path]![method] = { parameters, responses };
    }
  }
  const schemas = (document.components as { schemas: Record<string, Schema> }).schemas;
  const components = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, node(schema, name, (schema.$defs as Schema | undefined) ?? {})]));
  return shorten({ paths, components });
}

/**
 * The document writes a component out in full wherever it is used. The record names it instead (ref), where the
 * schema is exactly the component's, so that each is read in one place. The comparison follows a ref either way.
 */
function shorten(structure: Structure): Structure {
  const flags = ({ nullable, optional, ...rest }: Node): [Node, Pick<Node, "nullable" | "optional">] => [rest, { ...(nullable ? { nullable } : {}), ...(optional ? { optional } : {}) }];
  const named = new Map<string, string>();
  for (const [name, schema] of Object.entries(structure.components)) {
    const [rest] = flags(schema);
    if (!rest.properties && !rest.anyOf && !rest.additional) continue;
    const key = JSON.stringify(canonical(rest));
    if (!named.has(key)) named.set(key, name);
  }
  const walk = (value: Node, root: string | null): Node => {
    if (root === null) {
      const [rest, kept] = flags(value);
      const name = named.get(JSON.stringify(canonical(rest)));
      if (name) return { ref: name, ...kept };
    }
    const out: Node = { ...value };
    if (value.properties) out.properties = Object.fromEntries(Object.entries(value.properties).map(([key, child]) => [key, walk(child, null)]));
    if (value.anyOf) out.anyOf = value.anyOf.map((child) => walk(child, null));
    if (value.items) out.items = walk(value.items, null);
    if (value.additional) out.additional = walk(value.additional, null);
    return out;
  };
  const paths: Structure["paths"] = {};
  for (const [path, methods] of Object.entries(structure.paths)) {
    paths[path] = Object.fromEntries(
      Object.entries(methods).map(([method, operation]) => [
        method,
        {
          parameters: operation.parameters,
          responses: Object.fromEntries(Object.entries(operation.responses).map(([status, response]) => [status, { headers: response.headers, content: Object.fromEntries(Object.entries(response.content).map(([type, schema]) => [type, walk(schema, null)])) }])),
        },
      ]),
    );
  }
  return { paths, components: Object.fromEntries(Object.entries(structure.components).map(([name, schema]) => [name, walk(schema, name)])) };
}

// ---- growth

const typeName = (value: Node): string =>
  value.ref ?? (value.anyOf ? value.anyOf.map(typeName).join(" or ") : value.const !== undefined ? JSON.stringify(value.const) : value.recursive !== undefined ? "the schema that contains it" : (value.type ?? "any"));

const variantOf = (value: Node): string => {
  const discriminator = Object.entries(value.properties ?? {}).find(([, property]) => property.const !== undefined || property.enum !== undefined);
  if (discriminator) return `${discriminator[0]} ${discriminator[1].const !== undefined ? JSON.stringify(discriminator[1].const) : (discriminator[1].enum ?? []).map((item) => JSON.stringify(item)).join(" or ")}`;
  return typeName(value);
};

/** The variant of the new union that continues `old`, if any. */
function matchVariant(old: Node, variants: Node[]): Node | undefined {
  if (old.ref) return variants.find((variant) => variant.ref === old.ref);
  if (old.type === "object") {
    const objects = variants.filter((variant) => variant.type === "object");
    const keys = Object.entries(old.properties ?? {}).filter(([, property]) => property.const !== undefined || property.enum !== undefined);
    if (keys.length === 0) return objects.length === 1 ? objects[0] : objects.find((variant) => same(Object.keys(variant.properties ?? {}).sort(), Object.keys(old.properties ?? {}).sort()));
    const values = (property: Node | undefined): unknown[] => (property ? (property.const !== undefined ? [property.const] : (property.enum ?? [])) : []);
    return objects.find((variant) => keys.every(([name, property]) => values(property).every((item) => values(variant.properties?.[name]).some((other) => same(other, item)))));
  }
  return variants.find((variant) => !variant.ref && variant.type === old.type);
}

interface Context {
  old: Record<string, Node>;
  now: Record<string, Node>;
  seen: Set<string>;
  breaks: string[];
}

const at = (where: string, key: string): string => (where ? `${where}.${key}` : key);
const BOUND_WORDS: Record<string, string> = {
  minimum: "the lowest value", exclusiveMinimum: "the value it stays above", minLength: "the shortest length", minItems: "the fewest items",
  maximum: "the highest value", exclusiveMaximum: "the value it stays below", maxLength: "the longest length", maxItems: "the most items",
};

/**
 * What a client that reads `old` would no longer understand in `now`, for a schema the API returns.
 * New properties, new enum values and new variants of a union are growth; everything else that differs is a break.
 */
function compareOutput(old: Node, now: Node, where: string, context: Context): void {
  const fail = (words: string): void => void context.breaks.push(`${where}: ${words}`);
  if (!old.nullable && now.nullable) fail("could not be null in 1.0.0 and now can be null");
  if (old.ref || now.ref) {
    if (old.ref && old.ref === now.ref) return; // the component is compared on its own
    const key = `${old.ref ?? where}>${now.ref ?? where}`;
    if (context.seen.has(key)) return;
    context.seen.add(key);
    const left = old.ref ? context.old[old.ref] : old;
    const right = now.ref ? context.now[now.ref] : now;
    if (!left || !right) return fail(`is ${typeName(now)} and was ${typeName(old)}, a changed type`);
    return compareOutput({ ...left, ...(old.nullable ? { nullable: true } : {}) }, { ...right, ...(now.nullable ? { nullable: true } : {}) }, where, context);
  }
  if (old.recursive !== undefined || now.recursive !== undefined) {
    if (old.recursive !== now.recursive) fail(`is ${typeName(now)} and was ${typeName(old)}, a changed type`);
    return;
  }
  if (old.type === "any" || old.type === "json") return;
  if (now.type === "any" || now.type === "json") return fail(`was ${typeName(old)} and is now any JSON value, a changed type`);
  if (old.anyOf) {
    const variants = now.anyOf ?? [now];
    for (const variant of old.anyOf) {
      const next = matchVariant(variant, variants);
      if (!next) fail(`the variant ${variantOf(variant)} is gone`);
      else compareOutput(variant, next, `${where}<${variantOf(variant)}>`, context);
    }
    return;
  }
  if (now.anyOf) return fail(`was ${typeName(old)} and is now ${typeName(now)}, a changed type`);
  if (old.type !== now.type && !(old.type === "number" && now.type === "integer")) return fail(`was ${old.type} and is now ${now.type}, a changed type`);
  // A fixed value (const) is an enumeration of one: values may be added, none taken away.
  const values = (value: Node): unknown[] | undefined => (value.const !== undefined ? [value.const] : value.enum);
  const before = values(old);
  const after = values(now);
  if (before) {
    if (!after) fail(`was ${before.length > 1 ? "one of " : ""}${before.map((item) => JSON.stringify(item)).join(", ")} and is now any ${now.type}`);
    else {
      const gone = before.filter((item) => !after.some((other) => same(other, item)));
      if (gone.length) fail(`the value${gone.length > 1 ? "s" : ""} ${gone.map((item) => JSON.stringify(item)).join(", ")} ${gone.length > 1 ? "are" : "is"} gone`);
    }
  }
  for (const key of ["format", "pattern"] as const) if (old[key] !== undefined && old[key] !== now[key]) fail(`its ${key} was ${old[key]} and is now ${now[key] ?? "none"}, a changed type`);
  for (const key of LOWER) if (old[key] !== undefined && !(now[key] !== undefined && now[key]! >= old[key]!)) fail(`${BOUND_WORDS[key]} was ${old[key]} and is now ${now[key] ?? "not stated"}`);
  for (const key of UPPER) if (old[key] !== undefined && !(now[key] !== undefined && now[key]! <= old[key]!)) fail(`${BOUND_WORDS[key]} was ${old[key]} and is now ${now[key] ?? "not stated"}`);
  for (const [name, property] of Object.entries(old.properties ?? {})) {
    const next = now.properties?.[name];
    if (!next) {
      fail(`the property ${name} is gone (removed or renamed)`);
      continue;
    }
    if (!property.optional && next.optional) context.breaks.push(`${at(where, name)}: was always present and now may be absent`);
    compareOutput(property, next, at(where, name), context);
  }
  if (old.additional) {
    if (!now.additional) fail("took keys of its own in 1.0.0 and now does not");
    else compareOutput(old.additional, now.additional, `${where}{*}`, context);
  }
  if (old.items) {
    if (!now.items) fail("its items are no longer described");
    else compareOutput(old.items, now.items, `${where}[]`, context);
  }
}

/** What a request that was valid against `old` would have refused or read otherwise in `now`, for a parameter. */
function compareInput(old: Node, now: Node, where: string, breaks: string[]): void {
  const fail = (words: string): void => void breaks.push(`${where}: ${words}`);
  if (old.type !== now.type) return fail(`was ${typeName(old)} and is now ${typeName(now)}, a changed type`);
  if ((old.list === undefined) !== (now.list === undefined)) fail(old.list ? "took a comma-separated list and now does not" : "now takes a comma-separated list");
  // Allowed values may be added, never taken away; a parameter that took any value keeps doing so.
  for (const key of ["enum", "list"] as const) {
    const before = old[key];
    const after = now[key];
    if (before === undefined || after === undefined) continue;
    if (!Array.isArray(before)) {
      if (Array.isArray(after)) fail(`took any value and now takes only ${after.map((item) => JSON.stringify(item)).join(", ")}`);
      continue;
    }
    if (!Array.isArray(after)) continue;
    const gone = before.filter((item) => !after.some((other) => same(other, item)));
    if (gone.length) fail(`the allowed value${gone.length > 1 ? "s" : ""} ${gone.map((item) => JSON.stringify(item)).join(", ")} ${gone.length > 1 ? "are" : "is"} gone`);
  }
  if (old.enum === undefined && now.enum !== undefined) fail(`took any ${old.type} and now takes only ${now.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  if (old.const !== undefined || now.const !== undefined) if (!same(old.const, now.const)) fail("its fixed value changed");
  for (const key of ["format", "pattern"] as const) if (now[key] !== undefined && now[key] !== old[key]) fail(`its ${key} was ${old[key] ?? "none"} and is now ${now[key]}, a changed type`);
  for (const key of LOWER) if (now[key] !== undefined && !(old[key] !== undefined && now[key]! <= old[key]!)) fail(`${BOUND_WORDS[key]} allowed was ${old[key] ?? "not stated"} and is now ${now[key]}`);
  for (const key of UPPER) if (now[key] !== undefined && !(old[key] !== undefined && now[key]! >= old[key]!)) fail(`${BOUND_WORDS[key]} allowed was ${old[key] ?? "not stated"} and is now ${now[key]}`);
  if (!same(old.default, now.default)) fail(`its default was ${JSON.stringify(old.default) ?? "none"} and is now ${JSON.stringify(now.default) ?? "none"}`);
}

/** Every way `now` takes away something `old` (the structure of 1.0.0) promised. Empty = it only grew. */
export function structureBreaks(old: Structure, now: Structure): string[] {
  const breaks: string[] = [];
  const context: Context = { old: old.components, now: now.components, seen: new Set(), breaks };
  for (const [path, methods] of Object.entries(old.paths)) {
    if (!now.paths[path]) {
      breaks.push(`${path}: the path is gone (removed or renamed)`);
      continue;
    }
    for (const [method, operation] of Object.entries(methods)) {
      const where = `${method.toUpperCase()} ${path}`;
      const next = now.paths[path]![method];
      if (!next) {
        breaks.push(`${where}: the method is gone`);
        continue;
      }
      for (const [key, parameter] of Object.entries(operation.parameters)) {
        const name = `${where}, ${parameter.in} parameter ${parameter.name}`;
        const after = next.parameters[key];
        if (!after) breaks.push(`${name}: the parameter is gone (removed or renamed)`);
        else {
          if (!parameter.required && after.required) breaks.push(`${name}: was optional and is now required`);
          compareInput(parameter.schema, after.schema, name, breaks);
        }
      }
      for (const [key, parameter] of Object.entries(next.parameters)) {
        if (!operation.parameters[key] && parameter.required) breaks.push(`${where}, ${parameter.in} parameter ${parameter.name}: a new parameter that is required (a new parameter must be optional)`);
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        const after = next.responses[status];
        if (!after) {
          breaks.push(`${where}, response ${status}: the response is gone`);
          continue;
        }
        for (const [name, header] of Object.entries(response.headers)) {
          if (!after.headers[name]) breaks.push(`${where}, response ${status}, header ${name}: the header is gone`);
          else compareOutput(header, after.headers[name]!, `${where}, response ${status}, header ${name}`, context);
        }
        for (const [type, schema] of Object.entries(response.content)) {
          if (!after.content[type]) breaks.push(`${where}, response ${status}: ${type} is gone`);
          else compareOutput(schema, after.content[type]!, `${where}, response ${status}`, context);
        }
      }
    }
  }
  for (const [name, schema] of Object.entries(old.components)) {
    if (!now.components[name]) breaks.push(`${name}: the component is gone (removed or renamed)`);
    else compareOutput(schema, now.components[name]!, name, context);
  }
  return breaks;
}

/** The text a failing test prints. */
export function breaksMessage(breaks: string[]): string {
  return [
    `The structure of /api/v1 can only grow, and this change takes away ${breaks.length === 1 ? "something" : `${breaks.length} things`} that version 1.0.0 promised:`,
    ...breaks.map((item) => `  - ${item}`),
    "A client written against 1.0.0 would break on it. A change of this kind belongs in /api/v2, with /api/v1 kept as it is.",
    "Make the change by adding (a new property, value, parameter or path) instead, or keep the old one beside the new one.",
    "The baseline structure/api-v1-1.0.0.json is never edited.",
  ].join("\n");
}

/** The record file as written: a line for people, then the structure. */
export function recordFile(structure: Structure, about: string): string {
  return `${JSON.stringify({ about, ...structure }, null, 2)}\n`;
}

export function readRecord(text: string): Structure {
  const { paths, components } = JSON.parse(text) as Structure;
  return { paths, components };
}

export const RECORD_ABOUT =
  "The structure of /api/v1 as the code generates it, written by `npm run structure:update`. tests/api-structure.test.ts checks that the API has exactly this structure and that it only grows from structure/api-v1-1.0.0.json.";
export const BASELINE_ABOUT = "The structure of /api/v1 at version 1.0.0, the first public release. Never edited: the record (structure/api-v1.json) may only grow from it.";
