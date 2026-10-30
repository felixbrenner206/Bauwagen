// Demo-/Test-Backend (Aufruf mit ?demo): speichert alles nur lokal im Browser.
// Simuliert Online/Offline: Tipp auf die Sync-Anzeige schaltet um.
// Buchungen bleiben offline "ausstehend" und werden beim Online-Schalten "synchronisiert".

export const name = 'demo';
export const configured = true;

const KEY = 'bwz.demo';
let s, listener, online = true;

function load() {
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { s = null; }
  if (!s) s = { items: [], bookings: [], queue: 0, joined: false };
}
function save() { localStorage.setItem(KEY, JSON.stringify(s)); }
function uid() { return Math.random().toString(36).slice(2, 12); }
function emit() {
  listener && listener({ items: s.items.map(i => ({ ...i })), pending: s.queue, connected: online && s.queue === 0 });
}
function scheduleFlush() {
  if (!online || s.queue === 0) return;
  setTimeout(() => { if (online) { s.queue = 0; save(); emit(); } }, 400);
}

export async function init() {
  load();
  if (s.items.length === 0 && !s.seeded) seed();
  online = localStorage.getItem('bwz.demo.online') !== '0';
  return { joined: s.joined };
}

export async function join(code, deviceName) {
  const c = code.trim().toLowerCase();
  if (!c || c === 'falsch') throw new Error('Code falsch.');
  s.joined = true;
  s.me = { uid: 'me', role: c === 'admin' ? 'admin' : 'member', name: deviceName || '' };
  save();
}
let meCb;
export function subscribeMe(cb) { meCb = cb; cb({ ...(s.me || { uid: 'me', role: 'member' }) }); }
export async function upgradeAdmin(code) {
  if (code.trim().toLowerCase() !== 'admin') throw new Error('Admin-Code falsch.');
  s.me = { ...(s.me || {}), role: 'admin' }; save(); meCb && meCb({ ...s.me });
}
export function setDeviceName(name) { s.me = { ...(s.me || {}), name }; save(); meCb && meCb({ ...s.me }); }
export function touchLastSeen() {}
export async function listMembers() {
  if (!s.members) s.members = [
    { uid: 'dev2', name: 'Max iPhone', role: 'member', blocked: false, joinedAt: Date.now() - 5 * 86400000, lastSeen: Date.now() - 3600000 },
    { uid: 'dev3', name: '', role: 'member', blocked: false, joinedAt: Date.now() - 2 * 86400000, lastSeen: Date.now() - 50 * 86400000 }
  ];
  return [{ uid: 'me', name: s.me?.name || '', role: s.me?.role || 'member', blocked: false, joinedAt: Date.now(), lastSeen: Date.now() }, ...s.members.map(m => ({ ...m }))];
}
export async function setBlocked(id, blocked) { const m = (s.members || []).find(x => x.uid === id); if (m) m.blocked = blocked; save(); }
export function cancelCount(id) { const c = (s.counts || []).find(x => x.id === id); if (c) c.canceled = true; save(); }

export function subscribe(cb) {
  listener = cb;
  emit();
  scheduleFlush();
}

export function setOnline(v) {
  online = v;
  localStorage.setItem('bwz.demo.online', v ? '1' : '0');
  emit(); scheduleFlush();
}
export function isOnline() { return online; }

export function book(entries) {
  const ids = [];
  const now = Date.now();
  for (const e of entries) {
    const it = s.items.find(i => i.id === e.itemId);
    if (!it) continue;
    it.stock += e.delta;
    const id = uid(); ids.push(id);
    s.bookings.push({ id, ...e, clientTs: now, by: 'me' });
    s.queue++;
  }
  save(); emit(); scheduleFlush();
  return ids;
}

export function saveItem(fields, id) {
  const clean = { ...fields }; delete clean.stock; delete clean.id;
  if (id) {
    const it = s.items.find(i => i.id === id);
    Object.assign(it, clean);
  } else {
    id = uid();
    s.items.push({ ...clean, id, stock: 0, archived: false });
  }
  s.queue++;
  save(); emit(); scheduleFlush();
  return id;
}

