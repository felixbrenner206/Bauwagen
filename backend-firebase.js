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
  writeBatch, increment, serverTimestamp, setDoc, updateDoc, getDocFromServer, runTransaction
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

export async function join(code) {
  if (!navigator.onLine) throw new Error('Zum ersten Beitreten wird Internet gebraucht.');
  try {
    if (!auth.currentUser) await signInAnonymously(auth);
    uid = auth.currentUser.uid;
    const ref = doc(db, 'members', uid);
    let exists = false;
    try { exists = (await getDocFromServer(ref)).exists(); } catch (e) { /* noch kein Mitglied → permission-denied ist normal */ }
    if (!exists) await setDoc(ref, { code: code.trim(), joinedAt: serverTimestamp() });
    localStorage.setItem('bwz.joined', uid);
  } catch (e) {
    if (e && e.code === 'permission-denied') throw new Error('Gruppen-Code falsch.');
    if (e && e.code === 'auth/admin-restricted-operation') throw new Error('Anonyme Anmeldung ist in Firebase nicht aktiviert.');
    if (e && e.code === 'auth/network-request-failed') throw new Error('Keine Verbindung zu Firebase.');
    throw new Error('Beitritt fehlgeschlagen: ' + (e && (e.code || e.message)));
  }
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
      onError && onError('Kein Zugriff mehr (Gruppen-Code?). Bitte neu beitreten.');
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
    const data = { itemId: e.itemId, delta: e.delta, kind: e.kind, clientTs: now, ts: serverTimestamp() };
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
    updateDoc(doc(db, 'items', id), { ...clean, updatedAt: serverTimestamp() })
      .catch(err => window.dispatchEvent(new CustomEvent('bwz-error', { detail: 'Speichern abgelehnt: ' + (err.code || err.message) })));
    return id;
  }
  const ref = doc(collection(db, 'items'));
  setDoc(ref, { ...clean, stock: 0, archived: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
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
