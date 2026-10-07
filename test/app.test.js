const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../index');

async function runApp(t, client) {
  const server = createApp({ objectType: '2-123', client }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const plant = (name, species = 'Monstera deliciosa', care_notes = 'Bright indirect light') => ({ properties: { name, species, care_notes } });

test('homepage reads subsequent pages, requests all properties, and escapes CRM text', async t => {
  const calls = [];
  const base = await runApp(t, {
    get: async (url, options) => {
      calls.push({ url, ...options.params });
      return calls.length === 1
        ? { data: { results: [plant('Atlas')], paging: { next: { after: '42' } } } }
        : { data: { results: [plant('<script>alert(1)</script>')] } };
    }
  });
  const response = await fetch(base);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/crm/v3/objects/2-123');
  assert.equal(calls[0].properties, 'name,species,care_notes');
  assert.equal(calls[1].after, '42');
  assert.match(html, /2 plants in HubSpot/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /href="\/update-cobj"/);
});

test('valid form creates one record, redirects, and the record appears on the homepage', async t => {
  const records = [plant('Atlas')];
  let writes = 0;
  const base = await runApp(t, {
    get: async () => ({ data: { results: records } }),
    post: async (url, body) => { assert.equal(url, '/crm/v3/objects/2-123'); writes++; records.push(body); }
  });
  const response = await fetch(`${base}/update-cobj`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
    body: new URLSearchParams({ name: ' Fern ', species: ' Nephrolepis exaltata ', care_notes: ' Keep soil moist ' })
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
  assert.equal(writes, 1);
  assert.deepEqual(records[1].properties, { name: 'Fern', species: 'Nephrolepis exaltata', care_notes: 'Keep soil moist' });
  assert.match(await (await fetch(base)).text(), /Nephrolepis exaltata/);
});

test('invalid, oversized, and repeated fields do not write to HubSpot', async t => {
  let writes = 0;
  const base = await runApp(t, { post: async () => { writes++; } });
  for (const body of [
    'name=Atlas&species=&care_notes=Water',
    new URLSearchParams({ name: 'x'.repeat(101), species: 'Fern', care_notes: 'Water' }),
    'name=Atlas&name=Fern&species=Fern&care_notes=Water'
  ]) {
    const response = await fetch(`${base}/update-cobj`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Please check the form/);
  }
  assert.equal(writes, 0);
});

test('form exposes the prescribed title and three named controls', async t => {
  const base = await runApp(t, {});
  const html = await (await fetch(`${base}/update-cobj`)).text();
  assert.match(html, /Update Custom Object Form \| Integrating With HubSpot I Practicum/);
  for (const name of ['name', 'species', 'care_notes']) assert.match(html, new RegExp(`name="${name}"`));
  assert.match(html, /Return to the homepage/);
});

test('API failures return readable errors without exposing credentials or dropping form values', async t => {
  const fail = async () => { throw { response: { status: 401 }, config: { headers: { Authorization: 'secret-test-token' } } }; };
  const base = await runApp(t, { get: fail, post: fail });
  const list = await fetch(base);
  assert.equal(list.status, 502);
  assert.doesNotMatch(await list.text(), /secret-test-token/);
  const create = await fetch(`${base}/update-cobj`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'Atlas', species: 'Monstera', care_notes: 'Indirect light' })
  });
  const html = await create.text();
  assert.equal(create.status, 502);
  assert.match(html, /value="Atlas"/);
  assert.doesNotMatch(html, /secret-test-token/);
});

test('submissions from another website are rejected before API access', async t => {
  let writes = 0;
  const base = await runApp(t, { post: async () => { writes++; } });
  const response = await fetch(`${base}/update-cobj`, { method: 'POST', headers: { Origin: 'https://unrelated.example' } });
  assert.equal(response.status, 403);
  assert.equal(writes, 0);
});
