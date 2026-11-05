// Claude.ai web API client. Works from content scripts and from extension pages
// (the extension has host permission for claude.ai, so session cookies are sent).
(function (root) {
  'use strict';

  const BASE = 'https://claude.ai/api';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  // fetch with retry + exponential backoff for 429 / 5xx / network errors
  async function request(path, { as = 'json', retries = 4, signal } = {}) {
    const url = path.startsWith('http') ? path : BASE + path;
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await fetch(url, {
          credentials: 'include',
          headers: { Accept: as === 'json' ? 'application/json' : '*/*' },
          signal,
        });
      } catch (e) {
        if (signal && signal.aborted) throw e;
        if (attempt >= retries) throw new ApiError(`Сетевая ошибка: ${e.message}`, 0);
        await sleep(1000 * 2 ** attempt++);
        continue;
      }
      if (res.ok) {
        if (as === 'json') return res.json();
        if (as === 'blob') return res.blob();
        return res.text();
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(ra > 0 ? ra * 1000 : 1500 * 2 ** attempt++);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new ApiError(`Нет доступа (${res.status}). Войдите в claude.ai в этом браузере (VPN тоже может давать 403).`, res.status);
      }
      throw new ApiError(`HTTP ${res.status} для ${path}`, res.status);
    }
  }

  async function getOrganizations() {
    const orgs = await request('/organizations');
    return (Array.isArray(orgs) ? orgs : []).map((o) => ({
      uuid: o.uuid,
      name: o.name,
      isChat: Array.isArray(o.capabilities) && o.capabilities.includes('chat'),
    }));
  }

  async function detectOrgId() {
    const orgs = await getOrganizations();
    if (!orgs.length) throw new ApiError('Организации не найдены — вы вошли в claude.ai?', 0);
    return (orgs.find((o) => o.isChat) || orgs[0]).uuid;
  }

  // Lists every conversation. The endpoint usually returns the whole list at once;
  // if it starts paginating we keep requesting pages until nothing new comes back.
  async function listConversations(orgId, { signal } = {}) {
    const first = await request(`/organizations/${orgId}/chat_conversations`, { signal });
    const all = Array.isArray(first) ? first : first.data || [];
    const PAGE = all.length;
    if (!PAGE || PAGE % 10 !== 0 || PAGE > 1000) return all; // clearly not a page boundary
    const seen = new Set(all.map((c) => c.uuid));
    for (let offset = PAGE; offset < 100000; offset += PAGE) {
      let page;
      try {
        page = await request(`/organizations/${orgId}/chat_conversations?limit=${PAGE}&offset=${offset}`, { signal });
      } catch {
        break;
      }
      const items = (Array.isArray(page) ? page : page.data || []).filter((c) => !seen.has(c.uuid));
      if (!items.length) break;
      items.forEach((c) => { seen.add(c.uuid); all.push(c); });
      if (items.length < PAGE) break;
    }
    return all;
  }

  function getConversation(orgId, convId, opts) {
    return request(
      `/organizations/${orgId}/chat_conversations/${convId}?tree=True&rendering_mode=messages&render_all_tools=true`,
      opts
    );
  }

  const listProjects = (orgId, opts) => request(`/organizations/${orgId}/projects`, opts);
  const getProject = (orgId, pid, opts) => request(`/organizations/${orgId}/projects/${pid}`, opts);
  const getProjectDocs = (orgId, pid, opts) => request(`/organizations/${orgId}/projects/${pid}/docs`, opts);

  // Downloads a file (image) referenced from a message. Paths from the API are relative.
  function getFileBlob(path, opts) {
    const url = path.startsWith('http') ? path : `https://claude.ai${path}`;
    return request(url, { ...opts, as: 'blob', retries: 2 });
  }

  // Original bytes of an uploaded image / PDF (the /preview and /thumbnail variants are downscaled).
  function getFileContents(orgId, fileUuid, opts) {
    return request(`/organizations/${orgId}/files/${fileUuid}/contents`, { ...opts, as: 'blob', retries: 2 });
  }

  // Files in the conversation's code-execution sandbox ("wiggle"): user uploads in
  // /mnt/user-data/uploads and files Claude produced in /mnt/user-data/outputs.
  // Returns [{path, size, content_type}] or [] if the chat never had a sandbox (404).
  async function listSandboxFiles(orgId, convId, opts) {
    try {
      const r = await request(`/organizations/${orgId}/conversations/${convId}/wiggle/list-files`, { ...opts, retries: 2 });
      const meta = new Map((r.files_metadata || []).map((m) => [m.path, m]));
      return (r.files || []).map((p) => ({ path: p, size: meta.get(p)?.size, content_type: meta.get(p)?.content_type }));
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  function downloadSandboxFile(orgId, convId, path, opts) {
    return request(`/organizations/${orgId}/conversations/${convId}/wiggle/download-file?path=${encodeURIComponent(path)}`,
      { ...opts, as: 'blob', retries: 2 });
  }

  // Runs `worker` over `items` with limited concurrency and an optional delay between starts.
  async function pool(items, worker, { concurrency = 3, delayMs = 250, signal, onProgress } = {}) {
    let next = 0;
    let done = 0;
    const results = new Array(items.length);
    async function lane() {
      while (next < items.length) {
        if (signal && signal.aborted) return;
        const i = next++;
        try {
          results[i] = { ok: true, value: await worker(items[i], i) };
        } catch (e) {
          results[i] = { ok: false, error: e };
        }
        done++;
        if (onProgress) onProgress(done, items.length, items[i], results[i]);
        if (delayMs) await sleep(delayMs);
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
    return results;
  }

  root.CEApi = {
    ApiError, request, getOrganizations, detectOrgId, listConversations, getConversation,
    listProjects, getProject, getProjectDocs, getFileBlob, getFileContents, listSandboxFiles, downloadSandboxFile, pool, sleep,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
