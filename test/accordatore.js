// prova dell'accordatore: estrae altezza() da app.js e la prova su corde sintetiche (Karplus-Strong + rumore)
const fs = require("fs");
const src = fs.readFileSync(process.argv[2], "utf8");
const f = src.slice(src.indexOf("function altezza("), src.indexOf("async function accendiAccordatore"));
const altezza = new Function(f + "; return altezza;")();
const sr = 48000;
for (const [nomeC, hz] of [["Mi2", 82.41], ["La2", 110], ["Re3", 146.83], ["Sol3", 196], ["Si3", 246.94], ["Mi4", 329.63], ["Mi2 +12c", 82.41 * Math.pow(2, 12 / 1200)], ["Sol3 -20c", 196 * Math.pow(2, -20 / 1200)]]) {
  const P = sr / hz, n = sr * 1.0, x = new Float32Array(n);
  // corda: somma di armoniche che decadono, fondamentale debole come sulle corde basse
  for (let i = 0; i < n; i++) { let v = 0; for (let k = 1; k <= 10; k++) v += (k === 1 ? 0.4 : 1 / k) * Math.sin(2 * Math.PI * hz * k * i / sr + k) * Math.exp(-i / sr * k * 0.8); x[i] = 0.2 * v + 0.002 * (Math.random() - 0.5); }
  const r = [];
  for (const t of [0.1, 0.4, 0.8]) { const b = x.slice(t * sr, t * sr + 4096); const h = altezza(b, sr); r.push(h ? (1200 * Math.log2(h / hz)).toFixed(1) + "c" : "–"); }
  console.log(nomeC.padEnd(10), "errore a 0,1/0,4/0,8 s:", r.join("  "));
}
