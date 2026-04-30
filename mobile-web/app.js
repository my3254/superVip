const STORAGE_KEY = 'supervip.mobile.state.v2';

const MOBILE_HOME_URLS = {
  iqiyi: 'https://m.iqiyi.com/',
  youku: 'https://m.youku.com/',
  tencent: 'https://m.v.qq.com/',
  mgtv: 'https://m.mgtv.com/',
  bilibili: 'https://m.bilibili.com/',
  sohu: 'https://m.tv.sohu.com/',
  le: 'https://m.le.com/'
};

const state = {
  selectedPlatformId: PLATFORMS[0]?.id || '',
  currentInterfaceId: DEFAULT_INTERFACES[0]?.id || '',
  currentInputUrl: '',
  currentParsedUrl: '',
  history: [],
  frameFallbackTimer: null
};

const elements = {
  currentPlatformName: document.getElementById('currentPlatformName'),
  siteFrame: document.getElementById('siteFrame'),
  frameFallback: document.getElementById('frameFallback'),
  externalButton: document.getElementById('externalButton'),
  fallbackOpenButton: document.getElementById('fallbackOpenButton'),
  platformList: document.getElementById('platformList'),
  parseSheet: document.getElementById('parseSheet'),
  closeParseButton: document.getElementById('closeParseButton'),
  parseForm: document.getElementById('parseForm'),
  urlInput: document.getElementById('urlInput'),
  pasteButton: document.getElementById('pasteButton'),
  interfaceSelect: document.getElementById('interfaceSelect'),
  openOfficialButton: document.getElementById('openOfficialButton'),
  parseButton: document.getElementById('parseButton'),
  statusBar: document.getElementById('statusBar'),
  resultPanel: document.getElementById('resultPanel'),
  resultUrl: document.getElementById('resultUrl'),
  copyButton: document.getElementById('copyButton'),
  historyList: document.getElementById('historyList'),
  clearHistoryButton: document.getElementById('clearHistoryButton')
};

const PLATFORM_VISUALS = {
  iqiyi: { shortName: '爱奇艺', icon: 'iQIYI', className: 'platform-iqiyi' },
  youku: { shortName: '优酷', icon: 'YOUKU', className: 'platform-youku' },
  tencent: { shortName: '腾讯', icon: '腾讯', className: 'platform-tencent' },
  mgtv: { shortName: '芒果', icon: 'MGTV', className: 'platform-mgtv' },
  bilibili: { shortName: 'B站', icon: 'BILI', className: 'platform-bilibili' },
  sohu: { shortName: '搜狐', icon: '搜狐', className: 'platform-sohu' },
  le: { shortName: '乐视', icon: '乐视', className: 'platform-le' }
};

function loadState() {
  try {
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (typeof persisted.currentInterfaceId === 'string') {
      state.currentInterfaceId = persisted.currentInterfaceId;
    }
    if (typeof persisted.selectedPlatformId === 'string') {
      state.selectedPlatformId = persisted.selectedPlatformId;
    }
    if (Array.isArray(persisted.history)) {
      state.history = persisted.history.slice(0, 30);
    }
  } catch (_error) {
    state.history = [];
  }
}

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      selectedPlatformId: state.selectedPlatformId,
      currentInterfaceId: state.currentInterfaceId,
      history: state.history
    })
  );
}

function normalizeUrl(input) {
  const value = input.trim();
  if (!value) {
    return '';
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(value)) {
    return `https://${value}`;
  }
  return value;
}

function currentPlatform() {
  return PLATFORMS.find((platform) => platform.id === state.selectedPlatformId) || PLATFORMS[0];
}

function currentHomeUrl() {
  const platform = currentPlatform();
  return MOBILE_HOME_URLS[platform.id] || platform.homeUrl;
}

function currentInterface() {
  return DEFAULT_INTERFACES.find((item) => item.id === state.currentInterfaceId) || DEFAULT_INTERFACES[0];
}

function buildParseUrl(videoUrl) {
  return `${currentInterface().url}${encodeURIComponent(videoUrl)}`;
}

function setStatus(message, type = '') {
  elements.statusBar.textContent = message;
  elements.statusBar.classList.toggle('is-ok', type === 'ok');
  elements.statusBar.classList.toggle('is-warning', type === 'warning');
  elements.statusBar.classList.toggle('is-error', type === 'error');
}

function platformVisual(platformId) {
  return PLATFORM_VISUALS[platformId] || { shortName: '站点', icon: 'V', className: 'platform-default' };
}

function makePlatformIcon(platformId) {
  const visual = platformVisual(platformId);
  const icon = document.createElement('span');
  icon.className = `platform-icon ${visual.className}`;
  icon.textContent = visual.icon;
  return icon;
}

