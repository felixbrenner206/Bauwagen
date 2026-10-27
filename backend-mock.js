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

export async function join(code) {
  if (!code.trim()) throw new Error('Gruppen-Code falsch.');
  if (code.trim().toLowerCase() === 'falsch') throw new Error('Gruppen-Code falsch.');
  s.joined = true; save();
}

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
    s.bookings.push({ id, ...e, clientTs: now });
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
