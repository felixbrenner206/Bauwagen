// Kassenbon-Auswertung (rein lokal, offline).
// Eingabe: Text des Bons (über iPhone „Text scannen“ / Live Text kopiert).
// Ausgabe: Zeilen mit Menge, Gebinde, Flaschengröße und Artikel-Vorschlag.
//
// Typischer deutscher Bon (Aldi/Lidl/Kaufland/Getränkemarkt):
//   OETTINGER PILS 20X0,5      9,99 A      ← Artikelzeile: Name … Preis Steuerklasse
//     2 x 9,99                             ← Mengenzeile: steht je nach Kette VOR oder NACH der Artikelzeile
//   PFAND 3,10                 6,20 A      ← Pfand: ignoriert
// Welche Artikelzeile zur Mengenzeile gehört, wird über die Rechnung entschieden (Menge × Einzelpreis = Zeilenpreis).

const UML = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss', 'é': 'e', 'è': 'e', 'á': 'a', 'à': 'a' };
export function normalize(s) {
  return String(s || '').toLowerCase().replace(/[äöüßéèáà]/g, c => UML[c]).replace(/[^a-z0-9,.]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const num = (s) => Number(String(s).replace(',', '.'));

// Zeilen, die nie Artikel sind
const IGNORE = /\b(zw\.?\s*summe|zwischensumme|summe|gesamt|total|zu zahlen|zahlbetrag|mwst|ust|netto|brutto|steuer|bar|rueckgeld|gegeben|wechselgeld|ec[- ]?karte|ec cash|girocard|maestro|visa|mastercard|kreditkarte|kartenzahlung|kontaktlos|terminal|beleg|bon ?nr|kasse|kassierer|bediener|filiale|markt ?nr|datum|uhrzeit|tse|signatur|seriennummer|transaktion|vielen dank|danke|einkauf|www|tel|telefon|steuernr|ust ?id|oeffnungszeiten|lidl plus|payback|coupon|gutschein|rabatt|preisvorteil|ersparnis|sie sparen|aktion|kundenkarte|punkte|genehmigung|autorisierung|trace|kopie|haendlerbeleg|kundenbeleg|betrag|eur ?\/ ?kg)\b/;
const PFAND = /\b(pfand|leergut|einweg ?pfand|mehrweg ?pfand|pfd|pf\.)\b/;
const PRICE_END = /(-?\d{1,4}[,.]\d{2})\s*(?:€|eur)?\s*(?:[ab12*]|aw)?\s*$/i;
const MULT_ONLY = /^\s*(\d{1,3})\s*(?:stk\.?|st\.?)?\s*[x×*]\s*(\d{1,4}[,.]\d{2})\s*(?:€|eur)?\s*$/i;
const MULT_INLINE = /(?:^|\s)(\d{1,3})\s*(?:stk\.?|st\.?)?\s*[x×*]\s+(\d{1,4}[,.]\d{2})(?=\s)/i;
const LEAD_QTY = /^\s*(\d{1,3})\s*(?:[x×*]|stk\.?|st\.?)\s+(?=[a-zäöü])/i;
const LEAD_NUM = /^\s*([1-9]\d?)\s+(?=[a-zäöü]{3,})/i;                 // Getränkemarkt: „2 Oettinger Pils …“
const PACK = /(\d{1,2})\s*[x×]\s*(\d(?:[,.]\d{1,3})?)\s*(?:l|ltr|liter)\b|(\d{1,2})[x×](\d[,.]\d{1,3})(?![\d,.])/i;
const PACK_ER = /\b(\d{1,2})\s*er\b/i;                                  // „6er“, „20er“
const SIZE = /(\d(?:[,.]\d{1,3})?)\s*(?:l|ltr|liter)\b|(\d{2,4})\s*ml\b/i;
const CASE = /\b(kasten|kiste|kst|kas|ka|ki|ktn)\b/i;
const LETTERS = /[a-zäöü]{2,}/i;

// Ähnlichkeit 0..1 (Levenshtein-Verhältnis)
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function tokSim(a, b) {
  if (a === b) return 1;
  const short = a.length < b.length ? a : b, long = a.length < b.length ? b : a;
  if (short.length >= 3 && long.startsWith(short)) return 0.9;          // Abkürzung: „oett“ → „oettinger“
  if (short.length >= 4 && long.includes(short)) return 0.8;
  return Math.max(0, 1 - lev(a, b) / Math.max(a.length, b.length));
}
const STOP = new Set(['der', 'die', 'das', 'und', 'mit', 'fl', 'flasche', 'flaschen', 'dose', 'pet', 'glas', 'mw', 'ew', 'mehrweg', 'einweg', 'st', 'stk', 'stueck', 'je', 'ca', 'l', 'ml', 'ltr', 'liter', 'kasten', 'kiste', 'kst', 'ka', 'ki', 'er', 'x', 'vol']);
const tokens = (s) => normalize(s).replace(/[\d,.]+/g, ' ').split(' ').filter(t => t.length >= 2 && !STOP.has(t));

// Schlüssel für gelernte Zuordnungen: Name ohne Zahlen/Einheiten, z. B. „oett pils“
export function aliasKey(name) { return tokens(name).join('_').slice(0, 60); }

export function scoreItem(lineToks, item) {
  const itoks = tokens(item.name);
  if (!itoks.length || !lineToks.length) return 0;
  // jedes Wort des Artikelnamens muss irgendwo im Bon-Text vorkommen
  let sum = 0;
  for (const it of itoks) sum += Math.max(...lineToks.map(lt => tokSim(lt, it)));
  let s = sum / itoks.length;
  // Zusatzwörter im Bon (z. B. „Pils“) stören kaum; zu viele fremde Wörter etwas abwerten
  const extra = lineToks.filter(lt => !itoks.some(it => tokSim(lt, it) >= 0.8)).length;
  s -= Math.min(0.15, extra * 0.03);
  return Math.max(0, Math.min(1, s));
}

// Beste Artikel für eine Zeile: [{ item, score, rank }] absteigend.
// score = wie gut der Artikelname im Bon-Text steckt (für sicher/prüfen).
// rank  = score + Anteil des Bon-Texts, den der Artikel erklärt – lange, seltene Wörter zählen mehr
//         („Johannisbeer“ schlägt „Schorle“, „Razz“ schlägt „Bacardi“, weil Bacardi in 3 Artikeln vorkommt).
export function matchItems(name, items, aliases = {}) {
  const key = aliasKey(name);
  const al = aliases[key];
  if (al && al.id === '-') return [];                                       // gelernt: diese Bon-Zeile nie übernehmen
  if (al && items.some(i => i.id === al.id)) return [{ item: items.find(i => i.id === al.id), score: 1, rank: 2, alias: al }];
  const lt = tokens(name);
  if (!lt.length) return [];
  const itemToks = items.map(i => tokens(i.name));
  const weight = lt.map(t => {
    const df = itemToks.filter(toks => toks.some(x => tokSim(t, x) >= 0.8)).length;
    return t.length / Math.max(1, df);
  });
  const wsum = weight.reduce((a, b) => a + b, 0) || 1;
  return items.map((item, k) => {
    const score = scoreItem(lt, item);
    const explained = lt.reduce((a, t, j) => a + (itemToks[k].some(x => tokSim(t, x) >= 0.8) ? weight[j] : 0), 0) / wsum;
    return { item, score, rank: score + 0.5 * explained };
  }).filter(x => x.score > 0.3).sort((a, b) => b.rank - a.rank).slice(0, 4);
}

function parseLine(raw) {
  const line = raw.replace(/\s+/g, ' ').trim();
  const n = normalize(line);
  if (!n) return null;
  let m;
  if ((m = line.match(MULT_ONLY))) return { type: 'mult', raw, n: Number(m[1]), unit: num(m[2]) };
  const isPfand = PFAND.test(n);
  let rest = line, total = null, qty = null, unit = null;
  if ((m = rest.match(PRICE_END))) { total = num(m[1]); rest = rest.slice(0, m.index); }
  if ((m = rest.match(MULT_INLINE))) { qty = Number(m[1]); unit = num(m[2]); rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length); }
  if (qty == null && (m = rest.match(LEAD_QTY))) { qty = Number(m[1]); rest = rest.slice(m[0].length); }
  if (qty == null && total != null && (m = rest.match(LEAD_NUM)) && !/^\d+\s*(er|x|l|ml)\b/i.test(rest.trim().slice(m[1].length).trim())) {
    qty = Number(m[1]); rest = rest.slice(m[0].length);
  }
  if (isPfand) return { type: 'pfand', raw, total };
  if (!LETTERS.test(rest)) return null;
  if (IGNORE.test(normalize(rest))) return { type: 'ignore', raw, total };
  let pack = null, packSize = null, size = null;
  if ((m = rest.match(PACK))) { pack = Number(m[1] || m[3]); packSize = num(m[2] || m[4]); }
  else if ((m = rest.match(PACK_ER))) pack = Number(m[1]);
  if ((m = rest.match(SIZE))) size = m[1] ? num(m[1]) : Number(m[2]) / 1000;
  if (packSize) size = packSize;
  if (size && (size <= 0 || size > 10)) size = null;
  const isCase = CASE.test(normalize(rest));
  const name = rest.replace(PACK, ' ').replace(PACK_ER, ' ').replace(SIZE, ' ').replace(/\s+/g, ' ').trim();
  return { type: 'item', raw, name, total, qty, unit, pack, size, isCase };
}

// Hauptfunktion: Text → Liste von Positionen
// items: aktive Artikel der App; aliases: gelernte Zuordnungen { key: { id, u } }
export function parseReceipt(text, items, aliases = {}) {
  const parsed = String(text || '').split(/\r?\n/).map(parseLine).filter(Boolean);
  // Mengenzeilen zuordnen (vorher oder nachher, per Rechnung)
  const priced = (p) => p && (p.type === 'item' || p.type === 'pfand') && p.total != null;
  parsed.forEach((p, i) => {
    if (p.type !== 'mult') return;
    const cands = [parsed[i - 1], parsed[i + 1]].filter(priced);
    const fit = cands.find(c => Math.abs(c.total - p.n * p.unit) < 0.03) || (priced(parsed[i - 1]) && parsed[i - 1].qty == null ? parsed[i - 1] : null);
    if (fit && fit.qty == null) { fit.qty = p.n; fit.unit = p.unit; }
  });
  const out = [];
  for (const p of parsed) {
    if (p.type !== 'item') continue;
    const qty = p.qty || (p.unit && p.total ? Math.max(1, Math.round(p.total / p.unit)) : 1);
    const matches = matchItems(p.name, items, aliases);
    const best = matches[0];
    let conf = best ? (best.score >= 0.85 ? 'sure' : best.score >= 0.6 ? 'check' : 'none') : 'none';
    // knapp hinter dem Besten ein zweiter plausibler Artikel → lieber nachfragen
    if (conf === 'sure' && !best.alias && matches[1] && matches[1].score >= 0.6 && best.rank - matches[1].rank < 0.08) conf = 'check';
    // Zeilen ohne Preis (Ladenname, Adresse …) nur zeigen, wenn sie zu einem Artikel passen
    if (p.total == null && conf === 'none') continue;
    out.push({
      raw: p.raw.trim(), name: p.name, key: aliasKey(p.name), qty, pack: p.pack, size: p.size, isCase: p.isCase, total: p.total,
      itemId: conf === 'none' ? null : best.item.id, conf, alias: best && best.alias, alts: matches.map(x => x.item.id)
    });
  }
  return out;
}

// Vorschlag für die Eingabefelder: { big, small, alt: { Größe: Anzahl } } in den Einheiten des Artikels
export function suggestParts(line, item) {
  const parts = { big: 0, small: 0, alt: {} };
  if (!item) return parts;
  const isDrink = item.type === 'drink', std = Number(item.sizeL) || 0;
  const per = isDrink ? Number(item.perCase) || 0 : Number(item.packSize) || 0;
  const alts = (Array.isArray(item.altSizes) ? item.altSizes : []).filter(a => a > 0);
  const q = line.qty || 1;
  // gelernt: Flaschen pro Bon-Einheit
  if (line.alias && line.alias.id === item.id && line.alias.u > 0) {
    const b = Math.round(q * line.alias.u);
    if (per > 0) { parts.big = Math.floor(b / per); parts.small = b % per; } else parts.small = b;
    return parts;
  }
  const unitsPerLine = line.pack || (line.isCase && per ? per : 1);
  const count = q * unitsPerLine;
  if (isDrink && std && line.size && Math.abs(line.size - std) > 0.001) {
    const alt = alts.find(a => Math.abs(a - line.size) < 0.001);
    if (alt) { parts.alt[alt] = count; return parts; }
    const b = Math.round(count * line.size / std);                       // unbekannte Größe → in Standardflaschen umrechnen
    if (per > 0) { parts.big = Math.floor(b / per); parts.small = b % per; } else parts.small = b;
    return parts;
  }
  if (per > 0) { parts.big = Math.floor(count / per); parts.small = count % per; } else parts.small = count;
  return parts;
}
