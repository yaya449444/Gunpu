import { openDB } from 'idb';

/* ===== Constants ===== */
const DB_NAME = 'roll-score';
const DB_VERSION = 1;
const STORE_NAME = 'scores';
const SCROLL_BASE_SPEED = 5; // px/s at 1.0x speed
const SHARE_CACHE = 'roll-score-shared-v1';

/* ===== State ===== */
const state = {
  scores: [],               // All saved scores from DB
  currentScore: null,       // Currently editing score object (in-memory)
  currentId: null,          // ID of the currently loaded score (if saved)
  mode: 'browse',           // 'browse' | 'edit'
  isPlaying: false,
  rafId: null,
  scrollAccum: 0,      // Fractional accumulated scroll position
  speed: 1.0,
  zoom: 1.0,
  thumbnailUrls: [],        // Object URLs for thumbnails (parallel to imageBlobs)
  mergedUrl: null,          // Object URL for merged image
  isFullscreen: false,
  fsIdleTimer: null,
  delay: 0,
  countdownRemaining: 0,
  countdownTimer: null,
};

let db = null;

/* ===== DOM refs ===== */
const $ = (id) => document.getElementById(id);
const dom = {
  loadingOverlay: $('loadingOverlay'),
  loadingText: $('loadingText'),
  newScoreBtn: $('newScoreBtn'),
  exportBtn: $('exportBtn'),
  importBtn: $('importBtn'),
  importInput: $('importInput'),
  scoreList: $('scoreList'),
  emptyList: $('emptyList'),
  emptyEditor: $('emptyEditor'),
  activeEditor: $('activeEditor'),
  editor: $('editor'),
  scoreName: $('scoreName'),
  browseScoreName: $('browseScoreName'),
  saveBtn: $('saveBtn'),
  editBtn: $('editBtn'),
  backBtn: $('backBtn'),
  uploadZone: $('uploadZone'),
  fileInput: $('fileInput'),
  thumbnailContainer: $('thumbnailContainer'),
  thumbnailList: $('thumbnailList'),
  imageCount: $('imageCount'),
  controls: $('controls'),
  playBtn: $('playBtn'),
  speedDisplay: $('speedDisplay'),
  delayDisplay: $('delayDisplay'),
  zoomDisplay: $('zoomDisplay'),
  resetBtn: $('resetBtn'),
  scoreViewer: $('scoreViewer'),
  mergedImage: $('mergedImage'),
  fullscreenOverlay: $('fullscreenOverlay'),
  fullscreenViewer: $('fullscreenViewer'),
  fullscreenImage: $('fullscreenImage'),
  fullscreenControls: $('fullscreenControls'),
  fsPlayBtn: $('fsPlayBtn'),
  fsSpeedDisplay: $('fsSpeedDisplay'),
  fsDelayDisplay: $('fsDelayDisplay'),
  fsZoomDisplay: $('fsZoomDisplay'),
  fsExitBtn: $('fsExitBtn'),
  fsExitBtnTop: $('fsExitBtnTop'),
  fullscreenBtn: $('fullscreenBtn'),
  countdownBadge: $('countdownBadge'),
  fsCountdownBadge: $('fsCountdownBadge'),
  scrollWrapper: $('scrollWrapper'),
  fsScrollWrapper: $('fsScrollWrapper'),
};

/* ===== IndexedDB ===== */
async function getDB() {
  if (db) return db;
  db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    },
  });
  return db;
}

async function getAllScores() {
  const database = await getDB();
  return database.getAll(STORE_NAME);
}

async function getScore(id) {
  const database = await getDB();
  return database.get(STORE_NAME, id);
}

async function putScore(score) {
  const database = await getDB();
  await database.put(STORE_NAME, score);
}

async function deleteScore(id) {
  const database = await getDB();
  await database.delete(STORE_NAME, id);
}

/* ===== Loading overlay ===== */
function showLoading(text) {
  dom.loadingText.textContent = text || '加载中...';
  dom.loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  dom.loadingOverlay.classList.add('hidden');
}

/* ===== Toast notification ===== */
function showToast(message, duration = 2000) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

/* ===== Image utilities ===== */
function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

async function rotateBlob(blob, degrees) {
  const img = await loadImageElement(blob);
  const isSwap = degrees % 180 !== 0;
  const canvas = document.createElement('canvas');
  canvas.width = isSwap ? img.height : img.width;
  canvas.height = isSwap ? img.width : img.height;
  const ctx = canvas.getContext('2d');

  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);

  return new Promise((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/png');
  });
}

async function mergeBlobs(blobs) {
  if (!blobs || blobs.length === 0) return null;

  const images = await Promise.all(blobs.map(loadImageElement));
  const maxWidth = Math.max(...images.map((img) => img.naturalWidth));
  const totalHeight = images.reduce((sum, img) => sum + img.naturalHeight, 0);

  const canvas = document.createElement('canvas');
  canvas.width = maxWidth;
  canvas.height = totalHeight;
  const ctx = canvas.getContext('2d');

  let y = 0;
  for (const img of images) {
    const x = Math.round((maxWidth - img.naturalWidth) / 2);
    ctx.drawImage(img, x, y);
    y += img.naturalHeight;
  }

  return new Promise((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/png');
  });
}

