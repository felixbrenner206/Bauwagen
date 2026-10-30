// Bauwagen-Zähler – Etappe 1–3: Bestand, Austragen, Einkauf, Inventur, Artikel, Offline-Sync, Einkaufsliste, Push (ntfy),
// Bestandsaufnahme, mehrere Flaschengrößen, Statistik (Beta)
import { parseReceipt, suggestParts } from './receipt.js';
const PARAMS = new URLSearchParams(location.search);
const DEMO = PARAMS.has('demo');
const IMPORT = PARAMS.has('import');
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 2) => Number(n).toLocaleString('de-DE', { maximumFractionDigits: d });

let backend;
const state = {
  items: [], pending: 0, connected: false,
  lastSync: Number(localStorage.getItem('bwz.lastSync')) || 0,
  view: 'stock', search: '', showArchived: false,
  cart: {},          // Einkauf: { itemId: { big, small } }
  settings: {},      // { ntfyTopic }
  shopChecked: new Set(JSON.parse(localStorage.getItem('bwz.shopChecked') || '[]')),
  stats: { tab: 'week', data: null, loading: false, sel: null, err: '' },
  me: {},            // eigenes Gerät: { role, name, ... }
  aliases: {},       // gelernte Bon-Zuordnungen
  scan: null,        // Bon-Scan: { step, text, rows, stamp }
  error: ''
};

// ---------- Einheiten ----------
const isDrink = (it) => it.type === 'drink';
const bigSize = (it) => (isDrink(it) ? Number(it.perCase) : Number(it.packSize)) || 0;
const bigWord = (it, n) => isDrink(it) ? (n === 1 ? 'Kasten' : 'Kästen') : (n === 1 ? 'Packung' : 'Packungen');
const smallWord = (it, n) => isDrink(it) ? (n === 1 ? 'Flasche' : 'Flaschen') : 'Stück';
const title = (it) => (isDrink(it) && it.sizeL ? `${it.name}\u00a0${fmt(it.sizeL, 3)}\u00a0L` : it.name);  // geschützte Leerzeichen: Gebinde bricht nicht um
const below = (it) => typeof it.minStock === 'number' && it.minStock > 0 && it.stock < it.minStock;
// Einkaufsvorschlag (Lastenheft Rev. 2): Fehlmenge bis Mindestbestand, bei Kasten-Artikeln auf volle Kästen aufgerundet
function suggestion(it) {
  const missing = it.minStock - it.stock;
  if (missing <= 0) return 0;
  const b = isDrink(it) ? bigSize(it) : 0;
  return b > 0 ? Math.ceil(missing / b) * b : missing;
}
const plain = (t) => String(t).replace(/\u00a0/g, ' ');
const isAdmin = () => state.me.role === 'admin';

// Mehrere Flaschengrößen (Rev. 4): Bestand bleibt in Standardflaschen (z. B. 0,75 L), andere Größen werden umgerechnet
// → Bestand kann dann krumm sein (1 L Schnaps = 1,333 Standardflaschen). Anzeige dann in Litern.
const isInt = (n) => Math.abs(n - Math.round(n)) < 1e-6;
const r4 = (n) => Math.round(n * 10000) / 10000;
const altSizes = (it) => (isDrink(it) && it.sizeL > 0 && Array.isArray(it.altSizes))
  ? it.altSizes.filter(x => x > 0 && Math.abs(x - it.sizeL) > 1e-9).sort((a, b) => a - b) : [];
const sizeLabel = (l) => `${fmt(l, 3)}\u00a0L`;
const altKey = (l) => 'alt' + String(l).replace('.', '_');

function qtyText(it, n) {
  if (!isInt(n) && isDrink(it) && it.sizeL) return `${fmt(n * it.sizeL)} L`;
  n = Math.round(n);
  const b = bigSize(it);
  if (b > 0 && n >= b) {
    const big = Math.floor(n / b), small = n % b;
    return `${big} ${bigWord(it, big)}` + (small ? ` · ${small} ${smallWord(it, small)}` : '');
  }
  return `${n} ${smallWord(it, n)}`;
}
function stockMain(it) {
  const s = it.stock;
  if (isDrink(it) && it.sizeL) return `${fmt(s * it.sizeL)} L`;
  return `${fmt(s, 0)} ${smallWord(it, s)}`;
}
function stockSub(it) {
  const s = it.stock, b = bigSize(it);
  if (!isInt(s)) return `≈ ${fmt(s, 1)} Fl. à ${fmt(it.sizeL, 3)} L`;
  if (b > 0 && s >= 0) {
    const big = Math.floor(s / b), small = s % b;
    return `${big} ${bigWord(it, big)} · ${small} ${smallWord(it, small)}`;
  }
  if (isDrink(it) && it.sizeL) return `${s} ${smallWord(it, s)}`;
  return '';
}

// ---------- Start ----------
async function start() {
  if (!DEMO) {
    const { firebaseConfig } = await import('./config.js');
    if (String(firebaseConfig.apiKey).includes('HIER_EINTRAGEN')) return fatal(
      'Firebase ist noch nicht eingerichtet: config.js ausfüllen (siehe EINRICHTUNG.md).<br><br>Zum Ausprobieren: <a href="?demo">Demo-Modus öffnen</a>');
  }
  backend = DEMO ? await import('./backend-mock.js') : await import('./backend-firebase.js').catch(e => {
    console.error(e);
    return null;
  });
  if (!backend) return fatal('Firebase-Bibliothek konnte nicht geladen werden. Beim allerersten Start wird Internet gebraucht.');
  if (!backend.configured) return fatal('Firebase ist noch nicht eingerichtet: config.js ausfüllen (siehe EINRICHTUNG.md).<br><br>Zum Ausprobieren: <a href="?demo">Demo-Modus öffnen</a>');
  if (DEMO) document.body.classList.add('demo');
  let joined;
  try { ({ joined } = await backend.init()); }
  catch (e) { console.error(e); return fatal('Start fehlgeschlagen: ' + esc(e.message)); }
  if (!joined) return showJoin();
  next();
}
function next() { IMPORT ? showImport() : run(); }

function fatal(html) {
  $('#app').innerHTML = `<div class="center-box"><h1>Bauwagen-Zähler</h1><p>${html}</p></div>`;
}

function showJoin() {
  $('#app').innerHTML = `
    <form class="center-box" id="joinForm">
      <h1>Bauwagen-Zähler</h1>
      <p>Code eingeben (einmalig pro Handy, braucht Internet).</p>
      <input id="joinCode" type="password" autocomplete="off" autocapitalize="off" placeholder="Code" required>
      <input id="joinName" maxlength="30" minlength="2" autocomplete="off" placeholder="Dein Name (z. B. Max)" required>
      <p class="hint">Dein Name ist nur für den Admin sichtbar. Für die anderen bleiben Buchungen anonym; der Admin sieht, von welchem Handy eine Buchung kam – damit Fehlbuchungen geklärt werden können.</p>
      <button class="btn primary big" type="submit">Beitreten</button>
      <p class="err" id="joinErr"></p>
    </form>`;
  $('#joinForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('#joinForm button'); btn.disabled = true; btn.textContent = 'Prüfe …';
    const nm = $('#joinName').value.trim();
    if (nm.length < 2) { $('#joinErr').textContent = 'Bitte Namen eingeben.'; btn.disabled = false; btn.textContent = 'Beitreten'; return; }
    try {
      await backend.join($('#joinCode').value, nm);
      localStorage.setItem('bwz.joinedAt', Date.now());
      localStorage.removeItem('bwz.tourDone');
      next();
    }
    catch (e) { $('#joinErr').textContent = e.message; btn.disabled = false; btn.textContent = 'Beitreten'; }
  };
}

function run() {
  $('#app').innerHTML = `
    <header class="top">
      <div class="title">Bauwagen<span class="admin-chip" id="adminChip" hidden>ADMIN</span></div>
      <div class="top-right"><button class="sync" id="sync" type="button"></button>
      <button class="gear" id="gear" type="button" aria-label="Einstellungen">⚙︎</button></div>
    </header>
    <div class="banner err" id="errBanner" hidden></div>
    <main id="view"></main>
    <nav class="tabs">
      <button data-view="stock">Bestand</button>
      <button data-view="buy">Einkauf</button>
      <button data-view="list">Liste<span class="tab-badge" id="listBadge" hidden></span></button>
      <button data-view="items">Artikel</button>
      <button data-view="stats">Statistik</button>
    </nav>
    <div class="snack" id="snack" hidden><span id="snackText"></span><button id="snackUndo" type="button">Rückgängig</button></div>
    <dialog id="sheet"></dialog>`;
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { state.view = b.dataset.view; render(); window.scrollTo(0, 0); });
  $('#sync').onclick = () => {
    if (DEMO) backend.setOnline(!backend.isOnline());
    else alert(syncLong());
  };
  window.addEventListener('bwz-error', (e) => showError(e.detail));
  backend.subscribe(onData, showError);
  backend.subscribeSettings((st) => { state.settings = st || {}; scheduleAlerts(); });
  backend.subscribeAliases((a) => { state.aliases = a || {}; });
  backend.subscribeMe((me) => {
    state.me = me || {}; $('#adminChip').hidden = !isAdmin(); render();
    // Geräte, die vor der Namens-Pflicht beigetreten sind: einmal nach dem Namen fragen
    if (me && me.role && !String(me.name || '').trim() && !$('#sheet').open) askName();
  });
  backend.touchLastSeen();
  $('#gear').onclick = openSettings;
  // Geräte, die schon vor der Hilfe-Funktion beigetreten sind: 4 Wochen Hinweise ab jetzt, aber keine Tour
  if (!localStorage.getItem('bwz.joinedAt')) { localStorage.setItem('bwz.joinedAt', Date.now()); localStorage.setItem('bwz.tourDone', '1'); }
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-hint-close]');
    if (c) { dismissHint(c.dataset.hintClose); c.closest('.hint-card').remove(); }
  });
  if (!localStorage.getItem('bwz.tourDone')) setTimeout(startTour, 400);
  setInterval(renderSync, 20000);
  render();
}

function onData({ items, pending, connected }) {
  state.items = items.map(i => ({ ...i, stock: Number(i.stock) || 0 }));
  state.pending = pending;
  state.connected = connected;
  if (connected) { state.lastSync = Date.now(); localStorage.setItem('bwz.lastSync', state.lastSync); }
  render();
  if ($('#sheet').open && $('#sheet').dataset.item) refreshSheetHeader();
  scheduleAlerts();
}

function showError(msg) {
  const b = $('#errBanner'); if (!b) return;
  b.textContent = msg; b.hidden = false;
  setTimeout(() => { b.hidden = true; }, 8000);
}

// ---------- Sync-Anzeige ----------
function ago(ts) {
  if (!ts) return 'noch nie';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.floor(min / 60);
  if (h < 48) return `vor ${h} Std.`;
  return `vor ${Math.floor(h / 24)} Tagen`;
}
function syncLong() {
  return state.connected
    ? 'Synchronisiert – alle Buchungen sind in der Cloud.'
    : `Offline / nicht synchron.\nZuletzt synchronisiert: ${ago(state.lastSync)}\nAusstehende Buchungen: ${state.pending}\n\nBuchungen werden automatisch übertragen, sobald wieder Netz da ist.`;
}
function renderSync() {
  const el = $('#sync'); if (!el) return;
  if (state.connected) { el.className = 'sync ok'; el.innerHTML = '● Synchron'; return; }
  el.className = 'sync off';
  el.innerHTML = `○ Sync ${esc(ago(state.lastSync))}` + (state.pending ? ` · <b>${state.pending} ausstehend</b>` : '');
}

