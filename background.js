/**
 * SuperNavi PathoWeb Extension - Background Service Worker
 *
 * Edge-first architecture: discovers slides from local edge agent via tunnel,
 * falls back to cloud when edge is unavailable.
 */

// In-memory cache for case status (30s TTL)
const statusCache = new Map();
const CACHE_TTL_MS = 30_000;
const EDGE_TIMEOUT_MS = 3_000;

// Edge agent ID — resolved from /api/ui-bridge/me on auth
let edgeAgentId = null;

/**
 * Get configuration from chrome.storage.sync
 */
async function getConfig() {
  const result = await chrome.storage.sync.get({
    apiBaseUrl: 'https://cloud.supernavi.app',
    apiKey: '',
    deviceToken: '',
    edgeAgentId: '',
    debug: false,
  });
  // Restore cached edgeAgentId
  if (!edgeAgentId && result.edgeAgentId) {
    edgeAgentId = result.edgeAgentId;
  }
  return result;
}

function log(...args) {
  getConfig().then(cfg => {
    if (cfg.debug) console.log('[SuperNavi]', ...args);
  });
}

/**
 * Make authenticated API call to SuperNavi UI-Bridge (cloud)
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
 * Make a call to the edge agent via cloud tunnel.
 * Returns null on any failure (for easy fallback).
 */
async function edgeCall(path, options = {}) {
  if (!edgeAgentId) return null;

  const config = await getConfig();
  const url = `${config.apiBaseUrl}/edge/${edgeAgentId}${path}`;
  log('Edge call:', options.method || 'GET', url);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EDGE_TIMEOUT_MS);

    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;
    return response.json();
  } catch (err) {
    log('Edge call failed:', err.message);
    return null;
  }
}

/**
 * Get case status — edge-first with cloud fallback
 */
async function getCaseStatus(caseBase) {
  const cacheKey = caseBase.toUpperCase();
  const cached = statusCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    log('Cache hit for', cacheKey);
    return cached.data;
  }

  // Try edge first
  const edgeData = await edgeCall(`/v1/cases/by-ref/${encodeURIComponent(caseBase)}`);
  if (edgeData && edgeData.slides) {
    log('Case status from EDGE:', caseBase);
    const mapped = {
      caseBase: edgeData.caseBase || caseBase,
      externalCaseId: `pathoweb:${caseBase.toUpperCase()}`,
      readySlides: edgeData.slides.map((s, i) => ({
        slideId: s.slideId,
        label: null,
        filename: s.filename,
        index: i + 1,
        thumbUrl: `/edge/${edgeAgentId}/v1/slides/${s.slideId}/thumb`,
        width: s.width,
        height: s.height,
      })),
      processingSlides: [],
      unconfirmedCandidates: [],
      source: 'edge',
    };
    statusCache.set(cacheKey, { data: mapped, timestamp: Date.now() });
    return mapped;
  }

  // Fallback to cloud
  log('Falling back to cloud for case status:', caseBase);
  const data = await apiCall(`/api/ui-bridge/cases/${encodeURIComponent(caseBase)}/status`);
  statusCache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

/**
 * Get unlinked slides — edge-first with cloud fallback
 */
async function getUnlinkedSlides() {
  // Try edge first
  const edgeData = await edgeCall('/v1/slides/unlinked');
  if (edgeData && edgeData.slides) {
    log('Unlinked slides from EDGE:', edgeData.slides.length);
    return edgeData.slides.map(s => ({
      slideId: s.slideId,
      filename: s.filename,
      thumbUrl: `/edge/${edgeAgentId}/v1/slides/${s.slideId}/thumb`,
      width: s.width,
      height: s.height,
      hasPreview: true,
      createdAt: s.createdAt,
    }));
  }

  // Fallback to cloud
  log('Falling back to cloud for unlinked slides');
  const data = await apiCall('/api/ui-bridge/slides/unlinked');
  return data.slides || [];
}

/**
 * Attach slide to case — edge-first with cloud sync
 */
async function attachSlide(slideId, caseBase, patientData) {
  // Try edge first
  const edgeResult = await edgeCall(`/v1/slides/${slideId}/link-to-case`, {
    method: 'POST',
    body: JSON.stringify({ caseBase, patientName: patientData?.patientName }),
  });

  if (edgeResult && edgeResult.ok) {
    log('Slide attached via EDGE:', slideId, caseBase);

    // Fire-and-forget: also sync to cloud
    apiCall(`/api/ui-bridge/cases/${encodeURIComponent(caseBase)}/attach`, {
      method: 'POST',
      body: JSON.stringify({ slideId }),
    }).catch(err => log('Cloud sync attach (background):', err.message));

    return { success: true };
  }

  // Fallback to cloud
  log('Falling back to cloud for attach:', slideId, caseBase);
  await apiCall(`/api/ui-bridge/cases/${encodeURIComponent(caseBase)}/attach`, {
    method: 'POST',
    body: JSON.stringify({ slideId }),
  });
  return { success: true };
}

/**
 * Get extension auth info (device + user + edgeAgentId)
 */
async function getAuthInfo() {
  try {
    const data = await apiCall('/api/ui-bridge/me');

    // Store edge agent ID
    if (data.edgeAgentId) {
      edgeAgentId = data.edgeAgentId;
      chrome.storage.sync.set({ edgeAgentId: data.edgeAgentId });
      log('Edge agent ID resolved:', edgeAgentId);
    }

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

        // Fetch and send updated auth info (also resolves edgeAgentId)
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
      })
      .catch(err => {
        log('Viewer link error:', err.message);
      });

    return true;
  }

  if (msg.type === 'ATTACH_SLIDE') {
    log('Attaching slide', msg.slideId, 'to case', msg.caseBase);

    attachSlide(msg.slideId, msg.caseBase, msg.patientData)
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

    getUnlinkedSlides()
      .then(slides => {
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'UNLINKED_SLIDES',
            slides,
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
