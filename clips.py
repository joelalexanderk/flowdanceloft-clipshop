# -*- coding: utf-8 -*-
"""Legt Clips in den R2-Bucket: pro Nummer die Auslieferungsfassung und ein Standbild.

  python3 clips.py demo                                rund 25 s pro Nummer aus dem Handheld-Material, lokal
  python3 clips.py upload <ordner> [--remote]          fertige Einzelclips kodieren und hochladen
  python3 clips.py show <datei|liste.txt> [--remote]   die ganze Show als ein Video (liste.txt: ffmpeg-concat-Liste)
  python3 clips.py hero <bild|video> [sek] [--remote]  das Bild oben auf der Startseite (und Standbild der ganzen Show)

Im Ordner zählt die erste Zahl im Dateinamen als Nummer («04 Clouds.mp4»). Hochgeladen wird nur,
was in clips.js steht. So kommt keine gesperrte Nummer in den Shop.
Ohne --remote landet alles im lokalen Speicher von «wrangler dev».

Dateien über 300 MB (die ganze Show) gehen über die S3-Schnittstelle von R2. Dafür in der Umgebung:
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID und R2_TOKEN (Wert des R2-API-Tokens, Rechte «Object Read & Write»).
"""
import csv, os, re, subprocess, sys, tempfile

HIER = os.path.dirname(os.path.abspath(__file__))
SHOW = os.path.join(HIER, '..', '..', '02 | The Space Between')
BUCKET = 'flowdance-clips'
MAX_MB = 300   # «wrangler r2 object put» nimmt höchstens rund 315 MB pro Datei

_clips_js = open(os.path.join(HIER, 'clips.js'), encoding='utf-8').read()
JAHR = re.search(r"jahr: '(\d+)'", _clips_js).group(1)
FREI = {int(n) for n in re.findall(r'\{ nr: (\d+),', _clips_js)}
assert len(FREI) >= 20, FREI


def dauer(datei):
    aus = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', datei],
                         check=True, capture_output=True, text=True).stdout
    return float(aus)


def kodieren(quelle, ziel, laenge=None, maxrate=None):
    """Auslieferungsfassung: H.264 in 1080p mit höchstens 8 Mbit/s, AAC, faststart. Spielt auf jedem Handy.

    Lange Clips bekommen weniger, damit die Datei unter MAX_MB bleibt (Grenze von wrangler)."""
    if maxrate is None:
        maxrate = min(8, round(MAX_MB * 0.9 * 8 / (laenge or dauer(quelle)) - 0.25, 1))
    eingang = ['-f', 'concat', '-safe', '0', '-i', quelle] if quelle.endswith('.txt') else ['-i', quelle]
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *eingang, *(['-t', str(laenge)] if laenge else []),
                    '-vf', 'scale=-2:1080', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
                    '-maxrate', f'{maxrate}M', '-bufsize', f'{2 * maxrate}M', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', ziel], check=True)


def ablegen(datei, schluessel, typ, ort):
    mb = os.path.getsize(datei) / 1e6
    assert mb < MAX_MB, f'{schluessel}: {mb:.0f} MB, erlaubt sind {MAX_MB}. Mit tieferem -maxrate kodieren.'
    subprocess.run(['npx', 'wrangler', 'r2', 'object', 'put', f'{BUCKET}/{schluessel}', '--file', datei,
                    '--content-type', typ, ort], check=True, cwd=HIER, capture_output=True)
    return mb


def ablegen_gross(datei, schluessel, typ):
    """Über die S3-Schnittstelle von R2, in Teilen. Das Secret ist der SHA-256 des Token-Werts."""
    import boto3, hashlib
    s3 = boto3.client('s3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                      aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], region_name='auto',
                      aws_secret_access_key=hashlib.sha256(os.environ['R2_TOKEN'].encode()).hexdigest())
    s3.upload_file(datei, BUCKET, schluessel, ExtraArgs={'ContentType': typ})
    return os.path.getsize(datei) / 1e6


def hochladen(nr, quelle, ort, tmp, laenge=None):
    film, bild = os.path.join(tmp, f'nr{nr:02d}.mp4'), os.path.join(tmp, f'nr{nr:02d}.jpg')
    kodieren(quelle, film, laenge)
    # Standbild nicht vom Anfang: Dort ist die Bühne oft noch dunkel.
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(dauer(film) * 0.4), '-i', film,
                    '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', bild], check=True)
    mb = ablegen(film, f'{JAHR}/nr{nr:02d}.mp4', 'video/mp4', ort)
    ablegen(bild, f'{JAHR}/nr{nr:02d}.jpg', 'image/jpeg', ort)
    print(f'Nr. {nr:02d}  {mb:6.1f} MB  {os.path.basename(quelle)}', flush=True)


