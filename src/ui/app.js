const state = {
  category: 'unseen',
  collectionId: '',
  items: [],
  index: 0,
  offset: 0,
  total: 0,
  limit: 60,
  busy: false,
};
const byId = (id) => document.getElementById(id);
const mediaGrid = byId('media-grid');

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(result?.error || `Request failed (${response.status}).`);
  return result;
}

function setStatus(message, error = false) {
  byId('status').textContent = message;
  byId('status').classList.toggle('error', error);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function mediaUrl(item) {
  return `/api/media/${encodeURIComponent(item.id)}/content`;
}

function createPreview(item, controls = false) {
  if (item.kind === 'video') {
    const video = element('video');
    video.src = mediaUrl(item);
    video.controls = controls;
    video.preload = controls ? 'metadata' : 'none';
    if (!controls) video.muted = true;
    return video;
  }
  const image = element('img');
  image.src = mediaUrl(item);
  image.alt = item.relative_path;
  image.loading = 'lazy';
  image.onerror = () => {
    const placeholder = element('div', 'Preview unavailable. This file can still be sorted.', 'placeholder');
    image.replaceWith(placeholder);
  };
  return image;
}

function renderCurrent() {
  const container = byId('current-media');
  container.replaceChildren();
  const item = state.items[state.index];
  if (!item) {
    container.append(element('div', state.total ? 'Loading items…' : 'No items in this category.'));
    byId('item-count').textContent = state.total ? `${state.total} items` : '';
    return;
  }
  container.append(createPreview(item, item.kind === 'video'));
  byId('item-count').textContent = `${state.index + 1} of ${state.total}`;
}

function renderGrid() {
  mediaGrid.replaceChildren();
  for (const item of state.items) {
    const card = element('article', undefined, 'media-card');
    const select = element('button', item.relative_path);
    select.type = 'button';
    select.className = 'quiet media-name';
    select.addEventListener('click', () => {
      state.index = state.items.indexOf(item);
      renderCurrent();
    });
    card.append(createPreview(item), select, element('small', `${item.kind} · ${formatBytes(item.size)}${item.category ? ` · ${item.category}` : ''}`, 'media-name'));
    mediaGrid.append(card);
  }
  byId('load-more').classList.toggle('hidden', state.items.length >= state.total);
  renderCurrent();
}

async function loadMedia({ append = false } = {}) {
  if (!state.collectionId) {
    state.items = [];
    state.total = 0;
    renderGrid();
    return;
  }
  const offset = append ? state.offset : 0;
  const data = await request(`/api/media?collectionId=${encodeURIComponent(state.collectionId)}&category=${state.category}&offset=${offset}&limit=${state.limit}`);
  state.items = append ? [...state.items, ...data.items] : data.items;
  state.offset = state.items.length;
  state.total = data.total;
  state.index = Math.min(state.index, Math.max(0, state.items.length - 1));
  byId('collection-title').textContent = `${state.category[0].toUpperCase()}${state.category.slice(1)} items`;
  renderGrid();
}

async function loadCollections(preferredId) {
  const result = await request('/api/collections');
  const select = byId('collection');
  select.replaceChildren();
  for (const collection of result.collections) {
    const option = element('option', `${collection.name} (${collection.item_count})`);
    option.value = collection.id;
    select.append(option);
  }
  if (!result.collections.length) {
    state.collectionId = '';
    setStatus('Create a collection, then choose a folder from the host desktop app.');
    await loadMedia();
    return;
  }
  state.collectionId = preferredId && result.collections.some((item) => item.id === preferredId)
    ? preferredId : (select.value || result.collections[0].id);
  select.value = state.collectionId;
  const collection = result.collections.find((item) => item.id === state.collectionId);
  setStatus(collection.offline_roots ? `${collection.offline_roots} root(s) are currently offline.` : '');
  await loadMedia();
}

function showApp() {
  byId('auth-panel').classList.add('hidden');
  byId('app-panel').classList.remove('hidden');
  byId('logout').classList.remove('hidden');
  byId('add-root').classList.toggle('hidden', !window.photoSorter?.isDesktop);
  refreshNetwork();
  loadCollections().catch((error) => setStatus(error.message, true));
}

async function refreshNetwork() {
  try {
    const { addresses } = await request('/api/network');
    const container = byId('lan-addresses');
    container.replaceChildren();
    if (!addresses.length) {
      container.append(element('span', 'No LAN IPv4 address is currently available.'));
      return;
    }
    for (const address of addresses) {
      const link = element('a', `${address.name}: ${address.url}`);
      link.href = address.url;
      container.append(link);
    }
  } catch {}
}

async function showAuthentication() {
  const { setupComplete } = await request('/api/setup-status');
  const desktop = Boolean(window.photoSorter?.isDesktop);
  if (!setupComplete && !desktop) {
    byId('auth-panel').classList.remove('hidden');
    byId('auth-title').textContent = 'Waiting for host setup';
    byId('auth-description').textContent = 'The host desktop app must set the account password before other devices can connect.';
    byId('auth-form').classList.add('hidden');
    return;
  }
  byId('auth-form').classList.remove('hidden');
  byId('auth-panel').classList.remove('hidden');
  byId('auth-title').textContent = setupComplete ? 'Log in' : 'Create your password';
  byId('auth-description').textContent = setupComplete
    ? 'Your session ends when the host service restarts.'
    : 'Use at least 12 characters. This password protects access to your local library.';
  byId('auth-submit').textContent = setupComplete ? 'Log in' : 'Set password';
  byId('password').autocomplete = setupComplete ? 'current-password' : 'new-password';
  byId('auth-form').onsubmit = async (event) => {
    event.preventDefault();
    byId('auth-error').textContent = '';
    const password = byId('password').value;
    try {
      await request(setupComplete ? '/api/login' : '/api/setup', {
        method: 'POST', body: JSON.stringify({ password }),
      });
      byId('password').value = '';
      showApp();
    } catch (error) {
      byId('auth-error').textContent = error.message;
    }
  };
}

async function decide(category, item = state.items[state.index]) {
  if (!item || state.busy) return;
  state.busy = true;
  try {
    await request(`/api/media/${encodeURIComponent(item.id)}/decision`, {
      method: 'PUT', body: JSON.stringify({ category }),
    });
    setStatus(`Saved ${category === 'unseen' ? 'unseen' : category} decision.`);
    state.items = state.items.filter((candidate) => candidate.id !== item.id || state.category === category);
    if (state.category !== category) {
      state.total = Math.max(0, state.total - 1);
      state.index = Math.min(state.index, Math.max(0, state.items.length - 1));
      if (state.items.length < state.limit && state.items.length < state.total) {
        await loadMedia();
      } else renderGrid();
    } else {
      const index = state.items.findIndex((candidate) => candidate.id === item.id);
      if (index >= 0) state.index = index;
      renderGrid();
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    state.busy = false;
  }
}

function showDialog(title, lines, { allowReuse = false, confirmLabel = 'Confirm' } = {}) {
  const dialog = byId('confirm-dialog');
  byId('dialog-title').textContent = title;
  const content = byId('dialog-content');
  content.replaceChildren();
  for (const line of lines) content.append(element('p', line));
  let reuseCheckbox;
  if (allowReuse) {
    const label = element('label', 'I reviewed the existing folders and explicitly approve reusing them.');
    reuseCheckbox = element('input');
    reuseCheckbox.type = 'checkbox';
    label.prepend(reuseCheckbox);
    content.append(label);
  }
  const confirm = byId('dialog-confirm');
  confirm.textContent = confirmLabel;
  confirm.disabled = Boolean(allowReuse);
  if (reuseCheckbox) reuseCheckbox.addEventListener('change', () => { confirm.disabled = !reuseCheckbox.checked; });
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve({
      confirmed: dialog.returnValue === 'confirm',
      reuseOutputFolders: Boolean(reuseCheckbox?.checked),
    }), { once: true });
  });
}

