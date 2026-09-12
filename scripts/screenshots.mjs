/**
 * Gera os prints usados no README em docs/images/.
 *
 *   node scripts/screenshots.mjs
 *
 * Usa um Chromium controlado pelo protocolo DevTools (sem dependências npm):
 * um perfil limpo para os passos de instalação e outro com a extensão carregada
 * para o painel, as opções e o popup. Defina CHROME_PATH para apontar outro binário
 * (precisa aceitar --load-extension, ou seja, Chromium / Chrome for Testing).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'images');
const CARD_URL =
  'https://www.ligayugioh.com.br/?view=cards/card&card=W%3AP%20Fancy%20Ball%20(Secret%20Rare)&ed=0&num=';
const RELEASES_URL = 'https://github.com/tiago-dela-rosa/liga-yugioh-precos/releases/latest';
const VIEWPORT = { width: 1400, height: 900 };

// ---------------------------------------------------------------- Chromium

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!existsSync(cache)) throw new Error('Defina CHROME_PATH (Chromium / Chrome for Testing).');
  const builds = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    for (const sub of ['chrome-win64', 'chrome-win', 'chrome-linux', 'chrome-mac']) {
      const exe = path.join(cache, build, sub, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error('Chromium do Playwright não encontrado; defina CHROME_PATH.');
}

async function launch({ port, extension }) {
  const profile = mkdtempSync(path.join(tmpdir(), 'lyp-shots-'));
  // chrome://extensions segue o tema do navegador (que por padrão copia o do Windows).
  // Pré-configura o perfil em "claro" (1 = claro, 2 = escuro, 0 = sistema).
  mkdirSync(path.join(profile, 'Default'), { recursive: true });
  writeFileSync(
    path.join(profile, 'Default', 'Preferences'),
    JSON.stringify({ browser: { theme: { color_scheme: 1 } } })
  );
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=pt-BR',
    '--force-device-scale-factor=1',
    // O headless se identifica como "HeadlessChrome" e o TCGplayer recusa; usa o UA de um Chrome comum.
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    'about:blank'
  ];
  if (extension) args.splice(3, 0, `--load-extension=${extension}`, '--disable-extensions-except=' + extension);

  const proc = spawn(findChromium(), args, { stdio: 'ignore' });

  let version;
  for (let i = 0; i < 100 && !version; i++) {
    try {
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!version) throw new Error('Chromium não respondeu na porta ' + port);

  const cdp = await CDP.connect(version.webSocketDebuggerUrl);
  return {
    cdp,
    close: async () => {
      cdp.close();
      proc.kill();
      await new Promise((r) => setTimeout(r, 500));
      rmSync(profile, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------- CDP mínimo

class CDP {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new CDP(ws);
      ws.onopen = () => resolve(client);
      ws.onerror = (e) => reject(new Error('WebSocket: ' + (e.message || 'falhou')));
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.data || ''})`)) : resolve(msg.result);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    this.ws.close();
  }
}

class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
  }

  static async open(cdp, url = 'about:blank') {
    const { targetId } = await cdp.send('Target.createTarget', { url });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    // O headless costuma reportar tema escuro; o README fica melhor em claro.
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }]
    });
    await page.setViewport(VIEWPORT.width, VIEWPORT.height);
    return page;
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  setViewport(width, height) {
    return this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 30000);
    await sleep(600);
  }

  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'erro no eval');
    return result.value;
  }

  async waitFor(expression, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (await this.eval(expression)) return true;
      } catch {
        // página ainda navegando
      }
      await sleep(250);
    }
    throw new Error(`Tempo esgotado esperando: ${expression}`);
  }

  /** Contorno vermelho em volta de um elemento (função JS que retorna o elemento, pode atravessar shadow DOM). */
  async highlight(getElementJs, label = '', position = 'below') {
    await this.eval(`(() => {
      document.querySelectorAll('[data-lyp-highlight]').forEach((old) => old.remove());
      const el = (${getElementJs})();
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.dataset.lypHighlight = '1';
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #e5322d;border-radius:8px;box-shadow:0 0 0 4px rgba(229,50,45,.18)';
      box.style.left = (r.left - 8) + 'px';
      box.style.top = (r.top - 8) + 'px';
      box.style.width = (r.width + 16) + 'px';
      box.style.height = (r.height + 16) + 'px';
      const label = ${JSON.stringify(label)};
      if (label) {
        const tag = document.createElement('div');
        tag.textContent = label;
        const place = {
          below: 'left:-3px;top:100%;margin-top:6px',
          above: 'left:-3px;bottom:100%;margin-bottom:6px',
          right: 'left:100%;top:50%;transform:translateY(-50%);margin-left:10px',
          left: 'right:100%;top:50%;transform:translateY(-50%);margin-right:10px',
          'below-end': 'right:-3px;top:100%;margin-top:6px'
        }[${JSON.stringify(position)}];
        tag.style.cssText = 'position:absolute;' + place + ';background:#e5322d;color:#fff;font:600 13px/1 system-ui,Arial;padding:6px 9px;border-radius:5px;white-space:nowrap';
        box.appendChild(tag);
      }
      document.documentElement.appendChild(box);
      return true;
    })()`);
  }

  /** Retângulo de um elemento em coordenadas do documento (o clip do CDP usa essas, não as da viewport). */
  async rectOf(getElementJs, margin = 0) {
    return this.eval(`(() => {
      const r = (${getElementJs})().getBoundingClientRect();
      return {
        x: Math.max(0, r.left + window.scrollX - ${margin}),
        y: Math.max(0, r.top + window.scrollY - ${margin}),
        width: Math.ceil(r.width + ${margin} * 2),
        height: Math.ceil(r.height + ${margin} * 2)
      };
    })()`);
  }

  async screenshot(file, { clip, fullPage } = {}) {
    const params = { format: 'png', captureBeyondViewport: Boolean(fullPage || clip) };
    if (fullPage) {
      const height = await this.eval('document.documentElement.scrollHeight');
      params.clip = { x: 0, y: 0, width: VIEWPORT.width, height, scale: 1 };
    } else if (clip) {
      params.clip = { ...clip, scale: 1 };
    }
    const { data } = await this.send('Page.captureScreenshot', params);
    writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
    console.log('  ✓', file);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// chrome://extensions é todo em shadow DOM; estes caminhos chegam nos controles.
const EXT_TOOLBAR = `document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-toolbar').shadowRoot`;
const EXT_DEVMODE = `() => ${EXT_TOOLBAR}.querySelector('#devMode')`;
const EXT_LOAD = `() => ${EXT_TOOLBAR}.querySelector('#loadUnpacked')`;
const EXT_CARD = `() => document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-item-list').shadowRoot.querySelector('extensions-item')`;

// ---------------------------------------------------------------- roteiro

async function installSteps() {
  console.log('Passos de instalação (perfil limpo)…');
  const browser = await launch({ port: 9333, extension: null });
  try {
    const page = await Page.open(browser.cdp);

    await page.goto(RELEASES_URL);
    const asset = `() => document.querySelector('[href*="/releases/download/"]')`;
    await page.highlight(asset, 'Baixe este arquivo', 'right');
    const assetRect = await page.rectOf(asset);
    await page.screenshot('instalacao-1-download.png', {
      clip: { x: 0, y: 192, width: VIEWPORT.width, height: assetRect.y + assetRect.height - 192 + 110 }
    });

    await page.goto('chrome://extensions');
    await page.waitFor(`!!(${EXT_DEVMODE})()`);
    await page.highlight(EXT_DEVMODE, 'Ligue o Modo do desenvolvedor', 'below-end');
    await page.screenshot('instalacao-2-modo-dev.png', {
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: 240 }
    });

    await page.eval(`(${EXT_DEVMODE})().click()`);
    await sleep(500);
    await page.highlight(EXT_LOAD, 'Clique aqui e escolha a pasta liga-yugioh-precos', 'below');
    await page.screenshot('instalacao-3-carregar.png', {
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: 240 }
    });
  } finally {
    await browser.close();
  }
}

