/**
 * SuperNavi PathoWeb Extension - Content Script
 *
 * Detects AP case numbers from PathoWeb pages, injects a side handle
 * that opens a drawer with slide list and manual search.
 */

const AP_PATTERN = /\b(AP\d{6,12})\b/i;
const POLL_INTERVAL_MS = 30_000;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

let currentCaseBase = null;
let currentStatus = null;
let currentPatientData = null; // { patientName, patientId, age, doctor }
let authInfo = null;
let handleEl = null;
let drawerEl = null;
let drawerOpen = false;
let modalEl = null;
let toastEl = null;
let unlinkedSlides = null; // cached unlinked slides from cloud
let debounceTimer = null;
let configCache = null;

// ============================================================================
// SVG Icons
// ============================================================================

const THUMB_PLACEHOLDER_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.46,6.28L11.05,9C8.47,9.26 6.5,11.41 6.5,14A5,5 0 0,0 11.5,19C13.55,19 15.31,17.77 16.08,16H13.5V14H21.5V16H19.25C18.84,17.57 17.97,18.96 16.79,20H19.5V22H3.5V20H6.21C4.55,18.53 3.5,16.39 3.5,14C3.5,10.37 5.96,7.2 9.46,6.28M12.74,2.07L13.5,3.37L14.36,2.87L17.86,8.93L14.39,10.93L10.89,4.87L11.76,4.37L11,3.07L12.74,2.07Z"/></svg>`;

const ICON = {
  close: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>
  </svg>`,
  chevron: `<svg class="snavi-drawer-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 3l5 5-5 5"/>
  </svg>`,
  folder: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3A1 1 0 002 4.5z"/>
  </svg>`,
  slide: `<svg class="snavi-drawer-empty-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
    <rect x="8" y="14" width="32" height="20" rx="3"/>
    <circle cx="24" cy="24" r="5.5"/><circle cx="24" cy="24" r="1.5"/>
  </svg>`,
  user: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="8" cy="5.5" r="2.5"/><path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5"/>
  </svg>`,
  search: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <circle cx="7" cy="7" r="4.5"/><line x1="10.2" y1="10.2" x2="13.5" y2="13.5"/>
  </svg>`,
  link: `<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16.5 23.5a6.5 6.5 0 009.2 0l4-4a6.5 6.5 0 00-9.2-9.2l-2 2"/>
    <path d="M23.5 16.5a6.5 6.5 0 00-9.2 0l-4 4a6.5 6.5 0 009.2 9.2l2-2"/>
  </svg>`,
  check: `<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 21l6 6 10-13"/>
  </svg>`,
};

// ============================================================================
// Config
// ============================================================================

async function getConfig() {
  if (configCache) return configCache;
  return new Promise(resolve => {
    chrome.storage.sync.get({
      apiBaseUrl: 'https://cloud.supernavi.app',
      debug: false,
    }, result => {
      configCache = result;
      resolve(result);
    });
  });
}

// ============================================================================
// Case Detection
// ============================================================================