/* ===== Thumbnail URL management ===== */
function revokeThumbnails() {
  state.thumbnailUrls.forEach((url) => URL.revokeObjectURL(url));
  state.thumbnailUrls = [];
}

function rebuildThumbnailUrls() {
  revokeThumbnails();
  if (!state.currentScore) return;
  state.thumbnailUrls = state.currentScore.imageBlobs.map((blob) =>
    URL.createObjectURL(blob),
  );
}

function revokeMergedUrl() {
  if (state.mergedUrl) {
    URL.revokeObjectURL(state.mergedUrl);
    state.mergedUrl = null;
  }
}

function generateId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
}

/* ===== Render functions ===== */

/** Render the score list in the sidebar */
function renderScoreList() {
  dom.scoreList.innerHTML = '';

  if (state.scores.length === 0) {
    dom.emptyList.classList.remove('hidden');
    return;
  }

  dom.emptyList.classList.add('hidden');

  state.scores.forEach((score) => {
    const card = document.createElement('div');
    card.className = 'score-card';
    if (score.id === state.currentId) {
      card.classList.add('active');
    }
    card.dataset.id = score.id;

    card.innerHTML = `
      <div class="score-thumb">🎵</div>
      <div class="score-card-info">
        <div class="score-card-name">${escapeHtml(score.name || '未命名')}</div>
        <div class="score-card-meta">${formatDate(score.createdAt)} · ${score.imageBlobs?.length || 0} 张</div>
      </div>
      <button class="score-card-delete" data-id="${score.id}" title="删除曲谱">✕</button>
    `;

    // Click to load score
    card.addEventListener('click', (e) => {
      if (e.target.closest('.score-card-delete')) return;
      loadScoreToEditor(score.id);
    });

    dom.scoreList.appendChild(card);
  });

  // Delete button delegation
  dom.scoreList.querySelectorAll('.score-card-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteScore(btn.dataset.id);
    });
  });
}

/** Render thumbnails in the editor */
function renderThumbnails() {
  const blobs = state.currentScore?.imageBlobs;
  if (!blobs || blobs.length === 0) {
    dom.thumbnailContainer.classList.add('hidden');
    return;
  }

  dom.thumbnailContainer.classList.remove('hidden');
  dom.imageCount.textContent = `${blobs.length} 张`;

  dom.thumbnailList.innerHTML = '';
  const isTouch = matchMedia('(hover: none)').matches;

  state.thumbnailUrls.forEach((url, index) => {
    const item = document.createElement('div');
    item.className = 'thumbnail-item';
    item.innerHTML = `
      <div class="thumbnail-img-wrap">
        <img src="${url}" alt="第 ${index + 1} 页" loading="lazy">
        <div class="thumbnail-actions" style="${isTouch ? 'opacity:1' : ''}">
          <button class="btn-rotate" data-index="${index}" data-deg="-90" title="逆时针旋转">↺</button>
          <button class="btn-rotate" data-index="${index}" data-deg="90" title="顺时针旋转">↻</button>
          <button class="btn-delete-img" data-index="${index}" title="删除此页">✕</button>
        </div>
      </div>
      <span class="thumbnail-label">第 ${index + 1} 页</span>
    `;
    dom.thumbnailList.appendChild(item);
  });

  // Attach rotate handlers
  dom.thumbnailList.querySelectorAll('.btn-rotate').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index);
      const deg = parseInt(btn.dataset.deg);
      handleRotateImage(index, deg);
    });
  });

  // Attach delete image handlers
  dom.thumbnailList.querySelectorAll('.btn-delete-img').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index);
      handleDeleteImage(index);
    });
  });
}

/** Render the merged score viewer */
function renderMergedView() {
  const merged = state.currentScore?.mergedBlob;
  if (!merged) {
    dom.scoreViewer.classList.add('hidden');
    return;
  }

  dom.scoreViewer.classList.remove('hidden');
  revokeMergedUrl();
  state.mergedUrl = URL.createObjectURL(merged);
  dom.mergedImage.src = state.mergedUrl;
}

/** Show the active editor with current score data */
function showEditor(mode) {
  dom.emptyEditor.classList.add('hidden');
  dom.activeEditor.classList.remove('hidden');
  setEditorMode(mode || 'browse');
}

