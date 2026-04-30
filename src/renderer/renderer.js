const state = {
  currentUrl: '',
  currentTitle: '',
  currentPlatformInfo: null,
  detectedVideoUrl: '',
  detectedVideoTitle: '',
  selectedPlatformId: '',
  currentInterfaceId: 'interface_1',
  autoParse: true,
  history: [],
  guestPreloadPath: '',
  userAgent: '',
  lastParsedUrl: '',
  parseSession: null,
  parserHealthTimer: null,
  activeView: 'browser',
  inlinePlayerActive: false,
  inlinePlayerRect: null,
  inlineSourcePageUrl: '',
  browserLoading: false,
  pendingInlineReplaceAfterLoad: false,
  pendingInlinePlayerRect: null,
  pendingInlineTargetUrl: '',
  pendingInlineReplaceDeadline: 0,
  pendingInlineReplaceTimer: null
};

let nextParseSessionId = 1;
const latestParsedUrls = new Map();

const PARSER_LOAD_TIMEOUT_MS = 12000;
const PARSER_HEALTH_CHECK_DELAY_MS = 4500;
const PARSER_HEALTH_RECHECK_DELAY_MS = 2500;
const PAUSE_EMBEDDED_MEDIA_SCRIPT = `
  (() => {
    for (const media of document.querySelectorAll('audio, video')) {
      try {
        media.autoplay = false;
        media.pause();
      } catch (_error) {}
    }
    return true;
  })();
`;
const BROWSER_PLAYBACK_RECT_SCRIPT = `
  (() => {
    const selectors = [
      'video',
      '#player',
      '#video',
      '#flashbox',
      '#mod-player',
      '#playerWrap',
      '#player-wrapper',
      '.player',
      '.video-player',
      '.player-wrapper',
      '.player-container',
      '.mod-player',
      '.qy-player',
      '.iqp-player',
      '.iqp-root',
      '.iqp-player-root',
      '.m-video-player',
      '[class*="player"]',
      '[id*="player"]'
    ].join(',');
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const asPlainRect = (rect) => {
      const left = Math.max(0, Math.round(rect.left));
      const top = Math.max(0, Math.round(rect.top));
      const right = Math.min(window.innerWidth, Math.round(rect.right));
      const bottom = Math.min(window.innerHeight, Math.round(rect.bottom));
      return {
        left,
        top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top)
      };
    };
    const isUsable = (rect) => {
      const viewportArea = window.innerWidth * window.innerHeight;
      const area = rect.width * rect.height;
      return rect.width >= 360 &&
        rect.height >= 200 &&
        rect.width <= window.innerWidth &&
        rect.height <= window.innerHeight &&
        area <= viewportArea * 0.82;
    };
    let best = null;
    for (const element of new Set([...document.querySelectorAll(selectors)])) {
      if (!isVisible(element)) {
        continue;
      }
      const rect = asPlainRect(element.getBoundingClientRect());
      if (!isUsable(rect)) {
        continue;
      }
      const area = rect.width * rect.height;
      const ratio = rect.width / Math.max(1, rect.height);
      const name = String((element.id || '') + ' ' + (element.className || '')).toLowerCase();
      const score = area +
        (ratio >= 1.2 && ratio <= 2.6 ? area * 0.22 : 0) +
        (/player|video|iqp|flashbox/.test(name) ? area * 0.2 : 0) +
        (element.tagName === 'VIDEO' ? area * 0.35 : 0) +
        (rect.top < window.innerHeight * 0.72 ? area * 0.12 : 0);
      if (!best || score > best.score) {
        best = { rect, score };
      }
    }
    return best ? best.rect : null;
  })();
`;
const PARSER_ERROR_TEXTS = [
  '解析失败',
  '解析错误',
  '播放失败',
  '加载失败',
  '视频加载失败',
  '无法播放',
  '视频不存在',
  '资源不存在',
  '参数错误',
  '接口失效',
  '接口异常',
  '解析超时',
  'not found',
  'failed',
  'playback error',
  'video error'
];

const elements = {
  platformList: document.getElementById('platformList'),
  interfaceSelect: document.getElementById('interfaceSelect'),
  parseCurrentButton: document.getElementById('parseCurrentButton'),
  autoParseToggle: document.getElementById('autoParseToggle'),
  clearHistoryButton: document.getElementById('clearHistoryButton'),
  historyList: document.getElementById('historyList'),
  backButton: document.getElementById('backButton'),
  forwardButton: document.getElementById('forwardButton'),
  reloadButton: document.getElementById('reloadButton'),
  addressForm: document.getElementById('addressForm'),
  addressInput: document.getElementById('addressInput'),
  browserTab: document.getElementById('browserTab'),
  contentArea: document.querySelector('.content-area'),
  playerTab: document.getElementById('playerTab'),
  browserView: document.getElementById('browserView'),
  playerView: document.getElementById('playerView'),
  emptyPlayer: document.getElementById('emptyPlayer'),
  statusText: document.getElementById('statusText'),
  detectedBadge: document.getElementById('detectedBadge')
};

function configurePlayerWebview(webview) {
  webview.id = 'playerView';
  webview.className = 'webview';
  webview.setAttribute('allowpopups', '');
  if (state.guestPreloadPath) {
    webview.setAttribute('preload', state.guestPreloadPath);
  }
  if (state.userAgent) {
    webview.setAttribute('useragent', state.userAgent);
  }
  webview.setAttribute('nodeintegrationinsubframes', '');
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
  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
}

function currentInterface() {
  return DEFAULT_INTERFACES.find((item) => item.id === state.currentInterfaceId) || DEFAULT_INTERFACES[0];
}

function interfaceAt(index) {
  return DEFAULT_INTERFACES[index] || DEFAULT_INTERFACES[0];
}

function clearParserHealthTimer() {
  if (state.parserHealthTimer) {
    clearTimeout(state.parserHealthTimer);
    state.parserHealthTimer = null;
  }
}

function supportedPatternPayload() {
  return PLATFORMS.flatMap((platform) =>
    platform.patterns.map((pattern) => ({
      source: pattern.source,
      flags: pattern.flags
    }))
  );
}

