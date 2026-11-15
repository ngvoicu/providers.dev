// Cache capability schemas shared by authored declarations and the public contract.
import { z } from "zod";
import type { CacheDocumentation, CacheModeDocumentation, CacheRetention } from "./cache.ts";

export const SupportSchema = z.enum(["supported", "unsupported", "unknown"]);
export const RetentionProfileSchema = z.enum(["short", "long"]).describe("short = no lifetime requested, or the shortest documented lifetime. long = another requested lifetime. A profile does not confirm parameter support.");

export const CacheModeDocumentationSchema = z.strictObject({
  support: SupportSchema.describe("An absent mode is unknown. Only an explicit negative means unsupported."),
  min_tokens: z.number().nullable().describe("Minimum prompt size in tokens. Null = unknown."),
  max_breakpoints: z.number().nullable().describe("Maximum cache markers. Null = unknown or not applicable to this mode."),
  targets: z.array(z.string()).nullable().describe("Parts of the request that can be cached. Null = unknown or not applicable."),
}) satisfies z.ZodType<CacheModeDocumentation>;

export const CacheDocumentationSchema = z.strictObject({
  support: SupportSchema,
  modes: z.strictObject({ implicit: CacheModeDocumentationSchema, explicit: CacheModeDocumentationSchema }),
}).describe("Documented caching normalized for the API and every page. Unknown stays distinct from unsupported.") satisfies z.ZodType<CacheDocumentation>;

const evidence = z.strictObject({
  kind: z.enum(["documented", "measured"]),
  url: z.url(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  note: z.string(),
});

export const CacheRetentionSchema = z.strictObject({
  support: SupportSchema.describe("Whether a request parameter controls retention, confirmed by explicit evidence. A sent parameter or a cache hit alone leaves this unknown."),
  parameter: z.strictObject({ name: z.string().min(1), location: z.string().min(1) }).nullable().describe("The confirmed request field and its location. Null = unknown."),
  accepted_values: z.array(z.string().min(1)).nullable().describe("Values explicitly confirmed by the evidence. Requested values alone are not accepted values. Null = unknown."),
  default: z.string().nullable().describe("The lifetime when the parameter is omitted. Null = unknown."),
  profiles: z.array(z.strictObject({ profile: RetentionProfileSchema, value: z.string().nullable() })).describe("Confirmed short and long settings. A null value means omit the parameter. Empty = unknown."),
  conditions: z.array(z.string()).describe("Restrictions by client, protocol or header."),
  evidence: z.array(evidence).describe("Evidence for parameter support, values and conditions."),
}).describe("Confirmed retention controls. Observed cache behavior and requested settings are published separately in evaluations.") satisfies z.ZodType<CacheRetention>;

/** A person records the confirmation and source; evaluations cannot create this declaration. */
export const CacheRetentionDeclarationSchema = CacheRetentionSchema.extend({
  evidence: z.array(evidence.extend({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().min(1) })).min(1),
}).superRefine((value, ctx) => {
  if (value.support === "supported" && value.parameter === null) {
    ctx.addIssue({ code: "custom", path: ["parameter"], message: "Supported retention needs the confirmed request parameter." });
  }
  if (value.support !== "supported" && (value.parameter !== null || value.accepted_values !== null || value.default !== null || value.profiles.length > 0)) {
    ctx.addIssue({ code: "custom", path: ["support"], message: "Unknown or unsupported retention cannot declare parameter settings." });
  }
  for (const [index, profile] of value.profiles.entries()) {
    if (profile.value !== null && !value.accepted_values?.includes(profile.value)) {
      ctx.addIssue({ code: "custom", path: ["profiles", index, "value"], message: "A profile must use a confirmed accepted value." });
    }
  }
});
