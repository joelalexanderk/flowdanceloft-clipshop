// Selbsttest für den Geld- und Zugangspfad, ohne Netz: node check.mjs
// D1 läuft über node:sqlite, R2 ist eine Map, Payrexx und Resend sind Stubs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';
import { preis, PREIS_SHOW } from './clips.js';

assert.deepEqual([1, 2, 3, 4].map(preis), [1000, 1500, 2500, 3000]);
assert.equal(PREIS_SHOW, 2500);   // die ganze Show als ein Video, eigener Artikel

// ---------- Stubs ----------

function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      let args = [];
      const st = {
        bind: (...a) => (args = a, st),
        first: async () => db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
      };
      return st;
    },
    batch: sts => Promise.all(sts.map(s => s.run())),
  };
}

const film = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
const dateien = new Map(['04', '11', '14'].flatMap(n => [[`2026/nr${n}.mp4`, film], [`2026/nr${n}.jpg`, film]]));
dateien.set('2026/show.mp4', film).set('2026/hero.jpg', film);   // die ganze Show und das Finale-Bild
const CLIPS = {   // Nr. 13 steht in clips.js, hat aber keine Datei
  list: async ({ prefix }) => ({ objects: [...dateien.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }),
  get: async (k, { range } = {}) => {
    const b = dateien.get(k);
    if (!b) return null;
    const von = range ? range.suffix ? b.length - range.suffix : range.offset : 0;
    if (von >= b.length || range?.length <= 0) throw new RangeError('range');
    return { body: b.slice(von, range?.length ? von + range.length : undefined), size: b.length, httpEtag: '"e"' };
  },
};

const gesendet = { payrexx: [], mails: [] };
const gwStatus = new Map();
let gwId = 100;
globalThis.fetch = async (url, init = {}) => {
  url = new URL(url);
  const json = d => new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } });
  if (url.host === 'api.resend.com') { gesendet.mails.push(JSON.parse(init.body)); return json({ id: 'm' }); }
  assert.equal(url.host, 'api.payrexx.com');
  assert.equal(init.headers['X-API-KEY'], 'geheim');
  assert.equal(url.searchParams.get('instance'), 'flowdance');
  if (init.method === 'POST') {
    assert.equal(url.pathname, '/v1.0/Gateway/');
    const id = ++gwId;
    gesendet.payrexx.push(Object.fromEntries(new URLSearchParams(init.body)));
    gwStatus.set(String(id), 'waiting');
    return json({ status: 'success', data: [{ id, status: 'waiting', link: `https://flowdance.payrexx.com/?payment=${id}` }] });
  }
  const id = /^\/v1\.0\/Gateway\/(\d+)\/$/.exec(url.pathname)[1];
  return json({ status: 'success', data: [{ id: +id, status: gwStatus.get(id) }] });
};

const HOST = 'https://flowdance.seismos.ch';
const env = { DB: d1(), CLIPS, PAYREXX_API_KEY: 'geheim', PAYREXX_INSTANCE: 'flowdance', RESEND_API_KEY: 'r', ADMIN_PASSWORD: 'pw' };
const call = (pfad, { form, json, headers = {}, e = env, host = HOST } = {}) => worker.fetch(new Request(host + pfad, {
  method: form || json ? 'POST' : 'GET', headers,
  body: form ? new URLSearchParams(form) : json ? JSON.stringify(json) : undefined,
}), e);
const tokenAus = r => /k=([0-9a-f-]{36})/.exec(r.headers.get('set-cookie'))[1];

// ---------- Erster Kauf: zwei Clips, Betrag vom Server ----------

