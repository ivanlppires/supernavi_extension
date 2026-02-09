/**
 * SuperNavi PathoWeb Extension - Content Script
 *
 * Detects AP case numbers from PathoWeb pages, injects stealth FAB,
 * and manages the linking modal for unconfirmed candidates.
 */

const AP_PATTERN = /\b(AP\d{6,12})\b/i;
const POLL_INTERVAL_MS = 30_000;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

let currentCaseBase = null;
let currentStatus = null;
let fabEl = null;
let popoverEl = null;
let modalEl = null;
let toastEl = null;
let debounceTimer = null;
let configCache = null;

// ============================================================================
// Config cache (fetched from background once)
// ============================================================================

async function getConfig() {
  if (configCache) return configCache;
  return new Promise(resolve => {
    chrome.storage.sync.get({
      apiBaseUrl: 'http://localhost:3001',
      debug: false,
      fabRight: 18,
      fabBottom: 88,
    }, result => {
      configCache = result;
      resolve(result);
    });
  });
}

// ============================================================================
// Case Detection
// ============================================================================

/**
 * Detect AP case base from page content.
 * Tries specific selectors first, then falls back to body text scan.
 */
function detectCaseBase() {
  // Strategy 1: Common PathoWeb selectors
  const selectors = [
    '.case-number', '.case-id', '#case-header', '#caseNumber',
    '[data-case-id]', '.patient-header', '.exam-header',
    'h1', 'h2', 'h3',
    '.breadcrumb', '.page-title', '.header-title',
  ];

  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const match = el.textContent.match(AP_PATTERN);
      if (match) return match[1].toUpperCase();
    }
  }

  // Strategy 2: Title
  const titleMatch = document.title.match(AP_PATTERN);
  if (titleMatch) return titleMatch[1].toUpperCase();

  // Strategy 3: Scan body text (limited to first 5000 chars for performance)
  const bodyText = document.body?.innerText?.substring(0, 5000) || '';
  const bodyMatch = bodyText.match(AP_PATTERN);
  if (bodyMatch) return bodyMatch[1].toUpperCase();

  return null;
}

// ============================================================================
// FAB (Floating Action Button)
// ============================================================================

async function createFAB() {
  if (fabEl) return;

  const cfg = await getConfig();

  fabEl = document.createElement('button');
  fabEl.className = 'snavi-fab';
  fabEl.title = 'SuperNavi';
  fabEl.style.right = `${cfg.fabRight}px`;
  fabEl.style.bottom = `${cfg.fabBottom}px`;
  fabEl.innerHTML = `
    <svg class="snavi-fab-icon" viewBox="0 0 24 24" fill="none" stroke="#007AFF" stroke-width="2">
      <circle cx="12" cy="12" r="3"/>
      <path d="M2 12h4m12 0h4M12 2v4m0 12v4"/>
    </svg>
    <span class="snavi-dot snavi-dot--ready"></span>
  `;
  fabEl.addEventListener('click', onFABClick);
  document.body.appendChild(fabEl);
}

function removeFAB() {
  if (fabEl) {
    fabEl.remove();
    fabEl = null;
  }
  removePopover();
}

function updateFABState(status) {
  if (!fabEl) return;
  const dot = fabEl.querySelector('.snavi-dot');
  if (!dot) return;

  dot.className = 'snavi-dot';
  if (status.readySlides?.length > 0) {
    dot.classList.add('snavi-dot--ready');
    fabEl.title = `SuperNavi: ${status.readySlides.length} lamina(s) pronta(s)`;
  } else if (status.processingSlides?.length > 0) {
    dot.classList.add('snavi-dot--processing');
    fabEl.title = 'SuperNavi: Preparando...';
  } else {
    dot.classList.add('snavi-dot--error');
    fabEl.title = 'SuperNavi: Erro';
  }
}

function onFABClick(e) {
  e.stopPropagation();
  // Always show popover (with slides list + manual input)
  togglePopover();
}

// ============================================================================
// Popover (multi-slide selection + manual caseBase input)
// ============================================================================

