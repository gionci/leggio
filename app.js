// app.js — Leggio: per ogni brano della biblioteca (leggio-brani) partitura che scorre, ascolto, prova valutata,
// passaggi difficili, allenamento a ritroso (mano destra / mano sinistra / insieme), accordatore e metronomo.
// Il motore d'ascolto (attacchi e note) è analisi.js, lo stesso del Leggio Mertz e del Leggio Sor.
// Sito statico: niente server, i progressi restano nel browser di chi suona (localStorage, prefisso «leggio_»).
"use strict";
const $ = id => document.getElementById(id);
const A = window.Analisi;
const CORDE_STD = [64, 59, 55, 50, 45, 40];              // corda 1..6, accordatura normale
const corde = () => (B && B.accordatura) || CORDE_STD;     // il brano può chiedere una scordatura (sesta in Re)
// unità del battito: la semiminima puntata nei tempi composti
const U = () => (B && B.battito === 1.5 ? "♩." : "♩");
const NOMI = ["Do", "Do♯", "Re", "Mi♭", "Mi", "Fa", "Fa♯", "Sol", "Sol♯", "La", "Si♭", "Si"];
const nome = m => NOMI[m % 12] + (Math.floor(m / 12) - 1);

// ---------- memoria (solo in questo browser) ----------
const mem = {
  leggi(k, d) { try { const v = localStorage.getItem("leggio_" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  scrivi(k, v) { try { localStorage.setItem("leggio_" + k, JSON.stringify(v)); } catch (e) { /* niente */ } }
};
const imp = Object.assign({ mic: "", la: 440, minimo: null, ritardo: null, brano: "", micSpiegato: false, bpmBrano: {}, bpmAllena: {},
  modo: "insieme", fase: "dita", richiesti: 3, tolleranza: 8, metAllena: true, sudd: false, progressi: {}, met: { bpm: 60, misura: 4, sudd: 3 } },
  mem.leggi("impostazioni", {}));
if (imp.tolleranza > 20) imp.tolleranza = 8;           // prima era in ms fissi, ora in % del battito
const salvaImp = () => mem.scrivi("impostazioni", imp);
const prove = mem.leggi("prove", {});            // id brano -> [{data, bpm, da, a, punteggio, tempo, note, err: {k: [e, ms, sbagliata]}}]
const diario = mem.leggi("diario", []);          // allenamenti: [{data, brano, da, a, modo, bpm, giri, riusciti, completo}]

// ?demo: niente microfono, l'app «suona» da sola una chitarra sintetica con qualche errore
const DEMO = new URLSearchParams(location.search).has("demo");
// ?demo&sbando=120: il chitarrista finto esita: una nota su quattro arriva dopo una pausa di 120-600 ms
const SBANDO = +(new URLSearchParams(location.search).get("sbando") || 0) / 1000;
// la biblioteca: elenco.json e i MusicXML. Pubblicata accanto all'app (gionci.github.io/leggio-brani),
// in locale nella cartella sorella; ?brani=<indirizzo> per provarne un'altra.
const BRANI = (new URLSearchParams(location.search).get("brani") || "../leggio-brani/").replace(/\/?$/, "/");
let INDICE = null, B = null, osmd = null;
const cacheBrani = {};
let linea = [], rigo = { su: 60, giu: 110 }, larghezza = 0;
let corsa = null;        // ascolto, giro a tempo o giro in attesa in corso
let al = null;           // allenamento a ritroso in corso
let pannello = "brano";

// ---------- audio ----------
let ctx = null, flusso = null, nodoMic = null, cattura = null, analizzatore = null, ingresso = null;
let ascoltatori = [];    // chi riceve i blocchi del microfono: f(inizio in campioni, Float32Array)

async function apriContesto() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: "interactive" });
    // iOS/Safari: il contesto parte solo dentro un tocco; resume() subito, prima di ogni await
    if (ctx.state === "suspended") ctx.resume();
    await ctx.audioWorklet.addModule("cattura-worklet.js");
    // un filo di segnale (-120 dB) sempre in uscita: con l'uscita muta Chromium può fermare il thread audio
    // e il microfono perde pezzi fra un giro e l'altro
    const filo = ctx.createConstantSource();
    filo.offset.value = 1e-6;
    filo.connect(ctx.destination);
    filo.start();
  }
  if (ctx.state === "suspended") await ctx.resume();
}
async function apriAudio() {
  await apriContesto();
  if (!ingresso) {
    ingresso = ctx.createGain();
    cattura = new AudioWorkletNode(ctx, "cattura");
    cattura.port.onmessage = e => { for (const f of ascoltatori.slice()) f(e.data.inizio, e.data.dati); };
    ingresso.connect(cattura);
    const muto = ctx.createGain(); muto.gain.value = 0;     // il nodo va collegato all'uscita per essere eseguito
    cattura.connect(muto).connect(ctx.destination);
    analizzatore = ctx.createAnalyser();
    analizzatore.fftSize = 4096;
    ingresso.connect(analizzatore);
  }
  if (DEMO) { $("livelloTesto").textContent = "demo: chitarra sintetica"; return; }
  if (!flusso) {
    await spiegaMicrofono();
    const vincoli = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (imp.mic) vincoli.deviceId = { exact: imp.mic };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      avvisoMicrofono("Questo browser non dà il microfono alla pagina (serve https e un browser recente: Chrome, Safari, Firefox).");
      throw new Error("niente getUserMedia");
    }
    try {
      try {
        flusso = await navigator.mediaDevices.getUserMedia({ audio: vincoli });
      } catch (e) {
        if (imp.mic && e.name !== "NotAllowedError") { imp.mic = ""; salvaImp(); delete vincoli.deviceId; flusso = await navigator.mediaDevices.getUserMedia({ audio: vincoli }); }
        else throw e;
      }
    } catch (e) {
      avvisoMicrofono(e.name === "NotAllowedError" || e.name === "SecurityError"
        ? "Il microfono è bloccato per questa pagina. Riattivalo dal lucchetto accanto all'indirizzo (sul telefono: Impostazioni del browser → Siti → Microfono) e ricarica."
        : e.name === "NotFoundError" ? "Non trovo nessun microfono collegato." : "Il microfono non parte: " + (e.message || e.name));
      throw e;
    }
    if (ctx.state === "suspended") await ctx.resume();
    nodoMic = ctx.createMediaStreamSource(flusso);
    nodoMic.connect(ingresso);
    const traccia = flusso.getAudioTracks()[0];
    $("livelloTesto").textContent = traccia ? traccia.label.replace(/\s*\(.*\)$/, "").slice(0, 28) : "microfono";
    misuraLivello();
    elencaMicrofoni();
  }
}
// prima di chiedere il microfono, una volta: a cosa serve e che il suono non esce dal dispositivo
function spiegaMicrofono() {
  if (imp.micSpiegato) return Promise.resolve();
  return new Promise(ok => {
    const d = $("dlgMic");
    $("btnMicSi").onclick = () => { imp.micSpiegato = true; salvaImp(); if (ctx && ctx.state === "suspended") ctx.resume(); d.close(); ok(); };
    d.onclose = () => ok();
    d.showModal();
  });
}
function avvisoMicrofono(t) {
  $("livelloTesto").textContent = "microfono spento";
  $("statoTesto").textContent = t;
  alert(t);
}
async function chiudiMic() {
  if (flusso) { flusso.getTracks().forEach(t => t.stop()); flusso = null; }
  if (nodoMic) { nodoMic.disconnect(); nodoMic = null; }
}
function misuraLivello() {
  const buf = new Float32Array(2048);
  const giro = () => {
    if (!analizzatore || !flusso) return;
    analizzatore.getFloatTimeDomainData(buf);
    let p = 0;
    for (const v of buf) p = Math.max(p, Math.abs(v));
    const db = 20 * Math.log10(p + 1e-9);
    const el = $("livello").firstElementChild;
    el.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + "%";
    el.style.background = db > -3 ? "var(--male)" : db > -12 ? "var(--quasi)" : "var(--bene)";
    requestAnimationFrame(giro);
  };
  giro();
}
async function elencaMicrofoni() {
  const sel = $("selMic");
  const disp = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput");
  sel.innerHTML = "";
  for (const d of disp) {
    const o = document.createElement("option");
    o.value = d.deviceId; o.textContent = d.label || "microfono";
    sel.appendChild(o);
  }
  const attuale = flusso && flusso.getAudioTracks()[0] && flusso.getAudioTracks()[0].getSettings().deviceId;
  sel.value = imp.mic || attuale || "";
}

// click morbido (inviluppo gaussiano): tutto sopra i 2,8 kHz, dove il rilevatore non ascolta.
// tipo 2 = primo della battuta, 1 = battito, 0 = suddivisione
const clickBuf = {};
function bufferClick(tipo) {
  if (clickBuf[tipo]) return clickBuf[tipo];
  const sr = ctx.sampleRate, n = Math.round(0.016 * sr), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
  const f = [3000, 3300, 4000][tipo], v = [0.16, 0.35, 0.5][tipo];
  for (let i = 0; i < n; i++) d[i] = v * Math.sin(2 * Math.PI * f * i / sr) * Math.exp(-0.5 * ((i / sr - 0.007) / 0.0022) ** 2);
  return (clickBuf[tipo] = b);
}
function suonaBuffer(b, t, uscita) {
  const s = ctx.createBufferSource();
  s.buffer = b; s.connect(uscita || ctx.destination); s.start(t);
  return s;
}

// ---------- il battito da vedere: una pallina che rimbalza di battito in battito ----------
// Il click sul telefono si sente poco: la pallina tocca terra su ogni battito e si vede arrivare il colpo
// (niente lampi). Le celle sono i battiti della battuta, la prima è più grande. Una coda per riquadro:
// ogni elemento [istante in s sull'orologio audio, battito nella battuta (0..), battiti nella battuta].
const pendoli = {};
function pendolo(id) {
  if (pendoli[id]) return pendoli[id];
  const el = $(id);
  el.innerHTML = '<div class="celle"></div><span class="pallina"></span>';
  return (pendoli[id] = { el, celle: el.firstElementChild, palla: el.lastElementChild, colpi: [], n: 0, attivo: false });
}
function battitoVisto(id, t, b, n) {
  const p = pendolo(id);
  p.colpi.push([t, b, n]);
  if (!p.attivo) {
    p.attivo = true; p.el.hidden = false;
    // sul telefono la partitura può essere più giù dello schermo: la pallina deve vedersi
    const r = p.el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) p.el.scrollIntoView({ block: "start", behavior: "smooth" });
    requestAnimationFrame(() => muoviPendolo(p));
  }
}
function fermaPendolo(id) {
  const p = pendoli[id];
  if (!p) return;
  p.colpi = []; p.attivo = false; p.el.hidden = true;
}
function muoviPendolo(p) {
  if (!p.attivo || !ctx) return;
  const ora = ctx.currentTime - (ctx.outputLatency || 0);
  while (p.colpi.length > 1 && p.colpi[1][0] <= ora) p.colpi.shift();
  const [a, b] = p.colpi;
  if (!a || (!b && ora > a[0] + 0.6)) { p.attivo = false; p.el.hidden = true; return; }
  const n = (b && ora >= a[0] ? b : a)[2];
  if (n !== p.n) {
    p.n = n;
    p.celle.innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i === 0 && n > 1 ? "primo" : ""}"></i>`).join("");
  }
  const w = p.celle.clientWidth, centro = i => (i + 0.5) / p.n * w;
  let x, salto;
  if (ora < a[0]) { x = centro(a[1]); salto = Math.min(1, (a[0] - ora) / 0.6); }          // prima del primo colpo: scende sulla cella
  else if (!b) { x = centro(a[1]); salto = 0; }
  else {
    const f = Math.min(1, (ora - a[0]) / (b[0] - a[0]));
    x = centro(a[1]) + (centro(b[1]) - centro(a[1])) * f;
    salto = Math.sin(Math.PI * f);                                                      // a terra sul battito
  }
  const qui = ora >= a[0] ? a[1] : -1;
  [...p.celle.children].forEach((c, i) => c.classList.toggle("qui", i === qui));
  p.palla.style.transform = `translate(${x - p.palla.offsetWidth / 2}px, ${-salto * (p.el.classList.contains("grande") ? 46 : 34)}px)`;
  requestAnimationFrame(() => muoviPendolo(p));
}
// in che battito della battuta cade q (quarti), e quanti battiti ha la battuta
function battitoDi(q) {
  let m = B.misure[0];
  for (const x of B.misure) if (x[1] <= q + 1e-6) m = x;
  const n = Math.max(1, Math.round(m[2] / battito()));
  return [Math.min(n - 1, Math.round((q - m[1]) / battito())), n];
}

