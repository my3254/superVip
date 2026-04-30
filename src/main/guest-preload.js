const { ipcRenderer } = require('electron');

const isMainFrame = process.isMainFrame !== false;
let compiledPatterns = [];
let clickParserEnabled = true;
let adCleanupTimer = null;
let parserMaintenanceStarted = false;
let inlinePlayerTracking = false;
let playbackRectTimer = null;

const PLATFORM_HOSTS = [
  'iqiyi.com',
  'youku.com',
  'v.qq.com',
  'mgtv.com',
  'bilibili.com',
  'sohu.com',
  'le.com',
  'letv.com'
];

function isPlatformPageHost(hostname) {
  return PLATFORM_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function shouldRunAdCleanup() {
  return !isPlatformPageHost(location.hostname);
}

function compilePatterns(patterns) {
  compiledPatterns = [];
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    if (!pattern || typeof pattern.source !== 'string') {
      continue;
    }

    try {
      compiledPatterns.push(new RegExp(pattern.source, pattern.flags || ''));
    } catch (_error) {
      // Ignore invalid host-provided patterns and continue with the rest.
    }
  }
}

ipcRenderer.on('click-parser-config', (_event, config = {}) => {
  clickParserEnabled = config.enabled !== false;
  compilePatterns(Array.isArray(config.patterns) ? config.patterns : []);
});

ipcRenderer.on('inline-player-tracking', (_event, config = {}) => {
  inlinePlayerTracking = config.enabled === true;
  if (inlinePlayerTracking) {
    sendPlaybackRect('tracking-started');
  } else if (playbackRectTimer) {
    clearTimeout(playbackRectTimer);
    playbackRectTimer = null;
  }
});