function createPopover(slides) {
  removePopover();

  const ready = slides || [];
  const hasSlides = ready.length > 0;

  popoverEl = document.createElement('div');
  popoverEl.className = 'snavi-popover';
  popoverEl.innerHTML = `
    ${hasSlides ? `
      <div class="snavi-popover-header">Laminas</div>
      <ul class="snavi-popover-list">
        ${ready.map(s => `
          <li class="snavi-popover-item" data-slide-id="${s.slideId}">
            ${s.thumbUrl ? `<img class="snavi-popover-thumb" src="${getThumbUrl(s.thumbUrl)}" alt="" />` : ''}
            <span class="snavi-popover-label">${escapeHtml(s.label)}</span>
          </li>
        `).join('')}
      </ul>
    ` : ''}
    <div class="snavi-popover-manual">
      <div class="snavi-popover-header">Busca manual</div>
      <div class="snavi-popover-manual-row">
        <input class="snavi-popover-input" type="text" placeholder="AP26000230"
               value="${currentCaseBase || ''}" />
        <button class="snavi-popover-go">Buscar</button>
      </div>
    </div>
  `;

  // Slide click handlers
  popoverEl.querySelectorAll('.snavi-popover-item').forEach(item => {
    item.addEventListener('click', () => {
      const slideId = item.dataset.slideId;
      requestViewerLink(slideId);
      removePopover();
    });
  });

  // Manual search
  const goBtn = popoverEl.querySelector('.snavi-popover-go');
  const inputEl = popoverEl.querySelector('.snavi-popover-input');
  goBtn.addEventListener('click', () => {
    const val = inputEl.value.trim().toUpperCase();
    if (val && AP_PATTERN.test(val)) {
      removePopover();
      onCaseChange(val.match(AP_PATTERN)[1]);
    }
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goBtn.click();
  });

  document.body.appendChild(popoverEl);

  // Show with animation
  requestAnimationFrame(() => {
    popoverEl.classList.add('snavi-popover--visible');
  });

  // Close on outside click (delayed to avoid immediate close)
  setTimeout(() => {
    document.addEventListener('click', closePopoverOnOutside, { once: true });
  }, 50);
}

function removePopover() {
  if (popoverEl) {
    popoverEl.remove();
    popoverEl = null;
  }
}

function togglePopover() {
  if (popoverEl) {
    removePopover();
  } else {
    const slides = currentStatus?.readySlides || [];
    createPopover(slides);
  }
}

function closePopoverOnOutside(e) {
  if (popoverEl && !popoverEl.contains(e.target) && !fabEl?.contains(e.target)) {
    removePopover();
  }
}

// ============================================================================
// Debug Toast
// ============================================================================

async function showDebugToast(message) {
  const cfg = await getConfig();
  if (!cfg.debug) return;

  removeToast();

  toastEl = document.createElement('div');
  toastEl.className = 'snavi-toast';
  toastEl.textContent = `[SuperNavi] ${message}`;
  document.body.appendChild(toastEl);
  requestAnimationFrame(() => toastEl.classList.add('snavi-toast--visible'));

  setTimeout(() => removeToast(), 4000);
}

function removeToast() {
  if (toastEl) {
    toastEl.remove();
    toastEl = null;
  }
}

// ============================================================================
// Modal (link confirmation)
// ============================================================================

async function showLinkModal(candidate) {
  // Check cooldown
  const cooldownKey = `dismissed:${currentCaseBase}`;
  const stored = await chromeStorageGet(cooldownKey);
  if (stored && Date.now() - stored < COOLDOWN_MS) return;

  removeModal();

  modalEl = document.createElement('div');
  modalEl.className = 'snavi-modal-overlay';
  modalEl.innerHTML = `
    <div class="snavi-modal">
      <div class="snavi-modal-body">
        <h3 class="snavi-modal-title">Lamina encontrada</h3>
        <p class="snavi-modal-text">
          Encontramos uma lamina recente compativel com este caso. Vincular agora?
        </p>
        ${candidate.thumbUrl ? `<img class="snavi-modal-thumb" src="${getThumbUrl(candidate.thumbUrl)}" alt="Preview" />` : ''}
        <p class="snavi-modal-filename">${escapeHtml(candidate.filename)}</p>
      </div>
      <div class="snavi-modal-actions">
        <button class="snavi-modal-btn snavi-modal-btn--dismiss">Nao agora</button>
        <button class="snavi-modal-btn snavi-modal-btn--confirm">Vincular</button>
      </div>
    </div>
  `;

  modalEl.querySelector('.snavi-modal-btn--dismiss').addEventListener('click', async () => {
    await chromeStorageSet(cooldownKey, Date.now());
    removeModal();
  });

  modalEl.querySelector('.snavi-modal-btn--confirm').addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'ATTACH_SLIDE',
      slideId: candidate.slideId,
      caseBase: currentCaseBase,
    });
    removeModal();
  });

  document.body.appendChild(modalEl);
  requestAnimationFrame(() => {
    modalEl.classList.add('snavi-modal-overlay--visible');
  });
}

