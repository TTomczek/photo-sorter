const state = {
  category: 'unseen',
  sort: 'capture-asc',
  defaultSort: 'capture-asc',
  collectionId: '',
  items: [],
  index: 0,
  offset: 0,
  total: 0,
  limit: 60,
  busy: false,
  lockedItemId: '',
  lockReady: false,
  lockTransition: Promise.resolve(),
  restoreMediaId: '',
  zoomScale: 1,
  panX: 0,
  panY: 0,
  pointers: new Map(),
  pinchDistance: 0,
  pinchScale: 1,
  lastPointer: null,
  gridTargetIndex: null,
  restoreGridScroll: false,
  mediaRequestId: 0,
};
const byId = (id) => document.getElementById(id);
const mediaGrid = byId('media-grid');
const mediaViewport = byId('media-viewport');
const developmentMode = Boolean(window.photoSorter?.isDesktop
  && new URLSearchParams(window.location.search).get('dev') === '1');
const videoPosterObserver = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    videoPosterObserver.unobserve(entry.target);
    loadVideoPoster(entry.target).catch((error) => {
      setStatus(error.message, true);
      if (entry.target.isConnected) showVideoUnavailable(entry.target);
    });
  }
}, { rootMargin: '160px' });
let stateSaveTimer;
let scanPollTimer;
let scanPollBusy = false;
let queuePollTimer;
let queuePollBusy = false;
let queueEvents;
let queueEventRefreshTimer;
let pendingInstallPrompt;
let activePreviewJobs = 0;
const previewQueue = [];
const previewJobs = new Map();

function applyVisualPreferences() {
  const theme = localStorage.getItem('photo-sorter-theme');
  const gridColumns = localStorage.getItem('photo-sorter-grid-columns');
  const validTheme = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
  const validColumns = ['auto', '2', '3', '4', '5', '6'].includes(gridColumns) ? gridColumns : 'auto';
  document.documentElement.dataset.theme = validTheme;
  document.documentElement.dataset.gridColumns = validColumns;
  byId('theme').value = validTheme;
  byId('grid-columns').value = validColumns;
}

