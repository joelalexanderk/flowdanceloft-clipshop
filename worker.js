// Clip-Shop Flow Dance Loft: ein Worker, D1 für die Käufe, R2 für die Clips. Kein Framework, kein Build.
// Lokal zeigen: npx wrangler dev --ip 0.0.0.0        Selbsttest: node check.mjs
import { SHOW, CLIPS, PREIS_1, PREIS_2, PREIS_SHOW, preis } from './clips.js';

const PAYREXX = 'https://api.payrexx.com/v1.0';
const TAG = 86400;
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clipByNr = new Map(CLIPS.map(c => [c.nr, c]));

const now = () => Math.floor(Date.now() / 1000);
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const chf = r => 'CHF ' + (r % 100 ? (r / 100).toFixed(2) : r / 100);
const nr2 = nr => String(nr).padStart(2, '0');
const key = (nr, ext) => `${SHOW.jahr}/${nr === SHOWVIDEO ? 'show' : 'nr' + nr2(nr)}.${ext}`;

// Die ganze Show als ein Video ist ein eigener Artikel neben den Clips: clip = 0, Datei <jahr>/show.mp4.
const SHOWVIDEO = 0;
// Bezahlt hat ein Schlüssel die Clips nach Staffel, die ganze Show kommt dazu.
// Darum braucht es keine Tabelle mit Beträgen.
const gezahlt = hat => preis(hat.size - hat.has(SHOWVIDEO)) + (hat.has(SHOWVIDEO) ? PREIS_SHOW : 0);

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      console.error(e);   // beim Webhook heisst 500: Payrexx versucht es später noch einmal
      return new Response('Es ist ein Fehler passiert. Bitte versuche es später noch einmal.', { status: 500 });
    }
  },
};

async function route(req, env) {
  const url = new URL(req.url), p = url.pathname, demo = !env.PAYREXX_API_KEY;
  const get = req.method === 'GET' || req.method === 'HEAD', post = req.method === 'POST';

  // Der Demo-Modus schaltet ohne Zahlung frei. Ausserhalb des eigenen Netzes läuft er darum nur
  // hinter einem Passwort, sonst lägen Clips von Kindern gratis im Netz.
  if (p !== '/webhook' && (env.SITE_PASSWORD || (demo && !lokal(url.hostname)))
      && !basicOk(req, env.SITE_PASSWORD, env.ADMIN_PASSWORD)) return passwort();

  let m;
  if (get && p === '/') return start(req, env, url);
  if (post && p === '/buy') return kaufen(req, env, url);
  if (get && p === '/neu') return weiter(url, '/', { 'set-cookie': keks(url, '', 0) });
  if (post && p === '/link') return linkVergessen(req, env, url);
  if (post && p === '/webhook') return webhook(req, env, url);
  if (get && p === '/admin') return admin(req, env, url);
  if (get && p === '/p/hero')   // Bild vom Finale: oben auf der Startseite und als Standbild der ganzen Show
    return datei(env, req, `${SHOW.jahr}/hero.jpg`, 'image/jpeg', { 'cache-control': 'public, max-age=86400' });
  if (get && (m = /^\/p\/(\d+)$/.exec(p)) && clipByNr.has(+m[1]))
    return datei(env, req, key(+m[1], 'jpg'), 'image/jpeg', { 'cache-control': 'public, max-age=86400' });
  if ((m = /^\/k\/([0-9a-f-]{36})(\/buy|\/v\/(\d+))?$/.exec(p)) && UUID.test(m[1])) {
    if (post && m[2] === '/buy') return kaufen(req, env, url, m[1]);
    if (get && m[3]) return video(req, env, url, m[1], +m[3]);
    if (get && !m[2]) return meine(req, env, url, m[1]);
  }
  if (demo && (get || post) && (m = /^\/demo\/pay\/(demo-[0-9a-f-]{36})$/.exec(p)))
    return demoZahlung(req, env, url, m[1]);
  return nichtGefunden();
}

// ---------- Zugang ----------

const lokal = h => h === 'localhost' || h.endsWith('.local')
  || /^(127|10|192\.168|172\.(1[6-9]|2\d|3[01]))(\.\d+){2,3}$/.test(h);

function basicOk(req, ...passwoerter) {
  const a = req.headers.get('authorization') || '';
  if (!a.startsWith('Basic ')) return false;
  let pw;
  try { pw = atob(a.slice(6)).split(':').slice(1).join(':'); } catch { return false; }
  return passwoerter.some(p => p && p === pw);
}

const passwort = () => new Response('Passwort nötig', {
  status: 401, headers: { 'www-authenticate': 'Basic realm="Flow Dance Loft Clips", charset="UTF-8"' } });

const cookie = req => (/(?:^|;\s*)k=([0-9a-f-]{36})/.exec(req.headers.get('cookie') || '') || [])[1];
const keks = (url, t, alter = 365 * TAG) =>
  `k=${t}; Path=/; Max-Age=${alter}; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`;

const weiter = (url, pfad, headers = {}) =>
  new Response(null, { status: 303, headers: { location: new URL(pfad, url).href, ...headers } });

// ---------- Datenbank und Bucket ----------

const kaeufer = (env, t) => env.DB.prepare('SELECT token, email FROM buyers WHERE token = ?').bind(t).first();

const bezahlt = async (env, t) => new Set((await env.DB.prepare(
  "SELECT clip FROM purchases WHERE token = ? AND status = 'confirmed'").bind(t).all()).results.map(r => r.clip));

const offene = async (env, t) => (await env.DB.prepare(
  `SELECT gateway_id FROM purchases WHERE token = ? AND status = 'waiting' AND created_at > ?
   GROUP BY gateway_id ORDER BY MAX(created_at) DESC LIMIT 5`).bind(t, now() - 7 * TAG).all()).results.map(r => r.gateway_id);

// Was im Bucket liegt, ist kaufbar. So wird nie ein Clip verkauft, dessen Datei fehlt.
const vorhanden = async env =>
  new Set((await env.CLIPS.list({ prefix: SHOW.jahr + '/' })).objects.map(o => o.key));

// Reicht eine Datei aus R2 durch. Range muss sein: Ohne 206 spielt Safari auf dem iPhone kein Video ab.
async function datei(env, req, k, typ, extra = {}) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
  const range = !m ? null
    : m[1] ? { offset: +m[1], ...(m[2] && { length: +m[2] - +m[1] + 1 }) }
    : +m[2] ? { suffix: +m[2] } : null;
  let obj;
  try { obj = await env.CLIPS.get(k, range ? { range } : undefined); }
  catch { return new Response('Bereich ungültig', { status: 416 }); }
  if (!obj) return nichtGefunden();
  const h = new Headers({ 'content-type': typ, 'accept-ranges': 'bytes', etag: obj.httpEtag, ...extra });
  if (!range) return new Response(obj.body, { headers: h });
  const von = range.suffix ? Math.max(0, obj.size - range.suffix) : range.offset;
  const bis = Math.min(obj.size, range.length ? von + range.length : obj.size) - 1;
  h.set('content-range', `bytes ${von}-${bis}/${obj.size}`);
  return new Response(obj.body, { status: 206, headers: h });
}