// ---------- Render ----------
function render() {
  renderSync();
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  const v = $('#view'); if (!v) return;
  if (state.view !== 'buy') delete v.dataset.buyKey;
  if (state.view !== 'count') delete v.dataset.count;
  if (state.view !== 'scan') delete v.dataset.scan;
  document.body.classList.toggle('counting', state.view === 'count' || state.view === 'scan');
  const lowCount = active().filter(below).length;
  const badge = $('#listBadge');
  if (badge) { badge.hidden = !lowCount; badge.textContent = lowCount; }
  if (state.view === 'stock') renderStock(v);
  else if (state.view === 'buy') renderBuy(v);
  else if (state.view === 'list') renderList(v);
  else if (state.view === 'count') renderCount(v);
  else if (state.view === 'scan') renderScan(v);
  else if (state.view === 'stats') renderStats(v);
  else renderItems(v);
  addHint(v, state.view);
}

function groupByCat(list) {
  const map = new Map();
  [...list].sort((a, b) => (a.category || '').localeCompare(b.category || '', 'de') || title(a).localeCompare(title(b), 'de'))
    .forEach(it => { const c = it.category || 'Ohne Kategorie'; if (!map.has(c)) map.set(c, []); map.get(c).push(it); });
  return map;
}
const active = () => state.items.filter(i => !i.archived);
const matches = (it) => !state.search || title(it).toLowerCase().includes(state.search.toLowerCase()) || (it.category || '').toLowerCase().includes(state.search.toLowerCase());

function renderStock(v) {
  if (!$('#stockSearch', v)) {
    v.innerHTML = `<div class="stock-head"><input class="search" id="stockSearch" type="search" placeholder="Suchen …">
      <button class="btn" type="button" id="startCount">📋 Zählen</button></div><div id="stockList"></div>`;
    $('#startCount').onclick = startCount;
    $('#stockSearch').value = state.search;
    $('#stockSearch').oninput = (e) => { state.search = e.target.value; renderStockList(); };
  }
  renderStockList();
}

function renderStockList() {
  const list = $('#stockList'); if (!list) return;
  const items = active().filter(matches);
  if (!state.items.length) { list.innerHTML = `<p class="empty">Noch keine Artikel. Unter <b>Artikel</b> anlegen.</p>`; return; }
  if (!items.length) { list.innerHTML = `<p class="empty">Nichts gefunden.</p>`; return; }
  let html = '';
  for (const [cat, its] of groupByCat(items)) {
    html += `<h2 class="cat">${esc(cat)}</h2>`;
    for (const it of its) {
      html += `<div class="row ${below(it) ? 'low' : ''}" data-id="${esc(it.id)}">
        <button class="row-main" type="button" data-open="${esc(it.id)}">
          <span class="name">${esc(title(it))}</span>
          <span class="qty"><b>${esc(stockMain(it))}</b><small>${esc(stockSub(it))}</small></span>
        </button>
        <button class="minus" type="button" data-minus="${esc(it.id)}" aria-label="1 austragen">−1</button>
      </div>`;
    }
  }
  list.innerHTML = html;
  list.querySelectorAll('[data-minus]').forEach(b => b.onclick = () => quickOut(b.dataset.minus));
  list.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openSheet(b.dataset.open));
}

function getItem(id) { return state.items.find(i => i.id === id); }

// ---------- Buchen + Rückgängig ----------
let snackTimer;
function doBook(entries, text) {
  entries = entries.filter(e => e.delta !== 0);
  if (!entries.length) return;
  const ids = backend.book(entries);
  if (navigator.vibrate) navigator.vibrate(15);
  showSnack(text, () => {
    backend.book(entries.map((e, i) => ({ itemId: e.itemId, delta: -e.delta, kind: 'undo', ref: ids[i] })));
    showSnack('Rückgängig gemacht', null);
  });
}
function showSnack(text, undoFn) {
  const sn = $('#snack');
  $('#snackText').textContent = text;
  const u = $('#snackUndo');
  u.hidden = !undoFn;
  u.onclick = () => { clearTimeout(snackTimer); sn.hidden = true; undoFn && undoFn(); };
  sn.hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => { sn.hidden = true; }, undoFn ? 5000 : 2000);
}
function quickOut(id) {
  const it = getItem(id);
  doBook([{ itemId: id, delta: -1, kind: 'out' }], `−1 ${smallWord(it, 1)} ${title(it)}`);
}

// ---------- Artikel-Sheet (Austragen / Einbuchen / Inventur) ----------
function stepper(key, label, val) {
  return `<div class="stepper" data-key="${key}">
    <span class="lbl">${esc(label)}</span>
    <button type="button" data-step="-1">−</button>
    <input type="number" inputmode="numeric" min="0" value="${val}" data-input>
    <button type="button" data-step="1">+</button>
  </div>`;
}
function wireSteppers(root, onChange) {
  root.querySelectorAll('.stepper').forEach(st => {
    const inp = st.querySelector('[data-input]');
    st.querySelectorAll('[data-step]').forEach(b => b.onclick = () => {
      inp.value = Math.max(0, (parseInt(inp.value, 10) || 0) + Number(b.dataset.step));
      onChange();
    });
    inp.oninput = onChange;
    inp.onfocus = () => inp.select();
  });
}
const readStep = (root, key) => Math.max(0, parseInt(root.querySelector(`.stepper[data-key="${key}"] [data-input]`)?.value, 10) || 0);

// Mengeneingabe für einen Artikel: Kästen/Packungen + Standardflaschen + ggf. weitere Flaschengrößen
function qtySteppers(it, init = {}) {
  const b = bigSize(it), alts = altSizes(it);
  let h = '';
  if (b > 0) h += stepper('big', `${bigWord(it, 2)} (à ${b})`, init.big || 0);
  h += stepper('small', alts.length ? `Flaschen ${sizeLabel(it.sizeL)}` : smallWord(it, 2), init.small || 0);
  for (const a of alts) h += stepper(altKey(a), `Flaschen ${sizeLabel(a)}`, (init.alt && init.alt[a]) || 0);
  return h;
}
function readParts(root, it) {
  const alt = {};
  for (const a of altSizes(it)) alt[a] = readStep(root, altKey(a));
  return { big: readStep(root, 'big'), small: readStep(root, 'small'), alt };
}
function partsQty(it, c) {
  let q = (c.big || 0) * bigSize(it) + (c.small || 0);
  for (const a of altSizes(it)) q += ((c.alt && c.alt[a]) || 0) * a / it.sizeL;
  return r4(q);
}
const partsEmpty = (c) => !(c.big || c.small || Object.values(c.alt || {}).some(Boolean));