let r = await call('/buy', { form: [['clip', '4'], ['clip', '11'], ['clip', '13'], ['clip', '99'], ['email', ' Familie@Beispiel.ch '], ['amount', '1']] });
assert.equal(r.status, 303);
assert.equal(r.headers.get('location'), 'https://flowdance.payrexx.com/?payment=101');
const t = tokenAus(r);
assert.equal(gesendet.payrexx.length, 1);
assert.equal(gesendet.payrexx[0].amount, '1500');           // zwei Clips. Nr. 13 (keine Datei) und Nr. 99 (gibt es nicht) fallen weg
assert.equal(gesendet.payrexx[0].currency, 'CHF');
assert.equal(gesendet.payrexx[0].purpose, 'Flow Dance Loft Clips · Nr. 4, Nr. 11');
assert.equal(gesendet.payrexx[0].referenceId, t);
assert.equal(gesendet.payrexx[0]['fields[email][value]'], 'familie@beispiel.ch');
assert.equal(gesendet.payrexx[0].successRedirectUrl, `${HOST}/k/${t}?z=1`);

// ---------- Solange die Zahlung offen ist: nichts ----------

assert.equal((await call(`/k/${t}/v/4`)).status, 403);
r = await call(`/k/${t}?z=1`);
assert.equal(r.status, 200);
let html = await r.text();
assert.ok(!html.includes('<video') && html.includes('Zahlung wird geprüft'));
assert.equal(gesendet.mails.length, 0);

// ---------- Bestätigt: Webhook und Seitenaufruf zusammen verschicken genau eine Mail ----------

gwStatus.set('101', 'confirmed');
const meldung = { json: { transaction: { referenceId: t, status: 'confirmed' } } };
// gleichzeitig: Alle drei sehen die Zahlung noch als offen, nur der erste UPDATE darf die Mail auslösen
const gleichzeitig = await Promise.all([call('/webhook', meldung), call(`/k/${t}?z=1`), call('/webhook', meldung)]);
assert.deepEqual(gleichzeitig.map(x => x.status), [200, 200, 200]);
assert.equal((await call('/webhook', meldung)).status, 200);   // Wiederholung von Payrexx
html = await (await call(`/k/${t}?z=1`)).text();
assert.ok(html.includes('Zahlung erhalten') && html.includes(`/k/${t}/v/4"`) && html.includes(`/k/${t}/v/11"`));
assert.ok(!html.includes(`/k/${t}/v/0"`) && html.includes('value="0"'));   // die ganze Show hat sie nicht, sie wird angeboten
assert.equal(gesendet.mails.length, 1);
assert.equal(gesendet.mails[0].to, 'familie@beispiel.ch');
assert.ok(gesendet.mails[0].text.includes(`${HOST}/k/${t}`));
assert.ok(gesendet.mails[0].html.includes(`href="${HOST}/k/${t}"`) && gesendet.mails[0].html.includes('Nr. 04 · Clouds &#38; Little Alien'));
assert.equal((await call('/webhook', { json: { transaction: { referenceId: 'unsinn' } } })).status, 200);

// ---------- Auslieferung: Range, Download, fremde und unbekannte Schlüssel ----------

r = await call(`/k/${t}/v/4`, { headers: { range: 'bytes=0-99' } });
assert.equal(r.status, 206);
assert.equal(r.headers.get('content-range'), 'bytes 0-99/1000');
assert.equal((await r.arrayBuffer()).byteLength, 100);
r = await call(`/k/${t}/v/4`, { headers: { range: 'bytes=900-' } });
assert.equal(r.headers.get('content-range'), 'bytes 900-999/1000');
r = await call(`/k/${t}/v/4`, { headers: { range: 'bytes=-100' } });
assert.equal(r.headers.get('content-range'), 'bytes 900-999/1000');
assert.equal((await call(`/k/${t}/v/4`, { headers: { range: 'bytes=5000-' } })).status, 416);
r = await call(`/k/${t}/v/4?dl=1`);
assert.equal(r.status, 200);
assert.equal(r.headers.get('content-type'), 'video/mp4');
assert.equal(r.headers.get('content-disposition'), 'attachment; filename="FlowDanceLoft_2026_Nr04_Clouds_Little_Alien.mp4"');
assert.equal((await call(`/k/${t}/v/14`)).status, 403);                                 // nicht gekauft
assert.equal((await call(`/k/${t}/v/0`)).status, 403);                                  // Clips öffnen die ganze Show nicht
assert.equal((await call('/k/00000000-0000-4000-8000-000000000000/v/4')).status, 404);    // unbekannter Schlüssel
assert.equal((await call('/k/00000000-0000-4000-8000-000000000000')).status, 404);