function renderPlatforms() {
  elements.platformList.innerHTML = '';
  for (const platform of PLATFORMS) {
    const visual = platformVisual(platform.id);
    const button = document.createElement('button');
    button.className = 'dock-button';
    button.type = 'button';
    button.dataset.platformId = platform.id;
    button.textContent = visual.shortName;
    button.addEventListener('click', () => {
      selectPlatform(platform.id);
    });
    elements.platformList.appendChild(button);
  }
}

function updatePlatformSelection() {
  for (const button of elements.platformList.querySelectorAll('.dock-button')) {
    button.classList.toggle('is-active', button.dataset.platformId === state.selectedPlatformId);
  }
}

function showFrameFallback(show) {
  elements.frameFallback.hidden = !show;
}

function loadParser(videoUrl, title = '') {
  const platformInfo = detectPlatform(videoUrl);
  if (!platformInfo) {
    return false;
  }

  const parsedUrl = buildParseUrl(videoUrl);
  state.selectedPlatformId = platformInfo.platform.id;
  state.currentInputUrl = videoUrl;
  state.currentParsedUrl = parsedUrl;
  updatePlatformSelection();
  rememberHistory(videoUrl, parsedUrl, platformInfo);
  elements.currentPlatformName.textContent = `${platformInfo.platform.name} 解析播放`;
  elements.siteFrame.title = `${platformInfo.platform.name} 解析播放`;
  elements.siteFrame.src = parsedUrl;
  showFrameFallback(false);

  if (title) {
    console.info(`Parsing video: ${title}`);
  }
  return true;
}

function maybeParseFrameUrl() {
  try {
    const iframeUrl = elements.siteFrame.contentWindow.location.href;
    if (iframeUrl && detectPlatform(iframeUrl)) {
      loadParser(iframeUrl);
    }
  } catch (_error) {
    // Parser pages and some official pages can become cross-origin after navigation.
  }
}

function bindFrameClickParser() {
  let frameDocument;
  try {
    frameDocument = elements.siteFrame.contentDocument;
  } catch (_error) {
    return;
  }

  if (!frameDocument || frameDocument.__superVipClickBound) {
    return;
  }
  frameDocument.__superVipClickBound = true;

  frameDocument.addEventListener(
    'click',
    (event) => {
      const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!link) {
        return;
      }

      const targetUrl = link.href;
      if (!targetUrl || !detectPlatform(targetUrl)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      loadParser(targetUrl, link.textContent || '');
    },
    true
  );
}

function loadCurrentPlatformHome() {
  const platform = currentPlatform();
  elements.currentPlatformName.textContent = `${platform.name} 手机站`;
  elements.siteFrame.title = `${platform.name} 手机站`;
  showFrameFallback(false);

  if (state.frameFallbackTimer) {
    clearTimeout(state.frameFallbackTimer);
  }

  elements.siteFrame.src = currentHomeUrl();
  state.frameFallbackTimer = setTimeout(() => {
    showFrameFallback(true);
  }, 6000);
}

function selectPlatform(platformId) {
  state.selectedPlatformId = platformId;
  saveState();
  updatePlatformSelection();
  updateInputState();
  loadCurrentPlatformHome();
}

function renderInterfaces() {
  elements.interfaceSelect.innerHTML = '';
  DEFAULT_INTERFACES.forEach((parserInterface, index) => {
    const option = document.createElement('option');
    option.value = parserInterface.id;
    option.textContent = index === 0 ? '默认线路' : `备用线路 ${index}`;
    elements.interfaceSelect.appendChild(option);
  });
  elements.interfaceSelect.value = state.currentInterfaceId;
}

function formatTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return '';
  }
  const diff = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)}分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)}小时前`;
  if (diff < day * 7) return `${Math.floor(diff / day)}天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function renderHistory() {
  elements.historyList.innerHTML = '';
  if (state.history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-history';
    empty.textContent = '暂无历史记录';
    elements.historyList.appendChild(empty);
    return;
  }

  for (const item of state.history) {
    const button = document.createElement('button');
    button.className = 'history-item';
    button.type = 'button';

    const copy = document.createElement('span');
    const title = document.createElement('span');
    title.className = 'history-name';
    title.textContent = item.platformName || '视频地址';
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    meta.textContent = `${formatTime(item.createdAt)} · ${item.originalUrl}`;
    copy.append(title, meta);

    button.append(makePlatformIcon(item.platformId), copy);
    button.addEventListener('click', () => {
      state.selectedPlatformId = item.platformId || state.selectedPlatformId;
      elements.urlInput.value = item.originalUrl;
      updatePlatformSelection();
      updateInputState();
      openParseSheet();
    });
    elements.historyList.appendChild(button);
  }
}

