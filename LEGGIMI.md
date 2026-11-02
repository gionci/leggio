# Leggio

Allenatore per chitarra classica nel browser, per gli alunni: si sceglie un brano, la partitura scorre,
l'app ascolta col microfono e giudica ritmo e note, trova i passaggi difficili e li fa allenare a ritroso.
Funziona su telefono e computer, senza login e senza server: è un sito statico.

**Online:** <https://gionci.github.io/leggio/> · demo senza chitarra: <https://gionci.github.io/leggio/?demo>
Un brano preciso: `?brano=sor_op35_no07` (l'indirizzo si aggiorna da solo quando si cambia brano: si può copiare e mandare).

I brani **non** stanno qui: sono la biblioteca `leggio-brani` (repo a parte, <https://gionci.github.io/leggio-brani/>).
L'app legge `elenco.json` della biblioteca e carica il MusicXML scelto quando serve.

Nasce come copia generalizzata del Leggio Sor (`~/Work/leggio-sor`, che resta com'era, con il suo server e i suoi due brani);
stesso motore d'ascolto del Leggio Mertz (`~/Work/mertz-leggio`).

## Cosa fa (le schede)
- **Brano**: partitura su una riga che scorre; «Ascolta» (chitarra sintetica), «Suona e valuta» col metronomo,
  tutto il brano o da battuta a battuta. Resoconto: ritmo, regolarità, note, battuta per battuta.
- **Passaggi difficili**: dagli errori delle ultime 5 prove, i tratti dove si sbaglia di più; «Allena» li porta all'allenamento.
- **Allenamento a ritroso**: si parte dall'ultima nota del passaggio e si aggiunge una nota alla volta dopo N giri riusciti.
  Modi *mano destra* (stesso ritmo sulle corde a vuoto, con l'esagramma p-i-m-a), *mano sinistra* (senza tempo, l'app
  aspetta la nota giusta), *insieme* (prima le dita, poi il tempo).
- **Accordatore** (YIN) e **Metronomo** (click acuto che l'ascolto non sente).
- **Battito da vedere** (2/11, richiesta dopo la prova su iPhone: il click si sente poco): sopra la partitura, mentre si
  ascolta, si prova o ci si allena, e nella scheda Metronomo, una pallina rimbalza di battito in battito e tocca terra sul
  colpo. Le celle sono i battiti della battuta (la prima bordata e rossa quando tocca); niente lampi. Segue l'orologio audio
  meno la latenza d'uscita. Sul telefono la pagina scorre da sola per mostrarla.
- **Crediti**: fonte, trascrittore e licenza di ogni brano; «Fonte e licenza» accanto al titolo per il brano aperto.

## Architettura
Tutto JavaScript nel browser, nessuna compilazione.

| file | cosa fa |
|---|---|
| `index.html` | pagina, stile (responsive: sotto 600 px una colonna, tasti da 44 px sugli schermi a tocco), finestre Microfono / Crediti / Impostazioni |
| `app.js` | l'app: menu dei brani, partitura (OpenSheetMusicDisplay), audio, prove, passaggi, allenamento, accordatore, metronomo |
| `brano.js` | dal MusicXML ai dati dell'allenatore (traduzione di `strumenti/dati.py` del Leggio Sor), vedi sotto |
| `analisi.js` | motore d'ascolto: attacchi e giudizio delle note (lo stesso del Leggio Mertz) |
| `cattura-worklet.js` | AudioWorklet che passa i campioni del microfono all'app |
| `vendor/opensheetmusicdisplay.min.js` | disegno della partitura (BSD-3) |
| `test/browser.js` | collaudo in Chromium senza schermo |
| `test/accordatore.js` | prova dell'accordatore su corde sintetiche |

**Dove stanno i brani.** `app.js` legge da `../leggio-brani/` (su GitHub Pages: `gionci.github.io/leggio` → `gionci.github.io/leggio-brani`,
stessa origine, https: il microfono funziona). Per provare un'altra biblioteca: `?brani=<indirizzo>/`.

**Preparare un brano (`brano.js`).** Al caricamento, dal MusicXML (formato «partwise», non compresso):
- attacchi (istante in quarti, note MIDI ad altezza reale, battuta), legature di valore unite, acciaccature escluse;
- suoni con inizio e fine, per la chitarra sintetica;
- battute (l'anacrusi «implicit» dura quel che contiene);
- **corde e tasti**: ricerca a fascio (una nota per corda, mano entro 4 tasti, pochi spostamenti, corde a vuoto e posizioni basse
  preferite; barre «CIII», «0» e `<string>` scritti come vincoli). Se un accordo non entra nella mano, il vincolo si allenta
  per gradi invece di fallire. Servono alla «mano destra»: sono proposte, non diteggiature d'autore;
- **accordatura**: normale; se il brano scende sotto il Mi basso, la sesta si abbassa fino alla nota più grave (es. Re);
  `"accordatura": [64,59,55,50,45,38]` in `elenco.json` la impone;
- **tempo**: da `<sound tempo>` o `<metronome>`, sennò dalla parola (Andante, Allegro…), sennò 60 al minuto.
  L'app propone il 70% per le prove e il 55% per l'allenamento.
Limite: ritornelli e prima/seconda volta non si srotolano (il brano si legge una volta).
Ci mette meno di un secondo anche sui brani lunghi; il risultato resta in memoria finché la pagina è aperta.

**Audio e telefoni.** Il contesto audio si crea e si riprende al primo tocco (`pointerdown`), come vogliono iOS/Safari;
`resume()` è chiamato prima di ogni `await`. Prima di chiedere il microfono, una volta sola, la finestra «Il microfono» spiega
a cosa serve; se il permesso è negato l'app dice dove riattivarlo. Senza `getUserMedia` (pagina non https) lo dice.
Su iPhone il tasto silenzioso spegne il metronomo: lo dice la finestra del microfono.

**Dati di chi suona.** Solo nel browser (`localStorage`, prefisso `leggio_`): impostazioni, tarature, prove, progressi
dell'allenamento. «Scarica prove e allenamenti» in Impostazioni ne fa un file. Nessun registro su server (il Leggio Sor
mandava ogni prova a `strumenti/server.py`: qui tolto).

## Avviarlo in locale
Le due cartelle devono essere sorelle (`~/Work/leggio` e `~/Work/leggio-brani`); si serve la cartella che le contiene:

    cd ~/Work && python3 -m http.server 8811 --bind 127.0.0.1
    # poi http://127.0.0.1:8811/leggio/   (localhost: il microfono funziona anche senza https)
    #      http://127.0.0.1:8811/leggio/?demo

(Sul server la 8790 è già occupata da un altro servizio.) Da un altro computer: tunnel ssh `-L 8811:127.0.0.1:8811`.
Prima volta con la chitarra: **Impostazioni** → microfono → «Misura il silenzio» → «Misura il ritardo».

## Collaudo
    TMPDIR=~/.cache/claude-tmp node test/browser.js http://127.0.0.1:8811/leggio/ <cartella foto>
    node test/accordatore.js app.js

`browser.js` (Chromium headless, protocollo DevTools, nessuna libreria): carica **tutti** i brani di `elenco.json` e controlla
che si preparino e si disegnino senza errori; fotografa a 390 px (telefono) e 1400 px (desktop) e controlla che la pagina non
scorra di lato; poi in `?demo` (chitarra sintetica con errori, microfono spento) prova tre brani: due prove valutate,
passaggi difficili, allenamento a ritroso. `VELOCE=1` salta la demo, `BRANI=a,b,c` sceglie i tre brani.

Collaudo del 2/11/2026: 58/58 brani, pagina larga 390/1400 px senza scorrimento laterale, demo su Sor op. 35 n. 7,
Carcassi op. 60 n. 3, Giuliani op. 50 n. 1 (punteggi 79–85, catena a ritroso che avanza), accordatore < 0,2 cent.
**Non provato:** iPhone/Safari vero e chitarra vera (le soglie vengono dal Leggio Mertz/Sor).

## Pubblicare
GitHub Pages dal ramo `main`, cartella radice, account `gionci`:

    git add -A && git commit -m "…" && git push      # Pages si aggiorna da solo in 1-2 minuti

Prima pubblicazione (già fatta): `gh repo create gionci/leggio --public --source . --push` e
`gh api -X POST repos/gionci/leggio/pages -f "source[branch]=main" -f "source[path]=/"`. Stessa cosa per `leggio-brani`.
Il file `.nojekyll` evita che GitHub rielabori i file.

## Licenze
Codice: GPL 3 (`LICENSE`). OpenSheetMusicDisplay: BSD-3. Brani: vedi `leggio-brani` (MusicXML CC BY-SA 4.0, nel rispetto della
licenza Mutopia di ogni brano).
