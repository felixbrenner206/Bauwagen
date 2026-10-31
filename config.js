// ============================================================
//  Firebase-Konfiguration (Projekt: getraenke-bauwagen)
//  Quelle: Firebase-Konsole → Projekteinstellungen → Meine Apps → Web-App "bauwagen"
//  Diese Werte sind NICHT geheim (stehen in jeder Firebase-Web-App öffentlich drin).
//  Geschützt werden die Daten durch die Firestore-Regeln.
// ============================================================
export const firebaseConfig = {
  apiKey: "AIzaSyBU2DkPGhR1WZ5luTljzrPZwsNoFbQ1FOo",
  authDomain: "getraenke-bauwagen.firebaseapp.com",
  projectId: "getraenke-bauwagen",
  storageBucket: "getraenke-bauwagen.firebasestorage.app",
  messagingSenderId: "920415377038",
  appId: "1:920415377038:web:5441f206266e683e3c5bdf"
};

// ============================================================
//  KI-Bonerkennung (Firebase AI Logic, Gemini) – Einrichtung siehe EINRICHTUNG.md, Abschnitt 6
//  Voraussetzung: Firebase-Tarif Blaze (in der EU ist die kostenlose Gemini-Stufe für Apps nicht erlaubt).
//  recaptchaKey: Schlüssel-ID von reCAPTCHA (für Firebase App Check). Leer = KI aus → nur Offline-Erkennung.
//  Auch dieser Schlüssel ist nicht geheim; geschützt wird über App Check + Domain-Beschränkung.
//  models: werden der Reihe nach probiert, falls ein Modellname nicht (mehr) existiert.
// ============================================================
export const aiConfig = {
  recaptchaKey: "",
  models: ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"]
};