function syncClickParserConfig() {
  try {
    elements.browserView.send('click-parser-config', {
      enabled: state.autoParse,
      patterns: supportedPatternPayload()
    });
  } catch (_error) {
    // The guest page may not be ready yet; dom-ready will send the same config.
  }
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

const PLATFORM_VISUALS = {
  iqiyi: { label: 'iQIYI', icon: 'iQIYI', iconSrc: './assets/icons/iqiyi.png', className: 'platform-iqiyi' },
  youku: { label: '优酷', icon: 'YOUKU', iconSrc: './assets/icons/youku.png', className: 'platform-youku' },
  tencent: { label: '腾讯视频', icon: '腾讯', iconSrc: './assets/icons/tencent.png', className: 'platform-tencent' },
  mgtv: { label: '芒果TV', icon: 'MGTV', iconSrc: './assets/icons/mgtv.png', className: 'platform-mgtv' },
  bilibili: { label: '哔哩哔哩', icon: 'BILI', iconSrc: './assets/icons/bilibili.png', className: 'platform-bilibili' },
  sohu: { label: '搜狐视频', icon: '搜狐', iconSrc: './assets/icons/sohu.png', className: 'platform-sohu' },
  le: { label: '乐视视频', icon: '乐视', iconSrc: './assets/icons/le.png', className: 'platform-le' }
};

function platformVisual(platformId) {
  return PLATFORM_VISUALS[platformId] || { label: '视频站点', icon: 'V', className: 'platform-default' };
}

function createLogoElement(visual, className) {
  const image = document.createElement('img');
  image.className = className;
  image.src = visual.iconSrc;
  image.alt = '';
  image.decoding = 'async';
  image.addEventListener(
    'error',
    () => {
      const fallback = document.createElement('span');
      fallback.className = 'logo-fallback';
      fallback.textContent = visual.icon;
      image.replaceWith(fallback);
    },
    { once: true }
  );
  return image;
}

function createHistoryFallbackThumb(thumb, visual) {
  if (visual.iconSrc) {
    thumb.appendChild(createLogoElement(visual, 'history-logo'));
    return;
  }

  const fallback = document.createElement('span');
  fallback.className = 'logo-fallback';
  fallback.textContent = visual.icon;
  thumb.appendChild(fallback);
}

function createHistoryCoverElement(item, visual, thumb) {
  const image = document.createElement('img');
  image.className = 'history-cover';
  image.src = item.coverUrl;
  image.alt = '';
  image.decoding = 'async';
  image.addEventListener(
    'error',
    () => {
      thumb.classList.remove('has-cover');
      thumb.replaceChildren();
      createHistoryFallbackThumb(thumb, visual);
    },
    { once: true }
  );
  return image;
}

function cleanMediaTitle(value, platformName = '') {
  if (typeof value !== 'string') {
    return '';
  }

  let title = value
    .replace(/\s+/g, ' ')
    .replace(/[\r\n\t]/g, ' ')
    .trim();

  if (!title) {
    return '';
  }

  const separatorPattern = '\\s*[-_|｜—–]+\\s*';
  const suffixes = [
    platformName,
    'iQIYI',
    '爱奇艺',
    '优酷',
    '腾讯视频',
    '芒果TV',
    '哔哩哔哩',
    '搜狐视频',
    '乐视视频',
    '及相关视频',
    '高清在线观看',
    '视频在线观看',
    '免费观看',
    '全集',
    '正片',
    '预告片',
    '电影',
    '电视剧'
  ].filter(Boolean);

  for (const suffix of suffixes) {
    title = title.replace(new RegExp(`${separatorPattern}${suffix}.*$`, 'i'), '');
  }

  title = title.trim();

  if (!title) {
    return '';
  }
  if (/^(?:iQIYI|爱奇艺|优酷|腾讯视频|芒果TV|哔哩哔哩|搜狐视频|乐视视频)$/i.test(title)) {
    return '';
  }
  if (/热门独播|高清在线观看|在线视频|全网搜|开通会员|首页|频道/.test(title)) {
    return '';
  }
  if (/^(免费|vip|独播|限免|热播|推荐|最新|更多|更新至|全\d+集|\d+集全|\d+\.?\d*|[\d-]+期)$/i.test(title)) {
    return '';
  }
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(title)) {
    return '';
  }
  if (/^(限免|更新至|会员看|vip)?\d+[-~至]\d+[集期]$/i.test(title)) {
    return '';
  }
  if (/^第?\d+[集期]$/.test(title)) {
    return '';
  }
  if (/^(关闭弹幕|打开弹幕|弹幕|播放|暂停|全屏|退出全屏|清晰度|倍速|音量|静音)$/i.test(title)) {
    return '';
  }

  return title;
}

function historyDisplayTitle(item) {
  return (
    cleanMediaTitle(item.mediaTitle || '', item.platformName) ||
    cleanMediaTitle(item.title || '', item.platformName) ||
    item.platformName ||
    '未命名视频'
  );
}

