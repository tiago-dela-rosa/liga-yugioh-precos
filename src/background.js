/**
 * Service worker: concentra todas as chamadas de rede.
 * Content scripts em MV3 sofrem CORS; o service worker com host_permissions não.
 */
import {
  getSettings,
  CONDITION_ORDER,
  normalizeRarity,
  normalizeName,
  slugify
} from './shared.js';

const TCG_SEARCH = 'https://mp-search-api.tcgplayer.com/v1/search/request?isList=false&q=';
const TCG_LISTINGS = (id) => `https://mp-search-api.tcgplayer.com/v1/product/${id}/listings`;
const YGO_API = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

// ---------------------------------------------------------------- cache

async function cacheGet(key, ttlMs) {
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (!entry) return null;
  if (Date.now() - entry.at > ttlMs) return null;
  return entry.value;
}

async function cacheSet(key, value) {
  await chrome.storage.local.set({ [key]: { at: Date.now(), value } });
}

// ---------------------------------------------------------------- câmbio

async function fetchFxFromAwesome() {
  const res = await fetch('https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL');
  if (!res.ok) throw new Error(`AwesomeAPI ${res.status}`);
  const data = await res.json();
  const usd = Number(data?.USDBRL?.bid);
  const eur = Number(data?.EURBRL?.bid);
  if (!usd || !eur) throw new Error('AwesomeAPI sem cotação');
  return { usd, eur, source: 'AwesomeAPI (dólar comercial)' };
}

async function fetchFxFromErApi() {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  if (!res.ok) throw new Error(`er-api ${res.status}`);
  const data = await res.json();
  const usd = Number(data?.rates?.BRL);
  const eurPerUsd = Number(data?.rates?.EUR);
  if (!usd || !eurPerUsd) throw new Error('er-api sem cotação');
  return { usd, eur: usd / eurPerUsd, source: 'open.er-api.com' };
}

async function getFx(settings, force = false) {
  if (settings.fxSource === 'manual') {
    return {
      usd: Number(settings.manualUsd) || 0,
      eur: Number(settings.manualEur) || 0,
      source: 'Cotação manual',
      fetchedAt: Date.now()
    };
  }

  const key = `fx:${settings.fxSource}`;
  const ttl = Math.max(1, Number(settings.fxTtlMin)) * 60000;
  if (!force) {
    const cached = await cacheGet(key, ttl);
    if (cached) return cached;
  }

  const primary = settings.fxSource === 'erapi' ? fetchFxFromErApi : fetchFxFromAwesome;
  const backup = settings.fxSource === 'erapi' ? fetchFxFromAwesome : fetchFxFromErApi;

  let fx;
  try {
    fx = await primary();
  } catch (err) {
    fx = await backup();
    fx.source += ' (fallback)';
  }
  fx.fetchedAt = Date.now();
  await cacheSet(key, fx);
  return fx;
}

// ---------------------------------------------------------------- TCGplayer

async function tcgSearch(cardName) {
  const body = {
    algorithm: 'sales_synonym_v2',
    from: 0,
    size: 48,
    filters: {
      term: { productLineName: ['yugioh'] },
      range: {},
      match: {}
    },
    listingSearch: {
      context: { cart: {} },
      filters: {
        term: { sellerStatus: 'Live', channelId: 0 },
        range: { quantity: { gte: 1 } },
        exclude: { channelExclusion: 0 }
      }
    },
    context: { cart: {}, shippingCountry: 'US', userProfile: {} },
    settings: { useFuzzySearch: true, didYouMean: {} },
    sort: { field: 'product-sorting-name', order: 'asc' }
  };

  const res = await fetch(TCG_SEARCH + encodeURIComponent(cardName), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`busca retornou ${res.status}`);
  const data = await res.json();
  return data?.results?.[0]?.results || [];
}

/** Escolhe o produto que corresponde ao código da edição e à raridade da LigaYugioh. */
function pickProduct(products, { name, rarity, setCode }) {
  if (!products.length) return null;

  const wantedRarity = normalizeRarity(rarity);
  const wantedName = normalizeName(name);
  const wantedCode = String(setCode || '').toUpperCase();

  const score = (product) => {
    const attrs = product.customAttributes || {};
    let points = 0;
    if (wantedCode && String(attrs.number || '').toUpperCase() === wantedCode) points += 100;
    if (normalizeName(product.productName || product.productUrlName) === wantedName) points += 25;
    else if (normalizeName(product.productUrlName || '').startsWith(wantedName)) points += 12;
    if (wantedRarity && normalizeRarity(product.rarityName) === wantedRarity) points += 50;
    // Sem raridade informada, prefere a impressão mais barata da carta.
    if (!wantedRarity) points += 1 / (1 + (Number(product.marketPrice) || 0));
    return points;
  };

  const ranked = products
    .map((product) => ({ product, points: score(product) }))
    .sort((a, b) => b.points - a.points);

  const best = ranked[0];
  // Exige evidência real de correspondência (código da edição ou nome idêntico).
  if (!best || best.points < 25) return null;

  // Um mesmo código pode existir em reimpressões (ex.: "25th Anniversary Edition").
  // Empatados, fica a impressão mais barata — é o menor preço que o usuário procura.
  const tied = ranked.filter((item) => item.points === best.points);
  const cheapest = tied.reduce((acc, item) => {
    const price = Number(item.product.marketPrice);
    const accPrice = Number(acc.product.marketPrice);
    const a = Number.isFinite(price) && price > 0 ? price : Infinity;
    const b = Number.isFinite(accPrice) && accPrice > 0 ? accPrice : Infinity;
    return a < b ? item : acc;
  }, tied[0]);

  return { ...cheapest.product, matchScore: best.points, alternatives: tied.length - 1 };
}