function setZoom(scale) {
  state.zoomScale = Math.min(4, Math.max(1, scale));
  if (state.zoomScale === 1) {
    state.panX = 0;
    state.panY = 0;
  }
  const image = byId('current-media').querySelector('img');
  if (!image) return;
  image.classList.toggle('zoomable', state.zoomScale > 1);
  image.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoomScale})`;
}

function resetZoom() {
  state.zoomScale = 1;
  state.panX = 0;
  state.panY = 0;
  state.pointers.clear();
  state.lastPointer = null;
  setZoom(1);
}

function pointerDistance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function clampPan() {
  const container = byId('current-media');
  const limitX = container.clientWidth * (state.zoomScale - 1) / 2;
  const limitY = container.clientHeight * (state.zoomScale - 1) / 2;
  state.panX = Math.min(limitX, Math.max(-limitX, state.panX));
  state.panY = Math.min(limitY, Math.max(-limitY, state.panY));
}

function gridMetrics() {
  const style = getComputedStyle(mediaGrid);
  const columns = style.gridTemplateColumns.split(/\s+/).filter(Boolean).length || 1;
  const rowHeight = Number.parseFloat(style.gridAutoRows) || 190;
  const rowGap = Number.parseFloat(style.rowGap) || 12;
  return { columns, rowHeight: rowHeight + rowGap };
}

function alignGridToSelection() {
  const { columns, rowHeight } = gridMetrics();
  mediaViewport.scrollTop = Math.floor((state.offset + state.index) / columns) * rowHeight;
}

function showVideoUnavailable(video) {
  video.replaceWith(element('div', 'Video preview unavailable. This file can still be sorted.', 'placeholder'));
}

async function loadVideoPoster(video) {
  if (!video.isConnected) return;
  const item = {
    id: video.dataset.mediaId,
    size: Number(video.dataset.mediaSize),
    modified_at: Number(video.dataset.mediaModified),
  };
  const previewUrl = `/api/media/${encodeURIComponent(item.id)}/preview`;
  const cached = await fetch(previewUrl);
  if (cached.ok) {
    const posterUrl = URL.createObjectURL(await cached.blob());
    video.dataset.posterObjectUrl = posterUrl;
    video.poster = posterUrl;
    return;
  }
  if (cached.status !== 404) throw new Error(`Video poster request failed (${cached.status}).`);
  video.addEventListener('loadeddata', () => {
    if (!video.videoWidth || !video.videoHeight) return;
    enqueuePreviewJob(async () => {
      const scale = Math.min(1, 640 / video.videoWidth, 640 / video.videoHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Video poster generation is unavailable in this browser.');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const poster = await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('The browser could not encode this video poster.'));
        }, 'image/jpeg', 0.82);
      });
      const result = await cachePreviewBlob(item, poster);
      if (!video.isConnected) {
        if (result.objectUrl) URL.revokeObjectURL(result.src);
        return;
      }
      if (result.objectUrl) video.dataset.posterObjectUrl = result.src;
      video.poster = result.src;
      video.removeAttribute('src');
      video.load();
    }).catch((error) => {
      setStatus(error.message, true);
      if (video.isConnected) showVideoUnavailable(video);
    });
  }, { once: true });
  video.addEventListener('error', () => showVideoUnavailable(video), { once: true });
  video.preload = 'metadata';
  video.src = video.dataset.posterSource;
  video.load();
}

function setDecisionButtons(enabled) {
  for (const button of document.querySelectorAll('[data-decision]')) {
    button.disabled = !enabled;
  }
}

async function refreshScans() {
  if (!state.collectionId || scanPollBusy || byId('app-panel').classList.contains('hidden')) return;
  scanPollBusy = true;
  try {
    const { scans } = await request(`/api/scans?collectionId=${encodeURIComponent(state.collectionId)}`);
    const active = scans.filter((scan) => ['queued', 'running'].includes(scan.status));
    if (active.length) {
      const indexed = active.reduce((sum, scan) => sum + scan.indexed, 0);
      setStatus(`Scanning ${active.length} folder(s); ${indexed} media item(s) indexed so far.`);
      const current = state.items[state.index];
      state.restoreMediaId = current?.id || '';
      await loadMedia();
    } else if (scans.some((scan) => scan.status === 'failed')) {
      const failed = scans.filter((scan) => scan.status === 'failed');
      setStatus(`${failed.length} folder scan(s) failed: ${failed[0].error}`, true);
    } else if (scans.some((scan) => scan.status === 'completed')) {
      const indexed = scans.reduce((sum, scan) => sum + scan.indexed, 0);
      setStatus(`Scanning complete: ${indexed} media item(s) indexed.`);
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    scanPollBusy = false;
  }
}

function saveDeviceState() {
  if (!state.collectionId) return;
  clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(() => {
    const item = state.items[state.index];
    request('/api/device-state', {
      method: 'PUT',
      body: JSON.stringify({
        collectionId: state.collectionId,
        category: state.category,
        sort: state.sort,
        mediaId: item?.id || null,
        offset: state.offset,
      }),
    }).catch((error) => setStatus(error.message, true));
  }, 200);
}

function updateItemLock(item) {
  if (item?.id === state.lockedItemId) return;
  const previousId = state.lockedItemId;
  state.lockedItemId = item?.id || '';
  state.lockReady = false;
  setDecisionButtons(false);
  state.lockTransition = state.lockTransition.then(async () => {
    if (previousId) {
      await request(`/api/media/${encodeURIComponent(previousId)}/lock`, { method: 'DELETE' }).catch(() => {});
    }
    if (!item) return;
    try {
      await request(`/api/media/${encodeURIComponent(item.id)}/lock`, { method: 'POST' });
      if (state.lockedItemId !== item.id) {
        await request(`/api/media/${encodeURIComponent(item.id)}/lock`, { method: 'DELETE' }).catch(() => {});
        return;
      }
      state.lockReady = true;
      setDecisionButtons(true);
    } catch (error) {
      setStatus(error.message, true);
    }
  });
}

function runPreviewQueue() {
  while (activePreviewJobs < 2 && previewQueue.length) {
    const task = previewQueue.shift();
    activePreviewJobs += 1;
    Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => {
      activePreviewJobs -= 1;
      runPreviewQueue();
    });
  }
}

function enqueuePreviewJob(job) {
  const promise = new Promise((resolve, reject) => {
    previewQueue.push({ run: job, resolve, reject });
  });
  runPreviewQueue();
  return promise;
}

async function cachePreviewBlob(item, preview) {
  const version = `${item.size}:${item.modified_at}`;
  const previewUrl = `/api/media/${encodeURIComponent(item.id)}/preview`;
  const upload = await fetch(previewUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'If-Match': version },
    body: preview,
  });
  const result = upload.headers.get('content-type')?.includes('application/json')
    ? await upload.json() : null;
  if (!upload.ok) throw new Error(result?.error || `Preview save failed (${upload.status}).`);
  if (!result) throw new Error('The host returned an invalid preview response.');
  if (result.stored) return { src: previewUrl };
  return { src: URL.createObjectURL(preview), objectUrl: true };
}

function generateImagePreview(item) {
  const version = `${item.size}:${item.modified_at}`;
  const key = `${item.id}:${version}`;
  if (previewJobs.has(key)) return previewJobs.get(key);
  const promise = enqueuePreviewJob(async () => {
    const sourceResponse = await fetch(mediaUrl(item));
    if (!sourceResponse.ok) throw new Error(`Image request failed (${sourceResponse.status}).`);
    const bitmap = await createImageBitmap(await sourceResponse.blob());
    const scale = Math.min(1, 640 / bitmap.width, 640 / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      throw new Error('Image preview generation is unavailable in this browser.');
    }
    let preview;
    try {
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      preview = await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('The browser could not encode this image preview.'));
        }, 'image/jpeg', 0.82);
      });
    } finally {
      bitmap.close();
    }
    return cachePreviewBlob(item, preview);
  });
  previewJobs.set(key, promise);
  promise.then(() => previewJobs.delete(key), () => previewJobs.delete(key));
  return promise;
}

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

function auditFieldLabel(key) {
  const labels = {
    batchId: 'Batch ID',
    collectionId: 'Collection ID',
    credentialId: 'Credential ID',
    mediaId: 'Media ID',
    readOnly: 'Read only',
    retryInMs: 'Retry in ms',
    rootId: 'Root ID',
  };
  return labels[key] || key.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());
}

function appendLazyJson(disclosure, value) {
  disclosure.addEventListener('toggle', () => {
    if (!disclosure.open || disclosure.dataset.loaded) return;
    disclosure.append(element('pre', JSON.stringify(value, null, 2)));
    disclosure.dataset.loaded = 'true';
  });
}

function renderAuditDetails(details) {
  const content = element('div', undefined, 'audit-details');
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    content.append(element('p', String(details ?? '')));
    return content;
  }

  const fields = element('dl', undefined, 'audit-fields');
  for (const [key, value] of Object.entries(details)) {
    const term = element('dt', auditFieldLabel(key));
    const description = element('dd');
    if (value && typeof value === 'object') {
      const disclosure = element('details', undefined, 'audit-nested-details');
      const count = Array.isArray(value) ? ` (${value.length})` : '';
      disclosure.append(element('summary', `${auditFieldLabel(key)}${count}`));
      appendLazyJson(disclosure, value);
      description.append(disclosure);
    } else {
      description.textContent = value === null ? 'None' : String(value);
    }
    fields.append(term, description);
  }
  content.append(fields);

  const raw = element('details', undefined, 'audit-raw-details');
  raw.append(element('summary', 'Raw JSON'));
  appendLazyJson(raw, details);
  content.append(raw);
  return content;
}

function renderAuditEvents(events) {
  const list = byId('audit-list');
  list.replaceChildren();
  for (const event of events) {
    const entry = element('li', undefined, 'audit-entry');
    entry.append(element('p', `${event.created_at} · ${event.action}`, 'audit-heading'));
    entry.append(renderAuditDetails(event.details));
    list.append(entry);
  }
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function mediaUrl(item) {
  return `/api/media/${encodeURIComponent(item.id)}/content`;
}

function createPreview(item, controls = false, cached = false) {
  if (item.kind === 'video') {
    const video = element('video');
    video.controls = controls;
    if (controls) {
      video.src = mediaUrl(item);
      video.preload = 'metadata';
    } else {
      video.muted = true;
      video.dataset.posterSource = mediaUrl(item);
      video.dataset.mediaId = item.id;
      video.dataset.mediaSize = String(item.size);
      video.dataset.mediaModified = String(item.modified_at);
      if (videoPosterObserver) videoPosterObserver.observe(video);
      else loadVideoPoster(video).catch((error) => {
        setStatus(error.message, true);
        if (video.isConnected) showVideoUnavailable(video);
      });
    }
    return video;
  }
  const image = element('img');
  image.src = cached ? `/api/media/${encodeURIComponent(item.id)}/preview` : mediaUrl(item);
  image.alt = item.relative_path;
  image.loading = 'lazy';
  image.onerror = () => {
    if (cached) {
      cached = false;
      generateImagePreview(item).then(({ src, objectUrl }) => {
        if (!image.isConnected) {
          if (objectUrl) URL.revokeObjectURL(src);
          return;
        }
        if (objectUrl) {
          const release = () => URL.revokeObjectURL(src);
          image.addEventListener('load', release, { once: true });
          image.addEventListener('error', release, { once: true });
        }
        image.src = src;
      }).catch((error) => {
        setStatus(error.message, true);
        image.src = mediaUrl(item);
      });
      return;
    }
    const placeholder = element('div', 'Preview unavailable. This file can still be sorted.', 'placeholder');
    image.replaceWith(placeholder);
  };
  return image;
}

function renderCurrent() {
  const container = byId('current-media');
  resetZoom();
  container.replaceChildren();
  byId('zoom-controls').classList.add('hidden');
  const item = state.items[state.index];
  if (!item) {
    container.append(element('div', state.total ? 'Loading items…'
      : state.category === 'all' ? 'No items in this collection.' : 'No items in this category.'));
    byId('item-count').textContent = state.total ? `${state.total} items` : '';
    updateItemLock(null);
    saveDeviceState();
    return;
  }
  container.append(createPreview(item, item.kind === 'video'));
  if (item.kind === 'image') byId('zoom-controls').classList.remove('hidden');
  byId('item-count').textContent = `${state.offset + state.index + 1} of ${state.total}`;
  updateItemLock(item);
  saveDeviceState();
}

function renderGrid() {
  for (const video of mediaGrid.querySelectorAll('video')) {
    videoPosterObserver?.unobserve(video);
    if (video.dataset.posterObjectUrl) URL.revokeObjectURL(video.dataset.posterObjectUrl);
  }
  mediaGrid.replaceChildren();
  const { columns, rowHeight } = gridMetrics();
  byId('media-virtual-space').style.height = `${Math.ceil(state.total / columns) * rowHeight}px`;
  mediaGrid.style.top = `${Math.floor(state.offset / columns) * rowHeight}px`;
  for (const item of state.items) {
    const card = element('article', undefined, 'media-card');
    const select = element('button', item.relative_path);
    select.setAttribute('translate', 'no');
    select.type = 'button';
    select.className = 'quiet media-name';
    select.addEventListener('click', () => {
      state.index = state.items.indexOf(item);
      renderCurrent();
    });
    if (mediaGrid.childElementCount === 0 && state.offset % columns) {
      card.style.gridColumnStart = String(state.offset % columns + 1);
    }
    card.append(createPreview(item, false, item.kind === 'image'), select, element('small', `${item.kind} · ${formatBytes(item.size)}${item.category ? ` · ${item.category}` : ''}`, 'media-name'));
    mediaGrid.append(card);
  }
  if (state.restoreGridScroll) {
    mediaViewport.scrollTop = Math.floor((state.offset + state.index) / columns) * rowHeight;
    state.restoreGridScroll = false;
  }
  renderCurrent();
}

async function loadMedia() {
  const requestId = ++state.mediaRequestId;
  if (!state.collectionId) {
    state.items = [];
    state.total = 0;
    renderGrid();
    return;
  }
  const data = await request(`/api/media?collectionId=${encodeURIComponent(state.collectionId)}&category=${state.category}&sort=${state.sort}&offset=${state.offset}&limit=${state.limit}`);
  if (requestId !== state.mediaRequestId) return;
  state.items = data.items;
  state.total = data.total;
  if (!state.items.length && state.offset > 0 && state.offset >= state.total) {
    state.offset = Math.max(0, Math.floor(Math.max(0, state.total - 1) / state.limit) * state.limit);
    state.gridTargetIndex = Math.max(0, state.total - state.offset - 1);
    return loadMedia();
  }
  const restoredIndex = state.gridTargetIndex !== null
    ? state.gridTargetIndex : state.restoreMediaId
    ? state.items.findIndex((item) => item.id === state.restoreMediaId) : -1;
  state.index = restoredIndex >= 0 ? restoredIndex : Math.min(state.index, Math.max(0, state.items.length - 1));
  state.gridTargetIndex = null;
  state.restoreMediaId = '';
  byId('collection-title').textContent = state.category === 'all'
    ? 'All items' : `${state.category[0].toUpperCase()}${state.category.slice(1)} items`;
  renderGrid();
}

function handleGridScroll() {
  if (!state.total || state.busy) return;
  const { columns, rowHeight } = gridMetrics();
  const rowStart = Math.floor(mediaViewport.scrollTop / rowHeight) * columns;
  const firstVisibleIndex = state.offset > rowStart && state.offset < rowStart + columns
    ? state.offset : rowStart;
  const lastVisibleIndex = Math.min(
    state.total - 1,
    Math.floor((mediaViewport.scrollTop + mediaViewport.clientHeight) / rowHeight) * columns,
  );
  const pageOffset = Math.floor(Math.max(firstVisibleIndex, lastVisibleIndex) / state.limit) * state.limit;
  if (pageOffset === state.offset) return;
  const previousOffset = state.offset;
  state.offset = pageOffset;
  state.gridTargetIndex = Math.max(0, firstVisibleIndex - pageOffset);
  state.restoreMediaId = '';
  loadMedia().catch((error) => {
    if (state.offset === pageOffset) {
      state.offset = previousOffset;
      state.gridTargetIndex = null;
    }
    setStatus(error.message, true);
  });
}

function moveSelection(direction) {
  const absoluteIndex = state.offset + state.index + direction;
  if (absoluteIndex < 0 || absoluteIndex >= state.total) return;
  const pageOffset = Math.floor(absoluteIndex / state.limit) * state.limit;
  const index = absoluteIndex - pageOffset;
  if (pageOffset !== state.offset) {
    const previousOffset = state.offset;
    state.offset = pageOffset;
    state.gridTargetIndex = index;
    state.restoreMediaId = '';
    loadMedia().catch((error) => {
      if (state.offset === pageOffset) {
        state.offset = previousOffset;
        state.gridTargetIndex = null;
      }
      setStatus(error.message, true);
    });
    return;
  }
  state.index = index;
  renderCurrent();
}

async function refreshQueue() {
  if (!state.collectionId || queuePollBusy || state.busy
    || byId('app-panel').classList.contains('hidden')) return;
  queuePollBusy = true;
  const snapshot = {
    collectionId: state.collectionId,
    category: state.category,
    sort: state.sort,
    offset: state.offset,
  };
  try {
    const result = await request(`/api/media?collectionId=${encodeURIComponent(snapshot.collectionId)}&category=${snapshot.category}&sort=${snapshot.sort}&offset=${snapshot.offset}&limit=${state.limit}`);
    if (snapshot.collectionId !== state.collectionId || snapshot.category !== state.category
      || snapshot.sort !== state.sort || snapshot.offset !== state.offset) return;
    const unchanged = result.total === state.total
      && result.items.length === state.items.length
      && result.items.every((item, index) => item.id === state.items[index].id
        && item.category === state.items[index].category
        && item.size === state.items[index].size
        && item.modified_at === state.items[index].modified_at);
    if (unchanged) return;
    const currentId = state.items[state.index]?.id;
    state.items = result.items;
    state.total = result.total;
    const currentIndex = currentId ? state.items.findIndex((item) => item.id === currentId) : -1;
    state.index = currentIndex >= 0 ? currentIndex : Math.min(state.index, Math.max(0, state.items.length - 1));
    if (!state.items.length && state.offset > 0) {
      state.offset = Math.max(0, Math.floor(Math.max(0, state.total - 1) / state.limit) * state.limit);
      await loadMedia();
    } else {
      renderGrid();
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    queuePollBusy = false;
  }
}

async function loadCollections(preferredId) {
  byId('add-root').disabled = true;
  const result = await request('/api/collections');
  const preferences = await request('/api/preferences');
  const lastUsed = preferredId || preferences.lastCollectionId;
  const select = byId('collection');
  select.replaceChildren();
  for (const collection of result.collections) {
    const option = element('option', `${collection.name} (${collection.item_count})`);
    option.value = collection.id;
    option.setAttribute('translate', 'no');
    select.append(option);
  }
  if (!result.collections.length) {
    state.collectionId = '';
    byId('archive-collection').disabled = true;
    byId('root-list').replaceChildren();
    setStatus('Create a collection, then choose a folder from the host desktop app.');
    await loadMedia();
    await loadArchivedCollections();
    return;
  }
  state.collectionId = lastUsed && result.collections.some((item) => item.id === lastUsed)
    ? lastUsed : result.collections[0].id;
  state.offset = 0;
  state.index = 0;
  select.value = state.collectionId;
  byId('add-root').disabled = !result.collections.some((item) => item.id === state.collectionId);
  byId('archive-collection').disabled = false;
  await request('/api/preferences', {
    method: 'PUT', body: JSON.stringify({ lastCollectionId: state.collectionId }),
  });
  const saved = await request(`/api/device-state?collectionId=${encodeURIComponent(state.collectionId)}`);
  if (saved.state) {
    state.category = saved.state.category;
    state.sort = saved.state.sort;
    state.offset = saved.state.offset;
    state.restoreGridScroll = true;
    state.restoreMediaId = saved.state.mediaId || '';
    byId('sort-order').value = state.sort;
    for (const button of byId('filters').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.category === state.category));
    }
  } else {
    state.category = 'unseen';
    state.sort = state.defaultSort;
    state.offset = 0;
    state.restoreGridScroll = true;
    state.restoreMediaId = '';
    byId('sort-order').value = state.sort;
    for (const button of byId('filters').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.category === state.category));
    }
  }
  const collection = result.collections.find((item) => item.id === state.collectionId);
  setStatus(collection.offline_roots ? `${collection.offline_roots} root(s) are currently offline.` : '');
  await Promise.all([loadRootManagement(), loadArchivedCollections()]);
  await loadMedia();
}

function showApp() {
  byId('auth-panel').classList.add('hidden');
  byId('app-panel').classList.remove('hidden');
  byId('logout').classList.remove('hidden');
  byId('add-root').classList.toggle('hidden', !window.photoSorter?.isDesktop);
  refreshNetwork();
  loadSettings().then(() => loadCollections()).catch((error) => setStatus(error.message, true));
  loadPasskeys().catch((error) => setStatus(error.message, true));
  refreshScans();
  if (!scanPollTimer) scanPollTimer = setInterval(refreshScans, 1500);
  if (!queuePollTimer) queuePollTimer = setInterval(refreshQueue, 5000);
  if (!queueEvents && 'EventSource' in window) {
    queueEvents = new EventSource('/api/events');
    queueEvents.addEventListener('queue', (event) => {
      const change = JSON.parse(event.data);
      if (!change.collectionId || change.collectionId === state.collectionId) {
        clearTimeout(queueEventRefreshTimer);
        queueEventRefreshTimer = setTimeout(refreshQueue, 100);
      }
    });
    queueEvents.addEventListener('auth-expired', () => {
      queueEvents.close();
      queueEvents = null;
      clearInterval(scanPollTimer);
      clearInterval(queuePollTimer);
      scanPollTimer = null;
      queuePollTimer = null;
      byId('app-panel').classList.add('hidden');
      byId('logout').classList.add('hidden');
      showAuthentication().catch((error) => setStatus(error.message, true));
    });
  }
}

async function loadSettings() {
  const settings = await request('/api/settings');
  state.defaultSort = settings.defaultSort;
  byId('default-sort').value = settings.defaultSort;
  byId('preview-cache-limit').value = settings.previewCacheLimitMb;
  if (window.photoSorter?.isDesktop) {
    byId('autostart-setting').classList.remove('hidden');
    byId('autostart').checked = await window.photoSorter.getAutostart();
  }
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
      const entry = element('div', undefined, 'lan-address');
      const link = element('a', `${address.name}: ${address.url}`);
      link.href = address.url;
      const qr = element('img');
      qr.src = address.qrDataUrl;
      qr.alt = `QR code for ${address.url}`;
      qr.width = 120;
      qr.height = 120;
      entry.append(link, qr);
      container.append(entry);
    }
  } catch {}
}

async function loadRootManagement() {
  const list = byId('root-list');
  list.replaceChildren();
  if (!state.collectionId) return;
  const { roots } = await request(`/api/collections/${encodeURIComponent(state.collectionId)}/roots`);
  for (const root of roots) {
    const item = element('li', `${root.path}${root.online ? '' : ' · offline'}${root.read_only ? ' · read-only' : ''}`);
    const remove = element('button', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      const choice = await showDialog('Remove folder from collection', [
        `Stop including ${root.path} in this collection? Its indexed decisions and history will be retained.`,
      ]);
      if (!choice.confirmed) return;
      try {
        await request(`/api/collections/${encodeURIComponent(state.collectionId)}/roots/${encodeURIComponent(root.id)}`, {
          method: 'DELETE',
        });
        await loadCollections(state.collectionId);
      } catch (error) {
        setStatus(error.message, true);
      }
    });
    item.append(remove);
    list.append(item);
  }
  if (!roots.length) list.append(element('li', 'No folders are registered.'));
}

async function loadArchivedCollections() {
  const list = byId('archived-list');
  list.replaceChildren();
  const { collections } = await request('/api/collections/archived');
  for (const collection of collections) {
    const item = element('li', collection.name);
    item.setAttribute('translate', 'no');
    const restore = element('button', 'Restore');
    restore.type = 'button';
    restore.addEventListener('click', async () => {
      try {
        await request(`/api/collections/${encodeURIComponent(collection.id)}/restore`, { method: 'POST', body: '{}' });
        await loadCollections(collection.id);
      } catch (error) {
        setStatus(error.message, true);
      }
    });
    item.append(restore);
    list.append(item);
  }
  if (!collections.length) list.append(element('li', 'No archived collections.'));
}

async function updatePasskeyStatus(setupComplete) {
  const loginButton = byId('passkey-login');
  const management = byId('passkey-management');
  if (!window.isSecureContext || !navigator.credentials) {
    loginButton.classList.add('hidden');
    management.classList.add('hidden');
    return;
  }
  const status = await request('/api/passkeys/status');
  loginButton.classList.toggle('hidden', !setupComplete || !status.enabled || status.count === 0);
  management.classList.toggle('hidden', !status.enabled);
  byId('passkey-info').textContent = status.enabled
    ? `${status.count} passkey(s) registered. Password sign-in remains available.`
    : 'Passkeys require a configured HTTPS origin and relying-party domain.';
}

async function loadPasskeys() {
  if (!window.isSecureContext || !navigator.credentials) return;
  const status = await request('/api/passkeys/status');
  if (!status.enabled) return;
  const { passkeys } = await request('/api/passkeys');
  const list = byId('passkey-list');
  list.replaceChildren();
  for (const passkey of passkeys) {
    const addedDate = new Date(passkey.createdAt).toLocaleDateString(document.documentElement.lang);
    const item = element('li', `Passkey added ${addedDate}`);
    const remove = element('button', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      try {
        await request(`/api/passkeys/${encodeURIComponent(passkey.id)}`, { method: 'DELETE' });
        await loadPasskeys();
        await updatePasskeyStatus(true);
      } catch (error) {
        setStatus(error.message, true);
      }
    });
    item.append(remove);
    list.append(item);
  }
  await updatePasskeyStatus(true);
}

async function registerPasskey() {
  try {
    const { challengeId, options } = await request('/api/passkeys/registration/options', {
      method: 'POST', body: '{}',
    });
    const response = await window.photoSorterPasskeys.create(options);
    await request('/api/passkeys/registration/verify', {
      method: 'POST', body: JSON.stringify({ challengeId, response }),
    });
    await loadPasskeys();
    setStatus('Passkey registered.');
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function loginWithPasskey() {
  try {
    const { challengeId, options } = await request('/api/passkeys/authentication/options', {
      method: 'POST', body: '{}',
    });
    const response = await window.photoSorterPasskeys.get(options);
    await request('/api/passkeys/authentication/verify', {
      method: 'POST', body: JSON.stringify({ challengeId, response }),
    });
    showApp();
  } catch (error) {
    byId('auth-error').textContent = error.message;
  }
}

async function showAuthentication() {
  const { setupComplete } = await request('/api/setup-status');
  await updatePasskeyStatus(setupComplete);
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
  if (!item || state.busy || !state.lockReady || state.lockedItemId !== item.id) return;
  state.busy = true;
  try {
    await request(`/api/media/${encodeURIComponent(item.id)}/decision`, {
      method: 'PUT', body: JSON.stringify({ category }),
    });
    setStatus(`Saved ${category === 'unseen' ? 'unseen' : category} decision.`);
    const staysInQueue = state.category === 'all' || state.category === category;
    state.items = state.items.filter((candidate) => candidate.id !== item.id || staysInQueue);
    if (!staysInQueue) {
      state.total = Math.max(0, state.total - 1);
      state.index = Math.min(state.index, Math.max(0, state.items.length - 1));
      await loadMedia();
    } else {
      const index = state.items.findIndex((candidate) => candidate.id === item.id);
      if (index >= 0) {
        state.index = index;
        state.items[index].category = category === 'unseen' ? null : category;
      }
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
      `This will perform ${plan.moveCount} file operation(s): ${plan.moveCount - plan.restoreCount - plan.recategorizeCount} new move(s), ${plan.recategorizeCount} recategorization(s), and ${plan.restoreCount} restore(s). ${plan.readOnlySkipped} item(s) on read-only roots will be skipped.`,
      ...(plan.restoreConflictCount ? [`${plan.restoreConflictCount} restore destination(s) are already occupied and will not be overwritten.`] : []),
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
    const recategorized = result.results.filter((item) => item.status === 'recategorized').length;
    const restored = result.results.filter((item) => item.status === 'restored').length;
    setStatus(result.stoppedOnFailure
      ? `Stopped after ${moved} move(s), ${recategorized} recategorization(s), and ${restored} restore(s). Failure: ${result.results.at(-1)?.error}`
      : `Applied ${moved} move(s), ${recategorized} recategorization(s), and ${restored} restore(s). Batch ${result.batchId} can be restored.`);
    await loadMedia();
  } catch (error) {
    setStatus(error.message, true);
  }
}

byId('theme').addEventListener('change', (event) => {
  localStorage.setItem('photo-sorter-theme', event.target.value);
  document.documentElement.dataset.theme = event.target.value;
});
byId('grid-columns').addEventListener('change', (event) => {
  localStorage.setItem('photo-sorter-grid-columns', event.target.value);
  document.documentElement.dataset.gridColumns = event.target.value;
  renderGrid();
  alignGridToSelection();
});
byId('language').addEventListener('change', (event) => {
  window.photoSorterI18n.setLanguage(event.target.value);
});
byId('register-passkey').addEventListener('click', registerPasskey);
byId('passkey-login').addEventListener('click', loginWithPasskey);
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  pendingInstallPrompt = event;
  byId('install-app').classList.remove('hidden');
});
byId('install-app').addEventListener('click', async () => {
  if (!pendingInstallPrompt) return;
  try {
    await pendingInstallPrompt.prompt();
    pendingInstallPrompt = null;
    byId('install-app').classList.add('hidden');
  } catch (error) {
    setStatus(`Unable to start installation: ${error.message}`, true);
  }
});
window.addEventListener('appinstalled', () => {
  pendingInstallPrompt = null;
  byId('install-app').classList.add('hidden');
});
byId('zoom-in').addEventListener('click', () => setZoom(state.zoomScale + 0.5));
byId('zoom-out').addEventListener('click', () => setZoom(state.zoomScale - 0.5));
byId('zoom-reset').addEventListener('click', resetZoom);

byId('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const previousDefault = state.defaultSort;
    const settings = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        defaultSort: byId('default-sort').value,
        previewCacheLimitMb: Number(byId('preview-cache-limit').value),
      }),
    });

    state.defaultSort = settings.defaultSort;
    if (state.sort === previousDefault) {
      state.sort = settings.defaultSort;
      byId('sort-order').value = state.sort;
      state.offset = 0;
      await loadMedia();
    }
    setStatus('Settings saved.');
  } catch (error) { setStatus(error.message, true); }
});

byId('autostart').addEventListener('change', async (event) => {
  try {
    event.target.checked = await window.photoSorter.setAutostart(event.target.checked);
    setStatus('Sign-in startup setting updated.');
  } catch (error) {
    event.target.checked = !event.target.checked;
    setStatus(error.message, true);
  }
});

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
  await loadCollections(event.target.value);
});
byId('archive-collection').addEventListener('click', async () => {
  if (!state.collectionId) return;
  const choice = await showDialog('Archive collection', [
    'Archive this collection? Its decisions and indexed history will be kept. Its folders can then be registered by another active collection.',
  ], { confirmLabel: 'Archive collection' });
  if (!choice.confirmed) return;
  try {
    await request(`/api/collections/${encodeURIComponent(state.collectionId)}/archive`, { method: 'POST', body: '{}' });
    await loadCollections();
  } catch (error) {
    setStatus(error.message, true);
  }
});
byId('sort-order').addEventListener('change', async (event) => {
  state.sort = event.target.value;
  state.offset = 0;
  state.gridTargetIndex = null;
  state.restoreGridScroll = true;
  await loadMedia();
});
byId('add-root').addEventListener('click', async () => {
  try {
    const result = await window.photoSorter.chooseRoot(state.collectionId);
    if (!result.canceled) {
      setStatus('Folder registered; scanning has started.');
      await loadCollections(state.collectionId);
      refreshScans();
    }
  } catch (error) { setStatus(error.message, true); }
});
byId('filters').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  state.category = button.dataset.category;
  state.offset = 0;
  state.index = 0;
  state.gridTargetIndex = null;
  state.restoreGridScroll = true;
  for (const candidate of byId('filters').querySelectorAll('button')) {
    candidate.setAttribute('aria-pressed', String(candidate === button));
  }
  await loadMedia();
});
byId('previous').addEventListener('click', () => moveSelection(-1));
byId('next').addEventListener('click', () => moveSelection(1));
document.querySelectorAll('[data-decision]').forEach((button) => {
  button.addEventListener('click', () => decide(button.dataset.decision));
});
mediaViewport.addEventListener('scroll', handleGridScroll, { passive: true });
window.addEventListener('resize', () => {
  renderGrid();
  alignGridToSelection();
});
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
    setStatus(`Started scanning ${result.scans.length} folder(s).`);
    refreshScans();
  } catch (error) { setStatus(error.message, true); }
});
async function changeDecisionHistory(direction) {
  try {
    const result = await request(`/api/decisions/${direction}`, { method: 'POST', body: '{}' });
    if (!result.changed) {
      setStatus(result.message);
      return;
    }
    state.restoreMediaId = result.mediaId;
    state.offset = Math.floor(state.offset / state.limit) * state.limit;
    setStatus(`${direction === 'undo' ? 'Undid' : 'Redid'} decision: ${result.category}.`);
    await loadMedia();
  } catch (error) {
    setStatus(error.message, true);
  }
}
byId('undo-decision').addEventListener('click', () => changeDecisionHistory('undo'));
byId('redo-decision').addEventListener('click', () => changeDecisionHistory('redo'));
byId('audit').addEventListener('click', async () => {
  try {
    const { events } = await request('/api/audit');
    renderAuditEvents(events);
    byId('audit-panel').classList.toggle('hidden');
  } catch (error) { setStatus(error.message, true); }
});
byId('export-audit').addEventListener('click', async () => {
  try {
    const data = await request('/api/audit/export');
    const file = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = element('a');
    link.href = URL.createObjectURL(file);
    link.download = `photo-sorter-audit-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    setStatus(error.message, true);
  }
});
byId('clear-audit').addEventListener('click', async () => {
  const choice = await showDialog('Clear audit log', [
    'Permanently remove the current audit entries? A single audit_cleared event will be retained.',
  ], { confirmLabel: 'Clear audit log' });
  if (!choice.confirmed) return;
  try {
    const result = await request('/api/audit', { method: 'DELETE', body: '{}' });
    setStatus(`Cleared ${result.clearedCount} audit event(s).`);
    const { events } = await request('/api/audit');
    renderAuditEvents(events);
  } catch (error) {
    setStatus(error.message, true);
  }
});
byId('logout').addEventListener('click', async () => {
  updateItemLock(null);
  await state.lockTransition;
  queueEvents?.close();
  queueEvents = null;
  clearTimeout(queueEventRefreshTimer);
  queueEventRefreshTimer = null;
  await request('/api/logout', { method: 'POST', body: '{}' });
  byId('app-panel').classList.add('hidden');
  clearInterval(scanPollTimer);
  scanPollTimer = null;
  clearInterval(queuePollTimer);
  queuePollTimer = null;
  byId('logout').classList.add('hidden');
  await showAuthentication();
});
setInterval(async () => {
  if (!state.lockedItemId || document.hidden) return;
  try {
    await request(`/api/media/${encodeURIComponent(state.lockedItemId)}/lock`, { method: 'POST' });
  } catch (error) {
    state.lockReady = false;
    setDecisionButtons(false);
    setStatus(error.message, true);
  }
}, 20_000);
document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea, select') || byId('app-panel').classList.contains('hidden')) return;
  if (event.key === 'ArrowLeft') decide('delete');
  if (event.key === 'ArrowRight') decide('keep');
  if (event.key === 'ArrowDown') decide('unsure');
  if (event.key === 'ArrowUp') moveSelection(-1);
});
let touchStart;
byId('current-media').addEventListener('touchstart', (event) => {
  touchStart = { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
}, { passive: true });
byId('current-media').addEventListener('touchend', (event) => {
  if (!touchStart) return;
  if (state.zoomScale > 1) {
    touchStart = null;
    return;
  }
  const dx = event.changedTouches[0].clientX - touchStart.x;
  const dy = event.changedTouches[0].clientY - touchStart.y;
  if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy)) decide(dx < 0 ? 'delete' : 'keep');
  else if (dy > 65) decide('unsure');
  touchStart = null;
}, { passive: true });