function formatHistoryTime(value) {
  if (!value) {
    return '';
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return '';
  }

  const diffMs = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return '刚刚';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}分钟前`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}小时前`;
  if (diffMs < day * 7) return `${Math.floor(diffMs / day)}天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function historyMetaText(item, visual, timeText) {
  const parts = [item.platformName || visual.label];
  if (item.vodType) {
    parts.push(item.vodType);
  }
  if (item.vodUpdateTo) {
    parts.push(item.vodUpdateTo);
  } else if (item.vodYear) {
    parts.push(item.vodYear.replace(/^视频时长[:：]?/u, ''));
  }
  if (timeText) {
    parts.push(timeText);
  }
  return parts.filter(Boolean).join(' · ');
}

function saveState() {
  window.superVip.saveState({
    currentInterfaceId: state.currentInterfaceId,
    autoParse: state.autoParse,
    history: state.history
  });
}

function renderPlatforms() {
  elements.platformList.innerHTML = '';
  for (const platform of PLATFORMS) {
    const visual = platformVisual(platform.id);
    const button = document.createElement('button');
    button.className = 'platform-button';
    button.type = 'button';

    const icon = document.createElement('span');
    icon.className = `platform-icon ${visual.className}`;
    if (visual.iconSrc) {
      icon.appendChild(createLogoElement(visual, 'platform-logo'));
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'logo-fallback';
      fallback.textContent = visual.icon;
      icon.appendChild(fallback);
    }

    const name = document.createElement('span');
    name.className = 'platform-name';
    name.textContent = platform.name;

    button.append(icon, name);
    button.dataset.platformId = platform.id;
    button.addEventListener('click', () => openPlatform(platform));
    elements.platformList.appendChild(button);
  }
}

function renderInterfaces() {
  elements.interfaceSelect.innerHTML = '';
  DEFAULT_INTERFACES.forEach((parserInterface, index) => {
    const option = document.createElement('option');
    option.value = parserInterface.id;
    option.textContent = index === 0 ? '默认接口（推荐）' : `备用接口 ${index}`;
    option.title = parserInterface.url;
    elements.interfaceSelect.appendChild(option);
  });
  elements.interfaceSelect.value = state.currentInterfaceId;
}

function renderHistory() {
  elements.historyList.innerHTML = '';
  if (state.history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-meta';
    empty.textContent = '暂无历史';
    elements.historyList.appendChild(empty);
    return;
  }

  for (const item of state.history) {
    const visual = platformVisual(item.platformId);
    const timeText = formatHistoryTime(item.createdAt);
    const button = document.createElement('button');
    button.className = 'history-button';
    button.type = 'button';
    button.title = item.originalUrl;

    const thumb = document.createElement('span');
    thumb.className = item.coverUrl ? 'history-thumb has-cover' : `history-thumb ${visual.className}`;
    if (item.coverUrl) {
      thumb.appendChild(createHistoryCoverElement(item, visual, thumb));
    } else {
      createHistoryFallbackThumb(thumb, visual);
    }

    const copy = document.createElement('span');
    copy.className = 'history-copy';
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = historyDisplayTitle(item);
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    meta.textContent = historyMetaText(item, visual, timeText);
    copy.append(title, meta);

    button.append(thumb, copy);
    button.addEventListener('click', () => parseVideoUrl(item.originalUrl, item.title, false));
    elements.historyList.appendChild(button);
  }
}

function renderDetectedState() {
  elements.parseCurrentButton.disabled = !state.currentPlatformInfo;
  elements.detectedBadge.classList.toggle('is-hidden', !state.currentPlatformInfo);
  if (state.currentPlatformInfo) {
    elements.detectedBadge.textContent = `已识别：${state.currentPlatformInfo.platform.name}`;
  }

  for (const button of elements.platformList.querySelectorAll('.platform-button')) {
    button.classList.toggle('is-active', button.dataset.platformId === state.selectedPlatformId);
  }
}

function setWebviewAudioMuted(webview, muted) {
  try {
    if (typeof webview.setAudioMuted === 'function') {
      webview.setAudioMuted(muted);
    }
  } catch (_error) {
    // Some webview methods are unavailable before the guest contents exist.
  }
}

function pauseWebviewMedia(webview) {
  try {
    if (typeof webview.executeJavaScript === 'function') {
      webview.executeJavaScript(PAUSE_EMBEDDED_MEDIA_SCRIPT, true).catch(() => {});
    }
  } catch (_error) {
    // Navigation may already be in progress; muting still prevents leaked audio.
  }
}

function stopWebviewPlayback(webview) {
  setWebviewAudioMuted(webview, true);
  pauseWebviewMedia(webview);
}

function clearPendingInlineReplace() {
  if (state.pendingInlineReplaceTimer) {
    clearTimeout(state.pendingInlineReplaceTimer);
    state.pendingInlineReplaceTimer = null;
  }
  state.pendingInlineReplaceAfterLoad = false;
  state.pendingInlinePlayerRect = null;
  state.pendingInlineTargetUrl = '';
  state.pendingInlineReplaceDeadline = 0;
}

async function detectBrowserPlaybackRect() {
  try {
    if (typeof elements.browserView.executeJavaScript === 'function') {
      return await elements.browserView.executeJavaScript(BROWSER_PLAYBACK_RECT_SCRIPT, true);
    }
  } catch (_error) {
    // The official page may be navigating; inline playback has a layout fallback.
  }
  return null;
}

function currentBrowserPageUrl() {
  try {
    return elements.browserView.getURL() || state.currentUrl || '';
  } catch (_error) {
    return state.currentUrl || '';
  }
}

function pageIdentity(url) {
  if (!url) {
    return '';
  }

  try {
    const parsedUrl = new URL(url);
    parsedUrl.hash = '';
    return parsedUrl.href;
  } catch (_error) {
    return url;
  }
}

function isSameInlineSourcePage() {
  return Boolean(
    state.inlinePlayerActive &&
      state.inlineSourcePageUrl &&
      state.inlineSourcePageUrl === pageIdentity(currentBrowserPageUrl())
  );
}

function normalizeInlinePlayerRect(rect) {
  if (!rect || typeof rect !== 'object') {
    return null;
  }

  const contentRect = elements.contentArea.getBoundingClientRect();
  const left = Number(rect.left);
  const top = Number(rect.top);
  const width = Number(rect.width);
  const height = Number(rect.height);

  if (![left, top, width, height].every(Number.isFinite) || width < 240 || height < 135) {
    return null;
  }

  const boundedLeft = Math.max(0, Math.min(left, contentRect.width - 120));
  const boundedTop = Math.max(0, Math.min(top, contentRect.height - 90));
  const boundedWidth = Math.max(120, Math.min(width, contentRect.width - boundedLeft));
  const boundedHeight = Math.max(90, Math.min(height, contentRect.height - boundedTop));

  return {
    left: Math.round(boundedLeft),
    top: Math.round(boundedTop),
    width: Math.round(boundedWidth),
    height: Math.round(boundedHeight)
  };
}

function applyInlinePlayerRect(rect) {
  const nextRect = normalizeInlinePlayerRect(rect);
  if (!nextRect) {
    return false;
  }

  state.inlinePlayerRect = nextRect;
  Object.assign(elements.playerView.style, {
    left: `${nextRect.left}px`,
    top: `${nextRect.top}px`,
    width: `${nextRect.width}px`,
    height: `${nextRect.height}px`
  });
  return true;
}

function setInlinePlayerTracking(enabled) {
  try {
    elements.browserView.send('inline-player-tracking', { enabled });
  } catch (_error) {
    // The guest page may not be ready or may already be navigating.
  }
}

function clearInlinePlayer() {
  if (!state.inlinePlayerActive) {
    return;
  }

  state.inlinePlayerActive = false;
  state.inlinePlayerRect = null;
  state.inlineSourcePageUrl = '';
  setInlinePlayerTracking(false);
  if (!state.pendingInlineReplaceAfterLoad) {
    clearPendingInlineReplace();
  }
  if (state.parseSession?.inlinePlayer) {
    clearParserHealthTimer();
    state.parseSession = null;
  }
  stopWebviewPlayback(elements.playerView);
  elements.playerView.classList.remove('is-active', 'inline-player-view');
  elements.playerView.removeAttribute('style');
  try {
    elements.playerView.src = 'about:blank';
  } catch (_error) {
    // The player may already be detached while a page is navigating.
  }
  syncWebviewPlaybackForActiveView();
}

function recreatePlayerView() {
  const oldPlayerView = elements.playerView;
  const nextPlayerView = document.createElement('webview');
  configurePlayerWebview(nextPlayerView);

  stopWebviewPlayback(oldPlayerView);
  try {
    if (typeof oldPlayerView.stop === 'function') {
      oldPlayerView.stop();
    }
    oldPlayerView.src = 'about:blank';
  } catch (_error) {
    // The old guest may already be navigating or detached.
  }

  oldPlayerView.replaceWith(nextPlayerView);
  elements.playerView = nextPlayerView;
  bindWebviewEvents(nextPlayerView, 'player');
  return nextPlayerView;
}

function showInlineParsedPlayer(parsedUrl, rect) {
  const playerView = recreatePlayerView();
  state.inlinePlayerActive = true;
  state.activeView = 'browser';
  state.inlinePlayerRect = null;
  state.inlineSourcePageUrl = pageIdentity(currentBrowserPageUrl());

  elements.browserView.classList.add('is-active');
  elements.playerView.classList.remove('is-active');
  elements.emptyPlayer.classList.remove('is-active');
  elements.browserTab.classList.add('is-active');
  elements.playerTab.classList.remove('is-active');

  if (!applyInlinePlayerRect(rect)) {
    const contentRect = elements.contentArea.getBoundingClientRect();
    applyInlinePlayerRect({
      left: Math.round(contentRect.width * 0.04),
      top: Math.round(contentRect.height * 0.08),
      width: Math.round(contentRect.width * 0.72),
      height: Math.round(contentRect.height * 0.72)
    });
  }

  playerView.classList.add('inline-player-view', 'is-active');
  stopWebviewPlayback(elements.browserView);
  setWebviewAudioMuted(playerView, false);
  playerView.src = parsedUrl;
  setInlinePlayerTracking(true);
}

function replaceInlineParsedPlayer(parsedUrl, rect) {
  if (!state.inlinePlayerActive) {
    showInlineParsedPlayer(parsedUrl, rect);
    return;
  }

  state.activeView = 'browser';
  if (!state.inlinePlayerRect) {
    applyInlinePlayerRect(rect);
  }

  elements.browserView.classList.add('is-active');
  elements.playerView.classList.add('inline-player-view', 'is-active');
  elements.emptyPlayer.classList.remove('is-active');
  elements.browserTab.classList.add('is-active');
  elements.playerTab.classList.remove('is-active');

  stopWebviewPlayback(elements.playerView);
  stopWebviewPlayback(elements.browserView);
  try {
    if (typeof elements.playerView.stop === 'function') {
      elements.playerView.stop();
    }
  } catch (_error) {
    // The previous parser page may already be leaving.
  }
  elements.playerView.src = parsedUrl;
  setWebviewAudioMuted(elements.playerView, false);
  setInlinePlayerTracking(true);
}

function syncWebviewPlaybackForActiveView() {
  const browserActive = state.activeView === 'browser' && !state.inlinePlayerActive;
  const playerActive = state.inlinePlayerActive || (state.activeView === 'player' && Boolean(state.lastParsedUrl));

  setWebviewAudioMuted(elements.browserView, !browserActive);
  setWebviewAudioMuted(elements.playerView, !playerActive);

  if (!browserActive) {
    pauseWebviewMedia(elements.browserView);
  }
  if (!playerActive) {
    pauseWebviewMedia(elements.playerView);
  }
}

function switchView(view) {
  if (state.inlinePlayerActive && view !== 'browser') {
    clearInlinePlayer();
  }

  state.activeView = view;
  document.body.dataset.activeView = view;
  elements.browserTab.classList.toggle('is-active', view === 'browser');
  elements.playerTab.classList.toggle('is-active', view === 'player');
  elements.browserView.classList.toggle('is-active', view === 'browser' || state.inlinePlayerActive);
  elements.playerView.classList.toggle('is-active', state.inlinePlayerActive || (view === 'player' && Boolean(state.lastParsedUrl)));
  elements.emptyPlayer.classList.toggle('is-active', view === 'player' && !state.lastParsedUrl);
  syncWebviewPlaybackForActiveView();
}

function rememberHistory(entry) {
  state.history = [
    entry,
    ...state.history.filter((item) => item.originalUrl !== entry.originalUrl)
  ].slice(0, 30);
  renderHistory();
  saveState();
}

function updateHistoryEntry(originalUrl, updater) {
  let changed = false;
  state.history = state.history.map((item) => {
    if (item.originalUrl !== originalUrl) {
      return item;
    }

    const nextItem = updater(item);
    changed = changed || nextItem !== item;
    return nextItem;
  });

  if (changed) {
    renderHistory();
    saveState();
  }
}

function updateHistoryParserUrl(originalUrl, parsedUrl) {
  updateHistoryEntry(originalUrl, (item) => {
    if (item.parsedUrl === parsedUrl) {
      return item;
    }
    return { ...item, parsedUrl };
  });
}

function updateHistoryMetadata(originalUrl, metadata) {
  if (metadata?.source !== 'api') {
    return;
  }

  const mediaTitle = cleanMediaTitle(metadata?.title || '', metadata?.platformName);
  const coverUrl = typeof metadata?.coverUrl === 'string' ? metadata.coverUrl : '';
  const source = metadata?.source || 'page';
  const hasApiFields = Boolean(metadata?.type || metadata?.year || metadata?.updateTo || metadata?.description);

  if (!mediaTitle && !coverUrl && !hasApiFields) {
    return;
  }

  updateHistoryEntry(originalUrl, (item) => {
    const nextTitle = mediaTitle;
    const nextCoverUrl = coverUrl;
    const nextTitleSource = nextTitle ? source : '';
    const nextCoverSource = nextCoverUrl ? source : '';
    const nextVodType = metadata?.type || item.vodType || '';
    const nextVodYear = metadata?.year || item.vodYear || '';
    const nextVodUpdateTo = metadata?.updateTo || item.vodUpdateTo || '';
    const nextVodDesc = metadata?.description || item.vodDesc || '';

    if (
      item.mediaTitle === nextTitle &&
      item.coverUrl === nextCoverUrl &&
      item.mediaTitleSource === nextTitleSource &&
      item.coverSource === nextCoverSource &&
      item.vodType === nextVodType &&
      item.vodYear === nextVodYear &&
      item.vodUpdateTo === nextVodUpdateTo &&
      item.vodDesc === nextVodDesc
    ) {
      return item;
    }
    return {
      ...item,
      mediaTitle: nextTitle,
      mediaTitleSource: nextTitleSource,
      coverUrl: nextCoverUrl,
      coverSource: nextCoverSource,
      vodType: nextVodType,
      vodYear: nextVodYear,
      vodUpdateTo: nextVodUpdateTo,
      vodDesc: nextVodDesc
    };
  });
}

async function fetchApiVideoMetadata(videoUrl) {
  const metadataUrl = `https://dmku.hls.one/?ac=list&url=${encodeURIComponent(videoUrl)}`;
  console.info('[SuperVip] request metadata api', {
    metadataUrl,
    metadataRequestVideoUrl: videoUrl
  });

  const metadata = await window.superVip.fetchVideoMetadata(videoUrl).catch((error) => {
    console.warn('[SuperVip] metadata api rejected', {
      metadataRequestVideoUrl: videoUrl,
      message: error?.message || String(error)
    });
    return null;
  });
  if (!metadata || typeof metadata !== 'object') {
    console.warn('[SuperVip] metadata api empty', {
      metadataRequestVideoUrl: videoUrl
    });
    return null;
  }

  const result = {
    title: metadata.title || '',
    coverUrl: metadata.coverUrl || '',
    type: metadata.type || '',
    year: metadata.year || '',
    updateTo: metadata.updateTo || '',
    description: metadata.description || '',
    episodesCount: Number.isInteger(metadata.episodesCount) ? metadata.episodesCount : 0,
    source: 'api'
  };

  console.info('[SuperVip] metadata api mapped', {
    metadataRequestVideoUrl: videoUrl,
    title: result.title,
    type: result.type,
    updateTo: result.updateTo,
    hasCover: Boolean(result.coverUrl),
    episodesCount: result.episodesCount
  });

  return result;
}