function closestAnchor(node) {
  let current = node;
  while (current && current !== document.documentElement) {
    if (current.tagName === 'A' && current.href) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function asAbsoluteUrl(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value
    .trim()
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');

  if (!trimmed || /^(javascript|mailto|tel):/i.test(trimmed)) {
    return '';
  }

  try {
    return new URL(trimmed, location.href).href;
  } catch (_error) {
    return '';
  }
}

function asAbsoluteHttpUrl(value) {
  const url = asAbsoluteUrl(value);
  if (!url || !/^https?:\/\//i.test(url)) {
    return '';
  }
  return url;
}

function collectUrlLikeValues(value, candidates) {
  if (typeof value !== 'string' || !value) {
    return;
  }

  const cleaned = value.replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const fullUrlMatches = cleaned.match(/https?:\/\/[^\s"'<>\\]+|\/\/[^\s"'<>\\]+/gi) || [];
  for (const match of fullUrlMatches) {
    candidates.push(asAbsoluteUrl(match.startsWith('//') ? `${location.protocol}${match}` : match));
  }

  const relativeMatches = cleaned.match(/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g) || [];
  for (const match of relativeMatches) {
    candidates.push(asAbsoluteUrl(match));
  }
}

function collectElementCandidates(element, candidates) {
  const attributeNames = [
    'href',
    'src',
    'data-href',
    'data-url',
    'data-link',
    'data-target',
    'data-video-url',
    'data-play-url',
    'data-redirect',
    'onclick'
  ];

  for (const name of attributeNames) {
    collectUrlLikeValues(element.getAttribute(name), candidates);
    const directUrl = asAbsoluteUrl(element.getAttribute(name));
    if (directUrl) {
      candidates.push(directUrl);
    }
  }

  for (const value of Object.values(element.dataset || {})) {
    collectUrlLikeValues(value, candidates);
    const directUrl = asAbsoluteUrl(value);
    if (directUrl) {
      candidates.push(directUrl);
    }
  }
}

function findClickCandidates(target) {
  const candidates = [];
  const anchor = closestAnchor(target);
  if (anchor) {
    candidates.push(anchor.href);
  }

  let current = target && target.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  let depth = 0;
  while (current && current !== document.documentElement && depth < 10) {
    collectElementCandidates(current, candidates);

    current = current.parentElement;
    depth += 1;
  }

  return [...new Set(candidates.filter(Boolean))];
}

function isSupportedVideoUrl(url) {
  if (!url || compiledPatterns.length === 0) {
    return false;
  }
  return compiledPatterns.some((pattern) => pattern.test(url));
}

function pausePageMedia() {
  for (const media of document.querySelectorAll('audio, video')) {
    try {
      media.autoplay = false;
      media.pause();
    } catch (_error) {
      // Ignore protected or already-detached media nodes.
    }
  }
}

function asPlainRect(rect) {
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
}

function isUsablePlayerRect(rect) {
  const viewportArea = window.innerWidth * window.innerHeight;
  const area = rect.width * rect.height;
  return rect.width >= 360 &&
    rect.height >= 200 &&
    rect.width <= window.innerWidth &&
    rect.height <= window.innerHeight &&
    area <= viewportArea * 0.82;
}

function playbackSelectorList() {
  return [
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
}

function playerRectScore(element, rect) {
  const area = rect.width * rect.height;
  const ratio = rect.width / Math.max(1, rect.height);
  const ratioScore = ratio >= 1.2 && ratio <= 2.6 ? area * 0.22 : 0;
  const name = `${element.id || ''} ${element.className || ''}`.toLowerCase();
  const semanticScore = /player|video|iqp|flashbox/.test(name) ? area * 0.2 : 0;
  const mediaScore = element.tagName === 'VIDEO' ? area * 0.35 : 0;
  const viewportScore = rect.top < window.innerHeight * 0.72 ? area * 0.12 : 0;
  return area + ratioScore + semanticScore + mediaScore + viewportScore;
}

function findPlaybackRect() {
  const candidates = [...new Set([...document.querySelectorAll(playbackSelectorList())])];
  let best = null;

  for (const element of candidates) {
    if (!isVisibleElement(element)) {
      continue;
    }

    const rect = asPlainRect(element.getBoundingClientRect());
    if (!isUsablePlayerRect(rect)) {
      continue;
    }

    const score = playerRectScore(element, rect);
    if (!best || score > best.score) {
      best = { rect, score };
    }
  }

  return best ? best.rect : null;
}

function sendPlaybackRect(reason) {
  if (!isMainFrame) {
    return;
  }

  const rect = findPlaybackRect();
  if (!rect) {
    return;
  }

  ipcRenderer.sendToHost('playback-rect', {
    rect,
    reason
  });
}

function schedulePlaybackRectUpdate(reason) {
  if (!inlinePlayerTracking) {
    return;
  }

  if (playbackRectTimer) {
    clearTimeout(playbackRectTimer);
  }

  playbackRectTimer = setTimeout(() => {
    playbackRectTimer = null;
    sendPlaybackRect(reason);
  }, 120);
}

function isVisibleElement(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function intersectionArea(first, second) {
  const left = Math.max(first.left, second.left);
  const right = Math.min(first.right, second.right);
  const top = Math.max(first.top, second.top);
  const bottom = Math.min(first.bottom, second.bottom);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function rectArea(rect) {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function getPausedVideoRects() {
  return [...document.querySelectorAll('video')]
    .filter((video) => {
      if (!isVisibleElement(video) || !video.paused) {
        return false;
      }

      const rect = video.getBoundingClientRect();
      return rect.width >= 320 && rect.height >= 180;
    })
    .map((video) => video.getBoundingClientRect())
    .sort((first, second) => rectArea(second) - rectArea(first));
}

function getVisibleVideoRects() {
  return [...document.querySelectorAll('video')]
    .filter((video) => {
      if (!isVisibleElement(video)) {
        return false;
      }

      const rect = video.getBoundingClientRect();
      return rect.width >= 320 && rect.height >= 180;
    })
    .map((video) => video.getBoundingClientRect())
    .sort((first, second) => rectArea(second) - rectArea(first));
}

function getVisiblePlayerRects() {
  return [...document.querySelectorAll('.art-video-player, #Xmflv, .dplayer, .prism-player, .player-wrapper, .video-player')]
    .filter((player) => {
      if (!isVisibleElement(player)) {
        return false;
      }

      const rect = player.getBoundingClientRect();
      return rect.width >= 320 && rect.height >= 180;
    })
    .map((player) => player.getBoundingClientRect())
    .sort((first, second) => rectArea(second) - rectArea(first));
}

function hasMediaSurface(element) {
  if (element.matches?.('img, iframe, canvas, object, embed, svg')) {
    return true;
  }

  if (element.querySelector?.('img, iframe, canvas, object, embed, svg')) {
    return true;
  }

  const style = window.getComputedStyle(element);
  return Boolean(style.backgroundImage && style.backgroundImage !== 'none');
}

function isInteractiveSurface(element) {
  if (element.matches?.('a, button, [role="button"]')) {
    return true;
  }

  if (element.querySelector?.('a, button, [role="button"]')) {
    return true;
  }

  return window.getComputedStyle(element).cursor === 'pointer';
}

function isParserControlElement(element) {
  return Boolean(element.closest?.([
    '.art-bottom',
    '.art-controls',
    '.art-control',
    '.art-progress',
    '.art-setting',
    '.art-selector',
    '.art-volume',
    '.art-volume-panel',
    '.art-play',
    '.art-state',
    '.art-fullscreen',
    '.art-fullscreen-web'
  ].join(',')));
}

function isLikelyPlayerControl(element, elementRect, videoRect) {
  const bottomControlZone = videoRect.top + videoRect.height * 0.78;
  const isNearBottom = elementRect.top >= bottomControlZone;
  const isThin = elementRect.height <= Math.max(90, videoRect.height * 0.16);
  const isWide = elementRect.width >= videoRect.width * 0.45;
  return isNearBottom && isThin && isWide && !hasMediaSurface(element);
}

function isStructuralPauseOverlay(element, videoRect) {
  if (!isVisibleElement(element) || element.tagName === 'VIDEO') {
    return false;
  }

  if (isParserControlElement(element)) {
    return false;
  }

  if (!hasMediaSurface(element)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const area = rectArea(rect);
  if (area < 24000 || rect.width < 180 || rect.height < 100) {
    return false;
  }

  const overlap = intersectionArea(rect, videoRect);
  if (overlap / area < 0.75) {
    return false;
  }

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const centerInsideVideo =
    centerX >= videoRect.left &&
    centerX <= videoRect.right &&
    centerY >= videoRect.top &&
    centerY <= videoRect.bottom;
  if (!centerInsideVideo) {
    return false;
  }

  if (isLikelyPlayerControl(element, rect, videoRect)) {
    return false;
  }

  const tooCloseToFullVideo = rect.width >= videoRect.width * 0.92 && rect.height >= videoRect.height * 0.82;
  if (tooCloseToFullVideo) {
    return false;
  }

  const style = window.getComputedStyle(element);
  const isLayered =
    style.position === 'absolute' ||
    style.position === 'fixed' ||
    style.position === 'sticky' ||
    Number(style.zIndex) >= 1 ||
    isInteractiveSurface(element);

  return isLayered;
}

function isCenteredMediaOverlay(element, videoRect) {
  if (!isVisibleElement(element) || element.tagName === 'VIDEO') {
    return false;
  }

  if (isParserControlElement(element)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const area = rectArea(rect);
  if (area < 30000 || rect.width < 240 || rect.height < 160) {
    return false;
  }

  const overlap = intersectionArea(rect, videoRect);
  if (overlap / Math.max(1, area) < 0.85) {
    return false;
  }

  const rectCenterX = rect.left + rect.width / 2;
  const rectCenterY = rect.top + rect.height / 2;
  const videoCenterX = videoRect.left + videoRect.width / 2;
  const videoCenterY = videoRect.top + videoRect.height / 2;
  const centeredInVideo =
    Math.abs(rectCenterX - videoCenterX) <= videoRect.width * 0.18 &&
    Math.abs(rectCenterY - videoCenterY) <= videoRect.height * 0.22;
  if (!centeredInVideo) {
    return false;
  }

  const style = window.getComputedStyle(element);
  const layered =
    style.position === 'absolute' ||
    style.position === 'fixed' ||
    Number(style.zIndex) >= 100 ||
    style.transform !== 'none';
  if (!layered) {
    return false;
  }

  const hasLargeMedia = [...element.querySelectorAll('img, iframe, canvas, object, embed, svg')].some((media) => {
    const mediaRect = media.getBoundingClientRect();
    return mediaRect.width >= rect.width * 0.55 && mediaRect.height >= rect.height * 0.55;
  });
  if (!hasLargeMedia && !hasMediaSurface(element)) {
    return false;
  }

  if (isLikelyPlayerControl(element, rect, videoRect)) {
    return false;
  }

  return rect.width <= videoRect.width * 0.82 && rect.height <= videoRect.height * 0.82;
}

function isHighLayerMediaCard(element, videoRect) {
  if (!isVisibleElement(element) || element.tagName === 'VIDEO') {
    return false;
  }

  if (isParserControlElement(element)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const area = rectArea(rect);
  if (area < 40000 || rect.width < 260 || rect.height < 180) {
    return false;
  }

  const overlap = intersectionArea(rect, videoRect);
  if (overlap / Math.max(1, area) < 0.85) {
    return false;
  }

  const style = window.getComputedStyle(element);
  const hasStrongLayer =
    style.position === 'absolute' ||
    style.position === 'fixed' ||
    Number(style.zIndex) >= 1000 ||
    style.transform !== 'none';
  if (!hasStrongLayer) {
    return false;
  }

  const containsDominantImage = [...element.querySelectorAll('img')].some((image) => {
    const imageRect = image.getBoundingClientRect();
    return imageRect.width >= rect.width * 0.7 && imageRect.height >= rect.height * 0.7;
  });
  if (!containsDominantImage) {
    return false;
  }

  const rectCenterX = rect.left + rect.width / 2;
  const rectCenterY = rect.top + rect.height / 2;
  const videoCenterX = videoRect.left + videoRect.width / 2;
  const videoCenterY = videoRect.top + videoRect.height / 2;
  const centeredInVideo =
    Math.abs(rectCenterX - videoCenterX) <= videoRect.width * 0.2 &&
    Math.abs(rectCenterY - videoCenterY) <= videoRect.height * 0.25;

  return centeredInVideo && rect.width <= videoRect.width * 0.9 && rect.height <= videoRect.height * 0.9;
}

function containsDominantImage(element, rect, widthRatio = 0.65, heightRatio = 0.65) {
  return [...element.querySelectorAll('img')].some((image) => {
    if (!isVisibleElement(image)) {
      return false;
    }

    const imageRect = image.getBoundingClientRect();
    return imageRect.width >= rect.width * widthRatio && imageRect.height >= rect.height * heightRatio;
  });
}

function numericZIndex(style) {
  const value = Number.parseInt(style.zIndex, 10);
  return Number.isFinite(value) ? value : 0;
}

function isStandaloneCenteredMediaAd(element) {
  if (!isVisibleElement(element) || element.tagName === 'VIDEO') {
    return false;
  }

  if (isParserControlElement(element)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const area = rectArea(rect);
  if (area < 40000 || rect.width < 260 || rect.height < 160) {
    return false;
  }

  if (rect.width > window.innerWidth * 0.86 || rect.height > window.innerHeight * 0.86) {
    return false;
  }

  const style = window.getComputedStyle(element);
  const zIndex = numericZIndex(style);
  const isLayered =
    style.position === 'absolute' ||
    style.position === 'fixed' ||
    zIndex >= 100 ||
    style.transform !== 'none';
  if (!isLayered) {
    return false;
  }

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const centeredInViewport =
    Math.abs(centerX - window.innerWidth / 2) <= window.innerWidth * 0.24 &&
    Math.abs(centerY - window.innerHeight / 2) <= window.innerHeight * 0.28;
  if (!centeredInViewport) {
    return false;
  }

  return containsDominantImage(element, rect) || element.matches?.('img');
}

function hasVisibleTextOnly(element) {
  if (!element.textContent || !element.textContent.trim()) {
    return false;
  }

  if (element.querySelector?.('video, img, iframe, canvas, object, embed, svg, input, textarea, select')) {
    return false;
  }

  return true;
}

function isTopTextOverlayAd(element, videoRect) {
  if (!isVisibleElement(element) || element.tagName === 'VIDEO') {
    return false;
  }

  if (isParserControlElement(element) || !hasVisibleTextOnly(element)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 70 || rect.height < 14 || rect.height > Math.max(88, videoRect.height * 0.12)) {
    return false;
  }

  const overlap = intersectionArea(rect, videoRect);
  if (overlap / Math.max(1, rectArea(rect)) < 0.55) {
    return false;
  }

  const topLimit = videoRect.top + Math.max(130, videoRect.height * 0.18);
  if (rect.top > topLimit) {
    return false;
  }

  if (isLikelyPlayerControl(element, rect, videoRect)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  const zIndex = numericZIndex(style);
  const isLayered =
    style.position === 'absolute' ||
    style.position === 'fixed' ||
    style.position === 'sticky' ||
    zIndex >= 1 ||
    style.transform !== 'none';

  return isLayered;
}

function removeStandaloneCenteredAds() {
  for (const node of document.querySelectorAll('div, a, section, aside')) {
    if (isStandaloneCenteredMediaAd(node)) {
      hideAdElement(node);
    }
  }
}

function removeTopTextOverlayAds(videoRects) {
  const nodes = document.querySelectorAll('div, span, p, a, section, aside');
  for (const videoRect of videoRects) {
    for (const node of nodes) {
      if (isTopTextOverlayAd(node, videoRect)) {
        hideAdElement(node);
      }
    }
  }
}

function expandToOverlayRoot(element, videoRect) {
  let current = element;
  let best = element;
  let depth = 0;

  while (current && current.parentElement && current.parentElement !== document.body && depth < 8) {
    const parent = current.parentElement;
    const parentRect = parent.getBoundingClientRect();

    if (!isStructuralPauseOverlay(parent, videoRect)) {
      break;
    }

    const parentIsWholeVideo = parentRect.width >= videoRect.width * 0.92 && parentRect.height >= videoRect.height * 0.82;
    if (parentIsWholeVideo) {
      break;
    }

    best = parent;
    current = parent;
    depth += 1;
  }

  return best;
}

function hideAdElement(element) {
  if (!element || element.dataset.superVipAdHidden === '1') {
    return;
  }

  element.dataset.superVipAdHidden = '1';
  element.style.setProperty('display', 'none', 'important');
  element.style.setProperty('visibility', 'hidden', 'important');
  element.style.setProperty('pointer-events', 'none', 'important');
}

function clearPropertyIfValue(element, property, values) {
  const currentValue = element.style.getPropertyValue(property).trim();
  if (values.includes(currentValue)) {
    element.style.removeProperty(property);
  }
}

function clearImportantPropertyIfValue(element, property, values) {
  const currentValue = element.style.getPropertyValue(property).trim();
  if (element.style.getPropertyPriority(property) === 'important' && values.includes(currentValue)) {
    element.style.removeProperty(property);
  }
}

function restoreParserPlayerStyles() {
  clearImportantPropertyIfValue(document.documentElement, 'margin', ['0px', '0']);
  clearImportantPropertyIfValue(document.documentElement, 'padding', ['0px', '0']);
  clearImportantPropertyIfValue(document.documentElement, 'height', ['100%']);
  clearImportantPropertyIfValue(document.body, 'margin', ['0px', '0']);
  clearImportantPropertyIfValue(document.body, 'padding', ['0px', '0']);
  clearImportantPropertyIfValue(document.body, 'min-height', ['100vh']);
  clearImportantPropertyIfValue(document.body, 'background', ['rgb(0, 0, 0)', '#000', 'black']);

  for (const iframe of document.querySelectorAll('iframe')) {
    clearImportantPropertyIfValue(iframe, 'display', ['block']);
    clearImportantPropertyIfValue(iframe, 'width', ['100vw']);
    clearImportantPropertyIfValue(iframe, 'height', ['100vh']);
    clearImportantPropertyIfValue(iframe, 'border', ['0px', '0']);
  }

  for (const video of document.querySelectorAll('video')) {
    clearPropertyIfValue(video, 'width', ['100%']);
    clearPropertyIfValue(video, 'height', ['100%']);
    clearPropertyIfValue(video, 'object-fit', ['cover', 'contain']);
    clearPropertyIfValue(video, 'object-position', ['center center', 'center top']);
    clearPropertyIfValue(video, 'z-index', ['10']);
  }

  for (const player of document.querySelectorAll('.art-video-player, #Xmflv')) {
    clearPropertyIfValue(player, 'position', ['fixed']);
    clearPropertyIfValue(player, 'inset', ['0px', '0']);
    clearPropertyIfValue(player, 'width', ['100vw']);
    clearPropertyIfValue(player, 'height', ['100vh']);
    clearPropertyIfValue(player, 'margin', ['0px', '0']);
    clearPropertyIfValue(player, 'z-index', ['1']);
  }

  for (const control of document.querySelectorAll('.art-bottom,.art-controls,.art-control,.art-progress,.art-setting,.art-selector,.art-volume-panel,.art-fullscreen,.art-fullscreen-web')) {
    clearImportantPropertyIfValue(control, 'opacity', ['1']);
    clearImportantPropertyIfValue(control, 'visibility', ['visible']);
    clearImportantPropertyIfValue(control, 'pointer-events', ['auto']);
    clearImportantPropertyIfValue(control, 'z-index', ['100000', '100002', '100003']);
  }

  clearPropertyIfValue(document.documentElement, 'overflow', ['hidden']);
  clearPropertyIfValue(document.body, 'overflow', ['hidden']);
}

function removePauseAds() {
  restoreParserPlayerStyles();
  removeStandaloneCenteredAds();

  const videoRects = [...getPausedVideoRects(), ...getVisibleVideoRects()];
  if (videoRects.length === 0) {
    return;
  }

  const playerRects = getVisiblePlayerRects();
  const overlayRects = [...videoRects, ...playerRects];

  removeTopTextOverlayAds(overlayRects);

  const mediaNodes = [...document.querySelectorAll('img, iframe, canvas, object, embed, svg, a, button, div')];
  for (const videoRect of overlayRects) {
    for (const node of mediaNodes) {
      if (isHighLayerMediaCard(node, videoRect)) {
        hideAdElement(node);
        continue;
      }

      if (isCenteredMediaOverlay(node, videoRect)) {
        hideAdElement(node);
        continue;
      }

      if (!isStructuralPauseOverlay(node, videoRect)) {
        continue;
      }

      const root = expandToOverlayRoot(node, videoRect);
      const rootRect = root.getBoundingClientRect();
      const rootArea = rectArea(rootRect);
      const nodeArea = rectArea(node.getBoundingClientRect());
      const rootStillFocused = intersectionArea(rootRect, videoRect) / Math.max(1, rootArea) >= 0.75;

      if (rootStillFocused && rootArea <= Math.max(nodeArea * 4, rectArea(videoRect) * 0.7)) {
        hideAdElement(root);
      }
    }
  }
}

function scheduleAdCleanup() {
  if (!shouldRunAdCleanup()) {
    return;
  }

  if (adCleanupTimer) {
    clearTimeout(adCleanupTimer);
  }

  adCleanupTimer = setTimeout(() => {
    adCleanupTimer = null;
    removePauseAds();
  }, 120);
}

function bindVideoPauseCleanup() {
  if (!shouldRunAdCleanup()) {
    return;
  }

  for (const video of document.querySelectorAll('video')) {
    if (video.dataset.superVipPauseCleanupBound === '1') {
      continue;
    }

    video.dataset.superVipPauseCleanupBound = '1';
    video.addEventListener('pause', () => {
      scheduleAdCleanup();
      setTimeout(scheduleAdCleanup, 300);
      setTimeout(scheduleAdCleanup, 800);
    });
    video.addEventListener('play', scheduleAdCleanup);
  }
}

function startParserMaintenance() {
  if (!shouldRunAdCleanup() || parserMaintenanceStarted) {
    return;
  }

  parserMaintenanceStarted = true;
  scheduleAdCleanup();
  window.setInterval(scheduleAdCleanup, 1000);
}

function sendCurrentPage(reason) {
  if (!isMainFrame) {
    return;
  }

  ipcRenderer.sendToHost('page-ready', {
    url: location.href,
    title: document.title,
    reason
  });
}

function patchHistoryMethod(name) {
  const original = history[name];
  if (typeof original !== 'function') {
    return;
  }

  history[name] = function patchedHistoryMethod(...args) {
    const result = original.apply(this, args);
    setTimeout(() => sendCurrentPage(name), 0);
    return result;
  };
}

patchHistoryMethod('pushState');
patchHistoryMethod('replaceState');

window.addEventListener('popstate', () => sendCurrentPage('popstate'));
window.addEventListener('hashchange', () => sendCurrentPage('hashchange'));

window.addEventListener(
  'click',
  (event) => {
    if (!clickParserEnabled) {
      return;
    }

    const isInlineFollowupClick = inlinePlayerTracking && !event.ctrlKey;
    if (!event.ctrlKey && !isInlineFollowupClick) {
      return;
    }

    if (event.ctrlKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      pausePageMedia();

      ipcRenderer.sendToHost('candidate-link', {
        href: '',
        useCurrentPage: true,
        source: isMainFrame ? 'ctrl-current-page' : 'ctrl-subframe-current-page',
        playbackRect: isMainFrame ? findPlaybackRect() : null
      });
      return;
    }

    if (!isMainFrame) {
      return;
    }

    const candidates = findClickCandidates(event.target);
    const directUrl = candidates.find(isSupportedVideoUrl);
    const targetUrl = directUrl || '';
    if (!targetUrl && !isInlineFollowupClick) {
      return;
    }

    if (isInlineFollowupClick) {
      ipcRenderer.sendToHost('inline-followup-navigation', {
        href: targetUrl,
        source: 'inline-followup-click',
        playbackRect: findPlaybackRect()
      });
      return;
    }

  },
  true
);

window.addEventListener('DOMContentLoaded', () => {
  if (isMainFrame) {
    sendCurrentPage('dom-content-loaded');
  }
  bindVideoPauseCleanup();
  startParserMaintenance();

  const observer = new MutationObserver(() => {
    bindVideoPauseCleanup();
    startParserMaintenance();
    scheduleAdCleanup();
    schedulePlaybackRectUpdate('dom-mutated');
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'id', 'style', 'aria-label']
  });
});

window.addEventListener('click', scheduleAdCleanup, true);
window.addEventListener('pointerup', scheduleAdCleanup, true);
window.addEventListener('keydown', scheduleAdCleanup, true);
window.addEventListener('resize', scheduleAdCleanup, true);
window.addEventListener('resize', () => schedulePlaybackRectUpdate('resize'), true);
window.addEventListener('scroll', () => schedulePlaybackRectUpdate('scroll'), true);
