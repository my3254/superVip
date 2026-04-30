const { app, BrowserWindow, Menu, ipcMain, nativeTheme, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DEFAULT_INTERFACES, PLATFORMS } = require('../shared/catalog');

const DEFAULT_STATE = {
  currentInterfaceId: 'interface_1',
  autoParse: true,
  history: []
};

let mainWindow = null;

function getDesktopChromeUserAgent() {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
}

app.userAgentFallback = getDesktopChromeUserAgent();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function configureBrowserCompatibility() {
  const chromeMajor = process.versions.chrome.split('.')[0];
  const userAgent = getDesktopChromeUserAgent();
  const filter = { urls: ['http://*/*', 'https://*/*'] };

  session.defaultSession.setUserAgent(userAgent);
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        'User-Agent': userAgent,
        'Sec-CH-UA': `"Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}", "Not_A Brand";v="99"`,
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"Windows"'
      }
    });
  });
}

function getStateFilePath() {
  return path.join(app.getPath('userData'), 'state.json');
}

async function readState() {
  try {
    const raw = await fs.readFile(getStateFilePath(), 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to read state:', error);
    }
    return { ...DEFAULT_STATE };
  }
}

async function writeState(nextState) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(getStateFilePath(), JSON.stringify(nextState, null, 2), 'utf8');
  return nextState;
}

async function fetchVideoMetadata(_event, videoUrl) {
  if (typeof videoUrl !== 'string' || !/^https?:\/\//i.test(videoUrl)) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const metadataUrl = `https://dmku.hls.one/?ac=list&url=${encodeURIComponent(videoUrl)}`;

  console.info('[SuperVip] video metadata request', {
    metadataUrl,
    metadataRequestVideoUrl: videoUrl
  });

  try {
    const response = await fetch(metadataUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': getDesktopChromeUserAgent()
      }
    });

    if (!response.ok) {
      console.warn('[SuperVip] video metadata request failed', {
        metadataRequestVideoUrl: videoUrl,
        status: response.status,
        statusText: response.statusText
      });
      return null;
    }

    const payload = await response.json();
    if (!payload || Number(payload.vod_code) !== 200) {
      console.warn('[SuperVip] video metadata invalid response', {
        metadataRequestVideoUrl: videoUrl,
        vodCode: payload?.vod_code
      });
      return null;
    }

    const episodes = Array.isArray(payload.vod_episodes) ? payload.vod_episodes : [];

    const result = {
      title: typeof payload.vod_title === 'string' ? payload.vod_title : '',
      coverUrl: typeof payload.vod_pic === 'string' ? payload.vod_pic : '',
      type: typeof payload.vod_type === 'string' ? payload.vod_type : '',
      year: typeof payload.vod_year === 'string' ? payload.vod_year : '',
      updateTo: typeof payload.vod_updateTo === 'string' ? payload.vod_updateTo : '',
      description: typeof payload.vod_desc === 'string' ? payload.vod_desc : '',
      episodesCount: episodes.length
    };

    console.info('[SuperVip] video metadata response', {
      metadataRequestVideoUrl: videoUrl,
      title: result.title,
      type: result.type,
      updateTo: result.updateTo,
      hasCover: Boolean(result.coverUrl),
      episodesCount: result.episodesCount
    });

    return result;
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.warn('[SuperVip] video metadata request error', {
        metadataRequestVideoUrl: videoUrl,
        message: error.message
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function sendPopupUrlToRenderer(details) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const url = details && details.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return;
  }

  mainWindow.webContents.send('browser:popup-url', {
    url,
    frameName: details.frameName || '',
    disposition: details.disposition || ''
  });
}

function isPlatformUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    return PLATFORMS.some((platform) => {
      return parsedUrl.hostname === platform.domain || parsedUrl.hostname.endsWith(`.${platform.domain}`);
    });
  } catch (_error) {
    return false;
  }
}

function parserHosts() {
  return DEFAULT_INTERFACES.map((item) => {
    try {
      return new URL(item.url).hostname;
    } catch (_error) {
      return '';
    }
  }).filter(Boolean);
}

function isParserUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    return parserHosts().some((hostname) => {
      return parsedUrl.hostname === hostname || parsedUrl.hostname.endsWith(`.${hostname}`);
    });
  } catch (_error) {
    return false;
  }
}

function shouldInterceptPopup(contents, details) {
  const openerUrl = contents.getURL();
  const referrerUrl = details && details.referrer && details.referrer.url;
  return isPlatformUrl(openerUrl) || isPlatformUrl(referrerUrl);
}

function shouldBlockPopup(contents, details) {
  const openerUrl = contents.getURL();
  const referrerUrl = details && details.referrer && details.referrer.url;
  return isParserUrl(openerUrl) || isParserUrl(referrerUrl);
}

function configurePopupInterception() {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler((details) => {
      if (shouldBlockPopup(contents, details)) {
        return { action: 'deny' };
      }

      if (shouldInterceptPopup(contents, details)) {
        sendPopupUrlToRenderer(details);
        return { action: 'deny' };
      }

      return { action: 'allow' };
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    title: 'SuperVip Desktop',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0d1117',
      symbolColor: '#edf2f7',
      height: 34
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    if (webPreferences.preload && webPreferences.preload.endsWith('guest-preload.js')) {
      webPreferences.nodeIntegrationInSubFrames = true;
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    sendPopupUrlToRenderer({ url });
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);
  configureBrowserCompatibility();
  configurePopupInterception();

  ipcMain.handle('state:load', readState);
  ipcMain.handle('state:save', async (_event, state) => writeState({ ...DEFAULT_STATE, ...state }));
  ipcMain.handle('video:metadata', fetchVideoMetadata);
  ipcMain.handle('path:guest-preload', () => {
    return pathToFileURL(path.join(__dirname, 'guest-preload.js')).toString();
  });
  ipcMain.handle('browser:user-agent', () => getDesktopChromeUserAgent());
  ipcMain.handle('app:open-external', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