/** Set the editor mode (browse / edit) and toggle UI elements */
function setEditorMode(mode) {
  state.mode = mode;
  const isBrowse = mode === 'browse';
  const hasImages = state.currentScore?.imageBlobs?.length > 0;

  // Header
  dom.browseScoreName.classList.toggle('hidden', !isBrowse);
  dom.browseScoreName.textContent = state.currentScore.name || '未命名';
  dom.editBtn.classList.toggle('hidden', !isBrowse);
  dom.scoreName.classList.toggle('hidden', isBrowse);
  if (!isBrowse) dom.scoreName.value = state.currentScore.name || '';
  dom.saveBtn.classList.toggle('hidden', isBrowse);
  dom.backBtn.classList.toggle('hidden', isBrowse);

  // Upload zone: edit mode only
  dom.uploadZone.classList.toggle('hidden', isBrowse);

  // Thumbnails: edit mode only + only when images exist
  if (isBrowse || !hasImages) {
    dom.thumbnailContainer.classList.add('hidden');
  } else {
    rebuildThumbnailUrls();
    renderThumbnails();
  }

  // Controls: when images exist (any mode)
  dom.controls.classList.toggle('hidden', !hasImages);

  // Viewer: when merged blob exists (any mode)
  if (state.currentScore?.mergedBlob) {
    dom.scoreViewer.classList.remove('hidden');
    renderMergedView();
  } else {
    dom.scoreViewer.classList.add('hidden');
  }
}

function switchToEditMode() {
  state.currentScore.name = dom.browseScoreName.textContent;
  setEditorMode('edit');
  dom.scoreName.focus();
  dom.scoreName.select();
}

function switchToBrowseMode() {
  const name = dom.scoreName.value.trim();
  if (name) state.currentScore.name = name;
  setEditorMode('browse');
}

/** Show the empty editor (no score loaded) */
function showEmptyEditor() {
  dom.activeEditor.classList.add('hidden');
  dom.emptyEditor.classList.remove('hidden');
}

/** Update the play button state */
function updatePlayButton() {
  dom.playBtn.textContent = state.isPlaying ? '⏸ 暂停' : '▶ 播放';
  dom.playBtn.classList.toggle('playing', state.isPlaying);
  dom.fsPlayBtn.textContent = state.isPlaying ? '⏸ 暂停' : '▶ 播放';
  dom.fsPlayBtn.classList.toggle('playing', state.isPlaying);
}

/* ===== Score operations ===== */

async function createNewScore() {
  // Clean up current score state
  cleanupCurrentScore();

  state.currentScore = {
    id: generateId(),
    name: '',
    createdAt: Date.now(),
    imageBlobs: [],
    mergedBlob: null,
    scrollPosition: 0,
    speed: 1.0,
    zoom: 1.0,
    delay: 0,
  };
  state.currentId = null;
  state.isPlaying = false;
  state.speed = 1.0;
  state.zoom = 1.0;
  state.delay = 0;

  updateSpeed(1.0);
  updateZoom(1.0);
  updateDelay(0);

  showEditor('edit');
  dom.scoreName.focus();
  dom.scoreName.select();
}

async function loadScoreToEditor(id) {
  showLoading('加载曲谱中...');
  try {
    const score = await getScore(id);
    if (!score) {
      showToast('曲谱不存在');
      hideLoading();
      return;
    }

    // Clean up current
    cleanupCurrentScore();
    pausePlayback();

    state.currentScore = score;
    state.currentId = score.id;
    state.speed = score.speed || 1.0;
    state.zoom = Math.min(score.zoom || 1.0, 1.0);
    state.delay = score.delay || 0;

    updateSpeed(state.speed);
    updateZoom(state.zoom);
    updateDelay(state.delay);

    showEditor('browse');
    applyZoom();
    renderScoreList();

    // Restore scroll position
    if (score.scrollPosition && dom.scoreViewer) {
      dom.scoreViewer.scrollTop = score.scrollPosition;
    }
  } finally {
    hideLoading();
  }
}

function cleanupCurrentScore() {
  pausePlayback();
  if (state.isFullscreen) exitFullscreen();
  revokeThumbnails();
  revokeMergedUrl();
  dom.scrollWrapper.style.transform = 'translateY(0)';
  dom.fsScrollWrapper.style.transform = 'translateY(0)';
  state.currentScore = null;
  state.currentId = null;
}

function unloadScore() {
  cleanupCurrentScore();
  showEmptyEditor();
  renderScoreList();
}

async function addImagesToScore(files) {
  if (!state.currentScore) {
    showToast('请先新建一个曲谱');
    return;
  }

  const imageFiles = Array.from(files).filter((f) =>
    f.type.startsWith('image/'),
  );
  if (imageFiles.length === 0) {
    showToast('未选择图片文件');
    return;
  }

  showLoading(`正在处理 ${imageFiles.length} 张图片...`);
  try {
    for (const file of imageFiles) {
      state.currentScore.imageBlobs.push(file);
    }

    // Rebuild thumbnails and re-merge
    rebuildThumbnailUrls();
    renderThumbnails();

    // Merge and update viewer
    const merged = await mergeBlobs(state.currentScore.imageBlobs);
    state.currentScore.mergedBlob = merged;
    renderMergedView();

    dom.controls.classList.remove('hidden');

    const count = imageFiles.length;
    showToast(`成功添加 ${count} 张图片`);
  } finally {
    hideLoading();
  }
}

