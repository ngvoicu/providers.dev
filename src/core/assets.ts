// Large catalog exports are stored compressed to stay within static-asset limits. Decode as a stream, without
// loading the catalog into Worker memory. Public URLs and JSON representations stay unchanged.
const COMPRESSED = new Set(["/api.json", "/data/catalog.json"]);

export async function snapshotAsset(path: string, fetchAsset: (path: string) => Promise<Response>): Promise<Response | null> {
  const compressed = COMPRESSED.has(path);
  const response = await fetchAsset(compressed ? `${path}.gz` : path);
  if (!response.ok) return null;
  if (!compressed) return response;
  if (!response.body) return null;
  return new Response(response.body.pipeThrough(new DecompressionStream("gzip")), { headers: { "Content-Type": "application/json; charset=utf-8" } });
}