async function applyDecisions() {
  if (!state.collectionId) return;
  try {
    const plan = await request('/api/apply/plan', {
      method: 'POST', body: JSON.stringify({ collectionId: state.collectionId }),
    });
    if (!plan.moveCount) {
      setStatus('There are no delete/unsure moves to apply.');
      return;
    }
    const examples = plan.examples.map((item) => `${item.source} → ${item.destination}`);
    const lines = [
      `This will move ${plan.moveCount} file(s). ${plan.readOnlySkipped} item(s) on read-only roots will be skipped.`,
      ...examples,
      ...(plan.moveCount > examples.length ? [`And ${plan.moveCount - examples.length} more…`] : []),
      'No file will be permanently deleted. A failure stops the batch.',
      ...(plan.requiresOutputFolderConsent ? ['Existing deleted/unsure folder(s) are not marked as app-owned; inspect and approve reuse to continue.'] : []),
    ];
    const choice = await showDialog('Review file moves', lines, {
      allowReuse: plan.requiresOutputFolderConsent,
      confirmLabel: 'Apply these moves',
    });
    if (!choice.confirmed) return;
    const result = await request('/api/apply/confirm', {
      method: 'POST',
      body: JSON.stringify({ planId: plan.id, confirm: true, reuseOutputFolders: choice.reuseOutputFolders }),
    });
    const moved = result.results.filter((item) => item.status === 'moved').length;
    setStatus(result.stoppedOnFailure
      ? `Stopped after moving ${moved} file(s). Failure: ${result.results.at(-1)?.error}`
      : `Moved ${moved} file(s). Batch ${result.batchId} can be restored.`);
    await loadMedia();
  } catch (error) {
    setStatus(error.message, true);
  }
}