async function handleRotateImage(index, degrees) {
  if (!state.currentScore) return;
  const blob = state.currentScore.imageBlobs[index];
  if (!blob) return;

  showLoading('旋转中...');
  try {
    const rotated = await rotateBlob(blob, degrees);
    state.currentScore.imageBlobs[index] = rotated;

    // Update thumbnail URL
    URL.revokeObjectURL(state.thumbnailUrls[index]);
    state.thumbnailUrls[index] = URL.createObjectURL(rotated);
    renderThumbnails();

    // Re-merge
    const merged = await mergeBlobs(state.currentScore.imageBlobs);
    state.currentScore.mergedBlob = merged;
    renderMergedView();
  } finally {
    hideLoading();
  }
}

async function handleDeleteImage(index) {
  if (!state.currentScore) return;

  state.currentScore.imageBlobs.splice(index, 1);
  rebuildThumbnailUrls();
  renderThumbnails();

  if (state.currentScore.imageBlobs.length === 0) {
    dom.controls.classList.add('hidden');
    dom.scoreViewer.classList.add('hidden');
    state.currentScore.mergedBlob = null;
    return;
  }

  showLoading('更新中...');
  try {
    const merged = await mergeBlobs(state.currentScore.imageBlobs);
    state.currentScore.mergedBlob = merged;
    renderMergedView();
  } finally {
    hideLoading();
  }
}

async function saveCurrentScore() {
  if (!state.currentScore) {
    showToast('没有可保存的曲谱');
    return;
  }

  const name = dom.scoreName.value.trim();
  if (!name) {
    showToast('请为曲谱输入一个名称');
    dom.scoreName.focus();
    return;
  }

  if (state.currentScore.imageBlobs.length === 0) {
    showToast('请先添加图片');
    return;
  }

  showLoading('保存中...');
  try {
    // Ensure merged blob exists
    if (!state.currentScore.mergedBlob) {
      const merged = await mergeBlobs(state.currentScore.imageBlobs);
      state.currentScore.mergedBlob = merged;
      renderMergedView();
    }

    // Update metadata
    state.currentScore.name = name;
    state.currentScore.scrollPosition = dom.scoreViewer.scrollTop || 0;
    state.currentScore.speed = state.speed;
    state.currentScore.zoom = state.zoom;
    state.currentScore.delay = state.delay;

    // If it's a new score (not yet saved), set the creation time
    if (!state.currentId) {
      state.currentScore.createdAt = Date.now();
    }

    await putScore(state.currentScore);

    // Track the saved ID
    if (!state.currentId) {
      state.currentId = state.currentScore.id;
    }

    // Refresh the list
    await refreshScoreList();
    showToast('保存成功 ✓');
  } finally {
    hideLoading();
  }
}

async function handleDeleteScore(id) {
  if (!confirm('确定要删除这个曲谱吗？此操作不可撤销。')) return;

  // If currently editing this score, clean up
  if (state.currentId === id) {
    unloadScore();
  }

  await deleteScore(id);
  await refreshScoreList();
  showToast('已删除');
}

async function refreshScoreList() {
  state.scores = await getAllScores();
  renderScoreList();
}

/* ===== Playback ===== */


function togglePlayback() {
  if (state.countdownTimer !== null) {
    // Cancel countdown mid-flight
    cancelCountdown();
    state.isPlaying = false;
    updatePlayButton();
  } else if (state.isPlaying) {
    pausePlayback();
  } else {
    // Check if we should start with a delay
    const atTop = dom.scoreViewer.scrollTop < 10;
    if (state.delay > 0 && atTop && state.countdownRemaining === 0) {
      state.countdownRemaining = state.delay;
      startCountdown();
    } else if (state.delay > 0 && atTop && state.countdownRemaining > 0) {
      // Resuming from a paused countdown
      startCountdown();
    } else {
      startScrolling();
    }
  }
}

function startCountdown() {
  if (!state.currentScore?.mergedBlob) return;

  // Cancel any pending fullscreen auto-hide timer set before countdown started
  if (state.fsIdleTimer) {
    clearTimeout(state.fsIdleTimer);
    state.fsIdleTimer = null;
  }
  showFsControls();

  state.isPlaying = true;
  updatePlayButton();
  showCountdownOverlay();

  const startTime = performance.now();
  const totalRemaining = state.countdownRemaining;

  function tick(time) {
    if (state.countdownTimer === null) return;
    const elapsed = (time - startTime) / 1000;
    const remaining = Math.max(0, totalRemaining - elapsed);
    const display = Math.ceil(remaining);
    updateCountdownDisplay(display);
    if (remaining <= 0) {
      hideCountdownOverlay();
      startScrolling();
      return;
    }
    state.countdownTimer = requestAnimationFrame(tick);
  }
  state.countdownTimer = requestAnimationFrame(tick);
}

function cancelCountdown() {
  if (state.countdownTimer) {
    cancelAnimationFrame(state.countdownTimer);
    state.countdownTimer = null;
  }
  state.countdownRemaining = 0;
  hideCountdownOverlay();
}

function showCountdownOverlay() {
  dom.countdownBadge.classList.remove('hidden');
  dom.fsCountdownBadge.classList.remove('hidden');
}

