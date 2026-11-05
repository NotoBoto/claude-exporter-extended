(async () => {
  const $ = (id) => document.getElementById(id);
  const core = CECore;
  const settings = await CEExport.loadSettings();

  const state = {
    orgId: settings.orgId,
    convs: [],            // summaries from the API
    projects: new Map(),  // uuid -> name
    projectList: [],
    history: {},
    textIndex: new Map(), // uuid -> lowercased text (deep search)
    selected: new Set(),
    visible: [],
    sort: { key: 'updated_at', dir: 'desc' },
    previewId: null,
    abort: null,
  };

  // ---------------------------------------------------------------- utils
  let toastT;
  function toast(t) {
    $('toast').textContent = t;
    $('toast').classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => $('toast').classList.remove('show'), 3500);
  }
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    kids.flat().forEach((k) => k != null && n.append(k));
    return n;
  };
  const projectName = (c) => state.projects.get(c.project_uuid) || (c.project && c.project.name) || '';
  const isChanged = (c) => {
    const h = state.history[c.uuid];
    return !h || new Date(c.updated_at) > new Date(h.at);
  };

  // ---------------------------------------------------------------- export option controls (footer)
  $('format').value = settings.format;
  ['extractArtifacts', 'includeThinking', 'downloadImages'].forEach((k) => { $(k).checked = !!settings[k]; });
  $('allBranches').checked = settings.branchMode === 'all';
  document.querySelectorAll('.bottom select, .bottom input').forEach((n) => n.addEventListener('change', () => {
    const patch = {
      format: $('format').value, extractArtifacts: $('extractArtifacts').checked, includeThinking: $('includeThinking').checked,
      downloadImages: $('downloadImages').checked, branchMode: $('allBranches').checked ? 'all' : 'current',
    };
    Object.assign(settings, patch);
    CEExport.saveSettings(patch);
    if (state.previewId) showPreview(state.previewId);
  }));

  // ---------------------------------------------------------------- loading
  async function loadOrgs() {
    try {
      const orgs = await CEApi.getOrganizations();
      $('org').innerHTML = '';
      orgs.forEach((o) => $('org').append(el('option', { value: o.uuid, textContent: `${o.name}${o.isChat ? '' : ' (API)'}` })));
      if (!state.orgId || !orgs.some((o) => o.uuid === state.orgId)) {
        state.orgId = (orgs.find((o) => o.isChat) || orgs[0]).uuid;
        CEExport.saveSettings({ orgId: state.orgId });
      }
      $('org').value = state.orgId;
      $('org').hidden = orgs.length < 2;
    } catch (e) {
      $('empty').hidden = false;
      $('empty').textContent = `Не удалось подключиться к claude.ai: ${e.message}`;
      throw e;
    }
  }

  async function loadAll() {
    $('stats').textContent = 'Загрузка…';
    state.history = await CEExport.getHistory();
    const [convs, projects] = await Promise.all([
      CEApi.listConversations(state.orgId),
      CEApi.listProjects(state.orgId).catch(() => []),
    ]);
    state.convs = convs;
    state.projectList = Array.isArray(projects) ? projects : [];
    state.projects = new Map(state.projectList.map((p) => [p.uuid, p.name]));

    // filter dropdowns
    const fam = new Map();
    convs.forEach((c) => {
      const m = core.inferModel(c);
      const label = core.formatModelName(m);
      fam.set(label, (fam.get(label) || 0) + 1);
    });
    const fm = $('fModel');
    const keepM = fm.value;
    fm.length = 1;
    [...fam.entries()].sort((a, b) => b[1] - a[1]).forEach(([l, n]) => fm.append(el('option', { value: l, textContent: `${l} (${n})` })));
    fm.value = keepM;
    const fp = $('fProject');
    const keepP = fp.value;
    fp.length = 2;
    state.projectList.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((p) => fp.append(el('option', { value: p.uuid, textContent: p.name })));
    fp.value = keepP;

    await loadTextIndex();
    render();
  }

  async function loadTextIndex() {
    try {
      const recs = await CEExport.cache.all();
      state.textIndex = new Map(recs.map((r) => [r.uuid, { text: (r.text || '').toLowerCase(), raw: r.text || '', updated_at: r.updated_at }]));
    } catch { state.textIndex = new Map(); }
    const fresh = state.convs.filter((c) => state.textIndex.get(c.uuid)?.updated_at === c.updated_at).length;
    $('indexBtn').textContent = `Индексировать (${fresh}/${state.convs.length})`;
  }

  // ---------------------------------------------------------------- filtering / rendering
  function filtered() {
    const q = $('q').value.trim().toLowerCase();
    const deep = $('deep').checked;
    const fModel = $('fModel').value;
    const fProject = $('fProject').value;
    const from = $('fFrom').value ? new Date($('fFrom').value) : null;
    const to = $('fTo').value ? new Date($('fTo').value + 'T23:59:59') : null;
    const fState = $('fState').value;
    const terms = q.split(/\s+/).filter(Boolean);

    const out = state.convs.filter((c) => {
      if (fModel && core.formatModelName(core.inferModel(c)) !== fModel) return false;
      if (fProject === '__none' && c.project_uuid) return false;
      if (fProject && fProject !== '__none' && c.project_uuid !== fProject) return false;
      const upd = new Date(c.updated_at);
      if (from && upd < from) return false;
      if (to && new Date(c.created_at) > to) return false;
      if (fState === 'changed' && !isChanged(c)) return false;
      if (fState === 'never' && state.history[c.uuid]) return false;
      if (fState === 'starred' && !c.is_starred) return false;
      if (terms.length) {
        const hay = (c.name || '').toLowerCase() + ' ' + projectName(c).toLowerCase() +
          (deep ? ' ' + (state.textIndex.get(c.uuid)?.text || '') : '');
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      return true;
    });

    const { key, dir } = state.sort;
    const val = (c) => key === 'project' ? projectName(c) : key === 'model' ? core.formatModelName(core.inferModel(c))
      : key === 'exported' ? state.history[c.uuid]?.at || '' : c[key] || '';
    out.sort((a, b) => {
      const r = String(val(a)).localeCompare(String(val(b)), 'ru', { numeric: true });
      return dir === 'asc' ? r : -r;
    });
    return out;
  }

  function highlight(text, terms) {
    const frag = document.createDocumentFragment();
    if (!terms.length) { frag.append(text); return frag; }
    const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    String(text).split(re).forEach((part, i) => frag.append(i % 2 ? el('mark', { textContent: part }) : part));
    return frag;
  }

  function snippet(uuid, terms) {
    const idx = state.textIndex.get(uuid);
    if (!idx || !terms.length) return null;
    const pos = idx.text.indexOf(terms[0]);
    if (pos < 0) return null;
    const s = Math.max(0, pos - 60);
    return (s ? '…' : '') + idx.raw.slice(s, pos + 120).replace(/\s+/g, ' ') + '…';
  }

  function render() {
    state.visible = filtered();
    const terms = $('q').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const deep = $('deep').checked;
    const tb = $('tbody');
    tb.textContent = '';
    const frag = document.createDocumentFragment();
    for (const c of state.visible) {
      const model = core.inferModel(c);
      const fam = core.modelFamily(model);
      const chk = el('input', { type: 'checkbox', checked: state.selected.has(c.uuid) });
      chk.addEventListener('click', (e) => { e.stopPropagation(); toggleSel(c.uuid, chk.checked); });
      const nameCell = el('td', { className: 'name' },
        el('div', { className: 't' },
          isChanged(c) && state.history[c.uuid] ? el('span', { className: 'changed-dot', title: 'Изменён после последнего экспорта' }) : null,
          c.is_starred ? el('span', { className: 'star', textContent: '★ ' }) : null,
          highlight(c.name || 'Без названия', terms)));
      const sn = deep && snippet(c.uuid, terms);
      if (sn) nameCell.append(el('div', { className: 'snip' }, highlight(sn, terms)));
      const exp = state.history[c.uuid];
      const btnExport = el('button', { textContent: '⤓', title: 'Экспортировать' });
      btnExport.addEventListener('click', (e) => { e.stopPropagation(); exportOne(c); });
      const btnOpen = el('button', { textContent: '↗', title: 'Открыть в Claude' });
      btnOpen.addEventListener('click', (e) => { e.stopPropagation(); window.open(`https://claude.ai/chat/${c.uuid}`, '_blank'); });
      const tr = el('tr', {},
        el('td', {}, chk),
        nameCell,
        el('td', { className: 'proj', textContent: projectName(c), title: projectName(c) }),
        el('td', {}, el('span', { className: `badge ${fam}`, textContent: core.formatModelName(model).replace(/^Claude /, ''), title: c.model ? model : `${model} (предположительно)` })),
        el('td', { className: 'date', textContent: core.fmtDateTime(c.created_at) }),
        el('td', { className: 'date', textContent: core.fmtDateTime(c.updated_at) }),
        el('td', { className: 'date', textContent: exp ? core.fmtDateTime(exp.at) : '—' }),
        el('td', {}, el('div', { className: 'act' }, btnExport, btnOpen)));
      tr.dataset.id = c.uuid;
      if (c.uuid === state.previewId) tr.classList.add('active');
      tr.addEventListener('click', () => showPreview(c.uuid));
      frag.append(tr);
    }
    tb.append(frag);
    $('empty').hidden = state.visible.length > 0;
    if (!state.visible.length) $('empty').textContent = 'Ничего не найдено';
    $('stats').textContent = `Показано ${state.visible.length} из ${state.convs.length} · проектов: ${state.projectList.length}`;
    updateSel();
  }

  function toggleSel(id, on) {
    on ? state.selected.add(id) : state.selected.delete(id);
    updateSel();
  }
  function updateSel() {
    $('selInfo').textContent = `Выбрано: ${state.selected.size}`;
    $('exportSelected').disabled = !state.selected.size;
    const vis = state.visible.length && state.visible.every((c) => state.selected.has(c.uuid));
    $('checkAll').checked = !!vis;
    $('exportFiltered').textContent = `Экспорт всех показанных (${state.visible.length})`;
  }

  // ---------------------------------------------------------------- preview
  async function showPreview(uuid) {
    state.previewId = uuid;
    document.querySelectorAll('tbody tr').forEach((tr) => tr.classList.toggle('active', tr.dataset.id === uuid));
    const c = state.convs.find((x) => x.uuid === uuid);
    $('preview').hidden = false;
    $('prevTitle').textContent = c ? c.name || 'Без названия' : '';
    $('prevFrame').srcdoc = '<p style="font-family:sans-serif;color:#888;padding:20px">Загрузка…</p>';
    try {
      const full = await CEExport.fetchFull(state.orgId, c);
      if (state.previewId !== uuid) return;
      $('prevFrame').srcdoc = core.toHTML(full, { ...settings, includeTools: settings.includeTools }, { projectName: projectName(c) });
    } catch (e) {
      $('prevFrame').srcdoc = `<p style="font-family:sans-serif;color:#c0392b;padding:20px">${core.escapeHtml(e.message)}</p>`;
    }
  }
  $('prevClose').onclick = () => { $('preview').hidden = true; state.previewId = null; render(); };
  $('prevExport').onclick = () => {
    const c = state.convs.find((x) => x.uuid === state.previewId);
    if (c) exportOne(c);
  };

  // ---------------------------------------------------------------- exports
  async function exportOne(c) {
    try {
      toast(`Экспорт «${c.name || 'Без названия'}»…`);
      const full = await CEExport.fetchFull(state.orgId, c);
      const res = await CEExport.buildSingle(full, settings, { projectName: projectName(c), orgId: state.orgId });
      await CEExport.downloadBlob(res.blob, res.filename);
      await CEExport.recordExports([full]);
      state.history = await CEExport.getHistory();
      toast(`Сохранено: ${res.filename}`);
      render();
    } catch (e) {
      toast(`Ошибка: ${e.message}`);
    }
  }

  function modal(title) {
    $('mTitle').textContent = title;
    $('mBar').style.width = '0';
    $('mText').textContent = '';
    $('mErrors').textContent = '';
    $('mCancel').textContent = 'Отмена';
    $('modal').hidden = false;
    state.abort = new AbortController();
    return state.abort.signal;
  }
  $('mCancel').onclick = () => {
    if (state.abort && !state.abort.signal.aborted) state.abort.abort();
    $('modal').hidden = true;
  };

  async function exportMany(list) {
    if (!list.length) return toast('Нечего экспортировать');
    const withProjects = $('includeProjects').checked;
    const signal = modal(`Экспорт ${list.length} чатов`);
    const t0 = Date.now();
    try {
      const { zip, ok, errors, artifactTotal, filesTotal } = await CEExport.buildBulk(state.orgId, list, settings, {
        projects: state.projects, signal,
        onProgress: (done, total, item, r) => {
          $('mBar').style.width = `${(done / total) * 100}%`;
          const eta = done ? Math.round(((Date.now() - t0) / done) * (total - done) / 1000) : 0;
          $('mText').textContent = `${done} / ${total} · ${item.name || ''}${eta ? ` · осталось ~${eta} с` : ''}`;
          if (!r.ok) $('mErrors').append(el('div', { textContent: `✕ ${item.name}: ${r.error.message}` }));
        },
      });
      if (signal.aborted) return;
      if (withProjects) {
        const ids = new Set(list.map((c) => c.project_uuid).filter(Boolean));
        // Projects referenced by the exported chats; if none are referenced, all projects.
        const plist = state.projectList.filter((p) => ids.has(p.uuid));
        const toExport = plist.length ? plist : state.projectList;
        $('mText').textContent = `Проекты: 0 / ${toExport.length}`;
        const perr = await CEExport.addProjectsToZip(zip, state.orgId, toExport, {
          signal, onProgress: (d, t, p) => { $('mText').textContent = `Проекты: ${d} / ${t} · ${p.name}`; },
        });
        perr.forEach((e) => $('mErrors').append(el('div', { textContent: `✕ проект ${e.name}: ${e.error}` })));
      }
      $('mText').textContent = 'Упаковка ZIP…';
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
        (m) => { $('mBar').style.width = `${m.percent}%`; });
      await CEExport.downloadBlob(blob, `claude-export_${core.stamp()}.zip`);
      await CEExport.recordExports(ok);
      state.history = await CEExport.getHistory();
      $('mBar').style.width = '100%';
      $('mText').textContent = `Готово: ${ok.length} чатов, ${artifactTotal} артефактов, ${filesTotal} файлов${errors.length ? `, ошибок: ${errors.length} (см. errors.txt в архиве)` : ''}. ${(blob.size / 1048576).toFixed(1)} МБ`;
      $('mCancel').textContent = 'Закрыть';
      await loadTextIndex();
      render();
    } catch (e) {
      if (!signal.aborted) {
        $('mText').textContent = `Ошибка: ${e.message}`;
        $('mCancel').textContent = 'Закрыть';
      }
    }
  }

  // Fetches every conversation into the IndexedDB cache for full-text search.
  async function indexAll() {
    const todo = state.convs.filter((c) => state.textIndex.get(c.uuid)?.updated_at !== c.updated_at);
    if (!todo.length) return toast('Индекс уже актуален');
    const signal = modal(`Индексация ${todo.length} чатов`);
    await CEApi.pool(todo, (c) => CEExport.fetchFull(state.orgId, c, { signal }), {
      concurrency: settings.concurrency, delayMs: settings.delayMs, signal,
      onProgress: (d, t, item, r) => {
        $('mBar').style.width = `${(d / t) * 100}%`;
        $('mText').textContent = `${d} / ${t} · ${item.name || ''}`;
        if (!r.ok) $('mErrors').append(el('div', { textContent: `✕ ${item.name}: ${r.error.message}` }));
      },
    });
    await new Promise((r) => setTimeout(r, 300)); // let pending cache writes finish
    await loadTextIndex();
    $('mText').textContent = 'Индексация завершена';
    $('mCancel').textContent = 'Закрыть';
    $('deep').checked = true;
    render();
  }

  // ---------------------------------------------------------------- wiring
  let qT;
  $('q').addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(render, 150); });
  ['deep', 'fModel', 'fProject', 'fFrom', 'fTo', 'fState'].forEach((id) => $(id).addEventListener('change', render));
  $('resetFilters').onclick = () => {
    $('q').value = ''; $('fModel').value = ''; $('fProject').value = ''; $('fFrom').value = ''; $('fTo').value = ''; $('fState').value = '';
    render();
  };
  $('checkAll').addEventListener('change', (e) => {
    state.visible.forEach((c) => (e.target.checked ? state.selected.add(c.uuid) : state.selected.delete(c.uuid)));
    render();
  });
  document.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key && state.sort.dir === 'desc' ? 'asc' : 'desc' };
    document.querySelectorAll('th[data-sort]').forEach((x) => x.classList.remove('sorted', 'asc', 'desc'));
    th.classList.add('sorted', state.sort.dir);
    render();
  }));
  $('exportSelected').onclick = () => exportMany(state.convs.filter((c) => state.selected.has(c.uuid)));
  $('exportFiltered').onclick = () => exportMany(state.visible);
  $('indexBtn').onclick = indexAll;
  $('reload').onclick = () => loadAll().catch((e) => toast(e.message));
  $('openOptions').onclick = () => chrome.runtime.openOptionsPage();
  $('org').addEventListener('change', async () => {
    state.orgId = $('org').value;
    CEExport.saveSettings({ orgId: state.orgId });
    state.selected.clear();
    loadAll().catch((e) => toast(e.message));
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('q').focus(); $('q').select(); }
    if (e.key === 'Escape' && !$('preview').hidden && $('modal').hidden) $('prevClose').click();
  });

  try {
    await loadOrgs();
    await loadAll();
  } catch (e) {
    $('stats').textContent = '';
    toast(e.message);
  }
})();
