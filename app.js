// Bauwagen-Zähler – Etappe 1+2: Bestand, Austragen, Einkauf, Inventur, Artikel, Offline-Sync, Einkaufsliste, Push (ntfy)
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

function qtyText(it, n) {
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
      <p>Gruppen-Code eingeben (einmalig pro Handy, braucht Internet).</p>
      <input id="joinCode" autocomplete="off" autocapitalize="off" placeholder="Gruppen-Code" required>
      <button class="btn primary big" type="submit">Beitreten</button>
      <p class="err" id="joinErr"></p>
    </form>`;
  $('#joinForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('#joinForm button'); btn.disabled = true; btn.textContent = 'Prüfe …';
    try { await backend.join($('#joinCode').value); next(); }
    catch (e) { $('#joinErr').textContent = e.message; btn.disabled = false; btn.textContent = 'Beitreten'; }
  };
}

function run() {
  $('#app').innerHTML = `
    <header class="top">
      <div class="title">Bauwagen</div>
      <button class="sync" id="sync" type="button"></button>
    </header>
    <div class="banner err" id="errBanner" hidden></div>
    <main id="view"></main>
    <nav class="tabs">
      <button data-view="stock">Bestand</button>
      <button data-view="buy">Einkauf</button>
      <button data-view="list">Liste<span class="tab-badge" id="listBadge" hidden></span></button>
      <button data-view="items">Artikel</button>
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
  document.body.classList.toggle('counting', state.view === 'count');
  const lowCount = active().filter(below).length;
  const badge = $('#listBadge');
  if (badge) { badge.hidden = !lowCount; badge.textContent = lowCount; }
  if (state.view === 'stock') renderStock(v);
  else if (state.view === 'buy') renderBuy(v);
  else if (state.view === 'list') renderList(v);
  else if (state.view === 'count') renderCount(v);
  else renderItems(v);
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
  const hasBig = bigSize(it) > 0;
  let html = '';
  if (sheetMode === 'inv') {
    const s = Math.max(0, it.stock), b = bigSize(it);
    const big = hasBig ? Math.floor(s / b) : 0, small = hasBig ? s % b : s;
    if (hasBig) html += stepper('big', `Volle ${bigWord(it, 2)} (à ${b})`, big);
    html += stepper('small', hasBig ? `Einzelne ${smallWord(it, 2)}` : smallWord(it, 2), small);
    $('#sheetHint').textContent = 'Tatsächlich gezählten Bestand eingeben. Wird als Korrekturbuchung gespeichert.';
  } else {
    if (hasBig) html += stepper('big', bigWord(it, 2) + ` (à ${bigSize(it)})`, 0);
    html += stepper('small', smallWord(it, 2), sheetMode === 'out' ? 1 : 0);
    $('#sheetHint').textContent = sheetMode === 'out' ? 'Menge, die rausgenommen wird.' : 'Menge, die dazukommt (z. B. Einkauf eines einzelnen Artikels).';
  }
  $('#steps').innerHTML = html;
  wireSteppers($('#steps'), updateSheetResult);
  $('#sheetGo').textContent = sheetMode === 'out' ? 'Austragen' : sheetMode === 'in' ? 'Einbuchen' : 'Bestand korrigieren';
  updateSheetResult();
}
function sheetQty() {
  const it = getItem($('#sheet').dataset.item);
  return readStep($('#steps'), 'big') * bigSize(it) + readStep($('#steps'), 'small');
}
function updateSheetResult() {
  const it = getItem($('#sheet').dataset.item); const r = $('#sheetResult'); if (!it || !r) return;
  const q = sheetQty();
  let delta = sheetMode === 'out' ? -q : sheetMode === 'in' ? q : q - it.stock;
  const after = it.stock + delta;
  r.innerHTML = sheetMode === 'inv'
    ? (delta === 0 ? 'Keine Abweichung.' : `Abweichung: <b>${delta > 0 ? '+' : ''}${delta} ${smallWord(it, Math.abs(delta))}</b>`)
    : (q === 0 ? 'Menge wählen.' : `${sheetMode === 'out' ? '−' : '+'}${esc(qtyText(it, q))} → danach ${esc(stockMain({ ...it, stock: after }))}`);
  $('#sheetGo').disabled = sheetMode === 'inv' ? delta === 0 : q === 0;
}
function submitSheet() {
  const id = $('#sheet').dataset.item; const it = getItem(id);
  const q = sheetQty();
  if (sheetMode === 'out') doBook([{ itemId: id, delta: -q, kind: 'out' }], `−${qtyText(it, q)} ${title(it)}`);
  else if (sheetMode === 'in') doBook([{ itemId: id, delta: q, kind: 'in' }], `+${qtyText(it, q)} ${title(it)}`);
  else doBook([{ itemId: id, delta: q - it.stock, kind: 'correction', target: q }], `Inventur ${title(it)}: ${qtyText(it, q)}`);
  $('#sheet').close();
}

