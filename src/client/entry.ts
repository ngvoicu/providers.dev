// One entry in full. The entry is named in the query string (?ref=provider/model) because model ids contain slashes.
// It reads the same index and the same entry files that /api/v1/entry answers from.
import type { Index } from "../core/entries.ts";
import { escapeHtml } from "../core/format.ts";
import type { JsonObject } from "../core/merge.ts";
import { entryHtml } from "../core/render.ts";

const root = document.getElementById("entry") as HTMLElement;
const now = new Date(root.dataset.now ?? Date.now());

function message(title: string, body: string): void {
  root.innerHTML = `<h1>${escapeHtml(title)}</h1><p class="lead mt-2">${body}</p><p class="mt-5"><a class="button" href="/">Back to the catalog</a></p>`;
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function load(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const ref = params.get("ref") ?? (params.get("provider") && params.get("model") ? `${params.get("provider")}/${params.get("model")}` : null);
  if (!ref) {
    message("No entry named", "Open an entry from the catalog, or add <code>?ref=provider/model</code> to this address.");
    return;
  }
  try {
    const index = await json<Index>("/data/index.json");
    const summary = index.entries.find((entry) => entry.ref === ref);
    if (!summary) {
      message("Entry not found", `There is no entry <code>${escapeHtml(ref)}</code> in dataset ${escapeHtml(index.dataset_version)}. It may have been removed upstream or renamed.`);
      return;
    }
    const provider = index.providers.find((item) => item.id === summary.provider);
    const shard = await json<Record<string, JsonObject>>(`/data/entries/${encodeURIComponent(summary.provider)}/${summary.shard}.json`);
    const model = shard[summary.model];
    if (!model || !provider) throw new Error("the entry file does not hold this entry");
    document.title = `${summary.name} at ${provider.name} · providers.dev`;
    root.innerHTML = entryHtml({ summary, provider, model, now });
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  } catch (error) {
    message(
      "The entry could not be loaded",
      `${escapeHtml(error instanceof Error ? error.message : String(error))}. <button type="button" class="button ml-2" id="retry">Try again</button>`,
    );
    document.getElementById("retry")?.addEventListener("click", () => void load());
  }
}

void load();
