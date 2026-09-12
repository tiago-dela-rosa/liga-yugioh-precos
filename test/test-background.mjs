// Harness: roda o service worker fora do Chrome, com chrome.* stubado.

const sync = {};
const local = {};
const mkArea = (store) => ({
  async get(key) {
    if (key === null || key === undefined) return { ...store };
    if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, store[k]]));
    return key in store ? { [key]: store[key] } : {};
  },
  async set(obj) { Object.assign(store, obj); },
  async remove(keys) { for (const k of [].concat(keys)) delete store[k]; }
});

let listener = null;
globalThis.chrome = {
  storage: { sync: mkArea(sync), local: mkArea(local) },
  runtime: {
    onMessage: { addListener: (fn) => { listener = fn; } },
    openOptionsPage: async () => {}
  }
};

// Node manda User-Agent proprio; o Chrome manda o do navegador. Simula isso.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => {
  const headers = new Headers(opts.headers || {});
  headers.set(
    'User-Agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  );
  return realFetch(url, { ...opts, headers });
};

await import(new URL('../src/background.js', import.meta.url).href);

const send = (message) =>
  new Promise((resolve) => {
    listener(message, {}, resolve);
  });

const cards = [
  { name: 'W:P Fancy Ball', rarity: 'Secret Rare', setCode: 'MAMO-EN028' },
  { name: 'W:P Fancy Ball', rarity: 'Starlight Rare', setCode: 'MAMO-EN028' },
  { name: 'Dark Magician', rarity: 'Ultra Rare', setCode: 'LOB-EN005' },
  { name: 'Ash Blossom & Joyous Spring', rarity: 'Ultra Rare', setCode: '' },
  { name: 'Carta Que Nao Existe 9999', rarity: 'Secret Rare', setCode: '' }
];

for (const card of cards) {
  const res = await send({ type: 'getPrices', card, force: true });
  const t = res.tcg;
  console.log('\n### %s (%s) %s', card.name, card.rarity, card.setCode);
  if (!res.ok) { console.log('  ERRO:', res.error); continue; }
  console.log('  fx:', res.fx.usd.toFixed(4), res.fx.eur.toFixed(4), '|', res.fx.source);
  if (t) {
    console.log('  tcg produto:', t.productId, '|', t.rarityName, '|', t.number, '| exato:', t.exactMatch, '| alternativas:', t.alternatives);
    console.log('  url:', t.url);
    console.log('  menor:', t.lowest && `US$ ${t.lowest.totalUsd.toFixed(2)} -> R$ ${t.lowest.totalBrl.toFixed(2)} (${t.lowest.condition}/${t.lowest.printing}/${t.lowest.language}) de ${t.totalResults} anuncios`);
    console.log('  market:', t.market && `US$ ${t.market.usd} -> R$ ${t.market.brl.toFixed(2)}`);
  } else {
    console.log('  tcg: sem produto correspondente');
  }
  console.log('  cardmarket:', res.cardmarket && (res.cardmarket.eur ? `EUR ${res.cardmarket.eur} -> R$ ${res.cardmarket.brl.toFixed(2)}` : 'sem preco'));
  if (res.errors.length) console.log('  erros:', res.errors);
}

// cache + taxa extra
await chrome.storage.sync.set({ settings: { extraFeePct: 6.38 } });
const again = await send({ type: 'getPrices', card: cards[0], force: false });
console.log('\n### cache + taxa 6.38%');
console.log('  fromCache:', again.fromCache, '| menor R$', again.tcg?.lowest?.totalBrl.toFixed(2));
