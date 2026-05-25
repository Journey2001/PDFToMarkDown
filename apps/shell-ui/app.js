const APP_ROUTES = {
  download: '/download',
  clean: '/clean',
  translate: '/translate',
  export: '/export'
};

const APP_LABELS = {
  download: '下载',
  clean: '清洗',
  translate: '翻译',
  export: '导出 PDF'
};

function setActiveTab(buttons, activeApp) {
  for (const button of buttons) {
    const isActive = button.dataset.app === activeApp;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-current', isActive ? 'page' : 'false');
  }
}

function createRoute(appId) {
  return APP_ROUTES[appId] || APP_ROUTES.download;
}

export function initializeShellApp(doc = globalThis.document) {
  if (!doc?.querySelector) {
    return null;
  }

  const frame = doc.querySelector('#app-frame');
  if (!frame) {
    return null;
  }

  const frameTitle = doc.querySelector('#frame-title');
  const frameRoute = doc.querySelector('#frame-route');
  const buttons = Array.from(doc.querySelectorAll('[data-app]'));
  let frameResizeObserver = null;

  function resizeFrameToContent() {
    try {
      const frameDocument = frame.contentDocument;
      if (!frameDocument) {
        return;
      }

      const height = Math.max(
        frameDocument.body?.scrollHeight || 0,
        frameDocument.documentElement?.scrollHeight || 0,
        760
      );
      frame.style.height = `${height}px`;
    } catch {
      // If a browser blocks iframe access, keep the safe min-height fallback.
    }
  }

  function observeFrameContent() {
    if (frameResizeObserver) {
      frameResizeObserver.disconnect();
      frameResizeObserver = null;
    }

    resizeFrameToContent();

    try {
      const frameDocument = frame.contentDocument;
      if (!frameDocument || typeof ResizeObserver === 'undefined') {
        return;
      }

      frameResizeObserver = new ResizeObserver(resizeFrameToContent);
      frameResizeObserver.observe(frameDocument.documentElement);
      if (frameDocument.body) {
        frameResizeObserver.observe(frameDocument.body);
      }
    } catch {
      // The shell and sub-apps are same-origin; this is only a defensive fallback.
    }
  }

  function activate(appId) {
    const route = createRoute(appId);
    frame.style.height = '760px';
    frame.src = route;
    if (frameTitle) {
      frameTitle.textContent = APP_LABELS[appId] || APP_LABELS.download;
    }
    if (frameRoute) {
      frameRoute.textContent = route;
    }
    setActiveTab(buttons, appId);
  }

  for (const button of buttons) {
    button.addEventListener('click', () => {
      activate(button.dataset.app);
    });
  }

  if (typeof frame.addEventListener === 'function') {
    frame.addEventListener('load', observeFrameContent);
  }

  frame.src = '/download';
  if (frameTitle) {
    frameTitle.textContent = APP_LABELS.download;
  }
  if (frameRoute) {
    frameRoute.textContent = '/download';
  }
  setActiveTab(buttons, 'download');
  return { activate, resizeFrameToContent };
}

if (typeof document !== 'undefined') {
  initializeShellApp(document);
}