function hideCountdownOverlay() {
  dom.countdownBadge.classList.add('hidden');
  dom.fsCountdownBadge.classList.add('hidden');
}

function updateCountdownDisplay(seconds) {
  const text = String(Math.max(1, seconds));
  dom.countdownBadge.textContent = text;
  dom.fsCountdownBadge.textContent = text;
}

function startScrolling() {
  cancelCountdown();
  if (!state.currentScore?.mergedBlob) return;
  state.isPlaying = true;
  const activeViewer = state.isFullscreen ? dom.fullscreenViewer : dom.scoreViewer;
  state.scrollAccum = activeViewer.scrollTop;
  updatePlayButton();

  let lastTime = performance.now();

  function animate(time) {
    if (!state.isPlaying) return;
    const delta = (time - lastTime) / 1000;
    lastTime = time;
    state.scrollAccum += delta * SCROLL_BASE_SPEED * state.speed;

    // Check if we've reached the bottom
    const viewer = state.isFullscreen ? dom.fullscreenViewer : dom.scoreViewer;
    const maxScroll = viewer.scrollHeight - viewer.clientHeight;
    if (state.scrollAccum >= maxScroll) {
      state.scrollAccum = maxScroll;
      dom.scoreViewer.scrollTop = maxScroll;
      dom.scrollWrapper.style.transform = 'translateY(0)';
      if (state.isFullscreen) {
        dom.fullscreenViewer.scrollTop = maxScroll;
        dom.fsScrollWrapper.style.transform = 'translateY(0)';
      }
      pausePlayback();
      return;
    }

    const intPart = Math.floor(state.scrollAccum);
    const fracPart = state.scrollAccum - intPart;
    dom.scoreViewer.scrollTop = intPart;
    dom.scrollWrapper.style.transform = `translateY(${-fracPart}px)`;
    if (state.isFullscreen) {
      dom.fullscreenViewer.scrollTop = intPart;
      dom.fsScrollWrapper.style.transform = `translateY(${-fracPart}px)`;
    }
    state.rafId = requestAnimationFrame(animate);
  }

  state.rafId = requestAnimationFrame(animate);

  // Restart fullscreen idle timer now that countdown ended
  if (state.isFullscreen) resetFsIdleTimer();
}

function pausePlayback() {
  cancelCountdown();
  state.isPlaying = false;
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  updatePlayButton();
}

function resetPlayback() {
  cancelCountdown();
  pausePlayback();
  state.scrollAccum = 0;
  dom.scoreViewer.scrollTop = 0;
  dom.scrollWrapper.style.transform = 'translateY(0)';
  if (state.isFullscreen) {
    dom.fullscreenViewer.scrollTop = 0;
    dom.fsScrollWrapper.style.transform = 'translateY(0)';
  }
}

function updateSpeed(value) {
  state.speed = Math.max(0.3, Math.min(3.0, parseFloat(value)));
  const text = state.speed.toFixed(1) + 'x';
  dom.speedDisplay.textContent = text;
  dom.fsSpeedDisplay.textContent = text;
}

function updateDelay(value) {
  state.delay = Math.max(0, Math.min(60, Math.round(value)));
  const text = state.delay + 's';
  dom.delayDisplay.textContent = text;
  dom.fsDelayDisplay.textContent = text;
}

function updateZoom(value) {
  state.zoom = Math.max(0.5, Math.min(1.0, parseFloat(value)));
  const pct = Math.round(state.zoom * 100) + '%';
  dom.zoomDisplay.textContent = pct;
  dom.fsZoomDisplay.textContent = pct;
  applyZoom();
}

function applyZoom() {
  const pct = (state.zoom * 100).toFixed(0) + '%';
  dom.mergedImage.style.width = pct;
  dom.fullscreenImage.style.width = pct;
}

function adjustValue(ctrl, dir) {
  switch (ctrl) {
    case 'speed': updateSpeed(+(state.speed + dir * 0.1).toFixed(1)); break;
    case 'delay': updateDelay(state.delay + dir); break;
    case 'zoom':  updateZoom(+(state.zoom + dir * 0.1).toFixed(1)); break;
  }
}

/* ===== Fullscreen ===== */

function enterFullscreen() {
  if (!state.currentScore?.mergedBlob) return;

  // Save current scroll position
  if (state.currentId) {
    state.currentScore.scrollPosition = dom.scoreViewer.scrollTop || 0;
  }

  state.isFullscreen = true;

  // Copy image source
  dom.fullscreenImage.src = dom.mergedImage.src;

  // Sync fullscreen play button state
  dom.fsPlayBtn.textContent = state.isPlaying ? '⏸ 暂停' : '▶ 播放';
  dom.fsPlayBtn.classList.toggle('playing', state.isPlaying);

  // Sync fullscreen displays
  dom.fsSpeedDisplay.textContent = state.speed.toFixed(1) + 'x';
  dom.fsZoomDisplay.textContent = Math.round(state.zoom * 100) + '%';
  dom.fsDelayDisplay.textContent = state.delay + 's';
  applyZoom();

  // Show overlay
  dom.fullscreenOverlay.classList.remove('hidden');

  // Reset wrapper transforms
  dom.scrollWrapper.style.transform = 'translateY(0)';
  dom.fsScrollWrapper.style.transform = 'translateY(0)';

  // Restore scroll position in fullscreen viewer
  dom.fullscreenViewer.scrollTop = state.currentScore.scrollPosition || 0;

  // Start idle timer to hide controls
  resetFsIdleTimer();

  // Focus the overlay for keyboard events
  dom.fullscreenOverlay.focus();
}