r = await call('/buy', { form: { clip: '4', email: 'andere@beispiel.ch' } });
const fremd = tokenAus(r);
assert.equal(gesendet.payrexx.at(-1).amount, '1000');
assert.equal((await call(`/k/${fremd}/v/4`)).status, 403);                               // fremder Schlüssel, Zahlung offen
assert.equal((await call(`/k/${fremd}/v/11`)).status, 403);

// ---------- Nachkauf: Paarpreis gilt weiter, kein Clip doppelt, keiner ohne Datei ----------

let n = gesendet.payrexx.length;
r = await call(`/k/${t}/buy`, { form: [['clip', '14'], ['clip', '4']] });
assert.equal(r.status, 303);
assert.equal(gesendet.payrexx.at(-1).amount, '1000');       // dritter Clip: 2500 − 1500
assert.equal(gesendet.payrexx.length, n + 1);
r = await call(`/k/${t}/buy`, { form: { clip: '4' } });      // schon gekauft
assert.equal(r.headers.get('location'), `${HOST}/k/${t}?m=leer`);
r = await call('/buy', { form: { clip: '13', email: 'x@beispiel.ch' } });   // keine Datei im Bucket
assert.equal(r.headers.get('location'), `${HOST}/?m=leer`);
r = await call('/buy', { form: { clip: '4', email: 'keine-adresse' } });
assert.equal(r.headers.get('location'), `${HOST}/?m=mail`);
assert.equal(gesendet.payrexx.length, n + 1);

// Wer einen Clip hat, zahlt für den zweiten CHF 5.
r = await call('/buy', { form: { clip: '4', email: 'einzeln@beispiel.ch' } });
const einzeln = tokenAus(r);
gwStatus.set(String(gwId), 'confirmed');
await call(`/k/${einzeln}`);
await call(`/k/${einzeln}/buy`, { form: { clip: '11' } });
assert.equal(gesendet.payrexx.at(-1).amount, '500');

// ---------- Die ganze Show als ein Video: eigener Artikel, CHF 25, öffnet nur dieses eine Video ----------

r = await call('/buy', { form: { clip: '0', email: 'show@beispiel.ch' } });
const show = tokenAus(r);
assert.equal(gesendet.payrexx.at(-1).amount, '2500');
assert.equal(gesendet.payrexx.at(-1).purpose, 'Flow Dance Loft Clips · ganze Show');
assert.equal((await call(`/k/${show}/v/0`)).status, 403);                                // erst nach der Zahlung
gwStatus.set(String(gwId), 'confirmed');
html = await (await call(`/k/${show}?z=1`)).text();
assert.ok(html.includes(`/k/${show}/v/0"`) && html.includes('poster="/p/hero"') && !html.includes('value="0"'));
r = await call(`/k/${show}/v/0?dl=1`, { headers: { range: 'bytes=0-9' } });
assert.equal(r.status, 206);
assert.equal(r.headers.get('content-disposition'), 'attachment; filename="FlowDanceLoft_2026_Ganze_Show.mp4"');
assert.equal((await call(`/k/${show}/v/4`)).status, 403);                                // die Show öffnet keine Einzelclips
assert.ok(html.includes('Nächster Clip CHF 10'));                                        // Clips zählen für sich
await call(`/k/${show}/buy`, { form: { clip: '4' } });
assert.equal(gesendet.payrexx.at(-1).amount, '1000');
r = await call(`/k/${show}/buy`, { form: { clip: '0' } });                               // die Show kein zweites Mal
assert.equal(r.headers.get('location'), `${HOST}/k/${show}?m=leer`);

// Show und zwei Clips zusammen: 25 + 15
await call('/buy', { form: [['clip', '0'], ['clip', '4'], ['clip', '11'], ['email', 'beides@beispiel.ch']] });
assert.equal(gesendet.payrexx.at(-1).amount, '4000');
assert.equal(gesendet.payrexx.at(-1).purpose, 'Flow Dance Loft Clips · ganze Show, Nr. 4, Nr. 11');

