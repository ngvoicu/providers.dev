// The page's words for what only pi's catalog returns (design/pi-merged.md, section 6): the request formats and pi's
// call flags (`compat`) in three groups. Plain data, read by the entry page and the methodology. It is not one of pi's
// two modules and imports nothing: a word here changes what a page says, never what is published.
//
// A word in backticks is a field or a value as a request writes it; a page shows it as code. Moving a flag between
// groups, or giving a new flag a place, is a change of this table and of the page's words, never of the data.

/** pi's request format (`api`) in plain words. A format not named here is shown in pi's word alone. */
export const PI_FORMAT_WORDS: Readonly<Record<string, string>> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "azure-openai-responses": "Azure OpenAI Responses",
  "openai-codex-responses": "OpenAI Responses, through the ChatGPT sign-in",
  "anthropic-messages": "Anthropic Messages",
  "bedrock-converse-stream": "Amazon Bedrock Converse, streaming",
  "google-generative-ai": "Google Gemini API",
  "google-vertex": "Google Vertex AI",
  "mistral-conversations": "Mistral Conversations",
};

/**
 * Group A: what the provider or the model accepts, as pi states it. A flag of `true` or `false` is said as
 * "Accepted" or "Not accepted", or "Required" or "Not required" for the one that names a requirement (`says`); any
 * other value is printed as stated.
 */
export interface PiFlagWords {
  label: string;
  says: "accepted" | "required" | "value";
}
export const PI_ACCEPTS_FLAGS: Readonly<Record<string, PiFlagWords>> = {
  supportsStrictMode: { label: "Strict tool schemas", says: "accepted" },
  supportsStrictTools: { label: "Strict tool schemas", says: "accepted" },
  supportsStore: { label: "The `store` request field", says: "accepted" },
  supportsReasoningEffort: { label: "The `reasoning_effort` request field", says: "accepted" },
  maxTokensField: { label: "The request field for the output limit", says: "value" },
  supportsTemperature: { label: "The `temperature` request field", says: "accepted" },
  supportsUsageInStreaming: { label: "Token usage in a streamed response", says: "accepted" },
  thinkingFormat: { label: "How thinking is asked for, by pi's name for the convention", says: "value" },
  requiresReasoningContentOnAssistantMessages: { label: "`reasoning_content` on earlier assistant messages in a request", says: "required" },
  supportsLongCacheRetention: { label: "A request for the long cache lifetime", says: "accepted" },
  supportsExplicitPromptCacheMode: { label: "The `prompt_cache_options` request field", says: "accepted" },
  supportsCacheControlOnTools: { label: "Cache markers on tool definitions", says: "accepted" },
  supportsMidConvoSystemMessages: { label: "System messages after the conversation has started", says: "accepted" },
  supportsMidConvoToolAdditions: { label: "Tools added or removed in the middle of a conversation", says: "accepted" },
  supportsMidConvoToolChanges: { label: "Tools added or removed in the middle of a conversation", says: "accepted" },
  supportsMidConvoEffort: { label: "A change of thinking level in the middle of a conversation", says: "accepted" },
  supportsOpenAIGrammarTools: { label: "Custom tools with a grammar", says: "accepted" },
  supportsAdditionalTools: { label: "`additional_tools` input items", says: "accepted" },
  supportsToolSearch: { label: "Tool search run by the client", says: "accepted" },
  supportsEagerToolInputStreaming: { label: "Eager streaming of tool input", says: "accepted" },
  zaiToolStream: { label: "The `tool_stream` request field", says: "accepted" },
};

/** Group B: what pi does. pi's own switches, printed as pi states them. */
export const PI_OWN_FLAGS: readonly string[] = ["sendSessionAffinityHeaders", "sessionAffinityFormat", "allowEmptySignature", "forceAdaptiveThinking", "chatTemplateArgs", "allowedFallbackModels"];

/** The three groups, in the page's order. Group C is every name the other two do not have, printed as stated. */
export const PI_FLAG_GROUPS = {
  accepts: { title: "What the provider accepts", said: "`compat`: what the provider or the model accepts in this request format, as pi states it. A flag not named follows pi's own default: it is not false" },
  own: { title: "What pi does", said: "pi's own switches, as pi states them: how pi builds its requests. Not a statement about the provider" },
  other: { title: "Other flags", said: "Flags this page has no words for yet, as pi states them" },
} as const;
export type PiFlagGroup = keyof typeof PI_FLAG_GROUPS;

/** The group of a flag, by its name alone. */
export function piFlagGroup(name: string): PiFlagGroup {
  if (Object.hasOwn(PI_ACCEPTS_FLAGS, name)) return "accepts";
  return PI_OWN_FLAGS.includes(name) ? "own" : "other";
}