// ---------- Payrexx ----------

async function payrexx(env, method, pfad, body) {
  const r = await fetch(`${PAYREXX}/${pfad}?instance=${encodeURIComponent(env.PAYREXX_INSTANCE)}`, {
    method, body,
    headers: { 'X-API-KEY': env.PAYREXX_API_KEY, ...(body && { 'content-type': 'application/x-www-form-urlencoded' }) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 'success' || !j.data?.[0])
    throw new Error(`Payrexx ${method} ${pfad}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j.data[0];
}

// Legt die Zahlung an. Ohne API-Schlüssel führt sie auf die eigene Demo-Zahlseite.
async function gateway(env, origin, t, email, betrag, was) {
  if (!env.PAYREXX_API_KEY) {
    const id = 'demo-' + crypto.randomUUID();
    return { id, link: `${origin}/demo/pay/${id}` };
  }
  const seite = `${origin}/k/${t}`;
  return payrexx(env, 'POST', 'Gateway/', new URLSearchParams({
    amount: betrag, currency: 'CHF', purpose: `Flow Dance Loft Clips · ${was}`, referenceId: t,
    successRedirectUrl: seite + '?z=1', failedRedirectUrl: seite, cancelRedirectUrl: seite,
    'fields[email][value]': email, skipResultPage: 1,
  }).toString());
}

// Die einzige Stelle, die eine echte Zahlung freischaltet. Gefragt wird immer Payrexx selbst,
// nie der Redirect und nie der Inhalt des Webhooks.
async function settle(env, origin, gid) {
  if (gid.startsWith('demo-')) return;
  if ((await payrexx(env, 'GET', `Gateway/${gid}/`)).status === 'confirmed') await bestaetigt(env, origin, gid);
}

async function bestaetigt(env, origin, gid) {
  const r = await env.DB.prepare(
    "UPDATE purchases SET status = 'confirmed' WHERE gateway_id = ? AND status = 'waiting'").bind(gid).run();
  if (!r.meta.changes) return;   // schon freigeschaltet: Webhook und Seitenaufruf verschicken zusammen nur eine Mail
  const k = await env.DB.prepare(
    'SELECT b.token, b.email FROM buyers b JOIN purchases p ON p.token = b.token WHERE p.gateway_id = ? LIMIT 1').bind(gid).first();
  await mail(env, k.email, 'Deine Clips von Flow Dance Loft sind bereit', `Hallo

Danke für deinen Kauf. Deine Clips der Show «${SHOW.name}» sind bereit:

${origin}/k/${k.token}

Das ist dein persönlicher Link. Dort kannst du die Clips ansehen und herunterladen.
Online bleiben sie mindestens bis ${SHOW.onlineBis}. Lade sie am besten gleich herunter.

Die Clips sind für den privaten Gebrauch bestimmt. Bitte nicht weitergeben oder veröffentlichen.

Flow Dance Loft`);
}

async function webhook(req, env, url) {
  const t = (await req.json().catch(() => null))?.transaction?.referenceId;
  if (typeof t === 'string' && UUID.test(t))
    for (const gid of await offene(env, t)) await settle(env, url.origin, gid);
  return new Response('ok');
}

// ---------- Mail ----------

async function mail(env, an, betreff, text) {
  if (!env.RESEND_API_KEY) return console.log(`[Mail an ${an}] ${betreff}\n${text}\n`);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'Flow Dance Loft Clips <clips@seismos.ch>', to: an, subject: betreff, text,
      ...(env.CONTACT_EMAIL && { reply_to: env.CONTACT_EMAIL }),
    }),
  });
  if (!r.ok) console.error('Resend', r.status, await r.text());
}

async function linkVergessen(req, env, url) {
  const email = String((await req.formData()).get('email') || '').trim().toLowerCase();
  const ks = MAIL.test(email) ? (await env.DB.prepare(
    'SELECT token, mailed_at FROM buyers WHERE email = ? ORDER BY created_at DESC LIMIT 5').bind(email).all()).results : [];
  if (ks.length && !ks.some(k => k.mailed_at > now() - 600)) {   // höchstens alle 10 Minuten pro Adresse
    await env.DB.prepare('UPDATE buyers SET mailed_at = ? WHERE email = ?').bind(now(), email).run();
    await mail(env, email, 'Dein Link zu den Clips von Flow Dance Loft', `Hallo

Hier ist dein persönlicher Link zu deinen Clips:

${ks.map(k => `${url.origin}/k/${k.token}`).join('\n')}

Flow Dance Loft`);
  }
  return weiter(url, '/?m=link');   // immer dieselbe Antwort: Niemand erfährt, wer gekauft hat
}

// ---------- Kaufen ----------

async function kaufen(req, env, url, t) {
  const form = await req.formData(), zurueck = t ? `/k/${t}` : '/';
  let email;
  if (t) {
    const k = await kaeufer(env, t);
    if (!k) return nichtGefunden();
    email = k.email;
  } else {
    email = String(form.get('email') || '').trim().toLowerCase();
    if (!MAIL.test(email) || email.length > 200) return weiter(url, '/?m=mail');
  }
  const da = await vorhanden(env), hat = t ? await bezahlt(env, t) : new Set();
  const wahl = [...new Set(form.getAll('clip').map(Number))]
    .filter(n => (n === SHOWVIDEO || clipByNr.has(n)) && da.has(key(n, 'mp4')) && !hat.has(n));
  if (!wahl.length) return weiter(url, zurueck + '?m=leer');

  // ponytail: kein Limit pro Absender. Legt jemand massenhaft Zahlungen an, eine Rate-Limit-Regel
  // in Cloudflare auf POST /buy setzen.
  if (!t) {
    t = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO buyers (token, email, created_at) VALUES (?, ?, ?)').bind(t, email, now()).run();
  }
  // Den Betrag rechnet der Server, aus dem Formular kommt nur die Auswahl.
  // ponytail: Offene Zahlungen zählen nicht mit. Wer in zwei Tabs gleichzeitig kauft, spart
  // höchstens CHF 5 oder zahlt dasselbe doppelt. Erst schliessen, wenn es vorkommt.
  const betrag = gezahlt(new Set([...hat, ...wahl])) - gezahlt(hat);
  const was = wahl.map(n => n === SHOWVIDEO ? 'ganze Show' : `Nr. ${n}`).join(', ');
  const gw = await gateway(env, url.origin, t, email, betrag, was);
  await env.DB.batch(wahl.map(n => env.DB.prepare(
    'INSERT INTO purchases (token, clip, gateway_id, created_at) VALUES (?, ?, ?, ?)').bind(t, n, String(gw.id), now())));
  return new Response(null, { status: 303, headers: { location: gw.link, 'set-cookie': keks(url, t) } });
}

async function demoZahlung(req, env, url, id) {
  const rows = (await env.DB.prepare(
    "SELECT token, clip FROM purchases WHERE gateway_id = ? AND status = 'waiting' ORDER BY clip").bind(id).all()).results;
  if (!rows.length) return nichtGefunden();
  const t = rows[0].token;
  if (req.method === 'POST') {
    await bestaetigt(env, url.origin, id);
    return weiter(url, `/k/${t}?z=1`);
  }
  const k = await kaeufer(env, t), hat = await bezahlt(env, t);
  const betrag = 'CHF ' + ((gezahlt(new Set([...hat, ...rows.map(r => r.clip)])) - gezahlt(hat)) / 100).toFixed(2);
  return seite('Zahlung (Demo)', `<main>
  <div class="demo">Demo · keine echte Zahlung</div>
  <div class="merchant">Flow Dance Loft GmbH</div>
  <div class="via">Clips «${SHOW.name}» ${SHOW.jahr}</div>
  <div class="card">
    ${rows.map(r => r.clip === SHOWVIDEO ? '<div class="line"><span>Die ganze Show</span><span>Video</span></div>'
      : `<div class="line"><span>Nr. ${nr2(r.clip)} · ${esc(clipByNr.get(r.clip)?.titel ?? '')}</span><span>Clip</span></div>`).join('')}
    <div class="line total"><span>Total</span><span>${betrag}</span></div>
  </div>
  <div class="lbl">E-Mail für deinen Link</div>
  <div class="field">${esc(k.email)}</div>
  <form method="post">
    <div class="lbl">Bezahlen mit</div>
    <label class="pm"><span class="twint">TWINT</span><input type="radio" name="pm" checked></label>
    <label class="pm"><span>Karte<small>Visa · Mastercard</small></span><input type="radio" name="pm"></label>
    <button class="paybtn">${betrag} bezahlen</button>
  </form>
  <p class="secure">Im echten Shop steht hier die Zahlseite von Payrexx.<br>Das Geld geht direkt an Flow Dance Loft. <a href="/k/${t}">Abbrechen</a></p>
</main>`, { klasse: 'pay' });
}

// ---------- Seiten ----------

const HINWEIS = {
  leer: 'Bitte wähle mindestens einen Clip aus.',
  mail: 'Bitte gib eine gültige E-Mail-Adresse an.',
  link: 'Falls zu dieser Adresse Clips gehören, ist die Mail mit deinem Link unterwegs.',
};
const hinweis = url => Object.hasOwn(HINWEIS, url.searchParams.get('m') ?? '')
  ? `<p class="note">${HINWEIS[url.searchParams.get('m')]}</p>` : '';

// Icons als SVG: Pfeile und Haken aus der Schrift sehen je nach Handy anders aus oder werden zu Emoji.
const svg = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  pfeil: svg('<path d="M7 17 17 7M8 7h9v9"/>'),
  laden: svg('<path d="M12 4v12M6 11l6 6 6-6M5 20h14"/>'),
  haken: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
};
const STERN = '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M12 2 14.9 8.9 22 9.5 16.6 14.2 18.3 21.5 12 17.8 5.7 21.5 7.4 14.2 2 9.5 9.1 8.9z"/></svg>';

function laufband() {
  const t = [SHOW.name, SHOW.kicker, `1 Clip ${chf(PREIS_1)}`, `2 Clips ${chf(PREIS_2)}`, `Ganze Show ${chf(PREIS_SHOW)}`, 'Full HD', 'Ansehen und herunterladen']
    .map(x => `<span>${esc(x)}</span>${STERN}`).join('');
  return `<div class="ticker" aria-hidden="true"><div class="run">${t}${t}</div></div>`;   // zweimal: Die Schleife läuft nahtlos
}

const kopfzeile = () => `<header class="top"><div class="wrap">
  <a class="brand" href="/"><img src="/flow-logo.jpg" alt="" width="42" height="42"><b>Flow Dance Loft</b><span>/ Clip-Shop</span></a>
</div></header>`;

const kopf = (titel, pointe) =>
  `<p class="label">${esc(SHOW.kicker)}</p><h1 class="h1">${esc(titel)} <em>${esc(pointe)}</em></h1>`;

const fuss = env => `<footer class="foot"><div class="wrap">
  <p class="label">grow with the flow</p>
  <p><b>Flow Dance Loft GmbH</b> · Zelgli 3 · 5452 Oberrohrdorf${env.CONTACT_EMAIL
    ? ` · <a href="mailto:${esc(env.CONTACT_EMAIL)}">${esc(env.CONTACT_EMAIL)}</a>` : ''}</p>
  <p>Die Clips sind digitale Inhalte und nach der Zahlung sofort verfügbar. Sie sind für den privaten Gebrauch bestimmt, bitte nicht weitergeben oder veröffentlichen.</p>
  <p>Gespeichert wird nur deine E-Mail-Adresse, damit du deinen Link wieder bekommst. Technik: Seismos Media.</p>
  <div class="wordmark" aria-hidden="true">Flow Dance Loft</div>
</div></footer>`;

// Eine Zeile im Programm. Ohne Datei im Bucket heisst sie «folgt» und lässt sich nicht anwählen.
const zeile = (c, da) => da.has(key(c.nr, 'mp4'))
  ? `<label class="row"><input type="checkbox" name="clip" value="${c.nr}">
      <span class="num">${nr2(c.nr)}</span>
      <span class="thumb">${da.has(key(c.nr, 'jpg')) ? `<img src="/p/${c.nr}" alt="" loading="lazy" width="160" height="90">` : ''}</span>
      <span class="txt"><b>${esc(c.titel)}</b><small>${esc(c.gruppe)}</small></span>
      <span class="tog">${ICON.plus}${ICON.haken}</span></label>`
  : `<div class="row soon">
      <span class="num">${nr2(c.nr)}</span>
      <span class="thumb"></span>
      <span class="txt"><b>${esc(c.titel)}</b><small>${esc(c.gruppe)}</small></span>
      <span class="pill out">folgt</span></div>`;

// Oben die ganze Show als ein Video, darunter das Programm als Zeilen, unten die Leiste mit Betrag und «Bezahlen».
// Die Summe in der Leiste ist nur Anzeige, gerechnet wird in kaufen().
// «zwischen» steht zwischen der ganzen Show und dem Programm (Startseite: die Überschrift zum Programm).
function auswahl(action, clips, da, hat, mitMail, zwischen) {
  const pause = i => i > 0 && clips[i - 1].nr <= SHOW.pauseNach && clips[i].nr > SHOW.pauseNach;
  // Der Streifen zeigt das Programm auf einen Blick: da, folgt, gekauft, gewählt.
  const streifen = CLIPS.map((c, i) => (i > 0 && CLIPS[i - 1].nr <= SHOW.pauseNach && c.nr > SHOW.pauseNach ? '<i class="p"></i>' : '')
    + `<i data-n="${c.nr}" class="${hat.has(c.nr) ? 'own' : da.has(key(c.nr, 'mp4')) ? '' : 's'}"></i>`).join('');
  // Die ganze Show ist immer zu sehen. Ohne Datei im Bucket steht «folgt», kaufbar wird sie mit dem Upload.
  const show = !hat.has(SHOWVIDEO), kaufbar = show && da.has(key(SHOWVIDEO, 'mp4'));
  const text = '<span class="txt"><b>Die ganze Show</b><small>Die ganze Vorstellung als ein Video</small></span>';
  return `<form class="shop" method="post" action="${action}" data-paid="${hat.size - hat.has(SHOWVIDEO)}">
  ${kaufbar ? `<label class="alle" id="show"><input type="checkbox" name="clip" value="${SHOWVIDEO}">${text}
    <span class="pill"><b>${chf(PREIS_SHOW)}</b></span>
    <span class="tog">${ICON.plus}${ICON.haken}</span></label>`
    : show ? `<div class="alle soon" id="show">${text}<span class="pill out">folgt</span></div>` : ''}
  ${clips.length ? `${zwischen || (show ? '<p class="oder">Oder einzelne Nummern</p>' : '')}
  <div class="strip" aria-hidden="true">${streifen}</div>
  <div class="list">${clips.map((c, i) => (pause(i) ? '<div class="pause">Pause</div>' : '') + zeile(c, da)).join('')}</div>` : ''}
  <div class="bar">
    ${mitMail ? '<label for="mail">E-Mail für deinen Link</label><input id="mail" type="email" name="email" required autocomplete="email" placeholder="familie@beispiel.ch">' : ''}
    <div class="bar-r"><div><div class="bar-l" aria-live="polite"></div><div class="bar-p"></div></div>
      <button class="btn">Bezahlen ${ICON.pfeil}</button></div>
  </div>
</form>
<script>
for (const f of document.querySelectorAll('form.shop')) {
  const preis = n => Math.floor(n / 2) * ${PREIS_2 / 100} + n % 2 * ${PREIS_1 / 100}, paid = +f.dataset.paid;
  const zeigen = () => {
    const zeilen = [...f.querySelectorAll('.row [name=clip]')], n = zeilen.filter(c => c.checked).length;
    const show = !!f.querySelector('.alle :checked'), clips = n + (n === 1 ? ' Clip' : ' Clips');
    f.querySelector('.bar-l').textContent = show ? 'Ganze Show' + (n ? ' + ' + clips : '') : clips + ' ausgewählt';
    f.querySelector('.bar-p').textContent = 'CHF ' + (preis(paid + n) - preis(paid) + (show ? ${PREIS_SHOW / 100} : 0));
    for (const c of zeilen) document.querySelector('.strip [data-n="' + c.value + '"]')?.classList.toggle('on', c.checked);
  };
  f.addEventListener('change', zeigen); addEventListener('pageshow', zeigen);
}
</script>`;
}

async function start(req, env, url) {
  const t = cookie(req);
  if (t && !url.searchParams.has('m') && await kaeufer(env, t)) return weiter(url, `/k/${t}`);
  const da = await vorhanden(env);
  return seite(`${SHOW.name} · Clips`, `${laufband()}${kopfzeile()}
<main>
  <section class="hero wrap">
    <div>
      <span class="sticker">Show ${SHOW.jahr} · Die Clips sind da</span>
      <h1 class="over" aria-label="${esc(SHOW.name)}"><span aria-hidden="true">${esc(SHOW.titel)}<br>${esc(SHOW.pointe)}</span><span aria-hidden="true">${esc(SHOW.titel)}<br>${esc(SHOW.pointe)}</span></h1>
      <p class="lead">Jede Nummer als eigener Clip in Full HD, oder die ganze Show als ein Video. Bezahlen, sofort ansehen und herunterladen.</p>
      <p class="preise"><a class="pill y" href="#show">Ganze Show <b>${chf(PREIS_SHOW)}</b></a><span class="pill">1 Clip <b>${chf(PREIS_1)}</b></span><span class="pill">2 Clips <b>${chf(PREIS_2)}</b></span></p>
    </div>
    ${da.has(`${SHOW.jahr}/hero.jpg`) ? '<figure class="taped"><img src="/p/hero" alt="Das Finale der Show" width="1600" height="900"><i class="tape"></i><i class="tape"></i></figure>' : ''}
  </section>
  <section class="sect wrap">
    <p class="label">Alles auf einmal</p>
    ${hinweis(url)}
    ${auswahl('/buy', CLIPS, da, new Set(), true,
      '<div class="zwischen"><p class="label">Das Programm</p><h2>Oder einzelne <em>Clips.</em></h2></div>')}
  </section>
  <section class="block"><div class="wrap">
    <h2>Schon gekauft?</h2>
    <p>Gib deine E-Mail-Adresse an, dann schicken wir dir den Link zu deinen Clips noch einmal.</p>
    <form class="inline" method="post" action="/link">
      <label for="wieder">Deine E-Mail-Adresse</label>
      <input id="wieder" type="email" name="email" required autocomplete="email" placeholder="familie@beispiel.ch">
      <button class="btn dark">Link schicken</button>
    </form>
  </div></section>
</main>
${fuss(env)}`);
}

async function meine(req, env, url, t) {
  if (!await kaeufer(env, t)) return nichtGefunden();
  for (const gid of await offene(env, t)) await settle(env, url.origin, gid).catch(e => console.error(e));
  const rows = (await env.DB.prepare('SELECT clip, status, created_at FROM purchases WHERE token = ?').bind(t).all()).results;
  const hat = new Set(rows.filter(r => r.status === 'confirmed').map(r => r.clip));
  const jetzt = now(), z = +url.searchParams.get('z') || 0;
  const offen = rows.some(r => r.status === 'waiting' && !hat.has(r.clip) && jetzt - r.created_at < TAG);
  const frisch = rows.some(r => r.status === 'confirmed' && jetzt - r.created_at < 1800);
  // Nach der Rückkehr von Payrexx kann die Bestätigung ein paar Sekunden dauern: bis zu fünfmal neu laden.
  const prueft = offen && z > 0 && z < 6;

  const status = prueft
    ? '<div class="notiz wait"><b>Zahlung wird geprüft …</b><p>Einen Moment, die Seite lädt gleich neu.</p></div>'
    : z && frisch && !offen
    ? `<div class="notiz"><i class="tape"></i><b>${ICON.haken}Zahlung erhalten</b><p>Das ist dein persönlicher Link. Speichere ihn als Lesezeichen, du bekommst ihn auch per E-Mail.</p></div>`
    : offen
    ? '<p class="note">Eine Zahlung ist noch offen. Hast du abgebrochen? Dann wähle die Clips unten einfach noch einmal aus.</p>'
    : hinweis(url);

  const da = await vorhanden(env), show = hat.has(SHOWVIDEO), bezahlteClips = hat.size - show;
  const meins = CLIPS.filter(c => hat.has(c.nr)), rest = CLIPS.filter(c => !hat.has(c.nr));
  const karte = (nr, titel, unter) => `<article class="clip${nr === SHOWVIDEO ? ' gross' : ''}"><i class="tape"></i>
      <video controls playsinline preload="${da.has(key(nr, 'jpg')) || nr === SHOWVIDEO ? 'none' : 'metadata'}"${
        nr === SHOWVIDEO ? ' poster="/p/hero"' : da.has(key(nr, 'jpg')) ? ` poster="/p/${nr}"` : ''} src="/k/${t}/v/${nr}"></video>
      <div class="cmeta">${nr === SHOWVIDEO ? '' : `<span class="num">${nr2(nr)}</span>`}<span class="txt"><b>${esc(titel)}</b><small>${esc(unter)}</small></span></div>
      <a class="btn" href="/k/${t}/v/${nr}?dl=1" download>Herunterladen ${ICON.laden}</a>
    </article>`;
  return seite('Deine Clips · Flow Dance Loft', `${laufband()}${kopfzeile()}
<main>
  <section class="sect wrap">
    ${kopf('Deine', 'Clips.')}
    ${status}
    ${show || meins.length ? `<div class="clips">${show ? karte(SHOWVIDEO, 'Die ganze Show', `${SHOW.name} · die ganze Vorstellung als ein Video`) : ''}${
      meins.map(c => karte(c.nr, c.titel, c.gruppe)).join('')}</div>
    <p class="tip">Lade deine Videos herunter, dann bleiben sie dir für immer. Online sind sie mindestens bis ${SHOW.onlineBis}.${show ? ' Die ganze Show ist eine grosse Datei, lade sie am besten im WLAN.' : ''} Auf dem iPhone landet der Download in der Dateien-App, über «Teilen» und «Video sichern» kommt er in die Fotos.</p>`
      : '<p class="lead">Hier erscheinen deine Videos, sobald die Zahlung eingegangen ist.</p>'}
  </section>
  ${rest.length || !show ? `<section class="sect wrap">
    <p class="label">${rest.length ? `Nächster Clip ${chf(preis(bezahlteClips + 1) - preis(bezahlteClips))}` : 'Noch nicht dabei'}</p>
    <h2>${hat.size ? 'Noch' : 'Wähle'} <em>${hat.size ? 'mehr.' : 'deine Clips.'}</em></h2>
    ${auswahl(`/k/${t}/buy`, rest, da, hat, false)}
  </section>` : ''}
  <div class="wrap"><p class="tip"><a href="/neu">Nicht dein Gerät? Diesen Link hier vergessen</a></p></div>
</main>
${fuss(env)}`, { headers: { 'set-cookie': keks(url, t) }, ...(prueft && { refresh: `/k/${t}?z=${z + 1}` }) });
}

async function video(req, env, url, t, nr) {
  if (!await kaeufer(env, t)) return nichtGefunden();
  if (!(await bezahlt(env, t)).has(nr)) return new Response('Dieses Video ist nicht freigeschaltet.', { status: 403 });
  const titel = (clipByNr.get(nr)?.titel ?? '').normalize('NFKD').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '');
  const name = nr === SHOWVIDEO ? 'Ganze_Show' : `Nr${nr2(nr)}_${titel}`;
  return datei(env, req, key(nr, 'mp4'), 'video/mp4', {
    'cache-control': 'private, max-age=3600',
    ...(url.searchParams.has('dl') && {
      'content-disposition': `attachment; filename="FlowDanceLoft_${SHOW.jahr}_${name}.mp4"` }),
  });
}

async function admin(req, env, url) {
  if (!basicOk(req, env.ADMIN_PASSWORD)) return passwort();
  const off = (await env.DB.prepare(
    "SELECT DISTINCT gateway_id FROM purchases WHERE status = 'waiting' AND created_at > ? LIMIT 20").bind(now() - 7 * TAG).all()).results;
  for (const r of off) await settle(env, url.origin, r.gateway_id).catch(e => console.error(e));
  const rows = (await env.DB.prepare(
    `SELECT b.token, b.email, b.created_at, GROUP_CONCAT(p.clip) AS clips, COUNT(*) AS n
     FROM buyers b JOIN purchases p ON p.token = b.token WHERE p.status = 'confirmed'
     GROUP BY b.token ORDER BY b.created_at DESC`).all()).results;
  const kaeufe = rows.map(r => ({ ...r, hat: new Set(String(r.clips).split(',').map(Number)) }));
  const proNr = new Map();
  for (const k of kaeufe) for (const n of k.hat) proNr.set(n, (proNr.get(n) || 0) + 1);
  const umsatz = kaeufe.reduce((s, k) => s + gezahlt(k.hat), 0), shows = proNr.get(SHOWVIDEO) || 0;
  const clips = kaeufe.reduce((s, k) => s + k.hat.size - k.hat.has(SHOWVIDEO), 0);
  const was = n => n === SHOWVIDEO ? 'Show' : nr2(n);
  return seite('Verkäufe · Flow Dance Loft Clips', `${kopfzeile()}
<main class="admin">
  <section class="sect wrap">
    ${kopf('Verkäufe', 'Übersicht.')}
    <div class="kpi"><div><b>${chf(umsatz)}</b>Umsatz vor Gebühren</div><div><b>${shows}</b>Ganze Show</div><div><b>${clips}</b>Einzelne Clips</div></div>
  </section>
  <section class="sect wrap">
    <p class="label">Was gekauft wurde</p>
    <table><tr><th>Nr.</th><th>Titel</th><th>Verkauft</th></tr>
      ${[...proNr].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([n, c]) =>
        `<tr><td>${was(n)}</td><td>${n === SHOWVIDEO ? 'Die ganze Show als ein Video' : esc(clipByNr.get(n)?.titel ?? '')}</td><td>${c}</td></tr>`).join('') || '<tr><td colspan="3">Noch keine Verkäufe.</td></tr>'}
    </table>
  </section>
  <section class="sect wrap">
    <p class="label">Käufe</p>
    <div class="scroll"><table><tr><th>Datum</th><th>E-Mail</th><th>Gekauft</th><th>Betrag</th><th>Link</th></tr>
      ${kaeufe.map(k => `<tr><td>${new Date(k.created_at * 1000).toLocaleDateString('de-CH')}</td><td>${esc(k.email)}</td>
        <td>${[...k.hat].sort((a, b) => a - b).map(was).join(', ')}</td><td>${chf(gezahlt(k.hat))}</td>
        <td><a href="/k/${k.token}">öffnen</a></td></tr>`).join('')}
    </table></div>
  </section>
</main>`);
}

const nichtGefunden = () => seite('Nicht gefunden', `${kopfzeile()}
<main><section class="sect wrap">${kopf('Nicht', 'gefunden.')}
  <p class="lead">Diese Seite gibt es nicht. <a href="/">Zur Übersicht</a></p></section></main>`, { status: 404 });

function seite(titel, body, { status = 200, headers = {}, klasse = '', refresh } = {}) {
  return new Response(`<!doctype html>
<html lang="de-CH">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#15B6B8">
<link rel="icon" href="/flow-logo.jpg">
${refresh ? `<meta http-equiv="refresh" content="3;url=${esc(refresh)}">` : ''}
<title>${esc(titel)}</title>
<style>${CSS}</style>
</head>
<body class="${klasse}">
${body}
</body>
</html>`, { status, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex', ...headers } });
}

// Look: Farben und Logo aus der CI von flowdance.ch (Türkis, helles Aqua, warmes Dunkelgrau, Weiss).
// Dazu Plakat-Muster: Laufband, Sticker, Klebestreifen, dicke Linien, Programm als Zeilen, schmale Plakatschrift.
const CSS = `
:root {
  --paper: #F4F4F4; --card: #FFFFFF; --ink: #2B2A28; --text: #444340; --mute: #66635D; --dark: #444340;
  --teal: #15B6B8; --aqua: #4BE2D3; --teal-ink: #0A7477; --teal-big: #0C9092;   /* die zwei dunkleren Töne nur für Text */
  --display: "Big Shoulders", "Arial Narrow", "Helvetica Neue", Arial, sans-serif;
  --mono: "Space Mono", ui-monospace, Menlo, Consolas, monospace;
  --b: 2px solid var(--ink); --r: 10px; --shadow: 4px 4px 0 var(--ink);
}
@font-face { font-family: "Space Grotesk"; src: url(/space-grotesk.ttf) format("truetype"); font-weight: 300 700; font-display: swap; }
@font-face { font-family: "Big Shoulders"; src: url(/big-shoulders.woff2) format("woff2"); font-weight: 800 900; font-display: swap; }
@font-face { font-family: "Space Mono"; src: url(/space-mono-bold.woff2) format("woff2"); font-weight: 700; font-display: swap; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-text-size-adjust: 100%; overflow-x: clip; }
body { background: var(--paper); color: var(--text); font-family: "Space Grotesk", "Helvetica Neue", Arial, sans-serif;
       font-size: 16px; line-height: 1.5; -webkit-font-smoothing: antialiased; overflow-x: clip; }
a { color: inherit; }
img, svg, video { display: block; max-width: 100%; }
:focus-visible { outline: 3px solid var(--teal-ink); outline-offset: 3px; }
.wrap { max-width: 860px; margin: 0 auto; padding-left: 16px; padding-right: 16px; }
.sect { padding-top: 44px; }
.label { font: 700 12px/1.4 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--teal-ink); }
h2, .h1 { margin-top: 8px; font: 900 clamp(46px, 13vw, 88px)/1.03 var(--display); text-transform: uppercase; color: var(--ink); }
h2 em, .h1 em { font-style: normal; color: var(--teal-big); }
.lead { margin-top: 20px; max-width: 30em; font-size: 18px; line-height: 1.4; color: var(--ink); }
.note { margin-top: 20px; border: var(--b); border-radius: var(--r); background: var(--card); padding: 12px 14px; font-size: 15px; color: var(--ink); }
.tip { margin-top: 20px; max-width: 44em; font-size: 14px; color: var(--mute); }

.ticker { background: var(--teal); color: var(--ink); border-bottom: var(--b); overflow: hidden; white-space: nowrap; }
.run { display: inline-flex; align-items: center; padding: 9px 0; animation: lauf 40s linear infinite;
       font: 700 12px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
.run > * { margin-right: 20px; flex: none; }
@keyframes lauf { to { transform: translateX(-50%); } }

.top { border-bottom: var(--b); }
.top .wrap { display: flex; align-items: center; height: 64px; }
.brand { display: flex; align-items: center; gap: 10px; text-decoration: none; color: var(--ink); }
.brand img { width: 42px; height: 42px; border-radius: 50%; border: var(--b); background: #fff; }
.brand b { font: 900 25px/1 var(--display); letter-spacing: .02em; text-transform: uppercase; }
.brand span { font: 700 12px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--teal-ink); }

.hero { padding-top: 34px; }
.sticker { display: inline-block; transform: rotate(-2.5deg); background: var(--aqua); color: var(--ink); border: var(--b); border-radius: 6px;
           padding: 8px 12px; font: 700 12px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; }
.hero > div { container-type: inline-size; }
.over { position: relative; margin-top: 24px; font: 900 22vw/.8 var(--display); font-size: 25cqi; text-transform: uppercase; }
.over span { display: block; white-space: nowrap; }
.over span:first-child { position: absolute; inset: 0; color: var(--aqua); transform: translate(-.05em, -.045em); }
.over span:last-child { position: relative; color: var(--teal-big); mix-blend-mode: multiply; }
.preise { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
.pill { display: inline-flex; align-items: center; gap: 8px; background: var(--card); color: var(--ink); border: var(--b); border-radius: 999px;
        padding: 8px 14px; font: 700 12px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; }
.pill b { font: 900 22px/1 var(--display); letter-spacing: .01em; }
.pill.y { background: var(--aqua); }
.pill.out { background: none; border-style: dashed; border-color: var(--mute); color: var(--mute); }
.preise { flex-wrap: nowrap; }   /* drei Kacheln in einer Reihe, auch auf dem Handy: Label über dem Preis */
.preise .pill { flex: 1; flex-direction: column; align-items: flex-start; gap: 6px; border-radius: var(--r); padding: 10px 12px; }
.preise .pill b { font-size: 28px; }
.taped { position: relative; margin: 36px 10px 0; transform: rotate(1.8deg); border: var(--b); background: #111; }
.taped img { width: 100%; height: auto; aspect-ratio: 16/9; object-fit: cover; }
.tape { position: absolute; display: block; width: 96px; height: 28px; background: rgba(75, 226, 211, .78); }
.taped .tape:nth-of-type(1) { top: -15px; left: -20px; transform: rotate(-10deg); }
.taped .tape:nth-of-type(2) { top: -12px; right: -24px; transform: rotate(15deg); }

.strip { display: flex; gap: 3px; margin-top: 14px; }
.strip i { flex: 1; height: 8px; border-radius: 4px; background: var(--ink); transition: background .15s; }
.strip i.s { background: #D6D5D1; }
.strip i.own { background: var(--teal); }
.strip i.on { background: var(--aqua); box-shadow: inset 0 0 0 2px var(--ink); }
.strip i.p { flex: 0 0 8px; background: none; }

.alle { position: relative; display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 12px; margin-top: 20px;
        padding: 14px 12px 14px 14px; background: var(--teal); border: var(--b); border-radius: var(--r); box-shadow: var(--shadow);
        cursor: pointer; transition: transform .12s, box-shadow .12s, background .15s; }
.alle input { position: absolute; opacity: 0; pointer-events: none; }
.alle.soon { cursor: default; background: var(--card); }
.zwischen { margin-top: 48px; }
a.pill { text-decoration: none; }
html { scroll-behavior: smooth; scroll-padding-top: 16px; }
.alle .txt b { font-size: 30px; }
.alle .txt small { color: var(--ink); }
.alle:has(:focus-visible) { outline: 3px solid var(--teal-ink); outline-offset: 3px; }
.oder { margin-top: 30px; font: 700 12px/1.4 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--teal-ink); }
.list { margin-top: 12px; border-top: var(--b); }
.row { position: relative; display: grid; grid-template-columns: 30px 96px 1fr auto; align-items: center; gap: 12px;
       padding: 12px 6px 12px 4px; border-bottom: var(--b); cursor: pointer; transition: background .15s; }
.row input { position: absolute; opacity: 0; pointer-events: none; }
.num { font: 900 30px/1 var(--display); color: var(--ink); }
.thumb { display: block; aspect-ratio: 16/9; border: var(--b); border-radius: 6px; overflow: hidden; background: #111; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.txt { min-width: 0; }
.txt b { display: block; font: 800 22px/1 var(--display); letter-spacing: .01em; text-transform: uppercase; color: var(--ink); }
.txt small { display: block; margin-top: 4px; font-size: 13px; line-height: 1.3; color: var(--mute); }
.tog { display: grid; place-items: center; width: 40px; height: 40px; border: var(--b); border-radius: 50%; background: var(--card); color: var(--ink); }
.tog svg:last-child { display: none; }
.row:has(:checked), .alle:has(:checked) { background: var(--aqua); }
.row:has(:checked) small { color: var(--ink); }
:is(.row, .alle):has(:checked) .tog { background: var(--ink); color: var(--aqua); }
:is(.row, .alle):has(:checked) .tog svg:first-child { display: none; }
:is(.row, .alle):has(:checked) .tog svg:last-child { display: block; }
.row:has(:focus-visible) { outline: 3px solid var(--teal-ink); outline-offset: -3px; }
.row.soon { cursor: default; }
.row.soon .num, .row.soon .txt b { color: var(--mute); }
.row.soon .thumb { border: 2px dashed var(--mute); background: repeating-linear-gradient(-45deg, transparent 0 7px, rgba(27,27,27,.1) 7px 9px); }
.pause { padding: 7px; background: var(--ink); color: var(--paper); border-bottom: var(--b); text-align: center;
         font: 700 11px/1 var(--mono); letter-spacing: .3em; text-transform: uppercase; }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; padding: 0 18px;
       background: var(--teal); color: var(--ink); border: var(--b); border-radius: var(--r); box-shadow: var(--shadow);
       font: 700 14px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; text-decoration: none; white-space: nowrap;
       cursor: pointer; transition: transform .12s, box-shadow .12s; }
.btn:active { transform: translate(3px, 3px); box-shadow: 1px 1px 0 var(--ink); }
.btn.dark { background: var(--ink); color: var(--paper); box-shadow: none; }

.bar { position: fixed; left: 10px; right: 10px; bottom: max(12px, env(safe-area-inset-bottom)); z-index: 5; max-width: 600px; margin: 0 auto;
       display: none; flex-direction: column; gap: 8px; background: var(--ink); color: var(--paper); border-radius: 16px; padding: 12px;
       box-shadow: 0 14px 34px -12px rgba(0, 0, 0, .6); }
.shop:has(:checked) .bar { display: flex; }
@supports not selector(:has(a)) { .bar { display: flex; } }
.bar label, .bar-l { font: 700 11px/1.2 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: #CFCECA; }
.bar label { padding-left: 4px; }
.bar input { width: 100%; min-height: 48px; padding: 0 14px; border: 2px solid var(--paper); border-radius: var(--r); background: var(--paper);
             color: var(--ink); font: inherit; font-size: 16px; }
.bar-r { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 2px 0 0 4px; }
.bar-p { margin-top: 4px; font: 900 34px/1 var(--display); color: var(--aqua); }
.bar .btn { box-shadow: none; }

.notiz { position: relative; margin: 30px 4px 0; transform: rotate(-1deg); background: var(--aqua); color: var(--ink); border: var(--b);
         border-radius: 6px; padding: 20px 16px 16px; box-shadow: var(--shadow); }
.notiz b { display: flex; align-items: center; gap: 8px; font: 900 32px/1 var(--display); text-transform: uppercase; }
.notiz b svg { width: 26px; height: 26px; }
.notiz p { margin-top: 8px; font-size: 15px; line-height: 1.4; }
.notiz .tape { top: -15px; left: 50%; margin-left: -48px; transform: rotate(3deg); background: rgba(21, 182, 184, .7); }
.notiz.wait { background: var(--card); }

.clips { display: grid; gap: 30px; margin-top: 34px; }
.clip { position: relative; background: var(--card); border: var(--b); border-radius: var(--r); box-shadow: var(--shadow); padding: 10px; }
.clip > .tape { top: -15px; left: 24px; transform: rotate(-5deg); }
.clip video { width: 100%; aspect-ratio: 16/9; background: #111; border: var(--b); border-radius: 6px; }
.cmeta { display: flex; align-items: center; gap: 12px; padding: 12px 2px; }
.cmeta .num { font-size: 44px; color: var(--teal-big); }
.cmeta .txt b { font-size: 26px; }
.clip .btn { width: 100%; }

.block { margin-top: 64px; padding: 44px 0 50px; border-top: var(--b); border-bottom: var(--b); background: var(--teal); color: var(--ink); }
.block h2 { margin-top: 0; }
.block p { margin-top: 12px; max-width: 32em; }
.inline { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; max-width: 540px; }
.inline label { flex: 0 0 100%; margin-bottom: -4px; font: 700 12px/1.3 var(--mono); letter-spacing: .08em; text-transform: uppercase; }
.inline input { flex: 1 1 200px; min-width: 0; min-height: 48px; padding: 0 14px; border: var(--b); border-radius: var(--r); background: var(--card);
                color: var(--ink); font: inherit; font-size: 16px; }

.foot { margin-top: 0; padding-top: 38px; overflow: hidden; background: var(--dark); color: #E4E3DF; font-size: 13.5px; line-height: 1.6; }
main:not(:has(.block)) + .foot { margin-top: 64px; }
body:has(.shop :checked) .foot { padding-bottom: 170px; }
.foot .label { color: var(--aqua); }
.foot p { margin-top: 10px; max-width: 46em; }
.foot b { color: #fff; font-weight: 500; }
.wordmark { margin: 30px 0 -.07em; font: 900 clamp(40px, 13.4vw, 122px)/.76 var(--display); text-transform: uppercase; white-space: nowrap; color: var(--paper); }

.admin { padding-bottom: 70px; }
.kpi { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 26px; }
.kpi div { background: var(--aqua); color: var(--ink); border: var(--b); border-radius: var(--r); box-shadow: var(--shadow); padding: 14px 12px 12px;
           font: 700 11px/1.35 var(--mono); letter-spacing: .06em; text-transform: uppercase; }
.kpi div:nth-child(2) { background: var(--teal); }
.kpi div:nth-child(3) { background: var(--card); }
.kpi b { display: block; margin-bottom: 6px; font: 900 clamp(32px, 9vw, 58px)/1 var(--display); }
table { width: 100%; margin-top: 8px; border-collapse: collapse; font-size: 15px; color: var(--ink); }
th, td { text-align: left; padding: 11px 16px 11px 0; border-bottom: var(--b); vertical-align: top; white-space: nowrap; }
th:last-child, td:last-child { padding-right: 0; }
th { font: 700 11px/1.3 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--teal-ink); }
.scroll { overflow-x: auto; }

/* Demo-Zahlseite: bewusst neutral, sie steht für die fremde Seite von Payrexx */
body.pay { background: #fff; color: var(--ink); }
.pay main { max-width: 460px; margin: 0 auto; padding: 30px 16px 40px; }
.demo { display: inline-block; margin-bottom: 20px; transform: rotate(-2deg); background: var(--aqua); color: var(--ink); border: var(--b); border-radius: 6px;
        padding: 7px 10px; font: 700 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
.merchant { font-size: 19px; font-weight: 500; letter-spacing: -.02em; }
.via { margin-top: 2px; font-size: 13px; color: var(--mute); }
.card { margin-top: 18px; border: 1px solid #e6e5e1; border-radius: 14px; padding: 4px 16px; }
.line { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; font-size: 14.5px; border-bottom: 1px solid #efeeea; }
.line span:last-child { color: var(--mute); }
.line.total { border: none; font-weight: 500; font-size: 16px; }
.line.total span:last-child { color: var(--ink); }
.lbl { margin: 20px 0 8px; font-size: 12px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; color: var(--mute); }
.field { border: 1px solid #e0dfdb; border-radius: 12px; padding: 13px 14px; font-size: 15px; overflow-wrap: anywhere; }
.pm { display: flex; align-items: center; justify-content: space-between; min-height: 52px; border: 1px solid #e0dfdb; border-radius: 12px;
      padding: 14px; font-size: 15px; font-weight: 500; margin-bottom: 10px; cursor: pointer; }
.pm small { font-size: 12.5px; font-weight: 400; color: var(--mute); margin-left: 6px; }
.pm:has(:checked) { border: 2px solid var(--ink); padding: 13px; }
.pm input { width: 20px; height: 20px; accent-color: var(--ink); }
.twint { background: #000; color: #fff; font-weight: 700; font-size: 12.5px; letter-spacing: .04em; padding: 5px 9px 4px; border-radius: 6px; }
.paybtn { width: 100%; min-height: 54px; margin-top: 8px; background: var(--ink); color: #fff; border: 0; border-radius: 14px; font: inherit; font-size: 16px;
          font-weight: 500; cursor: pointer; }
.secure { margin-top: 14px; text-align: center; font-size: 12.5px; color: var(--mute); line-height: 1.6; }

@media (hover: hover) {
  .row:not(.soon):not(:has(:checked)):hover { background: #E1F7F4; }
  .btn:hover, .alle:hover { transform: translate(-1px, -1px); box-shadow: 5px 5px 0 var(--ink); }
  .btn.dark:hover, .bar .btn:hover { transform: none; box-shadow: none; filter: brightness(1.08); }
}
@media (min-width: 720px) {
  .top .wrap { height: 76px; }
  .hero { display: grid; grid-template-columns: 1.1fr .9fr; align-items: center; gap: 44px; padding-top: 56px; }
  .taped { margin-top: 0; }
  .sect { padding-top: 64px; }
  .row { grid-template-columns: 44px 168px 1fr auto; gap: 20px; padding: 14px 10px 14px 6px; }
  .num { font-size: 40px; }
  .txt b { font-size: 30px; }
  .alle .txt b { font-size: 40px; }
  .txt small { font-size: 14.5px; }
  .clips { grid-template-columns: 1fr 1fr; }
  .clip.gross { grid-column: 1 / -1; }
}
@media (min-width: 960px) {   /* Text bleibt in der Spalte, das Bild wächst nach rechts hinaus */
  .hero { grid-template-columns: 420px minmax(0, 720px); max-width: none; margin-left: max(0px, (100% - 860px) / 2); padding-right: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .run { animation: none; }
  .btn, .row, .alle, .strip i { transition: none; }
}
`;
