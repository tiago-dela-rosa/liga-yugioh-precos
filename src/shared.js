/** Configuração padrão e utilidades compartilhadas (background, options e popup). */

export const DEFAULTS = {
  // Conversão
  fxSource: 'awesomeapi',      // 'awesomeapi' | 'erapi' | 'manual'
  manualUsd: 5.2,
  manualEur: 6.0,
  extraFeePct: 0,              // ex.: 6.38 (IOF) ou spread do cartão

  // Filtros de anúncio no TCGplayer
  minCondition: 'Near Mint',   // 'Near Mint' | 'Lightly Played' | 'Moderately Played' | 'Heavily Played' | 'Damaged'
  language: 'English',         // 'English' | 'any'
  printing: 'any',             // 'any' | '1st Edition' | 'Unlimited'
  includeShipping: false,      // somar frete do vendedor (EUA) ao menor anúncio

  // Fontes
  showTcgLowest: true,
  showTcgMarket: true,
  showCardmarket: true,

  // Cache (minutos)
  priceTtlMin: 180,
  fxTtlMin: 360,

  autoOpen: true               // buscar preços automaticamente ao abrir a carta
};

export const CONDITION_ORDER = [
  'Near Mint',
  'Lightly Played',
  'Moderately Played',
  'Heavily Played',
  'Damaged'
];

export async function getSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ settings: next });
  return next;
}

/** Normaliza nomes de raridade para comparação ("Quarter Century Secret Rare" -> "quartercenturysecretrare"). */
export function normalizeRarity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** Normaliza nomes de carta para comparação, preservando dígitos e letras. */
export function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function formatBRL(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

export function formatForeign(value, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
}