function hasValidApiVideoMetadata(metadata) {
  return Boolean(
    metadata &&
      metadata.source === 'api' &&
      metadata.title &&
      (metadata.coverUrl || metadata.updateTo || metadata.type || metadata.episodesCount > 0)
  );
}

function nextInterfaceIndex(session) {
  for (let index = session.interfaceIndex + 1; index < DEFAULT_INTERFACES.length; index += 1) {
    if (!session.triedInterfaceIds.includes(DEFAULT_INTERFACES[index].id)) {
      return index;
    }
  }
  return -1;
}

function failoverParser(sessionId, reason = '') {
  const session = state.parseSession;
  if (!session || session.id !== sessionId) {
    return false;
  }

  clearParserHealthTimer();

  const nextIndex = nextInterfaceIndex(session);
  if (nextIndex === -1) {
    setStatus(reason ? `解析失败：${reason}，已尝试所有可用线路。` : '解析失败，已尝试所有可用线路。');
    return false;
  }

  setStatus('解析失败，正在尝试备用线路...');
  parseVideoUrl(session.originalUrl, session.title, session.shouldRemember, {
    interfaceIndex: nextIndex,
    triedInterfaceIds: session.triedInterfaceIds,
    metadata: session.metadata,
    inlinePlayer: session.inlinePlayer === true,
    inlinePlayerRect: session.inlinePlayerRect || state.inlinePlayerRect
  });
  return true;
}

