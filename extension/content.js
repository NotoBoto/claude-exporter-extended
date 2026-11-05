// Content script on claude.ai: floating export button + handler for popup/shortcut exports.
(() => {
  if (window.__ceExtendedLoaded) return;
  window.__ceExtendedLoaded = true;

  const UUID_RE = /\/chat\/([0-9a-f-]{36})/i;
  const currentConvId = () => (location.pathname.match(UUID_RE) || [])[1] || null;

  let toastTimer;
  function toast(text, kind = 'info') {
    let el = document.getElementById('ce-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ce-toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.className = `ce-show ce-${kind}`;
    clearTimeout(toastTimer);
    if (kind !== 'busy') toastTimer = setTimeout(() => (el.className = ''), 4000);
  }

  async function exportCurrent(overrides = {}) {
    const convId = currentConvId();
    if (!convId) return toast('Откройте чат, чтобы экспортировать его', 'error');
    try {
      toast('Экспорт…', 'busy');
      const settings = { ...(await CEExport.loadSettings()), ...overrides };
      const orgId = await CEExport.ensureOrgId(settings);
      if (overrides.copy) {
        const data = await CEApi.getConversation(orgId, convId);
        await navigator.clipboard.writeText(CECore.toMarkdown(data, { ...settings, includeArtifactsInline: true }));
        return toast('Чат скопирован в буфер как Markdown', 'ok');
      }
      const res = await CEExport.exportSingle(orgId, convId, settings);
      await CEExport.downloadBlob(res.blob, res.filename);
      toast(`Сохранено: ${res.filename}${res.artifactCount ? ` (артефактов: ${res.artifactCount})` : ''}`, 'ok');
    } catch (e) {
      console.error('[Claude Exporter Extended]', e);
      toast(`Ошибка: ${e.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------- floating button
  let fab = null;
  function buildFab() {
    fab = document.createElement('div');
    fab.id = 'ce-fab';
    fab.innerHTML = `
      <button class="ce-main" title="Claude Exporter Extended">⤓</button>
      <div class="ce-menu">
        <button data-f="markdown">Markdown</button>
        <button data-f="html">HTML (→ PDF)</button>
        <button data-f="text">Текст</button>
        <button data-f="json">JSON (все ветки)</button>
        <hr>
        <button data-f="markdown" data-branches="all">Markdown — все ветки</button>
        <button data-copy="1">📋 Копировать как Markdown</button>
        <button data-browse="1">📚 Менеджер чатов</button>
      </div>`;
    fab.querySelector('.ce-main').addEventListener('click', () => fab.classList.toggle('ce-open'));
    fab.querySelector('.ce-menu').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      fab.classList.remove('ce-open');
      if (b.dataset.browse) return chrome.runtime.sendMessage({ action: 'openBrowser' });
      const o = {};
      if (b.dataset.f) o.format = b.dataset.f;
      if (b.dataset.branches) o.branchMode = b.dataset.branches;
      if (b.dataset.copy) o.copy = true;
      exportCurrent(o);
    });
    document.addEventListener('click', (e) => { if (fab && !fab.contains(e.target)) fab.classList.remove('ce-open'); });
    document.body.appendChild(fab);
  }

  let showFab = true;
  chrome.storage.sync.get({ showFloatingButton: true }, (s) => { showFab = s.showFloatingButton; sync(); });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.showFloatingButton) { showFab = ch.showFloatingButton.newValue; sync(); }
  });
  function sync() {
    const want = showFab && !!currentConvId();
    if (want && !fab) buildFab();
    if (fab) fab.style.display = want ? '' : 'none';
  }
  // claude.ai is a SPA; watch for URL changes.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; sync(); }
  }, 800);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.action === 'exportCurrent') {
      exportCurrent(msg.overrides || {}).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg && msg.action === 'ping') sendResponse({ ok: true, convId: currentConvId() });
  });
})();
