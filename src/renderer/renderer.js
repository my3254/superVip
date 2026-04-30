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
  pendingAutoParse: false,
  pendingAutoParseTimer: null,
  pendingAutoParseExpireTimer: null,
  pendingClickMetadata: null,
  parseSession: null,
  parserHealthTimer: null,
  activeView: 'browser'
};

let nextParseSessionId = 1;

const PARSER_LOAD_TIMEOUT_MS = 12000;
const PARSER_HEALTH_CHECK_DELAY_MS = 4500;
const PARSER_HEALTH_RECHECK_DELAY_MS = 2500;
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
  playerTab: document.getElementById('playerTab'),
  browserView: document.getElementById('browserView'),
  playerView: document.getElementById('playerView'),
  emptyPlayer: document.getElementById('emptyPlayer'),
  statusText: document.getElementById('statusText'),
  detectedBadge: document.getElementById('detectedBadge')
};

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
    meta.textContent = `${item.platformName || visual.label}${timeText ? ` · ${timeText}` : ''}`;
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

function switchView(view) {
  state.activeView = view;
  document.body.dataset.activeView = view;
  elements.browserTab.classList.toggle('is-active', view === 'browser');
  elements.playerTab.classList.toggle('is-active', view === 'player');
  elements.browserView.classList.toggle('is-active', view === 'browser');
  elements.playerView.classList.toggle('is-active', view === 'player' && Boolean(state.lastParsedUrl));
  elements.emptyPlayer.classList.toggle('is-active', view === 'player' && !state.lastParsedUrl);
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
  const mediaTitle = cleanMediaTitle(metadata?.title || '', metadata?.platformName);
  const coverUrl = typeof metadata?.coverUrl === 'string' ? metadata.coverUrl : '';
  const source = metadata?.source || 'page';

  if (!mediaTitle && !coverUrl) {
    return;
  }

  updateHistoryEntry(originalUrl, (item) => {
    const keepClickTitle = item.mediaTitle && item.mediaTitleSource === 'click' && source !== 'click' && !mediaTitle;
    const keepClickCover = item.coverUrl && item.coverSource === 'click' && source !== 'click';
    const nextTitle = keepClickTitle ? item.mediaTitle : mediaTitle || item.mediaTitle;
    const nextCoverUrl = keepClickCover ? item.coverUrl : coverUrl || item.coverUrl;
    const nextTitleSource = nextTitle === item.mediaTitle ? item.mediaTitleSource : source;
    const nextCoverSource = nextCoverUrl === item.coverUrl ? item.coverSource : source;

    if (
      item.mediaTitle === nextTitle &&
      item.coverUrl === nextCoverUrl &&
      item.mediaTitleSource === nextTitleSource &&
      item.coverSource === nextCoverSource
    ) {
      return item;
    }
    return {
      ...item,
      mediaTitle: nextTitle,
      mediaTitleSource: nextTitleSource,
      coverUrl: nextCoverUrl,
      coverSource: nextCoverSource
    };
  });
}

function normalizeClickMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const title = cleanMediaTitle(typeof metadata.title === 'string' ? metadata.title.trim() : '');
  const coverUrl = typeof metadata.coverUrl === 'string' && /^https?:\/\//i.test(metadata.coverUrl)
    ? metadata.coverUrl
    : '';

  if (!title && !coverUrl) {
    return null;
  }

  return {
    title,
    coverUrl,
    source: 'click'
  };
}

function beginPendingAutoParse(message) {
  if (!state.autoParse) {
    return;
  }

  state.pendingAutoParse = true;
  if (state.pendingAutoParseExpireTimer) {
    clearTimeout(state.pendingAutoParseExpireTimer);
  }
  state.pendingAutoParseExpireTimer = setTimeout(() => {
    state.pendingAutoParse = false;
    state.pendingAutoParseExpireTimer = null;
  }, 8000);

  if (message) {
    setStatus(message);
  }
}

function clearPendingAutoParse() {
  state.pendingAutoParse = false;
  if (state.pendingAutoParseTimer) {
    clearTimeout(state.pendingAutoParseTimer);
    state.pendingAutoParseTimer = null;
  }
  if (state.pendingAutoParseExpireTimer) {
    clearTimeout(state.pendingAutoParseExpireTimer);
    state.pendingAutoParseExpireTimer = null;
  }
}