function parserHealthScript() {
  return `
    (() => {
      const errorTexts = ${JSON.stringify(PARSER_ERROR_TEXTS)};
      const bodyText = (document.body ? document.body.innerText : '')
        .replace(/\\s+/g, ' ')
        .trim()
        .toLowerCase();
      const hasErrorText = errorTexts.some((text) => bodyText.includes(text.toLowerCase()));
      const selectors = [
        'video',
        'iframe',
        'object',
        'embed',
        'canvas',
        '.art-video-player',
        '.dplayer',
        '.prism-player',
        '.player-wrapper',
        '.video-player',
        '#player',
        '#video',
        '#Xmflv'
      ];
      const hasVisibleMedia = selectors.some((selector) => {
        return Array.from(document.querySelectorAll(selector)).some((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width >= 240 &&
            rect.height >= 120 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || '1') > 0.05;
        });
      });
      return { hasErrorText, hasVisibleMedia };
    })();
  `;
}

function scheduleParserHealthCheck(sessionId, delay = PARSER_HEALTH_CHECK_DELAY_MS) {
  clearParserHealthTimer();
  state.parserHealthTimer = setTimeout(() => {
    validateParserHealth(sessionId);
  }, delay);
}

async function validateParserHealth(sessionId) {
  const session = state.parseSession;
  if (!session || session.id !== sessionId) {
    return;
  }

  try {
    const result = await elements.playerView.executeJavaScript(parserHealthScript(), true);
    if (!state.parseSession || state.parseSession.id !== sessionId) {
      return;
    }

    if (result?.hasErrorText && !result?.hasVisibleMedia) {
      failoverParser(sessionId, '当前线路返回失败');
      return;
    }

    if (!result?.hasVisibleMedia) {
      const elapsedMs = Date.now() - session.startedAt;
      if (elapsedMs >= PARSER_LOAD_TIMEOUT_MS) {
        failoverParser(sessionId, '当前线路未加载播放器');
        return;
      }
      scheduleParserHealthCheck(sessionId, PARSER_HEALTH_RECHECK_DELAY_MS);
      return;
    }

    clearParserHealthTimer();
    setStatus('解析播放已加载。');
  } catch (_error) {
    failoverParser(sessionId, '当前线路检测失败');
  }
}