function detectCaseBase() {
  // First try prominent elements (headers, case-specific selectors)
  const selectors = [
    '#botaoMenu',
    '.case-number', '.case-id', '#case-header', '#caseNumber',
    '[data-case-id]', '.patient-header', '.exam-header',
    '.btn-cabecalho',
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

  const titleMatch = document.title.match(AP_PATTERN);
  if (titleMatch) return titleMatch[1].toUpperCase();

  // Fallback: scan body text, but only if there's a SINGLE unique AP number.
  // Multiple AP numbers means it's a list page, not a single case view.
  const bodyText = document.body?.innerText?.substring(0, 10000) || '';
  const allMatches = bodyText.match(new RegExp(AP_PATTERN.source, 'gi'));
  if (allMatches) {
    const unique = new Set(allMatches.map(m => m.toUpperCase()));
    if (unique.size === 1) {
      return [...unique][0];
    }
  }

  return null;
}

// ============================================================================
// Patient Data Scraping (AJAX-loaded content)
// ============================================================================

function scrapePatientData() {
  // PathoWeb renders patient info as label:value pairs in the page body.
  // Scan the visible text for known patterns.
  const text = document.body?.innerText || '';

  const data = {};

  // Paciente: NOME COMPLETO (stop before Id: or next label)
  const patientMatch = text.match(/Paciente:\s*(.+?)(?=\s+Id:|\s+Idade:|\n|\r|$)/i);
  if (patientMatch) data.patientName = patientMatch[1].trim();

  // Id: 12345678
  const idMatch = text.match(/\bId:\s*(\d+)/i);
  if (idMatch) data.patientId = idMatch[1].trim();

  // Idade: 25
  const ageMatch = text.match(/Idade:\s*(\d+)/i);
  if (ageMatch) data.age = ageMatch[1].trim();

  // Médico requisitante: NOME (stop before next label or line break)
  // Note: "Médico" may appear as "MÃ©dico" due to encoding issues
  const doctorMatch = text.match(/[Mm](?:[ée]|Ã©)dico\s+requisitante:\s*(.+?)(?=\s+[Mm](?:[ée]|Ã©)dico|\n|\r|$)/i);
  if (doctorMatch) data.doctor = doctorMatch[1].trim();

  return Object.keys(data).length > 0 ? data : null;
}

/**
 * Try to scrape patient data, retrying a few times since AJAX loads late.
 */
function scrapePatientDataWithRetry(maxAttempts = 6, intervalMs = 2000) {
  let attempts = 0;
  const tryNow = () => {
    attempts++;
    const data = scrapePatientData();
    if (data && data.patientName) {
      currentPatientData = data;
      return;
    }
    if (attempts < maxAttempts) {
      setTimeout(tryNow, intervalMs);
    }
  };
  tryNow();
}

// ============================================================================
// Handle
// ============================================================================

async function createHandle() {
  if (handleEl) return;

  handleEl = document.createElement('button');
  handleEl.className = 'snavi-handle';
  handleEl.title = 'SuperNavi';
  handleEl.innerHTML = '<span class="snavi-handle-text">SUPERNAVI</span>';
  handleEl.addEventListener('click', onHandleClick);
  document.body.appendChild(handleEl);
}

function removeHandle() {
  if (handleEl) {
    handleEl.remove();
    handleEl = null;
  }
  closeDrawer();
}

function updateHandleState(status) {
  if (!handleEl) return;
  if (status.readySlides?.length > 0) {
    handleEl.title = `SuperNavi: ${status.readySlides.length} lâmina(s) pronta(s)`;
  } else if (status.processingSlides?.length > 0) {
    handleEl.title = 'SuperNavi: Preparando...';
  }
}

function onHandleClick(e) {
  e.stopPropagation();
  toggleDrawer();
}

// ============================================================================
// Drawer
// ============================================================================

function getStatusClass() {
  if (!currentStatus) return '';
  if (currentStatus.readySlides?.length > 0) return 'snavi-drawer-status--ready';
  if (currentStatus.processingSlides?.length > 0) return 'snavi-drawer-status--processing';
  return 'snavi-drawer-status--error';
}

function createDrawer() {
  if (drawerEl) return;
  drawerEl = document.createElement('div');
  drawerEl.className = 'snavi-drawer';
  document.body.appendChild(drawerEl);
}

function renderDrawerContent() {
  if (!drawerEl) return;

  // ── Not authenticated: full-drawer pairing onboarding ──
  if (!authInfo?.authenticated) {
    renderPairingView();
    return;
  }

  // ── Authenticated: normal slide drawer ──
  renderAuthenticatedView();

  // Fetch unlinked slides if not cached yet
  if (unlinkedSlides === null) {
    chrome.runtime.sendMessage({ type: 'GET_UNLINKED_SLIDES' });
  }
}

function renderPairingView() {
  const statusCls = getStatusClass();

  drawerEl.innerHTML = `
    <div class="snavi-drawer-header">
      <div class="snavi-drawer-brand">
        <img class="snavi-drawer-logo" src="${chrome.runtime.getURL('icons/icon48.png')}" alt="" />
        <span class="snavi-drawer-title">SuperNavi</span>
        ${statusCls ? `<span class="snavi-drawer-status ${statusCls}"></span>` : ''}
      </div>
      <button class="snavi-drawer-close">${ICON.close}</button>
    </div>
    <div class="snavi-pair-view">
      <div class="snavi-pair-hero">
        <div class="snavi-pair-icon-ring">
          <div class="snavi-pair-icon">${ICON.link}</div>
        </div>
        <h2 class="snavi-pair-title">Conectar dispositivo</h2>
        <p class="snavi-pair-desc">Vincule esta extensao a sua conta SuperNavi para visualizar lâminas diretamente do PathoWeb.</p>
      </div>

      <div class="snavi-pair-steps">
        <div class="snavi-pair-step">
          <span class="snavi-pair-step-num">1</span>
          <span class="snavi-pair-step-text">Abra <a href="https://viewer.supernavi.app/pair" target="_blank" class="snavi-pair-link">viewer.supernavi.app/pair</a></span>
        </div>
        <div class="snavi-pair-step">
          <span class="snavi-pair-step-num">2</span>
          <span class="snavi-pair-step-text">Gere um <strong>codigo de pareamento</strong></span>
        </div>
        <div class="snavi-pair-step">
          <span class="snavi-pair-step-num">3</span>
          <span class="snavi-pair-step-text">Insira o codigo abaixo</span>
        </div>
      </div>

      <div class="snavi-pair-form">
        <div class="snavi-pair-input-wrap">
          <input class="snavi-pair-input" type="text"
                 maxlength="6" autocomplete="off" spellcheck="false"
                 placeholder="------" />
          <div class="snavi-pair-dots">
            <span class="snavi-pair-dot"></span>
            <span class="snavi-pair-dot"></span>
            <span class="snavi-pair-dot"></span>
            <span class="snavi-pair-dot"></span>
            <span class="snavi-pair-dot"></span>
            <span class="snavi-pair-dot"></span>
          </div>
        </div>
        <button class="snavi-pair-btn" disabled>
          <span class="snavi-pair-btn-text">Conectar</span>
        </button>
        <div class="snavi-pair-feedback"></div>
      </div>
    </div>
  `;

  // Wire close
  drawerEl.querySelector('.snavi-drawer-close').addEventListener('click', closeDrawer);

  // Wire pairing form
  const input = drawerEl.querySelector('.snavi-pair-input');
  const btn = drawerEl.querySelector('.snavi-pair-btn');
  const dots = drawerEl.querySelectorAll('.snavi-pair-dot');

  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const len = input.value.length;

    // Update dot indicators
    dots.forEach((dot, i) => {
      dot.classList.toggle('snavi-pair-dot--filled', i < len);
    });

    // Enable button only when 6 chars
    btn.disabled = len !== 6;
  });

  btn.addEventListener('click', () => {
    const code = input.value.trim();
    if (code.length !== 6) return;
    btn.disabled = true;
    btn.classList.add('snavi-pair-btn--loading');
    btn.querySelector('.snavi-pair-btn-text').textContent = 'Conectando...';
    try {
      chrome.runtime.sendMessage({ type: 'CLAIM_PAIRING_CODE', code });
    } catch (err) {
      // Extension context invalidated — reload to reconnect
      btn.disabled = false;
      btn.classList.remove('snavi-pair-btn--loading');
      btn.querySelector('.snavi-pair-btn-text').textContent = 'Conectar';
      const feedbackEl = drawerEl?.querySelector('.snavi-pair-feedback');
      if (feedbackEl) {
        feedbackEl.textContent = 'Extensao recarregada. Tente novamente.';
        feedbackEl.classList.add('snavi-pair-feedback--error');
      }
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btn.click();
  });

  // Auto-focus input
  setTimeout(() => input.focus(), 300);
}