def show(quelle, ort):
    """Die ganze Show als ein Video. Mit 4 Mbit/s statt 8: Zwei Stunden sollen ladbar bleiben (rund 4 GB)."""
    film = os.path.splitext(quelle)[0] + '.shop.mp4'   # neben der Quelle: Stunden an Kodierzeit gehen so nicht verloren
    kodieren(quelle, film, maxrate=4)
    mb = os.path.getsize(film) / 1e6
    if mb < MAX_MB:
        ablegen(film, f'{JAHR}/show.mp4', 'video/mp4', ort)
    elif ort == '--remote' and 'R2_TOKEN' in os.environ:
        ablegen_gross(film, f'{JAHR}/show.mp4', 'video/mp4')
    else:
        sys.exit(f'{film}: {mb:.0f} MB, zu gross für wrangler. Mit --remote und R2_TOKEN usw. hochladen (siehe oben).')
    print(f'Ganze Show  {mb:6.1f} MB  {os.path.basename(quelle)}', flush=True)


def hero(quelle, sekunde, ort, tmp):
    bild = os.path.join(tmp, 'hero.jpg')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(sekunde), '-i', quelle, '-frames:v', '1',
                    '-vf', 'scale=1600:-2', '-q:v', '3', bild], check=True)
    ablegen(bild, f'{JAHR}/hero.jpg', 'image/jpeg', ort)
    print(f'Hero-Bild  {os.path.basename(quelle)} bei {sekunde} s', flush=True)


def demo(tmp):
    """Nimmt pro Nummer den längsten Handheld-Clip aus den Shotlisten v2 und v3.

    Nur diese beiden: Ihre Zuordnung Clip zu Nummer stammt aus dem Audio-Sync, die von v1 war geraten.
    """
    kandidaten = {}
    for version in ('v3', 'v2'):
        liste = os.path.join(SHOW, '04 | Edit', f'aftermovie_handheld_{version}_shotliste.csv')
        for zeile in csv.DictReader(open(liste, encoding='utf-8-sig'), delimiter=';'):
            nummer = re.match(r'Nr\. ?(\d+)', zeile['Inhalt'])
            if nummer and zeile['Datei'].upper().endswith('.MP4'):
                tag = 'Day 1' if zeile['Datei'].startswith('day1_') else 'Day 2'
                pfad = os.path.join(SHOW, '03 | Footage', '01 | RAW', tag, 'handheld', zeile['Datei'])
                if os.path.exists(pfad):
                    kandidaten.setdefault(int(nummer.group(1)), set()).add(pfad)
    nummern = sorted(set(kandidaten) & FREI)
    for nr in nummern:
        hochladen(nr, max(kandidaten[nr], key=dauer), '--local', tmp, laenge=25)
    # Die «ganze Show» der Demo: alle Ausschnitte hintereinander als ein Video, dazu ein Bild vom Finale.
    liste = os.path.join(tmp, 'liste.txt')
    open(liste, 'w').write(''.join(f"file 'nr{nr:02d}.mp4'\n" for nr in nummern))
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', liste, '-c', 'copy',
                    os.path.join(tmp, 'alle.mp4')], check=True)
    show(os.path.join(tmp, 'alle.mp4'), '--local')
    hero(os.path.join(SHOW, '03 | Footage', '01 | RAW', 'Day 2', 'handheld', 'day2_flowdance_68.MP4'), 51, '--local', tmp)


def upload(ordner, ort, tmp):
    for name in sorted(os.listdir(ordner)):
        nummer = re.search(r'\d+', name)
        if not nummer or not name.lower().endswith(('.mp4', '.mov', '.m4v')):
            continue
        if int(nummer.group()) not in FREI:
            print(f'übersprungen, nicht in clips.js freigegeben: {name}')
            continue
        hochladen(int(nummer.group()), os.path.join(ordner, name), ort, tmp)


if __name__ == '__main__':
    befehl = sys.argv[1] if len(sys.argv) > 1 else ''
    ort = '--remote' if '--remote' in sys.argv else '--local'
    with tempfile.TemporaryDirectory() as tmp:
        if befehl == 'demo':
            demo(tmp)
        elif befehl == 'upload' and len(sys.argv) > 2:
            upload(sys.argv[2], ort, tmp)
        elif befehl == 'show' and len(sys.argv) > 2:
            show(sys.argv[2], ort)
        elif befehl == 'hero' and len(sys.argv) > 2:
            hero(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 and sys.argv[3][0].isdigit() else 0, ort, tmp)
        else:
            sys.exit(__doc__)