async function refreshHistoryFromApi() {
  const targets = state.history
    .filter((item) => item.originalUrl && detectPlatform(item.originalUrl))
    .slice(0, 20);

  for (const item of targets) {
    const metadata = await fetchApiVideoMetadata(item.originalUrl);
    if (!hasValidApiVideoMetadata(metadata)) {
      continue;
    }
    updateHistoryMetadata(item.originalUrl, {
      ...metadata,
      platformName: item.platformName
    });
  }
}

async function rememberHistoryFromApi(videoUrl, parsedUrl, platformInfo) {
  console.info('[SuperVip] async history metadata request', {
    metadataRequestVideoUrl: videoUrl,
    parseVideoUrl: videoUrl
  });

  const metadata = await fetchApiVideoMetadata(videoUrl);
  if (!hasValidApiVideoMetadata(metadata)) {
    console.warn('[SuperVip] async history skipped: invalid metadata', {
      metadataRequestVideoUrl: videoUrl,
      parseVideoUrl: videoUrl
    });
    return;
  }

  const currentParsedUrl = latestParsedUrls.get(videoUrl) || parsedUrl;
  const title = cleanMediaTitle(metadata.title || '', platformInfo.platform.name);
  rememberHistory({
    originalUrl: videoUrl,
    parsedUrl: currentParsedUrl,
    title,
    mediaTitle: title,
    mediaTitleSource: 'api',
    coverUrl: metadata.coverUrl || '',
    coverSource: metadata.coverUrl ? 'api' : '',
    platformId: platformInfo.platform.id,
    platformName: platformInfo.platform.name,
    vodType: metadata.type || '',
    vodYear: metadata.year || '',
    vodUpdateTo: metadata.updateTo || '',
    vodDesc: metadata.description || '',
    createdAt: new Date().toISOString()
  });
}

function parseVideoUrl(videoUrl, title = '', shouldRemember = true, options = {}) {
  const platformInfo = detectPlatform(videoUrl);
  if (!platformInfo) {
    setStatus('当前地址不是已支持的视频页。');
    return;
  }

  clearParserHealthTimer();

  const isRetry = Boolean(options.triedInterfaceIds);
  const apiMetadata = hasValidApiVideoMetadata(options.metadata) ? options.metadata : null;

  const interfaceIndex = Number.isInteger(options.interfaceIndex) ? options.interfaceIndex : 0;
  const parserInterface = interfaceAt(interfaceIndex);
  const triedInterfaceIds = Array.isArray(options.triedInterfaceIds) ? [...options.triedInterfaceIds] : [];
  if (!triedInterfaceIds.includes(parserInterface.id)) {
    triedInterfaceIds.push(parserInterface.id);
  }
  const inlinePlayer = options.inlinePlayer === true;
  const directInlineReplace = inlinePlayer && isSameInlineSourcePage();
  const inlinePlayerRect = normalizeInlinePlayerRect(options.inlinePlayerRect) ||
    (inlinePlayer && state.inlinePlayerActive ? state.inlinePlayerRect : null);
  const parsedUrl = generateParseUrl(parserInterface.url, videoUrl);
  latestParsedUrls.set(videoUrl, parsedUrl);
  const metadataRequestVideoUrl = shouldRemember ? videoUrl : '';
  console.info('[SuperVip] parse url generated', {
    metadataRequestVideoUrl,
    parseVideoUrl: videoUrl,
    parserInterface: parserInterface.name,
    parsedUrl,
    sameRequestAndParseUrl: !metadataRequestVideoUrl || metadataRequestVideoUrl === videoUrl
  });
  const sessionId = nextParseSessionId++;

  state.parseSession = {
    id: sessionId,
    originalUrl: videoUrl,
    title: apiMetadata?.title || title,
    shouldRemember,
    platformName: platformInfo.platform.name,
    metadata: apiMetadata,
    interfaceIndex,
    triedInterfaceIds,
    inlinePlayer,
    inlinePlayerRect,
    startedAt: Date.now()
  };
  state.currentInterfaceId = parserInterface.id;
  state.lastParsedUrl = parsedUrl;
  if (state.parseSession.inlinePlayer) {
    if (directInlineReplace) {
      replaceInlineParsedPlayer(parsedUrl, state.parseSession.inlinePlayerRect);
    } else {
      showInlineParsedPlayer(parsedUrl, state.parseSession.inlinePlayerRect);
    }
  } else {
    clearInlinePlayer();
    stopWebviewPlayback(elements.browserView);
    const playerView = recreatePlayerView();
    playerView.src = parsedUrl;
    switchView('player');
  }
  setStatus(`正在加载解析播放：${platformInfo.platform.name}`);
  scheduleParserHealthCheck(sessionId, PARSER_LOAD_TIMEOUT_MS);

  if (shouldRemember && isRetry) {
    updateHistoryParserUrl(videoUrl, parsedUrl);
  } else if (shouldRemember) {
    rememberHistoryFromApi(videoUrl, parsedUrl, platformInfo);
  }
}

