// cattura-worklet.js — porta al thread principale i campioni del microfono (mono: media dei canali),
// a blocchi di 2048, con l'indice del primo campione: tempo = indice / sampleRate, lo stesso orologio di
// AudioContext.currentTime, su cui è programmato il metronomo.
class Cattura extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocco = new Float32Array(2048);
    this.n = 0;
    this.inizio = 0;
  }
  process(inputs) {
    const ing = inputs[0];
    if (!ing || !ing.length || !ing[0]) return true;
    const len = ing[0].length, nc = ing.length;
    for (let i = 0; i < len; i++) {
      if (this.n === 0) this.inizio = currentFrame + i;
      let v = 0;
      for (let c = 0; c < nc; c++) v += ing[c][i];
      this.blocco[this.n++] = v / nc;
      if (this.n === this.blocco.length) {
        this.port.postMessage({ inizio: this.inizio, dati: this.blocco }, [this.blocco.buffer]);
        this.blocco = new Float32Array(2048);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("cattura", Cattura);