function exitFullscreen() {
  if (!state.isFullscreen) return;

  state.isFullscreen = false;

  // Clear idle timer
  if (state.fsIdleTimer) {
    clearTimeout(state.fsIdleTimer);
    state.fsIdleTimer = null;
  }

  // Hide overlay
  dom.fullscreenOverlay.classList.add('hidden');

  // Reset wrapper transforms
  dom.scrollWrapper.style.transform = 'translateY(0)';
  dom.fsScrollWrapper.style.transform = 'translateY(0)';

  // Save scroll position from fullscreen viewer, then restore in main viewer
  if (state.currentScore) {
    state.currentScore.scrollPosition = dom.fullscreenViewer.scrollTop || 0;
  }
  dom.scoreViewer.scrollTop = state.currentScore?.scrollPosition || 0;
}

function toggleFullscreen() {
  if (state.isFullscreen) {
    exitFullscreen();
  } else {
    enterFullscreen();
  }
}

function showFsControls() {
  dom.fullscreenControls.classList.remove('fade-out');
}

function hideFsControls() {
  dom.fullscreenControls.classList.add('fade-out');
}

function resetFsIdleTimer() {
  if (state.fsIdleTimer) {
    clearTimeout(state.fsIdleTimer);
  }
  showFsControls();
  // Don't auto-hide on touch devices or during countdown
  if (matchMedia('(hover: none)').matches) return;
  if (state.countdownTimer !== null) return;
  state.fsIdleTimer = setTimeout(hideFsControls, 3000);
}

/* ===== Helpers ===== */

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ===== Backup: Export / Import ===== */

/** Convert a Blob to { type, data (base64) } */
async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return { type: blob.type, data: btoa(binary) };
}

/** Convert base64 string + mime type back to a Blob */
function base64ToBlob(base64Data, mimeType) {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType || 'image/png' });
}

/** Export all scores as a downloadable JSON backup file */
async function exportBackup() {
  showLoading('正在导出备份...');
  try {
    const scores = await getAllScores();
    if (scores.length === 0) {
      showToast('没有曲谱可导出');
      return;
    }

    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      scores: [],
    };

    for (const score of scores) {
      const scoreData = {
        id: score.id,
        name: score.name,
        createdAt: score.createdAt,
        scrollPosition: score.scrollPosition || 0,
        speed: score.speed || 1.0,
        zoom: score.zoom || 1.0,
        delay: score.delay || 0,
        imageBlobs: [],
      };

      for (const blob of score.imageBlobs) {
        scoreData.imageBlobs.push(await blobToBase64(blob));
      }

      if (score.mergedBlob) {
        scoreData.mergedBlob = await blobToBase64(score.mergedBlob);
      }

      exportData.scores.push(scoreData);
    }

    const json = JSON.stringify(exportData, null, 2);
    const today = formatDate(Date.now());
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `曲谱备份_${today}.json`;
    a.click();

    URL.revokeObjectURL(url);
    showToast(`成功导出 ${scores.length} 个曲谱`);
  } finally {
    hideLoading();
  }
}

/** Import scores from a JSON backup file */
async function importBackup(file) {
  if (!file) return;

  showLoading('正在导入备份...');
  try {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      showToast('文件格式错误：不是有效的 JSON');
      return;
    }

    if (!data.version || !Array.isArray(data.scores)) {
      showToast('文件格式错误：无效的备份文件');
      return;
    }

    // Get existing score names for dedup
    const existingScores = await getAllScores();
    const existingNames = new Set(existingScores.map((s) => s.name));

    let imported = 0;
    let skipped = 0;

    for (const scoreData of data.scores) {
      if (!scoreData.imageBlobs || !Array.isArray(scoreData.imageBlobs)) continue;

      // Skip if a score with the same name already exists
      const name = scoreData.name || '未命名';
      if (existingNames.has(name)) {
        skipped++;
        continue;
      }

      const imageBlobs = scoreData.imageBlobs.map((item) =>
        base64ToBlob(item.data, item.type)
      );

      let mergedBlob = null;
      if (scoreData.mergedBlob) {
        mergedBlob = base64ToBlob(scoreData.mergedBlob.data, scoreData.mergedBlob.type);
      }

      const score = {
        id: generateId(),
        name,
        createdAt: Date.now(),
        imageBlobs,
        mergedBlob,
        scrollPosition: 0,
        speed: scoreData.speed || 1.0,
        zoom: scoreData.zoom || 1.0,
        delay: scoreData.delay || 0,
      };

      await putScore(score);
      imported++;
      existingNames.add(name); // Prevent dupes within the same import batch
    }

    await refreshScoreList();
    const msg = `成功导入 ${imported} 个曲谱`;
    showToast(skipped > 0 ? `${msg}，跳过 ${skipped} 个（名称重复）` : msg);
  } finally {
    hideLoading();
  }
}