async function extensionShots() {
  console.log('Com a extensão carregada…');
  const browser = await launch({ port: 9334, extension: ROOT });
  try {
    const page = await Page.open(browser.cdp);

    // 4. extensão instalada na lista (com o modo do desenvolvedor ligado, como fica após o passo 3)
    await page.goto('chrome://extensions');
    await page.waitFor(`!!(${EXT_CARD})()`);
    if (!(await page.eval(`(${EXT_DEVMODE})().checked`))) {
      await page.eval(`(${EXT_DEVMODE})().click()`);
      await sleep(500);
    }
    await page.highlight(EXT_CARD, 'Pronto: a extensão está instalada', 'right');
    const cardRect = await page.rectOf(EXT_CARD, 24);
    await page.screenshot('instalacao-4-instalada.png', {
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: cardRect.y + cardRect.height }
    });

    const extensionId = await page.eval(`(${EXT_CARD})().id`);
    console.log('  id da extensão:', extensionId);

    // painel em uso na LigaYugioh (também aquece o cache da cotação para o popup)
    await page.goto(CARD_URL);
    await page.waitFor(`!!document.querySelector('#lyp-panel .lyp-price')`, 40000);
    await sleep(800);
    await page.eval(`document.querySelector('#lyp-panel').scrollIntoView({ block: 'center' })`);
    await sleep(300);
    await page.screenshot('uso.png', {
      clip: await page.rectOf(`() => document.querySelector('#lyp-panel')`, 16)
    });

    // configurações
    await page.setViewport(760, 900);
    await page.goto(`chrome-extension://${extensionId}/src/options.html`);
    await sleep(500);
    const optionsHeight = await page.eval('document.documentElement.scrollHeight');
    await page.screenshot('configuracoes.png', { clip: { x: 0, y: 0, width: 760, height: optionsHeight } });

    // popup
    await page.setViewport(320, 380);
    await page.goto(`chrome-extension://${extensionId}/src/popup.html`);
    await sleep(700);
    const popupHeight = await page.eval('Math.ceil(document.body.getBoundingClientRect().bottom)');
    await page.screenshot('popup.png', { clip: { x: 0, y: 0, width: 320, height: popupHeight } });
  } finally {
    await browser.close();
  }
}

mkdirSync(OUT, { recursive: true });
await installSteps();
await extensionShots();
console.log('Prints salvos em', path.relative(ROOT, OUT));
