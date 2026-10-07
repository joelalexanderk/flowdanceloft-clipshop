// Show, Preise und freigegebene Nummern. Quelle: Line-up-Excel in «02 | The Space Between/02 | Produktion».
// Kaufbar ist eine Nummer erst, wenn sie hier steht UND ihre Datei im Bucket liegt (sonst «folgt»).
//
// Nummern, die hier fehlen, sind nicht freigegeben. clips.py lädt nur hoch, was hier steht.
// Welche das sind, steht in der Projektübersicht und bewusst nicht in diesem öffentlichen Repo.

export const SHOW = {
  jahr: '2026',                 // Präfix im Bucket: 2026/nr04.mp4
  kicker: 'Flow Dance Loft · Show 2026',
  name: 'The Space Between',
  titel: 'The Space', pointe: 'Between.',   // die zwei Zeilen des grossen Titels
  pauseNach: 16,
  onlineBis: '31.12.2027',
};

// Preise in Rappen: 1 Clip, 2 Clips und die ganze Show als ein Video (eigener Artikel).
export const PREIS_1 = 1000, PREIS_2 = 1500, PREIS_SHOW = 2500;

// Preis für n Clips: paarweise PREIS_2, ein übriger Clip PREIS_1. Also 10, 15, 25, 30 Franken.
// Die Offerte 27 nennt noch 15 und 25 (render_offerte_clipshop.py).
export const preis = n => Math.floor(n / 2) * PREIS_2 + (n % 2) * PREIS_1;

export const CLIPS = [
  { nr: 1,  titel: 'Space Between',               gruppe: 'Kindertanzen KIGA · Vanessa' },
  { nr: 3,  titel: 'Orbit',                       gruppe: 'Ballett 7. Kl. · Rüya' },
  { nr: 4,  titel: 'Clouds',                      gruppe: 'Jazz 5. Kl. · Nita' },
  { nr: 5,  titel: 'Little Alien',                gruppe: 'Jazz KIGA–3. Kl. · Nita' },
  { nr: 6,  titel: 'Voilà, c’est moi',            gruppe: 'Ballett 4. Kl. · Taryn' },
  { nr: 10, titel: 'Through Strawberry Fields',   gruppe: 'Ballett KIGA / 1. Kl. · Taryn' },
  { nr: 11, titel: 'Defying Gravity',             gruppe: 'Ballett 5.–7. Kl. · Taryn' },
  { nr: 13, titel: 'Vibration',                   gruppe: 'Jazz 9–14 J. · Taryn' },
  { nr: 14, titel: 'Jump!',                       gruppe: 'Hip Hop 6–11 J. · Musa' },
  { nr: 16, titel: 'Fever',                       gruppe: 'Teens Ballett · Taryn' },
  { nr: 17, titel: 'A Whole New World',           gruppe: 'Ballett 2./3. Kl. · Taryn' },
  { nr: 18, titel: 'Bridgerton',                  gruppe: 'Ballett KIGA–2. Kl. · Taryn' },   // Programmtitel noch zu klären
  { nr: 22, titel: 'Break the Beat',              gruppe: 'Breaking Minis/Midis · Bboy Cho' },
  { nr: 23, titel: 'Arcade',                      gruppe: 'Jazz · Nita' },
  { nr: 25, titel: 'Where Sunflowers Bloom',      gruppe: 'Ballett KIGA–1. Kl. · Taryn' },
  { nr: 26, titel: 'Rewrite the Stars',           gruppe: 'Ballett KIGA–6. Kl. · Taryn' },
  { nr: 27, titel: 'Who Am I',                    gruppe: 'Teens · Nita' },
  { nr: 28, titel: 'Me with You',                 gruppe: 'Adult Ballet · Rüya' },
  { nr: 29, titel: 'What Lies Between the Beats', gruppe: 'Breaking Boys 4.–7. Kl. · Bboy Cho' },
  { nr: 30, titel: 'Is It Love',                  gruppe: 'Jazz Kids/Teens · Taryn' },
  { nr: 31, titel: 'Breaking Boundaries',         gruppe: 'Breaking Fusion · Bboy Cho & Taryn' },
  { nr: 32, titel: 'Where Is My Husband!',        gruppe: 'Teens Jazz · Taryn' },
  { nr: 33, titel: 'What About Us',               gruppe: 'Finale · alle Gruppen' },
  { nr: 34, titel: 'I Gotta Feeling',             gruppe: 'Grand Finale · alle zusammen' },
];
