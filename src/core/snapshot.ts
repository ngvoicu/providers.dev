import type { ApiDeps } from "./api.ts";
import { snapshotAsset } from "./assets.ts";
import type { Index } from "./entries.ts";
import type { Meta } from "./schema.ts";

export interface AssetBinding { fetch(request: Request | string): Promise<Response> }
interface Snapshot { index: Index; meta: Meta }

/**
 * Cache one parsed publication per binding; every request checks the current pointer. Only the publication in use is
 * kept: a new pointer replaces it, and nothing a request makes is kept beside it.
 */
const loaded = new WeakMap<AssetBinding, { id: string; value: Promise<Snapshot> }>();

export async function readSnapshot(assets: AssetBinding, origin: string): Promise<ApiDeps> {
  const fetchAsset = (path: string): Promise<Response> => assets.fetch(new Request(new URL(path, origin)));
  const manifest = await fetchAsset("/current.json");
  if (!manifest.ok) throw new Error("No published snapshot.");
  const { id } = await manifest.json() as { id: string };
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid snapshot pointer.");
  const asset = (path: string): Promise<Response | null> => path.startsWith("/data/") || path === "/api.json"
    ? snapshotAsset(path, (file) => fetchAsset(`/snapshots/${id}${file}`))
    : fetchAsset(path).then((response) => response.ok ? response : null);
  let cached = loaded.get(assets);
  if (!cached || cached.id !== id) {
    const value = (async (): Promise<Snapshot> => {
      const [headFile, metaFile] = await Promise.all([asset("/data/index-parts/head.json"), asset("/data/meta.json")]);
      if (!headFile || !metaFile) throw new Error("Incomplete snapshot.");
      const meta = await metaFile.json() as Meta;
      // The index in parts, parsed one after another: the whole text of the index is never held at once.
      const { parts, ...head } = await headFile.json() as Omit<Index, "entries"> & { parts: number };
      const index: Index = { ...head, entries: [] };
      for (let part = 0; part < parts; part += 1) {
        const file = await asset(`/data/index-parts/${part}.json`);
        if (!file) throw new Error("Incomplete snapshot.");
        for (const summary of await file.json() as Index["entries"]) index.entries.push(summary);
      }
      if (index.dataset_version !== meta.dataset_version || index.generated_at !== meta.generated_at) throw new Error("Mixed snapshot versions.");
      return { index, meta };
    })();
    cached = { id, value };
    loaded.set(assets, cached);
    void value.catch(() => { if (loaded.get(assets)?.value === value) loaded.delete(assets); });
  }
  return { ...await cached.value, asset };
}