function handleCandidateUrl(url, title = '') {
  const platformInfo = detectPlatform(url);
  state.currentPlatformInfo = platformInfo;
  if (platformInfo) {
    state.detectedVideoUrl = url;
    state.detectedVideoTitle = '';
    state.selectedPlatformId = platformInfo.platform.id;
    setStatus(`识别到 ${platformInfo.platform.name} 视频页：${url}`);
  } else {
    state.detectedVideoUrl = '';
    state.detectedVideoTitle = '';
    setStatus(url ? `当前页面：${url}` : '页面已加载。');
  }
  renderDetectedState();
}

function handleBrowserPopupUrl(url, title = '') {
  if (!url || !/^https?:\/\//i.test(url)) {
    return;
  }

  loadBrowserUrl(url);
}

async function handleCandidateLink(payload) {
  if (!payload) {
    return;
  }

  const payloadHref = typeof payload.href === 'string' ? payload.href : '';
  const detectedHref = payloadHref && detectPlatform(payloadHref) ? payloadHref : '';
  const currentPageUrl = currentBrowserPageUrl();
  const fallbackHref = payload.useCurrentPage ? (currentPageUrl || state.currentUrl || state.detectedVideoUrl) : '';
  const targetHref = detectedHref || (fallbackHref && detectPlatform(fallbackHref) ? fallbackHref : '');

  if (!targetHref) {
    return;
  }

  state.detectedVideoUrl = targetHref;
  state.detectedVideoTitle = '';
  state.currentPlatformInfo = detectPlatform(targetHref);
  state.selectedPlatformId = state.currentPlatformInfo.platform.id;
  renderDetectedState();

  const playbackRect = payload.playbackRect || state.inlinePlayerRect || await detectBrowserPlaybackRect();
  parseVideoUrl(targetHref, '', true, {
    inlinePlayer: true,
    inlinePlayerRect: playbackRect
  });
}

function beginInlineFollowupNavigation(payload = {}) {
  const payloadHref = typeof payload.href === 'string' ? payload.href : '';
  state.pendingInlineReplaceAfterLoad = true;
  state.pendingInlinePlayerRect = payload.playbackRect || state.inlinePlayerRect;
  state.pendingInlineTargetUrl = payloadHref && detectPlatform(payloadHref) ? payloadHref : '';
  state.pendingInlineReplaceDeadline = Date.now() + 10000;

  if (state.pendingInlineReplaceTimer) {
    clearTimeout(state.pendingInlineReplaceTimer);
  }

  state.pendingInlineReplaceTimer = setTimeout(() => {
    if (state.pendingInlineReplaceAfterLoad && Date.now() >= state.pendingInlineReplaceDeadline) {
      clearPendingInlineReplace();
    }
  }, 10000);

  setStatus('已切换剧集，等待页面加载完成后替换播放...');
}

function schedulePendingInlineReplace(reason, delay = 0) {
  if (!state.pendingInlineReplaceAfterLoad) {
    return;
  }

  if (state.pendingInlineReplaceTimer) {
    clearTimeout(state.pendingInlineReplaceTimer);
  }

  state.pendingInlineReplaceTimer = setTimeout(() => {
    state.pendingInlineReplaceTimer = null;
    runPendingInlineReplace(reason).catch((error) => {
      console.warn('[SuperVip] failed to replace inline player after navigation', error);
    });
  }, delay);
}

async function runPendingInlineReplace(reason = '') {
  if (!state.pendingInlineReplaceAfterLoad) {
    return;
  }

  if (state.browserLoading) {
    schedulePendingInlineReplace(reason, 500);
    return;
  }

  const currentPageUrl = currentBrowserPageUrl();
  let targetHref = currentPageUrl && detectPlatform(currentPageUrl) ? currentPageUrl : '';
  if (!targetHref) {
    if (Date.now() < state.pendingInlineReplaceDeadline) {
      schedulePendingInlineReplace(reason, 700);
      return;
    }
    targetHref = state.pendingInlineTargetUrl;
  }

  if (!targetHref || !detectPlatform(targetHref)) {
    clearPendingInlineReplace();
    return;
  }

  const playbackRect = state.pendingInlinePlayerRect || state.inlinePlayerRect || await detectBrowserPlaybackRect();
  clearPendingInlineReplace();
  parseVideoUrl(targetHref, '', true, {
    inlinePlayer: true,
    inlinePlayerRect: playbackRect
  });
}

function loadBrowserUrl(url, options = {}) {
  const nextUrl = normalizeUrl(url);
  if (!nextUrl) {
    return;
  }

  clearInlinePlayer();
  state.currentUrl = nextUrl;
  elements.addressInput.value = nextUrl;
  elements.browserView.setAttribute('useragent', state.userAgent);
  elements.browserView.src = nextUrl;
  switchView('browser');
  if (!options.skipImmediateDetection) {
    handleCandidateUrl(nextUrl);
  }
}

function openPlatform(platform) {
  state.selectedPlatformId = platform.id;
  renderDetectedState();
  loadBrowserUrl(platform.homeUrl);
}

