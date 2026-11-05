// Run: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
require('../extension/lib/core.js');
const core = globalThis.CECore;

const ROOT = '00000000-0000-4000-8000-000000000000';
const msg = (uuid, parent, sender, index, content, extra = {}) => ({
  uuid, parent_message_uuid: parent, sender, index, created_at: `2026-01-01T00:00:0${index}Z`, content, ...extra,
});
const conv = {
  uuid: 'c1', name: 'Test chat', model: null, created_at: '2025-10-10T10:00:00Z', updated_at: '2025-10-11T10:00:00Z',
  current_leaf_message_uuid: 'a2',
  chat_messages: [
    msg('h1', ROOT, 'human', 0, [{ type: 'text', text: 'Make a script' }], {
      attachments: [{ file_name: 'notes.txt', file_size: 2048, extracted_content: 'NOTES' }],
    }),
    msg('a1', 'h1', 'assistant', 1, [
      { type: 'thinking', thinking: 'Plan it', summaries: [{ summary: 'Planning' }] },
      { type: 'text', text: 'Here you go **bold**' },
      { type: 'tool_use', name: 'artifacts', input: { command: 'create', id: 'scr', title: 'My Script', type: 'application/vnd.ant.code', language: 'python', content: 'print(1)' } },
    ]),
    msg('h2', 'a1', 'human', 2, [{ type: 'text', text: 'change to 2' }]),
    msg('a2', 'h2', 'assistant', 3, [
      { type: 'tool_use', name: 'artifacts', input: { command: 'update', id: 'scr', old_str: 'print(1)', new_str: 'print(2)' } },
      { type: 'text', text: 'Updated' },
    ]),
    msg('h2b', 'a1', 'human', 4, [{ type: 'text', text: 'alternative question' }]),
    msg('a2b', 'h2b', 'assistant', 5, [{ type: 'text', text: 'alternative answer <antArtifact identifier="x" type="text/markdown" title="Doc">Hello</antArtifact>' }]),
  ],
};

test('current branch follows current_leaf_message_uuid', () => {
  assert.deepStrictEqual(core.getCurrentBranch(conv).map((m) => m.uuid), ['h1', 'a1', 'h2', 'a2']);
});

test('all branches: current first, then the alternative', () => {
  const b = core.getAllBranches(conv);
  assert.strictEqual(b.length, 2);
  assert.deepStrictEqual(b[1].map((m) => m.uuid), ['h1', 'a1', 'h2b', 'a2b']);
  assert.strictEqual(core.countBranches(conv), 2);
});

test('artifact update commands are applied', () => {
  const files = core.artifactFiles(conv, core.getCurrentBranch(conv));
  assert.deepStrictEqual(files, [{ path: 'My Script.py', content: 'print(2)' }]);
  const all = core.artifactFiles(conv, core.getCurrentBranch(conv), { versions: 'all' });
  assert.deepStrictEqual(all.map((f) => [f.path, f.content]), [['My Script.v1.py', 'print(1)'], ['My Script.v2.py', 'print(2)']]);
});

test('edits of files not created in the chat produce no artifact', () => {
  const m = [msg('a', ROOT, 'assistant', 0, [
    { type: 'tool_use', name: 'str_replace', input: { path: '/home/claude/unpacked/word/document.xml', old_str: 'a', new_str: 'b' } },
    { type: 'tool_use', name: 'create_file', input: { path: '/mnt/out/x.py', file_text: 'x = 1' } },
    { type: 'tool_use', name: 'str_replace', input: { path: '/mnt/out/x.py', old_str: 'missing', new_str: 'y' } },
  ])];
  assert.deepStrictEqual(core.artifactFiles({}, m, { versions: 'all' }), [{ path: 'x.py', content: 'x = 1' }]);
});

test('legacy antArtifact tags are parsed and stripped from text', () => {
  const md = core.toMarkdown(conv, { branchMode: 'all' });
  assert.match(md, /Ветка 2 из 2/);
  assert.match(md, /alternative answer/);
  assert.match(md, /Артефакт: Doc/);
  assert.doesNotMatch(md, /<antArtifact/);
});

test('markdown includes thinking, attachments, inferred model', () => {
  const md = core.toMarkdown(conv, {});
  assert.match(md, /Размышления: Planning/);
  assert.match(md, /notes\.txt/);
  assert.match(md, /NOTES/);
  assert.match(md, /Claude Sonnet 4\.5 \(предположительно\)/);
  assert.match(md, /print\(2\)/);
  assert.doesNotMatch(md, /alternative/);
});

test('text and json converters', () => {
  const t = core.toText(conv, { includeThinking: false });
  assert.match(t, /^Test chat/);
  assert.match(t, /User: Make a script/);
  assert.doesNotMatch(t, /Plan it/);
  const j = JSON.parse(core.toJSON(conv));
  assert.strictEqual(j._export.branches, 2);
  assert.strictEqual(j.chat_messages.length, 6);
});

test('html escapes user content and renders markdown', () => {
  const evil = { ...conv, name: '<script>x</script>', chat_messages: [msg('h', ROOT, 'human', 0, [{ type: 'text', text: '<img src=x onerror=alert(1)>' }]), msg('a', 'h', 'assistant', 1, [{ type: 'text', text: '# Title\n\n- a\n- b\n\n```js\nlet x = "<b>";\n```\n[l](javascript:alert(1))' }])], current_leaf_message_uuid: 'a' };
  const h = core.toHTML(evil, {});
  assert.doesNotMatch(h, /<script>x<\/script>/);
  assert.doesNotMatch(h, /<img src=x/);
  assert.doesNotMatch(h, /href="javascript/);
  assert.match(h, /<h1>Title<\/h1>/);
  assert.match(h, /<li>a<\/li>/);
  assert.match(h, /&lt;b&gt;/);
});

test('model names and filenames', () => {
  assert.strictEqual(core.formatModelName('claude-sonnet-4-5-20250929'), 'Claude Sonnet 4.5');
  assert.strictEqual(core.formatModelName('claude-3-5-sonnet-20241022'), 'Claude Sonnet 3.5');
  assert.strictEqual(core.formatModelName('claude-opus-5-5'), 'Claude Opus 5.5');
  assert.strictEqual(core.formatModelName('claude-fable-5-1'), 'Claude Fable 5.1');
  assert.strictEqual(core.modelFamily('claude-3-5-sonnet-20241022'), 'sonnet');
  assert.strictEqual(core.buildFilename('{date} {title}', { ...conv, name: 'a/b:c?' }), '2025-10-10 a_b_c_');
  assert.strictEqual(core.sanitizeFilename('CON'), '_CON');
});
