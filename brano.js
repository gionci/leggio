// brano.js — da un MusicXML (testo) ai dati che servono all'allenatore, nel browser.
// È la traduzione di strumenti/dati.py del Leggio Sor, così ogni brano della biblioteca si prepara
// al caricamento, senza file calcolati a parte.
//
// - attacchi: istante in quarti dall'inizio, note che partono (MIDI, altezza reale), battuta, corde e tasti;
//   le note legate non sono nuovi attacchi; le acciaccature restano fuori.
// - suoni: ogni nota con inizio e fine (legature comprese), per la chitarra sintetica di «Ascolta».
// - misure: [numero, inizio in quarti, durata in quarti].
// - corde: la partitura dice al più le dita della sinistra (e qualche barra «CIII»), quasi mai le corde.
//   Si cercano con una ricerca a fascio: niente due note sulla stessa corda, la mano entro 4 tasti,
//   pochi spostamenti, preferenza per le corde a vuoto e le posizioni basse; barre, «0» e corde scritte
//   (<string>) come vincoli.
// - accordatura: normale; se il brano scende sotto il Mi basso, la sesta si abbassa fino alla nota più grave.
// Ritornelli e prima/seconda volta non si srotolano: il brano si legge una volta, dall'inizio alla fine.
"use strict";
(function () {
  const PASSO = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const ROMANI = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };
  const TEMPI = [[/grave|largo|lento/i, 50], [/larghetto|adagio/i, 60], [/andantino/i, 80], [/andante/i, 72],
    [/moderato|tempo di minuetto|minuetto|menuet/i, 100], [/allegretto/i, 108], [/vivace|presto|vivo/i, 140], [/allegro/i, 126]];
  const figli = (el, tag) => [...el.children].filter(c => c.tagName === tag);
  const figlio = (el, tag) => [...el.children].find(c => c.tagName === tag) || null;
  const testo = (el, sel) => { const x = el.querySelector(sel); return x ? x.textContent.trim() : null; };

  function midi(p) {
    return 12 * (+testo(p, "octave") + 1) + PASSO[testo(p, "step")] + Math.round(+(testo(p, "alter") || 0));
  }

  function leggi(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("il file MusicXML non si legge");
    if (!doc.querySelector("score-partwise")) throw new Error("serve un MusicXML «partwise» (non «timewise» né compresso .mxl)");
    const parte = doc.querySelector("score-partwise > part");
    let divisions = 1, tempo = null, metro = [4, 4], parola = null;
    const misure = [], suoni = [], barre = {}, aperte = new Map();
    let q0 = 0;
    for (const m of figli(parte, "measure")) {
      const n = parseInt(m.getAttribute("number"), 10) || misure.length + 1;
      for (const a of figli(m, "attributes")) {
        if (testo(a, "divisions")) divisions = +testo(a, "divisions");
        if (a.querySelector("time beats")) metro = [parseInt(testo(a, "time beats"), 10), +testo(a, "time beat-type")];
      }
      for (const s of m.querySelectorAll("sound[tempo]")) if (tempo == null) tempo = +s.getAttribute("tempo");
      for (const mt of m.querySelectorAll("metronome")) if (tempo == null && testo(mt, "per-minute")) {
        const u = testo(mt, "beat-unit"), pt = mt.querySelector("beat-unit-dot") ? 1.5 : 1;
        const q = ({ whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25 }[u] || 1) * pt;
        tempo = parseFloat(testo(mt, "per-minute")) * q;           // in semiminime al minuto, come <sound tempo>
      }
      for (const w of m.querySelectorAll("words")) {
        const t = w.textContent || "";
        const r = t.match(/^\s*C\s*([IVX]+)/);
        if (r && ROMANI[r[1]]) barre[n] = ROMANI[r[1]];
        if (!parola && misure.length < 2) { const x = TEMPI.find(([re]) => re.test(t)); if (x) parola = x[1]; }
      }
      let t = 0, ultimo = 0, lung = 0;
      for (const el of m.children) {
        if (el.tagName === "backup") t -= +testo(el, "duration");
        else if (el.tagName === "forward") t += +testo(el, "duration");
        else if (el.tagName === "note") {
          const d = +(testo(el, "duration") || 0);
          let t0;
          if (figlio(el, "chord")) t0 = ultimo; else { t0 = t; t += d; }
          ultimo = t0;
          lung = Math.max(lung, t);
          if (figlio(el, "rest") || figlio(el, "grace") || !figlio(el, "pitch")) continue;
          const nm = midi(figlio(el, "pitch")), voce = testo(el, "voice") || "1", chiave = nm + "/" + voce;
          const inizio = q0 + t0 / divisions, fine = q0 + (t0 + d) / divisions;
          const tipi = new Set(figli(el, "tie").map(x => x.getAttribute("type")));
          if (tipi.has("stop") && aperte.has(chiave)) {
            const s = aperte.get(chiave);
            s.fine = +fine.toFixed(4);
            if (!tipi.has("start")) aperte.delete(chiave);
            continue;
          }
          const dito = testo(el, "notations technical fingering"), corda = testo(el, "notations technical string");
          const s = { midi: nm, inizio: +inizio.toFixed(4), fine: +fine.toFixed(4), misura: n, voce,
            dito: dito && /^\d$/.test(dito) ? +dito : null, corda: corda && /^[1-6]$/.test(corda) ? +corda : null };
          suoni.push(s);
          if (tipi.has("start")) aperte.set(chiave, s);
        }
      }
      // una battuta «implicit» (anacrusi) dura quel che contiene, le altre almeno quanto dice il metro
      const durata = (m.getAttribute("implicit") === "yes" ? lung : Math.max(lung, metro[0] * 4 / metro[1] * divisions)) / divisions;
      misure.push([n, +q0.toFixed(4), +durata.toFixed(4)]);
      q0 += durata;
    }
    return { suoni, misure, barre, tempo, parola, metro, quarti: +q0.toFixed(4) };
  }

  function attacchiDi(suoni) {
    const per = new Map();
    suoni.forEach((s, i) => {
      if (!per.has(s.inizio)) per.set(s.inizio, { q: s.inizio, misura: s.misura, idx: [] });
      const a = per.get(s.inizio);
      if (a.idx.every(j => suoni[j].midi !== s.midi)) a.idx.push(i);   // stessa nota in due voci: un solo suono
      else s.doppio = true;
    });
    return [...per.values()].sort((a, b) => a.q - b.q);
  }

  function tastiSpan(comb) {
    const t = comb.map(x => x[1]).filter(f => f > 0);
    return t.length ? Math.max(...t) - Math.min(...t) : 0;
  }
  function prodotto(liste) {
    let out = [[]];
    for (const l of liste) { const n = []; for (const p of out) for (const x of l) n.push(p.concat([x])); out = n; }
    return out;
  }

  // Ricerca a fascio. Stato: corda di ogni suono che risuona ancora + posizione della mano.
  function cercaCorde(suoni, attacchi, barre, CORDE, MAX_TASTO) {
    const posizioni = (m, scritta) => {
      const tutte = [];
      for (let c = 1; c <= 6; c++) { const f = m - CORDE[c - 1]; if (f >= 0 && f <= MAX_TASTO) tutte.push([c, f]); }
      const s = scritta ? tutte.filter(([c]) => c === scritta) : [];
      return s.length ? s : tutte;
    };
    let fascio = [{ costo: 0, vivi: new Map(), pos: 1, scelte: [] }];
    for (const a of attacchi) {
      const q = a.q, barra = barre[a.misura];
      const opzioni = a.idx.map(i => posizioni(suoni[i].midi, suoni[i].corda));
      if (opzioni.some(o => !o.length)) throw new Error(`nota fuori dalla chitarra a b. ${a.misura}`);
      const combinazioni = prodotto(opzioni).filter(comb => new Set(comb.map(x => x[0])).size === comb.length);
      // se nessuna diteggiatura regge (accordi larghi, note tenute che la mano non può tenere), si allenta:
      // prima la mano fino a 5 tasti, poi le note tenute si lasciano andare, infine nessun limite
      let nuovi = [];
      for (const [larga, lascia, multa] of [[3, false, 0], [4, false, 3], [4, true, 6], [99, true, 12]]) {
        nuovi = espandi(larga, lascia, multa);
        if (nuovi.length) break;
      }
      function espandi(larga, lascia, multa) {
      const nuovi = [];
      for (const st of fascio) {
        const vivi = lascia ? new Map() : new Map([...st.vivi].filter(([i]) => suoni[i].fine > q + 1e-6));
        const occupate = new Set([...vivi.values()].map(ct => ct[0]));
        for (const comb of combinazioni) {
          const cc = comb.map(x => x[0]);
          // una nota che riparte sulla corda di una nota tenuta la interrompe: si può, ma costa
          let base = cc.filter(c => occupate.has(c)).length + multa + Math.max(0, (tastiSpan(comb) - 3) * 2);
          const tasti = comb.map(x => x[1]).filter(f => f > 0)
            .concat([...vivi.values()].filter(ct => ct[1] > 0 && !cc.includes(ct[0])).map(ct => ct[1]));
          let scelte;
          if (tasti.length) {
            const lo = Math.min(...tasti), hi = Math.max(...tasti);
            if (hi - lo > larga) continue;
            if (hi - lo <= 3) { scelte = []; for (let p = Math.max(1, hi - 3); p <= lo; p++) scelte.push(p); }
            else scelte = [lo];                         // accordo largo (fallback): la mano parte dal tasto più basso
          } else scelte = [st.pos];
          comb.forEach(([, f], k) => {
            const d = suoni[a.idx[k]].dito;
            if (f === 0) base -= 0.3;
            if (d === 0 && f !== 0) base += 20;          // «0» scritto: corda a vuoto
            if (d && f === 0) base += 6;                   // un dito scritto: nota tastata
          });
          const v2 = new Map(vivi);
          comb.forEach(([c, f], k) => {
            const i = a.idx[k];
            v2.set(i, [c, f]);
            for (const [j, ct] of [...v2]) if (j !== i && ct[0] === c && !a.idx.includes(j)) v2.delete(j);   // la tenuta si ferma
          });
          for (const nuova of scelte) {
            let c_ = base + (tasti.length ? 1.5 * Math.abs(nuova - st.pos) + 0.15 * nuova : 0);
            comb.forEach(([, f], k) => { const d = suoni[a.idx[k]].dito; if (d && f > 0 && Math.abs(f - (nuova + d - 1)) > 1) c_ += 1; });
            if (barra) c_ += comb.filter(([, f]) => f < barra).length * 2 + Math.abs(nuova - barra);
            nuovi.push({ costo: st.costo + c_, vivi: v2, pos: nuova, scelte: st.scelte.concat([comb]) });
          }
        }
      }
      return nuovi;
      }
      nuovi.sort((x, y) => x.costo - y.costo);
      const visti = new Set();
      fascio = [];
      for (const x of nuovi) {
        const chiave = [...x.vivi].sort((p, r) => p[0] - r[0]).map(([i, ct]) => i + ":" + ct).join(",") + "|" + x.pos;
        if (visti.has(chiave)) continue;
        visti.add(chiave);
        fascio.push(x);
        if (fascio.length >= 400) break;
      }
      if (!fascio.length) throw new Error(`nessuna diteggiatura possibile a b. ${a.misura}`);
    }
    return fascio[0].scelte;
  }

  // voce = la riga di elenco.json; xml = il testo del file
  function prepara(voce, xml) {
    const d = leggi(xml);
    const suoni = d.suoni;
    if (!suoni.length) throw new Error("il brano non ha note");
    const att = attacchiDi(suoni);
    const basso = Math.min(...suoni.map(s => s.midi)), acuto = Math.max(...suoni.map(s => s.midi));
    const CORDE = (voce.accordatura || [64, 59, 55, 50, 45, Math.min(40, Math.max(36, basso))]).slice();
    const MAX_TASTO = Math.max(12, Math.min(19, acuto - CORDE[0]));
    const scelte = cercaCorde(suoni, att, d.barre, CORDE, MAX_TASTO);
    const attacchi = att.map((a, k) => {
      const coppie = a.idx.map((i, j) => [suoni[i].midi, scelte[k][j]]).sort((x, y) => x[0] - y[0]);
      return { q: a.q, misura: a.misura, note: coppie.map(x => x[0]), corde: coppie.map(x => x[1][0]), tasti: coppie.map(x => x[1][1]) };
    });
    attacchi.forEach((a, k) => { a.durata = +((k + 1 < attacchi.length ? attacchi[k + 1].q : d.quarti) - a.q).toFixed(4); });
    const [num, den] = d.metro;
    const composto = den === 8 && num % 3 === 0 && num > 3;
    const battito = composto ? 1.5 : 4 / den;
    const semiminime = d.tempo || voce.tempo_semiminime || (d.parola ? d.parola * battito : null);
    return {
      id: voce.id, titolo: voce.titolo, movimento: voce.opera || "", metro: [num, den],
      accordatura: CORDE, battito,
      battitiPerMisura: composto ? num / 3 : num,
      suddivisione: composto ? 3 : 2,
      tempo: semiminime ? Math.max(30, Math.min(200, Math.round(semiminime / battito))) : 60,   // battiti al minuto
      quarti: d.quarti, misure: d.misure, barre: d.barre, attacchi,
      suoni: suoni.filter(s => !s.doppio).map(s => [s.midi, s.inizio, s.fine])
    };
  }

  window.Brano = { prepara, leggi };
})();