// ---------- Einkauf ----------
function renderBuy(v) {
  const items = active();
  if (!items.length) { v.innerHTML = `<p class="empty">Noch keine Artikel.</p>`; return; }
  // Bei Sync-Updates nicht neu aufbauen (sonst springt die Eingabe) – nur Bestandstexte aktualisieren
  const key = items.map(i => i.id + bigSize(i) + title(i) + i.category).sort().join('|');
  if (v.dataset.buyKey === key && $('.buy-row', v)) {
    items.forEach(it => {
      const s = v.querySelector(`.buy-row[data-id="${it.id}"] .buy-stock`);
      if (s) s.innerHTML = `Bestand ${esc(stockMain(it))}${below(it) ? ' · <span class="lowtxt">unter Min.</span>' : ''}`;
    });
    return;
  }
  v.dataset.buyKey = key;
  let html = `<p class="hint pad">Eingekaufte Mengen eintragen, dann unten buchen.</p>`;
  for (const [cat, its] of groupByCat(items)) {
    html += `<h2 class="cat">${esc(cat)}</h2>`;
    for (const it of its) {
      const c = state.cart[it.id] || { big: 0, small: 0 };
      const hasBig = bigSize(it) > 0;
      html += `<div class="buy-row ${c.big || c.small ? 'has' : ''}" data-id="${esc(it.id)}">
        <div class="buy-name">${esc(title(it))}<small class="buy-stock">Bestand ${esc(stockMain(it))}${below(it) ? ' · <span class="lowtxt">unter Min.</span>' : ''}</small></div>
        <div class="buy-steps">
          ${hasBig ? stepper('big', bigWord(it, 2), c.big) : ''}
          ${stepper('small', smallWord(it, 2), c.small)}
        </div>
      </div>`;
    }
  }
  html += `<div class="buy-bar"><span id="buySum"></span><button class="btn primary" type="button" id="buyGo">Einkauf buchen</button></div>`;
  v.innerHTML = html;
  v.querySelectorAll('.buy-row').forEach(row => {
    wireSteppers(row, () => {
      const id = row.dataset.id;
      state.cart[id] = { big: readStep(row, 'big'), small: readStep(row, 'small') };
      row.classList.toggle('has', !!(state.cart[id].big || state.cart[id].small));
      updateBuySum();
    });
  });
  $('#buyGo').onclick = submitBuy;
  updateBuySum();
}
function cartEntries() {
  return Object.entries(state.cart).map(([id, c]) => {
    const it = getItem(id); if (!it || it.archived) return null;
    const q = c.big * bigSize(it) + c.small;
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
      <button class="btn" type="button" id="pushSet">Push ${state.settings.ntfyTopic ? '✓' : '⚠︎'}</button>
    </div>
    ${noMin ? `<p class="hint">${noMin} Artikel ohne Mindestbestand – die erscheinen nie auf der Einkaufsliste.</p>` : ''}
    <label class="chk" style="margin-top:10px"><input type="checkbox" id="showArch" ${state.showArchived ? 'checked' : ''}> Archivierte zeigen</label>`;
  if (!list.length) html += `<p class="empty">Keine Artikel.</p>`;
  for (const [cat, its] of groupByCat(list)) {
    html += `<h2 class="cat">${esc(cat)}</h2>`;
    for (const it of its) {
      const meta = isDrink(it)
        ? [it.sizeL ? `${fmt(it.sizeL, 3)} L/Fl.` : null, it.perCase ? `${it.perCase} Fl./Kasten` : null]
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
  $('#pushSet').onclick = openSettings;
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
      minStock: Math.round(num('minStock') ?? 0)
    };
    for (const k of ['sizeL', 'perCase', 'packSize', 'minStock']) {
      if (data[k] !== null && (!isFinite(data[k]) || data[k] < 0)) { $('#formErr').textContent = 'Ungültige Zahl.'; return; }
      if (data[k] === 0 && k !== 'minStock') data[k] = null;
    }
    if (!data.name) { $('#formErr').textContent = 'Name fehlt.'; return; }
    if (id) data.archived = !!it.archived;
    const newId = backend.saveItem(data, id);
    const init = id ? 0 : Math.max(0, Math.round(num('initial') || 0));
    if (init > 0) backend.book([{ itemId: newId, delta: init, kind: 'correction', target: init }]);
    d.close();
    showSnack(id ? 'Gespeichert' : 'Artikel angelegt', null);
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
  return v.big * bigSize(it) + v.small;
}
function devText(it, d) {
  if (d === 0) return '✓';
  const n = Math.abs(d), sign = d > 0 ? '+' : '−';
  return `${sign}${n} ${isDrink(it) ? 'Fl.' : 'St.'}`;
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
      const b = bigSize(it), exp = Math.max(0, it.stock);
      const big = b > 0 ? Math.floor(exp / b) : 0, small = b > 0 ? exp % b : exp;
      html += `<div class="count-row" data-id="${esc(it.id)}">
        <div class="count-name"><span>${esc(title(it))}</span><small class="count-exp">erwartet ${esc(qtyText(it, exp))}</small></div>
        <div class="count-inputs">
          ${b > 0 ? `<label>${bigWord(it, 2)}<input data-f="big" type="text" inputmode="numeric" pattern="[0-9]*" value="${big}"></label>` : ''}
          <label>${smallWord(it, 2)}<input data-f="small" type="text" inputmode="numeric" pattern="[0-9]*" value="${small}"></label>
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
      c.vals[row.dataset.id] = { big: big ? Number(big.value) || 0 : 0, small: Number(small.value) || 0 };
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
  return active().map(it => ({ it, total: countTotal(it), d: countTotal(it) - it.stock })).filter(x => x.d !== 0);
}
function updateCountDevs() {
  const v = $('#view');
  v.querySelectorAll('.count-row').forEach(row => {
    const it = getItem(row.dataset.id); if (!it) return;
    const d = countTotal(it) - it.stock;
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
function openSettings() {
  const d = $('#sheet');
  delete d.dataset.item;
  const cur = state.settings.ntfyTopic || '';
  d.innerHTML = `<form class="form" id="setForm">
    <div class="sheet-head"><h3>Push über ntfy</h3><button class="x" type="button" data-close>✕</button></div>
    <p class="hint">Meldet sofort, wenn ein Artikel unter den Mindestbestand fällt, und einmal im Monat die ganze Einkaufsliste. Gilt für alle Handys der Gruppe.</p>
    <label>Kanalname (wie ein Passwort – nicht öffentlich posten)
      <input name="topic" value="${esc(cur)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="bauwagen-…" pattern="[A-Za-z0-9_\\-]{6,64}"></label>
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
    render();
  };
  d.onclick = (e) => { if (e.target === d) d.close(); };
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