// corda pizzicata (Karplus-Strong). suoni: [[midi, inizio s, fine s]]
function sintetizza(suoni, durata) {
  const sr = ctx.sampleRate, x = new Float32Array(Math.round(durata * sr));
  suoni.sort((a, b) => a[1] - b[1]);
  suoni.forEach(([m, t, f], i) => {
    if (t < 0 || t >= durata) return;
    const dopo = suoni.find((s, j) => j > i && s[0] === m && s[1] > t);
    const fine = Math.min(t + 2.4, Math.max(f, t + 0.25), dopo ? dopo[1] : 1e9);
    const P = Math.round(sr / A.freq(m, imp.la)), buf = new Float32Array(P);
    let lp = 0;
    for (let k = 0; k < P; k++) { lp = 0.55 * lp + 0.45 * (Math.random() * 2 - 1); buf[k] = lp * 0.22; }
    const i0 = Math.round(t * sr), n = Math.min(x.length - i0, Math.round((fine - t) * sr)), fade = Math.round(0.015 * sr);
    for (let k = 0, p = 0; k < n; k++) {
      const j = (p + 1) % P, v = buf[p];
      buf[p] = 0.996 * 0.5 * (buf[p] + buf[j]);
      x[i0 + k] += v * Math.min(1, (n - k) / fade);
      p = j;
    }
  });
  const b = ctx.createBuffer(1, x.length, sr);
  b.copyToChannel(x, 0);
  return b;
}

// i campioni del microfono di una prova, a blocchi, per giudicare le note dopo l'attacco
class Registro {
  constructor(sr) { this.sr = sr; this.blocchi = []; this.fine = 0; }
  aggiungi(inizio, dati) { this.blocchi.push([inizio, dati]); this.fine = Math.max(this.fine, inizio + dati.length); }
  get ora() { return this.fine / this.sr; }
  estrai(tDa, tA) {
    const a = Math.round(tDa * this.sr), b = Math.round(tA * this.sr), x = new Float32Array(Math.max(0, b - a));
    for (const [i, d] of this.blocchi) {
      if (i + d.length <= a || i >= b) continue;
      const da = Math.max(a, i), fin = Math.min(b, i + d.length);
      x.set(d.subarray(da - i, fin - i), da - a);
    }
    return { x, t0: a / this.sr };
  }
  taglia(tPrima) { const s = tPrima * this.sr; this.blocchi = this.blocchi.filter(([i, d]) => i + d.length > s); }
}
function giudica(reg, t, note, lung) {
  const { x, t0 } = reg.estrai(t - 0.3, t + 0.3);
  return A.giudicaNote(x, reg.sr, t0, t, note, lung, { la: imp.la });
}

// ---------- il brano e la partitura ----------
const battito = () => B.battito;                     // quarti per battito del metronomo (1,5 in 12/8)
const noteAttese = (a, modo) => modo === "destra" ? [...new Set(a.corde.map(c => corde()[c - 1]))].sort((x, y) => x - y) : a.note;
function indiciBattute(da, a, arrivo) {
  let i0 = B.attacchi.findIndex(x => x.misura >= da);
  let i1 = -1;
  B.attacchi.forEach((x, i) => { if (x.misura <= a) i1 = i; });
  if (i0 < 0) i0 = 0;
  if (i1 < i0) i1 = i0;
  if (arrivo && i1 + 1 < B.attacchi.length) i1++;
  return [i0, i1];
}
function descriviTratto(i0, i1) {
  const a = B.attacchi[i0], b = B.attacchi[i1];
  const pos = x => { const m = B.misure.find(m => m[0] === x.misura); const bt = Math.floor((x.q - m[1]) / battito() + 1e-6) + 1; return `b. ${x.misura}` + (bt > 1 ? ` (${bt}° tempo)` : ""); };
  return `${pos(a)} → ${pos(b)}, ${i1 - i0 + 1} attacchi`;
}

async function caricaBrano(id) {
  if (corsa) ferma();
  fermaAllenamento();
  const voce = INDICE.brani.find(b => b.id === id);
  $("statoTesto").textContent = `Carico «${voce.titolo}»…`;
  try {
    if (!cacheBrani[id]) {
      const r = await fetch(BRANI + "brani/" + voce.file);
      if (!r.ok) throw new Error(`il file ${voce.file} non c'è (${r.status})`);
      const xml = await r.text();
      cacheBrani[id] = { xml, dati: Brano.prepara(voce, xml) };
    }
  } catch (e) {
    $("statoTesto").textContent = `Questo brano non si apre: ${e.message}.`;
    console.error("brano " + id + ": " + e.message);
    window.ERRORE_BRANO = id + ": " + e.message;
    return;
  }
  B = cacheBrani[id].dati;
  B.xml = cacheBrani[id].xml;
  imp.brano = id; salvaImp();
  history.replaceState(null, "", location.pathname + "?" + new URLSearchParams([...new URLSearchParams(location.search)].filter(([k]) => k !== "brano").concat([["brano", id]])));
  $("titolo").textContent = B.titolo;
  $("sottotitolo").textContent = voce.autore;
  $("meta").textContent = `${B.misure.length} battute · ${B.metro[0]}/${B.metro[1]} · ${B.attacchi.length} attacchi · tempo indicato ${U()} ${B.tempo}`;
  const prima = B.misure[0][0], ultima = B.misure.at(-1)[0];
  for (const id of ["aBatt", "daBatt", "pDa", "pA"]) { $(id).min = prima; $(id).max = ultima; }
  $("aBatt").value = ultima; $("daBatt").value = prima;
  for (const el of document.querySelectorAll(".unitaBattito")) el.textContent = el.dataset.testo.replace("U", U());
  $("accCorde").innerHTML = corde().map((m, i) => `<button data-m="${m}">${i + 1}ª · ${nome(m)}</button>`).join("");
  for (const b of $("accCorde").children) b.onclick = () => suonaCorda(+b.dataset.m);
  $("bpmBrano").value = imp.bpmBrano[id] || Math.round(B.tempo * 0.7);
  $("bpmAllena").value = imp.bpmAllena[id] || Math.round(B.tempo * 0.55);
  $("statoTesto").textContent = "Preparo la partitura…";
  await disegnaPartitura();
  pulisciSegni();
  posiziona(0);
  $("statoTesto").textContent = "Pronto. «Ascolta» per sentirlo, «Suona e valuta» per provarlo dall'inizio alla fine (o da battuta a battuta).";
  disegnaPassaggi();
  aggiornaTratto();
}

async function disegnaPartitura() {
  const cont = $("osmd");
  cont.innerHTML = "";
  $("striscia").classList.remove("libera");
  osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(cont, {
    backend: "svg", autoResize: false, drawTitle: false, drawSubtitle: false, drawComposer: false, drawCredits: false,
    drawPartNames: false, drawMeasureNumbers: true, renderSingleHorizontalStaffline: true, drawingParameters: "default"
  });
  osmd.EngravingRules.PageLeftMargin = 3;
  osmd.EngravingRules.PageTopMargin = 2;
  await osmd.load(B.xml);
  osmd.zoom = innerWidth < 600 ? 0.8 : 1.15;          // telefono: più musica nello schermo
  osmd.render();
  const svg = cont.querySelector("svg");
  larghezza = svg ? svg.getBoundingClientRect().width : 2000;
  const altezza = svg ? svg.getBoundingClientRect().height : 200;
  $("rullo").style.width = larghezza + "px";
  costruisciLinea();
  const alto = Math.max(altezza, rigo.giu + 192);
  $("striscia").style.height = Math.max(190, alto + 8) + "px";
  const segni = $("segni");
  segni.setAttribute("width", larghezza); segni.setAttribute("height", alto);
  segni.style.width = larghezza + "px"; segni.style.height = alto + "px";
}

// da quarti (dall'inizio del brano) a x sulla partitura: posizioni vere delle note disegnate da OSMD
function costruisciLinea() {
  linea = [];
  const unita = 10 * osmd.zoom;
  try {
    const disegnate = osmd.GraphicSheet.MeasureList.map(col => col && col[0]).filter(Boolean);
    const ps0 = disegnate[0].ParentStaffLine.PositionAndShape;
    const y0 = ps0.AbsolutePosition.y * unita;
    let fondo = y0 + 4 * unita;
    for (const gm of disegnate) {
      const g = gm.PositionAndShape;
      fondo = Math.max(fondo, (g.AbsolutePosition.y + g.BorderMarginBottom) * unita);
    }
    rigo = { su: y0, giu: fondo };
    disegnate.forEach((gm, i) => {
      if (i >= B.misure.length) return;
      const [, q0, durata] = B.misure[i];
      const ps = gm.PositionAndShape;
      const x0 = ps.AbsolutePosition.x * unita, w = ps.Size.width * unita;
      linea.push([q0, x0 + 0.02 * w]);
      for (const se of gm.staffEntries) linea.push([q0 + se.relInMeasureTimestamp.RealValue * 4, se.PositionAndShape.AbsolutePosition.x * unita]);
      linea.push([q0 + durata - 1e-3, x0 + w]);
    });
  } catch (e) { console.warn("linea della partitura:", e); linea = []; }
  linea.sort((a, b) => a[0] - b[0]);
  linea = linea.filter((p, i) => i === 0 || p[1] >= linea[i - 1][1] - 0.5);
  if (linea.length < 2) linea = [[0, 40], [B.quarti, larghezza - 20]];
}
function xDi(q) {
  if (q <= linea[0][0]) return linea[0][1] + (q - linea[0][0]) * 40;
  for (let i = 1; i < linea.length; i++) {
    if (q <= linea[i][0]) {
      const [q0, x0] = linea[i - 1], [q1, x1] = linea[i];
      return x0 + (x1 - x0) * (q - q0) / Math.max(q1 - q0, 1e-6);
    }
  }
  return linea[linea.length - 1][1];
}
function posiziona(q) {
  const str = $("striscia");
  if (str.classList.contains("libera")) str.classList.remove("libera");
  if (str.scrollLeft) str.scrollLeft = 0;          // lo scorrimento a mano di prima non deve sommarsi
  const testa = str.clientWidth * 0.3;
  $("rullo").style.transform = `translateX(${(testa - xDi(q)).toFixed(1)}px)`;
}
function liberaPartitura(q) {
  const str = $("striscia");
  str.classList.add("libera");
  $("rullo").style.transform = "none";
  str.scrollLeft = Math.max(0, xDi(q || 0) - str.clientWidth * 0.3);
}