// ---------- Link vergessen ----------

n = gesendet.mails.length;
r = await call('/link', { form: { email: 'Familie@beispiel.ch' } });
assert.equal(r.headers.get('location'), `${HOST}/?m=link`);
assert.equal(gesendet.mails.length, n + 1);
assert.ok(gesendet.mails.at(-1).text.includes(`${HOST}/k/${t}`));
r = await call('/link', { form: { email: 'niemand@beispiel.ch' } });
assert.equal(r.headers.get('location'), `${HOST}/?m=link`);      // gleiche Antwort
await call('/link', { form: { email: 'familie@beispiel.ch' } }); // innert 10 Minuten
assert.equal(gesendet.mails.length, n + 1);

// ---------- Admin und Startseite ----------

assert.equal((await call('/admin')).status, 401);
r = await call('/admin', { headers: { authorization: 'Basic ' + btoa('joel:pw') } });
assert.equal(r.status, 200);
html = await r.text();
assert.ok(html.includes('CHF 50') && html.includes('familie@beispiel.ch'));   // 15 (zwei Clips) + 10 (ein Clip) + 25 (ganze Show)
html = await (await call('/')).text();
assert.ok(html.includes('value="0"') && html.includes('value="4"') && !html.includes('value="13"') && !html.includes('value="99"'));
assert.ok(html.includes('src="/p/hero"') && !html.includes('Nummern sind da'));
assert.equal((await call('/p/99')).status, 404);             // nicht im Programm: auch kein Standbild
assert.equal((await call('/p/4')).status, 200);
assert.equal((await call('/p/hero')).status, 200);

// ---------- Admin: zu tun, suchen, Link schicken, erstatten, löschen, Export ----------

const adm = { authorization: 'Basic ' + btoa('joel:pw') }, hier = { ...adm, origin: HOST };
html = await (await call('/admin', { headers: adm })).text();
assert.ok(html.includes('Netto, geschätzt') && html.includes('<b>Video fehlt</b> · Nr. 01, 02, 03'));   // nur Nr. 4, 11, 14 haben Dateien
assert.ok(html.includes('Zahlung offen') && html.includes('beides@beispiel.ch'));                          // offen, noch nicht bestätigt
assert.ok(html.includes(`data-link="${HOST}/k/${t}"`));
html = await (await call('/admin?q=FAMILIE', { headers: adm })).text();
assert.ok(html.includes('1 Treffer') && html.includes('familie@beispiel.ch') && !html.includes('show@beispiel.ch</b>'));

// Eine fremde Seite darf mit dem gespeicherten Passwort nichts auslösen.
r = await call('/admin/aktion', { headers: { ...adm, origin: 'https://boese.example' }, form: { was: 'loeschen', id: t } });
assert.equal(r.status, 403);
r = await call('/admin/aktion', { headers: { ...adm, 'sec-fetch-site': 'cross-site' }, form: { was: 'loeschen', id: t } });
assert.equal(r.status, 403);
assert.equal((await call('/admin/aktion', { headers: { origin: HOST }, form: { was: 'loeschen', id: t } })).status, 401);
assert.equal((await call(`/k/${t}`)).status, 200);

n = gesendet.mails.length;
r = await call('/admin/aktion', { headers: hier, form: { was: 'mail', id: t, q: 'familie' } });
assert.equal(r.headers.get('location'), `${HOST}/admin?m=gesendet&q=familie`);
assert.equal(gesendet.mails.length, n + 1);
assert.ok(gesendet.mails.at(-1).text.includes(`${HOST}/k/${t}`));

