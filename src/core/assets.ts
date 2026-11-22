// The large files of a snapshot are stored compressed to stay within static-asset limits: the two catalog exports,
// the index of summaries, and the same index in parts (data/index-parts/). Decoded as a stream: an export passes through without being loaded into Worker memory, and
// the index is parsed once per publication. Public URLs and JSON representations stay unchanged.
const COMPRESSED = new Set(["/api.json", "/data/catalog.json", "/data/index.json"]);

export async function snapshotAsset(path: string, fetchAsset: (path: string) => Promise<Response>): Promise<Response | null> {
  const compressed = COMPRESSED.has(path) || /^\/data\/index-parts\/(head|\d+)\.json$/.test(path);
  const response = await fetchAsset(compressed ? `${path}.gz` : path);
  if (!response.ok) return null;
  if (!compressed) return response;
  if (!response.body) return null;
  return new Response(response.body.pipeThrough(new DecompressionStream("gzip")), { headers: { "Content-Type": "application/json; charset=utf-8" } });
}