// ---------- segni sulla partitura ----------
const NS = "http://www.w3.org/2000/svg";
function pulisciSegni() { $("segni").innerHTML = ""; }
function elemento(tag, attr, testo) {
  const e = document.createElementNS(NS, tag);
  for (const k in attr) e.setAttribute(k, attr[k]);
  if (testo != null) e.textContent = testo;
  return e;
}
function coloreScarto(ms) {
  if (ms == null) return "var(--male)";
  const a = Math.abs(ms);
  return a <= 25 ? "var(--bene)" : a <= 50 ? "#7aa36f" : a <= 90 ? "var(--quasi)" : "var(--male)";
}
function segno(k, ms) {
  const x = xDi(B.attacchi[k].q), y = rigo.giu + 14;
  let c = $("segni").querySelector(`[data-k="${k}"]`);
  if (!c) { c = elemento("circle", { r: 5 }); c.dataset.k = k; $("segni").appendChild(c); }
  c.setAttribute("cx", x.toFixed(1)); c.setAttribute("cy", y);
  c.setAttribute("fill", coloreScarto(ms));
  c.setAttribute("opacity", ms == null ? 0.35 : 1);
}
function segnoNota(k, sbagliata) {
  let t = $("segni").querySelector(`[data-n="${k}"]`);
  if (!sbagliata) { if (t) t.remove(); return; }
  if (!t) { t = elemento("text", { fill: "var(--male)", "font-size": 18, "font-weight": 600 }, "×"); t.dataset.n = k; $("segni").appendChild(t); }
  t.setAttribute("x", (xDi(B.attacchi[k].q) - 5).toFixed(1)); t.setAttribute("y", rigo.giu + 36);
}
// il tratto in studio: fondo colorato; in mano destra, sotto ogni attacco, le corde da pizzicare
// (attivo: da dove parte il pezzo della catena in corso, riquadrato)
function segnaTratto(i0, i1, modo, attivo) {
  for (const e of $("segni").querySelectorAll(".tratto")) e.remove();
  if (i0 == null) return;
  const x0 = xDi(B.attacchi[i0].q) - 10, x1 = xDi(B.attacchi[i1].q) + 14;
  const r = elemento("rect", { x: x0, y: 4, width: Math.max(20, x1 - x0), height: rigo.giu + 184, rx: 6, fill: "var(--tratto)", class: "tratto" });
  $("segni").insertBefore(r, $("segni").firstChild);
  if (attivo != null) {
    const xa = xDi(B.attacchi[attivo].q) - 8;
    $("segni").appendChild(elemento("rect", { x: xa, y: 6, width: Math.max(18, x1 - 2 - xa), height: rigo.giu + 180, rx: 5, fill: "none", stroke: "var(--accento)", "stroke-width": 1.5, "stroke-dasharray": "5 3", class: "tratto" }));
  }
  if (modo === "destra") esagramma(i0, i1, x0 - 6, x1 + 6);
}
// mano destra: l'esagramma sotto la partitura, come nella Bibbia di Kappel (e nell'app «tre gradi di libertà»):
// sei righe = sei corde (1ª in alto), su ogni riga la lettera del dito che pizzica quella corda, sopra il ritmo
// degli attacchi (gambi e travi per battito). Le dita sono una proposta: pollice sulle corde 4-6, i m a su 3 2 1.
const DITO_DESTRA = { 1: "a", 2: "m", 3: "i", 4: "p", 5: "p", 6: "p" };
const COLORE_DITO = { p: "var(--accento)", i: "var(--bene)", m: "var(--quasi)", a: "#3b5f8a" };
function esagramma(i0, i1, xa, xb) {
  const S = $("segni"), RIGA = 15, TRAVE = rigo.giu + 46, Y1 = rigo.giu + 80, y = c => Y1 + (c - 1) * RIGA;
  const metti = (tag, attr, testo) => S.appendChild(elemento(tag, { ...attr, class: "tratto" }, testo));
  for (let c = 1; c <= 6; c++) metti("rect", { x: xa, y: y(c), width: xb - xa, height: 1, fill: "var(--tenue)", opacity: 0.55 });
  metti("text", { x: xa + 2, y: y(6) + 20, "font-size": 11, fill: "var(--tenue)" }, "mano destra (dita proposte)");
  const quasi = (a, b) => Math.abs(a - b) < 1e-3;
  const gambo = {};
  for (let k = i0; k <= i1; k++) {
    const a = B.attacchi[k], x = xDi(a.q), corde = [...new Set(a.corde)];
    gambo[k] = x;
    metti("rect", { x: x - 0.75, y: TRAVE, width: 1.5, height: y(Math.min(...corde)) - 7 - TRAVE, fill: "var(--inchiostro)" });
    const d = k < i1 ? a.durata : Math.min(a.durata, battito());
    if (quasi(d, 0.75) || quasi(d, 1.5) || quasi(d, 3)) metti("circle", { cx: x + 6, cy: y(Math.min(...corde)) - 10, r: 1.6, fill: "var(--inchiostro)" });
    for (const c of corde) {
      const f = DITO_DESTRA[c];
      metti("rect", { x: x - 7, y: y(c) - 8, width: 14, height: 15, fill: "var(--foglio)" });
      metti("text", { x, y: y(c) + 4, "font-size": 17, "font-style": "italic", "font-family": "EB Garamond, serif", "font-weight": 600, "text-anchor": "middle", fill: COLORE_DITO[f] }, f);
    }
  }
  // travi: gli attacchi più corti di un quarto, per battito; la seconda trave sui sedicesimi
  const gruppi = {};
  for (let k = i0; k <= i1; k++) {
    const a = B.attacchi[k], d = k < i1 ? a.durata : Math.min(a.durata, battito());
    if (d < 1 - 1e-3) (gruppi[Math.floor(a.q / battito() + 1e-6)] ||= []).push([k, d]);
  }
  for (const g of Object.values(gruppi)) {
    const xs = g.map(([k]) => gambo[k]), sedic = j => g[j][1] <= 0.25 + 1e-3;
    if (g.length === 1) {
      metti("path", { d: `M${xs[0]} ${TRAVE}l7 7`, stroke: "var(--inchiostro)", "stroke-width": 2, fill: "none" });
      if (sedic(0)) metti("path", { d: `M${xs[0]} ${TRAVE + 5}l7 7`, stroke: "var(--inchiostro)", "stroke-width": 2, fill: "none" });
      continue;
    }
    metti("rect", { x: xs[0] - 0.75, y: TRAVE, width: xs[xs.length - 1] - xs[0] + 1.5, height: 3, fill: "var(--inchiostro)" });
    g.forEach((_, j) => {
      if (!sedic(j)) return;
      if (j + 1 < g.length && sedic(j + 1)) metti("rect", { x: xs[j] - 0.75, y: TRAVE + 6, width: xs[j + 1] - xs[j] + 1.5, height: 3, fill: "var(--inchiostro)" });
      else if (!(j > 0 && sedic(j - 1))) { const dx = j + 1 < g.length ? 7 : -7; metti("rect", { x: Math.min(xs[j], xs[j] + dx), y: TRAVE + 6, width: 7, height: 3, fill: "var(--inchiostro)" }); }
    });
  }
}
function segnaAttesa(k) {
  let r = $("segni").querySelector(".attesa");
  if (k == null) { if (r) r.remove(); return; }
  if (!r) { r = elemento("rect", { class: "attesa", y: 2, width: 22, rx: 4, fill: "none", stroke: "var(--accento)", "stroke-width": 2 }); $("segni").appendChild(r); }
  r.setAttribute("x", xDi(B.attacchi[k].q) - 8); r.setAttribute("height", rigo.giu + 24);
}

// ---------- tempo ----------
function leggiBpm(id) {
  const el = $(id);
  const v = Math.max(20, Math.min(200, Math.round(+el.value || 40)));
  el.value = v;
  if (B) { (id === "bpmBrano" ? imp.bpmBrano : imp.bpmAllena)[B.id] = v; salvaImp(); }
  if (id === "bpmAllena") etichetteTolleranza();
  return v;
}

// ---------- ascolto (anteprima con chitarra sintetica) ----------
async function ascolta(i0, i1, bpm, modo) {
  await apriContesto();
  if (corsa) ferma();
  fermaMetronomo();
  const sq = 60 / bpm / battito(), q0 = B.attacchi[i0].q, qFine = B.attacchi[i1].q + B.attacchi[i1].durata;
  const conta = B.battitiPerMisura;
  const qc0 = Math.ceil(q0 / battito() - 1e-6) * battito() - conta * battito();
  const t0 = ctx.currentTime + 0.25, tq = q => t0 + (q - qc0) * sq;
  const sorgenti = [];
  for (let q = qc0; q < q0 - 1e-6; q += battito()) sorgenti.push(suonaBuffer(bufferClick(primoDellaBattuta(q) ? 2 : 1), tq(q)));
  fermaPendolo("pendolo");
  for (let q = qc0; q < qFine - 1e-6; q += battito()) battitoVisto("pendolo", tq(q), ...(q < q0 - 1e-6 ? [Math.round((q - qc0) / battito()) % conta, conta] : battitoDi(q)));
  let suoni;
  if (modo === "destra") suoni = B.attacchi.slice(i0, i1 + 1).flatMap(a => noteAttese(a, "destra").map(m => [m, (a.q - q0) * sq, (a.q - q0 + a.durata) * sq]));
  else suoni = B.suoni.filter(([, s]) => s >= q0 - 1e-6 && s <= B.attacchi[i1].q + 1e-6).map(([m, s, f]) => [m, (s - q0) * sq, (Math.min(f, qFine + 2) - q0) * sq]);
  const durata = (qFine - q0) * sq + 2.5;
  sorgenti.push(suonaBuffer(sintetizza(suoni, durata), tq(q0)));
  corsa = { tipo: "ascolto", sorgenti, qc0, tq, sq, t0, q0, fine: tq(qFine) + 0.3, tPrimo: tq(q0) };
  pulisciSegni();
  if (al) segnaTratto(al.i0, al.i1, al.modo, al.i1 - al.k + 1);
  comandi(true);
  anima();
}
function primoDellaBattuta(q) { return B.misure.some(m => Math.abs(m[1] - q) < 1e-4); }

function comandi(inCorsa) {
  for (const b of document.querySelectorAll(".btnFerma")) b.disabled = !inCorsa && !al;
  $("btnSuona").disabled = inCorsa || !!al; $("btnAscolta").disabled = inCorsa || !!al;
  $("btnAllena").disabled = inCorsa || !!al; $("btnAscoltaPass").disabled = inCorsa || !!al;
}

// ---------- un giro a tempo: metronomo, ascolto dal vivo, giudizio ----------
// opz: {i0, i1, bpm, modo ("insieme" | "destra"), conta (battiti di attacco), metronomo, sudd}
// Restituisce una promessa: {righe, extra, R} alla fine, null se fermato.
async function giroATempo(opz) {
  await apriAudio();
  if (corsa) ferma();
  fermaMetronomo();
  const { i0, i1, bpm, modo } = opz;
  const sr = ctx.sampleRate, b = battito(), sq = 60 / bpm / b;
  const q0 = B.attacchi[i0].q, ultimo = B.attacchi[i1];
  const qFine = ultimo.q + Math.min(ultimo.durata, b);
  const qc0 = Math.ceil(q0 / b - 1e-6) * b - opz.conta * b;
  // la chitarra finta si prepara prima di fissare l'inizio: il calcolo può durare
  let demoBuf = null;
  if (DEMO) {
    const suoni = [];
    let esita = 0;
    for (let k = i0; k <= i1; k++) {
      const a = B.attacchi[k];
      if (Math.random() < 0.02) continue;
      if (SBANDO && k > i0 && Math.random() < 0.25) esita += SBANDO * (1 + 4 * Math.random());
      const dt = (Math.random() + Math.random() + Math.random() - 1.5) * 0.03 + esita;
      const sposta = Math.random() < 0.04 ? (Math.random() < 0.5 ? -1 : 2) : 0;
      for (const m of noteAttese(a, modo)) suoni.push([m + sposta, 0.1 + (a.q - q0) * sq + dt, 0.1 + (a.q - q0 + a.durata) * sq + 1.2]);
    }
    demoBuf = sintetizza(suoni, (qFine - q0) * sq + 2.6);
  }
  const t0 = ctx.currentTime + 0.35, tq = q => t0 + (q - qc0) * sq;
  const ritardo = DEMO ? 0.009 : imp.ritardo == null ? 0.03 : imp.ritardo;
  const attesi = [];
  for (let k = i0; k <= i1; k++) {
    const a = B.attacchi[k];
    attesi.push({ k, t: tq(a.q), q: a.q, note: noteAttese(a, modo), misura: a.misura });
  }
  const sorgenti = [];
  const lento = 60 / bpm > 1.0;                       // battito più lungo di un secondo
  const passi = opz.sudd || lento ? B.suddivisione : 1;
  for (let j = 0; ; j++) {
    const q = qc0 + j * b / passi;
    if (q > qFine - 1e-6) break;
    if (q >= q0 - 1e-6 && !opz.metronomo) break;
    if (j % passi && q >= q0 - 1e-6 && !opz.sudd) continue;     // le crome dell'attacco lento non proseguono
    const tipo = j % passi ? 0 : primoDellaBattuta(q) ? 2 : 1;
    sorgenti.push(suonaBuffer(bufferClick(tipo), tq(q)));
    if (tipo) battitoVisto("pendolo", tq(q), ...(q < q0 - 1e-6 ? [Math.round((q - qc0) / b) % B.battitiPerMisura, B.battitiPerMisura] : battitoDi(q)));
  }
  if (DEMO) {
    const s = ctx.createBufferSource();
    s.buffer = demoBuf;
    s.connect(ingresso); s.connect(ctx.destination); s.start(tq(q0) - 0.1 + 0.009);
    sorgenti.push(s);
  }
  const ril = new A.Rilevatore(sr);
  if (imp.minimo != null) ril.minimo = imp.minimo;
  const c = {
    tipo: "giro", modo, bpm, sq, giudizio: opz.giudizio || "assoluto", toll: opz.toll || 0.075, qc0, q0, tq, conta: opz.conta, tPrimo: tq(q0), fine: tq(qFine) + 0.3, ritardo, attesi, sorgenti,
    reg: new Registro(sr), ril, sr, inizio: null, sentiti: [], vivi: new Map(), daGiudicare: [], giudizi: new Map()
  };
  c.ascolta = (inizio, dati) => {
    for (const o of nutri(c, inizio, dati)) {
      if (o.t < c.tPrimo - 0.25) continue;                  // durante l'attacco del metronomo
      const tc = o.t - ritardo;
      c.sentiti.push({ t: tc, grezzo: o.t, forza: +o.forza.toFixed(2) });
      abbinaVivo(c, tc, o.t);
    }
  };
  ascoltatori.push(c.ascolta);
  const promessa = new Promise(ok => { c.risolvi = ok; });
  corsa = c;
  pulisciSegni();
  if (al) segnaTratto(al.i0, al.i1, al.modo, al.i1 - al.k + 1);
  comandi(true);
  anima();
  return promessa;
}

