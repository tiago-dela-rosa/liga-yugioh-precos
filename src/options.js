import { DEFAULTS, getSettings, saveSettings } from './shared.js';

const NUMBER_FIELDS = ['manualUsd', 'manualEur', 'extraFeePct', 'priceTtlMin', 'fxTtlMin'];
const BOOL_FIELDS = [
  'includeShipping',
  'showTcgLowest',
  'showTcgMarket',
  'showCardmarket',
  'autoOpen'
];
const TEXT_FIELDS = ['fxSource', 'minCondition', 'language', 'printing'];

const $ = (id) => document.getElementById(id);

function toggleManual() {
  $('manualRates').hidden = $('fxSource').value !== 'manual';
}

function fill(settings) {
  for (const key of TEXT_FIELDS) $(key).value = settings[key];
  for (const key of NUMBER_FIELDS) $(key).value = settings[key];
  for (const key of BOOL_FIELDS) $(key).checked = Boolean(settings[key]);
  toggleManual();
}

function collect() {
  const patch = {};
  for (const key of TEXT_FIELDS) patch[key] = $(key).value;
  for (const key of NUMBER_FIELDS) {
    const value = Number($(key).value);
    patch[key] = Number.isFinite(value) ? value : DEFAULTS[key];
  }
  for (const key of BOOL_FIELDS) patch[key] = $(key).checked;
  patch.priceTtlMin = Math.max(1, patch.priceTtlMin);
  patch.fxTtlMin = Math.max(1, patch.fxTtlMin);
  return patch;
}

function flash(message) {
  const status = $('status');
  status.textContent = message;
  clearTimeout(flash._timer);
  flash._timer = setTimeout(() => {
    status.textContent = '';
  }, 2500);
}

$('fxSource').addEventListener('change', toggleManual);

$('save').addEventListener('click', async () => {
  await saveSettings(collect());
  // Filtros mudaram: o cache antigo já não corresponde às opções.
  await chrome.runtime.sendMessage({ type: 'clearCache' }).catch(() => {});
  flash('Configurações salvas.');
});

$('clearCache').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'clearCache' }).catch(() => null);
  flash(res?.ok ? 'Cache limpo.' : 'Não foi possível limpar o cache.');
});

fill(await getSettings());