function renderAuthenticatedView() {
  const slides = [
    ...(currentStatus?.readySlides || []),
    ...(currentStatus?.processingSlides || []),
  ];
  const hasSlides = slides.length > 0;
  const statusCls = getStatusClass();

  drawerEl.innerHTML = `
    <div class="snavi-drawer-header">
      <div class="snavi-drawer-brand">
        <img class="snavi-drawer-logo" src="${chrome.runtime.getURL('icons/icon48.png')}" alt="" />
        <span class="snavi-drawer-title">SuperNavi</span>
        ${statusCls ? `<span class="snavi-drawer-status ${statusCls}"></span>` : ''}
      </div>
      <button class="snavi-drawer-close">${ICON.close}</button>
    </div>
    <div class="snavi-drawer-body">
      ${currentCaseBase ? `
        <div class="snavi-drawer-case">
          <div class="snavi-drawer-case-icon">${ICON.folder}</div>
          <div class="snavi-drawer-case-info">
            <div class="snavi-drawer-case-label">Caso ativo</div>
            <div class="snavi-drawer-case-value">${escapeHtml(currentCaseBase)}</div>
          </div>
        </div>
      ` : ''}

      ${hasSlides ? `
        <div class="snavi-drawer-section">Lâminas do caso (${slides.length})</div>
        <ul class="snavi-drawer-list">
          ${slides.map((s, i) => {
            const dims = formatDimensions(s.width, s.height);
            return `
            <li class="snavi-drawer-item" data-slide-id="${s.slideId}" style="--i:${i}">
              ${s.thumbUrl
                ? `<img class="snavi-drawer-thumb" src="${getThumbUrl(s.thumbUrl)}" alt="" />`
                : `<div class="snavi-drawer-thumb snavi-thumb-placeholder">${THUMB_PLACEHOLDER_SVG}</div>`}
              <div class="snavi-drawer-item-info">
                <span class="snavi-drawer-label">${escapeHtml(formatSlideLabel(s, i))}</span>
                <span class="snavi-drawer-sublabel">${dims || 'Abrir no viewer'}</span>
              </div>
              <button class="snavi-detach-btn" data-detach-slide-id="${s.slideId}" title="Desvincular">✕</button>
              ${ICON.chevron}
            </li>`;
          }).join('')}
        </ul>
      ` : `
        ${!(unlinkedSlides && unlinkedSlides.length > 0) ? `
          <div class="snavi-drawer-empty">
            ${ICON.slide}
            <span class="snavi-drawer-empty-text">
              ${currentCaseBase
                ? 'Nenhuma lâmina encontrada para este caso.'
                : 'Nenhum caso AP detectado nesta pagina.'}
            </span>
          </div>
        ` : ''}
      `}

      ${unlinkedSlides && unlinkedSlides.length > 0 ? `
        <div class="snavi-drawer-section">Lâminas sem caso (${unlinkedSlides.length})</div>
        <div class="snavi-unlinked-list">
          ${unlinkedSlides.map((s, i) => {
            const dims = formatDimensions(s.width, s.height);
            const date = formatRelativeDate(s.createdAt);
            const dotIdx = s.filename.lastIndexOf('.');
            const name = dotIdx > 0 ? s.filename.substring(0, dotIdx) : s.filename;
            const ext = dotIdx > 0 ? s.filename.substring(dotIdx) : '';
            return `
            <div class="snavi-unlinked-card" style="--i:${i}">
              ${s.thumbUrl
                ? `<img class="snavi-unlinked-thumb" src="${getThumbUrl(s.thumbUrl)}" alt="" />`
                : `<div class="snavi-unlinked-thumb snavi-thumb-placeholder">${THUMB_PLACEHOLDER_SVG}</div>`}
              <div class="snavi-unlinked-body">
                <span class="snavi-unlinked-filename">${escapeHtml(name)}</span>
                <span class="snavi-unlinked-meta">${[ext, dims, date].filter(Boolean).join(' · ')}</span>
              </div>
              ${currentCaseBase
                ? `<button class="snavi-drawer-link-btn" data-link-slide-id="${s.slideId}">Vincular</button>`
                : ''}
            </div>`;
          }).join('')}
        </div>
      ` : ''}
    </div>
    <div class="snavi-drawer-search-section snavi-hidden">
      <div class="snavi-drawer-search-row">
        <input class="snavi-drawer-input" type="text" placeholder="Ex: AP26000230"
               value="${currentCaseBase || ''}" />
        <button class="snavi-drawer-go">Ir</button>
      </div>
    </div>
    <div class="snavi-drawer-footer">
      ${authInfo.user
        ? `<div class="snavi-drawer-user">
            ${authInfo.user.avatarUrl
              ? `<img class="snavi-drawer-user-avatar" src="${escapeHtml(authInfo.user.avatarUrl)}" alt="" />`
              : `<div class="snavi-drawer-user-icon">${ICON.user}</div>`}
            <div class="snavi-drawer-user-info">
              <span class="snavi-drawer-user-name">${escapeHtml(authInfo.user.name)}</span>
              <span class="snavi-drawer-user-detail">${escapeHtml(authInfo.device?.name || '')}</span>
            </div>
            <button class="snavi-search-toggle" title="Buscar caso">${ICON.search}</button>
          </div>`
        : `<div class="snavi-drawer-user">
            <div class="snavi-drawer-user-icon">${ICON.user}</div>
            <div class="snavi-drawer-user-info">
              <span class="snavi-drawer-user-name">API Key</span>
              <span class="snavi-drawer-user-detail">Modo legado</span>
            </div>
            <button class="snavi-search-toggle" title="Buscar caso">${ICON.search}</button>
          </div>`}
    </div>
  `;

  drawerEl.querySelector('.snavi-drawer-close').addEventListener('click', closeDrawer);

  // Replace broken thumb images with microscope placeholder
  drawerEl.querySelectorAll('img.snavi-drawer-thumb, img.snavi-unlinked-thumb, img.snavi-modal-thumb').forEach(img => {
    img.addEventListener('error', () => {
      const cls = img.className;
      const div = document.createElement('div');
      div.className = cls + ' snavi-thumb-placeholder';
      div.innerHTML = THUMB_PLACEHOLDER_SVG;
      img.replaceWith(div);
    });
  });

  drawerEl.querySelectorAll('.snavi-drawer-item[data-slide-id]').forEach(item => {
    item.addEventListener('click', () => {
      requestViewerLink(item.dataset.slideId);
    });
  });

  drawerEl.querySelectorAll('.snavi-detach-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const slideId = btn.dataset.detachSlideId;
      if (!slideId || !currentCaseBase) return;
      btn.disabled = true;
      btn.textContent = '…';
      chrome.runtime.sendMessage({ type: 'DETACH_SLIDE', slideId, caseBase: currentCaseBase });
    });
  });

  drawerEl.querySelectorAll('.snavi-drawer-link-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const slideId = btn.dataset.linkSlideId;
      if (!slideId || !currentCaseBase) return;
      btn.disabled = true;
      btn.textContent = '...';
      chrome.runtime.sendMessage({ type: 'ATTACH_SLIDE', slideId, caseBase: currentCaseBase });
    });
  });

  const searchSection = drawerEl.querySelector('.snavi-drawer-search-section');
  const searchToggle = drawerEl.querySelector('.snavi-search-toggle');
  searchToggle?.addEventListener('click', () => {
    searchSection.classList.toggle('snavi-hidden');
    if (!searchSection.classList.contains('snavi-hidden')) {
      searchSection.querySelector('.snavi-drawer-input')?.focus();
    }
  });

  const goBtn = drawerEl.querySelector('.snavi-drawer-go');
  const inputEl = drawerEl.querySelector('.snavi-drawer-input');
  goBtn.addEventListener('click', () => {
    const val = inputEl.value.trim().toUpperCase();
    if (val && AP_PATTERN.test(val)) {
      onCaseChange(val.match(AP_PATTERN)[1]);
    }
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goBtn.click();
  });
}