// i blocchi del microfono al registro e al rilevatore. Il primo blocco di un giro può essere uno vecchio
// consegnato in ritardo: un salto prima che si cominci a suonare fa solo ripartire il rilevatore da lì.
// Se invece il thread audio salta dei campioni mentre si suona (macchina carica), il rilevatore riceve silenzio
// al loro posto, così il suo orologio resta giusto; gli attacchi sul bordo non contano e il giro va ripetuto.
function nutri(c, inizio, dati) {
  c.nb = (c.nb || 0) + 1;
  if (c.inizio == null) { c.inizio = inizio; c.ril.t0 = inizio / c.sr; c.atteso = inizio; c.mutoFino = 0; }
  if (inizio < c.atteso) return [];                          // blocco fuori ordine
  const buco = inizio - c.atteso;
  if (buco > 0) {
    const primaDiSuonare = c.tipo === "attesa" || inizio / c.sr < c.tPrimo - 0.5;     // senza tempo un buco non sposta niente
    if (primaDiSuonare || buco > 4 * c.sr) {
      c.ril = new A.Rilevatore(c.sr);
      if (imp.minimo != null) c.ril.minimo = imp.minimo;
      if (c.tipo === "attesa") c.ril.avvio = 0.05;
      c.ril.t0 = inizio / c.sr;
    } else {
      c.ril.feed(new Float32Array(buco));
      c.mutoFino = (inizio + 0.12 * c.sr) / c.sr;
      c.buchi = (c.buchi || 0) + 1;
    }
    if (!primaDiSuonare) console.warn(`audio: saltati ${buco} campioni mentre si suona`);
  }
  c.atteso = inizio + dati.length;
  c.reg.aggiungi(inizio, dati);
  return c.ril.feed(dati).filter(o => {
    if (o.t <= c.mutoFino) return false;
    // risonanza: un picco molto più debole dell'attacco vero appena prima (corde che battono, accordi a vuoto
    // che suonano a lungo) non è una nota nuova
    const f = c.forte;
    if (f && o.t - f.t < 0.6 && o.forza < 0.3 * f.forza) return false;
    if (!f || o.t - f.t >= 0.6 || o.forza >= 0.3 * f.forza) c.forte = { t: o.t, forza: o.forza };
    return true;
  });
}

// abbinamento provvisorio, mentre si suona: la nota attesa più vicina e libera
function abbinaVivo(c, tc, grezzo) {
  let best = null, bd = 1e9;
  for (const a of c.attesi) {
    if (c.vivi.has(a.k)) continue;
    const d = Math.abs(tc - a.t);
    if (d < bd) { bd = d; best = a; }
    if (a.t > tc + 0.3) break;
  }
  if (!best) return;
  const i = c.attesi.indexOf(best);
  const bs = c.sq * battito();
  const prima = i > 0 ? best.t - c.attesi[i - 1].t : bs, dopo = i < c.attesi.length - 1 ? c.attesi[i + 1].t - best.t : bs;
  if (bd > finestra(c, prima, dopo)) return;
  c.vivi.set(best.k, tc - best.t);
  if (c.giudizio !== "relativo") segno(best.k, (tc - best.t) * 1000);
  c.daGiudicare.push({ k: best.k, note: best.note, grezzo, dopo: Math.min(dopo, 0.3) });
  if (!al) {
    const ms = Math.round((tc - best.t) * 1000);
    $("statoTesto").innerHTML = `battuta <b>${best.misura}</b> · ultima nota <b>${ms === 0 ? "a tempo" : Math.abs(ms) + " ms " + (ms < 0 ? "in anticipo" : "in ritardo")}</b>`;
  }
}
function giudicaPronti(c, tutti) {
  const ora = c.reg.ora;
  c.daGiudicare = c.daGiudicare.filter(g => {
    if (!tutti && g.grezzo + 0.2 > ora) return true;
    const gs = giudica(c.reg, g.grezzo, g.note, g.dopo);
    c.giudizi.set(g.k, gs);
    segnoNota(g.k, gs.some(x => x.esito === "sbagliata"));
    return false;
  });
}

function anima() {
  const c = corsa;
  if (!c) return;
  const ora = ctx.currentTime - (ctx.outputLatency || 0);
  if (c.tipo === "attesa") { animaAttesa(c); return; }
  const q = c.q0 + (ora - c.tPrimo) / c.sq;
  posiziona(Math.max(c.qc0, q));
  const conta = $("conta");
  if (ora < c.tPrimo && ora >= c.tq(c.qc0)) {
    conta.style.display = "flex"; conta.textContent = Math.ceil((c.tPrimo - ora) / (c.sq * battito()) - 1e-3);
  } else conta.style.display = "none";
  if (c.tipo === "giro") {
    giudicaPronti(c, false);
    for (const a of c.giudizio === "relativo" ? [] : c.attesi) {
      if (a.t > ora - 0.2) break;
      if (!c.vivi.has(a.k) && !$("segni").querySelector(`[data-k="${a.k}"]`)) segno(a.k, null);
    }
  }
  if (ctx.currentTime > c.fine + 0.3) {
    const ultimo = c.sentiti.length ? c.sentiti[c.sentiti.length - 1].grezzo : 0;
    const aspetta = c.giudizio === "relativo" && c.sentiti.length < c.attesi.length + 2 && ctx.currentTime - ultimo < 1.5 && ctx.currentTime < c.fine + 8;
    if (!aspetta) { concludi(); return; }
  }
  requestAnimationFrame(anima);
}

function smettiCorsa() {
  const c = corsa;
  if (!c) return null;
  corsa = null;
  for (const s of c.sorgenti || []) { try { s.stop(); } catch (e) { /* già finito */ } }
  if (c.ascolta) ascoltatori = ascoltatori.filter(f => f !== c.ascolta);
  fermaPendolo("pendolo");
  $("conta").style.display = "none";
  segnaAttesa(null);
  comandi(false);
  return c;
}
// quanto lontano dal suo istante si cerca l'attacco di una nota. «assoluto» (prova del brano, fase del tempo):
// fino a 150 ms, o due volte la tolleranza se è più larga, mai oltre metà della distanza dalle note vicine.
// «relativo» (fase delle dita): metà della distanza dalle vicine, qualunque sia.
function finestra(c, prima, dopo) {
  const meta = 0.45 * Math.min(prima, dopo);
  return c.giudizio === "relativo" ? meta : Math.min(meta, Math.max(0.15, 2 * c.toll));
}
function abbinaFinestra(c, attesi, sentiti) {
  const bs = c.sq * battito();
  const usato = new Array(sentiti.length).fill(false);
  const righe = attesi.map((a, k) => {
    const fin = finestra(c, k > 0 ? a.t - attesi[k - 1].t : bs, k < attesi.length - 1 ? attesi[k + 1].t - a.t : bs);
    let best = -1, bd = 1e9;
    for (let j = 0; j < sentiti.length; j++) {
      if (usato[j]) continue;
      const d = Math.abs(sentiti[j].t - a.t);
      if (d <= fin && d < bd) { bd = d; best = j; }
    }
    if (best < 0) return { ...a, sentito: null, scarto: null };
    usato[best] = true;
    return { ...a, sentito: sentiti[best].t, scarto: sentiti[best].t - a.t };
  });
  return { righe, extra: sentiti.filter((_, j) => !usato[j]) };
}
// fase delle dita: contano le note e il loro ordine, non il metronomo. Le note si prendono in sequenza: ognuna è il
// primo attacco dopo quello della nota precedente, purché non arrivi troppo presto (prima di metà della distanza
// scritta) e non dopo una pausa di più di 2 battiti (o 3 s): ci si può fermare a cercare la posizione.
// Un secondo picco entro 90 ms dallo stesso attacco non conta come nota.
function abbinaRelativo(attesi, sentiti, bs) {
  const usato = new Array(sentiti.length).fill(false);
  let rif = null, ultimo = -1;
  const attesa = Math.max(2 * bs, 3);
  const righe = attesi.map((a, k) => {
    const prima = k > 0 ? a.t - attesi[k - 1].t : bs;
    const previsto = rif ? rif[1] + prima : a.t;
    const presto = rif ? rif[1] + 0.5 * prima : a.t - 0.5 * bs;
    let best = -1;
    for (let j = ultimo + 1; j < sentiti.length; j++) {
      const s = sentiti[j].t;
      if (rif && s - rif[1] < 0.09) continue;                 // stesso gesto della nota prima
      if (s < presto) continue;
      if (s <= previsto + attesa) best = j;
      break;
    }
    if (best < 0) return { ...a, sentito: null, scarto: null };
    usato[best] = true; ultimo = best;
    rif = [a.t, sentiti[best].t];
    return { ...a, sentito: sentiti[best].t, scarto: sentiti[best].t - a.t };
  });
  const primo = righe.find(r => r.sentito != null);
  return { righe, extra: sentiti.filter((s, j) => !usato[j] && j <= Math.max(ultimo, 0) && (!primo || s.t > primo.sentito + 0.09)
    && !righe.some(r => r.sentito != null && s.t - r.sentito > 0 && s.t - r.sentito < 0.09)) };
}

// fine naturale di un giro: giudizio completo
function concludi() {
  const c = smettiCorsa();
  if (!c) return;
  if (c.tipo === "ascolto") { if (!al) posiziona(c.q0); return; }
  if (c.tipo === "attesa") { scriviLog(c, null); c.risolvi(c.esito); return; }
  const bs = c.sq * battito();
  const sentiti = c.sentiti.filter(s => s.t > c.attesi[0].t - Math.max(0.2, 0.5 * bs) && s.t < c.attesi[c.attesi.length - 1].t + (c.giudizio === "relativo" ? Math.max(0.3, 0.5 * bs) : 0.3));
  const abb = c.giudizio === "relativo" ? abbinaRelativo(c.attesi, sentiti, bs) : abbinaFinestra(c, c.attesi, sentiti);
  const righe = abb.righe;
  // un secondo picco subito dopo un attacco giudicato è lo stesso gesto (succede sulle note isolate), non un colpo in più
  const extra = abb.extra.filter(s => !righe.some(r => r.sentito != null && s.t - r.sentito > 0 && s.t - r.sentito < 0.09));
  righe.forEach((r, i) => {
    if (r.scarto == null) return;
    const dopo = i < righe.length - 1 ? righe[i + 1].t - r.t : 0.3;
    r.giudizi = giudica(c.reg, r.sentito + c.ritardo, r.note, Math.min(dopo, 0.3));
  });
  pulisciSegni();
  if (al) segnaTratto(al.i0, al.i1, al.modo, al.i1 - al.k + 1);
  righe.forEach(r => { segno(r.k, r.scarto == null ? null : c.giudizio === "relativo" ? 0 : r.scarto * 1000); segnoNota(r.k, (r.giudizi || []).some(g => g.esito === "sbagliata")); });
  if (al) posiziona(Math.max(c.qc0, c.q0 - battito()));        // fra un giro e l'altro si vede il pezzo appena suonato
  const ris = { righe, extra, R: A.riepilogo(righe, extra), bpm: c.bpm, modo: c.modo, buchi: c.buchi || 0 };
  scriviLog(c, ris);
  c.risolvi(ris);
}

// (il Leggio Sor mandava ogni prova a un registro sul server; qui niente server: le prove restano nel browser)
function scriviLog() { }
// interruzione (Ferma, cambio di scheda): la prova del brano dà il resoconto della parte suonata
function ferma() {
  const c = smettiCorsa();
  if (!c) return;
  if (c.tipo === "ascolto") { posiziona(c.q0); return; }
  if (c.risolvi) c.risolvi(null);
}

