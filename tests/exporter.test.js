// Smoke test for bulk ZIP building with mocked chrome.* and fetch. Run: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');

globalThis.JSZip = require('../extension/lib/jszip.min.js');
const store = {};
globalThis.chrome = {
  storage: {
    sync: { get: (d, cb) => cb({ ...d }), set: (p, cb) => cb && cb() },
    local: { get: (d, cb) => cb({ ...d, ...store }), set: (p, cb) => { Object.assign(store, p); cb && cb(); } },
  },
};
const ROOT = '00000000-0000-4000-8000-000000000000';
const conv = (uuid, name, project) => ({
  uuid, name, model: 'claude-opus-5-5', project_uuid: project, created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-02T00:00:00Z',
  current_leaf_message_uuid: uuid + 'a',
  chat_messages: [
    { uuid: uuid + 'h', parent_message_uuid: ROOT, sender: 'human', index: 0, content: [{ type: 'text', text: 'hi' }] },
    { uuid: uuid + 'a', parent_message_uuid: uuid + 'h', sender: 'assistant', index: 1, content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', name: 'create_file', input: { path: '/mnt/out/app.ts', file_text: 'export {}' } },
    ] },
  ],
});
const db = { c1: conv('c1', 'Same name', 'p1'), c2: conv('c2', 'Same name', 'p1'), c3: conv('c3', 'Other', null) };
let calls = 0;
db.c4 = conv('c4', 'With files', null);
db.c4.chat_messages[0].files = [
  { file_kind: 'image', file_uuid: 'i1', file_name: 'shot.png', preview_asset: { url: '/api/o/files/i1/preview' } },
  { file_kind: 'image', file_uuid: 'i2', file_name: 'old.png', preview_asset: { url: '/api/o/files/i2/preview' } },
  { file_kind: 'document', file_uuid: 'd1', file_name: 'Lecture (1).pdf', document_asset: { url: '/api/o/files/d1/document_pdf' } },
  { file_kind: 'blob', file_name: 'big.zip', path: '/mnt/user-data/uploads/big.zip', size_bytes: 2048 },
  { file_kind: 'blob', file_name: 'huge.bin', path: '/mnt/user-data/uploads/huge.bin', size_bytes: 500 * 1048576 },
];
db.c4.chat_messages[1].content.push({ type: 'tool_use', name: 'present_files', input: { filepaths: ['/mnt/user-data/outputs/report/final.docx'] } });
// Node's JSZip can't read Blob (no FileReader), so a typed array stands in for it.
const fakeBlob = (type, tag = 1) => Object.assign(new Uint8Array([tag, 2, 3]), { type });
const seenUrls = [];
globalThis.fetch = async (url) => {
  seenUrls.push(url);
  const ok = (blob) => ({ ok: true, status: 200, blob: async () => blob });
  if (url.includes('/files/i2/contents')) return { ok: false, status: 404, headers: { get: () => null } };
  if (url.includes('/contents')) return ok(fakeBlob(url.includes('/i1/') ? 'image/jpeg' : '', 9));
  if (url.includes('/files/')) return ok(fakeBlob(url.endsWith('preview') ? 'image/webp' : 'application/pdf'));
  if (url.includes('/wiggle/list-files')) {
    return { ok: true, status: 200, json: async () => ({ files: ['/mnt/user-data/outputs/tmp/step1.py', '/mnt/user-data/uploads/big.zip'], files_metadata: [] }) };
  }
  if (url.includes('/wiggle/download-file')) return ok(fakeBlob('application/octet-stream', 7));
  calls++;
  const id = url.match(/chat_conversations\/(\w+)\?/)[1];
  if (id === 'c3' && calls < 4) return { ok: false, status: 429, headers: { get: () => '0' } }; // retried
  return { ok: true, status: 200, json: async () => db[id] };
};
require('../extension/lib/api.js');
require('../extension/lib/core.js');
require('../extension/lib/exporter.js');

