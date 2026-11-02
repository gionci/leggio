// analisi.js — il motore d'ascolto, senza Web Audio: gira uguale nel browser e in Node (test/prova.js).
// 1. Rilevatore: trova gli attacchi delle note (spectral flux sulle frequenze della chitarra, 70-2000 Hz;
//    il click del metronomo è a 3-4 kHz e resta fuori).
// 2. giudicaNote: a ogni attacco guarda quali note sono comparse (energia nuova rispetto a subito prima,
//    perché negli arpeggi le note precedenti continuano a suonare) e se c'è quella scritta.
// 3. valuta: abbina attacchi attesi e sentiti, dà tempo, note e punteggio.
(function (root) {
  "use strict";

  // ---------- FFT (radix 2, sul posto) ----------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }

  const finestre = {};
  function hann(n) {
    if (!finestre[n]) {
      const w = new Float32Array(n);
      for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
      finestre[n] = w;
    }
    return finestre[n];
  }

  // modulo dello spettro di x[da .. da+lung) con finestra di Hann, completato con zeri fino a nfft
  function spettro(x, da, lung, nfft) {
    const re = new Float64Array(nfft), im = new Float64Array(nfft), w = hann(lung);
    for (let i = 0; i < lung; i++) {
      const k = da + i;
      re[i] = k >= 0 && k < x.length ? x[k] * w[i] : 0;
    }
    fft(re, im);
    const m = new Float32Array(nfft / 2);
    for (let i = 0; i < nfft / 2; i++) m[i] = Math.hypot(re[i], im[i]);
    return m;
  }

  // ---------- 1. attacchi ----------
  // Si nutre a pezzi (feed) con i campioni del microfono; restituisce gli attacchi trovati, con il tempo in secondi
  // dal primo campione (t0 + campioni / sr). Lavora con 3 finestre di ritardo (~16 ms) per riconoscere il picco.
  class Rilevatore {
    constructor(sr, opz = {}) {
      this.sr = sr;
      this.N = 2048;
      this.hop = 256;
      this.t0 = opz.t0 || 0;
      this.buf = new Float32Array(0);
      this.pos = 0;                // indice (assoluto) del primo campione in buf
      this.prossima = 0;           // inizio assoluto della prossima finestra
      this.prec = null;            // spettro compresso della finestra precedente
      this.storia = [];            // flux recenti (per la soglia)
      this.f = [];                 // ultimi 3 valori [indice finestra, flux]
      this.ultimo = -1e9;
      // bande: 70 Hz - 8 kHz, tranne 2,8-4,4 kHz dove sta il click del metronomo (gaussiano, stretto)
      const hz = f => Math.round(f * this.N / sr);
      this.bin = [];
      for (let b = hz(70); b < hz(8000); b++) if (b < hz(2800) || b > hz(4400)) this.bin.push(b);
      this.b0 = 0; this.b1 = this.bin.length;
      this.forti = [];                             // forza degli ultimi attacchi
      this.cdStoria = [];
      this.pesoFase = opz.pesoFase != null ? opz.pesoFase : 0.1;
      this.avvio = 0.15;                           // all'inizio il fondo si assesta
      this.minimo = opz.minimo || 0.6;      // flux minimo assoluto (la pagina lo alza dal silenzio)
      this.rapporto = opz.rapporto || 2.0;  // quante volte sopra la mediana recente
      this.distanza = opz.distanza || 0.045;
    }
    // silenzio: qualche secondo di solo rumore (microfono aperto, nessuno suona). Il minimo diventa
    // una volta e mezza il valore più alto del rumore, così il fruscio non fa attacchi.
    taraSilenzio(x) {
      const r = new Rilevatore(this.sr);
      r.traccia = [];
      r.minimo = 1e9;
      r.feed(x);
      const v = r.traccia.map(z => z[1]).sort((a, b) => a - b);
      this.minimo = Math.max(0.6, 1.5 * (v[Math.floor(v.length * 0.99)] || 0));
      return this.minimo;
    }
    feed(chunk) {
      const nb = new Float32Array(this.buf.length + chunk.length);
      nb.set(this.buf); nb.set(chunk, this.buf.length);
      this.buf = nb;
      const out = [];
      while (this.prossima + this.N <= this.pos + this.buf.length) {
        const da = this.prossima - this.pos;
        const N = this.N, re = new Float64Array(N), im = new Float64Array(N), w = hann(N);
        for (let i = 0; i < N; i++) re[i] = this.buf[da + i] * w[i];
        fft(re, im);
        const nb = this.b1 - this.b0, c = new Float32Array(nb), mg = new Float32Array(nb), ph = new Float32Array(nb);
        for (let k = 0; k < nb; k++) {
          const b = this.bin[k];
          mg[k] = Math.hypot(re[b], im[b]); ph[k] = Math.atan2(im[b], re[b]); c[k] = Math.log(1 + 100 * mg[k]);
        }
        // a) aumento dello spettro rispetto alla finestra prima (con i bin vicini: un leggero vibrato non conta)
        let flux = 0;
        if (this.prec) {
          const p = this.prec;
          for (let i = 1; i < nb - 1; i++) {
            const d = c[i] - Math.max(p[i - 1], p[i], p[i + 1]);
            if (d > 0) flux += d;
          }
        }
        // b) salto di fase: una corda ripizzicata riparte da capo anche se non suona più forte di prima
        //    (note ribattute, arpeggi che tornano sulla stessa corda). Si prevede ogni bin dalle due finestre
        //    prima e si misura quanto il suono nuovo se ne discosta; conta solo il salto rispetto agli ultimi 30 ms.
        let cd = 0;
        if (this.f1 && this.f2) {
          const a1 = this.f1, a2 = this.f2;
          for (let i = 0; i < nb; i++) {
            const pr = 2 * a1.ph[i] - a2.ph[i];
            const er = mg[i] * Math.cos(ph[i]) - a1.mg[i] * Math.cos(pr), ei = mg[i] * Math.sin(ph[i]) - a1.mg[i] * Math.sin(pr);
            cd += Math.log(1 + 100 * Math.hypot(er, ei));
          }
        }
        this.f2 = this.f1; this.f1 = { mg, ph };
        const base = this.cdStoria.length ? Math.min(...this.cdStoria) : cd;
        this.cdStoria.push(cd);
        if (this.cdStoria.length > 6) this.cdStoria.shift();
        flux += this.pesoFase * Math.max(0, cd - 1.3 * base);
        this.prec = c;
        const idx = this.prossima;
        this.f.push([idx, flux]);
        if (this.f.length > 3) this.f.shift();
        if (this.f.length === 3) {
          const [a, b, cc] = this.f;
          const s = this.storia.slice().sort((x, y) => x - y);
          const med = s.length ? s[Math.floor(s.length * 0.3)] : 0;   // fondo: 30° percentile degli ultimi ~0,6 s
          // soglia: sopra il rumore (minimo, dalla taratura del silenzio), sopra il fondo recente e almeno
          // un quarto della forza tipica degli ultimi attacchi (così il battimento di due corde che suonano non conta)
          const tip = this.forti.length >= 4 ? this.forti.slice().sort((x, y) => x - y)[this.forti.length >> 1] : 0;
          const soglia = Math.max(this.minimo, med * this.rapporto, 0.25 * tip);
          const t = this.t0 + (b[0] + this.N / 2) / this.sr;
          if (this.traccia) this.traccia.push([t, b[1], soglia]);
          if (b[1] > soglia && b[1] >= a[1] && b[1] > cc[1] && t - this.ultimo > this.distanza &&
              t - this.t0 > this.avvio) {
            this.forti.push(b[1]);
            if (this.forti.length > 8) this.forti.shift();
            out.push({ t, forza: b[1] / Math.max(soglia, 1e-9) });
            this.ultimo = t;
          }
          this.storia.push(b[1]);
          if (this.storia.length > 110) this.storia.shift();
        }
        this.prossima += this.hop;
      }
      // tieni solo quello che serve alla prossima finestra
      const tieni = this.prossima - this.pos;
      if (tieni > 0) { this.buf = this.buf.slice(tieni); this.pos += tieni; }
      return out;
    }
  }

  // ---------- 2. note ----------
  const freq = (m, la) => (la || 440) * Math.pow(2, (m - 69) / 12);

  // salienza armonica di ogni nota MIDI da 36 a 96 nello spettro s (bin = sr/nfft Hz)
  function salienze(s, sr, nfft, la) {
    const hz = sr / nfft, out = {};
    for (let m = 36; m <= 96; m++) {
      const f0 = freq(m, la);
      let tot = 0;
      for (let k = 1; k <= 8; k++) {
        const f = f0 * k;
        if (f > 5000) break;
        const lo = Math.floor(f * Math.pow(2, -0.4 / 12) / hz), hi = Math.ceil(f * Math.pow(2, 0.4 / 12) / hz);
        let p = 0;
        for (let b = lo; b <= hi && b < s.length; b++) if (s[b] > p) p = s[b];
        tot += p * Math.pow(0.8, k - 1);
      }
      out[m] = tot;
    }
    return out;
  }

  // salienza di una concorrente contando solo le armoniche che le note attese non spiegano già: in un accordo
  // le armoniche delle altre note cadono spesso su quelle di una nota estranea vicina (nell'accordo di Mi la 4ª
  // armonica di Mi4 è la 5ª di Do4) e la farebbero «vincere» senza che nessuno l'abbia suonata
  function spiegata(f, attese, la) {
    for (const a of attese) {
      const fa = freq(a, la), k = Math.round(f / fa);
      if (k >= 1 && k <= 16 && Math.abs(1200 * Math.log2(f / (fa * k))) < 40) return true;
    }
    return false;
  }
  function salienzaLibera(s, sr, nfft, la, m, attese) {
    const hz = sr / nfft, f0 = freq(m, la);
    let tot = 0;
    for (let k = 1; k <= 8; k++) {
      const f = f0 * k;
      if (f > 5000) break;
      if (spiegata(f, attese, la)) continue;
      const lo = Math.floor(f * Math.pow(2, -0.4 / 12) / hz), hi = Math.ceil(f * Math.pow(2, 0.4 / 12) / hz);
      let p = 0;
      for (let b = lo; b <= hi && b < s.length; b++) if (s[b] > p) p = s[b];
      tot += p * Math.pow(0.8, k - 1);
    }
    return tot;
  }

  // note «parenti» di m (stesse armoniche): non contano come concorrenti
  function parenti(m) { return [m, m - 12, m + 12, m - 24, m + 24, m + 19, m - 19, m + 7, m - 7, m + 28]; }

  // x: tutti i campioni; t: attacco (s, sullo stesso orologio di x con t0); attese: note MIDI; lung: s disponibili
  function giudicaNote(x, sr, t0, t, attese, lung, opz = {}) {
    const la = opz.la || 440;
    const L = Math.max(Math.round(0.04 * sr), Math.min(Math.round(0.12 * sr), Math.round((lung - 0.02) * sr)));
    const nfft = 16384;
    const i = Math.round((t - t0) * sr);
    const A = spettro(x, i + Math.round(0.012 * sr), L, nfft);
    const B = spettro(x, i - L - Math.round(0.008 * sr), L, nfft);
    const D = new Float32Array(A.length);
    let eA = 0, eD = 0;
    for (let b = 0; b < A.length; b++) { D[b] = Math.max(A[b] - 0.8 * B[b], 0.2 * A[b]); eA += A[b]; eD += D[b]; }
    const s = salienze(D, sr, nfft, la);
    // risonanza: una nota che suonava già prima dell'attacco (corde a vuoto per simpatia, la stessa nota di prima)
    // nell'energia nuova si vede poco anche se è stata suonata; per lei si guarda anche lo spettro intero
    const risonanza = opz.risonanza === true;                        // sperimentale: vedi test/giudice.js
    const sA = risonanza ? salienze(A, sr, nfft, la) : null, sB = risonanza ? salienze(B, sr, nfft, la) : null;
    return attese.map(m => {
      const escl = new Set();
      for (const a of attese) for (const p of parenti(a)) escl.add(p);
      // concorrenti: le note vicine (entro una quinta), cioè gli errori di tasto o di corda plausibili.
      // Le note lontane e acute raccolgono le armoniche alte della nota giusta: non sono concorrenti credibili.
      let best = -1, bm = null;
      const spiega = opz.spiega === true && attese.length > 1;          // sperimentale: vedi test/giudice.js
      for (let c = Math.max(36, m - 6); c <= Math.min(96, m + 6); c++) {
        if (escl.has(c)) continue;
        const v = spiega ? salienzaLibera(D, sr, nfft, la, c, attese) : s[c];
        if (v > best) { best = v; bm = c; }
      }
      let r = s[m] / Math.max(best, 1e-12);
      if (risonanza && sB[m] > 0.3 * sA[m]) {
        let bestA = -1, bmA = null;
        for (let c = Math.max(36, m - 6); c <= Math.min(96, m + 6); c++) {
          if (escl.has(c)) continue;
          const v = spiega ? salienzaLibera(A, sr, nfft, la, c, attese) : sA[c];
          if (v > bestA) { bestA = v; bmA = c; }
        }
        const rA = sA[m] / Math.max(bestA, 1e-12);
        if (rA > r) { r = rA; bm = bmA; }
      }
      // giusta: la nota scritta è almeno alla pari con la migliore estranea; sbagliata: chiaramente sotto
      const esito = r >= (opz.giusta || 0.9) ? "giusta" : r <= (opz.sbagliata || 0.55) ? "sbagliata" : "incerta";
      return { nota: m, esito, sentita: esito === "giusta" ? m : bm, rapporto: +r.toFixed(2) };
    });
  }

  // ---------- 3. valutazione ----------
  // attesi: [{t, note, misura}] (s, già sull'orologio del microfono, ritardo corretto); sentiti: [{t}] in ordine.
  // Restituisce {righe: attesi con sentito/scarto (null = mancata), extra: attacchi sentiti fuori posto}
  function abbina(attesi, sentiti) {
    const usato = new Array(sentiti.length).fill(false);
    const righe = attesi.map((a, k) => {
      const prima = k > 0 ? a.t - attesi[k - 1].t : 1, dopo = k < attesi.length - 1 ? attesi[k + 1].t - a.t : 1;
      const fin = Math.min(0.15, 0.45 * Math.min(prima, dopo));
      let best = -1, bd = 1e9;
      for (let j = 0; j < sentiti.length; j++) {
        if (usato[j]) continue;
        const d = Math.abs(sentiti[j].t - a.t);
        if (d <= fin && d < bd) { bd = d; best = j; }
        if (sentiti[j].t > a.t + fin) break;
      }
      if (best < 0) return { ...a, sentito: null, scarto: null };
      usato[best] = true;
      return { ...a, sentito: sentiti[best].t, scarto: sentiti[best].t - a.t };
    });
    return { righe, extra: sentiti.filter((_, j) => !usato[j]) };
  }

  // punteggio di tempo di un attacco: 1 fino a 25 ms, poi scende fino a 0 a 120 ms
  const puntiTempo = ms => ms <= 25 ? 1 : ms >= 120 ? 0 : 1 - (ms - 25) / 95;
  const fascia = ms => ms <= 25 ? "perfetto" : ms <= 50 ? "bene" : ms <= 90 ? "impreciso" : "fuori";

  function riepilogo(righe, extra) {
    const n = righe.length;
    let pt = 0, pn = 0, nn = 0;
    const fasce = { perfetto: 0, bene: 0, impreciso: 0, fuori: 0, mancata: 0 };
    const note = { giusta: 0, sbagliata: 0, incerta: 0 };
    const scarti = [];
    for (const r of righe) {
      if (r.scarto == null) { fasce.mancata++; continue; }
      const ms = Math.abs(r.scarto) * 1000;
      fasce[fascia(ms)]++;
      pt += puntiTempo(ms);
      scarti.push(r.scarto * 1000);
      for (const g of r.giudizi || []) {
        note[g.esito]++; nn++;
        pn += g.esito === "giusta" ? 1 : g.esito === "incerta" ? 0.5 : 0;
      }
    }
    const nNote = righe.reduce((s, r) => s + r.note.length, 0);
    const mediana = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
    const med = mediana(scarti);
    const disp = mediana(scarti.map(v => Math.abs(v - med)));
    // tendenza: retta degli scarti nel tempo (ms di scarto in più ogni 10 s)
    let tend = 0;
    const xs = righe.filter(r => r.scarto != null);
    if (xs.length > 4) {
      const mx = xs.reduce((s, r) => s + r.t, 0) / xs.length, my = xs.reduce((s, r) => s + r.scarto, 0) / xs.length;
      let num = 0, den = 0;
      for (const r of xs) { num += (r.t - mx) * (r.scarto - my); den += (r.t - mx) ** 2; }
      tend = den ? num / den * 10000 : 0;
    }
    const tempo = n ? pt / n : 0;
    const giuste = nNote ? pn / nNote : 0;
    const penExtra = Math.min(0.15, (extra ? extra.length : 0) / Math.max(n, 1) * 0.5);
    return {
      punteggio: Math.round(100 * Math.max(0, 0.5 * tempo + 0.5 * giuste - penExtra)),
      tempo: Math.round(100 * tempo), note: Math.round(100 * giuste),
      fasce, giudizi: note, extra: extra ? extra.length : 0,
      anticipo: Math.round(med), regolarita: Math.round(disp), tendenza: +tend.toFixed(1)
    };
  }

  const NOMI = ["Do", "Do#", "Re", "Mib", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "Sib", "Si"];
  const nomeNota = m => NOMI[m % 12] + (Math.floor(m / 12) - 1);

  const api = { fft, spettro, Rilevatore, salienze, giudicaNote, abbina, riepilogo, puntiTempo, fascia, nomeNota, freq };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Analisi = api;
})(typeof self !== "undefined" ? self : this);