/* ===== Share target helpers ===== */

function hasQueryParam(name) {
  return new URLSearchParams(window.location.search).has(name);
}

function cleanUrl() {
  if (window.history.replaceState) {
    const clean = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, clean);
  }
}

async function retrieveSharedFilesFromCache() {
  if (!('caches' in window)) return [];
  try {
    const cache = await caches.open(SHARE_CACHE);
    const metaRes = await cache.match(new Request('/_sw_share/meta'));
    if (!metaRes) return [];

    const fileInfos = await metaRes.json();
    const files = [];

    for (const info of fileInfos) {
      const fileRes = await cache.match(new Request(info.key));
      if (fileRes) {
        const blob = await fileRes.blob();
        const file = new File([blob], info.name, { type: info.type });
        files.push(file);
      }
    }

    // Clean up cache
    for (const info of fileInfos) {
      await cache.delete(new Request(info.key));
    }
    await cache.delete(new Request('/_sw_share/meta'));

    return files;
  } catch (err) {
    console.error('Failed to retrieve shared files:', err);
    try {
      const cache = await caches.open(SHARE_CACHE);
      const keys = await cache.keys();
      for (const key of keys) await cache.delete(key);
    } catch {}
    return [];
  }
}

async function handleIncomingFiles(files) {
  const imageFiles = Array.from(files).filter((f) =>
    f.type.startsWith('image/')
  );
  if (imageFiles.length === 0) {
    showToast('未发现图片文件');
    return;
  }

  showLoading(`正在接收 ${imageFiles.length} 张共享图片...`);
  try {
    if (state.currentScore) {
      // Already has a score — add images directly
      await addImagesToScore(imageFiles);
      switchToBrowseMode();
      showToast(`已添加 ${imageFiles.length} 张共享图片`);
    } else {
      // No current score — auto-create one
      await createNewScore();
      dom.scoreName.value = '共享曲谱';
      await addImagesToScore(imageFiles);
      await saveCurrentScore();
      switchToBrowseMode();
      showToast(`已接收 ${imageFiles.length} 张共享图片`);
    }
  } finally {
    hideLoading();
  }
}

async function handleShareTarget() {
  showLoading('正在接收共享文件...');
  try {
    const files = await retrieveSharedFilesFromCache();
    if (files.length === 0) {
      showToast('未找到共享文件');
      return;
    }
    await handleIncomingFiles(files);
  } finally {
    cleanUrl();
    hideLoading();
  }
}

function setupLaunchQueue() {
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      if (!launchParams.files || launchParams.files.length === 0) return;
      const files = [];
      for (const fileHandle of launchParams.files) {
        try {
          const file = await fileHandle.getFile();
          files.push(file);
        } catch (err) {
          console.warn('Failed to read file handle:', err);
        }
      }
      if (files.length > 0) {
        await handleIncomingFiles(files);
      }
    });
  }
}

/* ===== Stepper long-press support ===== */

function setupStepperListeners(container) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.stepper-btn');
    if (!btn) return;
    adjustValue(btn.dataset.ctrl, parseInt(btn.dataset.dir));
  });

  // Long press: start repeating after 300ms, then every 120ms
  container.addEventListener('mousedown', (e) => {
    const btn = e.target.closest('.stepper-btn');
    if (!btn || e.button !== 0) return;
    let interval = null;
    const timeout = setTimeout(() => {
      interval = setInterval(() => adjustValue(btn.dataset.ctrl, parseInt(btn.dataset.dir)), 120);
    }, 300);

    const stop = () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
      interval = null;
    };

    btn.addEventListener('mouseup', stop, { once: true });
    btn.addEventListener('mouseleave', stop, { once: true });
  });

  // Touch long press for mobile
  container.addEventListener('touchstart', (e) => {
    const btn = e.target.closest('.stepper-btn');
    if (!btn) return;
    let interval = null;
    const timeout = setTimeout(() => {
      interval = setInterval(() => adjustValue(btn.dataset.ctrl, parseInt(btn.dataset.dir)), 120);
    }, 300);

    const stop = () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
      interval = null;
    };

    btn.addEventListener('touchend', stop, { once: true });
    btn.addEventListener('touchcancel', stop, { once: true });
  }, { passive: true });
}

/* ===== Event setup ===== */