byId('current-media').addEventListener('pointerdown', (event) => {
  if (!byId('current-media').querySelector('img') || event.button !== 0) return;
  const point = { x: event.clientX, y: event.clientY };
  state.pointers.set(event.pointerId, point);
  if (state.pointers.size === 1 && state.zoomScale > 1) {
    byId('current-media').setPointerCapture(event.pointerId);
    state.lastPointer = point;
  } else if (state.pointers.size === 2) {
    const [first, second] = state.pointers.values();
    state.pinchDistance = pointerDistance(first, second);
    state.pinchScale = state.zoomScale;
  }
});
byId('current-media').addEventListener('pointermove', (event) => {
  if (!state.pointers.has(event.pointerId)) return;
  const point = { x: event.clientX, y: event.clientY };
  state.pointers.set(event.pointerId, point);
  if (state.pointers.size >= 2 && state.pinchDistance > 0) {
    const [first, second] = state.pointers.values();
    setZoom(state.pinchScale * pointerDistance(first, second) / state.pinchDistance);
    clampPan();
    setZoom(state.zoomScale);
  } else if (state.pointers.size === 1 && state.lastPointer && state.zoomScale > 1) {
    state.panX += point.x - state.lastPointer.x;
    state.panY += point.y - state.lastPointer.y;
    state.lastPointer = point;
    clampPan();
    setZoom(state.zoomScale);
  }
});
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  byId('current-media').addEventListener(eventName, (event) => {
    state.pointers.delete(event.pointerId);
    state.pinchDistance = 0;
    state.lastPointer = null;
  });
}

async function initializeApp() {
  if (developmentMode) {
    const { authenticated } = await request('/api/session');
    if (authenticated) {
      showApp();
      return;
    }
  }
  await showAuthentication();
}

initializeApp().catch((error) => {
  byId('auth-panel').classList.remove('hidden');
  byId('auth-title').textContent = 'Cannot reach the local host';
  byId('auth-description').textContent = error.message;
});

applyVisualPreferences();
if (!developmentMode && window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js')
    .catch((error) => setStatus(`Offline install support unavailable: ${error.message}`, true));
}
