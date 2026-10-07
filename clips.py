# -*- coding: utf-8 -*-
"""Legt Clips in den R2-Bucket: pro Nummer die Auslieferungsfassung und ein Standbild.

  python3 clips.py demo                                rund 25 s pro Nummer aus dem Handheld-Material, lokal
  python3 clips.py upload <ordner> [--remote]          fertige Einzelclips kodieren und hochladen
  python3 clips.py show <datei> [--remote]             die ganze Show als ein Video
  python3 clips.py hero <bild|video> [sek] [--remote]  das Bild oben auf der Startseite (und Standbild der ganzen Show)

Im Ordner zählt die erste Zahl im Dateinamen als Nummer («04 Clouds.mp4»). Hochgeladen wird nur,
was in clips.js steht. So kommt keine gesperrte Nummer in den Shop.
Ohne --remote landet alles im lokalen Speicher von «wrangler dev».
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


def kodieren(quelle, ziel, laenge=None, maxrate=8):
    """Auslieferungsfassung: H.264 in 1080p mit höchstens 8 Mbit/s, AAC, faststart. Spielt auf jedem Handy."""
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', quelle, *(['-t', str(laenge)] if laenge else []),
                    '-vf', 'scale=-2:1080', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
                    '-maxrate', f'{maxrate}M', '-bufsize', f'{2 * maxrate}M', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', ziel], check=True)


def ablegen(datei, schluessel, typ, ort):
    mb = os.path.getsize(datei) / 1e6
    assert mb < MAX_MB, f'{schluessel}: {mb:.0f} MB, erlaubt sind {MAX_MB}. Mit tieferem -maxrate kodieren.'
    subprocess.run(['npx', 'wrangler', 'r2', 'object', 'put', f'{BUCKET}/{schluessel}', '--file', datei,
                    '--content-type', typ, ort], check=True, cwd=HIER, capture_output=True)
    return mb


def hochladen(nr, quelle, ort, tmp, laenge=None):
    film, bild = os.path.join(tmp, f'nr{nr:02d}.mp4'), os.path.join(tmp, f'nr{nr:02d}.jpg')
    kodieren(quelle, film, laenge)
    # Standbild nicht vom Anfang: Dort ist die Bühne oft noch dunkel.
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(min(20, dauer(film) / 3)), '-i', film,
                    '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', bild], check=True)
    mb = ablegen(film, f'{JAHR}/nr{nr:02d}.mp4', 'video/mp4', ort)
    ablegen(bild, f'{JAHR}/nr{nr:02d}.jpg', 'image/jpeg', ort)
    print(f'Nr. {nr:02d}  {mb:6.1f} MB  {os.path.basename(quelle)}', flush=True)


def show(quelle, ort):
    """Die ganze Show als ein Video. Mit 4 Mbit/s statt 8: Zwei Stunden sollen ladbar bleiben (rund 4 GB)."""
    film = os.path.splitext(quelle)[0] + '.shop.mp4'   # neben der Quelle: Stunden an Kodierzeit gehen so nicht verloren
    kodieren(quelle, film, maxrate=4)
    mb = os.path.getsize(film) / 1e6
    if mb >= MAX_MB:
        sys.exit(f'{film}: {mb:.0f} MB, das ist zu gross für wrangler. Mit rclone hochladen:\n'
                 f'  rclone copyto "{film}" r2:{BUCKET}/{JAHR}/show.mp4')
    ablegen(film, f'{JAHR}/show.mp4', 'video/mp4', ort)
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
