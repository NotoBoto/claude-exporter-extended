// Core, DOM-free logic: conversation tree, artifacts, converters (JSON/MD/TXT/HTML),
// filenames, model names. Shared by popup, browse page, options and content script.
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- defaults
  const DEFAULT_SETTINGS = {
    orgId: '',
    format: 'markdown',            // json | markdown | text | html
    includeMetadata: true,
    includeThinking: true,
    includeTools: false,           // tool calls (web search, code, etc.) and their results
    includeArtifactsInline: true,
    includeAttachments: true,
    branchMode: 'current',         // current | all
    extractArtifacts: true,        // separate artifact files in ZIP
    artifactVersions: 'latest',    // latest | all
    downloadImages: false,         // download chat files: uploaded images/PDFs (originals) + sandbox files
    sandboxScope: 'referenced',    // referenced (files mentioned in messages) | all (whole sandbox incl. intermediate outputs)
    maxFileMB: 100,                // skip single files larger than this (0 = no limit)
    zipLayout: 'nested',           // nested (folder per chat) | flat (Chats/ + Artifacts/)
    groupByProject: true,
    filenameTemplate: '{date} {title}',
    concurrency: 3,
    delayMs: 250,
    showFloatingButton: true,
    addIndex: true,                // index.html + index.csv in bulk ZIP
    theme: 'auto',
  };

  // ---------------------------------------------------------------- helpers
  const pad = (n) => String(n).padStart(2, '0');
  function ymd(d) {
    d = new Date(d);
    return isNaN(d) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function stamp(d = new Date()) {
    return `${ymd(d)}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  function fmtDateTime(d) {
    d = new Date(d);
    return isNaN(d) ? '' : `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function sanitizeFilename(name, max = 120) {
    let s = String(name || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '');
    if (s.length > max) s = s.slice(0, max).trim();
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
    return s || 'untitled';
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // Ensures unique names inside one folder: "a.md", "a (2).md", ...
  function makeUniquer() {
    const used = new Set();
    return (name) => {
      let base = name, ext = '';
      const m = name.match(/^(.*?)(\.[^.]{1,10})$/);
      if (m) { base = m[1]; ext = m[2]; }
      let out = name, i = 2;
      while (used.has(out.toLowerCase())) out = `${base} (${i++})${ext}`;
      used.add(out.toLowerCase());
      return out;
    };
  }

  // ---------------------------------------------------------------- models
  const DEFAULT_MODEL_TIMELINE = [
    ['2024-01-01', 'claude-3-sonnet-20240229'],
    ['2024-06-20', 'claude-3-5-sonnet-20240620'],
    ['2024-10-22', 'claude-3-5-sonnet-20241022'],
    ['2025-02-24', 'claude-3-7-sonnet-20250219'],
    ['2025-05-22', 'claude-sonnet-4-20250514'],
    ['2025-09-29', 'claude-sonnet-4-5-20250929'],
    ['2026-02-17', 'claude-sonnet-4-6'],
  ];
  function inferModel(conv) {
    if (conv.model) return conv.model;
    const d = new Date(conv.created_at);
    for (let i = DEFAULT_MODEL_TIMELINE.length - 1; i >= 0; i--) {
      if (d >= new Date(DEFAULT_MODEL_TIMELINE[i][0])) return DEFAULT_MODEL_TIMELINE[i][1];
    }
    return DEFAULT_MODEL_TIMELINE[0][1];
  }
  // claude-sonnet-4-5-20250929 -> "Claude Sonnet 4.5"; works for any family name.
  function formatModelName(model) {
    if (!model) return 'Unknown';
    let m = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}|preview|latest))?$/i);
    if (m && !/^\d/.test(m[1])) {
      const fam = m[1][0].toUpperCase() + m[1].slice(1);
      return `Claude ${fam} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}${m[4] === 'preview' ? ' (preview)' : ''}`;
    }
    m = model.match(/^claude-(\d+)(?:-(\d+))?-([a-z]+)-\d{8}$/i);
    if (m) return `Claude ${m[3][0].toUpperCase() + m[3].slice(1)} ${m[2] ? `${m[1]}.${m[2]}` : m[1]}`;
    return model;
  }
  function modelFamily(model) {
    const m = String(model || '').match(/claude-(?:\d+(?:-\d+)?-)?([a-z]+)/i);
    return m ? m[1].toLowerCase() : 'other';
  }

  // ---------------------------------------------------------------- tree
  function buildTree(conv) {
    const msgs = conv.chat_messages || [];
    const byId = new Map(msgs.map((m) => [m.uuid, m]));
    const children = new Map();
    const roots = [];
    for (const m of msgs) {
      const p = m.parent_message_uuid;
      if (p && byId.has(p)) {
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(m);
      } else roots.push(m);
    }
    const order = (a, b) => (a.index ?? 0) - (b.index ?? 0) || String(a.created_at).localeCompare(String(b.created_at));
    roots.sort(order);
    children.forEach((arr) => arr.sort(order));
    return { byId, children, roots };
  }

  function pathTo(conv, leafUuid, tree = buildTree(conv)) {
    const out = [];
    let id = leafUuid;
    const guard = new Set();
    while (id && tree.byId.has(id) && !guard.has(id)) {
      guard.add(id);
      const m = tree.byId.get(id);
      out.unshift(m);
      id = m.parent_message_uuid;
    }
    return out;
  }

  // Messages of the branch currently selected in the UI.
  function getCurrentBranch(conv) {
    const tree = buildTree(conv);
    if (conv.current_leaf_message_uuid && tree.byId.has(conv.current_leaf_message_uuid)) {
      return pathTo(conv, conv.current_leaf_message_uuid, tree);
    }
    // Fallback: follow the last child at every level.
    const out = [];
    let cur = tree.roots[tree.roots.length - 1];
    while (cur) {
      out.push(cur);
      const ch = tree.children.get(cur.uuid);
      cur = ch && ch[ch.length - 1];
    }
    return out;
  }

  // All root->leaf paths, current branch first.
  function getAllBranches(conv) {
    const tree = buildTree(conv);
    const leaves = [];
    for (const m of tree.byId.values()) if (!tree.children.has(m.uuid)) leaves.push(m);
    leaves.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const cur = conv.current_leaf_message_uuid;
    leaves.sort((a, b) => (b.uuid === cur) - (a.uuid === cur));
    return leaves.map((l) => pathTo(conv, l.uuid, tree));
  }

  function countBranches(conv) {
    const tree = buildTree(conv);
    let n = 0;
    for (const m of tree.byId.values()) if (!tree.children.has(m.uuid)) n++;
    return n;
  }

  // ---------------------------------------------------------------- artifacts
  const ARTIFACT_TYPE_LANG = {
    'text/html': 'html',
    'text/markdown': 'markdown',
    'text/css': 'css',
    'image/svg+xml': 'svg',
    'application/vnd.ant.mermaid': 'mermaid',
    'application/vnd.ant.react': 'jsx',
  };
  const LANG_EXT = {
    javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx', python: 'py', py: 'py',
    html: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less', json: 'json', xml: 'xml',
    yaml: 'yaml', yml: 'yml', toml: 'toml', ini: 'ini', markdown: 'md', md: 'md', text: 'txt', txt: 'txt',
    plaintext: 'txt', java: 'java', kotlin: 'kt', swift: 'swift', go: 'go', rust: 'rs', c: 'c', cpp: 'cpp',
    'c++': 'cpp', csharp: 'cs', 'c#': 'cs', fsharp: 'fs', 'f#': 'fs', php: 'php', ruby: 'rb', perl: 'pl',
    lua: 'lua', r: 'r', dart: 'dart', scala: 'scala', haskell: 'hs', elixir: 'ex', erlang: 'erl',
    clojure: 'clj', ocaml: 'ml', shell: 'sh', bash: 'sh', sh: 'sh', zsh: 'sh', powershell: 'ps1', ps1: 'ps1',
    bat: 'bat', batch: 'bat', sql: 'sql', graphql: 'graphql', svg: 'svg', mermaid: 'mmd', latex: 'tex',
    tex: 'tex', bibtex: 'bib', csv: 'csv', dockerfile: 'dockerfile', makefile: 'mk', groovy: 'groovy',
    gradle: 'gradle', vue: 'vue', svelte: 'svelte', solidity: 'sol', asm: 'asm', assembly: 'asm',
  };
  const extFor = (lang) => LANG_EXT[String(lang || '').toLowerCase()] || 'txt';
  const langFromFilename = (fn) => {
    const m = String(fn || '').match(/\.([a-z0-9]+)$/i);
    if (!m) return 'txt';
    const ext = m[1].toLowerCase();
    return Object.keys(LANG_EXT).find((k) => LANG_EXT[k] === ext) || ext;
  };

  function parseDisplayContent(dc) {
    if (!dc) return null;
    if (dc.type === 'code_block' && dc.code != null) return { code: dc.code, language: dc.language, filename: dc.filename };
    if (dc.type === 'json_block' && dc.json_block) {
      try {
        const j = JSON.parse(dc.json_block);
        if (j.filename || j.code != null) return { code: j.code || '', language: j.language, filename: j.filename };
      } catch { /* ignore */ }
    }
    return null;
  }

  function parseAntArtifacts(text) {
    const out = [];
    const re = /<antArtifact([^>]*)>([\s\S]*?)<\/antArtifact>/g;
    let m;
    while ((m = re.exec(text))) {
      const attr = (n) => (m[1].match(new RegExp(`${n}="([^"]*)"`)) || [])[1];
      const type = attr('type');
      out.push({
        id: attr('identifier') || attr('title') || `artifact-${out.length + 1}`,
        title: attr('title') || 'Untitled',
        language: (type === 'application/vnd.ant.code' ? attr('language') : ARTIFACT_TYPE_LANG[type]) || attr('language') || 'txt',
        content: m[2].replace(/^\n+|\n+$/g, ''),
        command: 'create',
      });
    }
    return out;
  }

  // Walks messages in order and tracks every artifact version, applying
  // update (old_str -> new_str) commands so the final content is correct.
  function collectArtifacts(messages) {
    const state = new Map(); // id -> {id,title,language,versions:[{content,messageUuid,command}]}
    const perMessage = new Map();
    const push = (msg, a) => {
      let entry = state.get(a.id);
      // An edit of a file that was never created in this chat (e.g. an uploaded
      // document unpacked in the sandbox): we don't know its content, so skip it.
      if (a.command === 'update' && a.content == null && !(entry && entry.versions.length)) return;
      if (!entry) {
        entry = { id: a.id, title: a.title || 'artifact', language: a.language || 'txt', filename: a.filename, versions: [] };
        state.set(a.id, entry);
      }
      if (a.title) entry.title = a.title;
      if (a.language) entry.language = a.language;
      if (a.filename) entry.filename = a.filename;
      let content = a.content;
      if (a.command === 'update' && content == null) {
        const prev = entry.versions[entry.versions.length - 1].content;
        if (a.old_str == null || !prev.includes(a.old_str)) return; // nothing applied, no new version
        content = prev.replace(a.old_str, () => a.new_str ?? '');
      }
      if (content == null) return;
      const v = { content, messageUuid: msg.uuid, command: a.command || 'create', at: msg.created_at };
      entry.versions.push(v);
      if (!perMessage.has(msg.uuid)) perMessage.set(msg.uuid, []);
      perMessage.get(msg.uuid).push({ ...entry, content, version: entry.versions.length, command: v.command });
    };

    for (const msg of messages) {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const c of blocks) {
        if (c.type === 'tool_use' && c.name === 'artifacts') {
          const inp = c.input || {};
          const dc = parseDisplayContent(c.display_content);
          // Updates usually carry no type/language: keep what the artifact already has.
          const lang = inp.language || ARTIFACT_TYPE_LANG[inp.type] || (dc && dc.language) ||
            (inp.command === 'update' ? undefined : inp.type === 'application/vnd.ant.code' ? 'txt' : 'markdown');
          const id = inp.id || inp.identifier || (dc && dc.filename) || inp.title || `artifact-${state.size + 1}`;
          const cmd = inp.command || 'create';
          push(msg, {
            id, title: inp.title || (dc && dc.filename && dc.filename.split('/').pop().replace(/\.[^.]+$/, '')),
            language: lang, command: cmd === 'rewrite' ? 'rewrite' : cmd,
            content: cmd === 'update' ? (inp.content ?? undefined) : (inp.content ?? (dc ? dc.code : undefined)),
            old_str: inp.old_str, new_str: inp.new_str,
          });
        } else if (c.type === 'tool_use' && (c.name === 'create_file' || c.name === 'str_replace' || c.name === 'str_replace_based_edit_tool')) {
          const inp = c.input || {};
          const dc = parseDisplayContent(c.display_content);
          const path = inp.path || inp.file_path || (dc && dc.filename);
          if (!path) continue;
          const filename = String(path).split('/').pop();
          const isReplace = c.name !== 'create_file' && (inp.command === 'str_replace' || inp.old_str != null);
          push(msg, {
            id: path, title: filename.replace(/\.[^.]+$/, ''), filename,
            language: (dc && dc.language) || langFromFilename(filename),
            command: isReplace ? 'update' : 'create',
            content: isReplace ? undefined : (inp.file_text ?? inp.content ?? (dc ? dc.code : undefined)),
            old_str: inp.old_str, new_str: inp.new_str,
          });
        } else if (c.type === 'text' && c.text && c.text.includes('<antArtifact')) {
          parseAntArtifacts(c.text).forEach((a) => push(msg, a));
        }
      }
      if (!blocks.length && msg.text && msg.text.includes('<antArtifact')) {
        parseAntArtifacts(msg.text).forEach((a) => push(msg, a));
      }
    }
    return { perMessage, all: [...state.values()] };
  }

  // Files for a ZIP: [{path, content}] (path relative to an artifacts folder)
  function artifactFiles(conv, messages, { versions = 'latest' } = {}) {
    const { all } = collectArtifacts(messages);
    const unique = makeUniquer();
    const files = [];
    for (const a of all) {
      const ext = extFor(a.language);
      const base = sanitizeFilename(a.filename ? a.filename.replace(/\.[^.]+$/, '') : a.title || 'artifact', 80);
      const fext = a.filename && /\.[^.]+$/.test(a.filename) ? a.filename.match(/\.([^.]+)$/)[1] : ext;
      if (versions === 'all' && a.versions.length > 1) {
        a.versions.forEach((v, i) => files.push({ path: unique(`${base}.v${i + 1}.${fext}`), content: v.content }));
      } else {
        files.push({ path: unique(`${base}.${fext}`), content: a.versions[a.versions.length - 1].content });
      }
    }
    return files;
  }

  // ---------------------------------------------------------------- message parts
  const stripAnt = (t) => String(t || '').replace(/<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/g, '').trim();

  function toolResultText(c) {
    if (typeof c.content === 'string') return c.content;
    if (Array.isArray(c.content)) {
      return c.content.map((x) => x.text || (x.title && x.url ? `${x.title} — ${x.url}` : x.url) || '').filter(Boolean).join('\n');
    }
    return '';
  }

  // Files attached to a message. Every entry has a stable `key` used to look up the
  // downloaded copy: "file:<uuid>" for uploaded images/PDFs (original via /contents,
  // `path` = fallback preview/pdf URL), "sandbox:<path>" for sandbox files.
  function messageFiles(msg) {
    const list = [...(msg.files_v2 || msg.files || [])];
    return list.map((f) => {
      const fileKind = f.file_kind || (f.preview_url || f.thumbnail_url ? 'image' : 'blob');
      const uuid = f.file_uuid || f.uuid;
      const name = f.file_name || f.name || 'file';
      if (fileKind === 'blob' || (!uuid && f.path)) {
        return { name, fileKind: 'blob', sandboxPath: f.path || null, key: f.path ? `sandbox:${f.path}` : null, size: f.size_bytes, uuid };
      }
      const path = fileKind === 'image'
        ? (f.preview_asset && f.preview_asset.url) || f.preview_url || (f.thumbnail_asset && f.thumbnail_asset.url) || f.thumbnail_url || null
        : (f.document_asset && f.document_asset.url) || null;
      return { name, fileKind, path, key: uuid ? `file:${uuid}` : path, size: f.size_bytes, uuid };
    });
  }

  // Files Claude handed to the user with the present_files tool (sandbox outputs).
  function presentedFiles(block) {
    const paths = (block && block.input && (block.input.filepaths || block.input.paths)) || [];
    return paths.filter((p) => typeof p === 'string').map((p) => ({
      name: p.split('/').pop(), fileKind: 'output', sandboxPath: p, key: `sandbox:${p}`,
    }));
  }

  // All files referenced by these messages (uploads + presented outputs), de-duplicated by key.
  function referencedFiles(messages) {
    const seen = new Map();
    for (const m of messages) {
      for (const f of messageFiles(m)) if (f.key && !seen.has(f.key)) seen.set(f.key, f);
      for (const c of m.content || []) {
        if (c.type === 'tool_use' && c.name === 'present_files') {
          for (const f of presentedFiles(c)) if (!seen.has(f.key)) seen.set(f.key, f);
        }
      }
    }
    return [...seen.values()];
  }

  // How a file part is rendered: {img, href} relative to the chat file, or nothing.
  function fileLink(p, ctx) {
    const local = ctx.imageMap && p.key && ctx.imageMap.get(p.key);
    if (!local) return {};
    if (p.fileKind === 'image') return { img: ctx.embedImages && local.dataUrl ? local.dataUrl : local.relPath };
    return { href: local.relPath };
  }
  const fileNote = (p) => (p.fileKind === 'blob' || p.fileKind === 'output' ? ' (не скачан — включите «файлы из чатов»)' : '');

  // Normalised parts for one message, used by every text-like converter.
  function messageParts(msg, opts, artifactsForMsg) {
    const parts = [];
    const blocks = Array.isArray(msg.content) && msg.content.length ? msg.content : [{ type: 'text', text: msg.text || '' }];
    for (const c of blocks) {
      if (c.type === 'text') {
        const t = stripAnt(c.text);
        if (t) parts.push({ kind: 'text', text: t });
      } else if (c.type === 'thinking' && opts.includeThinking && c.thinking) {
        const sum = c.summaries && c.summaries.length ? c.summaries[c.summaries.length - 1].summary : '';
        parts.push({ kind: 'thinking', text: c.thinking, summary: sum });
      } else if (c.type === 'tool_use' && c.name === 'present_files' && opts.includeAttachments) {
        presentedFiles(c).forEach((f) => parts.push({ kind: 'file', ...f }));
      } else if (c.type === 'tool_use' && opts.includeTools && !['artifacts', 'create_file'].includes(c.name)) {
        parts.push({ kind: 'tool', name: c.name, text: c.input ? JSON.stringify(c.input, null, 2) : '' });
      } else if (c.type === 'tool_result' && opts.includeTools && c.name !== 'artifacts') {
        const t = toolResultText(c);
        if (t) parts.push({ kind: 'toolResult', name: c.name, text: t });
      }
    }
    if (opts.includeArtifactsInline && artifactsForMsg) {
      for (const a of artifactsForMsg) parts.push({ kind: 'artifact', artifact: a });
    }
    if (opts.includeAttachments) {
      for (const at of msg.attachments || []) {
        parts.push({
          kind: 'attachment', name: at.file_name || 'Вставленный текст', size: at.file_size,
          type: at.file_type, text: at.extracted_content || '',
        });
      }
      for (const f of messageFiles(msg)) parts.push({ kind: 'file', ...f });
    }
    return parts;
  }

  function prepare(conv, opts) {
    const branches = opts.branchMode === 'all' ? getAllBranches(conv) : [getCurrentBranch(conv)];
    // Artifacts are tracked along each branch so update-commands apply correctly.
    const sections = [];
    const rendered = new Set();
    branches.forEach((path, bi) => {
      const arts = collectArtifacts(path).perMessage;
      let start = 0;
      if (bi > 0) while (start < path.length && rendered.has(path[start].uuid)) start++;
      const msgs = path.slice(start).map((m) => {
        rendered.add(m.uuid);
        return { msg: m, parts: messageParts(m, opts, arts.get(m.uuid)) };
      });
      if (msgs.length) sections.push({ index: bi, forkAfter: start, total: branches.length, messages: msgs });
    });
    return sections;
  }

  const fence = (text, lang = '') => {
    const ticks = '`'.repeat(Math.max(3, ...(String(text).match(/`+/g) || ['']).map((s) => s.length + 1)));
    return `${ticks}${lang}\n${text}\n${ticks}`;
  };
  const kb = (n) => (n ? `${(n / 1024).toFixed(1)} KB` : '');

  // ---------------------------------------------------------------- markdown
  function toMarkdown(conv, opts = {}, ctx = {}) {
    opts = { ...DEFAULT_SETTINGS, ...opts };
    const lines = [`# ${conv.name || 'Без названия'}`, ''];
    if (opts.includeMetadata) {
      lines.push(
        `- **Создан:** ${fmtDateTime(conv.created_at)}`,
        `- **Обновлён:** ${fmtDateTime(conv.updated_at)}`,
        `- **Экспорт:** ${fmtDateTime(new Date())}`,
        `- **Модель:** ${formatModelName(inferModel(conv))}${conv.model ? '' : ' (предположительно)'}`,
      );
      if (ctx.projectName) lines.push(`- **Проект:** ${ctx.projectName}`);
      lines.push(`- **Ссылка:** https://claude.ai/chat/${conv.uuid}`);
      const nb = countBranches(conv);
      if (nb > 1) lines.push(`- **Веток:** ${nb}`);
      lines.push('', '---', '');
    }
    for (const sec of prepare(conv, opts)) {
      if (sec.total > 1) {
        lines.push(sec.index === 0 ? `## 🌿 Ветка 1 из ${sec.total} (текущая)` : `## 🌿 Ветка ${sec.index + 1} из ${sec.total} — ответвление после сообщения #${sec.forkAfter}`, '');
      }
      for (const { msg, parts } of sec.messages) {
        lines.push(`### ${msg.sender === 'human' ? '👤 Пользователь' : '🤖 Claude'}${opts.includeMetadata && msg.created_at ? ` · ${fmtDateTime(msg.created_at)}` : ''}`, '');
        for (const p of parts) {
          switch (p.kind) {
            case 'text': lines.push(p.text, ''); break;
            case 'thinking':
              lines.push(`<details><summary>💭 Размышления${p.summary ? `: ${p.summary}` : ''}</summary>`, '', fence(p.text), '', '</details>', ''); break;
            case 'tool': lines.push(`> 🔧 **Инструмент:** \`${p.name}\``, '', fence(p.text, 'json'), ''); break;
            case 'toolResult': lines.push(`> 📤 **Результат** \`${p.name || ''}\``, '', fence(p.text.slice(0, 20000)), ''); break;
            case 'artifact': {
              const a = p.artifact;
              lines.push(`#### 📦 Артефакт: ${a.title}${a.version > 1 ? ` (версия ${a.version})` : ''}`, `*${a.language}*`, '');
              lines.push(a.language === 'markdown' || a.language === 'md' ? a.content : fence(a.content, a.language), '');
              break;
            }
            case 'attachment':
              lines.push(`#### 📎 ${p.name}${p.size || p.type ? ` _(${[kb(p.size), p.type].filter(Boolean).join(', ')})_` : ''}`, '');
              if (p.text) lines.push(fence(p.text), '');
              break;
            case 'file': {
              const l = fileLink(p, ctx);
              const url = (s) => encodeURI(s).replace(/\(/g, '%28').replace(/\)/g, '%29');
              lines.push(l.img ? `![${p.name}](${l.img.startsWith('data:') ? l.img : url(l.img)})`
                : l.href ? `📎 [${p.name}](${url(l.href)})` : `📎 _${p.name}_${p.size ? ` (${kb(p.size)})` : ''}${fileNote(p)}`, '');
              break;
            }
          }
        }
      }
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  // ---------------------------------------------------------------- text
  function toText(conv, opts = {}, ctx = {}) {
    opts = { ...DEFAULT_SETTINGS, ...opts };
    const out = [];
    if (opts.includeMetadata) {
      out.push(conv.name || 'Без названия', `Создан: ${fmtDateTime(conv.created_at)}`, `Обновлён: ${fmtDateTime(conv.updated_at)}`,
        `Модель: ${formatModelName(inferModel(conv))}`);
      if (ctx.projectName) out.push(`Проект: ${ctx.projectName}`);
      out.push(`Ссылка: https://claude.ai/chat/${conv.uuid}`, '', '---', '');
    }
    for (const sec of prepare(conv, opts)) {
      if (sec.total > 1) out.push(`===== Ветка ${sec.index + 1} из ${sec.total}${sec.index ? ` (после сообщения #${sec.forkAfter})` : ' (текущая)'} =====`, '');
      for (const { msg, parts } of sec.messages) {
        const who = msg.sender === 'human' ? 'User' : 'Claude';
        const body = [];
        for (const p of parts) {
          if (p.kind === 'text') body.push(p.text);
          else if (p.kind === 'thinking') body.push(`[Thinking${p.summary ? `: ${p.summary}` : ''}]\n${p.text}\n[/Thinking]`);
          else if (p.kind === 'tool') body.push(`[Tool: ${p.name}]\n${p.text}\n[/Tool]`);
          else if (p.kind === 'toolResult') body.push(`[Tool result]\n${p.text.slice(0, 20000)}\n[/Tool result]`);
          else if (p.kind === 'artifact') body.push(`[Artifact: ${p.artifact.title} (${p.artifact.language})]\n${p.artifact.content}\n[/Artifact]`);
          else if (p.kind === 'attachment') body.push(`[Attachment: ${p.name}]${p.text ? `\n${p.text}\n[/Attachment]` : ''}`);
          else if (p.kind === 'file') {
            const l = fileLink(p, ctx);
            body.push(`[File: ${p.name}${l.img && !l.img.startsWith('data:') ? ` -> ${l.img}` : l.href ? ` -> ${l.href}` : ''}]`);
          }
        }
        out.push(`${who}: ${body.join('\n\n')}`, '');
      }
    }
    return out.join('\n').trim() + '\n';
  }

  // ---------------------------------------------------------------- JSON
  function toJSON(conv, opts = {}, ctx = {}) {
    const data = { ...conv, model: inferModel(conv) };
    data._export = {
      tool: 'Claude Exporter Extended',
      exportedAt: new Date().toISOString(),
      modelInferred: !conv.model,
      project: ctx.projectName || null,
      branches: countBranches(conv),
      currentBranch: getCurrentBranch(conv).map((m) => m.uuid),
    };
    return JSON.stringify(data, null, 2);
  }

  // ---------------------------------------------------------------- mini markdown -> HTML
  function inlineMd(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = escapeHtml(s)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${/^(https?:|data:image\/|[\w./-]+$)/.test(src) ? src : ''}">`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => /^(https?:|mailto:|#)/.test(href.replace(/&amp;/g, '&')) ? `<a href="${href}" target="_blank" rel="noopener">${t}</a>` : t)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  }

  function mdToHtml(md) {
    const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let i = 0;
    const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    while (i < lines.length) {
      const line = lines[i];
      const fm = line.match(/^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/);
      if (fm) {
        const close = fm[2];
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(close)) buf.push(lines[i++]);
        i++;
        html.push(`<pre><code class="lang-${escapeHtml(fm[3])}">${escapeHtml(buf.join('\n'))}</code></pre>`);
        continue;
      }
      if (/^\s*$/.test(line)) { i++; continue; }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { html.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        html.push(`<table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        html.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`);
        continue;
      }
      const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        const ordered = /\d/.test(li[2]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (m) { items.push({ depth: m[1].length, text: m[3] }); i++; continue; }
          if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1].text += ' ' + lines[i].trim(); i++; continue; }
          break;
        }
        const base = items[0].depth;
        const tag = ordered ? 'ol' : 'ul';
        html.push(`<${tag}>${items.map((it) => `<li${it.depth > base ? ' class="nested"' : ''}>${inlineMd(it.text.replace(/^\[( |x)\]\s*/i, (_, x) => (x.trim() ? '☑ ' : '☐ ')))}</li>`).join('')}</${tag}>`);
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(`{3,}|~{3,})|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++]);
      if (!buf.length) buf.push(lines[i++]);
      html.push(`<p>${buf.map(inlineMd).join('<br>')}</p>`);
    }
    return html.join('\n');
  }

  // ---------------------------------------------------------------- HTML
  const HTML_CSS = `
:root{--bg:#faf9f5;--fg:#1f1e1d;--muted:#6b6a68;--card:#fff;--border:#e5e2d9;--accent:#c96442;--code:#f3f1ea;--user:#efece3}
@media (prefers-color-scheme:dark){:root{--bg:#262624;--fg:#ecebe6;--muted:#a3a19b;--card:#30302e;--border:#45443f;--accent:#d97757;--code:#1f1e1d;--user:#3a3936}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 80px}h1{font-size:1.8em;margin:.2em 0}
.meta{color:var(--muted);font-size:.9em;border-bottom:1px solid var(--border);padding-bottom:12px;margin-bottom:20px}
.meta span{margin-right:14px;display:inline-block}.msg{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 18px;margin:14px 0}
.msg.human{background:var(--user)}.who{font-weight:600;font-size:.85em;color:var(--accent);margin-bottom:6px}.who time{color:var(--muted);font-weight:400;margin-left:8px}
pre{background:var(--code);border:1px solid var(--border);border-radius:8px;padding:12px;overflow:auto;font-size:.88em;line-height:1.45}
code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}p code,li code{background:var(--code);padding:1px 5px;border-radius:4px}
details{border:1px dashed var(--border);border-radius:8px;padding:6px 10px;margin:10px 0}summary{cursor:pointer;color:var(--muted)}
.artifact{border-left:3px solid var(--accent)}.branch{margin:34px 0 10px;padding:8px 12px;border-radius:8px;background:var(--code);font-weight:600}
table{border-collapse:collapse;margin:10px 0;display:block;overflow:auto}th,td{border:1px solid var(--border);padding:6px 10px}
blockquote{border-left:3px solid var(--border);margin:8px 0;padding:0 12px;color:var(--muted)}img{max-width:100%;border-radius:8px}
li.nested{margin-left:1.5em}a{color:var(--accent)}.toolbar{position:fixed;right:16px;bottom:16px;display:flex;gap:8px}
.toolbar button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font:inherit}
@media print{.toolbar{display:none}body{background:#fff;color:#000}.msg{break-inside:avoid-page}details{display:block}details>*{display:block}}`;

  function toHTML(conv, opts = {}, ctx = {}) {
    opts = { ...DEFAULT_SETTINGS, ...opts };
    const body = [];
    const title = escapeHtml(conv.name || 'Без названия');
    body.push(`<h1>${title}</h1>`);
    if (opts.includeMetadata) {
      const meta = [
        ['Создан', fmtDateTime(conv.created_at)], ['Обновлён', fmtDateTime(conv.updated_at)],
        ['Модель', formatModelName(inferModel(conv))], ctx.projectName && ['Проект', ctx.projectName],
      ].filter(Boolean);
      body.push(`<div class="meta">${meta.map(([k, v]) => `<span><b>${k}:</b> ${escapeHtml(v)}</span>`).join('')}<span><a href="https://claude.ai/chat/${escapeHtml(conv.uuid)}" target="_blank">Открыть в Claude</a></span></div>`);
    }
    for (const sec of prepare(conv, opts)) {
      if (sec.total > 1) body.push(`<div class="branch">🌿 Ветка ${sec.index + 1} из ${sec.total}${sec.index ? ` — ответвление после сообщения #${sec.forkAfter}` : ' (текущая)'}</div>`);
      for (const { msg, parts } of sec.messages) {
        const h = [`<div class="who">${msg.sender === 'human' ? 'Пользователь' : 'Claude'}${opts.includeMetadata && msg.created_at ? `<time>${fmtDateTime(msg.created_at)}</time>` : ''}</div>`];
        for (const p of parts) {
          if (p.kind === 'text') h.push(msg.sender === 'human' ? `<p>${escapeHtml(p.text).replace(/\n/g, '<br>')}</p>` : mdToHtml(p.text));
          else if (p.kind === 'thinking') h.push(`<details><summary>💭 Размышления${p.summary ? `: ${escapeHtml(p.summary)}` : ''}</summary><pre>${escapeHtml(p.text)}</pre></details>`);
          else if (p.kind === 'tool') h.push(`<details><summary>🔧 ${escapeHtml(p.name)}</summary><pre>${escapeHtml(p.text)}</pre></details>`);
          else if (p.kind === 'toolResult') h.push(`<details><summary>📤 Результат ${escapeHtml(p.name || '')}</summary><pre>${escapeHtml(p.text.slice(0, 20000))}</pre></details>`);
          else if (p.kind === 'artifact') {
            const a = p.artifact;
            const inner = a.language === 'markdown' || a.language === 'md' ? mdToHtml(a.content) : `<pre><code>${escapeHtml(a.content)}</code></pre>`;
            h.push(`<details class="artifact" open><summary>📦 ${escapeHtml(a.title)} <small>(${escapeHtml(a.language)}${a.version > 1 ? `, v${a.version}` : ''})</small></summary>${inner}</details>`);
          } else if (p.kind === 'attachment') {
            h.push(`<details><summary>📎 ${escapeHtml(p.name)} ${p.size ? `<small>${kb(p.size)}</small>` : ''}</summary>${p.text ? `<pre>${escapeHtml(p.text)}</pre>` : ''}</details>`);
          } else if (p.kind === 'file') {
            const l = fileLink(p, ctx);
            const enc = (s) => (s.startsWith('data:') ? s : encodeURI(s));
            h.push(l.img ? `<p><a href="${escapeHtml(enc(l.img))}" target="_blank"><img src="${escapeHtml(enc(l.img))}" alt="${escapeHtml(p.name)}"></a></p>`
              : l.href ? `<p>📎 <a href="${escapeHtml(enc(l.href))}" target="_blank">${escapeHtml(p.name)}</a></p>`
              : `<p>📎 <i>${escapeHtml(p.name)}</i>${p.size ? ` <small>${kb(p.size)}</small>` : ''}<small>${escapeHtml(fileNote(p))}</small></p>`);
          }
        }
        body.push(`<section class="msg ${msg.sender === 'human' ? 'human' : 'assistant'}">${h.join('\n')}</section>`);
      }
    }
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${HTML_CSS}</style></head><body><main>${body.join('\n')}</main><div class="toolbar"><button onclick="document.querySelectorAll('details').forEach(d=>d.open=!d.open)">Развернуть/свернуть</button><button onclick="print()">PDF / Печать</button></div></body></html>`;
  }

  const FORMATS = {
    json: { ext: 'json', mime: 'application/json', fn: toJSON },
    markdown: { ext: 'md', mime: 'text/markdown', fn: toMarkdown },
    text: { ext: 'txt', mime: 'text/plain', fn: toText },
    html: { ext: 'html', mime: 'text/html', fn: toHTML },
  };

  function convert(conv, format, opts, ctx) {
    const f = FORMATS[format] || FORMATS.markdown;
    return { content: f.fn(conv, opts, ctx), ext: f.ext, mime: f.mime };
  }

  function buildFilename(template, conv, ctx = {}) {
    const vals = {
      title: conv.name || 'Без названия',
      date: ymd(conv.created_at),
      created: ymd(conv.created_at),
      updated: ymd(conv.updated_at),
      uuid: conv.uuid,
      short: String(conv.uuid || '').slice(0, 8),
      model: formatModelName(inferModel(conv)),
      project: ctx.projectName || '',
    };
    const name = String(template || '{title}').replace(/\{(\w+)\}/g, (_, k) => vals[k] ?? '');
    return sanitizeFilename(name.replace(/\s+/g, ' ').trim() || vals.title);
  }

  // Plain text of the whole conversation (all branches) for full-text search.
  function searchableText(conv) {
    const out = [conv.name || ''];
    for (const m of conv.chat_messages || []) {
      for (const c of m.content || []) {
        if (c.text) out.push(c.text);
        if (c.thinking) out.push(c.thinking);
        if (c.input && (c.input.content || c.input.file_text)) out.push(c.input.content || c.input.file_text);
      }
      if (m.text) out.push(m.text);
      for (const a of m.attachments || []) if (a.extracted_content) out.push(a.extracted_content);
    }
    return out.join('\n');
  }

  function csvRow(arr) {
    return arr.map((v) => {
      const s = String(v ?? '');
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',');
  }

  root.CECore = {
    DEFAULT_SETTINGS, ymd, stamp, fmtDateTime, sanitizeFilename, escapeHtml, makeUniquer,
    inferModel, formatModelName, modelFamily,
    buildTree, getCurrentBranch, getAllBranches, countBranches,
    collectArtifacts, artifactFiles, messageFiles, presentedFiles, referencedFiles,
    toMarkdown, toText, toJSON, toHTML, mdToHtml, convert, FORMATS, buildFilename, searchableText, csvRow, HTML_CSS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
