// Public research snapshots update independently of the deployed interface.
export const DATA_ROOT = 'https://raw.githubusercontent.com/srmcno/pm/HEAD/dashboard/';
export const publicationHealth = new Map();
const accepted = new Map();

export function snapshotTimestamp(data) {
  const value = data?.generatedAt ?? data?.updatedAt ?? data?.meta?.generatedAt;
  return Number.isFinite(value) ? value : 0;
}

export async function publishedJson(file, validate = data => data && typeof data === 'object', fetcher = fetch) {
  if (!/^data\/[a-z0-9-]+\.json$/.test(file)) throw new Error('Unknown snapshot path');
  let failure;
  for (const source of ['repository', 'bundled']) {
    try {
      const url = (source === 'repository' ? DATA_ROOT : './') + file + '?t=' + Date.now();
      const response = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(9000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!validate(data)) throw new Error('Incompatible snapshot');
      const previous = accepted.get(file);
      if (previous && validate(previous) && snapshotTimestamp(previous) > snapshotTimestamp(data)) {
        publicationHealth.set(file, { source: 'retained', checkedAt: Date.now() / 1000, updatedAt: snapshotTimestamp(previous), error: 'The latest request returned older data. Keeping the newer loaded record.' });
        return previous;
      }
      accepted.set(file, data);
      publicationHealth.set(file, { source, checkedAt: Date.now() / 1000, updatedAt: snapshotTimestamp(data), error: failure?.message || '' });
      return data;
    } catch (error) { failure = error; }
  }
  const previous = accepted.get(file);
  if (previous && validate(previous)) {
    publicationHealth.set(file, { source: 'retained', checkedAt: Date.now() / 1000, updatedAt: snapshotTimestamp(previous), error: failure?.message || 'Sources unavailable' });
    return previous;
  }
  publicationHealth.set(file, { source: 'unavailable', checkedAt: Date.now() / 1000, error: failure?.message || 'Source unavailable' });
  throw failure;
}

// Retained research pages use the same transport, without a global fetch override.
export async function publishedResponse(path) {
  const data = await publishedJson(path.split('?')[0]);
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}