// ---------- un giro senza tempo (mano sinistra): l'app aspetta la nota giusta ----------
function giroInAttesa(i0, i1) {
  return new Promise(async ok => {
    await apriAudio();
    if (corsa) ferma();
    fermaMetronomo();
    const sr = ctx.sampleRate, ril = new A.Rilevatore(sr);
    if (imp.minimo != null) ril.minimo = imp.minimo;
    ril.avvio = 0.05;
    const c = { tipo: "attesa", i0, i1, k: i0, qVista: B.attacchi[i0].q, reg: new Registro(sr), ril, sr, inizio: null,
      inArrivo: [], errori: 0, sbagli: [], tentativi: [], ultimo: -1, risolvi: ok, sorgenti: [], demo: null };
    c.ascolta = (inizio, dati) => { for (const o of nutri(c, inizio, dati)) c.inArrivo.push(o.t); };
    ascoltatori.push(c.ascolta);
    corsa = c;
    pulisciSegni();
    if (al) segnaTratto(al.i0, al.i1, al.modo, al.i1 - al.k + 1);
    segnaAttesa(c.k);
    comandi(true);
    mostraAttesa(c);
    anima();
  });
}
function mostraAttesa(c) {
  const a = B.attacchi[c.k];
  $("statoTesto").innerHTML = `suona: <b>${a.note.map(nome).join(" · ")}</b> <span style="margin-left:10px">battuta ${a.misura} · ${c.k - c.i0 + 1} di ${c.i1 - c.i0 + 1}</span>` +
    (c.errori ? ` <span style="color:var(--male);margin-left:10px">${c.errori} ${c.errori === 1 ? "sbaglio" : "sbagli"}</span>` : "");
}
function animaAttesa(c) {
  // la partitura scivola verso la nota attesa
  const q = B.attacchi[c.k].q;
  c.qVista += (q - c.qVista) * 0.18;
  posiziona(c.qVista);
  if (DEMO) demoAttesa(c);
  const ora = c.reg.ora;
  while (c.inArrivo.length && c.inArrivo[0] + 0.2 <= ora) {
    const t = c.inArrivo.shift();
    if (t - c.ultimo < 0.09) continue;                 // stesso gesto (accordo arpeggiato)
    c.ultimo = t;
    const a = B.attacchi[c.k];
    const gs = giudica(c.reg, t, a.note, 0.2);
    c.tentativi.push({ k: c.k, t: +t.toFixed(3), giudizi: gs });
    c.reg.taglia(t - 2);
    if (c.demo) c.demo.suonato = false;
    if (gs.every(g => g.esito !== "sbagliata")) {
      segno(c.k, 0);
      segnoNota(c.k, false);
      c.k++;
      if (c.k > c.i1) {
        c.esito = { errori: c.errori, sbagli: c.sbagli, buchi: c.buchi || 0 };
        segnaAttesa(null);
        setTimeout(concludi, 250);
        return;
      }
      segnaAttesa(c.k);
    } else {
      c.errori++;
      c.sbagli.push({ k: c.k, giudizi: gs });
      segnoNota(c.k, true);
    }
    mostraAttesa(c);
  }
  requestAnimationFrame(anima);
}
// demo: un chitarrista finto che suona la nota attesa dopo un po', ogni tanto sbagliata
function demoAttesa(c) {
  const ora = ctx.currentTime;
  if (!c.demo) c.demo = { quando: ora + 0.8, suonato: false, k: -1 };
  if (c.demo.k !== c.k && !c.demo.suonato) { c.demo.k = c.k; c.demo.quando = ora + 0.5 + Math.random() * 0.6; }
  if (!c.demo.suonato && ora >= c.demo.quando) {
    const a = B.attacchi[c.k];
    const sposta = Math.random() < 0.12 ? 1 : 0;
    const s = ctx.createBufferSource();
    s.buffer = sintetizza(a.note.map(m => [m + sposta, 0, 1.2]), 1.4);
    s.connect(ingresso); s.connect(ctx.destination); s.start();
    c.sorgenti.push(s);
    c.demo.suonato = true;
    c.demo.k = sposta ? -1 : c.k;
  }
}

// ---------- prova del brano (scheda Brano) ----------
async function suonaBrano() {
  try { await apriAudio(); } catch (e) {
    $("statoTesto").innerHTML = "<b>Il microfono non è disponibile.</b> Serve il permesso del browser e la pagina aperta su localhost o https.";
    return;
  }
  if (imp.ritardo == null && !DEMO) $("statoTesto").innerHTML = "<b>Consiglio:</b> fai una volta la taratura del ritardo (Impostazioni), sennò i giudizi di tempo sono spostati.";
  const [i0, i1] = indiciBattute(+$("daBatt").value, +$("aBatt").value, false);
  $("resoconto").hidden = true;
  const bpm = leggiBpm("bpmBrano");
  const tInizio = performance.now();
  const r = await giroATempo({ i0, i1, bpm, modo: "insieme", conta: +$("attacco").value * B.battitiPerMisura, metronomo: $("metronomo").checked, sudd: false });
  if (!r) { $("statoTesto").textContent = "Interrotto."; posiziona(B.attacchi[i0].q); return; }
  resocontoBrano(r, i0, i1, (performance.now() - tInizio) / 1000);
}

function erroreNota(r) {
  if (r.scarto == null) return 1;
  const gs = r.giudizi || [];
  const pn = gs.length ? gs.reduce((s, g) => s + (g.esito === "giusta" ? 1 : g.esito === "incerta" ? 0.5 : 0), 0) / gs.length : 1;
  return 1 - (0.5 * A.puntiTempo(Math.abs(r.scarto) * 1000) + 0.5 * pn);
}

function resocontoBrano(r, i0, i1) {
  const { righe, R } = r;
  liberaPartitura(B.attacchi[i0].q);
  const err = {};
  for (const x of righe) err[x.k] = [+erroreNota(x).toFixed(2), x.scarto == null ? null : Math.round(x.scarto * 1000), (x.giudizi || []).some(g => g.esito === "sbagliata") ? 1 : 0];
  const voce = { data: new Date().toISOString(), bpm: r.bpm, da: i0, a: i1, punteggio: R.punteggio, tempo: R.tempo, note: R.note, err };
  (prove[B.id] = prove[B.id] || []).push(voce);
  if (prove[B.id].length > 40) prove[B.id].shift();
  mem.scrivi("prove", prove);

  const perMisura = new Map();
  for (const x of righe) {
    const m = perMisura.get(x.misura) || { n: 0, e: 0, sbagliate: 0, mancate: 0, scarti: [] };
    m.n++; m.e += erroreNota(x);
    if (x.scarto == null) m.mancate++;
    else { m.scarti.push(x.scarto * 1000); if ((x.giudizi || []).some(g => g.esito === "sbagliata")) m.sbagliate++; }
    perMisura.set(x.misura, m);
  }
  const celle = [...perMisura.entries()].map(([n, m]) => {
    const v = 1 - m.e / m.n;
    return `<div style="background:${coloreValore(v)}" title="battuta ${n}: ${Math.round(100 * v)}">${n}</div>`;
  }).join("");
  const sbagliate = [];
  for (const x of righe) for (const g of x.giudizi || []) if (g.esito === "sbagliata")
    sbagliate.push(`battuta ${x.misura}: scritto <b>${nome(g.nota)}</b>, sentito ${g.sentita != null ? "<b>" + nome(g.sentita) + "</b>" : "altro"}`);
  const giudizio = R.punteggio >= 90 ? "Ottimo" : R.punteggio >= 75 ? "Buono" : R.punteggio >= 60 ? "Da rifinire" : "Da riprendere più lento";
  const tend = R.tendenza;
  const fraseTend = Math.abs(tend) < 4 ? "tempo stabile" : tend < 0 ? `acceleri (${Math.abs(tend)} ms ogni 10 s)` : `rallenti (${tend} ms ogni 10 s)`;
  const fraseAnt = Math.abs(R.anticipo) < 8 ? "né avanti né indietro" : R.anticipo < 0 ? `in media ${-R.anticipo} ms in anticipo` : `in media ${R.anticipo} ms in ritardo`;
  const pass = trovaPassaggi().slice(0, 3);
  const el = $("resoconto");
  el.hidden = false;
  el.innerHTML = `
    <div class="voto"><span class="n">${R.punteggio}</span><span class="giudizio">${giudizio}</span>
      <span class="meta">a ${U()} ${r.bpm} · ${descriviTratto(i0, i1)}</span></div>
    <div class="carte">
      <div class="carta"><h4>Ritmo</h4><div class="grande">${R.tempo}</div>
        <p>${R.fasce.perfetto} a tempo · ${R.fasce.bene} bene · ${R.fasce.impreciso} imprecise · ${R.fasce.fuori} fuori · ${R.fasce.mancata} mancate</p></div>
      <div class="carta"><h4>Regolarità</h4><div class="grande">± ${R.regolarita} ms</div><p>${fraseAnt}; ${fraseTend}</p></div>
      <div class="carta"><h4>Note</h4><div class="grande">${R.note}</div>
        <p>${R.giudizi.giusta} giuste · ${R.giudizi.sbagliata} sbagliate · ${R.giudizi.incerta} incerte${R.extra ? " · " + R.extra + " colpi in più" : ""}</p></div>
    </div>
    <h4>Battuta per battuta</h4>
    <div class="misure">${celle}</div>
    ${pass.length ? `<h4>Passaggi da allenare</h4><ul>${pass.map(p => `<li>${descriviTratto(p.i0, p.i1)} — ${p.motivo}</li>`).join("")}</ul>` : ""}
    ${sbagliate.length ? `<h4>Note sbagliate</h4><ul>${sbagliate.slice(0, 10).map(s => `<li>${s}</li>`).join("")}${sbagliate.length > 10 ? `<li>… e altre ${sbagliate.length - 10}</li>` : ""}</ul>` : ""}
    <h4>Le tue prove di questo brano</h4>
    <div>${grafico(prove[B.id] || [])}</div>
    <div class="azioni">
      <button class="primario" id="rRiprova">Riprova</button>
      ${pass.length ? `<button id="rPassaggi">Vai ai passaggi difficili</button>` : ""}
    </div>
    <p class="nota" style="margin-top:12px">Scorri la partitura qui sopra: il pallino dice il tempo di ogni nota, la × una nota sbagliata.
      Le note «incerte» sono quelle in cui l'ascolto non è sicuro: valgono mezza.</p>`;
  $("rRiprova").onclick = suonaBrano;
  if ($("rPassaggi")) $("rPassaggi").onclick = () => mostra("passaggi");
  $("statoTesto").textContent = "Fatto. Il resoconto è qui sotto.";
  disegnaPassaggi();
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}
const coloreValore = v => v >= 0.85 ? "var(--bene)" : v >= 0.7 ? "#7aa36f" : v >= 0.5 ? "var(--quasi)" : "var(--male)";