byId('new-collection-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const name = byId('collection-name').value;
    const { id } = await request('/api/collections', { method: 'POST', body: JSON.stringify({ name }) });
    byId('collection-name').value = '';
    await loadCollections(id);
  } catch (error) { setStatus(error.message, true); }
});

byId('collection').addEventListener('change', async (event) => {
  state.collectionId = event.target.value;
  await loadMedia();
});
byId('add-root').addEventListener('click', async () => {
  try {
    const result = await window.photoSorter.chooseRoot(state.collectionId);
    if (!result.canceled) {
      setStatus('Folder scanned. New media is available.');
      await loadCollections(state.collectionId);
    }
  } catch (error) { setStatus(error.message, true); }
});
byId('filters').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  state.category = button.dataset.category;
  state.index = 0;
  for (const candidate of byId('filters').querySelectorAll('button')) {
    candidate.setAttribute('aria-pressed', String(candidate === button));
  }
  await loadMedia();
});
byId('previous').addEventListener('click', () => {
  if (state.index > 0) { state.index -= 1; renderCurrent(); }
});
byId('next').addEventListener('click', () => {
  if (state.index + 1 < state.items.length) { state.index += 1; renderCurrent(); }
});
document.querySelectorAll('[data-decision]').forEach((button) => {
  button.addEventListener('click', () => decide(button.dataset.decision));
});
byId('load-more').addEventListener('click', () => loadMedia({ append: true }).catch((error) => setStatus(error.message, true)));
byId('apply').addEventListener('click', applyDecisions);
byId('restore').addEventListener('click', async () => {
  const choice = await showDialog('Restore latest apply', ['Move successfully applied files back to their original paths. Occupied paths will be reported and never overwritten.'], { confirmLabel: 'Restore batch' });
  if (!choice.confirmed) return;
  try {
    const result = await request('/api/restore', { method: 'POST', body: '{}' });
    setStatus(`Restore finished with ${result.results.filter((item) => item.status === 'restored').length} restored and ${result.results.filter((item) => item.status === 'conflict').length} conflict(s).`);
    await loadMedia();
  } catch (error) { setStatus(error.message, true); }
});
byId('rescan').addEventListener('click', async () => {
  try {
    const result = await request('/api/rescan', { method: 'POST', body: JSON.stringify({ collectionId: state.collectionId }) });
    setStatus(`Rescan complete: ${result.indexed} media item(s) indexed.`);
    await loadCollections(state.collectionId);
  } catch (error) { setStatus(error.message, true); }
});
byId('audit').addEventListener('click', async () => {
  try {
    const { events } = await request('/api/audit');
    const list = byId('audit-list');
    list.replaceChildren();
    for (const event of events) {
      const details = element('pre', JSON.stringify(event.details));
      const entry = element('li', `${event.created_at} · ${event.action}`);
      entry.append(details);
      list.append(entry);
    }
    byId('audit-panel').classList.toggle('hidden');
  } catch (error) { setStatus(error.message, true); }
});
byId('logout').addEventListener('click', async () => {
  await request('/api/logout', { method: 'POST', body: '{}' });
  byId('app-panel').classList.add('hidden');
  byId('logout').classList.add('hidden');
  await showAuthentication();
});
document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea, select') || byId('app-panel').classList.contains('hidden')) return;
  if (event.key === 'ArrowLeft') decide('delete');
  if (event.key === 'ArrowRight') decide('keep');
  if (event.key === 'ArrowDown') decide('unsure');
  if (event.key === 'ArrowUp' && state.index > 0) { state.index -= 1; renderCurrent(); }
});
let touchStart;
byId('current-media').addEventListener('touchstart', (event) => {
  touchStart = { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
}, { passive: true });
byId('current-media').addEventListener('touchend', (event) => {
  if (!touchStart) return;
  const dx = event.changedTouches[0].clientX - touchStart.x;
  const dy = event.changedTouches[0].clientY - touchStart.y;
  if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy)) decide(dx < 0 ? 'delete' : 'keep');
  else if (dy > 65) decide('unsure');
  touchStart = null;
}, { passive: true });

request('/api/setup-status').then(showAuthentication).catch((error) => {
  byId('auth-panel').classList.remove('hidden');
  byId('auth-title').textContent = 'Cannot reach the local host';
  byId('auth-description').textContent = error.message;
});
