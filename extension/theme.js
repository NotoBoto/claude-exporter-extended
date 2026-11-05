// Applies the theme preference (auto | light | dark) to extension pages.
chrome.storage.sync.get({ theme: 'auto' }, ({ theme }) => {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
});
