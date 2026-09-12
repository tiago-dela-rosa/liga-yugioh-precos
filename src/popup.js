import { getSettings, saveSettings } from './shared.js';

const $ = (id) => document.getElementById(id);

function flash(message) {
  $('status').textContent = message;
  setTimeout(() => {
    $('status').textContent = '';
  }, 2000);
}

async function showFx() {
  const stored = await chrome.storage.local.get(null);
  const settings = await getSettings();

  if (settings.fxSource === 'manual') {
    $('usd').textContent = `R$ ${Number(settings.manualUsd).toFixed(4)}`;
    $('eur').textContent = `R$ ${Number(settings.manualEur).toFixed(4)}`;
    $('fxSrc').textContent = 'Cotação manual (definida nas configurações)';
    return;
  }

  const entry = stored[`fx:${settings.fxSource}`];
  if (!entry) {
    $('fxSrc').textContent = 'Cotação será buscada ao abrir uma carta.';
    return;
  }

  const fx = entry.value;
  $('usd').textContent = `R$ ${fx.usd.toFixed(4)}`;
  $('eur').textContent = `R$ ${fx.eur.toFixed(4)}`;
  const when = new Date(entry.at).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const fee = settings.extraFeePct ? ` · +${settings.extraFeePct}% de taxa` : '';
  $('fxSrc').textContent = `${fx.source} · ${when}${fee}`;
}

const settings = await getSettings();
$('autoOpen').checked = settings.autoOpen !== false;
$('includeShipping').checked = Boolean(settings.includeShipping);

$('autoOpen').addEventListener('change', async (event) => {
  await saveSettings({ autoOpen: event.target.checked });
  flash('Salvo.');
});

$('includeShipping').addEventListener('change', async (event) => {
  await saveSettings({ includeShipping: event.target.checked });
  await chrome.runtime.sendMessage({ type: 'clearCache' }).catch(() => {});
  flash('Salvo.');
});

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearCache' }).catch(() => {});
  await showFx();
  flash('Cache limpo.');
});

await showFx();