function setupEventListeners() {
  // New score
  dom.newScoreBtn.addEventListener('click', createNewScore);

  // Export backup
  dom.exportBtn.addEventListener('click', exportBackup);

  // Import backup
  dom.importBtn.addEventListener('click', () => dom.importInput.click());
  dom.importInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      importBackup(e.target.files[0]);
      e.target.value = '';
    }
  });

  // Save
  dom.saveBtn.addEventListener('click', saveCurrentScore);

  // Edit
  dom.editBtn.addEventListener('click', switchToEditMode);

  // Back: saved score → browse mode, new score → unload
  dom.backBtn.addEventListener('click', () => {
    if (state.currentId) {
      switchToBrowseMode();
    } else {
      unloadScore();
    }
  });

  // Play/pause
  dom.playBtn.addEventListener('click', togglePlayback);

  // Stepper buttons (controls bar)
  setupStepperListeners(dom.controls);

  // Reset
  dom.resetBtn.addEventListener('click', resetPlayback);

  // Fullscreen toggle
  dom.fullscreenBtn.addEventListener('click', toggleFullscreen);
  dom.fsExitBtn.addEventListener('click', resetPlayback);
  dom.fsExitBtnTop.addEventListener('click', exitFullscreen);

  // Upload zone click → file input
  dom.uploadZone.addEventListener('click', () => dom.fileInput.click());

  // File input change
  dom.fileInput.addEventListener('change', (e) => {
    addImagesToScore(e.target.files);
    e.target.value = '';
  });

  // Drag & drop
  dom.uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dom.uploadZone.classList.add('drag-over');
  });

  dom.uploadZone.addEventListener('dragleave', () => {
    dom.uploadZone.classList.remove('drag-over');
  });

  dom.uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.uploadZone.classList.remove('drag-over');
    addImagesToScore(e.dataTransfer.files);
  });

  // Paste (screenshot)
  document.addEventListener('paste', (e) => {
    if (!state.currentScore || state.mode !== 'edit') return;
    const items = e.clipboardData.items;
    const imageFiles = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      // Visual feedback: highlight upload zone
      dom.uploadZone.style.transition = 'background 0.3s';
      dom.uploadZone.style.background = '#dbeafe';
      setTimeout(() => {
        dom.uploadZone.style.background = '';
      }, 600);
      addImagesToScore(imageFiles);
    }
  });

  // User manual scroll during playback → detect vs programmatic scroll
  dom.scoreViewer.addEventListener('scroll', () => {
    if (!state.isPlaying) return;
    const current = dom.scoreViewer.scrollTop;
    const expected = Math.floor(state.scrollAccum);
    if (current !== expected) {
      state.scrollAccum = current;
      dom.scrollWrapper.style.transform = 'translateY(0)';
    }
  });
  dom.fullscreenViewer.addEventListener('scroll', () => {
    if (!state.isPlaying) return;
    const current = dom.fullscreenViewer.scrollTop;
    const expected = Math.floor(state.scrollAccum);
    if (current !== expected) {
      state.scrollAccum = current;
      dom.fsScrollWrapper.style.transform = 'translateY(0)';
    }
  });

  // Fullscreen: play/pause and stepper buttons
  dom.fsPlayBtn.addEventListener('click', togglePlayback);
  setupStepperListeners(dom.fullscreenControls.querySelector('.fullscreen-controls-inner'));

  // Fullscreen overlay: idle timer on mouse/touch activity
  dom.fullscreenOverlay.addEventListener('mousemove', resetFsIdleTimer);
  dom.fullscreenOverlay.addEventListener('keydown', resetFsIdleTimer);

  // Touch devices: tap on viewer to toggle controls
  let lastFsTap = 0;
  dom.fullscreenViewer.addEventListener('touchstart', (e) => {
    const now = Date.now();
    if (now - lastFsTap < 300) {
      // Double tap: ignore (let user zoom/scroll)
      lastFsTap = 0;
      return;
    }
    lastFsTap = now;
    resetFsIdleTimer();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ignore when typing in input fields
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.code === 'Escape' && state.isFullscreen) {
      e.preventDefault();
      exitFullscreen();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlayback();
    }
    if (e.code === 'KeyR') {
      resetPlayback();
    }
  });

  // Save scroll position when leaving
  window.addEventListener('beforeunload', () => {
    if (state.currentId && state.currentScore) {
      const activeViewer = state.isFullscreen ? dom.fullscreenViewer : dom.scoreViewer;
      state.currentScore.scrollPosition = activeViewer.scrollTop || 0;
      state.currentScore.speed = state.speed;
      state.currentScore.zoom = state.zoom;
      state.currentScore.delay = state.delay;
      putScore(state.currentScore).catch(() => {});
    }
  });
}

/* ===== Init ===== */

async function init() {
  // Register service worker for share target support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  setupEventListeners();
  setupLaunchQueue();

  showLoading('加载曲谱列表...');
  try {
    // Handle share target or error signals early
    if (hasQueryParam('shared')) {
      await handleShareTarget();
      // Re-fetch score list after import
      await refreshScoreList();
    } else if (hasQueryParam('shared-error')) {
      showToast('接收共享文件时出错');
      cleanUrl();
      await refreshScoreList();
      showEmptyEditor();
    } else if (hasQueryParam('shared-empty')) {
      showToast('共享内容中未发现图片');
      cleanUrl();
      await refreshScoreList();
      showEmptyEditor();
    } else {
      await refreshScoreList();
      showEmptyEditor();
    }
  } finally {
    hideLoading();
  }
}

init();