// Erstatten sperrt genau diese Zahlung und zählt nicht mehr zum Umsatz.
assert.equal((await call(`/k/${t}/v/4`)).status, 200);
r = await call('/admin/aktion', { headers: hier, form: { was: 'erstatten', id: '101' } });
assert.equal(r.headers.get('location'), `${HOST}/admin?m=erstattet`);
assert.equal((await call(`/k/${t}/v/4`)).status, 403);
html = await (await call('/admin', { headers: adm })).text();
assert.ok(html.includes('<b>CHF 35</b>Umsatz') && html.includes('erstattet'));   // 50 − 15

r = await call('/admin/export.csv', { headers: adm });
assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
assert.deepEqual([...new Uint8Array(await r.clone().arrayBuffer()).slice(0, 3)], [0xef, 0xbb, 0xbf]);   // BOM für Excel
const csv = await r.text();
assert.ok(csv.startsWith('"Datum";"E-Mail"') && csv.includes('"familie@beispiel.ch";"Nr. 04, Nr. 11";"15.00";"erstattet"'));
assert.ok(csv.includes('"show@beispiel.ch";"ganze Show";"25.00";"bezahlt"'));
assert.equal((await call('/admin/export.csv')).status, 401);

r = await call('/admin/aktion', { headers: hier, form: { was: 'loeschen', id: t } });
assert.equal(r.headers.get('location'), `${HOST}/admin?m=geloescht`);
assert.equal((await call(`/k/${t}`)).status, 404);

// Ohne Datei gibt es die ganze Show nicht zu kaufen.
dateien.delete('2026/show.mp4');
n = gesendet.payrexx.length;
html = await (await call('/')).text();
assert.ok(!html.includes('value="0"') && html.includes('id="show"') && html.includes('Die ganze Show'));   // sichtbar, aber «folgt»
r = await call('/buy', { form: { clip: '0', email: 'x@beispiel.ch' } });
assert.equal(r.headers.get('location'), `${HOST}/?m=leer`);
assert.equal(gesendet.payrexx.length, n);
dateien.set('2026/show.mp4', film);

// ---------- Demo-Modus ----------

assert.equal((await call('/demo/pay/demo-00000000-0000-4000-8000-000000000000')).status, 404);   // mit API-Schlüssel gibt es keine Demo
const demo = { DB: d1(), CLIPS, RESEND_API_KEY: 'r', ADMIN_PASSWORD: 'pw' };
assert.equal((await call('/', { e: demo })).status, 401);                          // fremder Host ohne Passwort
assert.equal((await call('/', { e: { ...demo, SITE_PASSWORD: 's' }, headers: { authorization: 'Basic ' + btoa(':s') } })).status, 200);
for (const host of ['http://localhost:8787', 'http://192.168.1.20:8787']) {
  n = gesendet.payrexx.length;
  r = await call('/buy', { e: demo, host, form: [['clip', '0'], ['clip', '4'], ['email', 'demo@beispiel.ch']] });
  const dt = tokenAus(r), zahlseite = new URL(r.headers.get('location'));
  assert.equal(zahlseite.origin, host);
  assert.ok(!r.headers.get('set-cookie').includes('Secure'));     // http im WLAN: Cookie muss trotzdem halten
  html = await (await call(zahlseite.pathname, { e: demo, host })).text();
  assert.ok(html.includes('keine echte Zahlung') && html.includes('CHF 35.00') && html.includes('Die ganze Show') && html.includes('Nr. 04'));
  assert.equal((await call(`/k/${dt}/v/4`, { e: demo, host })).status, 403);
  r = await call(zahlseite.pathname, { e: demo, host, form: { pm: 'on' } });
  assert.equal(r.headers.get('location'), `${host}/k/${dt}?z=1`);
  assert.equal((await call(`/k/${dt}/v/4`, { e: demo, host, headers: { range: 'bytes=0-1' } })).status, 206);
  assert.equal((await call(`/k/${dt}/v/0`, { e: demo, host, headers: { range: 'bytes=0-1' } })).status, 206);
  assert.equal(gesendet.mails.at(-1).to, 'demo@beispiel.ch');
  assert.equal(gesendet.payrexx.length, n);                      // im Demo-Modus geht nichts an Payrexx
}

console.log('check.mjs: alles in Ordnung');
