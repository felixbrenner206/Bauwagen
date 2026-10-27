// Einmaliger Import der Artikelliste (Stand 27.10.2026, Bestand in Flaschen).
// Mindest-/Sollbestand = 0 → werden später in der App nachgetragen.
const D = (name, category, sizeL, perCase, stock) =>
  ({ name, category, type: 'drink', sizeL, perCase, packSize: null, minStock: 0, targetStock: null, stock });

export const IMPORT_ITEMS = [
  // Bier – 0,5 L, 20 pro Kasten
  D('Nattheimer', 'Bier', 0.5, 20, 40),
  D('Öttinger', 'Bier', 0.5, 20, 60),
  // Softdrinks
  D('Schorle', 'Softdrinks', 0.5, 20, 20),
  D('Johannisbeere', 'Softdrinks', 0.5, 20, 20),
  D('Sprudel', 'Softdrinks', 0.5, null, 28),
  D('Süßer Sprudel', 'Softdrinks', 0.5, null, 20),
  D('Spezi', 'Softdrinks', 0.5, null, 22),
  D('Cola', 'Softdrinks', 1.0, null, 101),
  // Schnaps – 0,75 L
  D('Korn', 'Schnaps', 0.75, null, 5),
  D('Havanna', 'Schnaps', 0.75, null, 21),
  D('Lillet', 'Schnaps', 0.75, null, 9),
  D('Asbach', 'Schnaps', 0.75, null, 20),
  D('Vodka', 'Schnaps', 0.75, null, 35),
  D('Razz', 'Schnaps', 0.75, null, 16),
  D('Bacardi Tropical', 'Schnaps', 0.75, null, 3),
  D('Bacardi Braun', 'Schnaps', 0.75, null, 7),
  D('Bacardi', 'Schnaps', 0.75, null, 1),
  D('Jim Beam', 'Schnaps', 0.75, null, 12),
  D('Berentzen Apfel', 'Schnaps', 0.75, null, 12),
  D('Berentzen Sauer', 'Schnaps', 0.75, null, 2),
  D('Berentzen Waldfrucht', 'Schnaps', 0.75, null, 2),
  D('Joster', 'Schnaps', 0.75, null, 5),
  D('Aperol', 'Schnaps', 0.75, null, 4),
  D('Jack', 'Schnaps', 0.75, null, 1)
];
