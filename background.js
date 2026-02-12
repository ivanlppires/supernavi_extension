/**
 * SuperNavi PathoWeb Extension - Background Service Worker
 *
 * Handles API calls to SuperNavi UI-Bridge, caching, and message relay.
 */

// In-memory cache for case status (30s TTL)
const statusCache = new Map();
const CACHE_TTL_MS = 30_000;

/**
 * Get configuration from chrome.storage.sync
 */
async function getConfig() {
  const result = await chrome.storage.sync.get({
    apiBaseUrl: 'http://localhost:3001',
    apiKey: '',
    deviceToken: '',
    debug: false,
  });
  return result;
}

function log(...args) {
  getConfig().then(cfg => {
    if (cfg.debug) console.log('[SuperNavi]', ...args);
  });
}

/**
 * Make authenticated API call to SuperNavi UI-Bridge
 */
async function apiCall(path, options = {}) {
  const config = await getConfig();

  if (!config.deviceToken && !config.apiKey) {
    throw new Error('Not configured: pair the device or set an API key');
  }

  const url = `${config.apiBaseUrl}${path}`;
  log('API call:', options.method || 'GET', url);

  // Dual-mode auth: prefer device token over legacy API key
  const authHeaders = {};
  if (config.deviceToken) {
    authHeaders['x-device-token'] = config.deviceToken;
  } else if (config.apiKey) {
    authHeaders['x-supernavi-key'] = config.apiKey;
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`API ${response.status}: ${text}`);
  }

  return response.json();
}

/**
 * Get case status with caching
 */
async function getCaseStatus(caseBase) {
  const cacheKey = caseBase.toUpperCase();
  const cached = statusCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    log('Cache hit for', cacheKey);
    return cached.data;
  }

  const data = await apiCall(`/api/ui-bridge/cases/${encodeURIComponent(caseBase)}/status`);
  statusCache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

/**
 * Get extension auth info (device + user)
 */
async function getAuthInfo() {
  try {
    return await apiCall('/api/ui-bridge/me');
  } catch (err) {
    log('Auth info error:', err.message);
    return { authenticated: false, device: null, user: null };
  }
}

/**
 * Handle messages from content script
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.type === 'GET_AUTH_INFO') {
    getAuthInfo()
      .then(data => {
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'AUTH_INFO', ...data });
        }
      })
      .catch(err => {
        log('Auth info error:', err.message);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'AUTH_INFO', authenticated: false });
        }
      });
    return true;
  }

  if (msg.type === 'CLAIM_PAIRING_CODE') {
    const { code } = msg;
    log('Claiming pairing code:', code);

    (async () => {
      try {
        const config = await getConfig();
        const url = `${config.apiBaseUrl}/api/ui-bridge/pairing/claim`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const errorMsg = response.status === 404 ? 'Codigo invalido'
            : response.status === 410 ? 'Codigo expirado ou ja usado'
            : `Erro ${response.status}`;
          if (tabId) {
            chrome.tabs.sendMessage(tabId, { type: 'PAIRING_RESULT', success: false, error: errorMsg });
          }
          return;
        }

        const data = await response.json();

        // Store device credentials
        await chrome.storage.sync.set({
          deviceToken: data.deviceToken,
          deviceId: data.deviceId,
          deviceName: data.deviceName,
        });

        log('Device paired:', data.deviceName);

        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'PAIRING_RESULT', success: true, deviceName: data.deviceName });
        }

        // Fetch and send updated auth info
        const authData = await getAuthInfo();
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'AUTH_INFO', ...authData });
        }
      } catch (err) {
        log('Pairing error:', err.message);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'PAIRING_RESULT', success: false, error: 'Erro de conexao' });
        }
      }
    })();

    return true;
  }

  if (msg.type === 'CASE_DETECTED') {
    log('Case detected:', msg.caseBase);

    getCaseStatus(msg.caseBase)
      .then(data => {
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'CASE_STATUS',
            caseBase: msg.caseBase,
            ...data,
          });
        }
      })
      .catch(err => {
        log('API error:', err.message);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'CASE_STATUS_ERROR',
            caseBase: msg.caseBase,
            error: err.message,
          });
        }
      });

    return true; // Keep channel open for async
  }

  if (msg.type === 'REQUEST_VIEWER_LINK') {
    log('Requesting viewer link for slide:', msg.slideId);

    apiCall('/api/ui-bridge/viewer-link', {
      method: 'POST',
      body: JSON.stringify({
        slideId: msg.slideId,
        externalCaseId: msg.externalCaseId,
        patientData: msg.patientData || undefined,
      }),
    })
      .then(data => {
        // Open viewer in new tab directly from background (avoids popup blocker)
        chrome.tabs.create({ url: data.url });
      })
      .catch(err => {
        log('Viewer link error:', err.message);
      });

    return true;
  }

  if (msg.type === 'ATTACH_SLIDE') {
    log('Attaching slide', msg.slideId, 'to case', msg.caseBase);

    apiCall(`/api/ui-bridge/cases/${encodeURIComponent(msg.caseBase)}/attach`, {
      method: 'POST',
      body: JSON.stringify({ slideId: msg.slideId }),
    })
      .then(() => {
        // Invalidate cache
        statusCache.delete(msg.caseBase.toUpperCase());

        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'ATTACH_RESULT',
            success: true,
            slideId: msg.slideId,
            caseBase: msg.caseBase,
          });
        }
      })
      .catch(err => {
        log('Attach error:', err.message);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'ATTACH_RESULT',
            success: false,
            error: err.message,
          });
        }
      });

    return true;
  }

  if (msg.type === 'REFRESH_STATUS') {
    // Force cache invalidation and re-fetch
    statusCache.delete(msg.caseBase?.toUpperCase());
    if (msg.caseBase) {
      getCaseStatus(msg.caseBase)
        .then(data => {
          if (tabId) {
            chrome.tabs.sendMessage(tabId, {
              type: 'CASE_STATUS',
              caseBase: msg.caseBase,
              ...data,
            });
          }
        })
        .catch(err => log('Refresh error:', err.message));
    }
    return true;
  }
});
