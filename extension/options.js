(async () => {
  const $ = (id) => document.getElementById(id);
  const status = (t, cls = 'ok') => {
    $('status').textContent = t;
    $('status').className = `status ${cls}`;
    setTimeout(() => { if ($('status').textContent === t) $('status').textContent = ''; }, 3000);
  };
  const D = CECore.DEFAULT_SETTINGS;
  const s = await CEExport.loadSettings();

  const keys = Object.keys(D).filter((k) => $(k));
  for (const k of keys) {
    const n = $(k);
    if (n.type === 'checkbox') n.checked = !!s[k];
    else n.value = s[k];
    n.addEventListener('change', save);
    if (n.type === 'text') n.addEventListener('input', updateExample);
  }

  function save() {
    const patch = {};
    for (const k of keys) {
      const n = $(k);
      patch[k] = n.type === 'checkbox' ? n.checked : n.type === 'number' ? Math.max(Number(n.min) || 0, Math.min(Number(n.max) || 1e9, n.value === '' || isNaN(n.value) ? D[k] : Number(n.value))) : n.value;
    }
    if (!patch.filenameTemplate.trim()) patch.filenameTemplate = D.filenameTemplate;
    CEExport.saveSettings(patch).then(() => status('Сохранено'));
    if (patch.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', patch.theme);
    updateExample();
  }

  function updateExample() {
    $('example').textContent = CECore.buildFilename($('filenameTemplate').value, {
      name: 'Разбор архитектуры: API', uuid: '3f2a9c1e-0000-4000-8000-000000000000',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), model: 'claude-opus-5-5',
    }, { projectName: 'Мой проект' }) + '.md';
  }
  updateExample();

  $('detect').onclick = async () => {
    try {
      const id = await CEApi.detectOrgId();
      $('orgId').value = id;
      save();
      status(`Найдено: ${id}`);
    } catch (e) {
      status(e.message, 'err');
    }
  };

  $('backup').onclick = () => {
    chrome.storage.sync.get(null, (sync) => chrome.storage.local.get(null, (local) => {
      const blob = new Blob([JSON.stringify({ app: 'claude-exporter-extended', at: new Date().toISOString(), sync, local }, null, 2)], { type: 'application/json' });
      CEExport.downloadBlob(blob, `claude-exporter-backup_${CECore.stamp()}.json`);
    }));
  };
  $('restore').onchange = async (e) => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (data.app !== 'claude-exporter-extended') throw new Error('Это не резервная копия Claude Exporter Extended');
      await new Promise((r) => chrome.storage.sync.set(data.sync || {}, r));
      await new Promise((r) => chrome.storage.local.set(data.local || {}, r));
      status('Восстановлено, перезагружаю…');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      status(err.message, 'err');
    }
  };
  $('clearCache').onclick = async () => { await CEExport.cache.clear(); status('Кеш очищен'); };
  $('clearHistory').onclick = () => {
    if (confirm('Сбросить историю экспорта? Все чаты снова будут считаться неэкспортированными.')) {
      chrome.storage.local.set({ exportHistory: {} }, () => status('История сброшена'));
    }
  };
})();