function openDrawer() {
  if (!drawerEl) createDrawer();
  renderDrawerContent();
  drawerOpen = true;

  requestAnimationFrame(() => {
    drawerEl.classList.add('snavi-drawer--open');
    handleEl?.classList.add('snavi-handle--open');
  });

  setTimeout(() => {
    document.addEventListener('click', closeDrawerOnOutside);
  }, 50);
}

function closeDrawer() {
  if (!drawerEl) return;
  drawerOpen = false;
  drawerEl.classList.remove('snavi-drawer--open');
  handleEl?.classList.remove('snavi-handle--open');
  document.removeEventListener('click', closeDrawerOnOutside);
}

function toggleDrawer() {
  drawerOpen ? closeDrawer() : openDrawer();
}

function closeDrawerOnOutside(e) {
  if (drawerEl && !drawerEl.contains(e.target) && !handleEl?.contains(e.target)) {
    closeDrawer();
  }
}

// ============================================================================
// Toast
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
  if (toastEl) { toastEl.remove(); toastEl = null; }
}

// ============================================================================
// Modal
// ============================================================================

async function showLinkModal(candidate) {
  const cooldownKey = `dismissed:${currentCaseBase}`;
  const stored = await chromeStorageGet(cooldownKey);
  if (stored && Date.now() - stored < COOLDOWN_MS) return;

  removeModal();

  modalEl = document.createElement('div');
  modalEl.className = 'snavi-modal-overlay';
  modalEl.innerHTML = `
    <div class="snavi-modal">
      <div class="snavi-modal-body">
        <h3 class="snavi-modal-title">Lâmina encontrada</h3>
        <p class="snavi-modal-text">
          Encontramos uma lâmina recente compatível com este caso. Vincular agora?
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
  requestAnimationFrame(() => modalEl.classList.add('snavi-modal-overlay--visible'));
}

function removeModal() {
  if (modalEl) { modalEl.remove(); modalEl = null; }
}

// ============================================================================
// Communication with Background
// ============================================================================

function requestCaseStatus(caseBase) {
  chrome.runtime.sendMessage({ type: 'CASE_DETECTED', caseBase });
}

function requestViewerLink(slideId) {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => { debounceTimer = null; }, 2000);

  chrome.runtime.sendMessage({
    type: 'REQUEST_VIEWER_LINK',
    slideId,
    externalCaseId: currentCaseBase ? `pathoweb:${currentCaseBase}` : undefined,
    patientData: currentPatientData || undefined,
  });
}

function requestAuthInfo() {
  chrome.runtime.sendMessage({ type: 'GET_AUTH_INFO' });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'AUTH_INFO') {
    const wasAuthenticated = authInfo?.authenticated;
    authInfo = msg;
    // Clear config cache so new token is used
    configCache = null;
    if (drawerOpen) renderDrawerContent();

    // Just paired — fetch case status now that we have credentials
    if (!wasAuthenticated && msg.authenticated && currentCaseBase) {
      requestCaseStatus(currentCaseBase);
    }
  }
  if (msg.type === 'PAIRING_RESULT') {
    if (msg.success) {
      // Auth info update will re-render the drawer automatically
      showDebugToast(`Pareado: ${msg.deviceName}`);
    } else {
      // Show error in pairing form
      const feedbackEl = drawerEl?.querySelector('.snavi-pair-feedback');
      if (feedbackEl) {
        feedbackEl.textContent = msg.error || 'Erro ao parear';
        feedbackEl.classList.add('snavi-pair-feedback--error');
      }
      const btn = drawerEl?.querySelector('.snavi-pair-btn');
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('snavi-pair-btn--loading');
        btn.querySelector('.snavi-pair-btn-text').textContent = 'Conectar';
      }
    }
  }
  if (msg.type === 'CASE_STATUS') {
    currentStatus = msg;
    handleStatusUpdate(msg);
  }
  if (msg.type === 'CASE_STATUS_ERROR') {
    showDebugToast(`API error: ${msg.error}`);
    // Don't remove handle — keep it so user can open drawer to pair
  }
  if (msg.type === 'VIEWER_LINK') {
    window.open(msg.url, '_blank');
  }
  if (msg.type === 'DETACH_RESULT' && msg.success) {
    unlinkedSlides = null; // invalidate cache
    chrome.runtime.sendMessage({ type: 'REFRESH_STATUS', caseBase: currentCaseBase });
    chrome.runtime.sendMessage({ type: 'GET_UNLINKED_SLIDES' });
  }
  if (msg.type === 'UNLINKED_SLIDES') {
    unlinkedSlides = msg.slides || [];
    if (drawerOpen) renderDrawerContent();
  }
  if (msg.type === 'ATTACH_RESULT' && msg.success) {
    unlinkedSlides = null; // invalidate cache
    chrome.runtime.sendMessage({ type: 'REFRESH_STATUS', caseBase: currentCaseBase });
    chrome.runtime.sendMessage({ type: 'GET_UNLINKED_SLIDES' });
  }
});

// ============================================================================
// State Management
// ============================================================================

function handleStatusUpdate(status) {
  const hasReady = status.readySlides?.length > 0;
  const hasProcessing = status.processingSlides?.length > 0;
  const hasCandidates = status.unconfirmedCandidates?.length > 0;

  // Handle is always present — just update its state
  createHandle();
  if (hasReady || hasProcessing) {
    updateHandleState(status);
  }
  if (drawerOpen) renderDrawerContent();

  if (!hasReady && hasCandidates) {
    const best = status.unconfirmedCandidates[0];
    if (best.score >= 0.85) showLinkModal(best);
  }
}

function onCaseChange(newCaseBase) {
  if (newCaseBase === currentCaseBase) return;
  currentCaseBase = newCaseBase;
  currentStatus = null;
  removeModal();
  // Toggle handle active state (gray → navy when case detected)
  if (handleEl) {
    handleEl.classList.toggle('snavi-handle--active', !!currentCaseBase);
  }
  if (drawerOpen) renderDrawerContent();
  if (currentCaseBase && authInfo?.authenticated) {
    requestCaseStatus(currentCaseBase);
  }
}

// ============================================================================
// Navigation Observer
// ============================================================================

function startObserver() {
  const observer = new MutationObserver(() => {
    const detected = detectCaseBase();
    if (detected !== currentCaseBase) onCaseChange(detected);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  setInterval(() => {
    const detected = detectCaseBase();
    if (detected !== currentCaseBase) onCaseChange(detected);
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

function getThumbUrl(path) {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  const base = configCache?.apiBaseUrl || 'https://cloud.supernavi.app';
  return `${base}${path}`;
}

function formatSlideLabel(slide) {
  // If slide has a parsed label (e.g. "1" from AP26000230-1.svs), use it
  if (slide.label) return `Lâmina ${slide.label}`;
  // Otherwise show filename without extension
  if (slide.filename) {
    const dotIdx = slide.filename.lastIndexOf('.');
    return dotIdx > 0 ? slide.filename.substring(0, dotIdx) : slide.filename;
  }
  // Fallback to sequential number
  return `Lâmina ${slide.index || (index + 1)}`;
}

function formatDimensions(w, h) {
  if (!w || !h) return null;
  const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
  return `${fmt(w)} × ${fmt(h)} px`;
}

function formatRelativeDate(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min}min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  if (days === 1) return 'ontem';
  return `${days}d`;
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
  await getConfig();

  // Always show handle so user can open drawer (even if not authenticated)
  createHandle();
  requestAuthInfo();

  const detected = detectCaseBase();
  if (detected) {
    currentCaseBase = detected;
    // Activate handle (gray → navy)
    if (handleEl) handleEl.classList.add('snavi-handle--active');
    // Only fetch case status after auth info arrives (see AUTH_INFO handler)
    // If already configured, try now
    const cfg = await getConfig();
    if (cfg.deviceToken || cfg.apiKey) {
      requestCaseStatus(detected);
    }
  }

  // Scrape patient data (AJAX-loaded, so retry a few times)
  scrapePatientDataWithRetry();

  startObserver();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
