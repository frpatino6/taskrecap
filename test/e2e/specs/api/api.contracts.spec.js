// A few HTTP contracts the page relies on, checked without a browser page (Playwright `request`).
import { test, expect } from '../../fixtures/app.js';

test.describe('api: contracts', () => {
  test('should answer /api/search with hits, searched coverage, message hits and the index state @smoke', async ({ request }) => {
    const res = await request.get('/api/search?q=tombstone');
    expect(res.status()).toBe(200);
    expect(Object.keys(await res.json()).sort()).toEqual(['hits', 'index', 'messages', 'searched']);
    // the message index is built in the background after the start: wait until it is ready
    const ready = async () => (await (await request.get('/api/search?q=tombstone')).json()).index.state;
    await expect.poll(ready).toBe('ready');
    const body = await (await request.get('/api/search?q=tombstone')).json();
    expect(body.hits).toEqual([]);
    expect(body.index).toEqual({ state: 'ready', done: expect.any(Number), total: expect.any(Number) });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({
      session: expect.stringMatching(/^a7b8c9d0-/), turn: expect.any(Number), role: expect.stringMatching(/^(user|assistant)$/), more: 0,
      snippet: { excerpt: expect.stringContaining('tombstone'), highlights: expect.any(Array) },
    });
    expect(body.searched).toMatchObject({ capsules: expect.any(Number), other_tasks: expect.any(Number) });
  });

  test('should answer /api/search for a task word with ranked task hits @regression', async ({ request }) => {
    const body = await (await request.get('/api/search?q=' + encodeURIComponent('integer cents'))).json();
    expect(body.hits.map((h) => h.key)).toContain('SHOP-101');
    expect(body.hits[0]).toMatchObject({ key: expect.any(String), where: expect.any(String) });
  });

  test('should answer an empty query with no hits and no messages @regression', async ({ request }) => {
    const body = await (await request.get('/api/search?q=')).json();
    expect(body.hits ?? []).toEqual([]);
    expect(body.messages ?? []).toEqual([]);
  });

  test('should refuse to reveal a path the session did not record, with 400 @smoke', async ({ request }) => {
    const res = await request.post('/api/reveal', { data: { session: 'a1b2c3d4', path: '/etc/passwd' } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('That file is not one Claude wrote in this session.');
  });

  test('should answer a recorded path in demo mode without opening anything @regression', async ({ request }) => {
    const res = await request.post('/api/reveal', { data: { session: 'a1b2c3d4', path: '/home/demo/acme-shop/docs/SHOP-101-notes.md' } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true, opened: '/home/demo/acme-shop/docs/SHOP-101-notes.md' });
  });

  test('should answer a reveal for an unknown session with 404 @regression', async ({ request }) => {
    const res = await request.post('/api/reveal', { data: { session: 'ffffffff', path: '/tmp/x' } });
    expect(res.status()).toBe(404);
  });

  test('should refuse a foreign Origin with 403 on reads and on writes @smoke', async ({ request }) => {
    const read = await request.get('/api/tasks', { headers: { Origin: 'https://evil.example' } });
    expect(read.status()).toBe(403);
    const write = await request.post('/api/reveal', { headers: { Origin: 'https://evil.example' }, data: { session: 'a1b2c3d4', path: '/x' } });
    expect(write.status()).toBe(403);
    expect((await write.json()).error).toBe('Forbidden origin');
  });

  test('should refuse a foreign Host header with 403 @regression', async ({ request }) => {
    const res = await request.get('/api/tasks', { headers: { Host: 'evil.example' } });
    expect(res.status()).toBe(403);
  });

  test('should accept the local Origin @regression', async ({ request, baseURL }) => {
    const res = await request.get('/api/tasks', { headers: { Origin: new URL(baseURL).origin } });
    expect(res.status()).toBe(200);
  });

  test('should refuse a non-JSON body with 415 on every mutating endpoint family @smoke', async ({ request }) => {
    for (const route of ['/api/reveal', '/api/units/rename', '/api/organize/accept', '/api/capsule/reuse', '/api/ai/recheck', '/api/organize']) {
      const res = await request.post(route, { headers: { 'Content-Type': 'text/plain' }, data: 'hello' });
      expect(res.status(), route).toBe(415);
      expect((await res.json()).error).toBe('JSON required');
    }
  });

  test('should require the explicit confirmation before any AI action @regression', async ({ request }) => {
    const res = await request.post('/api/organize', { data: {} });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/Confirmation required/);
  });

  test('should answer 404 JSON for an unknown task and unknown route @regression', async ({ request }) => {
    const task = await request.get('/api/tasks/NOPE-1');
    expect(task.status()).toBe(404);
    expect((await task.json()).error).toBe('Unknown task');
    expect((await request.get('/api/nope')).status()).toBe(404);
  });
});