function grafico(st) {
  if (st.length < 2) return `<p class="nota">${st.length ? "È la prima prova." : "Ancora nessuna prova."}</p>`;
  const w = 520, h = 120, p = 26, n = st.length;
  const x = i => p + i * (w - 2 * p) / (n - 1), y = v => h - p - v * (h - 2 * p) / 100;
  const pts = st.map((s, i) => `${x(i).toFixed(1)},${y(s.punteggio).toFixed(1)}`).join(" ");
  const pall = st.map((s, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(s.punteggio).toFixed(1)}" r="4" fill="var(--accento)"><title>${s.data.slice(0, 10)} · ${U()} ${s.bpm} · ${s.punteggio}</title></circle>
    <text x="${x(i).toFixed(1)}" y="${h - 6}" font-size="10" text-anchor="middle" fill="var(--tenue)">${s.bpm}</text>`).join("");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="max-width:100%">
    <line x1="${p}" x2="${w - p}" y1="${y(80)}" y2="${y(80)}" stroke="var(--filo)" stroke-dasharray="3 3"/>
    <text x="${w - p + 3}" y="${y(80) + 3}" font-size="10" fill="var(--tenue)">80</text>
    <polyline points="${pts}" fill="none" stroke="var(--accento)" stroke-width="1.5"/>${pall}
    <text x="2" y="${h - 6}" font-size="10" fill="var(--tenue)">${U()}</text></svg>`;
}

// ---------- passaggi difficili ----------
// errore medio di ogni attacco sulle ultime 5 prove che lo comprendono; poi gruppi di un battito (♩.):
// i battiti con errore medio ≥ 0,25 vicini si uniscono in un passaggio (al massimo 2 battute),
// che finisce sulla nota d'arrivo (il primo attacco del battito dopo).
function erroriPerAttacco() {
  const st = (prove[B.id] || []).slice().reverse();
  const out = B.attacchi.map(() => ({ e: 0, n: 0, tempo: 0, note: 0, mancate: 0 }));
  for (const p of st) for (const k in p.err) {
    const o = out[k];
    if (!o || o.n >= 5) continue;
    const [e, ms, sb] = p.err[k];
    o.e += e; o.n++;
    if (ms == null) o.mancate++; else { o.tempo += 1 - A.puntiTempo(Math.abs(ms)); o.note += sb; }
  }
  return out.map(o => o.n ? { e: o.e / o.n, n: o.n, tempo: o.tempo / o.n, note: o.note / o.n, mancate: o.mancate / o.n } : null);
}
function trovaPassaggi() {
  const err = erroriPerAttacco();
  const b = battito();
  const gruppi = new Map();
  B.attacchi.forEach((a, k) => {
    if (!err[k]) return;
    const g = Math.floor(a.q / b + 1e-6);
    const x = gruppi.get(g) || { g, ks: [], e: 0, tempo: 0, note: 0, mancate: 0 };
    x.ks.push(k); x.e += err[k].e; x.tempo += err[k].tempo; x.note += err[k].note; x.mancate += err[k].mancate;
    gruppi.set(g, x);
  });
  const cattivi = [...gruppi.values()].filter(x => x.e / x.ks.length >= 0.25).sort((p, q) => p.g - q.g);
  const passaggi = [];
  let cur = null;
  const MAX = 2 * B.battitiPerMisura;
  for (const x of cattivi) {
    if (cur && x.g === cur.gFine + 1 && x.g - cur.g0 < MAX) { cur.gFine = x.g; cur.parti.push(x); }
    else { cur = { g0: x.g, gFine: x.g, parti: [x] }; passaggi.push(cur); }
  }
  return passaggi.map(p => {
    const ks = p.parti.flatMap(x => x.ks);
    const i0 = Math.min(...ks);
    let i1 = Math.max(...ks);
    if (i1 + 1 < B.attacchi.length) i1++;                          // la nota d'arrivo
    const somma = (c) => p.parti.reduce((s, x) => s + x[c], 0);
    const n = ks.length, e = somma("e") / n;
    const t = somma("tempo"), no = somma("note"), m = somma("mancate");
    const motivi = [];
    if (t >= Math.max(no, m) * 0.8 && t > 0.3) motivi.push("soprattutto il ritmo");
    if (no > 0.3) motivi.push(`note sbagliate (${Math.round(no)})`);
    if (m > 0.3) motivi.push(`note non sentite (${Math.round(m)})`);
    return { i0, i1, e, gravita: e * Math.sqrt(n), motivo: motivi.join(", ") || "imprecisioni sparse" };
  }).sort((a, b) => b.gravita - a.gravita);
}
function disegnaPassaggi() {
  if (!B) return;
  const err = erroriPerAttacco();
  const nProve = (prove[B.id] || []).length;
  // mappa: una cella per battuta, colore dall'errore medio
  const celle = B.misure.map(([n]) => {
    const ks = B.attacchi.map((a, k) => a.misura === n ? err[k] : undefined).filter(x => x !== undefined);
    const vs = ks.filter(Boolean);
    if (!vs.length) return `<div class="vuota" title="battuta ${n}: mai provata">${n}</div>`;
    const v = 1 - vs.reduce((s, x) => s + x.e, 0) / vs.length;
    return `<div style="background:${coloreValore(v)}" title="battuta ${n}: ${Math.round(100 * v)}">${n}</div>`;
  }).join("");
  $("mappaErrori").innerHTML = nProve ? `<h4>Le battute, dalle ultime prove (${Math.min(5, nProve)} di ${nProve})</h4><div class="misure">${celle}</div>` : "";
  const pass = trovaPassaggi();
  const el = $("elencoPassaggi");
  if (!nProve) { el.innerHTML = `<p>Ancora nessuna prova: suona il brano con «Suona e valuta» nella scheda <b>Brano</b>, anche lento, e qui compariranno i passaggi da allenare.</p>`; return; }
  if (!pass.length) { el.innerHTML = `<p>Nessun passaggio sopra la soglia: nelle ultime prove l'errore medio di ogni tempo è sotto il 25%. Si può alzare il tempo.</p>`; return; }
  el.innerHTML = `<h4>Da allenare, dal più difficile</h4><table class="passaggi"><tr><th>Dove</th><th>Errore</th><th>Cosa</th><th></th></tr>` +
    pass.map((p, j) => `<tr><td>${descriviTratto(p.i0, p.i1)}</td><td><div class="barra"><i style="width:${Math.round(100 * Math.min(1, p.e))}%"></i></div></td>
      <td>${p.motivo}</td><td><button data-j="${j}">Allena</button> <button data-v="${j}">Vedi</button></td></tr>`).join("") + `</table>`;
  for (const b of el.querySelectorAll("button[data-j]")) b.onclick = () => { const p = pass[+b.dataset.j]; scegliTratto(p.i0, p.i1); mostra("allena"); };
  for (const b of el.querySelectorAll("button[data-v]")) b.onclick = () => { const p = pass[+b.dataset.v]; pulisciSegni(); segnaTratto(p.i0, p.i1); liberaPartitura(B.attacchi[p.i0].q); window.scrollTo({ top: 0, behavior: "smooth" }); };
}

// ---------- allenamento a ritroso ----------
let tratto = null;           // [i0, i1] scelto per l'allenamento
function scegliTratto(i0, i1) {
  tratto = [i0, i1];
  const dita = imp.progressi[`${B.id}:${i0}-${i1}:insieme:dita`];
  scegliFase(dita && dita.completo ? "tempo" : "dita");
  $("pDa").value = B.attacchi[i0].misura;
  $("pA").value = B.attacchi[i1].misura;
  $("pArrivo").checked = false;
  aggiornaTratto(true);
}
// da punto a punto: nella scheda Allenamento un tocco sulla partitura fissa l'inizio, il tocco dopo la fine
let primoPunto = null;
function attaccoVicino(x) {
  let best = 0;
  B.attacchi.forEach((a, k) => { if (Math.abs(xDi(a.q) - x) < Math.abs(xDi(B.attacchi[best].q) - x)) best = k; });
  return best;
}
function toccoPartitura(e) {
  if (pannello !== "allena" || al || corsa || !B) return;
  const k = attaccoVicino(e.clientX - $("rullo").getBoundingClientRect().left);
  const sx = $("striscia").scrollLeft;
  if (primoPunto == null) {
    primoPunto = k;
    pulisciSegni(); segnaTratto(k, k);
    $("pPunti").innerHTML = `Inizio: <b>${descriviNota(k)}</b>. Ora tocca l'ultima nota.`;
  } else {
    const [i0, i1] = [Math.min(primoPunto, k), Math.max(primoPunto, k)];
    primoPunto = null;
    scegliTratto(i0, i1);
    $("striscia").scrollLeft = sx;          // la vista resta dov'era
  }
}
function spostaPunto(j, d) {
  if (al || !tratto) return;
  primoPunto = null;
  const t = [...tratto];
  t[j] = Math.max(0, Math.min(B.attacchi.length - 1, t[j] + d));
  if (t[0] > t[1]) t[1 - j] = t[j];
  const sx = $("striscia").scrollLeft;
  scegliTratto(t[0], t[1]);
  $("striscia").scrollLeft = sx;
}
function descriviNota(k) {
  const a = B.attacchi[k], m = B.misure.find(m => m[0] === a.misura);
  const bt = Math.floor((a.q - m[1]) / battito() + 1e-6) + 1;
  return `${a.note.map(nome).join("·")} (b. ${a.misura}, ${bt}° tempo)`;
}
function aggiornaTratto(daPassaggio) {
  if (!B) return;
  if (!daPassaggio || !tratto) tratto = indiciBattute(+$("pDa").value, +$("pA").value, $("pArrivo").checked);
  const [i0, i1] = tratto;
  const pr = imp.progressi[chiaveTratto()];
  primoPunto = null;
  $("pPunti").innerHTML = `Da <b>${descriviNota(i0)}</b> a <b>${descriviNota(i1)}</b>. Per cambiarlo tocca sulla partitura la prima nota, poi l'ultima, o usa ◀ ▶.`;
  $("striscia").classList.toggle("scegli", pannello === "allena");
  $("pDescr").textContent = descriviTratto(i0, i1) + (pr ? ` · l'ultima volta: ${pr.k} di ${i1 - i0 + 1} a ${U()} ${pr.bpm}${pr.completo ? " (completo)" : ""}` : "");
  if (pr && !al) { $("bpmAllena").value = pr.bpm; etichetteTolleranza(); }
  $("avvisoTaratura").hidden = imp.ritardo != null || DEMO;
  if (pannello === "allena" && !corsa) { pulisciSegni(); segnaTratto(i0, i1, imp.modo); liberaPartitura(B.attacchi[i0].q); }
}
const faseDi = modo => modo === "insieme" ? imp.fase : modo === "destra" ? "tempo" : "dita";
const chiaveTratto = () => `${B.id}:${tratto[0]}-${tratto[1]}:${imp.modo}:${faseDi(imp.modo)}`;
const chiaveAl = () => `${B.id}:${al.i0}-${al.i1}:${al.modo}:${al.fase}`;
// tolleranza della fase del tempo: una percentuale del battito (più larga nel lento), mai sotto 40 ms
const tollMs = (bpm, pct) => Math.max(40, Math.round(pct / 100 * 60 / bpm * 1000));
function etichetteTolleranza() {
  const bpm = +$("bpmAllena").value || 40;
  for (const o of $("tolleranza").options) o.textContent = `${{ 5: "stretta", 8: "media", 12: "larga" }[o.value]}: ±${tollMs(bpm, +o.value)} ms`;
}
const DESCR_MODI = {
  destra: "Solo la mano destra, sulle corde a vuoto: stesso ritmo, stesse corde: sotto la partitura l'esagramma (sei righe = sei corde) con le dita p i m a e il ritmo. Il metronomo dà il tempo; si giudica il ritmo e se suona la corda giusta.",
  sinistra: "Senza tempo: l'app aspetta ogni attacco e va avanti solo quando sente le note giuste. Serve a trovare le posizioni della mano sinistra con calma; il giro riesce se non ci sono sbagli.",
  insieme: "Tutte e due le mani, in due strati: prima le dita (note giuste nell'ordine giusto, il ritmo può respirare), poi il tempo (a metronomo, con la tolleranza scelta)."
};
const DESCR_FASI = {
  dita: "Fase 1 · le dita. Contano le note e il loro ordine; il ritmo basta che sia ragionevole: ogni nota entro metà della distanza dalla vicina, misurata dalla nota suonata prima, quindi rallentare o esitare un poco non è un errore. Finita la catena si passa al tempo.",
  tempo: "Fase 2 · il tempo. Tutto il passaggio a metronomo: ogni nota entro la tolleranza (una parte del battito, quindi più larga quando il tempo è lento)."
};
function scegliFase(f) {
  imp.fase = f; salvaImp();
  for (const b of document.querySelectorAll("#fasi button")) b.classList.toggle("scelto", b.dataset.f === f);
  $("descrFase").textContent = DESCR_FASI[f];
  aggiornaTratto(true);
}
function scegliModo(m) {
  imp.modo = m; salvaImp();
  for (const b of document.querySelectorAll("#modi button")) b.classList.toggle("scelto", b.dataset.m === m);
  $("descrModo").textContent = DESCR_MODI[m];
  $("rigaFasi").hidden = m !== "insieme";
  aggiornaTratto(true);
}

async function avviaAllenamento() {
  if (!tratto) aggiornaTratto();
  try { await apriAudio(); } catch (e) { $("esitoGiro").textContent = "Il microfono non è disponibile."; return; }
  const [i0, i1] = tratto;
  const pr = imp.progressi[chiaveTratto()];
  const bpm = leggiBpm("bpmAllena");
  const fase = faseDi(imp.modo);
  const n = i1 - i0 + 1;
  // fase del tempo in «insieme»: tutto il passaggio (le dita ci sono già); in mano destra la catena è a tempo
  const k0 = fase === "tempo" && imp.modo === "insieme" ? n : 1;
  al = { i0, i1, modo: imp.modo, fase, bpm, richiesti: +$("richiesti").value, pct: +$("tolleranza").value,
    k: pr && !pr.completo && pr.bpm === bpm ? pr.k : k0, riusciti: 0, giri: 0, buoni: 0, inizio: new Date().toISOString(), giriFatti: [] };
  $("diarioAllena").innerHTML = "";
  comandi(false);
  scriviCatena();
  while (al) {
    const da = al.i1 - al.k + 1;
    let esito;
    $("esitoGiro").className = ""; $("esitoGiro").textContent = al.modo === "sinistra" ? "Suona quando vuoi." : "Ascolta l'attacco…";
    if (al.modo !== "sinistra") $("statoTesto").innerHTML = `giro ${al.giri + 1} · ${al.k} ${al.k === 1 ? "nota" : "note"} · attacco di 2 battiti, poi suona dal riquadro`;
    if (al.modo === "sinistra") {
      const r = await giroInAttesa(da, al.i1);
      if (!r || !al) break;
      esito = r.errori ? { ok: false, perche: perchéAttesa(r) } : { ok: true };
      esito.buchi = r.buchi;
    } else {
      const toll = tollMs(al.bpm, al.pct) / 1000;
      const r = await giroATempo({ i0: da, i1: al.i1, bpm: al.bpm, modo: al.modo, conta: 2, metronomo: $("metAllena").checked, sudd: $("suddivisione").checked,
        giudizio: al.fase === "dita" ? "relativo" : "assoluto", toll });
      if (!r || !al) break;
      esito = valutaGiro(r, al.fase === "dita" ? null : toll * 1000);
    }
    if (buchiNelGiro(esito)) { await new Promise(ok => setTimeout(ok, 1000)); continue; }
    registraGiro(esito);
    if (!al) break;
    await new Promise(ok => setTimeout(ok, esito.ok ? 900 : 1500));
  }
}
// un giro in cui il computer ha perso pezzi di audio non si giudica: si ripete
function buchiNelGiro(esito) {
  if (!esito.buchi) return false;
  $("esitoGiro").className = "";
  $("esitoGiro").textContent = "L'audio ha avuto un intoppo (computer carico): giro da rifare, non conta.";
  return true;
}
// toll null = fase delle dita: il tempo non si giudica (l'abbinamento relativo ha già scartato le note fuori posto)
function valutaGiro(r, toll) {
  if (r.buchi) return { buchi: r.buchi };
  r.righe.forEach((x, i) => {
    // fra note fitte la tolleranza non supera un terzo della distanza dalla vicina (sedicesimi lenti: ~80 ms)
    const vic = Math.min(i > 0 ? x.t - r.righe[i - 1].t : 9, i < r.righe.length - 1 ? r.righe[i + 1].t - x.t : 9);
    x.toll = toll == null ? null : Math.max(40, Math.min(toll, vic * 1000 / 3));
  });
  for (const x of r.righe) {
    const a = B.attacchi[x.k], dove = `${a.note.length > 1 ? "l'accordo" : nome(x.note[0])} di b. ${a.misura}`;
    if (x.scarto == null) return { ok: false, perche: `non ho sentito ${dove}` };
    const ms = Math.round(x.scarto * 1000);
    const sb = (x.giudizi || []).find(g => g.esito === "sbagliata");
    if (sb) return { ok: false, perche: al.modo === "destra" ? `corda sbagliata: attesa la ${corde().indexOf(sb.nota) + 1}ª (${nome(sb.nota)}, b. ${a.misura}), sentito ${sb.sentita != null ? nome(sb.sentita) : "altro"}` : `${nome(sb.nota)} di b. ${a.misura}: sentito ${sb.sentita != null ? nome(sb.sentita) : "altro"}` };
    if (x.toll != null && Math.abs(ms) > x.toll) return { ok: false, perche: `${dove}: ${Math.abs(ms)} ms ${ms < 0 ? "in anticipo" : "in ritardo"}` };
  }
  if (r.extra.length > (toll == null ? 2 : 1)) return { ok: false, perche: `${r.extra.length} colpi in più` };
  const scarti = r.righe.map(x => Math.abs(x.scarto * 1000));
  return { ok: true, nota: toll == null ? "note giuste" : `scarto massimo ${Math.round(Math.max(...scarti))} ms (tolleranza ${Math.round(toll)})` };
}
function perchéAttesa(r) {
  const s = r.sbagli[0], a = B.attacchi[s.k], g = s.giudizi.find(x => x.esito === "sbagliata");
  return `${r.errori} ${r.errori === 1 ? "sbaglio" : "sbagli"}; il primo: ${nome(g.nota)} di b. ${a.misura}, sentito ${g.sentita != null ? nome(g.sentita) : "altro"}`;
}
function registraGiro(esito) {
  al.giri++;
  al.giriFatti.push({ k: al.k, fase: al.fase, ok: !!esito.ok, perche: esito.perche || null });
  const n = al.i1 - al.i0 + 1;
  const li = document.createElement("li");
  li.innerHTML = `${al.k} ${al.k === 1 ? "nota" : "note"}: ${esito.ok ? "riuscito" : "<span style='color:var(--male)'>" + esito.perche + "</span>"}`;
  $("diarioAllena").prepend(li);
  $("esitoGiro").className = esito.ok ? "ok" : "no";
  if (esito.ok) {
    al.buoni++; al.riusciti++;
    $("esitoGiro").textContent = "Riuscito" + (esito.nota ? ` · ${esito.nota}` : "");
    if (al.riusciti >= al.richiesti) {
      if (al.k >= n && al.fase === "dita" && al.modo === "insieme") {
        // le dita ci sono: secondo strato, tutto il passaggio a tempo
        imp.progressi[chiaveAl()] = { k: n, bpm: al.bpm, completo: true, data: new Date().toISOString() };
        al.fase = "tempo"; imp.fase = "tempo"; al.riusciti = 0;
        const pt = imp.progressi[chiaveAl()];
        if (pt && pt.completo) delete imp.progressi[chiaveAl()];
        salvaImp();
        for (const b of document.querySelectorAll("#fasi button")) b.classList.toggle("scelto", b.dataset.f === "tempo");
        $("descrFase").textContent = DESCR_FASI.tempo;
        li.insertAdjacentHTML("beforeend", ` → <b>le dita ci sono: ora a tempo</b>`);
        $("esitoGiro").textContent = `Le dita ci sono. Ora tutto il passaggio a tempo (±${tollMs(al.bpm, al.pct)} ms).`;
        scriviCatena();
        return;
      }
      if (al.k >= n) {
        $("esitoGiro").textContent = `Passaggio completo a ${U()} ${al.bpm}, ${al.modo === "insieme" ? "con tutte e due le mani" : al.modo === "destra" ? "in mano destra" : "in mano sinistra"}.`;
        imp.progressi[chiaveAl()] = { k: n, bpm: al.bpm, completo: true, data: new Date().toISOString() };
        if (al.modo === "insieme") imp.fase = "dita";        // al prossimo tempo si ricomincia dalle dita
        salvaImp();
        chiudiDiario(true);
        const prossimo = al.modo === "destra" ? "la mano sinistra" : al.modo === "sinistra" ? "le due mani insieme" : `${U()} ${al.bpm + 4}`;
        al = null;
        comandi(false);
        $("catena").textContent = "Completo";
        $("pallini").textContent = "";
        $("diarioAllena").insertAdjacentHTML("afterbegin", `<li><b>Completo.</b> Prossimo passo: ${prossimo}.</li>`);
        return;
      }
      al.k++; al.riusciti = 0;
      li.insertAdjacentHTML("beforeend", ` → <b>aggiungo una nota</b>`);
    }
  } else {
    al.riusciti = 0;
    $("esitoGiro").textContent = esito.perche;
  }
  imp.progressi[chiaveAl()] = { k: al.k, bpm: al.bpm, completo: false, data: new Date().toISOString() };
  salvaImp();
  scriviCatena();
}
function scriviCatena() {
  if (!al) return;
  const n = al.i1 - al.i0 + 1, da = al.i1 - al.k + 1, a = B.attacchi[da];
  const fase = al.modo === "insieme" ? `<span class="meta" style="font-size:16px;display:block">${al.fase === "dita" ? "fase 1 · le dita (ritmo libero)" : `fase 2 · il tempo (±${tollMs(al.bpm, al.pct)} ms)`}</span>` : "";
  $("catena").innerHTML = `${fase}${al.k} di ${n} <span class="meta" style="font-size:16px">da ${a.note.map(nome).join("·")} (b. ${a.misura}) all'arrivo · ${U()} ${al.bpm}</span>`;
  $("pallini").textContent = "●".repeat(al.riusciti) + "○".repeat(Math.max(0, al.richiesti - al.riusciti));
}
function chiudiDiario(completo) {
  if (!al || !al.giri) return;
  diario.push({ data: al.inizio, brano: B.id, da: al.i0, a: al.i1, modo: al.modo, fase: al.fase, bpm: al.bpm, giri: al.giri, riusciti: al.buoni, arrivato: al.k, completo,
    dettaglio: al.giriFatti.slice(-200) });
  if (diario.length > 500) diario.shift();
  mem.scrivi("diario", diario);
}
function fermaAllenamento() {
  if (!al) return;
  chiudiDiario(false);
  al = null;
  ferma();
  comandi(false);
  $("esitoGiro").className = ""; $("esitoGiro").textContent = "Fermato. «Comincia» riprende da dove sei arrivato.";
  aggiornaTratto(true);
}

// ---------- accordatore ----------
let acc = null;
function altezza(buf, sr) {
  let rms = 0;
  for (const v of buf) rms += v * v;
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.004) return null;
  const minP = Math.floor(sr / 1000), maxP = Math.floor(sr / 70), W = buf.length - maxP;
  const d = new Float32Array(maxP + 1);
  for (let tau = minP; tau <= maxP; tau++) {
    let s = 0;
    for (let i = 0; i < W; i += 2) { const x = buf[i] - buf[i + tau]; s += x * x; }
    d[tau] = s;
  }
  // differenza normalizzata (YIN): primo minimo sotto la soglia
  let somma = 0, tau = -1;
  const dn = new Float32Array(maxP + 1);
  for (let t = 1; t <= maxP; t++) { somma += t >= minP ? d[t] : 0; dn[t] = t < minP ? 1 : d[t] * (t - minP + 1) / (somma || 1); }
  for (let t = minP + 1; t < maxP; t++) if (dn[t] < 0.15 && dn[t] <= dn[t - 1] && dn[t] <= dn[t + 1]) { tau = t; break; }
  if (tau < 0) return null;
  const a = dn[tau - 1], b = dn[tau], c = dn[tau + 1], sp = (a - c) / (2 * (a - 2 * b + c) || 1);
  return sr / (tau + (Math.abs(sp) < 1 ? sp : 0));
}
async function accendiAccordatore() {
  if (acc) { spegniAccordatore(); return; }
  try { await apriAudio(); } catch (e) { $("accHz").textContent = "microfono non disponibile"; return; }
  acc = { storia: [] };
  $("btnAccorda").textContent = "Spegni l'accordatore";
  const buf = new Float32Array(analizzatore.fftSize);
  let alterna = 0;
  const giro = () => {
    if (!acc) return;
    if (alterna++ % 2 === 0) {
      analizzatore.getFloatTimeDomainData(buf);
      const f = altezza(buf, ctx.sampleRate);
      if (f) { acc.storia.push(f); if (acc.storia.length > 5) acc.storia.shift(); acc.zitto = 0; }
      else if (++acc.zitto > 20) acc.storia = [];
      mostraAltezza();
    }
    requestAnimationFrame(giro);
  };
  giro();
}
function spegniAccordatore() { acc = null; $("btnAccorda").textContent = "Accendi l'accordatore"; }
function mostraAltezza() {
  if (!acc.storia.length) { $("accNota").textContent = "–"; $("accHz").textContent = "suona una corda"; $("accCents").textContent = ""; $("accAgo").style.left = "50%"; return; }
  const f = acc.storia.slice().sort((a, b) => a - b)[acc.storia.length >> 1];
  const m = 69 + 12 * Math.log2(f / imp.la), mr = Math.round(m), cents = Math.round(100 * (m - mr));
  $("accNota").textContent = nome(mr);
  $("accHz").textContent = `${f.toFixed(1)} Hz`;
  $("accCents").textContent = Math.abs(cents) <= 3 ? "intonata" : `${cents > 0 ? "+" : ""}${cents} cent ${cents > 0 ? "(crescente)" : "(calante)"}`;
  $("accCents").style.color = Math.abs(cents) <= 3 ? "var(--bene)" : Math.abs(cents) <= 10 ? "var(--quasi)" : "var(--male)";
  $("accAgo").style.left = `${50 + Math.max(-50, Math.min(50, cents))}%`;
  $("accAgo").style.background = Math.abs(cents) <= 3 ? "var(--bene)" : "var(--tenue)";
  const vicina = corde().reduce((b, c) => Math.abs(c - m) < Math.abs(b - m) ? c : b);
  for (const b of $("accCorde").children) b.classList.toggle("vicina", +b.dataset.m === vicina && Math.abs(vicina - m) < 1.5);
}
async function suonaCorda(m) {
  await apriContesto();
  suonaBuffer(sintetizza([[m, 0, 3]], 3));
}