function scheduleParseCurrentBrowserUrl(title = '', fallbackUrl = '', metadata = null) {
  if (!state.autoParse || !state.pendingAutoParse) {
    return;
  }

  if (state.pendingAutoParseTimer) {
    clearTimeout(state.pendingAutoParseTimer);
  }

  state.pendingAutoParseTimer = setTimeout(() => {
    const finalUrl = elements.browserView.getURL() || state.currentUrl;
    const platformInfo = detectPlatform(finalUrl);
    const fallbackPlatformInfo = fallbackUrl ? detectPlatform(fallbackUrl) : null;
    const targetUrl = platformInfo ? finalUrl : fallbackUrl;

    if (!platformInfo && !fallbackPlatformInfo) {
      setStatus(`等待视频页最终地址：${finalUrl || '尚未获取到地址'}`);
      return;
    }

    clearPendingAutoParse();
    parseVideoUrl(targetUrl, title || state.currentTitle, true, {
      metadata: metadata || state.pendingClickMetadata
    });
    state.pendingClickMetadata = null;
  }, 1200);
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
    metadata: session.metadata
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

function metadataExtractionScript() {
  return `
    (() => {
      const absoluteUrl = (value) => {
        if (!value || typeof value !== 'string') return '';
        try {
          const url = new URL(value.trim(), location.href);
          return /^https?:$/i.test(url.protocol) ? url.href : '';
        } catch (_error) {
          return '';
        }
      };
      const textFrom = (selector, attribute = 'content') => {
        const element = document.querySelector(selector);
        const value = attribute === 'textContent' ? element?.textContent : element?.getAttribute(attribute);
        return typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim() : '';
      };
      const titleCandidates = [
        textFrom('meta[property="og:title"]'),
        textFrom('meta[name="twitter:title"]'),
        textFrom('meta[itemprop="name"]'),
        textFrom('h1', 'textContent'),
        textFrom('.title', 'textContent'),
        textFrom('[class*="title"]', 'textContent'),
        document.title
      ].filter(Boolean);
      const imageSelectors = [
        ['meta[property="og:image"]', 'content'],
        ['meta[property="og:image:url"]', 'content'],
        ['meta[name="twitter:image"]', 'content'],
        ['meta[itemprop="image"]', 'content'],
        ['link[rel="image_src"]', 'href'],
        ['video[poster]', 'poster'],
        ['img[alt*="海报"]', 'src'],
        ['img[class*="cover"]', 'src'],
        ['img[class*="poster"]', 'src'],
        ['img[src*="cover"]', 'src'],
        ['img[src*="poster"]', 'src']
      ];
      const imageCandidates = imageSelectors
        .map(([selector, attribute]) => absoluteUrl(document.querySelector(selector)?.getAttribute(attribute)))
        .filter(Boolean);

      if (imageCandidates.length === 0) {
        const visibleImages = Array.from(document.images)
          .map((image) => ({
            url: absoluteUrl(image.currentSrc || image.src),
            area: (image.naturalWidth || image.width || 0) * (image.naturalHeight || image.height || 0)
          }))
          .filter((item) => item.url && item.area >= 6000)
          .sort((first, second) => second.area - first.area);
        if (visibleImages[0]) {
          imageCandidates.push(visibleImages[0].url);
        }
      }

      return {
        title: titleCandidates[0] || '',
        coverUrl: imageCandidates[0] || '',
        pageUrl: location.href
      };
    })();
  `;
}

async function enrichHistoryMetadata(sessionId) {
  const session = state.parseSession;
  if (!session || session.id !== sessionId || !session.shouldRemember) {
    return;
  }

  try {
    const metadata = await elements.browserView.executeJavaScript(metadataExtractionScript(), true);
    const currentSession = state.parseSession;
    if (!currentSession || currentSession.id !== sessionId) {
      return;
    }

    updateHistoryMetadata(session.originalUrl, {
      title: metadata?.title || session.title,
      coverUrl: metadata?.coverUrl || '',
      platformName: session.platformName,
      source: 'page'
    });
  } catch (_error) {
    updateHistoryMetadata(session.originalUrl, {
      title: session.title,
      platformName: session.platformName,
      source: 'page'
    });
  }
}

function parseVideoUrl(videoUrl, title = '', shouldRemember = true, options = {}) {
  const platformInfo = detectPlatform(videoUrl);
  if (!platformInfo) {
    setStatus('当前地址不是已支持的视频页。');
    return;
  }

  clearParserHealthTimer();

  const interfaceIndex = Number.isInteger(options.interfaceIndex) ? options.interfaceIndex : 0;
  const parserInterface = interfaceAt(interfaceIndex);
  const triedInterfaceIds = Array.isArray(options.triedInterfaceIds) ? [...options.triedInterfaceIds] : [];
  if (!triedInterfaceIds.includes(parserInterface.id)) {
    triedInterfaceIds.push(parserInterface.id);
  }
  const parsedUrl = generateParseUrl(parserInterface.url, videoUrl);
  const sessionId = nextParseSessionId++;

  state.parseSession = {
    id: sessionId,
    originalUrl: videoUrl,
    title,
    shouldRemember,
    platformName: platformInfo.platform.name,
    metadata: options.metadata || null,
    interfaceIndex,
    triedInterfaceIds,
    startedAt: Date.now()
  };
  state.currentInterfaceId = parserInterface.id;
  state.lastParsedUrl = parsedUrl;
  elements.playerView.src = parsedUrl;
  switchView('player');
  setStatus(`正在加载解析播放：${platformInfo.platform.name}`);
  scheduleParserHealthCheck(sessionId, PARSER_LOAD_TIMEOUT_MS);

  if (shouldRemember && options.triedInterfaceIds) {
    updateHistoryParserUrl(videoUrl, parsedUrl);
  } else if (shouldRemember) {
    const initialMetadata = options.metadata || {};
    const initialTitle = initialMetadata.title || title || state.currentTitle;
    const initialCoverUrl = initialMetadata.coverUrl || '';
    const initialSource = initialMetadata.source || 'page';
    rememberHistory({
      originalUrl: videoUrl,
      parsedUrl,
      title: cleanMediaTitle(initialTitle, platformInfo.platform.name),
      mediaTitle: cleanMediaTitle(initialTitle, platformInfo.platform.name),
      mediaTitleSource: initialMetadata.title ? initialSource : 'page',
      coverUrl: initialCoverUrl,
      coverSource: initialCoverUrl ? initialSource : '',
      platformId: platformInfo.platform.id,
      platformName: platformInfo.platform.name,
      createdAt: new Date().toISOString()
    });
    enrichHistoryMetadata(sessionId);
  }
}

function handleCandidateUrl(url, title = '') {
  const platformInfo = detectPlatform(url);
  state.currentPlatformInfo = platformInfo;
  if (platformInfo) {
    state.detectedVideoUrl = url;
    state.detectedVideoTitle = title || state.currentTitle;
    state.selectedPlatformId = platformInfo.platform.id;
    setStatus(`识别到 ${platformInfo.platform.name} 视频页：${url}`);
    if (state.pendingAutoParse && state.lastParsedUrl !== generateParseUrl(currentInterface().url, url)) {
      scheduleParseCurrentBrowserUrl(title || state.currentTitle);
    }
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

  const platformInfo = detectPlatform(url);
  if (platformInfo) {
    beginPendingAutoParse(`已打开视频页，等待最终地址：${url}`);
    loadBrowserUrl(url, { skipImmediateDetection: true });
    return;
  }

  loadBrowserUrl(url);
}

function loadBrowserUrl(url, options = {}) {
  const nextUrl = normalizeUrl(url);
  if (!nextUrl) {
    return;
  }

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
    setStatus(type === 'browser' ? '官网页面加载中...' : '解析页面加载中...');
  });

  webview.addEventListener('did-finish-load', () => {
    if (type === 'browser') {
      state.currentTitle = webview.getTitle();
      state.currentUrl = webview.getURL();
      elements.addressInput.value = state.currentUrl;
      handleCandidateUrl(state.currentUrl, state.currentTitle);
      scheduleParseCurrentBrowserUrl(state.currentTitle);
      if (state.parseSession?.shouldRemember) {
        enrichHistoryMetadata(state.parseSession.id);
      }
    } else {
      setStatus('解析页面已加载，正在检测播放状态。');
      if (state.parseSession) {
        scheduleParserHealthCheck(state.parseSession.id);
      }
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
      setStatus(event.errorDescription ? `页面加载失败：${event.errorDescription}` : '页面加载失败。');
    }
  });

  webview.addEventListener('will-navigate', (event) => {
    if (type !== 'browser' || !state.autoParse || !detectPlatform(event.url)) {
      return;
    }

    beginPendingAutoParse(`正在进入视频页，等待最终地址：${event.url}`);
  });

  webview.addEventListener('did-navigate', (event) => {
    if (type === 'browser') {
      state.currentUrl = event.url;
      elements.addressInput.value = event.url;
      handleCandidateUrl(event.url);
      scheduleParseCurrentBrowserUrl(state.currentTitle);
    }
  });

  webview.addEventListener('did-navigate-in-page', (event) => {
    if (type === 'browser') {
      state.currentUrl = event.url;
      elements.addressInput.value = event.url;
      handleCandidateUrl(event.url);
      scheduleParseCurrentBrowserUrl(state.currentTitle);
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
    if (type !== 'browser') {
      return;
    }
    if (event.channel === 'candidate-link') {
      const [payload] = event.args;
      if (payload && payload.href && detectPlatform(payload.href)) {
        const metadata = normalizeClickMetadata({
          title: payload.text,
          coverUrl: payload.coverUrl
        });
        state.pendingClickMetadata = metadata;
        beginPendingAutoParse(`已点击视频，等待页面地址变为最终播放页：${payload.href}`);
        state.detectedVideoUrl = payload.href;
        state.detectedVideoTitle = metadata?.title || payload.text || state.currentTitle;
        state.currentPlatformInfo = detectPlatform(payload.href);
        state.selectedPlatformId = state.currentPlatformInfo.platform.id;
        renderDetectedState();
        scheduleParseCurrentBrowserUrl(metadata?.title || payload.text || state.currentTitle, payload.href, metadata);
      }
    }
    if (event.channel === 'page-click') {
      const [payload] = event.args;
      const metadata = normalizeClickMetadata({
        title: payload?.text,
        coverUrl: payload?.coverUrl
      });
      if (metadata) {
        state.pendingClickMetadata = metadata;
      }
      if (state.autoParse) {
        beginPendingAutoParse(payload?.text ? `已点击页面，等待是否进入视频页：${payload.text}` : '已点击页面，等待是否进入视频页。');
      }
    }
    if (event.channel === 'page-ready') {
      const [payload] = event.args;
      if (payload && payload.url) {
        handleCandidateUrl(payload.url, payload.title);
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
  state.history = Array.isArray(persistedState.history) ? persistedState.history : [];
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
