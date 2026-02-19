/**
 * SuperNavi PathoWeb Extension - Background Service Worker
 *
 * Cloud-first architecture: all data comes from cloud API.
 * Bindings connect PathoWeb cases to SuperNavi slides.
 */

// In-memory cache for case status (30s TTL)
const statusCache = new Map();
const CACHE_TTL_MS = 30_000;

/**
 * Get configuration from chrome.storage.sync
 */
async function getConfig() {
  return chrome.storage.sync.get({
    apiBaseUrl: 'https://cloud.supernavi.app',
    apiKey: '',
    deviceToken: '',
    debug: false,
  });
}

function log(...args) {
  getConfig().then(cfg => {
    if (cfg.debug) console.log('[SuperNavi]', ...args);
  });
}

/**
 * Make authenticated API call to SuperNavi cloud
 */
async function apiCall(path, options = {}) {
  const config = await getConfig();

  if (!config.deviceToken && !config.apiKey) {
    throw new Error('Not configured: pair the device or set an API key');
  }

  const url = `${config.apiBaseUrl}${path}`;
  log('API call:', options.method || 'GET', url);

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
 * Get case status from cloud
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
 * Get bindings for a pathowebRef
 */
async function getBindings(pathowebRef) {
  return apiCall(`/api/v1/bindings/${encodeURIComponent(pathowebRef)}`);
}

/**
 * Create a binding between a pathowebRef and a slideId
 */
async function createBinding(pathowebRef, slideId) {
  return apiCall('/api/v1/bindings', {
    method: 'POST',
    body: JSON.stringify({ pathowebRef, slideId }),
  });
}

/**
 * Get READY slides available for binding
 */
async function getReadySlides() {
  return apiCall('/api/v1/slides/ready');
}

/**
 * Get extension auth info
 */
async function getAuthInfo() {
  try {
    const data = await apiCall('/api/ui-bridge/me');
    return data;
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
          const errorMsg = response.status === 404 ? 'Codigo invalido'
            : response.status === 410 ? 'Codigo expirado ou ja usado'
            : `Erro ${response.status}`;
          if (tabId) {
            chrome.tabs.sendMessage(tabId, { type: 'PAIRING_RESULT', success: false, error: errorMsg });
          }
          return;
        }

        const data = await response.json();

        await chrome.storage.sync.set({
          deviceToken: data.deviceToken,
          deviceId: data.deviceId,
          deviceName: data.deviceName,
        });

        log('Device paired:', data.deviceName);

        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'PAIRING_RESULT', success: true, deviceName: data.deviceName });
        }

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

    return true;
  }

  if (msg.type === 'GET_BINDINGS') {
    log('Getting bindings for:', msg.pathowebRef);

    getBindings(msg.pathowebRef)
      .then(data => {
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'BINDINGS_RESULT', ...data });
        }
      })
      .catch(err => {
        log('Bindings error:', err.message);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'BINDINGS_RESULT',
            pathowebRef: msg.pathowebRef,
            bindings: [],
            error: err.message,
          });
        }
      });

    return true;
  }

  if (msg.type === 'CREATE_BINDING') {
    log('Creating binding:', msg.pathowebRef, '->', msg.slideId);

    createBinding(msg.pathowebRef, msg.slideId)
      .then(data => {
        statusCache.delete(msg.pathowebRef?.toUpperCase());
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'BINDING_CREATED', ...data });
        }
      })
      .catch(err => {
        log('Create binding error:', err.message);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'BINDING_CREATED', ok: false, error: err.message });
        }
      });

    return true;
  }

  if (msg.type === 'GET_READY_SLIDES') {
    log('Fetching READY slides');

    getReadySlides()
      .then(data => {
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'READY_SLIDES', ...data });
        }
      })
      .catch(err => {
        log('Ready slides error:', err.message);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'READY_SLIDES', slides: [] });
        }
      });

    return true;
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
        chrome.tabs.create({ url: data.url });
        if (tabId) chrome.tabs.sendMessage(tabId, { type: 'VIEWER_LINK_OPENED', slideId: msg.slideId });
      })
      .catch(err => {
        log('Viewer link error:', err.message);
        if (tabId) chrome.tabs.sendMessage(tabId, { type: 'VIEWER_LINK_ERROR', slideId: msg.slideId, error: err.message });
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

  if (msg.type === 'DETACH_SLIDE') {
    log('Detaching slide', msg.slideId, 'from case', msg.caseBase);

    apiCall(`/api/ui-bridge/cases/${encodeURIComponent(msg.caseBase)}/detach`, {
      method: 'POST',
      body: JSON.stringify({ slideId: msg.slideId }),
    })
      .then(() => {
        statusCache.delete(msg.caseBase.toUpperCase());
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'DETACH_RESULT',
            success: true,
            slideId: msg.slideId,
            caseBase: msg.caseBase,
          });
        }
      })
      .catch(err => {
        log('Detach error:', err.message);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'DETACH_RESULT',
            success: false,
            error: err.message,
          });
        }
      });

    return true;
  }

  if (msg.type === 'GET_UNLINKED_SLIDES') {
    log('Fetching unlinked slides');

    apiCall('/api/ui-bridge/slides/unlinked')
      .then(data => {
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'UNLINKED_SLIDES',
            slides: data.slides || [],
          });
        }
      })
      .catch(err => {
        log('Unlinked slides error:', err.message);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'UNLINKED_SLIDES',
            slides: [],
          });
        }
      });

    return true;
  }

  if (msg.type === 'REFRESH_STATUS') {
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