let sheetMode = 'out';
function openSheet(id) {
  const it = getItem(id); if (!it) return;
  sheetMode = 'out';
  const d = $('#sheet');
  d.dataset.item = id;
  d.innerHTML = `
    <div class="sheet-head"><div><h3>${esc(title(it))}</h3><div class="sheet-stock" id="sheetStock"></div></div>
      <button class="x" type="button" data-close aria-label="Schließen">✕</button></div>
    <div class="seg" id="seg">
      <button type="button" data-mode="out">Austragen</button>
      <button type="button" data-mode="in">Einbuchen</button>
      <button type="button" data-mode="inv">Inventur</button>
    </div>
    <p class="hint" id="sheetHint"></p>
    <div id="steps"></div>
    <div class="result" id="sheetResult"></div>
    <button class="btn primary big" type="button" id="sheetGo">Buchen</button>
    <button class="btn link" type="button" id="sheetEdit">Artikel bearbeiten</button>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { sheetMode = b.dataset.mode; buildSheetBody(); });
  $('#sheetEdit').onclick = () => { d.close(); openItemForm(id); };
  $('#sheetGo').onclick = () => submitSheet();
  d.onclick = (e) => { if (e.target === d) d.close(); };
  buildSheetBody();
  refreshSheetHeader();
  d.showModal();
}
function refreshSheetHeader() {
  const it = getItem($('#sheet').dataset.item); if (!it) return;
  const s = $('#sheetStock'); if (!s) return;
  s.innerHTML = `Bestand: <b>${esc(stockMain(it))}</b>` + (stockSub(it) ? ` · ${esc(stockSub(it))}` : '') + (below(it) ? ' <span class="badge">unter Mindestbestand</span>' : '');
  updateSheetResult();
}
function buildSheetBody() {
  const it = getItem($('#sheet').dataset.item);
  $('#seg').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === sheetMode));
  let html = '';
  if (sheetMode === 'inv') {
    const b = bigSize(it), whole = Math.floor(Math.max(0, it.stock) + 1e-6);
    html = qtySteppers(it, { big: b > 0 ? Math.floor(whole / b) : 0, small: b > 0 ? whole % b : whole });
    $('#sheetHint').textContent = 'Tatsächlich gezählten Bestand eingeben. Wird als Korrekturbuchung gespeichert.';
  } else {
    html = qtySteppers(it, { small: sheetMode === 'out' ? 1 : 0 });
    $('#sheetHint').textContent = sheetMode === 'out' ? 'Menge, die rausgenommen wird.' : 'Menge, die dazukommt (z. B. Einkauf eines einzelnen Artikels).';
  }
  $('#steps').innerHTML = html;
  wireSteppers($('#steps'), updateSheetResult);
  $('#sheetGo').textContent = sheetMode === 'out' ? 'Austragen' : sheetMode === 'in' ? 'Einbuchen' : 'Bestand korrigieren';
  updateSheetResult();
}
function sheetQty() {
  const it = getItem($('#sheet').dataset.item);
  return partsQty(it, readParts($('#steps'), it));
}
function updateSheetResult() {
  const it = getItem($('#sheet').dataset.item); const r = $('#sheetResult'); if (!it || !r) return;
  const q = sheetQty();
  let delta = r4(sheetMode === 'out' ? -q : sheetMode === 'in' ? q : q - it.stock);
  const after = it.stock + delta;
  r.innerHTML = sheetMode === 'inv'
    ? (delta === 0 ? 'Keine Abweichung.' : `Abweichung: <b>${delta > 0 ? '+' : '−'}${esc(qtyText(it, Math.abs(delta)))}</b>`)
    : (q === 0 ? 'Menge wählen.' : `${sheetMode === 'out' ? '−' : '+'}${esc(qtyText(it, q))} → danach ${esc(stockMain({ ...it, stock: after }))}`);
  $('#sheetGo').disabled = sheetMode === 'inv' ? delta === 0 : q === 0;
}
function submitSheet() {
  const id = $('#sheet').dataset.item; const it = getItem(id);
  const q = sheetQty();
  if (sheetMode === 'out') doBook([{ itemId: id, delta: -q, kind: 'out' }], `−${qtyText(it, q)} ${title(it)}`);
  else if (sheetMode === 'in') doBook([{ itemId: id, delta: q, kind: 'in' }], `+${qtyText(it, q)} ${title(it)}`);
  else doBook([{ itemId: id, delta: r4(q - it.stock), kind: 'correction', target: q }], `Inventur ${title(it)}: ${qtyText(it, q)}`);
  $('#sheet').close();
}

// ---------- Einkauf ----------
function renderBuy(v) {
  const items = active();
  if (!items.length) { v.innerHTML = `<p class="empty">Noch keine Artikel.</p>`; return; }
  // Bei Sync-Updates nicht neu aufbauen (sonst springt die Eingabe) – nur Bestandstexte aktualisieren
  const key = items.map(i => i.id + bigSize(i) + title(i) + i.category + altSizes(i).join(',')).sort().join('|');
  if (v.dataset.buyKey === key && $('.buy-row', v)) {
    items.forEach(it => {
      const s = v.querySelector(`.buy-row[data-id="${it.id}"] .buy-stock`);
      if (s) s.innerHTML = `Bestand ${esc(stockMain(it))}${below(it) ? ' · <span class="lowtxt">unter Min.</span>' : ''}`;
    });
    return;
  }
  v.dataset.buyKey = key;
  let html = `<div class="buy-head"><p class="hint">Eingekaufte Mengen eintragen, dann unten buchen.</p>
    <button class="btn primary" type="button" id="startScan">📷 Bon scannen</button></div>`;
  for (const [cat, its] of groupByCat(items)) {
    html += `<h2 class="cat">${esc(cat)}</h2>`;
    for (const it of its) {
      const c = state.cart[it.id] || { big: 0, small: 0, alt: {} };
      html += `<div class="buy-row ${partsEmpty(c) ? '' : 'has'}" data-id="${esc(it.id)}">
        <div class="buy-name">${esc(title(it))}<small class="buy-stock">Bestand ${esc(stockMain(it))}${below(it) ? ' · <span class="lowtxt">unter Min.</span>' : ''}</small></div>
        <div class="buy-steps">${qtySteppers(it, c)}</div>
      </div>`;
    }
  }
  html += `<div class="buy-bar"><span id="buySum"></span><button class="btn primary" type="button" id="buyGo">Einkauf buchen</button></div>`;
  v.innerHTML = html;
  v.querySelectorAll('.buy-row').forEach(row => {
    wireSteppers(row, () => {
      const id = row.dataset.id, it = getItem(id); if (!it) return;
      state.cart[id] = readParts(row, it);
      row.classList.toggle('has', !partsEmpty(state.cart[id]));
      updateBuySum();
    });
  });
  $('#buyGo').onclick = submitBuy;
  $('#startScan').onclick = startScan;
  updateBuySum();
}
function cartEntries() {
  return Object.entries(state.cart).map(([id, c]) => {
    const it = getItem(id); if (!it || it.archived) return null;
    const q = partsQty(it, c);
    return q > 0 ? { itemId: id, delta: q, kind: 'in' } : null;
  }).filter(Boolean);
}
function updateBuySum() {
  const e = cartEntries();
  $('#buySum').textContent = e.length ? `${e.length} Artikel` : 'Nichts eingetragen';
  $('#buyGo').disabled = !e.length;
}
function submitBuy() {
  const e = cartEntries(); if (!e.length) return;
  doBook(e, `Einkauf gebucht (${e.length} Artikel)`);
  state.cart = {};
  delete $('#view').dataset.buyKey;
  render();
}

// ---------- Artikelverwaltung ----------
function renderItems(v) {
  const list = state.items.filter(i => state.showArchived || !i.archived);
  const noMin = active().filter(i => !(i.minStock > 0)).length;
  let html = `<div class="items-head">
      <button class="btn primary" type="button" id="newItem">+ Neuer Artikel</button>
      <button class="btn" type="button" id="minBulk">Mindestbestände</button>
      <button class="btn" type="button" id="sizeBulk">Flaschengrößen</button>

    </div>
    ${noMin ? `<p class="hint">${noMin} Artikel ohne Mindestbestand – die erscheinen nie auf der Einkaufsliste.</p>` : ''}
    <label class="chk" style="margin-top:10px"><input type="checkbox" id="showArch" ${state.showArchived ? 'checked' : ''}> Archivierte zeigen</label>`;
  if (!list.length) html += `<p class="empty">Keine Artikel.</p>`;
  for (const [cat, its] of groupByCat(list)) {
    html += `<h2 class="cat">${esc(cat)}</h2>`;
    for (const it of its) {
      const meta = isDrink(it)
        ? [it.sizeL ? `${fmt(it.sizeL, 3)} L/Fl.` : null, it.perCase ? `${it.perCase} Fl./Kasten` : null,
           altSizes(it).length ? `auch ${altSizes(it).map(a => fmt(a, 3) + ' L').join(', ')}` : null]
        : ['Stück', it.packSize ? `${it.packSize}/Packung` : null];
      meta.push(it.minStock > 0 ? `Min ${qtyText(it, it.minStock)}` : 'kein Mindestbestand');
      html += `<button class="item-row ${it.archived ? 'arch' : ''}" type="button" data-edit="${esc(it.id)}">
        <span>${esc(title(it))}${it.archived ? ' <i>(archiviert)</i>' : ''}</span>
        <small>${esc(meta.filter(Boolean).join(' · '))}</small></button>`;
    }
  }
  v.innerHTML = html;
  $('#newItem').onclick = () => openItemForm(null);
  $('#minBulk').onclick = openMinBulk;
  $('#sizeBulk').onclick = openSizeBulk;

  $('#showArch').onchange = (e) => { state.showArchived = e.target.checked; render(); };
  v.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openItemForm(b.dataset.edit));
}

function openItemForm(id) {
  const it = id ? getItem(id) : { type: 'drink', category: '', name: '', sizeL: 0.5, perCase: 20, packSize: null, minStock: 0 };
  const cats = [...new Set(state.items.map(i => i.category).filter(Boolean)), 'Bier', 'Softdrinks', 'Schnaps', 'Verbrauchsmaterial']
    .filter((c, i, a) => a.indexOf(c) === i);
  const d = $('#sheet');
  delete d.dataset.item;
  d.innerHTML = `<form id="itemForm" class="form">
    <div class="sheet-head"><h3>${id ? 'Artikel bearbeiten' : 'Neuer Artikel'}</h3><button class="x" type="button" data-close>✕</button></div>
    <label>Name<input name="name" required maxlength="60" value="${esc(it.name)}" placeholder="z. B. Helles"></label>
    <label>Kategorie<input name="category" list="catList" maxlength="40" value="${esc(it.category)}" placeholder="z. B. Bier"></label>
    <datalist id="catList">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="seg" id="typeSeg">
      <button type="button" data-type="drink">Trinkbar</button>
      <button type="button" data-type="piece">Nicht trinkbar</button>
    </div>
    <div class="grid2 only-drink">
      <label>Liter pro Flasche<input name="sizeL" type="text" inputmode="decimal" value="${it.sizeL != null ? fmt(it.sizeL, 3) : ''}" placeholder="0,5"></label>
      <label>Flaschen pro Kasten<input name="perCase" type="number" inputmode="numeric" min="0" value="${it.perCase ?? ''}" placeholder="20"></label>
    </div>
    <label class="only-drink">Weitere Flaschengrößen in L (optional)<input name="altSizes" type="text" inputmode="decimal" value="${esc(altSizes(it).map(a => fmt(a, 3)).join('; '))}" placeholder="z. B. 1  oder  0,5; 1,5"></label>
    <div class="grid2 only-piece">
      <label>Stück pro Packung (optional)<input name="packSize" type="number" inputmode="numeric" min="0" value="${it.packSize ?? ''}"></label>
    </div>
    <label>Mindestbestand <span class="unit"></span> – darunter muss eingekauft werden<input name="minStock" type="number" inputmode="numeric" min="0" value="${it.minStock ?? 0}" required></label>
    ${id ? '' : `<label>Anfangsbestand <span class="unit"></span><input name="initial" type="number" inputmode="numeric" min="0" value="0"></label>`}
    <p class="err" id="formErr"></p>
    <button class="btn primary big" type="submit">Speichern</button>
    ${id ? `<button class="btn ${it.archived ? '' : 'danger'}" type="button" id="archBtn">${it.archived ? 'Wiederherstellen' : 'Archivieren'}</button>` : ''}
  </form>`;
  let type = it.type;
  const f = $('#itemForm');
  const setType = (t) => {
    type = t;
    f.querySelectorAll('[data-type]').forEach(b => b.classList.toggle('active', b.dataset.type === t));
    f.querySelectorAll('.only-drink').forEach(e => e.hidden = t !== 'drink');
    f.querySelectorAll('.only-piece').forEach(e => e.hidden = t !== 'piece');
    f.querySelectorAll('.unit').forEach(e => e.textContent = t === 'drink' ? '(Flaschen)' : '(Stück)');
  };
  f.querySelectorAll('[data-type]').forEach(b => b.onclick = () => setType(b.dataset.type));
  setType(type);
  f.querySelector('[data-close]').onclick = () => d.close();
  if (id) $('#archBtn').onclick = () => { backend.saveItem({ archived: !it.archived }, id); d.close(); };
  f.onsubmit = (ev) => {
    ev.preventDefault();
    const fd = new FormData(f);
    const num = (k) => { const v = String(fd.get(k) ?? '').trim().replace(',', '.'); return v === '' ? null : Number(v); };
    const data = {
      name: String(fd.get('name')).trim(),
      category: String(fd.get('category') || '').trim(),
      type,
      sizeL: type === 'drink' ? num('sizeL') : null,
      perCase: type === 'drink' ? num('perCase') : null,
      packSize: type === 'piece' ? num('packSize') : null,
      minStock: Math.round(num('minStock') ?? 0),
      altSizes: type === 'drink' ? parseSizes(fd.get('altSizes')) : []
    };
    for (const k of ['sizeL', 'perCase', 'packSize', 'minStock']) {
      if (data[k] !== null && (!isFinite(data[k]) || data[k] < 0)) { $('#formErr').textContent = 'Ungültige Zahl.'; return; }
      if (data[k] === 0 && k !== 'minStock') data[k] = null;
    }
    if (!data.name) { $('#formErr').textContent = 'Name fehlt.'; return; }
    if (id) data.archived = !!it.archived;
    const newId = backend.saveItem(data, id);
    const init = id ? 0 : Math.max(0, Math.round(num('initial') || 0));
    if (init > 0) backend.book([{ itemId: newId, delta: init, kind: 'correction', target: init, ref: 'init' }]);
    d.close();
    showSnack(id ? 'Gespeichert' : 'Artikel angelegt', null);
  };
  d.onclick = (e) => { if (e.target === d) d.close(); };
  if (!d.open) d.showModal();
}

// Eingabe "1" oder "0,5; 1,5" → [1] bzw. [0.5, 1.5]
function parseSizes(txt) {
  return [...new Set((String(txt || '').match(/\d+(?:[.,]\d+)?/g) || []).map(x => Number(x.replace(',', '.'))).filter(x => x > 0 && x <= 5))].sort((a, b) => a - b);
}

// Flaschengrößen für eine ganze Kategorie setzen (z. B. alle Schnäpse: zusätzlich 1 L)
function openSizeBulk() {
  const cats = [...new Set(active().filter(isDrink).map(i => i.category || 'Ohne Kategorie'))].sort((a, b) => a.localeCompare(b, 'de'));
  const d = $('#sheet');
  delete d.dataset.item;
  d.innerHTML = `<form class="form" id="sizeForm">
    <div class="sheet-head"><h3>Flaschengrößen</h3><button class="x" type="button" data-close>✕</button></div>
    <p class="hint">Für Artikel, die es in verschiedenen Flaschengrößen gibt (z. B. Schnaps 0,75 L und 1 L, Cola 1 L und 1,5 L). Beim Einkaufen und Zählen erscheinen dann eigene Felder pro Größe – umgerechnet wird automatisch.</p>
    <label>Kategorie<select name="cat">${cats.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
    <label>Weitere Größen in L<input name="sizes" type="text" inputmode="decimal" placeholder="z. B. 1  oder  0,5; 1,5"></label>
    <div id="sizePrev" class="hint"></div>
    <button class="btn primary big" type="submit">Für alle Artikel der Kategorie übernehmen</button>
  </form>`;
  const f = $('#sizeForm');
  const prev = () => {
    const its = active().filter(i => isDrink(i) && (i.category || 'Ohne Kategorie') === f.cat.value);
    const sz = parseSizes(f.sizes.value);
    $('#sizePrev').innerHTML = its.map(i => `${esc(plain(title(i)))}: ${altSizes({ ...i, altSizes: sz }).map(a => fmt(a, 3) + ' L').join(', ') || 'nur Standard'}`).join('<br>');
  };
  f.cat.onchange = () => {
    const first = active().find(i => isDrink(i) && (i.category || 'Ohne Kategorie') === f.cat.value && altSizes(i).length);
    f.sizes.value = first ? altSizes(first).map(a => fmt(a, 3)).join('; ') : '';
    prev();
  };
  f.sizes.oninput = prev;
  f.cat.onchange();
  f.querySelector('[data-close]').onclick = () => d.close();
  f.onsubmit = (ev) => {
    ev.preventDefault();
    const sz = parseSizes(f.sizes.value);
    const its = active().filter(i => isDrink(i) && (i.category || 'Ohne Kategorie') === f.cat.value);
    its.forEach(i => backend.saveItem({ altSizes: sz }, i.id));
    d.close();
    showSnack(`${its.length} Artikel aktualisiert`, null);
  };
  d.onclick = (e) => { if (e.target === d) d.close(); };
  if (!d.open) d.showModal();
}

// ---------- Bestandsaufnahme (alle Artikel auf einer Seite) ----------
// Vorausgefüllt mit dem erwarteten Bestand → nur Abweichungen ändern. Speichert ein Zählprotokoll (counts)
// plus Korrekturbuchungen; beides zusammen ist die Grundlage der Party-Auswertung in der Statistik.
const COUNT_KINDS = ['Vor Party', 'Nach Party', 'Sonstige'];
function startCount() {
  state.count = { kind: 'Sonstige', name: '', vals: {} };   // vals: { itemId: { big, small } }
  state.view = 'count'; render(); window.scrollTo(0, 0);
}
function countTotal(it) {
  const v = state.count.vals[it.id];
  if (!v) return Math.max(0, it.stock);
  return partsQty(it, v);
}
function devText(it, d) {
  if (d === 0) return '✓';
  const n = Math.abs(d), sign = d > 0 ? '+' : '−';
  if (!isInt(n) && isDrink(it) && it.sizeL) return `${sign}${fmt(n * it.sizeL)} L`;
  return `${sign}${Math.round(n)} ${isDrink(it) ? 'Fl.' : 'St.'}`;
}
function renderCount(v) {
  const items = active();
  if (v.dataset.count === '1') { updateCountDevs(); return; }   // Sync-Updates zerstören keine Eingaben
  v.dataset.count = '1';
  const c = state.count;
  let html = `<div class="count-head">
      <div class="count-top"><h2>Bestandsaufnahme</h2><button class="btn link" type="button" id="countCancel">Abbrechen</button></div>
      <div class="seg" id="countKind">${COUNT_KINDS.map(k => `<button type="button" data-kind="${k}" class="${k === c.kind ? 'active' : ''}">${k}</button>`).join('')}</div>
      <input id="countName" maxlength="40" placeholder="Anlass (optional), z. B. Halloween" value="${esc(c.name)}">
      <p class="hint">Vorausgefüllt mit dem erwarteten Bestand – nur ändern, was abweicht. <b>Kästen</b> = volle Kästen, <b>Flaschen</b> = alle losen Flaschen zusammen.</p>
    </div><form id="countForm" onsubmit="return false">`;
  for (const [cat, its] of groupByCat(items)) {
    html += `<h2 class="cat">${esc(cat)}</h2>`;
    for (const it of its) {
      const b = bigSize(it), exp = Math.max(0, it.stock), whole = Math.floor(exp + 1e-6);
      const big = b > 0 ? Math.floor(whole / b) : 0, small = b > 0 ? whole % b : whole;
      const alts = altSizes(it);
      html += `<div class="count-row" data-id="${esc(it.id)}">
        <div class="count-name"><span>${esc(title(it))}</span><small class="count-exp">erwartet ${esc(qtyText(it, exp))}</small></div>
        <div class="count-inputs">
          ${b > 0 ? `<label>${bigWord(it, 2)}<input data-f="big" type="text" inputmode="numeric" pattern="[0-9]*" value="${big}"></label>` : ''}
          <label>${alts.length ? sizeLabel(it.sizeL) : smallWord(it, 2)}<input data-f="small" type="text" inputmode="numeric" pattern="[0-9]*" value="${small}"></label>
          ${alts.map(a => `<label>${sizeLabel(a)}<input data-f="alt" data-size="${a}" type="text" inputmode="numeric" pattern="[0-9]*" value="0"></label>`).join('')}
          <span class="dev">✓</span>
        </div></div>`;
    }
  }
  html += `</form><div class="buy-bar count-bar"><span id="countSum"></span><button class="btn primary" type="button" id="countSave">Speichern</button></div>`;
  v.innerHTML = html;
  v.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
    c.kind = b.dataset.kind;
    v.querySelectorAll('[data-kind]').forEach(x => x.classList.toggle('active', x === b));
  });
  $('#countName').oninput = (e) => { c.name = e.target.value; };
  const inputs = [...v.querySelectorAll('.count-row input')];
  inputs.forEach((inp, idx) => {
    // Antippen leert das Feld (alter Wert grau als Platzhalter) → Tippen überschreibt immer; nichts getippt = Wert bleibt
    inp.onfocus = () => { inp.dataset.prev = inp.value; inp.placeholder = inp.value; inp.value = ''; };
    inp.onblur = () => { inp.placeholder = ''; if (inp.value === '') { inp.value = inp.dataset.prev ?? '0'; inp.oninput(); } };
    inp.oninput = () => {
      inp.value = inp.value.replace(/\D/g, '');
      const row = inp.closest('.count-row');
      const big = row.querySelector('[data-f="big"]'), small = row.querySelector('[data-f="small"]');
      const alt = {};
      row.querySelectorAll('[data-f="alt"]').forEach(x => { alt[Number(x.dataset.size)] = Number(x.value) || 0; });
      c.vals[row.dataset.id] = { big: big ? Number(big.value) || 0 : 0, small: Number(small.value) || 0, alt };
      updateCountDevs();
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); (inputs[idx + 1] || inp).focus(); } };
  });
  $('#countCancel').onclick = () => {
    if (Object.keys(c.vals).length && !confirm('Bestandsaufnahme verwerfen?')) return;
    state.view = 'stock'; render();
  };
  $('#countSave').onclick = saveCountSession;
  updateCountDevs();
}
function countEntries() {
  return active().map(it => ({ it, total: countTotal(it), d: r4(countTotal(it) - it.stock) })).filter(x => Math.abs(x.d) > 1e-6);
}
function updateCountDevs() {
  const v = $('#view');
  v.querySelectorAll('.count-row').forEach(row => {
    const it = getItem(row.dataset.id); if (!it) return;
    const d = r4(countTotal(it) - it.stock);
    const dev = row.querySelector('.dev');
    dev.textContent = devText(it, d);
    dev.className = 'dev ' + (d < 0 ? 'neg' : d > 0 ? 'pos' : '');
    row.classList.toggle('changed', d !== 0);
    row.querySelector('.count-exp').textContent = `erwartet ${qtyText(it, Math.max(0, it.stock))}`;
  });
  const n = countEntries().length;
  const sum = $('#countSum'); if (sum) sum.textContent = n ? `${n} Abweichung${n === 1 ? '' : 'en'}` : 'Alles wie erwartet';
}
function saveCountSession() {
  const c = state.count;
  const label = c.kind + (c.name.trim() ? `: ${c.name.trim()}` : '');
  const devs = countEntries();
  const lost = devs.filter(x => x.d < 0).reduce((a, x) => a + (isDrink(x.it) && x.it.sizeL ? -x.d * x.it.sizeL : 0), 0);
  const msg = devs.length
    ? `${label} speichern?\n${devs.length} Abweichung(en)` + (lost ? `, Fehlmenge ${fmt(lost)} L` : '')
    : `${label} speichern?\nAlles wie erwartet.`;
  if (!confirm(msg)) return;
  const counted = {};
  active().forEach(it => { counted[it.id] = countTotal(it); });
  backend.saveCount(label, counted, devs.map(x => ({ itemId: x.it.id, delta: x.d, target: x.total })));
  state.view = 'stock'; render();
  showSnack(`Bestandsaufnahme gespeichert (${devs.length} Korrekturen)`, null);
}

// ---------- Statistik (Beta) ----------
// Verbrauch (Lastenheft Rev. 3) = Austragen + Fehlmengen aus Bestandsaufnahmen/Inventur; Mehrbestand wird gegengerechnet.
// Nicht als Verbrauch zählen: Einkäufe, Anfangsbestände, Rückgängig von Einkäufen.
const DAY = 86400000;
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const dDate = (ts) => { const d = new Date(ts); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`; };
const dTime = (ts) => { const d = new Date(ts); return `${WD[d.getDay()]} ${dDate(ts)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function weekStart(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
function kw(ts) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / DAY - 3 + ((w1.getDay() + 6) % 7)) / 7);
}
function periods(kind, n) {
  const res = [];
  if (kind === 'week') {
    let start = new Date(weekStart(Date.now()));
    for (let i = 0; i < n; i++) {
      const end = new Date(start); end.setDate(end.getDate() + 7);
      res.unshift({ from: start.getTime(), to: end.getTime(), label: `KW ${kw(start.getTime())}`, long: `KW ${kw(start.getTime())} (${dDate(start.getTime())}–${dDate(end.getTime() - DAY)})` });
      start = new Date(start); start.setDate(start.getDate() - 7);
    }
  } else {
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const from = new Date(now.getFullYear(), now.getMonth() - i, 1), to = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      res.push({ from: from.getTime(), to: to.getTime(), label: MON[from.getMonth()], long: `${MONTHS[from.getMonth()]} ${from.getFullYear()}` });
    }
  }
  return res;
}
const isInitBooking = (b) => b.kind === 'correction' && (b.ref === 'init' || (!b.session && b.delta > 0 && Math.abs((b.target ?? -1) - b.delta) < 1e-6));
function consumptionEvents(data) {
  const byId = Object.fromEntries(data.bookings.map(b => [b.id, b]));
  const out = [];
  for (const b of data.bookings) {
    let c = 0;
    if (b.kind === 'out') c = -b.delta;
    else if (b.kind === 'correction') c = isInitBooking(b) ? 0 : -b.delta;
    else if (b.kind === 'undo') { const o = byId[b.ref]; if (o && (o.kind === 'out' || (o.kind === 'correction' && !isInitBooking(o)))) c = -b.delta; }
    if (c && getItem(b.itemId)) out.push({ itemId: b.itemId, units: c, ts: b.clientTs });
  }
  return out;
}
const litersOf = (it, units) => (isDrink(it) && it.sizeL ? units * it.sizeL : 0);
function aggregate(perItem) {   // perItem: { itemId: units } → Summen
  let liters = 0; const byCat = {}; const rows = [];
  for (const [id, u] of Object.entries(perItem)) {
    const it = getItem(id); if (!it || Math.abs(u) < 1e-6) continue;
    const l = litersOf(it, u); liters += l;
    const cat = it.category || 'Ohne Kategorie';
    byCat[cat] = (byCat[cat] || 0) + l;
    rows.push({ it, units: r4(u), liters: l });
  }
  rows.sort((a, b) => (b.liters - a.liters) || (b.units - a.units));
  return { liters, byCat, rows };
}
function sumEvents(events, from, to) {
  const per = {};
  for (const e of events) if (e.ts >= from && e.ts < to) per[e.itemId] = (per[e.itemId] || 0) + e.units;
  return aggregate(per);
}
function partyList(data) {
  const counts = data.counts.filter(c => !c.canceled).sort((a, b) => a.clientTs - b.clientTs);
  const byId = Object.fromEntries(data.bookings.map(b => [b.id, b]));
  const res = [];
  counts.forEach((c, i) => {
    if (!String(c.label).startsWith('Vor Party')) return;
    const next = counts.slice(i + 1).find(x => /^(Vor|Nach) Party/.test(x.label));
    if (!next || !next.label.startsWith('Nach Party')) { res.push({ before: c, open: true }); return; }
    const ins = {};
    for (const b of data.bookings) {
      if (b.clientTs <= c.clientTs || b.clientTs > next.clientTs) continue;
      if (b.kind === 'in' || (b.kind === 'undo' && byId[b.ref]?.kind === 'in')) ins[b.itemId] = (ins[b.itemId] || 0) + b.delta;
    }
    const per = {};
    for (const id of Object.keys(c.counted || {})) if (id in (next.counted || {})) per[id] = c.counted[id] + (ins[id] || 0) - next.counted[id];
    res.push({ before: c, after: next, sum: aggregate(per), bought: aggregate(ins) });
  });
  return res.reverse();
}
const partyName = (p) => { const n = (p.after || p.before).label.split(':').slice(1).join(':').trim() || p.before.label.split(':').slice(1).join(':').trim(); return n || 'Party'; };

async function loadStats() {
  const st = state.stats;
  st.loading = true; st.err = ''; render();
  try {
    st.data = await backend.fetchHistory(); st.sel = null;
    st.names = {};
    if (isAdmin()) {      // Admin: Geräte-ID → Name für den Verlauf
      try { (await backend.listMembers()).forEach(m => { st.names[m.uid] = m.name || 'Unbenannt'; }); } catch (e) { /* offline */ }
    }
  }
  catch (e) { console.error(e); st.err = 'Konnte Verlauf nicht laden: ' + (e.code || e.message); }
  st.loading = false; render();
}
function catBars(byCat) {
  const entries = Object.entries(byCat).filter(([, l]) => l > 0.001).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  const max = entries[0][1];
  return `<div class="cat-bars">${entries.map(([c, l]) => `<div class="cbar"><span>${esc(c)}</span><i style="width:${Math.max(4, l / max * 100)}%"></i><b>${fmt(l, 1)} L</b></div>`).join('')}</div>`;
}
function topRows(rows, max = 10) {
  const r = rows.filter(x => x.units > 1e-6).slice(0, max);
  if (!r.length) return '<p class="hint">Kein Verbrauch in diesem Zeitraum.</p>';
  return `<ol class="top-list">${r.map(x => `<li><span>${esc(title(x.it))}</span><small>${esc(qtyText(x.it, x.units))}</small><b>${x.liters ? fmt(x.liters, 1) + ' L' : ''}</b></li>`).join('')}</ol>`;
}
function renderStats(v) {
  const st = state.stats;
  if (!st.data && !st.loading && !st.err) { loadStats(); return; }
  const tabs = [['week', 'Woche'], ['month', 'Monat'], ['party', 'Partys'], ['log', 'Verlauf']];
  let html = `<div class="stats-head"><h2>Statistik <span class="beta">BETA</span></h2><button class="btn" type="button" id="statsReload">↻ Aktualisieren</button></div>
    <p class="hint beta-note">Beta – Werte bitte gegenprüfen. Verbrauch = Austragen + Fehlmengen aus Bestandsaufnahmen. Einkäufe zählen nicht.${st.data && st.data.fromCache ? ' <b>Offline: Stand vom letzten Sync.</b>' : ''}</p>
    <div class="seg">${tabs.map(([k, l]) => `<button type="button" data-st="${k}" class="${st.tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  if (st.loading) html += '<p class="empty">Lade Verlauf …</p>';
  else if (st.err) html += `<p class="err">${esc(st.err)}</p>`;
  else if (st.tab === 'week' || st.tab === 'month') html += statsPeriods(st.tab);
  else if (st.tab === 'party') html += statsParties();
  else html += statsLog();
  v.innerHTML = html;
  v.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { st.tab = b.dataset.st; st.sel = null; render(); });
  $('#statsReload').onclick = loadStats;
  v.querySelectorAll('[data-sel]').forEach(b => b.onclick = () => { st.sel = Number(b.dataset.sel); render(); });
}
function statsPeriods(kind) {
  const st = state.stats;
  const ev = consumptionEvents(st.data);
  const ps = periods(kind, kind === 'week' ? 8 : 6).map(p => ({ ...p, sum: sumEvents(ev, p.from, p.to) }));
  const sel = st.sel ?? ps.length - 1;
  const max = Math.max(1, ...ps.map(p => p.sum.liters));
  const all = sumEvents(ev, 0, Infinity);
  let h = `<div class="bars">${ps.map((p, i) => `<button type="button" class="bar ${i === sel ? 'sel' : ''}" data-sel="${i}">
      <b>${p.sum.liters >= 0.05 ? fmt(p.sum.liters, 0) : ''}</b><i style="height:${Math.max(2, p.sum.liters / max * 100)}%"></i><span>${p.label}</span></button>`).join('')}</div>`;
  const p = ps[sel];
  h += `<div class="stat-card"><div class="stat-title">${esc(p.long)}</div><div class="stat-big">${fmt(p.sum.liters, 1)} L</div>
    ${catBars(p.sum.byCat)}<h3 class="sub">Top-Artikel</h3>${topRows(p.sum.rows)}</div>
    <div class="stat-card"><div class="stat-title">Gesamt seit Beginn</div><div class="stat-big">${fmt(all.liters, 1)} L</div>${catBars(all.byCat)}
    <h3 class="sub">Top-Artikel gesamt</h3>${topRows(all.rows)}</div>`;
  return h;
}
function statsParties() {
  const list = partyList(state.stats.data);
  if (!list.length) return `<p class="empty">Noch keine Party-Auswertung.</p><p class="hint" style="text-align:center">Vor der Party unter Bestand → <b>📋 Zählen</b> mit „Vor Party“ zählen, danach mit „Nach Party“.</p>`;
  return list.map(p => p.open
    ? `<div class="stat-card"><div class="stat-title">${esc(partyName(p))} · ab ${dDate(p.before.clientTs)}</div><p class="hint">„Vor Party“ gezählt am ${dTime(p.before.clientTs)} – Zählung „Nach Party“ fehlt noch.</p></div>`
    : `<div class="stat-card"><div class="stat-title">${esc(partyName(p))} · ${dDate(p.before.clientTs)}–${dDate(p.after.clientTs)}</div>
       <div class="stat-big">${fmt(p.sum.liters, 1)} L</div>
       ${p.bought.rows.length ? `<p class="hint">Dazwischen eingekauft und eingerechnet: ${p.bought.rows.map(x => esc(plain(title(x.it))) + ' ' + esc(qtyText(x.it, x.units))).join(', ')}</p>` : ''}
       ${catBars(p.sum.byCat)}<h3 class="sub">Verbrauch</h3>${topRows(p.sum.rows, 50)}</div>`).join('');
}
function statsLog() {
  const data = state.stats.data;
  const admin = isAdmin();
  const byId = Object.fromEntries(data.bookings.map(b => [b.id, b]));
  const undone = new Set(data.bookings.filter(b => b.kind === 'undo' && b.ref).map(b => b.ref));
  const kindLabel = (b) => b.kind === 'out' ? 'Ausgetragen' : b.kind === 'in' ? 'Einkauf'
    : b.kind === 'undo' ? (byId[b.ref] && Math.abs(b.clientTs - byId[b.ref].clientTs) > 60000 ? 'Storno' : 'Rückgängig')
    : isInitBooking(b) ? 'Anfangsbestand' : b.session ? 'Bestandsaufnahme' : 'Inventur';
  const rows = [
    ...data.bookings.filter(b => getItem(b.itemId)).map(b => ({ ts: b.clientTs, b })),
    ...data.counts.map(c => ({ ts: c.clientTs, c }))
  ].sort((a, b) => b.ts - a.ts).slice(0, 150);
  if (!rows.length) return '<p class="empty">Noch keine Buchungen.</p>';
  const who = (x) => admin && x.by ? ` · <span class="who">${esc(state.stats.names?.[x.by] || 'unbekannt')}</span>` : '';
  const html = `${admin ? '<p class="hint">Admin: Namen sind nur für dich sichtbar. Fehlbuchungen mit <b>Storno</b> rückgängig machen – Storno ist selbst eine Buchung, nichts wird gelöscht.</p>' : ''}<div class="log">${rows.map(r => {
    if (r.c) {
      const can = admin && !r.c.canceled;
      return `<div class="log-row count ${r.c.canceled ? 'gone' : ''}"><small>${dTime(r.ts)}</small><span>📋 ${esc(r.c.label)}<em>${r.c.canceled ? 'storniert' : ''}${who(r.c)}</em></span>
        ${can ? `<button class="btn mini" type="button" data-storno-count="${esc(r.c.id)}">Storno</button>` : ''}</div>`;
    }
    const it = getItem(r.b.itemId), d = r.b.delta, gone = undone.has(r.b.id);
    const can = admin && !gone && r.b.kind !== 'undo' && !r.b.session;
    return `<div class="log-row ${gone ? 'gone' : ''}"><small>${dTime(r.ts)}</small><span>${esc(title(it))}<em>${kindLabel(r.b)}${gone ? ' · storniert' : ''}${who(r.b)}</em></span>
      <b class="${d < 0 ? 'neg' : 'pos'}">${d < 0 ? '−' : '+'}${esc(qtyText(it, Math.abs(d)))}</b>
      ${can ? `<button class="btn mini" type="button" data-storno="${esc(r.b.id)}">Storno</button>` : ''}</div>`;
  }).join('')}</div>`;
  setTimeout(() => {
    document.querySelectorAll('[data-storno]').forEach(btn => btn.onclick = () => {
      const b = byId[btn.dataset.storno], it = getItem(b.itemId);
      if (!confirm(`Buchung stornieren?\n${plain(title(it))}: ${b.delta < 0 ? '−' : '+'}${qtyText(it, Math.abs(b.delta))} (${dTime(b.clientTs)})`)) return;
      backend.book([{ itemId: b.itemId, delta: -b.delta, kind: 'undo', ref: b.id }]);
      showSnack('Storniert', null); setTimeout(loadStats, 600);
    });
    document.querySelectorAll('[data-storno-count]').forEach(btn => btn.onclick = () => {
      const c = data.counts.find(x => x.id === btn.dataset.stornoCount);
      const bs = data.bookings.filter(b => b.session === c.id && !undone.has(b.id));
      if (!confirm(`Bestandsaufnahme „${c.label}“ (${dTime(c.clientTs)}) stornieren?\n${bs.length} Korrektur(en) werden zurückgebucht.`)) return;
      if (bs.length) backend.book(bs.map(b => ({ itemId: b.itemId, delta: -b.delta, kind: 'undo', ref: b.id })));
      backend.cancelCount(c.id);
      showSnack('Bestandsaufnahme storniert', null); setTimeout(loadStats, 600);
    });
  }, 0);
  return html;
}

// ---------- Bon scannen (Lastenheft Rev. 7) ----------
// Schritt 1: Text des Bons holen (iPhone „Text scannen“ oder Live Text aus dem Foto kopieren)
// Schritt 2: Prüfseite – jede Zeile Artikel + Menge bestätigen/ändern, dann als Einkauf buchen
// Gelernte Zuordnungen (meta/aliases) gelten für alle Geräte.
function startScan() {
  state.scan = { step: 'input', text: '', rows: [], stamp: 1 };
  state.view = 'scan'; render(); window.scrollTo(0, 0);
}
function closeScan(msg) {
  state.scan = null; state.view = 'buy'; delete $('#view').dataset.buyKey; render(); window.scrollTo(0, 0);
  if (msg) showSnack(msg, null);
}
function renderScan(v) {
  const sc = state.scan;
  if (!sc) { state.view = 'buy'; return render(); }
  if (v.dataset.scan === String(sc.stamp)) return;          // Sync-Updates zerstören keine Eingaben
  v.dataset.scan = String(sc.stamp);
  if (sc.step === 'input') return renderScanInput(v);
  renderScanReview(v);
}
function renderScanInput(v) {
  const sc = state.scan;
  v.innerHTML = `<div class="count-head">
      <div class="count-top"><h2>Bon scannen</h2><button class="btn link" type="button" id="scanCancel">Abbrechen</button></div>
    </div>
    <textarea id="scanText" rows="9" placeholder="Hier kommt der Text vom Kassenbon rein …" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(sc.text)}</textarea>
    <div class="scan-btns">
      <button class="btn" type="button" id="scanPaste">📋 Einfügen</button>
      <button class="btn primary" type="button" id="scanGo">Auswerten</button>
    </div>
    <p class="err" id="scanErr"></p>
    <div class="stat-card scan-help">
      <div class="stat-title">So kommt der Text rein (iPhone)</div>
      <ol class="steps-list hint">
        <li><b>Foto (am besten bei langen Bons):</b> Bon flach hinlegen und fotografieren → Foto in der Fotos-App öffnen → unten rechts das <b>Text-Symbol</b> antippen → <b>Alle kopieren</b> → hier <b>📋 Einfügen</b>.</li>
        <li><b>Direkt scannen:</b> ins Textfeld tippen → nochmal tippen → <b>„Text scannen“</b> → Kamera auf den Bon halten → <b>Einsetzen</b>. Lange Bons in mehreren Stücken scannen, der Text wird angehängt.</li>
      </ol>
      <p class="hint">Android: Foto mit Google Lens öffnen → „Text“ → alles auswählen → kopieren. Nichts wird hochgeladen – die Auswertung läuft auf dem Handy.</p>
    </div>`;
  const ta = $('#scanText');
  ta.oninput = () => { sc.text = ta.value; };
  $('#scanCancel').onclick = () => closeScan();
  $('#scanPaste').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) throw new Error('leer');
      ta.value = (ta.value.trim() ? ta.value.trimEnd() + '\n' : '') + t; sc.text = ta.value;
      $('#scanErr').textContent = '';
    } catch (e) { $('#scanErr').textContent = 'Einfügen nicht möglich – lange ins Textfeld tippen und „Einsetzen“ wählen.'; }
  };
  $('#scanGo').onclick = () => {
    sc.text = ta.value;
    const rows = parseReceipt(sc.text, active(), state.aliases);
    if (!rows.length) { $('#scanErr').textContent = 'Keine Artikel im Text gefunden. Ist der ganze Bon drin?'; return; }
    sc.rows = rows.map((r, i) => {
      const it = r.itemId ? getItem(r.itemId) : null;
      return { ...r, n: i, include: !!it, auto: r.itemId, parts: suggestParts(r, it) };
    });
    sc.step = 'review'; sc.stamp++; render(); window.scrollTo(0, 0);
  };
}
function itemOptions(sel) {
  let h = `<option value="">– nicht übernehmen –</option>`;
  for (const [cat, its] of groupByCat(active())) {
    h += `<optgroup label="${esc(cat)}">` + its.map(i => `<option value="${esc(i.id)}" ${i.id === sel ? 'selected' : ''}>${esc(plain(title(i)))}</option>`).join('') + '</optgroup>';
  }
  return h;
}
function scanRowHtml(r) {
  const it = r.itemId ? getItem(r.itemId) : null;
  const q = it ? partsQty(it, r.parts) : 0;
  return `<div class="scan-row ${r.include && it ? '' : 'off'} ${r.conf === 'check' && r.itemId === r.auto ? 'chk-warn' : ''}" data-n="${r.n}">
    <div class="scan-top">
      <input type="checkbox" data-inc ${r.include && it ? 'checked' : ''} ${it ? '' : 'disabled'} aria-label="übernehmen">
      <select data-item>${itemOptions(r.itemId)}</select>
    </div>
    <small class="scan-raw">${r.manual ? 'von Hand hinzugefügt' : `Bon: „${esc(r.raw)}“`}${r.conf === 'check' && r.itemId === r.auto ? ' · <b class="warn">bitte prüfen</b>' : ''}</small>
    ${it ? `<div class="buy-steps">${qtySteppers(it, r.parts)}</div><small class="scan-sum">${q > 0 ? '+ ' + esc(qtyText(it, q)) + (isDrink(it) && it.sizeL ? ' = ' + fmt(q * it.sizeL) + ' L' : '') : 'Menge 0 – wird nicht gebucht'}</small>` : ''}
  </div>`;
}
function renderScanReview(v) {
  const sc = state.scan;
  const matched = sc.rows.filter(r => r.itemId), open = sc.rows.filter(r => !r.itemId);
  const nCheck = matched.filter(r => r.conf === 'check' && r.itemId === r.auto).length;
  v.innerHTML = `<div class="count-head">
      <div class="count-top"><h2>Bon prüfen</h2><button class="btn link" type="button" id="scanBack">← Text</button></div>
      <p class="hint">${matched.length} Artikel erkannt${nCheck ? `, davon <b class="warn">${nCheck} bitte prüfen</b>` : ''}. Artikel und Mengen kontrollieren, Häkchen weg = wird nicht gebucht.</p>
    </div>
    <div id="scanMatched">${matched.map(scanRowHtml).join('') || '<p class="hint">Nichts automatisch erkannt – unten zuordnen.</p>'}</div>
    <button class="btn" type="button" id="scanAdd">+ Artikel hinzufügen</button>
    ${open.length ? `<h2 class="cat">Nicht zugeordnet (${open.length})</h2><p class="hint">Gehört eine Zeile zu einem Artikel? Auswählen – die App merkt es sich für den nächsten Bon.</p>
      <div id="scanOpen">${open.map(scanRowHtml).join('')}</div>` : ''}
    <div class="buy-bar count-bar"><span id="scanSum"></span><button class="btn primary" type="button" id="scanBook">Einkauf buchen</button></div>`;
  v.querySelectorAll('.scan-row').forEach(el => {
    const r = sc.rows[Number(el.dataset.n)];
    el.querySelector('[data-item]').onchange = (e) => {
      r.itemId = e.target.value || null;
      r.include = !!r.itemId;
      const it = r.itemId ? getItem(r.itemId) : null;
      r.parts = r.manual ? { big: 0, small: 0, alt: {} } : suggestParts({ ...r, alias: r.alias && r.alias.id === r.itemId ? r.alias : null }, it);
      if (r.itemId && r.itemId !== r.auto) r.conf = 'user';
      sc.stamp++; render();
    };
    const cb = el.querySelector('[data-inc]');
    cb.onchange = () => { r.include = cb.checked; el.classList.toggle('off', !cb.checked); updateScanSum(); };
    const it = r.itemId ? getItem(r.itemId) : null;
    if (it) wireSteppers(el, () => {
      r.parts = readParts(el, it);
      const q = partsQty(it, r.parts);
      el.querySelector('.scan-sum').textContent = q > 0 ? '+ ' + plain(qtyText(it, q)) + (isDrink(it) && it.sizeL ? ' = ' + fmt(q * it.sizeL) + ' L' : '') : 'Menge 0 – wird nicht gebucht';
      updateScanSum();
    });
  });
  $('#scanBack').onclick = () => { sc.step = 'input'; sc.stamp++; render(); };
  $('#scanAdd').onclick = () => {
    sc.rows.push({ n: sc.rows.length, raw: '', key: '', manual: true, itemId: null, include: false, conf: 'user', qty: 1, parts: { big: 0, small: 0, alt: {} } });
    sc.stamp++; render();
    const last = [...document.querySelectorAll('.scan-row')].find(x => Number(x.dataset.n) === sc.rows.length - 1);
    last && last.querySelector('select').focus();
  };
  $('#scanBook').onclick = bookScan;
  updateScanSum();
}
function scanEntries() {
  const per = {};
  for (const r of state.scan.rows) {
    if (!r.include || !r.itemId) continue;
    const it = getItem(r.itemId); if (!it) continue;
    const q = partsQty(it, r.parts);
    if (q > 0) per[it.id] = r4((per[it.id] || 0) + q);
  }
  return Object.entries(per).map(([itemId, delta]) => ({ itemId, delta, kind: 'in' }));
}
function updateScanSum() {
  const e = scanEntries();
  const liters = e.reduce((a, x) => { const it = getItem(x.itemId); return a + (isDrink(it) && it.sizeL ? x.delta * it.sizeL : 0); }, 0);
  $('#scanSum').textContent = e.length ? `${e.length} Artikel${liters ? ' · ' + fmt(liters, 1) + ' L' : ''}` : 'Nichts ausgewählt';
  $('#scanBook').disabled = !e.length;
}
function bookScan() {
  const sc = state.scan, e = scanEntries();
  if (!e.length) return;
  // Lernen: Bon-Text → Artikel (+ Flaschen pro Bon-Einheit); abgewählte Vorschläge → künftig ignorieren
  const learn = {};
  for (const r of sc.rows) {
    if (r.manual || !r.key || r.key.length < 3) continue;
    const it = r.itemId ? getItem(r.itemId) : null;
    if (it && r.include) {
      const q = partsQty(it, r.parts);
      if (q > 0) learn[r.key] = { id: it.id, u: r4(q / (r.qty || 1)) };
    } else if (r.auto && (!r.include || !r.itemId)) learn[r.key] = { id: '-', u: 0 };
  }
  backend.saveAliases(learn);
  doBook(e, `Bon gebucht (${e.length} Artikel)`);
  state.scan = null; state.view = 'buy'; delete $('#view').dataset.buyKey; render(); window.scrollTo(0, 0);
}

// ---------- Einkaufsliste ----------
function saveChecked() { localStorage.setItem('bwz.shopChecked', JSON.stringify([...state.shopChecked])); }
function lowItems() { return active().filter(below); }

function renderList(v) {
  const low = lowItems();
  // Abhaken aufräumen: Artikel, die nicht mehr auf der Liste stehen, verlieren ihr Häkchen
  const lowIds = new Set(low.map(i => i.id));
  let dirty = false;
  for (const id of state.shopChecked) if (!lowIds.has(id)) { state.shopChecked.delete(id); dirty = true; }
  if (dirty) saveChecked();

  const noMin = active().filter(i => !(i.minStock > 0)).length;
  if (!low.length) {
    v.innerHTML = `<p class="empty">✓ Alles über Mindestbestand.</p>` +
      (noMin ? `<p class="hint" style="text-align:center">${noMin} Artikel haben noch keinen Mindestbestand.<br><button class="btn" type="button" id="goMin" style="margin-top:8px">Mindestbestände eintragen</button></p>` : '');
    if (noMin) $('#goMin').onclick = openMinBulk;
    return;
  }
  let html = `<div class="list-head"><span class="hint">${low.length} Artikel unter Mindestbestand</span>
    <button class="btn" type="button" id="shareList">Teilen</button></div>`;
  for (const [cat, its] of groupByCat(low)) {
    html += `<h2 class="cat">${esc(cat)}</h2>`;
    for (const it of its) {
      const on = state.shopChecked.has(it.id);
      html += `<button class="shop-row ${on ? 'on' : ''}" type="button" data-check="${esc(it.id)}">
        <span class="box">${on ? '✓' : ''}</span>
        <span class="shop-main"><span class="name">${esc(title(it))}</span>
          <small>Bestand ${esc(qtyText(it, Math.max(0, it.stock)))} · Min ${esc(qtyText(it, it.minStock))}</small></span>
        <b class="shop-qty">${esc(qtyText(it, suggestion(it)))}</b>
      </button>`;
    }
  }
  const n = low.filter(i => state.shopChecked.has(i.id)).length;
  html += `<p class="hint">Abhaken beim Einkaufen. Gekauft = Vorschlag? Dann unten buchen. Andere Mengen über <b>Einkauf</b> eintragen.</p>
    <div class="buy-bar"><span>${n ? `${n} abgehakt` : 'Nichts abgehakt'}</span>
    <button class="btn primary" type="button" id="listBook" ${n ? '' : 'disabled'}>Als Einkauf buchen</button></div>`;
  v.innerHTML = html;
  v.querySelectorAll('[data-check]').forEach(b => b.onclick = () => {
    const id = b.dataset.check;
    state.shopChecked.has(id) ? state.shopChecked.delete(id) : state.shopChecked.add(id);
    saveChecked(); render();
  });
  $('#listBook').onclick = () => {
    const entries = low.filter(i => state.shopChecked.has(i.id)).map(i => ({ itemId: i.id, delta: suggestion(i), kind: 'in' }));
    entries.forEach(e => state.shopChecked.delete(e.itemId)); saveChecked();
    doBook(entries, `Einkauf gebucht (${entries.length} Artikel)`);
  };
  $('#shareList').onclick = shareList;
}

function listText(items) {
  return items.map(i => `• ${plain(title(i))}: ${qtyText(i, suggestion(i))}`).join('\n');
}
async function shareList() {
  const text = 'Einkaufsliste Bauwagen\n' + listText(lowItems());
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); showSnack('Liste kopiert', null); }
  } catch (e) { /* Teilen abgebrochen */ }
}

// ---------- Mindestbestände schnell eintragen ----------
function openMinBulk() {
  const d = $('#sheet');
  delete d.dataset.item;
  let html = `<div class="sheet-head"><div><h3>Mindestbestände</h3><div class="sheet-stock">Fällt der Bestand darunter, kommt der Artikel auf die Einkaufsliste.</div></div>
    <button class="x" type="button" data-close>✕</button></div>`;
  for (const [cat, its] of groupByCat(active())) {
    html += `<h2 class="cat">${esc(cat)}</h2>`;
    for (const it of its) {
      const b = bigSize(it), m = it.minStock > 0 ? it.minStock : 0;
      html += `<div class="min-row" data-id="${esc(it.id)}"><div class="buy-name">${esc(title(it))}<small>Bestand ${esc(qtyText(it, Math.max(0, it.stock)))}</small></div>
        <div class="buy-steps">${b > 0 ? stepper('big', bigWord(it, 2), Math.floor(m / b)) : ''}${stepper('small', smallWord(it, 2), b > 0 ? m % b : m)}</div></div>`;
    }
  }
  html += `<div class="sheet-bar"><button class="btn primary big" type="button" id="minSave">Speichern</button></div>`;
  d.innerHTML = html;
  d.querySelectorAll('.min-row').forEach(r => wireSteppers(r, () => r.classList.add('has')));
  d.querySelector('[data-close]').onclick = () => d.close();
  $('#minSave').onclick = () => {
    let n = 0;
    d.querySelectorAll('.min-row').forEach(r => {
      const it = getItem(r.dataset.id); if (!it) return;
      const val = readStep(r, 'big') * bigSize(it) + readStep(r, 'small');
      if (val !== (it.minStock || 0)) { backend.saveItem({ minStock: val }, it.id); n++; }
    });
    d.close();
    showSnack(n ? `${n} Mindestbestände gespeichert` : 'Nichts geändert', null);
  };
  d.onclick = (e) => { if (e.target === d) d.close(); };
  if (!d.open) d.showModal();
}

// ---------- Push-Einstellungen ----------
function randomTopic() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  let r = ''; const buf = crypto.getRandomValues(new Uint8Array(10));
  for (const x of buf) r += a[x % a.length];
  return 'bauwagen-' + r;
}
// ---------- Einstellungen (⚙︎) ----------
function openSettings() {
  const d = $('#sheet');
  delete d.dataset.item;
  const admin = isAdmin();
  const days = helpDaysLeft();
  d.innerHTML = `<div class="form">
    <div class="sheet-head"><h3>Einstellungen</h3><button class="x" type="button" data-close>✕</button></div>

    <h4 class="set-h">Hilfe</h4>
    <label class="switch-row"><span>Erklärungen anzeigen<small>${helpMode() === 'auto' ? (days > 0 ? `automatisch noch ${days} Tag${days === 1 ? '' : 'e'}` : 'automatisch aus (4 Wochen vorbei)') : helpMode() === 'on' ? 'immer an' : 'aus'}</small></span>
      <input type="checkbox" id="setHelp" ${helpActive() ? 'checked' : ''}></label>
    <button class="btn" type="button" id="setTour">Kurze Einführung nochmal ansehen</button>
    <p class="hint">Probleme oder Beschwerden: bitte sofort bei <b>${ADMIN_CONTACT}</b> melden.</p>

    <h4 class="set-h">Dieses Handy</h4>
    <label>Dein Name (nur für den Admin sichtbar)<input id="setName" maxlength="30" value="${esc(state.me.name || '')}" placeholder="z. B. Max"></label>
    <p class="hint">Rolle: <b>${admin ? 'Admin' : 'Mitglied'}</b></p>

    ${admin ? `
    <h4 class="set-h">Admin</h4>
    <button class="btn" type="button" id="setPush">Push über ntfy ${state.settings.ntfyTopic ? '✓' : '⚠︎ nicht eingerichtet'}</button>
    <button class="btn" type="button" id="setDevices">Geräte verwalten</button>
    <p class="hint">Stornieren alter Buchungen: Statistik → Verlauf.</p>
    <details class="admin-re"><summary>Admin-Code neu eingeben</summary>
      <p class="hint">Nötig, wenn der Admin-Code in den Firestore-Regeln geändert wurde (Fehler „permission-denied“).</p>
      <div class="admin-row"><input id="setAdminCode" type="password" autocomplete="off" placeholder="Admin-Code"><button class="btn" type="button" id="setAdminGo">Übernehmen</button></div>
      <p class="err" id="setErr"></p></details>` : `
    <h4 class="set-h">Admin-Modus</h4>
    <div class="admin-row"><input id="setAdminCode" type="password" autocomplete="off" placeholder="Admin-Code"><button class="btn" type="button" id="setAdminGo">Aktivieren</button></div>
    <p class="err" id="setErr"></p>`}
  </div>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  $('#setHelp').onchange = (e) => {
    localStorage.setItem('bwz.help', e.target.checked ? 'on' : 'off');
    if (e.target.checked) localStorage.removeItem('bwz.hintsDone');
    render(); openSettings();
  };
  $('#setTour').onclick = () => { d.close(); startTour(); };
  $('#setName').onchange = (e) => {
    const n = e.target.value.trim();
    if (n.length < 2) { e.target.value = state.me.name || ''; showSnack('Name darf nicht leer sein', null); return; }
    backend.setDeviceName(n); showSnack('Name gespeichert', null);
  };
  if (admin) {
    $('#setPush').onclick = openPushSettings;
    $('#setDevices').onclick = openDevices;
  }
  {
    $('#setAdminGo').onclick = async () => {
      const btn = $('#setAdminGo'); btn.disabled = true;
      try { await backend.upgradeAdmin($('#setAdminCode').value); showSnack('Admin-Modus aktiv', null); openSettings(); }
      catch (e) { $('#setErr').textContent = e.message; btn.disabled = false; }
    };
  }
  d.onclick = (e) => { if (e.target === d) d.close(); };
  if (!d.open) d.showModal();
}

async function openDevices() {
  const d = $('#sheet');
  d.innerHTML = `<div class="sheet-head"><div><h3>Geräte</h3><div class="sheet-stock">Gesperrte Geräte können nichts mehr lesen oder buchen.</div></div><button class="x" type="button" data-close>✕</button></div><div id="devList"><p class="hint">Lade …</p></div>
    <p class="hint">Wer die App-Daten löscht, kann mit dem Gruppen-Code neu beitreten. Wirklich aussperren: zusätzlich den Gruppen-Code in den Firestore-Regeln ändern.</p>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  let list;
  try { list = await backend.listMembers(); }
  catch (e) {
    $('#devList').innerHTML = e.code === 'permission-denied'
      ? `<p class="err">Der Server erkennt dich nicht als Admin – dein gespeicherter Admin-Code passt nicht zu den Firestore-Regeln.</p><p class="hint">⚙︎ → „Admin-Code neu eingeben“ mit dem Code aus den Regeln.</p>`
      : `<p class="err">Geräteliste nicht ladbar (Internet?): ${esc(e.code || e.message)}</p>`;
    return;
  }
  list.sort((a, b) => (b.uid === state.me.uid) - (a.uid === state.me.uid) || (b.lastSeen - a.lastSeen));
  const draw = () => {
    $('#devList').innerHTML = list.map(m => `<div class="dev-row ${m.blocked ? 'blocked' : ''}">
      <div><span class="dev-name"><b>${esc(m.name || 'Unbenanntes Gerät')}</b>${m.role === 'admin' ? ' <span class="admin-chip">ADMIN</span>' : ''}${m.uid === state.me.uid ? ' <span class="badge-me">· dieses Handy</span>' : ''}</span>
      <small>beigetreten ${m.joinedAt ? dDate(m.joinedAt) : '–'} · zuletzt aktiv ${m.lastSeen ? ago(m.lastSeen) : 'unbekannt'}${m.blocked ? ' · <b>gesperrt</b>' : ''}</small></div>
      ${m.uid === state.me.uid ? '' : `<button class="btn ${m.blocked ? '' : 'danger'}" type="button" data-block="${esc(m.uid)}">${m.blocked ? 'Entsperren' : 'Sperren'}</button>`}
    </div>`).join('');
    $('#devList').querySelectorAll('[data-block]').forEach(btn => btn.onclick = async () => {
      const m = list.find(x => x.uid === btn.dataset.block);
      if (!m.blocked && !confirm(`„${m.name || 'Unbenanntes Gerät'}“ sperren?`)) return;
      btn.disabled = true;
      try { await backend.setBlocked(m.uid, !m.blocked); m.blocked = !m.blocked; draw(); }
      catch (e) { showError('Sperren fehlgeschlagen: ' + (e.code || e.message)); btn.disabled = false; }
    });
  };
  draw();
}

function openPushSettings() {
  const d = $('#sheet');
  delete d.dataset.item;
  const cur = state.settings.ntfyTopic || '';
  d.innerHTML = `<form class="form" id="setForm">
    <div class="sheet-head"><h3>Push über ntfy</h3><button class="x" type="button" data-close>✕</button></div>
    <p class="hint">Meldet sofort, wenn ein Artikel unter den Mindestbestand fällt, und einmal im Monat die ganze Einkaufsliste. Gilt für alle Handys der Gruppe.</p>
    <label>Kanalname (wie ein Passwort – nicht öffentlich posten)
      <input name="topic" value="${esc(cur)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="bauwagen-…"></label>
    <button class="btn" type="button" id="genTopic">Zufälligen Namen erzeugen</button>
    <ol class="hint steps-list">
      <li>Namen erzeugen → <b>Speichern</b></li>
      <li>ntfy-App öffnen → <b>+</b> → genau diesen Kanalnamen eintragen → Abonnieren</li>
      <li>Hier <b>Testnachricht</b> senden</li>
      <li>Kanalnamen an die anderen weitergeben (die abonnieren ihn in ihrer ntfy-App)</li>
    </ol>
    <p class="err" id="setErr"></p>
    <button class="btn primary big" type="submit">Speichern</button>
    <button class="btn" type="button" id="testPush" ${cur ? '' : 'disabled'}>Testnachricht senden</button>
  </form>`;
  const f = $('#setForm');
  f.querySelector('[data-close]').onclick = () => d.close();
  $('#genTopic').onclick = () => { f.topic.value = randomTopic(); };
  $('#testPush').onclick = async () => {
    const ok = await sendPush('Bauwagen: Test', 'Push funktioniert ✓', 'white_check_mark');
    showSnack(ok ? 'Testnachricht gesendet' : 'Senden fehlgeschlagen (Internet?)', null);
  };
  f.onsubmit = (ev) => {
    ev.preventDefault();
    const t = f.topic.value.trim();
    if (t && !/^[A-Za-z0-9_-]{6,64}$/.test(t)) { $('#setErr').textContent = 'Nur Buchstaben, Zahlen, - und _ (6–64 Zeichen).'; return; }
    backend.saveSettings({ ntfyTopic: t });
    state.settings = { ...state.settings, ntfyTopic: t };
    $('#testPush').disabled = !t;
    showSnack('Gespeichert', null);
  };
  d.onclick = (e) => { if (e.target === d) d.close(); };
  if (!d.open) d.showModal();
}

// Namensabfrage für bestehende Geräte ohne Namen (nicht wegklickbar)
function askName() {
  const d = $('#sheet');
  delete d.dataset.item;
  d.innerHTML = `<form class="form" id="nameForm">
    <h3 style="margin:0">Wie heißt du?</h3>
    <p class="hint">Damit der Admin sieht, wem welches Handy gehört und bei Fehlbuchungen nachfragen kann. Für die anderen bleibt alles anonym.</p>
    <input id="askName" maxlength="30" autocomplete="off" placeholder="Dein Name (z. B. Max)" required>
    <p class="err" id="askErr"></p>
    <button class="btn primary big" type="submit">Speichern</button></form>`;
  d.onclick = null;
  d.oncancel = (e) => e.preventDefault();          // Escape/Wischen schließt nicht
  $('#nameForm').onsubmit = (ev) => {
    ev.preventDefault();
    const n = $('#askName').value.trim();
    if (n.length < 2) { $('#askErr').textContent = 'Bitte mindestens 2 Zeichen.'; return; }
    backend.setDeviceName(n);
    state.me = { ...state.me, name: n };
    d.oncancel = null; d.close();
    showSnack('Danke!', null);
  };
  if (!d.open) d.showModal();
}

// ---------- Hilfe: Hinweiskarten + Einführung (4 Wochen ab Beitritt, pro Handy) ----------
const HELP_DAYS = 28;
const ADMIN_CONTACT = 'Felix Brenner';
const helpMode = () => localStorage.getItem('bwz.help') || 'auto';     // auto | on | off
function helpDaysLeft() {
  const j = Number(localStorage.getItem('bwz.joinedAt')) || Date.now();
  return Math.max(0, Math.ceil(HELP_DAYS - (Date.now() - j) / DAY));
}
function helpActive() {
  const m = helpMode();
  return m === 'on' || (m === 'auto' && helpDaysLeft() > 0);
}
const hintsDone = () => new Set(JSON.parse(localStorage.getItem('bwz.hintsDone') || '[]'));
function dismissHint(k) { const s = hintsDone(); s.add(k); localStorage.setItem('bwz.hintsDone', JSON.stringify([...s])); }
const HINTS = {
  stock: '<b>Bestand:</b> <b>−1</b> trägt eine Flasche aus. Artikel antippen für mehr: Menge, ganze Kästen, Einbuchen oder Inventur. Rot = unter Mindestbestand. <b>📋 Zählen</b> = Bestandsaufnahme aller Artikel.',
  buy: '<b>Einkauf:</b> Alles eintragen, was du gekauft hast – Kästen und einzelne Flaschen getrennt – und unten einmal <b>Einkauf buchen</b>.',
  list: '<b>Einkaufsliste:</b> Hier steht automatisch alles unter Mindestbestand, mit Mengenvorschlag. Beim Einkaufen abhaken, danach <b>Als Einkauf buchen</b>. <b>Teilen</b> schickt die Liste z. B. per WhatsApp.',
  items: '<b>Artikel:</b> Neue Artikel anlegen, Mindestbestände und Flaschengrößen festlegen. Artikel antippen zum Bearbeiten oder Archivieren.',
  stats: '<b>Statistik (Beta):</b> Verbrauch pro Woche, Monat und Party. Für die Party-Auswertung vor und nach der Party unter Bestand → 📋 Zählen mit „Vor Party“ bzw. „Nach Party“ zählen.',
  scan: '<b>Bon scannen:</b> Text vom Kassenbon ins Feld holen (Anleitung unten), dann <b>Auswerten</b>. Danach prüfst du jede Zeile, bevor gebucht wird. Was du einmal zuordnest, erkennt die App beim nächsten Bon automatisch.',
  count: '<b>Bestandsaufnahme:</b> Alles ist mit dem erwarteten Bestand vorausgefüllt. Nur ändern, was nicht stimmt: Feld antippen, gezählte Zahl tippen. Rechts siehst du die Abweichung. Zum Schluss <b>Speichern</b>.'
};
function hint(key) {
  if (!helpActive() || hintsDone().has(key) || !HINTS[key]) return '';
  return `<div class="hint-card"><span>${HINTS[key]}</span><button type="button" data-hint-close="${key}" aria-label="Hinweis schließen">✕</button></div>`;
}
function addHint(v, key) {
  const h = hint(key);
  if (h && !v.querySelector('.hint-card')) v.insertAdjacentHTML('afterbegin', h);
}

const TOUR = [
  ['🍺', 'Willkommen!', 'Mit der App zählt ihr gemeinsam Getränke und Material im Bauwagen. Für die anderen sind alle Buchungen anonym. Nur der Admin sieht, von welchem Handy eine Buchung kam – damit Fehlbuchungen geklärt werden können.'],
  ['➖', 'Austragen', 'Auf der Startseite trägt <b>−1</b> eine Flasche aus. Artikel antippen für größere Mengen oder ganze Kästen. Vertippt? Unten erscheint kurz <b>Rückgängig</b>.'],
  ['🛒', 'Einkaufen', 'Unter <b>Liste</b> steht automatisch, was fehlt. Was du gekauft hast, trägst du unter <b>Einkauf</b> ein – oder hakst es in der Liste ab und buchst es dort.'],
  ['📋', 'Vor und nach Partys zählen', 'Auf der Startseite <b>📋 Zählen</b>: alle Artikel auf einer Seite, nur Abweichungen ändern. Mit „Vor Party“ und „Nach Party“ rechnet die Statistik den Verbrauch der Party aus.'],
  ['📶', 'Funktioniert auch ohne Netz', 'Oben siehst du, ob alles synchron ist. Ohne Internet wird lokal gebucht und später automatisch übertragen. Erklärungen kannst du unter <b>⚙︎</b> ein- und ausschalten.'],
  ['📞', 'Probleme oder Beschwerden?', `Bitte sofort bei <b>${ADMIN_CONTACT}</b> melden – egal ob Fehlbuchung, falscher Bestand oder die App spinnt.`]
];
function startTour(step = 0) {
  const d = $('#sheet');
  delete d.dataset.item;
  const [icon, h, txt] = TOUR[step];
  const last = step === TOUR.length - 1;
  d.innerHTML = `<div class="tour">
    <div class="tour-icon">${icon}</div><h3>${h}</h3><p>${txt}</p>
    <div class="tour-dots">${TOUR.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('')}</div>
    <div class="tour-btns"><button class="btn link" type="button" id="tourSkip">${last ? '' : 'Überspringen'}</button>
      <button class="btn primary" type="button" id="tourNext">${last ? 'Los geht’s' : 'Weiter'}</button></div></div>`;
  const done = () => { localStorage.setItem('bwz.tourDone', '1'); d.close(); };
  $('#tourNext').onclick = () => last ? done() : startTour(step + 1);
  $('#tourSkip').onclick = done;
  d.onclick = null;
  if (!d.open) d.showModal();
}

// ---------- Push-Logik ----------
// Läuft auf jedem Handy, aber nur im Zustand "Synchron" (Bestand ist dann vom Server bestätigt).
// Wer meldet, entscheidet eine Firestore-Transaktion auf meta/alerts → jede Meldung geht genau einmal raus.
async function sendPush(titleText, body, tags) {
  const topic = state.settings.ntfyTopic;
  if (!topic) return false;
  if (DEMO) { backend.logPush({ topic, title: titleText, body }); showSnack('📣 ' + titleText, null); return true; }
  try {
    const url = `https://ntfy.sh/${encodeURIComponent(topic)}?title=${encodeURIComponent(titleText)}&tags=${encodeURIComponent(tags || '')}`;
    const res = await fetch(url, { method: 'POST', body });
    return res.ok;
  } catch (e) { console.warn('ntfy', e); return false; }
}

function monthKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

let alertTimer, alertBusy = false;
function scheduleAlerts() { clearTimeout(alertTimer); alertTimer = setTimeout(checkAlerts, 2500); }
async function checkAlerts() {
  if (alertBusy || !state.connected || !state.settings.ntfyTopic || !state.items.length) return;
  alertBusy = true;
  try {
    const lowIds = new Set(lowItems().map(i => i.id));
    const month = monthKey();
    const res = await backend.updateAlerts((cur) => {
      const alerted = { ...(cur.alerted || {}) };
      const newly = []; let changed = false, monthly = false;
      for (const id of lowIds) if (!alerted[id]) { alerted[id] = true; newly.push(id); changed = true; }
      for (const id of Object.keys(alerted)) if (!lowIds.has(id)) { delete alerted[id]; changed = true; }   // wieder aufgefüllt → darf erneut melden
      let lastMonthly = cur.lastMonthly;
      if (!lastMonthly) { lastMonthly = month; changed = true; }          // erster Lauf: Monatsmeldung ab nächstem Monat
      else if (lastMonthly !== month) { lastMonthly = month; monthly = true; changed = true; }
      if (!changed) return null;
      return { data: { alerted, lastMonthly }, result: { newly, monthly } };
    });
    if (!res) return;
    if (res.newly.length) {
      const its = res.newly.map(getItem).filter(Boolean);
      if (its.length === 1) {
        const it = its[0];
        await sendPush(`Bauwagen: ${plain(title(it))} unter Mindestbestand`,
          `Noch ${qtyText(it, Math.max(0, it.stock))} (Min ${qtyText(it, it.minStock)}).\nEinkaufen: ${qtyText(it, suggestion(it))}`, 'beer');
      } else if (its.length > 1) {
        await sendPush(`Bauwagen: ${its.length} Artikel unter Mindestbestand`, listText(its), 'beer');
      }
    }
    if (res.monthly) {
      const low = lowItems();
      const [y, m] = month.split('-');
      await sendPush(`Bauwagen: Einkaufsliste ${MONTHS[Number(m) - 1]} ${y}`,
        low.length ? listText(low) : 'Alles über Mindestbestand ✓', 'clipboard');
    }
  } catch (e) { console.warn('Push-Check', e); }
  finally { alertBusy = false; }
}

// ---------- Einmaliger Import (…/?import) ----------
async function showImport() {
  const { IMPORT_ITEMS } = await import('./import-data.js');
  const app = $('#app');
  app.innerHTML = `<main class="import"><h1>Artikel-Import</h1><p id="impStatus" class="hint">Lade aktuellen Bestand vom Server …</p><div id="impBody"></div></main>`;
  let phase = 'wait';          // wait → preview → sending → done
  let latest = { items: [], connected: false };
  const key = (n) => String(n).trim().toLowerCase();
  backend.subscribe((d) => {
    latest = d;
    if (phase === 'wait' && d.connected) { phase = 'preview'; renderPreview(); }
    if (phase === 'sending' && d.connected) { phase = 'done'; renderDone(); }
  }, (msg) => { $('#impStatus').textContent = msg; });

  function renderPreview() {
    const existing = new Map(latest.items.map(i => [key(i.name), i]));
    const listNames = new Set(IMPORT_ITEMS.map(i => key(i.name)));
    const toCreate = IMPORT_ITEMS.filter(i => !existing.has(key(i.name)));
    const skipped = IMPORT_ITEMS.filter(i => existing.has(key(i.name)));
    const others = latest.items.filter(i => !i.archived && !listNames.has(key(i.name)));
    let html = `<p class="hint">${toCreate.length} neue Artikel werden angelegt (Mindestbestand 0, später nachtragen).</p>`;
    for (const [cat, its] of groupByCat(toCreate)) {
      html += `<h2 class="cat">${esc(cat)}</h2>` + its.map(it =>
        `<div class="imp-row"><span>${esc(title(it))}</span><b>${esc(qtyText(it, it.stock))}</b></div>`).join('');
    }
    if (skipped.length) html += `<h2 class="cat">Schon vorhanden – wird übersprungen</h2><p class="hint">${skipped.map(i => esc(i.name)).join(', ')}</p>`;
    if (others.length) {
      html += `<h2 class="cat">Andere vorhandene Artikel</h2><p class="hint">Nicht in der Liste (z. B. Testartikel). Angehakte werden archiviert:</p>` +
        others.map(i => `<label class="imp-row chk"><input type="checkbox" data-arch="${esc(i.id)}" checked> ${esc(title(i))}</label>`).join('');
    }
    html += `<button class="btn primary big" id="impGo" ${toCreate.length || others.length ? '' : 'disabled'}>Importieren</button>
      <a class="btn link" href="./">Abbrechen</a>`;
    $('#impStatus').textContent = '';
    $('#impBody').innerHTML = html;
    $('#impGo').onclick = () => {
      $('#impGo').disabled = true;
      const entries = [];
      for (const it of toCreate) {
        const { stock, ...fields } = it;
        const id = backend.saveItem(fields, null);
        if (stock > 0) entries.push({ itemId: id, delta: stock, kind: 'correction', target: stock });
      }
      if (entries.length) backend.book(entries);
      document.querySelectorAll('[data-arch]:checked').forEach(c => backend.saveItem({ archived: true }, c.dataset.arch));
      phase = 'sending';
      $('#impBody').innerHTML = '';
      $('#impStatus').textContent = 'Übertrage zur Cloud … (Seite offen lassen)';
      if (latest.connected && !entries.length && !toCreate.length) { phase = 'done'; renderDone(); }
    };
  }
  function renderDone() {
    $('#impStatus').innerHTML = '';
    $('#impBody').innerHTML = `<div class="center-box" style="margin-top:20px"><p><b>✓ Import fertig und synchronisiert.</b></p>
      <p>Diese Seite kannst du schließen. Die App auf dem Homescreen zeigt die Artikel nach dem nächsten Öffnen.</p>
      <a class="btn primary big" href="./${DEMO ? '?demo' : ''}">Zur App</a></div>`;
  }
}

start();