function rememberHistory(originalUrl, parsedUrl, platformInfo) {
  state.history = [
    {
      originalUrl,
      parsedUrl,
      platformId: platformInfo.platform.id,
      platformName: platformInfo.platform.name,
      createdAt: new Date().toISOString()
    },
    ...state.history.filter((item) => item.originalUrl !== originalUrl)
  ].slice(0, 30);
  saveState();
  renderHistory();
}

function updateResult(parsedUrl) {
  state.currentParsedUrl = parsedUrl;
  elements.resultPanel.hidden = !parsedUrl;
  elements.resultUrl.textContent = parsedUrl;
}

function updateInputState() {
  const normalizedUrl = normalizeUrl(elements.urlInput.value);
  const platformInfo = detectPlatform(normalizedUrl);
  state.currentInputUrl = normalizedUrl;

  if (!normalizedUrl) {
    elements.parseButton.disabled = true;
    updateResult('');
    setStatus('打开官网，复制视频页地址后粘贴解析。');
    return;
  }

  if (!/^https?:\/\//i.test(normalizedUrl)) {
    elements.parseButton.disabled = true;
    updateResult('');
    setStatus('请输入 http 或 https 开头的视频页地址。', 'warning');
    return;
  }

  if (!platformInfo) {
    elements.parseButton.disabled = true;
    updateResult('');
    setStatus('当前地址不是已支持的视频页。', 'warning');
    return;
  }

  state.selectedPlatformId = platformInfo.platform.id;
  updatePlatformSelection();
  const parsedUrl = buildParseUrl(normalizedUrl);
  updateResult(parsedUrl);
  elements.parseButton.disabled = false;
  setStatus(`已识别：${platformInfo.platform.name}`, 'ok');
}

function openUrl(url) {
  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) {
    window.location.href = url;
  }
}

async function copyText(text) {
  if (!text) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_error) {
    return false;
  }
}

function openParseSheet() {
  elements.parseSheet.hidden = false;
}

function closeParseSheet() {
  elements.parseSheet.hidden = true;
}

function handleParseSubmit(event) {
  event.preventDefault();
  updateInputState();
  if (elements.parseButton.disabled || !state.currentParsedUrl) {
    return;
  }

  const platformInfo = detectPlatform(state.currentInputUrl);
  rememberHistory(state.currentInputUrl, state.currentParsedUrl, platformInfo);
  openUrl(state.currentParsedUrl);
}

async function handlePaste() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      elements.urlInput.value = text.trim();
      updateInputState();
      return;
    }
  } catch (_error) {
    // Clipboard read is unavailable on some iOS/LAN HTTP contexts.
  }
  elements.urlInput.focus();
  setStatus('当前浏览器不允许自动读取剪贴板，请在输入框长按粘贴。', 'warning');
}

function bindEvents() {
  elements.siteFrame.addEventListener('load', () => {
    if (state.frameFallbackTimer) {
      clearTimeout(state.frameFallbackTimer);
      state.frameFallbackTimer = null;
    }
    maybeParseFrameUrl();
    bindFrameClickParser();
  });
  elements.externalButton.addEventListener('click', () => openUrl(currentHomeUrl()));
  elements.fallbackOpenButton.addEventListener('click', () => openUrl(currentHomeUrl()));
  elements.closeParseButton.addEventListener('click', closeParseSheet);
  elements.urlInput.addEventListener('input', updateInputState);
  elements.parseForm.addEventListener('submit', handleParseSubmit);
  elements.pasteButton.addEventListener('click', handlePaste);
  elements.interfaceSelect.addEventListener('change', () => {
    state.currentInterfaceId = elements.interfaceSelect.value;
    saveState();
    updateInputState();
  });
  elements.openOfficialButton.addEventListener('click', () => {
    openUrl(currentHomeUrl());
  });
  elements.copyButton.addEventListener('click', async () => {
    const copied = await copyText(state.currentParsedUrl);
    setStatus(copied ? '解析链接已复制。' : '当前浏览器不允许自动复制，请长按解析链接复制。', copied ? 'ok' : 'warning');
  });
  elements.clearHistoryButton.addEventListener('click', () => {
    state.history = [];
    saveState();
    renderHistory();
  });
}

function init() {
  loadState();
  renderPlatforms();
  renderInterfaces();
  renderHistory();
  bindEvents();
  updatePlatformSelection();
  updateInputState();
  loadCurrentPlatformHome();
}

init();
