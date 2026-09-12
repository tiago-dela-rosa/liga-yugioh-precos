/* Content script: lê a carta aberta na LigaYugioh e injeta o painel de preços internacionais. */
(() => {
  const PANEL_ID = 'lyp-panel';
  const RARITY_HINT = /(rare|common|edition|parallel|gold|foil|holo)/i;

  let lastKey = null;
  let settings = null;

  // ------------------------------------------------------------ leitura da página

  function parseNameAndRarity(rawText) {
    const text = String(rawText || '').trim();
    const match = text.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    if (match && RARITY_HINT.test(match[2])) {
      return { name: match[1].trim(), rarity: match[2].trim() };
    }
    return { name: text, rarity: '' };
  }

  function readCardFromUrl() {
    const param = new URLSearchParams(location.search).get('card');
    return param ? parseNameAndRarity(param) : null;
  }

  function readSetCode() {
    const el = document.querySelector('.sigla-ed');
    const text = el?.textContent || '';
    const match = text.match(/([A-Z0-9]{2,6}-[A-Z]{1,3}\d{2,4})/);
    return match ? match[1] : '';
  }

  /** A raridade também aparece em "Detalhes da Carta", útil quando o nome não a traz. */
  function readRarityFromDetails() {
    const label = [...document.querySelectorAll('.container-details .title')].find(
      (el) => el.textContent.trim() === 'Raridade'
    );
    const value = label?.parentElement?.querySelector('span:not(.title)');
    const text = value?.textContent.replace(/\([^)]*\)/g, '').trim();
    return text && RARITY_HINT.test(text) ? text : '';
  }

  /** Retorna os dados da carta se estivermos numa página de carta; caso contrário, null. */
  function readCard() {
    const nameEl = document.querySelector('.container-title .item-name-en');
    const fromDom = nameEl ? parseNameAndRarity(nameEl.textContent) : null;
    const fromUrl = readCardFromUrl();
    const base = fromDom || fromUrl;
    if (!base || !base.name) return null;

    return {
      name: base.name,
      rarity: base.rarity || fromUrl?.rarity || readRarityFromDetails(),
      setCode: readSetCode(),
      ptName: document.querySelector('.container-title .item-name')?.textContent.trim() || ''
    };
  }

  /**
   * O painel fica logo abaixo de "Preço Médio de Venda no Marketplace": os dois blocos
   * falam de preço e ficam comparáveis lado a lado.
   */
  function anchorPoint() {
    const priceBlock = document.querySelector('.container-show-price-mkp');
    if (priceBlock) return { parent: priceBlock.parentElement, before: priceBlock.nextSibling };

    const details = document.querySelector('.container-details-item');
    if (details) return { parent: details.parentElement, before: details.nextSibling };

    const title = document.querySelector('.container-infos .container-title');
    if (title) return { parent: title.parentElement, before: title.nextSibling };

    const infos = document.querySelector('.container-infos');
    if (infos) return { parent: infos, before: null };

    return null;
  }

  // ------------------------------------------------------------ formatação

  const brl = (value) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);

  const foreign = (value, currency) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);

  const time = (ts) =>
    new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  const CONDITION_PT = {
    'Near Mint': 'NM',
    'Lightly Played': 'LP',
    'Moderately Played': 'MP',
    'Heavily Played': 'HP',
    Damaged: 'DMG'
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
    );
  }

  // ------------------------------------------------------------ montagem do painel

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'lyp-panel';
    panel.innerHTML = `
      <div class="lyp-title">
        <div>Preços Internacionais <label class="lyp-title-extra">em Reais</label></div>
        <div class="lyp-actions">
          <span class="cursor-pointer lyp-action" data-action="refresh">Atualizar</span>
          <span class="cursor-pointer lyp-action" data-action="options">Configurar</span>
        </div>
      </div>
      <div class="lyp-body"></div>
      <div class="lyp-foot"></div>
    `;
    panel.querySelector('[data-action="refresh"]').addEventListener('click', () => load(true));
    panel.querySelector('[data-action="options"]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'openOptions' }).catch(() => {});
    });
    return panel;
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    const anchor = anchorPoint();
    if (!anchor) return null;

    if (!panel) panel = buildPanel();

    // anchor.before pode ser o próprio painel quando ele já está no lugar certo.
    const placed =
      panel.parentElement === anchor.parent &&
      (anchor.before === panel || panel.nextSibling === anchor.before);
    if (!placed) anchor.parent.insertBefore(panel, anchor.before);

    return panel;
  }

  function setBody(html) {
    const body = document.querySelector(`#${PANEL_ID} .lyp-body`);
    if (body) body.innerHTML = html;
  }

  function setFoot(text) {
    const foot = document.querySelector(`#${PANEL_ID} .lyp-foot`);
    if (foot) foot.textContent = text;
  }

  /** Uma linha no mesmo formato das linhas de "Preço Médio de Venda no Marketplace". */
  function priceRow({ store, url, tag, note, main, sub, variant = 'min' }) {
    const label = url
      ? `<a class="lyp-store" href="${url}" target="_blank" rel="noopener">${store}</a>`
      : `<span class="lyp-store lyp-store-off">${store}</span>`;

    return `
      <div class="lyp-line">
        <div class="lyp-line-left">
          ${label}
          ${tag ? `<span class="lyp-tag">${tag}</span>` : ''}
          ${note ? `<span class="lyp-note">${note}</span>` : ''}
        </div>
        <div class="lyp-line-right lyp-${variant}">
          <div class="lyp-price">${main}</div>
          ${sub ? `<div class="lyp-sub">${sub}</div>` : ''}
        </div>
      </div>
    `;
  }

  function render(data) {
    const rows = [];
    const cfg = data.settings || {};

    if (data.tcg) {
      const t = data.tcg;

      if (cfg.showTcgLowest !== false) {
        if (t.lowest) {
          const l = t.lowest;
          const cond = CONDITION_PT[l.condition] || l.condition;
          const parts = [cond, l.printing, l.language].filter(Boolean).map(escapeHtml).join(' · ');
          const shippingNote = cfg.includeShipping
            ? ` + frete US$ ${l.shipping.toFixed(2)}`
            : '';
          rows.push(
            priceRow({
              store: 'TCGplayer',
              url: t.url,
              tag: 'menor anúncio',
              note: `${parts}${shippingNote}`,
              main: brl(l.totalBrl),
              sub: `${foreign(l.totalUsd, 'USD')} · ${t.totalResults} anúncios`,
              variant: 'min'
            })
          );
        } else {
          rows.push(
            priceRow({
              store: 'TCGplayer',
              url: t.url,
              tag: 'menor anúncio',
              main: '—',
              sub: t.filteredOut ? 'nada no filtro atual' : 'sem anúncios ativos',
              variant: 'min'
            })
          );
        }
      }

      if (cfg.showTcgMarket !== false && t.market) {
        rows.push(
          priceRow({
            store: 'TCGplayer',
            url: t.url,
            tag: 'market price',
            note: 'média das vendas recentes',
            main: brl(t.market.brl),
            sub: foreign(t.market.usd, 'USD'),
            variant: 'medium'
          })
        );
      }
    } else if (!data.errors.some((e) => e.startsWith('TCGplayer'))) {
      rows.push(
        priceRow({
          store: 'TCGplayer',
          main: '—',
          sub: 'produto não encontrado para esta raridade',
          variant: 'min'
        })
      );
    }

    if (cfg.showCardmarket !== false && data.cardmarket) {
      const c = data.cardmarket;
      rows.push(
        priceRow({
          store: 'Cardmarket',
          url: c.url,
          tag: 'menor preço',
          note: 'qualquer edição da carta',
          main: c.brl ? brl(c.brl) : '—',
          sub: c.eur ? foreign(c.eur, 'EUR') : 'sem cotação',
          variant: 'min'
        })
      );
    }

    const notes = [];
    if (data.tcg && !data.tcg.exactMatch) {
      notes.push(
        `Sem correspondência pelo código da edição: usando ${escapeHtml(
          data.tcg.rarityName || '?'
        )} de ${escapeHtml(data.tcg.setName || '?')} (impressão mais barata da carta).`
      );
    } else if (data.tcg?.alternatives) {
      notes.push(
        `${data.tcg.alternatives + 1} impressões com o código ${escapeHtml(
          data.tcg.number || ''
        )}; mostrando a mais barata (${escapeHtml(data.tcg.setName || '?')}).`
      );
    }

    const warn = notes.length ? `<div class="lyp-warn">${notes.join(' ')}</div>` : '';
    const errors = (data.errors || []).length
      ? `<div class="lyp-error">${data.errors.map(escapeHtml).join(' · ')}</div>`
      : '';

    setBody(rows.join('') + warn + errors);

    const fx = data.fx;
    const fee = fx.feePct ? ` · +${fx.feePct}% de taxa` : '';
    const eur = fx.eur ? ` · EUR ${fx.eur.toFixed(4)}` : '';
    setFoot(
      `USD ${fx.usd.toFixed(4)}${eur} — ${fx.source}${fee} · consultado ${time(data.fetchedAt)}${
        data.fromCache ? ' (cache)' : ''
      }`
    );
  }

  // ------------------------------------------------------------ ciclo de vida

  async function load(force = false) {
    const card = readCard();
    if (!card) return;

    const panel = ensurePanel();
    if (!panel) return;

    setBody('<div class="lyp-loading">Buscando preços…</div>');
    setFoot('');

    try {
      const data = await chrome.runtime.sendMessage({ type: 'getPrices', card, force });
      if (!data || !data.ok) {
        setBody(
          `<div class="lyp-error">Não foi possível obter os preços: ${escapeHtml(
            data?.error || 'erro desconhecido'
          )}</div>`
        );
        return;
      }
      render(data);
    } catch (err) {
      setBody(
        `<div class="lyp-error">Falha na comunicação com a extensão: ${escapeHtml(
          err?.message || err
        )}</div>`
      );
    }
  }

  function showIdlePanel() {
    const panel = ensurePanel();
    if (!panel) return;
    setBody('<div class="lyp-line lyp-cta-line"><button type="button" class="lyp-cta">Ver preços no TCGplayer e Cardmarket</button></div>');
    setFoot('');
    panel.querySelector('.lyp-cta')?.addEventListener('click', () => load(false));
  }

  async function sync() {
    const card = readCard();
    if (!card) {
      document.getElementById(PANEL_ID)?.remove();
      lastKey = null;
      return;
    }

    const key = `${card.name}|${card.rarity}|${card.setCode}`;
    if (key === lastKey && document.getElementById(PANEL_ID)?.isConnected) {
      ensurePanel(); // a Liga pode ter recriado o bloco de preços em volta do painel
      return;
    }
    lastKey = key;

    if (!settings) {
      const res = await chrome.runtime.sendMessage({ type: 'getSettings' }).catch(() => null);
      settings = res?.settings || {};
    }

    if (settings.autoOpen === false) showIdlePanel();
    else load(false);
  }

  // Configurações alteradas no popup/opções valem já na próxima renderização.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.settings) return;
    settings = changes.settings.newValue || {};
    lastKey = null;
    sync();
  });

  // A LigaYugioh troca o conteúdo sem recarregar a página em parte da navegação.
  const observer = new MutationObserver(() => {
    clearTimeout(observer._timer);
    observer._timer = setTimeout(sync, 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastKey = null;
      sync();
    }
  }, 700);

  sync();
})();
