// Firebase-Backend: Anonymous Auth + Firestore mit Offline-Persistenz (IndexedDB)
// Prinzip: Bestand wird NIE absolut geschrieben, sondern per increment(delta) –
// damit lassen sich Offline-Buchungen mehrerer Handys konfliktfrei zusammenführen.
// Jede Buchung landet zusätzlich als Dokument in /bookings (Event-Log für Statistik/Verlauf).

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, signInAnonymously
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, query, where, orderBy, limit,
  writeBatch, increment, serverTimestamp, setDoc, updateDoc, getDocFromServer, runTransaction, getDocs
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { firebaseConfig } from './config.js';

export const name = 'firebase';
export const configured = !String(firebaseConfig.apiKey).includes('HIER_EINTRAGEN');

let app, auth, db;
let uid = null;

export async function init() {
  app = initializeApp(firebaseConfig);
  // initializeAuth ohne Popup/Redirect-Resolver → lädt keine Google-Iframes, startet auch offline
  auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
  await auth.authStateReady();          // stellt die gespeicherte anonyme Anmeldung wieder her (offline ok)
  uid = auth.currentUser ? auth.currentUser.uid : null;
  const joined = !!uid && localStorage.getItem('bwz.joined') === uid;
  return { joined };
}

// Ein Passwortfeld: Gruppen-Code → Mitglied, Admin-Code → Admin. Welcher Code gilt, entscheiden die Firestore-Regeln:
// erst als Admin versuchen, bei Ablehnung als Mitglied. Die App selbst kennt keinen der beiden Codes.
export async function join(code, deviceName) {
  if (!navigator.onLine) throw new Error('Zum ersten Beitreten wird Internet gebraucht.');
  code = code.trim();
  try {
    if (!auth.currentUser) await signInAnonymously(auth);
    uid = auth.currentUser.uid;
    const ref = doc(db, 'members', uid);
    let snap = null;
    try { snap = await getDocFromServer(ref); } catch (e) { /* noch kein Mitglied */ }
    if (snap && snap.exists()) {
      if (snap.data().blocked) throw new Error('Dieses Gerät wurde vom Admin gesperrt.');
    } else {
      const base = { code, joinedAt: serverTimestamp(), lastSeen: serverTimestamp(), name: String(deviceName || '').trim().slice(0, 30) };
      try { await setDoc(ref, { ...base, role: 'admin' }); }
      catch (e) {
        if (e.code !== 'permission-denied') throw e;
        await setDoc(ref, { ...base, role: 'member' });
      }
    }
    localStorage.setItem('bwz.joined', uid);
  } catch (e) {
    if (e instanceof Error && !e.code) throw e;
    if (e && e.code === 'permission-denied') throw new Error('Code falsch.');
    if (e && e.code === 'auth/admin-restricted-operation') throw new Error('Anonyme Anmeldung ist in Firebase nicht aktiviert.');
    if (e && e.code === 'auth/network-request-failed') throw new Error('Keine Verbindung zu Firebase.');
    throw new Error('Beitritt fehlgeschlagen: ' + (e && (e.code || e.message)));
  }
}

// ---------- Eigenes Gerät: Rolle, Name, zuletzt aktiv ----------
export function subscribeMe(cb) {
  if (!uid) return;
  onSnapshot(doc(db, 'members', uid), (s) => cb({ uid, ...(s.exists() ? s.data() : {}) }), (e) => console.warn(e));
}
export async function upgradeAdmin(code) {
  if (!navigator.onLine) throw new Error('Dafür wird Internet gebraucht.');
  try { await updateDoc(doc(db, 'members', uid), { code: code.trim(), role: 'admin' }); }
  catch (e) { throw new Error(e.code === 'permission-denied' ? 'Admin-Code falsch.' : 'Fehler: ' + (e.code || e.message)); }
}
export function setDeviceName(name) {
  updateDoc(doc(db, 'members', uid), { name: String(name || '').trim().slice(0, 30) }).catch(e => console.warn(e));
}
export function touchLastSeen() {
  const k = 'bwz.lastSeenPing', last = Number(localStorage.getItem(k)) || 0;
  if (Date.now() - last < 6 * 3600000) return;            // höchstens alle 6 h → spart Schreibvorgänge
  updateDoc(doc(db, 'members', uid), { lastSeen: serverTimestamp() })
    .then(() => localStorage.setItem(k, Date.now())).catch(() => {});
}

