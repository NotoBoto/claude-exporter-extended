(async () => {
  const $ = (id) => document.getElementById(id);
  const status = (t, cls = '') => { $('status').textContent = t; $('status').className = `status ${cls}`; };

  const settings = await CEExport.loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const convId = ((tab && tab.url) || '').match(/^https:\/\/claude\.ai\/chat\/([0-9a-f-]{36})/i)?.[1] || null;

  // Bind quick options to stored settings.
  $('format').value = settings.format;
  const boxes = ['includeThinking', 'includeArtifactsInline', 'extractArtifacts', 'includeTools', 'downloadImages'];
  boxes.forEach((k) => { $(k).checked = !!settings[k]; });
  $('allBranches').checked = settings.branchMode === 'all';
  const persist = () => {
    const patch = { format: $('format').value, branchMode: $('allBranches').checked ? 'all' : 'current' };
    boxes.forEach((k) => { patch[k] = $(k).checked; });
    Object.assign(settings, patch);
    CEExport.saveSettings(patch);
  };
  document.querySelectorAll('select, input').forEach((el) => el.addEventListener('change', persist));

  $('options').onclick = () => chrome.runtime.openOptionsPage();
  $('browse').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('browse.html') });

  let orgId;
  async function org() {
    if (!orgId) orgId = await CEExport.ensureOrgId(settings);
    return orgId;
  }

  if (!convId) {
    $('chatInfo').textContent = 'Текущая вкладка — не чат Claude. Откройте чат на claude.ai или используйте менеджер чатов.';
    $('exportCurrent').disabled = true;
    $('copyCurrent').disabled = true;
  } else {
    try {
      const conv = await CEApi.getConversation(await org(), convId);
      const branches = CECore.countBranches(conv);
      const arts = CECore.collectArtifacts(CECore.getCurrentBranch(conv)).all.length;
      $('chatInfo').innerHTML = '';
      const t = document.createElement('div');
      t.style.cssText = 'font-weight:600;color:var(--fg);margin-bottom:4px';
      t.textContent = conv.name || 'Без названия';
      const m = document.createElement('div');
      m.textContent = `${CECore.formatModelName(CECore.inferModel(conv))} · ${conv.chat_messages.length} сообщ. · веток: ${branches} · артефактов: ${arts}`;
      $('chatInfo').append(t, m);
    } catch (e) {
      $('chatInfo').textContent = `Не удалось загрузить чат: ${e.message}`;
    }
  }

  $('exportCurrent').onclick = async () => {
    persist();
    $('exportCurrent').disabled = true;
    status('Экспорт…');
    try {
      const res = await CEExport.exportSingle(await org(), convId, settings);
      await CEExport.downloadBlob(res.blob, res.filename);
      status(`Готово: ${res.filename}`, 'ok');
    } catch (e) {
      status(`Ошибка: ${e.message}`, 'err');
    } finally {
      $('exportCurrent').disabled = false;
    }
  };

  $('copyCurrent').onclick = async () => {
    try {
      const conv = await CEApi.getConversation(await org(), convId);
      await navigator.clipboard.writeText(CECore.toMarkdown(conv, settings));
      status('Скопировано в буфер обмена', 'ok');
    } catch (e) {
      status(`Ошибка: ${e.message}`, 'err');
    }
  };
})();