function bindWebviewEvents(webview, type) {
  webview.addEventListener('dom-ready', () => {
    if (type === 'browser') {
      syncClickParserConfig();
    }
  });

  webview.addEventListener('did-start-loading', () => {
    if (type === 'browser') {
      state.browserLoading = true;
    }
    setStatus(type === 'browser' ? '官网页面加载中...' : '解析页面加载中...');
  });

  webview.addEventListener('did-finish-load', () => {
    if (type === 'browser') {
      state.browserLoading = false;
      state.currentTitle = webview.getTitle();
      state.currentUrl = webview.getURL();
      elements.addressInput.value = state.currentUrl;
      handleCandidateUrl(state.currentUrl, state.currentTitle);
      schedulePendingInlineReplace('did-finish-load', 250);
    } else {
      setStatus('解析页面已加载，正在检测播放状态。');
      if (state.parseSession) {
        scheduleParserHealthCheck(state.parseSession.id);
      }
    }
  });

  webview.addEventListener('did-stop-loading', () => {
    if (type === 'browser') {
      state.browserLoading = false;
      schedulePendingInlineReplace('did-stop-loading', 350);
    }
  });

  webview.addEventListener('did-fail-load', (event) => {
    if (event.errorCode === -3) {
      return;
    }

    if (type === 'player' && state.parseSession) {
      failoverParser(state.parseSession.id, event.errorDescription || '当前线路加载失败');
      return;
    }

    if (type === 'browser') {
      state.browserLoading = false;
      setStatus(event.errorDescription ? `页面加载失败：${event.errorDescription}` : '页面加载失败。');
    }
  });

  webview.addEventListener('did-navigate', (event) => {
    if (type === 'browser') {
      state.currentUrl = event.url;
      elements.addressInput.value = event.url;
      handleCandidateUrl(event.url);
      schedulePendingInlineReplace('did-navigate', 1200);
    }
  });

  webview.addEventListener('did-navigate-in-page', (event) => {
    if (type === 'browser') {
      state.currentUrl = event.url;
      elements.addressInput.value = event.url;
      handleCandidateUrl(event.url);
      schedulePendingInlineReplace('did-navigate-in-page', 1200);
    }
  });

  webview.addEventListener('new-window', (event) => {
    if (type !== 'browser') {
      return;
    }

    event.preventDefault();
    handleBrowserPopupUrl(event.url, event.frameName || state.currentTitle);
  });

  webview.addEventListener('ipc-message', (event) => {
    if (event.channel === 'candidate-link') {
      const [payload] = event.args;
      const nextPayload = {
        ...payload,
        playbackRect: type === 'browser' ? payload?.playbackRect || state.inlinePlayerRect : state.inlinePlayerRect
      };
      handleCandidateLink(nextPayload).catch((error) => {
        console.warn('[SuperVip] failed to handle candidate link', error);
      });
      return;
    }

    if (type !== 'browser') {
      return;
    }

    if (event.channel === 'inline-followup-navigation') {
      const [payload] = event.args;
      beginInlineFollowupNavigation(payload);
    }
    if (event.channel === 'playback-rect') {
      const [payload] = event.args;
      if (state.inlinePlayerActive && payload?.rect && applyInlinePlayerRect(payload.rect) && state.parseSession) {
        state.parseSession.inlinePlayerRect = state.inlinePlayerRect;
      }
    }
    if (event.channel === 'page-ready') {
      const [payload] = event.args;
      if (payload && payload.url) {
        handleCandidateUrl(payload.url, payload.title);
        schedulePendingInlineReplace(payload.reason || 'page-ready', 1200);
      }
    }
  });
}

function bindControls() {
  elements.addressForm.addEventListener('submit', (event) => {
    event.preventDefault();
    loadBrowserUrl(elements.addressInput.value);
  });

  elements.backButton.addEventListener('click', () => {
    const active = state.activeView === 'player' ? elements.playerView : elements.browserView;
    if (active.canGoBack()) active.goBack();
  });

  elements.forwardButton.addEventListener('click', () => {
    const active = state.activeView === 'player' ? elements.playerView : elements.browserView;
    if (active.canGoForward()) active.goForward();
  });

  elements.reloadButton.addEventListener('click', () => {
    const active = state.activeView === 'player' ? elements.playerView : elements.browserView;
    active.reload();
  });

  elements.browserTab.addEventListener('click', () => switchView('browser'));
  elements.playerTab.addEventListener('click', () => switchView('player'));

  elements.interfaceSelect.addEventListener('change', () => {
    state.currentInterfaceId = elements.interfaceSelect.value;
    saveState();
  });

  elements.autoParseToggle.addEventListener('change', () => {
    state.autoParse = elements.autoParseToggle.checked;
    syncClickParserConfig();
    saveState();
    if (state.autoParse && state.currentPlatformInfo && state.detectedVideoUrl) {
      parseVideoUrl(state.detectedVideoUrl, state.detectedVideoTitle);
    }
  });

  elements.parseCurrentButton.addEventListener('click', () => {
    parseVideoUrl(
      state.detectedVideoUrl || state.currentUrl,
      state.detectedVideoTitle || state.currentTitle
    );
  });

  elements.clearHistoryButton.addEventListener('click', () => {
    state.history = [];
    renderHistory();
    saveState();
  });
}

async function init() {
  const persistedState = await window.superVip.loadState();
  state.currentInterfaceId = DEFAULT_INTERFACES[0].id;
  state.autoParse = true;
  state.history = Array.isArray(persistedState.history)
    ? persistedState.history.filter((item) => item.mediaTitleSource === 'api' && (!item.coverUrl || item.coverSource === 'api'))
    : [];
  state.guestPreloadPath = await window.superVip.getGuestPreloadPath();
  state.userAgent = await window.superVip.getUserAgent();

  elements.browserView.setAttribute('preload', state.guestPreloadPath);
  elements.playerView.setAttribute('preload', state.guestPreloadPath);
  elements.playerView.setAttribute('nodeintegrationinsubframes', '');
  elements.browserView.setAttribute('useragent', state.userAgent);
  elements.playerView.setAttribute('useragent', state.userAgent);
  elements.autoParseToggle.checked = state.autoParse;

  renderPlatforms();
  renderInterfaces();
  renderHistory();
  refreshHistoryFromApi();
  renderDetectedState();
  bindControls();
  bindWebviewEvents(elements.browserView, 'browser');
  bindWebviewEvents(elements.playerView, 'player');
  window.superVip.onBrowserPopupUrl((payload) => {
    if (payload && payload.url) {
      handleBrowserPopupUrl(payload.url, payload.frameName || state.currentTitle);
    }
  });
  openPlatform(PLATFORMS[0]);
}

init().catch((error) => {
  console.error(error);
  setStatus(`初始化失败：${error.message}`);
});