// ---------- Admin ----------
export async function listMembers() {
  const snap = await getDocs(collection(db, 'members'));
  return snap.docs.map(d => {
    const x = d.data();
    return { uid: d.id, name: x.name || '', role: x.role || 'member', blocked: !!x.blocked,
      joinedAt: x.joinedAt?.toMillis?.() || 0, lastSeen: x.lastSeen?.toMillis?.() || 0 };
  });
}
export async function setBlocked(memberUid, blocked) {
  await updateDoc(doc(db, 'members', memberUid), { blocked });
}
export function cancelCount(id) {
  updateDoc(doc(db, 'counts', id), { canceled: true })
    .catch(err => window.dispatchEvent(new CustomEvent('bwz-error', { detail: 'Storno abgelehnt: ' + (err.code || err.message) })));
}

// cb({ items, pending, connected }) wird bei jeder Änderung aufgerufen
export function subscribe(cb, onError) {
  let items = [], itemsFromCache = true, itemsPending = false;
  let pendingBookings = 0, bookingsFromCache = true;

  const emit = () => cb({
    items,
    pending: pendingBookings,
    connected: navigator.onLine && !itemsFromCache && !bookingsFromCache && !itemsPending && pendingBookings === 0
  });

  const handleErr = (e) => {
    console.error(e);
    if (e && e.code === 'permission-denied') {
      localStorage.removeItem('bwz.joined');
      onError && onError('Kein Zugriff (Gerät gesperrt oder Gruppen-Code geändert). App neu öffnen und Code eingeben.');
    } else onError && onError('Fehler: ' + (e && (e.code || e.message)));
  };

  onSnapshot(collection(db, 'items'), { includeMetadataChanges: true }, (snap) => {
    items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    itemsFromCache = snap.metadata.fromCache;
    itemsPending = snap.metadata.hasPendingWrites;
    emit();
  }, handleErr);

  // Letzte 14 Tage Buchungen – nur um ausstehende (noch nicht synchronisierte) Buchungen zu zählen
  const since = Date.now() - 14 * 86400000;
  const q = query(collection(db, 'bookings'), where('clientTs', '>=', since), orderBy('clientTs', 'desc'), limit(200));
  onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    pendingBookings = snap.docs.filter(d => d.metadata.hasPendingWrites).length;
    bookingsFromCache = snap.metadata.fromCache;
    emit();
  }, handleErr);

  window.addEventListener('online', emit);
  window.addEventListener('offline', emit);
}

// entries: [{ itemId, delta, kind, target?, ref? }] → gibt Buchungs-IDs zurück
// Wird NICHT awaited: offline wird lokal sofort gebucht, Sync passiert im Hintergrund.
export function book(entries) {
  const batch = writeBatch(db);
  const ids = [];
  const now = Date.now();
  for (const e of entries) {
    const bRef = doc(collection(db, 'bookings'));
    ids.push(bRef.id);
    const data = { itemId: e.itemId, delta: e.delta, kind: e.kind, clientTs: now, ts: serverTimestamp(), by: uid };   // by: Geräte-ID, Name sieht nur der Admin
    if (e.target !== undefined) data.target = e.target;
    if (e.ref !== undefined) data.ref = e.ref;
    batch.set(bRef, data);
    batch.update(doc(db, 'items', e.itemId), { stock: increment(e.delta), updatedAt: serverTimestamp() });
  }
  batch.commit().catch(err => {
    console.error('Buchung abgelehnt', err);
    window.dispatchEvent(new CustomEvent('bwz-error', { detail: 'Buchung vom Server abgelehnt: ' + (err.code || err.message) }));
  });
  return ids;
}

