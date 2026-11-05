// High-level export operations shared by popup, browse page and content script.
// Depends on CEApi, CECore and JSZip being loaded first.
(function (root) {
  'use strict';
  const { CEApi: api, CECore: core } = root;

  // ---------------------------------------------------------------- settings
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(core.DEFAULT_SETTINGS, (s) => resolve({ ...core.DEFAULT_SETTINGS, ...s }));
    });
  }
  function saveSettings(patch) {
    return new Promise((resolve) => chrome.storage.sync.set(patch, resolve));
  }

  async function ensureOrgId(settings) {
    if (settings.orgId) return settings.orgId;
    const orgId = await api.detectOrgId();
    await saveSettings({ orgId });
    settings.orgId = orgId;
    return orgId;
  }

  // ---------------------------------------------------------------- export history
  function getHistory() {
    return new Promise((r) => chrome.storage.local.get({ exportHistory: {} }, (x) => r(x.exportHistory)));
  }
  async function recordExports(convs) {
    const h = await getHistory();
    const now = new Date().toISOString();
    for (const c of convs) h[c.uuid] = { at: now, updated_at: c.updated_at };
    return new Promise((r) => chrome.storage.local.set({ exportHistory: h }, r));
  }

  // ---------------------------------------------------------------- full-conversation cache (IndexedDB, extension pages only)
  const cache = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const req = indexedDB.open('ce-cache', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('convs', { keyPath: 'uuid' });
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('convs', mode);
        const r = fn(t.objectStore('convs'));
        t.oncomplete = () => res(r && r.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      get: (uuid) => tx('readonly', (s) => s.get(uuid)),
      put: (rec) => tx('readwrite', (s) => s.put(rec)),
      all: () => tx('readonly', (s) => s.getAll()),
      clear: () => tx('readwrite', (s) => s.clear()),
    };
  })();
  const canCache = typeof location !== 'undefined' && location.protocol === 'chrome-extension:';

  // Returns the full conversation, using the cache when updated_at matches.
  async function fetchFull(orgId, summary, { signal, useCache = canCache } = {}) {
    if (useCache && summary.updated_at) {
      try {
        const hit = await cache.get(summary.uuid);
        if (hit && hit.updated_at === summary.updated_at && hit.data) return hit.data;
      } catch { /* cache is best effort */ }
    }
    const data = await api.getConversation(orgId, summary.uuid, { signal });
    if (!data || !Array.isArray(data.chat_messages)) throw new Error('Неожиданный формат ответа API');
    if (useCache) {
      cache.put({ uuid: data.uuid, updated_at: data.updated_at, name: data.name, text: core.searchableText(data), data }).catch(() => {});
    }
    return data;
  }

  // ---------------------------------------------------------------- images
  function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
  }
  const mimeExt = (t) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[t] || 'bin');

  const fileExt = (name) => (String(name).match(/\.([a-z0-9]{1,10})$/i) || [])[1];
  // "/mnt/user-data/outputs/a/b.txt" -> "sandbox/outputs/a/b.txt" (each segment sanitized)
  const sandboxRel = (p) => 'sandbox/' + String(p).replace(/^\/mnt\/user-data\//, '').replace(/^\/+/, '')
    .split('/').filter((s) => s && s !== '..' && s !== '.').map((s) => core.sanitizeFilename(s, 120)).join('/');

  // Downloads the chat's files:
  //  - uploaded images and PDFs in their ORIGINAL form (/files/<id>/contents),
  //    falling back to the preview/PDF URL if that fails;
  //  - sandbox files (uploads like ZIP/bundles and files Claude produced in
  //    /mnt/user-data/outputs) via the wiggle API — referenced ones, or the whole
  //    sandbox when settings.sandboxScope === 'all'.
  // Returns Map(key -> {blob, relPath, isImage, dataUrl?}) with extra props:
  // .failed = [{name, error}], .skipped = [{name, size}], .docs = non-image files count.
  async function collectImages(conv, settings, { orgId = settings.orgId, dataUrls = false, prefix = 'files/', signal } = {}) {
    const map = new Map();
    map.failed = [];
    map.skipped = [];
    map.docs = 0;
    const maxBytes = (Number(settings.maxFileMB) || 0) * 1048576;
    const msgs = settings.branchMode === 'all' ? conv.chat_messages || [] : core.getCurrentBranch(conv);
    const unique = core.makeUniquer();

    const add = async (f, fetchers, relFor) => {
      if (!f.key || map.has(f.key)) return;
      if (maxBytes && f.size > maxBytes) { map.skipped.push({ name: f.name, size: f.size }); return; }
      let blob = null, lastErr = null;
      for (const get of fetchers) {
        try { blob = await get(); break; } catch (e) { lastErr = e; }
      }
      if (!blob) {
        map.failed.push({ name: f.name, error: lastErr ? lastErr.message : 'нет ссылки для скачивания' });
        return;
      }
      if (maxBytes && blob.size > maxBytes) { map.skipped.push({ name: f.name, size: blob.size }); return; }
      const isImage = f.fileKind === 'image';
      map.set(f.key, { blob, relPath: prefix + relFor(blob), isImage, dataUrl: dataUrls && isImage ? await blobToDataUrl(blob) : null });
      if (!isImage) map.docs++;
    };

    const uploadRel = (f) => (blob) => {
      const ext = fileExt(f.name) || (f.fileKind === 'image' ? mimeExt(blob.type) : blob.type === 'application/pdf' ? 'pdf' : 'bin');
      return unique(`${core.sanitizeFilename(f.name.replace(/\.[^.]+$/, ''), 80)}.${ext}`);
    };

    const refs = core.referencedFiles(msgs);
    for (const f of refs) {
      if (signal && signal.aborted) break;
      if (f.fileKind === 'image' || f.fileKind === 'document') {
        const fetchers = [];
        if (orgId && f.uuid) fetchers.push(() => api.getFileContents(orgId, f.uuid, { signal }));
        if (f.path) fetchers.push(() => api.getFileBlob(f.path, { signal }));
        await add(f, fetchers, uploadRel(f));
      } else if (f.sandboxPath && orgId) {
        await add(f, [() => api.downloadSandboxFile(orgId, conv.uuid, f.sandboxPath, { signal })], () => sandboxRel(f.sandboxPath));
      }
    }

    if (settings.sandboxScope === 'all' && orgId && !(signal && signal.aborted)) {
      let list = [];
      try { list = await api.listSandboxFiles(orgId, conv.uuid, { signal }); } catch (e) { map.failed.push({ name: 'список файлов песочницы', error: e.message }); }
      for (const s of list) {
        if (signal && signal.aborted) break;
        const f = { key: `sandbox:${s.path}`, name: s.path.split('/').pop(), fileKind: 'blob', size: s.size };
        await add(f, [() => api.downloadSandboxFile(orgId, conv.uuid, s.path, { signal })], () => sandboxRel(s.path));
      }
    }
    return map;
  }

  // ---------------------------------------------------------------- single conversation
  // Returns {blob, filename, artifactCount}
  async function buildSingle(conv, settings, ctx = {}) {
    const fmt = settings.format;
    const baseName = core.buildFilename(settings.filenameTemplate, conv, ctx);
    const arts = settings.extractArtifacts ? core.artifactFiles(conv, core.getCurrentBranch(conv), { versions: settings.artifactVersions }) : [];
    let imageMap = null;
    if (settings.downloadImages) {
      imageMap = await collectImages(conv, settings, { orgId: ctx.orgId || settings.orgId, dataUrls: fmt === 'html' && !arts.length });
    }
    // A single HTML file can embed images; anything else (PDFs, other formats) needs a ZIP.
    const needZip = arts.length > 0 || (imageMap && imageMap.size > 0 && (fmt !== 'html' || imageMap.docs > 0));
    const out = core.convert(conv, fmt, settings, { ...ctx, imageMap, embedImages: !needZip });
    if (!needZip) {
      return { blob: new Blob([out.content], { type: out.mime + ';charset=utf-8' }), filename: `${baseName}.${out.ext}`, artifactCount: 0 };
    }
    const zip = new JSZip();
    zip.file(`${baseName}.${out.ext}`, out.content);
    for (const a of arts) zip.file(`artifacts/${a.path}`, a.content);
    if (imageMap) for (const v of imageMap.values()) zip.file(v.relPath, v.blob);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    return { blob, filename: `${baseName}.zip`, artifactCount: arts.length };
  }

  async function exportSingle(orgId, convId, settings, ctx = {}) {
    const data = await api.getConversation(orgId, convId);
    if (!data || !Array.isArray(data.chat_messages)) throw new Error('Неожиданный формат ответа API');
    if (!ctx.projectName && data.project && data.project.name) ctx.projectName = data.project.name;
    const res = await buildSingle(data, settings, { ...ctx, orgId });
    await recordExports([data]);
    return res;
  }

  // ---------------------------------------------------------------- bulk
  // summaries: items from listConversations; projects: Map(uuid -> name)
  async function buildBulk(orgId, summaries, settings, { projects = new Map(), onProgress, signal } = {}) {
    const zip = new JSZip();
    const fmt = settings.format;
    const folderUniq = new Map(); // parent folder -> uniquer
    const uniqIn = (folder) => {
      if (!folderUniq.has(folder)) folderUniq.set(folder, core.makeUniquer());
      return folderUniq.get(folder);
    };
    const index = [];
    const errors = [];
    let artifactTotal = 0;
    let filesTotal = 0;

    const results = await api.pool(summaries, async (s) => {
      const conv = await fetchFull(orgId, s, { signal });
      const projectName = projects.get(conv.project_uuid || s.project_uuid) || (conv.project && conv.project.name) || '';
      const ctx = { projectName };
      const base = core.buildFilename(settings.filenameTemplate, conv, ctx);
      const root = settings.groupByProject ? (projectName ? `Projects/${core.sanitizeFilename(projectName, 60)}/` : 'Chats/') : '';
      const arts = settings.extractArtifacts ? core.artifactFiles(conv, core.getCurrentBranch(conv), { versions: settings.artifactVersions }) : [];
      const branchMsgs = settings.branchMode === 'all' ? conv.chat_messages || [] : core.getCurrentBranch(conv);
      const hasFiles = settings.downloadImages && (settings.sandboxScope === 'all' || core.referencedFiles(branchMsgs).length > 0);
      const nested = settings.zipLayout === 'nested' && (arts.length > 0 || hasFiles);
      let chatPath, artDir, imgDir;
      if (nested) {
        const dir = root + uniqIn(root)(base) + '/';
        chatPath = dir + `${base}.${core.FORMATS[fmt].ext}`;
        artDir = dir + 'artifacts/';
        imgDir = dir + 'files/';
      } else {
        const chatsDir = settings.groupByProject ? root : 'Chats/';
        const fileName = uniqIn(chatsDir)(`${base}.${core.FORMATS[fmt].ext}`);
        chatPath = chatsDir + fileName;
        const key = fileName.replace(/\.[^.]+$/, '');
        artDir = `Artifacts/${key}/`;
        imgDir = `Files/${key}/`;
      }
      let imageMap = null;
      if (hasFiles) {
        // relPath is relative to the chat file; zip path is absolute inside the archive
        const depth = chatPath.split('/').length - 1;
        const chatDir = chatPath.slice(0, chatPath.lastIndexOf('/') + 1);
        const prefix = imgDir.startsWith(chatDir) && nested ? imgDir.slice(chatDir.length) : '../'.repeat(depth) + imgDir;
        imageMap = await collectImages(conv, settings, { orgId, prefix, signal });
        for (const v of imageMap.values()) zip.file(imgDir + v.relPath.slice(prefix.length), v.blob);
        imageMap.failed.forEach((f) => errors.push({ name: `${conv.name} → файл ${f.name}`, error: f.error }));
        imageMap.skipped.forEach((f) => errors.push({ name: `${conv.name} → файл ${f.name}`, error: `пропущен: ${(f.size / 1048576).toFixed(1)} МБ больше лимита ${settings.maxFileMB} МБ` }));
        filesTotal += imageMap.size;
      }
      const out = core.convert(conv, fmt, settings, { ...ctx, imageMap });
      zip.file(chatPath, out.content);
      for (const a of arts) zip.file(artDir + a.path, a.content);
      artifactTotal += arts.length;
      index.push({
        conv, path: chatPath, projectName, artifacts: arts.length,
        messages: (conv.chat_messages || []).length, branches: core.countBranches(conv),
      });
      return conv;
    }, {
      concurrency: settings.concurrency, delayMs: settings.delayMs, signal,
      onProgress: (done, total, item, r) => {
        if (!r.ok) errors.push({ uuid: item.uuid, name: item.name, error: r.error && r.error.message });
        if (onProgress) onProgress(done, total, item, r);
      },
    });

    if (settings.addIndex && index.length) {
      index.sort((a, b) => String(b.conv.updated_at).localeCompare(String(a.conv.updated_at)));
      zip.file('index.csv', '﻿' + [
        core.csvRow(['title', 'created', 'updated', 'model', 'project', 'messages', 'branches', 'artifacts', 'file', 'url']),
        ...index.map((r) => core.csvRow([r.conv.name, r.conv.created_at, r.conv.updated_at, core.formatModelName(core.inferModel(r.conv)),
          r.projectName, r.messages, r.branches, r.artifacts, r.path, `https://claude.ai/chat/${r.conv.uuid}`])),
      ].join('\r\n'));
      zip.file('index.html', buildIndexHtml(index));
    }
    if (errors.length) {
      zip.file('errors.txt', errors.map((e) => `${e.name || e.uuid}: ${e.error}`).join('\n'));
    }
    const ok = results.filter((r) => r && r.ok).map((r) => r.value);
    return { zip, ok, errors, artifactTotal, filesTotal };
  }

  function buildIndexHtml(index) {
    const e = core.escapeHtml;
    const rows = index.map((r) => `<tr><td><a href="${e(encodeURI(r.path))}">${e(r.conv.name || 'Без названия')}</a></td><td>${e(core.ymd(r.conv.created_at))}</td><td>${e(core.ymd(r.conv.updated_at))}</td><td>${e(core.formatModelName(core.inferModel(r.conv)))}</td><td>${e(r.projectName)}</td><td>${r.messages}</td><td>${r.artifacts}</td></tr>`).join('');
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Claude — архив чатов</title><style>${core.HTML_CSS}
input{width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--fg);font:inherit;margin:10px 0}
table{display:table;width:100%}td,th{font-size:.92em;text-align:left}th{cursor:pointer}</style></head><body><main style="max-width:1200px">
<h1>Архив чатов Claude</h1><div class="meta">${index.length} чатов · экспорт ${e(core.fmtDateTime(new Date()))}</div>
<input id="q" placeholder="Фильтр по названию / проекту / модели…"><table id="t"><thead><tr><th>Название</th><th>Создан</th><th>Обновлён</th><th>Модель</th><th>Проект</th><th>Сообщ.</th><th>Арт.</th></tr></thead><tbody>${rows}</tbody></table>
<script>q.oninput=()=>{const v=q.value.toLowerCase();for(const r of t.tBodies[0].rows)r.style.display=r.textContent.toLowerCase().includes(v)?'':'none'};
document.querySelectorAll('th').forEach((th,i)=>th.onclick=()=>{const b=t.tBodies[0],rs=[...b.rows],d=th.dataset.d=th.dataset.d==='a'?'d':'a';rs.sort((x,y)=>{const a=x.cells[i].textContent,c=y.cells[i].textContent;const n=!isNaN(a)&&!isNaN(c)?a-c:a.localeCompare(c);return d==='a'?n:-n});rs.forEach(r=>b.appendChild(r))})</script></main></body></html>`;
  }

  // ---------------------------------------------------------------- projects (instructions + knowledge docs)
  async function addProjectsToZip(zip, orgId, projectList, { onProgress, signal } = {}) {
    const errors = [];
    const uniq = core.makeUniquer();
    let i = 0;
    for (const p of projectList) {
      if (signal && signal.aborted) break;
      const dir = `Projects/${uniq(core.sanitizeFilename(p.name || p.uuid, 60))}/_project/`;
      try {
        const full = await api.getProject(orgId, p.uuid).catch(() => p);
        const info = [`# ${full.name || p.name}`, '', full.description ? `${full.description}\n` : '',
          `- Создан: ${core.fmtDateTime(full.created_at)}`, `- Обновлён: ${core.fmtDateTime(full.updated_at)}`,
          `- Ссылка: https://claude.ai/project/${p.uuid}`, ''];
        if (full.prompt_template) info.push('## Инструкции проекта', '', full.prompt_template, '');
        zip.file(dir + 'README.md', info.join('\n'));
        zip.file(dir + 'project.json', JSON.stringify(full, null, 2));
        try {
          const docs = await api.getProjectDocs(orgId, p.uuid);
          const du = core.makeUniquer();
          for (const d of docs || []) {
            zip.file(dir + 'knowledge/' + du(core.sanitizeFilename(d.file_name || d.uuid, 100)), d.content || '');
          }
        } catch (e) {
          errors.push({ name: p.name, error: `база знаний: ${e.message}` });
        }
      } catch (e) {
        errors.push({ name: p.name, error: e.message });
      }
      if (onProgress) onProgress(++i, projectList.length, p);
    }
    return errors;
  }

  // ---------------------------------------------------------------- download
  function downloadBlob(blob, filename, { saveAs = false } = {}) {
    const url = URL.createObjectURL(blob);
    const revoke = () => setTimeout(() => URL.revokeObjectURL(url), 60000);
    if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.download) {
      return new Promise((resolve, reject) => {
        chrome.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' }, (id) => {
          revoke();
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        });
      });
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    revoke();
    return Promise.resolve();
  }

  root.CEExport = {
    loadSettings, saveSettings, ensureOrgId, getHistory, recordExports, cache, fetchFull,
    buildSingle, exportSingle, buildBulk, addProjectsToZip, downloadBlob, collectImages,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