// ---------- metronomo ----------
let met = null;
function avviaMetronomo() {
  if (met) { fermaMetronomo(); return; }
  apriContesto().then(() => {
    if (corsa) ferma();
    met = { prossimo: ctx.currentTime + 0.1, j: 0, colpi: [] };
    $("metVia").textContent = "Ferma";
    met.timer = setInterval(programmaMet, 25);
    disegnaBattiti();
    requestAnimationFrame(luciMet);
  });
}
function programmaMet() {
  const bpm = +$("metBpm").value || 60, misura = +$("metMisura").value, sudd = +$("metSudd").value;
  const passo = 60 / bpm / sudd;
  while (met.prossimo < ctx.currentTime + 0.12) {
    const j = met.j, batt = Math.floor(j / sudd) % misura, sotto = j % sudd;
    suonaBuffer(bufferClick(sotto ? 0 : batt === 0 && misura > 1 ? 2 : 1), met.prossimo);
    if (!sotto) { met.colpi.push([met.prossimo, batt]); battitoVisto("metPendolo", met.prossimo, batt, misura); }
    met.prossimo += passo; met.j++;
  }
}
function luciMet() {
  if (!met) return;
  const ora = ctx.currentTime - (ctx.outputLatency || 0);
  while (met.colpi.length && met.colpi[0][0] <= ora) {
    const [, b] = met.colpi.shift();
    [...$("metBattiti").children].forEach((e, i) => e.classList.toggle("acceso", i === b));
  }
  requestAnimationFrame(luciMet);
}
function fermaMetronomo() {
  if (!met) return;
  clearInterval(met.timer); met = null;
  fermaPendolo("metPendolo");
  $("metVia").textContent = "Avvia";
  for (const e of $("metBattiti").children) e.classList.remove("acceso");
}
function disegnaBattiti() {
  const n = +$("metMisura").value;
  $("metBattiti").innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i === 0 && n > 1 ? "primo" : ""}"></i>`).join("");
  imp.met = { bpm: +$("metBpm").value, misura: n, sudd: +$("metSudd").value }; salvaImp();
}
let tocchi = [];
function batti() {
  const t = performance.now();
  tocchi = tocchi.filter(x => t - x < 3000);
  tocchi.push(t);
  if (tocchi.length >= 3) {
    const d = (tocchi[tocchi.length - 1] - tocchi[0]) / (tocchi.length - 1);
    $("metBpm").value = Math.round(60000 / d);
    disegnaBattiti();
  }
}