// Artikel anlegen (id leer) oder ändern. Bestand wird hier nie gesetzt.
export function saveItem(fields, id) {
  const clean = { ...fields };
  delete clean.stock; delete clean.id;
  if (id) {
    updateDoc(doc(db, 'items', id), { ...clean, updatedAt: serverTimestamp(), updatedBy: uid })
      .catch(err => window.dispatchEvent(new CustomEvent('bwz-error', { detail: 'Speichern abgelehnt: ' + (err.code || err.message) })));
    return id;
  }
  const ref = doc(collection(db, 'items'));
  setDoc(ref, { ...clean, stock: 0, archived: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: uid })
    .catch(err => window.dispatchEvent(new CustomEvent('bwz-error', { detail: 'Anlegen abgelehnt: ' + (err.code || err.message) })));
  return ref.id;
}

// ---------- Einstellungen (ntfy-Kanal) – liegt in Firestore, nicht im öffentlichen Repo ----------
export function subscribeSettings(cb) {
  onSnapshot(doc(db, 'meta', 'settings'), (snap) => cb(snap.exists() ? snap.data() : {}), (e) => console.error(e));
}
export function saveSettings(data) {
  setDoc(doc(db, 'meta', 'settings'), data, { merge: true })
    .catch(err => window.dispatchEvent(new CustomEvent('bwz-error', { detail: 'Einstellungen abgelehnt: ' + (err.code || err.message) })));
}

// ---------- Push-Zustand: Transaktion sorgt dafür, dass nur EIN Gerät eine Meldung "gewinnt" ----------
// mutator(aktuellerZustand) → null (nichts zu tun) oder { data: neuerZustand, result }
// Läuft nur online (Transaktionen brauchen den Server) – wird von der App nur im Zustand "Synchron" aufgerufen.
export async function updateAlerts(mutator) {
  return runTransaction(db, async (tx) => {
    const ref = doc(db, 'meta', 'alerts');
    const snap = await tx.get(ref);
    const res = mutator(snap.exists() ? snap.data() : {});
    if (!res) return null;
    tx.set(ref, res.data);
    return res.result;
  });
}

// ---------- Bestandsaufnahme: ein Zähl-Dokument + Korrekturbuchungen in EINEM Batch ----------
// counted: { itemId: gezählte Menge }  entries: [{ itemId, delta, target }]
export function saveCount(label, counted, entries) {
  const batch = writeBatch(db);
  const cRef = doc(collection(db, 'counts'));
  const now = Date.now();
  batch.set(cRef, { label, counted, clientTs: now, ts: serverTimestamp(), by: uid });
  for (const e of entries) {
    batch.set(doc(collection(db, 'bookings')), { itemId: e.itemId, delta: e.delta, kind: 'correction', target: e.target, session: cRef.id, clientTs: now, ts: serverTimestamp(), by: uid });
    batch.update(doc(db, 'items', e.itemId), { stock: increment(e.delta), updatedAt: serverTimestamp() });
  }
  batch.commit().catch(err => window.dispatchEvent(new CustomEvent('bwz-error', { detail: 'Bestandsaufnahme abgelehnt: ' + (err.code || err.message) })));
  return cRef.id;
}

// ---------- Statistik: komplette Historie laden (bei Netz vom Server, sonst aus dem lokalen Cache) ----------
export async function fetchHistory() {
  const [b, c] = await Promise.all([
    getDocs(query(collection(db, 'bookings'), orderBy('clientTs'))),
    getDocs(query(collection(db, 'counts'), orderBy('clientTs')))
  ]);
  return {
    bookings: b.docs.map(d => ({ id: d.id, ...d.data(), ts: undefined })),
    counts: c.docs.map(d => ({ id: d.id, ...d.data(), ts: undefined })),
    fromCache: b.metadata.fromCache
  };
}

// ---------- Gelernte Bon-Zuordnungen (für alle Geräte gemeinsam) ----------
// meta/aliases = { map: { "oett_pils": { id: <Artikel-ID oder "-">, u: Flaschen pro Bon-Einheit } } }
export function subscribeAliases(cb) {
  onSnapshot(doc(db, 'meta', 'aliases'), (snap) => cb((snap.exists() && snap.data().map) || {}), (e) => console.warn(e));
}
export function saveAliases(partial) {
  if (!Object.keys(partial).length) return;
  setDoc(doc(db, 'meta', 'aliases'), { map: partial }, { merge: true })
    .catch(err => console.warn('Zuordnungen nicht gespeichert', err));
}
