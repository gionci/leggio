// browser.js — collaudo dell'app intera in Chromium senza schermo (protocollo DevTools, niente librerie).
// 1. carica TUTTI i brani di elenco.json e controlla che si preparino senza errori;
// 2. in modalità ?demo (chitarra sintetica con errori, microfono spento) prova tre brani: prova valutata,
//    passaggi difficili, allenamento a ritroso;
// 3. fotografie a larghezza telefono (390 px) e desktop (1400 px).
//
// Uso: node test/browser.js [indirizzo dell'app] [cartella per le foto]
//   indirizzo predefinito: http://127.0.0.1:8811/leggio/ (python3 -m http.server 8811 --bind 127.0.0.1 nella cartella ~/Work)
//   BRANI=sor_op35_no07,carcassi_op60_no03,giuliani_op50_no01 per scegliere i tre brani della demo; VELOCE=1 salta la demo.
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const BASE = (process.argv[2] || "http://127.0.0.1:8811/leggio/").replace(/\/?$/, "/");
const OUT = process.argv[3] || path.join(os.tmpdir(), "leggio-foto");
const DEMO_BRANI = (process.env.BRANI || "sor_op35_no07,carcassi_op60_no03,giuliani_op50_no01").split(",");
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const dati = fs.mkdtempSync(path.join(os.tmpdir(), "leggio-chrome-"));
  const chrome = spawn("chromium", ["--headless=new", "--remote-debugging-port=9335", "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--window-size=1400,1000", `--user-data-dir=${dati}`, "about:blank"], { stdio: "ignore" });
  let lista;
  for (let i = 0; i < 50; i++) { try { lista = await (await fetch("http://127.0.0.1:9335/json")).json(); break; } catch (e) { await sleep(200); } }
  const pag = lista.find(t => t.type === "page");
  const ws = new WebSocket(pag.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const attesa = {};
  let errori = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && attesa[m.id]) { attesa[m.id](m); delete attesa[m.id]; }
    if (m.method === "Runtime.exceptionThrown") errori.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && ["error"].includes(m.params.type)) errori.push(m.params.args.map(a => a.value || a.description).join(" "));
    if (m.method === "Network.loadingFailed" && !/fonts\.g/.test(m.params.errorText + "")) errori.push("rete: " + m.params.errorText);
  };
  const cmd = (method, params = {}) => new Promise(r => { const i = ++id; attesa[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const val = async expr => { const r = await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); return r.result.result ? r.result.result.value : r; };
  const foto = async (nome, intera) => {
    const r = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: !!intera });
    fs.writeFileSync(`${OUT}/${nome}.png`, Buffer.from(r.result.data, "base64"));
  };
  const schermo = (w, h, mobile) => cmd("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const aspetta = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await val(expr)) return true; await sleep(200); } return false; };
  await cmd("Runtime.enable"); await cmd("Page.enable"); await cmd("Network.enable");
  let falliti = 0;

  // ---------- 1. tutti i brani ----------
  await schermo(1400, 1000, false);
  await cmd("Page.navigate", { url: BASE + "?demo" });
  await aspetta(`window.PRONTO === true`);
  const ids = await val(`INDICE.brani.map(b => b.id)`);
  console.log(`elenco: ${ids.length} brani`);
  const esiti = [];
  for (const b of ids) {
    errori = [];
    await val(`window.ERRORE_BRANO = null; document.querySelector('#selBrano').value = '${b}'; caricaBrano('${b}').then(() => 1)`);
    const r = await val(`JSON.stringify({ok: !!(B && B.id === '${b}' && !window.ERRORE_BRANO), err: window.ERRORE_BRANO, battute: B && B.misure.length, attacchi: B && B.attacchi.length, accordatura: B && B.accordatura[5], tempo: B && B.tempo, punti: linea.length, svg: !!document.querySelector('#osmd svg')})`);
    const x = JSON.parse(r);
    const ok = x.ok && x.svg && x.punti > 0 && !errori.length;
    if (!ok) falliti++;
    esiti.push(`${ok ? "ok " : "NO "} ${b}: ${x.battute} battute, ${x.attacchi} attacchi, sesta ${x.accordatura}, tempo ${x.tempo}, ${x.punti} punti${x.err ? " ERRORE " + x.err : ""}${errori.length ? " " + errori.slice(0, 2).join(" ; ") : ""}`);
  }
  console.log(esiti.join("\n"));
  console.log(`brani caricati: ${ids.length - falliti}/${ids.length}`);

  // ---------- 2. foto: telefono e desktop ----------
  for (const [nome, w, h, mob] of [["telefono", 390, 844, true], ["desktop", 1400, 1000, false]]) {
    await schermo(w, h, mob);
    await cmd("Page.navigate", { url: BASE + "?brano=sor_op35_no07" });
    await aspetta(`window.PRONTO === true && !!B`);
    await sleep(800);
    await foto(`${nome}_1_brano`);
    const larga = await val(`document.documentElement.scrollWidth`);
    console.log(`${nome}: larghezza pagina ${larga}px su ${w}px${larga > w + 1 ? "  ← SCORRE DI LATO" : ""}`);
    if (larga > w + 1) falliti++;
    await val(`document.querySelector('#selBrano').focus(); 1`);
    await val(`mostra('allena'); 1`); await sleep(400); await foto(`${nome}_2_allena`, true);
    await val(`mostra('accordatore'); 1`); await sleep(300); await foto(`${nome}_3_accordatore`);
    await val(`mostra('brano'); mostraCrediti(B.id); 1`); await sleep(300); await foto(`${nome}_4_crediti`);
    await val(`document.querySelector('#dlgCrediti').close(); document.querySelector('#dlgMic').showModal(); 1`); await sleep(200); await foto(`${nome}_5_microfono`);
    await val(`document.querySelector('#dlgMic').close(); 1`);
  }

  // ---------- 3. demo su tre brani ----------
  if (!process.env.VELOCE) for (const b of DEMO_BRANI) {
    errori = [];
    const telefono = b === DEMO_BRANI[0];             // il primo brano a larghezza telefono
    await schermo(telefono ? 390 : 1400, telefono ? 844 : 1000, telefono);
    await cmd("Page.navigate", { url: BASE + "?demo&brano=" + b });
    await aspetta(`window.PRONTO === true && !!B`);
    await val(`localStorage.clear(); for (const k in prove) delete prove[k]; 1`);
    const m = await val(`B.misure.map(x => x[0])`);
    const da = m[0], a = m[Math.min(3, m.length - 1)];
    for (let giro = 0; giro < 2; giro++) {
      await val(`document.querySelector('#daBatt').value=${da}; document.querySelector('#aBatt').value=${a}; document.querySelector('#bpmBrano').value=Math.round(B.tempo*0.8); document.querySelector('#attacco').value=1; suonaBrano(); 1`);
      await sleep(1000);
      const durata = await val(`corsa ? corsa.fine - ctx.currentTime : 0`);
      await sleep(durata * 500);
      if (giro === 0) {
        await foto(`demo_${b}_1_durante`);
        const pend = await val(`!document.querySelector('#pendolo').hidden && getComputedStyle(document.querySelector('#pendolo .pallina')).transform`);
        console.log(`   pallina del battito: ${pend ? "si muove (" + pend + ")" : "NON VISIBILE"}`);
        if (!pend || pend === "none") falliti++;
      }
      await sleep(durata * 500 + 2500);
    }
    const res = (await val(`document.querySelector('#resoconto').innerText`)).replace(/\n+/g, " | ");
    console.log(`demo ${b}, b. ${da}-${a}: ${res.slice(0, 220)}`);
    await val(`window.scrollTo(0, 0); 1`);
    await foto(`demo_${b}_2_resoconto`);
    await val(`mostra('passaggi'); 1`); await sleep(400);
    console.log(`   passaggi: ${(await val(`document.querySelector('#elencoPassaggi').innerText`)).replace(/\n+/g, " | ").slice(0, 200)}`);
    await val(`mostra('allena'); scegliTratto(Math.max(0, B.attacchi.findIndex(x => x.misura >= ${a}) - 4), B.attacchi.findIndex(x => x.misura >= ${a})); scegliModo('insieme'); document.querySelector('#bpmAllena').value=Math.round(B.tempo*0.7); document.querySelector('#richiesti').value=2; document.querySelector('#richiesti').onchange(); avviaAllenamento(); 1`);
    await sleep(20000);
    await foto(`demo_${b}_3_allena`);
    console.log(`   allenamento: ${await val(`document.querySelector('#catena').innerText + ' / ' + document.querySelector('#esitoGiro').innerText`)} | ${(await val(`document.querySelector('#diarioAllena').innerText`)).replace(/\n+/g, " | ").slice(0, 200)}`);
    await val(`fermaAllenamento(); 1`);
    const okDemo = res.length > 20 && !errori.length;
    if (!okDemo) { falliti++; console.log("   ERRORI:", errori.slice(0, 5)); }
  }
  console.log(`foto in ${OUT}`);
  console.log(falliti ? `FALLITI: ${falliti}` : "TUTTO OK");
  ws.close(); chrome.kill();
  await sleep(500);
  try { fs.rmSync(dati, { recursive: true, force: true }); } catch (e) { /* Chromium sta ancora chiudendo */ }
  process.exit(falliti ? 1 : 0);
})();
