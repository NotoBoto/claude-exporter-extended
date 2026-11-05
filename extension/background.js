// Service worker: context menus, keyboard shortcuts, re-injection after install/update.
const CONTENT_FILES = ['lib/jszip.min.js', 'lib/api.js', 'lib/core.js', 'lib/exporter.js', 'content.js'];

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ce-export', title: 'Экспортировать этот чат', contexts: ['page'], documentUrlPatterns: ['https://claude.ai/chat/*'] });
    chrome.contextMenus.create({ id: 'ce-browse', title: 'Менеджер чатов Claude Exporter', contexts: ['page', 'action'], documentUrlPatterns: ['https://claude.ai/*'] });
  });
  // Make the floating button available in tabs that were open before install.
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  for (const t of tabs) {
    chrome.scripting.insertCSS({ target: { tabId: t.id }, files: ['content.css'] }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: CONTENT_FILES }).catch(() => {});
  }
});

const openBrowser = () => chrome.tabs.create({ url: chrome.runtime.getURL('browse.html') });

async function exportActive(tab) {
  if (!tab || !/^https:\/\/claude\.ai\/chat\//.test(tab.url || '')) return;
  chrome.tabs.sendMessage(tab.id, { action: 'exportCurrent' }).catch(() => {});
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'ce-export') exportActive(tab);
  if (info.menuItemId === 'ce-browse') openBrowser();
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'open-browser') return openBrowser();
  if (cmd === 'export-current') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    exportActive(tab);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.action === 'openBrowser') openBrowser();
  if (msg && msg.action === 'openOptions') chrome.runtime.openOptionsPage();
});