export function getBookings() { return s.bookings.slice(); }

export function saveCount(label, counted, entries) {
  const id = uid(), now = Date.now();
  s.counts = s.counts || [];
  s.counts.push({ id, label, counted, clientTs: now, by: 'me' });
  for (const e of entries) {
    const it = s.items.find(i => i.id === e.itemId); if (!it) continue;
    it.stock += e.delta;
    s.bookings.push({ id: uid(), itemId: e.itemId, delta: e.delta, kind: 'correction', target: e.target, session: id, clientTs: now, by: 'me' });
  }
  s.queue++;
  save(); emit(); scheduleFlush();
  return id;
}
export function getCounts() { return (s.counts || []).slice(); }
export async function fetchHistory() {
  return { bookings: s.bookings.slice().sort((a, b) => a.clientTs - b.clientTs), counts: (s.counts || []).slice(), fromCache: !online };
}

// Meta (Einstellungen + Push-Zustand) separat gespeichert, damit mehrere Tabs dieselben Werte sehen (Dedupe-Test)
const MKEY = 'bwz.demo.meta';
const readMeta = () => { try { return JSON.parse(localStorage.getItem(MKEY)) || { settings: {}, alerts: {} }; } catch (e) { return { settings: {}, alerts: {} }; } };
let settingsCb;
export function subscribeSettings(cb) { settingsCb = cb; cb(readMeta().settings); }
export function saveSettings(data) {
  const m = readMeta(); m.settings = { ...m.settings, ...data };
  localStorage.setItem(MKEY, JSON.stringify(m)); settingsCb && settingsCb(m.settings);
}
export async function updateAlerts(mutator) {
  if (!online) throw new Error('offline');
  const m = readMeta();
  const res = mutator(m.alerts || {});
  if (!res) return null;
  m.alerts = res.data; localStorage.setItem(MKEY, JSON.stringify(m));
  return res.result;
}
let aliasCb;
export function subscribeAliases(cb) { aliasCb = cb; cb(readMeta().aliases || {}); }
export function saveAliases(partial) {
  const m = readMeta(); m.aliases = { ...(m.aliases || {}), ...partial };
  localStorage.setItem(MKEY, JSON.stringify(m)); aliasCb && aliasCb(m.aliases);
}
export function logPush(msg) {
  const log = JSON.parse(localStorage.getItem('bwz.demo.pushlog') || '[]');
  log.push({ ...msg, ts: Date.now() }); localStorage.setItem('bwz.demo.pushlog', JSON.stringify(log));
}

function seed() {
  const mk = (o) => ({ id: uid(), archived: false, sizeL: null, perCase: null, packSize: null, targetStock: null, ...o });
  s.items = [
    mk({ name: 'Helles', category: 'Bier', type: 'drink', sizeL: 0.5, perCase: 20, minStock: 20, targetStock: 60, stock: 69 }),
    mk({ name: 'Radler', category: 'Bier', type: 'drink', sizeL: 0.5, perCase: 20, minStock: 10, targetStock: 40, stock: 7 }),
    mk({ name: 'Spezi', category: 'Softdrinks', type: 'drink', sizeL: 1.0, perCase: 12, minStock: 6, targetStock: 24, stock: 15 }),
    mk({ name: 'Wasser', category: 'Softdrinks', type: 'drink', sizeL: 0.7, perCase: 12, minStock: 6, targetStock: 24, stock: 30 }),
    mk({ name: 'Klopfer', category: 'Schnaps', type: 'drink', sizeL: 0.02, perCase: 25, minStock: 10, targetStock: 50, stock: 31 }),
    mk({ name: 'Becher', category: 'Verbrauchsmaterial', type: 'piece', packSize: 50, minStock: 50, targetStock: 200, stock: 120 }),
    mk({ name: 'Grillkohle', category: 'Verbrauchsmaterial', type: 'piece', minStock: 1, targetStock: 3, stock: 0 })
  ];
  s.seeded = true;
  save();
}