// ---------- tarature ----------
async function registra(secondi) {
  await apriAudio();
  const sr = ctx.sampleRate, reg = new Float32Array(Math.round(secondi * sr));
  let n = 0;
  return new Promise(ok => {
    const f = (i, d) => {
      const k = Math.min(d.length, reg.length - n);
      reg.set(d.subarray(0, k), n); n += k;
      if (n >= reg.length) { ascoltatori = ascoltatori.filter(g => g !== f); ok(reg); }
    };
    ascoltatori.push(f);
  });
}
async function taraSilenzio() {
  $("esSilenzio").textContent = "silenzio… (3 s)";
  const reg = await registra(3);
  imp.minimo = new A.Rilevatore(ctx.sampleRate).taraSilenzio(reg);
  let p = 0; for (const v of reg) p = Math.max(p, Math.abs(v));
  salvaImp();
  $("esSilenzio").textContent = `fatto: rumore di fondo ${Math.round(20 * Math.log10(p + 1e-9))} dBFS`;
}
async function taraRitardo() {
  await apriAudio();
  const sr = ctx.sampleRate, q = 60 / 80, t0 = ctx.currentTime + 0.4;
  const clicks = [];
  for (let b = 0; b < 12; b++) { suonaBuffer(bufferClick(b % 4 === 0 ? 2 : 1), t0 + b * q); if (b >= 4) clicks.push(t0 + b * q); }
  $("esRitardo").textContent = "pizzica insieme al click, dal quinto colpo…";
  const ril = new A.Rilevatore(sr);
  if (imp.minimo != null) ril.minimo = imp.minimo;
  const sentiti = [];
  let primo = null;
  const f = (i, d) => { if (primo == null) { primo = i; ril.t0 = i / sr; } for (const o of ril.feed(d)) sentiti.push(o.t); };
  ascoltatori.push(f);
  await new Promise(ok => setTimeout(ok, (12 * q + 1.2) * 1000));
  ascoltatori = ascoltatori.filter(g => g !== f);
  const scarti = [];
  for (const c of clicks) {
    let bd = 1e9;
    for (const s of sentiti) if (Math.abs(s - c) < Math.abs(bd)) bd = s - c;
    if (Math.abs(bd) < 0.25) scarti.push(bd);
  }
  if (scarti.length < 5) { $("esRitardo").textContent = `ho sentito solo ${scarti.length} colpi su 8: riprova un po' più forte`; return; }
  scarti.sort((a, b) => a - b);
  const med = scarti[scarti.length >> 1];
  const disp = scarti.map(v => Math.abs(v - med)).sort((a, b) => a - b)[scarti.length >> 1];
  imp.ritardo = med; salvaImp();
  $("esRitardo").textContent = `fatto: ${Math.round(med * 1000)} ms (colpi ±${Math.round(disp * 1000)} ms)`;
}

// ---------- schede ----------
function mostra(p) {
  if (p !== pannello) { if (corsa) ferma(); fermaAllenamento(); }
  if (p !== "accordatore") spegniAccordatore();
  pannello = p;
  $("striscia").classList.toggle("scegli", p === "allena");
  for (const b of document.querySelectorAll("#schede button")) b.classList.toggle("scelto", b.dataset.p === p);
  for (const s of document.querySelectorAll(".pannello")) s.hidden = s.dataset.p !== p;
  $("zonaLeggio").hidden = p === "accordatore" || p === "metronomo";
  if (p === "passaggi") disegnaPassaggi();
  if (p === "allena") aggiornaTratto(true);
  if (p === "brano" && B && !corsa) { pulisciSegni(); posiziona(0); }
  if (p === "metronomo" && B && !met) {
    if (!imp.met.usato) { $("metBpm").value = B.tempo; $("metMisura").value = B.battitiPerMisura; $("metSudd").value = B.suddivisione; }
    $("metUnita").textContent = B.battito === 1.5 ? "♩. al minuto" : "al minuto";
    disegnaBattiti();
  }
}

// ---------- menu dei brani e crediti ----------
const esc = t => String(t == null ? "" : t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function riempiMenu() {
  const sel = $("selBrano");
  sel.innerHTML = "";
  const gruppi = new Map();
  for (const b of INDICE.brani) {
    const g = b.autore + (b.opera ? " · " + b.opera : "");
    if (!gruppi.has(g)) gruppi.set(g, []);
    gruppi.get(g).push(b);
  }
  for (const [g, lista] of gruppi) {
    const og = document.createElement("optgroup");
    og.label = g;
    for (const b of lista) { const o = document.createElement("option"); o.value = b.id; o.textContent = b.titolo; og.appendChild(o); }
    sel.appendChild(og);
  }
}
function schedaBrano(b) {
  const lic = b.licenza_url ? `<a href="${esc(b.licenza_url)}" target="_blank" rel="noopener">${esc(b.licenza)}</a>` : esc(b.licenza);
  const orig = b.origine_url ? `<a href="${esc(b.origine_url)}" target="_blank" rel="noopener">${esc(b.origine)}</a>` : esc(b.origine || "");
  return `<b>${esc(b.autore)}</b>, ${esc(b.titolo)}${b.opera ? ` <i>(${esc(b.opera)})</i>` : ""}<br>
    edizione: ${esc(b.fonte)}${b.anno ? `, ${esc(b.anno)}` : ""} · trascrizione: ${esc(b.trascrittore || "—")} · ${orig} · licenza ${lic}`;
}
function mostraCrediti(id) {
  const voce = typeof id === "string" && INDICE.brani.find(b => b.id === id);
  $("crQuesto").innerHTML = voce ? `<h3>Questo brano</h3><p>${schedaBrano(voce)}</p>` : "";
  $("crElenco").innerHTML = INDICE.brani.map(b => `<li>${schedaBrano(b)}</li>`).join("");
  $("dlgCrediti").showModal();
}

// ---------- avvio ----------
async function avvio() {
  $("bandaDemo").hidden = !DEMO;
  try {
    INDICE = await (await fetch(BRANI + "elenco.json")).json();
  } catch (e) {
    $("statoTesto").textContent = "Non riesco a leggere l'elenco dei brani (" + BRANI + "elenco.json).";
    return;
  }
  riempiMenu();
  const chiesto = new URLSearchParams(location.search).get("brano");
  $("selBrano").value = [chiesto, imp.brano].find(x => x && INDICE.brani.some(b => b.id === x)) || INDICE.brani[0].id;
  $("selBrano").onchange = () => caricaBrano($("selBrano").value);
  $("btnCrediti").onclick = mostraCrediti;
  for (const b of document.querySelectorAll("#schede button")) b.onclick = () => mostra(b.dataset.p);
  for (const b of document.querySelectorAll(".bpm button[data-bpm]")) b.onclick = () => {
    const inp = b.parentElement.querySelector("input");
    inp.value = +inp.value + +b.dataset.bpm;
    if (inp.id === "metBpm") { imp.met.usato = true; disegnaBattiti(); } else leggiBpm(inp.id);
  };
  $("bpmBrano").onchange = () => leggiBpm("bpmBrano");
  $("bpmAllena").onchange = () => leggiBpm("bpmAllena");
  $("btnSuona").onclick = suonaBrano;
  $("btnAscolta").onclick = () => { const [i0, i1] = indiciBattute(+$("daBatt").value, +$("aBatt").value, false); $("resoconto").hidden = true; ascolta(i0, i1, leggiBpm("bpmBrano"), "insieme"); };
  for (const b of document.querySelectorAll(".btnFerma")) b.onclick = () => { if (al) fermaAllenamento(); else ferma(); };
  $("btnOriginale").onclick = () => mostraCrediti(B && B.id);
  // allenamento
  for (const b of document.querySelectorAll("#modi button")) b.onclick = () => { if (!al) scegliModo(b.dataset.m); };
  for (const id of ["pDa", "pA", "pArrivo"]) $(id).onchange = () => aggiornaTratto(false);
  $("richiesti").value = imp.richiesti; $("tolleranza").value = imp.tolleranza;
  $("metAllena").checked = imp.metAllena; $("suddivisione").checked = imp.sudd;
  $("richiesti").onchange = () => { imp.richiesti = +$("richiesti").value; salvaImp(); if (al) { al.richiesti = imp.richiesti; scriviCatena(); } };
  $("tolleranza").onchange = () => { imp.tolleranza = +$("tolleranza").value; salvaImp(); if (al) { al.pct = imp.tolleranza; scriviCatena(); } };
  for (const b of document.querySelectorAll("#fasi button")) b.onclick = () => { if (!al) scegliFase(b.dataset.f); };
  $("bpmAllena").addEventListener("change", etichetteTolleranza);
  etichetteTolleranza();
  $("metAllena").onchange = () => { imp.metAllena = $("metAllena").checked; salvaImp(); };
  $("suddivisione").onchange = () => { imp.sudd = $("suddivisione").checked; salvaImp(); };
  $("btnAllena").onclick = avviaAllenamento;
  $("striscia").addEventListener("click", toccoPartitura);
  for (const b of document.querySelectorAll("button[data-sp]")) b.onclick = () => { const [j, d] = b.dataset.sp.split(",").map(Number); spostaPunto(j, d); };
  $("btnAscoltaPass").onclick = () => { if (!tratto) aggiornaTratto(); ascolta(tratto[0], tratto[1], leggiBpm("bpmAllena"), imp.modo === "destra" ? "destra" : "insieme"); };
  // accordatore
  $("btnAccorda").onclick = accendiAccordatore;
  // metronomo
  $("metBpm").value = imp.met.bpm; $("metMisura").value = imp.met.misura; $("metSudd").value = imp.met.sudd;
  $("metVia").onclick = avviaMetronomo;
  $("metTap").onclick = () => { imp.met.usato = true; batti(); };
  for (const id of ["metBpm", "metMisura", "metSudd"]) $(id).onchange = () => { imp.met.usato = true; disegnaBattiti(); };
  disegnaBattiti();
  // impostazioni
  $("accLa").textContent = imp.la;
  $("selLa").value = String(imp.la);
  if (imp.minimo != null) $("esSilenzio").textContent = "già misurato";
  if (imp.ritardo != null) $("esRitardo").textContent = `già misurato: ${Math.round(imp.ritardo * 1000)} ms`;
  $("btnImpostazioni").onclick = async () => { $("dlgImpostazioni").showModal(); try { await apriAudio(); } catch (e) { /* senza permesso */ } };
  $("selMic").onchange = async () => { imp.mic = $("selMic").value; imp.minimo = null; salvaImp(); $("esSilenzio").textContent = "da rifare con il nuovo microfono"; await chiudiMic(); await apriAudio(); };
  $("selLa").onchange = () => { imp.la = +$("selLa").value; $("accLa").textContent = imp.la; salvaImp(); };
  $("btnSilenzio").onclick = taraSilenzio;
  $("btnRitardo").onclick = taraRitardo;
  $("btnScarica").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ prove, diario, progressi: imp.progressi }, null, 1)], { type: "application/json" }));
    a.download = `leggio_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  $("btnAzzera").onclick = () => { if (confirm("Cancello tutte le prove di questo brano? (Gli allenamenti restano.)")) { delete prove[B.id]; mem.scrivi("prove", prove); disegnaPassaggi(); } };
  document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.code !== "Space") return;
    e.preventDefault();
    if (pannello === "brano") corsa ? ferma() : suonaBrano();
    else if (pannello === "allena") al ? fermaAllenamento() : avviaAllenamento();
    else if (pannello === "metronomo") avviaMetronomo();
  });
  window.addEventListener("resize", () => { if (!corsa && B && !$("striscia").classList.contains("libera")) posiziona(0); });
  scegliModo(imp.modo);
  scegliFase(imp.fase);
  await caricaBrano($("selBrano").value);
  if (imp.ritardo == null && !DEMO && B) $("statoTesto").innerHTML = "Prima volta: apri <b>Impostazioni</b>, scegli il microfono e fai le due tarature (silenzio e ritardo). Per provare senza chitarra: <a href=\"?demo\">modalità demo</a>.";
  // iOS/Safari: il suono si sblocca al primo tocco sulla pagina
  const sblocca = () => { apriContesto().catch(() => { }); };
  document.addEventListener("pointerdown", sblocca, { once: true, capture: true });
  window.PRONTO = true;
}
avvio();