test('chat files: originals, preview fallback, PDFs, sandbox uploads and outputs', async () => {
  const settings = { ...CECore.DEFAULT_SETTINGS, delayMs: 0, downloadImages: true, format: 'html', addIndex: false };
  const { zip, filesTotal, errors } = await CEExport.buildBulk('org', [{ uuid: 'c4', name: 'With files' }], settings);
  const dir = 'Chats/2026-03-01 With files/';
  const names = Object.keys(zip.files).filter((f) => !zip.files[f].dir && f.startsWith(dir + 'files/')).map((f) => f.slice(dir.length)).sort();
  assert.deepStrictEqual(names, ['files/Lecture (1).pdf', 'files/old.png', 'files/sandbox/outputs/report/final.docx', 'files/sandbox/uploads/big.zip', 'files/shot.png']);
  assert.strictEqual(filesTotal, 5);
  // original via /contents; preview fallback when /contents fails
  assert.strictEqual((await zip.file(dir + 'files/shot.png').async('uint8array'))[0], 9);
  assert.strictEqual((await zip.file(dir + 'files/old.png').async('uint8array'))[0], 1);
  assert.ok(seenUrls.some((u) => u.includes('/organizations/org/files/i1/contents')));
  assert.ok(seenUrls.some((u) => u.includes('wiggle/download-file?path=%2Fmnt%2Fuser-data%2Fuploads%2Fbig.zip')));
  assert.ok(!seenUrls.some((u) => u.includes('huge.bin')), 'over-limit file must not be fetched');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].error, /пропущен: 500\.0 МБ/);
  const html = await zip.file(dir + '2026-03-01 With files.html').async('string');
  assert.ok(html.includes('<img src="files/shot.png"'));
  assert.ok(html.includes('<a href="files/Lecture%20(1).pdf"'));
  assert.ok(html.includes('<a href="files/sandbox/uploads/big.zip"'));
  assert.match(html, /<a href="files\/sandbox\/outputs\/report\/final\.docx"[^>]*>final\.docx/);
  assert.match(html, /huge\.bin.*не скачан/);
});

test('whole sandbox mode adds unreferenced outputs', async () => {
  const settings = { ...CECore.DEFAULT_SETTINGS, delayMs: 0, downloadImages: true, sandboxScope: 'all', addIndex: false };
  const { zip } = await CEExport.buildBulk('org', [{ uuid: 'c4', name: 'With files' }], settings);
  assert.ok(zip.file('Chats/2026-03-01 With files/files/sandbox/outputs/tmp/step1.py'));
});

test('bulk export builds grouped, de-duplicated archive with index and artifacts', async () => {
  const settings = { ...CECore.DEFAULT_SETTINGS, delayMs: 0, concurrency: 2 };
  const summaries = Object.values(db).filter((c) => c.uuid !== 'c4').map(({ chat_messages, ...s }) => s);
  const { zip, ok, errors, artifactTotal } = await CEExport.buildBulk('org', summaries, settings, { projects: new Map([['p1', 'Proj']]) });
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(ok.length, 3);
  assert.strictEqual(artifactTotal, 3);
  const files = Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort();
  assert.deepStrictEqual(files, [
    'Chats/2026-03-01 Other/2026-03-01 Other.md',
    'Chats/2026-03-01 Other/artifacts/app.ts',
    'Projects/Proj/2026-03-01 Same name (2)/2026-03-01 Same name.md',
    'Projects/Proj/2026-03-01 Same name (2)/artifacts/app.ts',
    'Projects/Proj/2026-03-01 Same name/2026-03-01 Same name.md',
    'Projects/Proj/2026-03-01 Same name/artifacts/app.ts',
    'index.csv',
    'index.html',
  ]);
  const md = await zip.file('Chats/2026-03-01 Other/2026-03-01 Other.md').async('string');
  assert.match(md, /Claude Opus 5\.5/);
  assert.match(md, /export \{\}/);
});

test('flat layout', async () => {
  const settings = { ...CECore.DEFAULT_SETTINGS, delayMs: 0, zipLayout: 'flat', groupByProject: false, addIndex: false };
  const summaries = Object.values(db).filter((c) => c.uuid !== "c4").map(({ chat_messages, ...s }) => s);
  const { zip } = await CEExport.buildBulk('org', summaries, settings);
  const files = Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort();
  assert.deepStrictEqual(files, [
    'Artifacts/2026-03-01 Other/app.ts',
    'Artifacts/2026-03-01 Same name (2)/app.ts',
    'Artifacts/2026-03-01 Same name/app.ts',
    'Chats/2026-03-01 Other.md',
    'Chats/2026-03-01 Same name (2).md',
    'Chats/2026-03-01 Same name.md',
  ]);
});