/**
 * Resolve o produto no TCGplayer. Buscar pelo código da edição (ex.: LOB-EN005) é
 * muito mais preciso que buscar pelo nome, que pode ter centenas de reimpressões.
 */
async function resolveProduct(card) {
  const queries = [];
  if (card.setCode) queries.push(card.setCode);
  queries.push(card.name);
  if (card.setCode) queries.push(`${card.name} ${card.setCode}`);

  let fallback = null;
  for (const query of queries) {
    const products = await tcgSearch(query);
    const picked = pickProduct(products, card);
    if (picked && picked.matchScore >= 100) return picked;
    if (picked && (!fallback || picked.matchScore > fallback.matchScore)) fallback = picked;
  }
  return fallback;
}

function conditionAllowed(condition, minCondition) {
  const limit = CONDITION_ORDER.indexOf(minCondition);
  const index = CONDITION_ORDER.indexOf(condition);
  if (limit < 0) return true;
  if (index < 0) return false;
  return index <= limit;
}

async function tcgLowestListing(productId, settings) {
  const body = {
    filters: {
      term: { sellerStatus: 'Live', channelId: 0 },
      range: { quantity: { gte: 1 } },
      exclude: { channelExclusion: 0, listingType: 'custom' }
    },
    from: 0,
    size: 50,
    sort: { field: 'price+shipping', order: 'asc' },
    context: { shippingCountry: 'US', cart: {} },
    aggregations: ['listingType']
  };

  const res = await fetch(TCG_LISTINGS(productId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`anúncios retornaram ${res.status}`);
  const data = await res.json();
  const block = data?.results?.[0] || {};
  const listings = block.results || [];

  const pool = listings.filter((listing) => {
    if (settings.language !== 'any' && listing.language !== settings.language) return false;
    if (settings.printing !== 'any' && listing.printing !== settings.printing) return false;
    return conditionAllowed(listing.condition, settings.minCondition);
  });

  if (!pool.length) {
    return { lowest: null, totalResults: block.totalResults || 0, filteredOut: listings.length > 0 };
  }

  const key = (listing) =>
    Number(listing.price) + (settings.includeShipping ? Number(listing.shippingPrice || 0) : 0);

  const lowest = pool.reduce((best, listing) => (key(listing) < key(best) ? listing : best), pool[0]);

  return {
    lowest: {
      price: Number(lowest.price),
      shipping: Number(lowest.shippingPrice || 0),
      condition: lowest.condition,
      printing: lowest.printing,
      language: lowest.language,
      seller: lowest.sellerName,
      quantity: Number(lowest.quantity || 0)
    },
    totalResults: block.totalResults || 0,
    filteredOut: false
  };
}

function tcgProductUrl(product) {
  const attrs = product.customAttributes || {};
  const setSlug = slugify(product.setUrlName || attrs.setName || '');
  const nameSlug = slugify(product.productUrlName || product.productName || '');
  const path = ['yugioh', setSlug, nameSlug].filter(Boolean).join('-');
  return `https://www.tcgplayer.com/product/${product.productId}/${path}?Language=English`;
}

// ---------------------------------------------------------------- YGOPRODeck (Cardmarket)

async function ygoCard(cardName) {
  let res = await fetch(`${YGO_API}?name=${encodeURIComponent(cardName)}`);
  if (res.status === 400) {
    res = await fetch(`${YGO_API}?fname=${encodeURIComponent(cardName)}`);
  }
  if (!res.ok) throw new Error(`retornou ${res.status}`);
  const data = await res.json();
  const list = data?.data || [];
  if (!list.length) return null;

  const wanted = normalizeName(cardName);
  return list.find((card) => normalizeName(card.name) === wanted) || list[0];
}

// ---------------------------------------------------------------- montagem

function withFee(value, feePct) {
  return value * (1 + (Number(feePct) || 0) / 100);
}

async function buildPrices(card, settings, force) {
  const cacheKey = [
    'price',
    normalizeName(card.name),
    normalizeRarity(card.rarity),
    String(card.setCode || ''),
    settings.minCondition,
    settings.language,
    settings.printing,
    settings.includeShipping ? 'ship' : 'noship'
  ].join('|');

  const ttl = Math.max(1, Number(settings.priceTtlMin)) * 60000;
  let raw = force ? null : await cacheGet(cacheKey, ttl);
  const fromCache = Boolean(raw);

  if (!raw) {
    raw = { card, tcg: null, cardmarket: null, errors: [] };

    const [tcgResult, ygoResult] = await Promise.allSettled([
      (async () => {
        const product = await resolveProduct(card);
        if (!product) return null;

        // Se os anúncios falharem, ainda vale mostrar o market price do produto.
        let listings = { lowest: null, totalResults: 0, filteredOut: false };
        try {
          listings = await tcgLowestListing(product.productId, settings);
        } catch (err) {
          listings.error = err?.message || String(err);
        }

        return {
          productId: product.productId,
          url: tcgProductUrl(product),
          rarityName: product.rarityName,
          setName: product.customAttributes?.setName || product.setName || '',
          number: product.customAttributes?.number || '',
          setUrlName: product.setUrlName || '',
          marketPrice: Number(product.marketPrice) || null,
          exactMatch: product.matchScore >= 100,
          alternatives: product.alternatives || 0,
          ...listings
        };
      })(),
      ygoCard(card.name)
    ]);

    if (tcgResult.status === 'fulfilled') {
      raw.tcg = tcgResult.value;
      if (raw.tcg?.error) raw.errors.push(`TCGplayer: ${raw.tcg.error}`);
    } else {
      raw.errors.push(`TCGplayer: ${tcgResult.reason?.message || 'falhou'}`);
    }

    if (ygoResult.status === 'fulfilled' && ygoResult.value) {
      const prices = ygoResult.value.card_prices?.[0] || {};
      const eur = Number(prices.cardmarket_price) || 0;
      raw.cardmarket = {
        eur: eur > 0 ? eur : null,
        url: `https://www.cardmarket.com/en/YuGiOh/Products/Search?searchString=${encodeURIComponent(ygoResult.value.name)}`,
        cardName: ygoResult.value.name,
        image: ygoResult.value.card_images?.[0]?.image_url_small || null
      };
    } else if (ygoResult.status === 'rejected') {
      raw.errors.push(`Cardmarket/YGOPRODeck: ${ygoResult.reason?.message || 'falhou'}`);
    }

    raw.fetchedAt = Date.now();
    await cacheSet(cacheKey, raw);
  }

  // O câmbio é aplicado fora do cache: a cotação muda mais rápido que o preço.
  const fx = await getFx(settings, force);
  const feePct = Number(settings.extraFeePct) || 0;
  const usdToBrl = (usd) => withFee(usd * fx.usd, feePct);
  const eurToBrl = (eur) => withFee(eur * fx.eur, feePct);

  const out = {
    ok: true,
    card: raw.card,
    fetchedAt: raw.fetchedAt,
    fromCache,
    errors: raw.errors || [],
    fx: { ...fx, feePct },
    tcg: null,
    cardmarket: null
  };

  if (raw.tcg) {
    const lowest = raw.tcg.lowest;
    const extra = settings.includeShipping ? lowest?.shipping || 0 : 0;
    out.tcg = {
      productId: raw.tcg.productId,
      url: raw.tcg.url,
      rarityName: raw.tcg.rarityName,
      setName: raw.tcg.setName || raw.tcg.setUrlName,
      number: raw.tcg.number,
      exactMatch: raw.tcg.exactMatch,
      alternatives: raw.tcg.alternatives,
      totalResults: raw.tcg.totalResults,
      filteredOut: raw.tcg.filteredOut,
      listingsFailed: Boolean(raw.tcg.error),
      market: raw.tcg.marketPrice
        ? { usd: raw.tcg.marketPrice, brl: usdToBrl(raw.tcg.marketPrice) }
        : null,
      lowest: lowest
        ? {
            ...lowest,
            brl: usdToBrl(lowest.price),
            totalUsd: lowest.price + extra,
            totalBrl: usdToBrl(lowest.price + extra)
          }
        : null
    };
  }

  if (raw.cardmarket) {
    out.cardmarket = {
      ...raw.cardmarket,
      brl: raw.cardmarket.eur ? eurToBrl(raw.cardmarket.eur) : null
    };
  }

  return out;
}

// ---------------------------------------------------------------- mensagens

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      const settings = await getSettings();

      if (message.type === 'getSettings') {
        sendResponse({ ok: true, settings });
        return;
      }

      if (message.type === 'getPrices') {
        const result = await buildPrices(message.card, settings, Boolean(message.force));
        sendResponse({ ...result, settings });
        return;
      }

      if (message.type === 'openOptions') {
        await chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'clearCache') {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter((k) => k.startsWith('price|') || k.startsWith('fx:'));
        await chrome.storage.local.remove(keys);
        sendResponse({ ok: true, removed: keys.length });
        return;
      }

      sendResponse({ ok: false, error: `Mensagem desconhecida: ${message.type}` });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // resposta assíncrona
});
