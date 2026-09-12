import test from 'node:test';
import assert from 'node:assert/strict';
import { publishedJson, publicationHealth } from '../dashboard/data-client.mjs';
test('new repository snapshots reach the UI without a deployment', async () => {
  const urls = [];
  const data = await publishedJson('data/opportunities.json', d => d.version === 'valid', async url => {
    urls.push(url); return Response.json({ version: 'valid', generatedAt: 100 });
  });
  assert.equal(data.generatedAt, 100);
  assert.match(urls[0], /raw.githubusercontent.com\/srmcno\/pm\/HEAD/);
  assert.equal(publicationHealth.get('data/opportunities.json').source, 'repository');
});
test('incompatible remote data uses labeled bundled fallback without changing original dates', async () => {
  let calls = 0;
  const data = await publishedJson('data/opportunities.json', d => d.version === 'valid', async () =>
    Response.json(++calls === 1 ? { version: 'wrong' } : { version: 'valid', generatedAt: 150 }));
  assert.equal(data.generatedAt, 150);
  assert.equal(publicationHealth.get('data/opportunities.json').source, 'bundled');
  assert.equal(publicationHealth.get('data/opportunities.json').updatedAt, 150);
});
test('total outage fails explicitly; arbitrary URLs cannot be requested', async () => {
  await assert.rejects(publishedJson('data/desk.json', undefined, async () => { throw new Error('offline'); }), /offline/);
  assert.equal(publicationHealth.get('data/desk.json').source, 'unavailable');
  await assert.rejects(publishedJson('https://example.com'), /Unknown snapshot/);
});

test('a temporary outage never rolls an account back to bundled history', async () => {
  await publishedJson('data/desk.json', undefined, async () => Response.json({ updatedAt: 200, cash: 2000 }));
  let attempts = 0;
  const retained = await publishedJson('data/desk.json', undefined, async () => {
    if (++attempts === 1) throw new Error('network failure');
    return Response.json({ updatedAt: 100, cash: 1000 });
  });
  assert.equal(retained.cash, 2000);
  assert.equal(publicationHealth.get('data/desk.json').source, 'retained');
});
