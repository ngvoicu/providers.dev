import type { ApiDeps } from "./api.ts";
import { snapshotAsset } from "./assets.ts";
import type { Index } from "./entries.ts";
import type { Meta } from "./schema.ts";

export interface AssetBinding { fetch(request: Request | string): Promise<Response> }

/** The deps of one publication, with the index loaded only when a request reads it. */
export type SnapshotDeps = ApiDeps & { index: () => Promise<Index> };

interface Publication { id: string; meta: Promise<Meta>; index: () => Promise<Index> }

/**
 * Cache one parsed publication per binding; every request checks the current pointer. Only the publication in use is
 * kept: a new pointer replaces it, and nothing a request makes is kept beside it.
 *
 * Every read of ASSETS is a subrequest, and a Worker invocation may make 50. The meta is read at once; the index
 * (its head and one file per part, 27 files today) only by the first request that reads it, so that a request that
 * needs none of it (the listings, /meta, the evaluations) does not pay for it in a fresh isolate. tests/subrequests.test.ts
 * holds every route to 45.
 */
const loaded = new WeakMap<AssetBinding, Publication>();

export async function readSnapshot(assets: AssetBinding, origin: string): Promise<SnapshotDeps> {
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
    const meta = (async (): Promise<Meta> => {
      const metaFile = await asset("/data/meta.json");
      if (!metaFile) throw new Error("Incomplete snapshot.");
      return await metaFile.json() as Meta;
    })();
    let index: Promise<Index> | null = null;
    const loadIndex = (): Promise<Index> => {
      index ??= (async (): Promise<Index> => {
        const headFile = await asset("/data/index-parts/head.json");
        if (!headFile) throw new Error("Incomplete snapshot.");
        // The index in parts, parsed one after another: the whole text of the index is never held at once.
        const { parts, ...head } = await headFile.json() as Omit<Index, "entries"> & { parts: number };
        const result: Index = { ...head, entries: [] };
        for (let part = 0; part < parts; part += 1) {
          const file = await asset(`/data/index-parts/${part}.json`);
          if (!file) throw new Error("Incomplete snapshot.");
          for (const summary of await file.json() as Index["entries"]) result.entries.push(summary);
        }
        const { dataset_version, generated_at } = await meta;
        if (result.dataset_version !== dataset_version || result.generated_at !== generated_at) throw new Error("Mixed snapshot versions.");
        return result;
      })();
      // A failed load is tried again by the next request that reads the index.
      const attempt = index;
      void attempt.catch(() => { if (index === attempt) index = null; });
      return attempt;
    };
    const publication: Publication = { id, meta, index: loadIndex };
    cached = publication;
    loaded.set(assets, cached);
    void meta.catch(() => { if (loaded.get(assets) === publication) loaded.delete(assets); });
  }
  return { meta: await cached.meta, index: cached.index, asset };
}