function removeModal() {
  if (modalEl) {
    modalEl.remove();
    modalEl = null;
  }
}

// ============================================================================
// Communication with Background
// ============================================================================

function requestCaseStatus(caseBase) {
  chrome.runtime.sendMessage({ type: 'CASE_DETECTED', caseBase });
}

function requestViewerLink(slideId) {
  // Debounce to prevent multiple tabs
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => { debounceTimer = null; }, 2000);

  chrome.runtime.sendMessage({
    type: 'REQUEST_VIEWER_LINK',
    slideId,
    externalCaseId: currentCaseBase ? `pathoweb:${currentCaseBase}` : undefined,
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CASE_STATUS') {
    currentStatus = msg;
    handleStatusUpdate(msg);
  }

  if (msg.type === 'CASE_STATUS_ERROR') {
    showDebugToast(`API error: ${msg.error}`);
    removeFAB();
  }

  if (msg.type === 'VIEWER_LINK') {
    window.open(msg.url, '_blank');
  }

  if (msg.type === 'ATTACH_RESULT') {
    if (msg.success) {
      chrome.runtime.sendMessage({ type: 'REFRESH_STATUS', caseBase: currentCaseBase });
    }
  }
});

// ============================================================================
// State Management
// ============================================================================

function handleStatusUpdate(status) {
  const hasReady = status.readySlides?.length > 0;
  const hasProcessing = status.processingSlides?.length > 0;
  const hasCandidates = status.unconfirmedCandidates?.length > 0;

  if (hasReady || hasProcessing) {
    createFAB();
    updateFABState(status);
  } else {
    removeFAB();
  }

  // Show modal for unconfirmed candidates only when no ready slides
  if (!hasReady && hasCandidates) {
    const best = status.unconfirmedCandidates[0];
    if (best.score >= 0.85) {
      showLinkModal(best);
    }
  }
}

function onCaseChange(newCaseBase) {
  if (newCaseBase === currentCaseBase) return;

  currentCaseBase = newCaseBase;
  currentStatus = null;
  removeFAB();
  removePopover();
  removeModal();

  if (currentCaseBase) {
    requestCaseStatus(currentCaseBase);
  }
}

// ============================================================================
// Navigation Observation (SPA support)
// ============================================================================

function startObserver() {
  const observer = new MutationObserver(() => {
    const detected = detectCaseBase();
    if (detected !== currentCaseBase) {
      onCaseChange(detected);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Also poll as fallback
  setInterval(() => {
    const detected = detectCaseBase();
    if (detected !== currentCaseBase) {
      onCaseChange(detected);
    }
  }, POLL_INTERVAL_MS);
}

// ============================================================================
// Utility
// ============================================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Resolve thumb URL. Uses cached config (sync) since it's called in template strings.
 * Config is always loaded before any UI rendering (init() calls getConfig() first).
 */
function getThumbUrl(path) {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  const base = configCache?.apiBaseUrl || 'http://localhost:3001';
  return `${base}${path}`;
}

async function chromeStorageGet(key) {
  return new Promise(resolve => {
    chrome.storage.local.get(key, result => resolve(result[key]));
  });
}

async function chromeStorageSet(key, value) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

// ============================================================================
// Init
// ============================================================================

async function init() {
  // Pre-fetch config so getThumbUrl sync works
  await getConfig();

  const detected = detectCaseBase();
  if (detected) {
    currentCaseBase = detected;
    requestCaseStatus(detected);
  } else {
    showDebugToast('Nenhum caso AP detectado nesta pagina');
  }
  startObserver();
}

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
