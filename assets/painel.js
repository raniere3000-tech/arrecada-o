// Página do painel: conecta a pasta, manda os arquivos para o worker e desenha as abas a partir das somas que ele devolve.
(function () {
  "use strict";
  const C = window.CALC, R = window.REGRAS;
  const $ = (id) => document.getElementById(id);
  const ARQ_AJUSTES = "ajustes_arrecadacao.json";
  const ABAS = { resumo: "Resumo", subcategoria: "Subcategoria", perfil: "Perfil de pagamento", cidades: "Cidades", escada: "Escada", onepage: "One page", analise: "Ranking de clientes", base: "Base", dados: "Dados",
    fxa: "Faturamento x Arrecadação", fxv: "Fat. x Arrec. — mesmo vencimento", conversao: "Conversão por referência", localidade: "Diagnóstico por localidade", clientes: "Clientes e oportunidades", negociacao: "Negociação" };
  const AREA_DA_ABA = { fxa: "analises", fxv: "analises", conversao: "analises", analise: "analises", clientes: "analises", negociacao: "analises", dados: "dados" };   // as outras: Executivo
  const ultimaDaArea = { executivo: "resumo", analises: "fxa", dados: "dados" };
  const ABAS_PDF = ["resumo", "subcategoria", "perfil", "cidades", "escada"];     // Ranking de clientes e Dados não entram no PDF
  const NOME_SUP = { INTERIOR: "Interior", LESTE: "Leste", [R.SEM_SUP]: "Sem SUP" };
  const DIGITADO = "__digitado";                      // opção do seletor de orçado: o valor digitado no painel
  const E = {
    res: null, sups: ["INTERIOR"], cidades: [], grupos: [], mes: "", meses: [], sel: 0, aba: "resumo",
    abertos: new Set(["PUBLICO"]), ajustes: { orcado: {}, curva: {} }, pasta: null, rodando: false,
  };
  // Filtros do cabeçalho com vários itens: E.sups, E.cidades e E.grupos (lista vazia = todas). E.sup, E.cidade e E.grupo
  // dão o item quando só um está escolhido (senão ""): servem ao orçado e à curva, que são por superintendência. Para
  // filtrar, use marcas(), okCombo() ou okFat() — nunca E.cidade/E.grupo, que ficam "" com dois ou mais escolhidos.
  const unico = (l) => (l.length === 1 ? l[0] : "");
  Object.defineProperties(E, { sup: { get: () => unico(E.sups) }, cidade: { get: () => unico(E.cidades) }, grupo: { get: () => unico(E.grupos) } });
  try { $("versao").textContent = VERSAO_SITE.split("-")[0]; } catch (e) { /* sem versão */ }

  // ===== formatação =====
  const fmt = (v, d = 0) => (isFinite(v) && Math.abs(v) >= 0.5 / 10 ** d ? v : 0).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });   // sem "-0"
  const rs = (v) => (v < 0 ? "-R$ " : "R$ ") + fmt(Math.abs(v));
  const pct = (v) => (isFinite(v) ? (v * 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%" : "—");
  const milhoes = (v) => (isFinite(v) ? fmt(v / 1e6, 2) + " Mi" : "—");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const td = (txt, cls = "") => `<td${cls ? ` class="${cls}"` : ""}>${txt}</td>`;
  const tdNum = (v, f, extra = "") => {
    const cls = [v < 0 ? "neg" : "", extra].filter(Boolean).join(" ");
    return `<td${cls ? ` class="${cls}"` : ""}${typeof v === "number" && isFinite(v) ? ` data-v="${v}"` : ""}>${f(v)}</td>`;
  };
  const dataBR = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
  const nomeSup = (s) => (s ? NOME_SUP[s] || s : "Todas");

  function toast(msg, erro) {
    const t = $("toast");
    t.innerHTML = msg;
    t.classList.toggle("erro", !!erro);
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, erro ? 9000 : 4500);
  }

  // ===== qual painel: Arrecadação (este) ou Duplicidades (em migração). O visual "Power BI" saiu: fica sempre o do painel =====
  try { localStorage.removeItem("arrecadacao_visual"); } catch (e) { /* sem armazenamento */ }
  function aplicaModo(m) {
    const dup = m === "duplicidades";
    document.body.classList.toggle("modo-dup", dup);
    document.querySelectorAll(".chave-visual button").forEach((b) => b.classList.toggle("on", b.dataset.modo === m));
    $("dupArea").hidden = !dup;
    document.querySelector(".top h1").textContent = dup ? "Duplicidade de descontos" : "Arrecadação Diária";
    if (dup) desenhaDuplicidades();
    try { localStorage.setItem("arrecadacao_modo", m); } catch (e) { /* sem armazenamento */ }
  }
  document.querySelectorAll(".chave-visual button").forEach((b) => b.addEventListener("click", () => aplicaModo(b.dataset.modo)));
  // arquivos da pasta Duplicidades (guardados na leitura da pasta; não vão para a arrecadação)
  E.dupArquivos = [];
  const naPastaDup = (rel) => rel.split("/").slice(0, -1).some((p) => semAcentoDup(p) === "duplicidades");
  const semAcentoDup = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  // O painel de Duplicidades (duplicidades/index.html, o mesmo da v1.1) roda isolado num iframe, com o próprio código,
  // a própria base no navegador e as próprias abas e filtros. Ele recebe os arquivos da pasta Duplicidades da pasta
  // principal (subpastas Descontos e Cadastro): na 1ª vez que a área é aberta e a cada ↻ Atualizar.
  let dupPronto = false, dupEnviados = null;
  function enviaDuplicidades() {
    const fr = $("dupFrame");
    if (!dupPronto || !E.dupArquivos.length || dupEnviados === E.dupArquivos) return;
    dupEnviados = E.dupArquivos;
    fr.contentWindow.postMessage({ tipo: "dup-arquivos", itens: E.dupArquivos.map((i) => ({ rel: i.rel, file: i.file })) }, location.origin);
  }
  window.addEventListener("message", (ev) => {
    if (ev.origin !== location.origin || !ev.data) return;
    if (ev.data.tipo === "dup-pronto") { dupPronto = true; enviaDuplicidades(); }
    if (ev.data.tipo === "dup-altura") $("dupFrame").style.height = Math.max(400, ev.data.altura) + "px";
  });
  function desenhaDuplicidades() {
    const el = $("dupArquivos"), fr = $("dupFrame");
    if (!fr.src) fr.src = "duplicidades/index.html?v=" + VERSAO_SITE;      // carrega só quando a área é aberta
    fr.hidden = false;
    const n = E.dupArquivos.length;
    el.innerHTML = n ? `Lendo da pasta <b>Duplicidades</b>: ${fmt(n)} arquivo(s) (${[...new Set(E.dupArquivos.map((i) => i.rel.split("/").slice(-2, -1)[0]))].map(esc).join(", ")}). Ao trocar os arquivos, clique em <b>↻ Atualizar</b>.`
      : E.res || E.pasta ? "A pasta conectada não tem a pasta <b>Duplicidades</b> (com as subpastas Descontos e Cadastro). Abaixo, a última base lida neste navegador, se houver."
      : "Conecte a pasta principal (📁 Conectar pasta). Abaixo, a última base lida neste navegador, se houver.";
    enviaDuplicidades();
  }

  // ===== pasta =====
  const idb = {
    abre() { return new Promise((ok, erro) => { const r = indexedDB.open("arrecadacao", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => ok(r.result); r.onerror = () => erro(r.error); }); },
    async get(k) { try { const db = await this.abre(); return await new Promise((ok) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => ok(q.result); q.onerror = () => ok(null); }); } catch (e) { return null; } },
    async set(k, v) { try { const db = await this.abre(); await new Promise((ok) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = ok; t.onerror = ok; }); } catch (e) { /* sem IndexedDB */ } },
  };
  const setFonte = (html) => { $("fonteStatus").innerHTML = html; };

  async function lerPasta(handle, prefixo = "") {
    const out = [];
    for await (const [nome, h] of handle.entries()) {
      if (nome.startsWith(".")) continue;
      if (h.kind === "directory") out.push(...(await lerPasta(h, prefixo + nome + "/")));
      else out.push({ rel: prefixo + nome, file: await h.getFile() });
    }
    return out;
  }
  async function abrePasta(handle) {
    if (E.rodando) return;
    try {
      if ((await handle.queryPermission({ mode: "read" })) !== "granted" && (await handle.requestPermission({ mode: "read" })) !== "granted") {
        setFonte("O acesso à pasta não foi liberado. Clique em <b>📁 Conectar pasta</b> de novo.");
        return;
      }
      E.pasta = handle;
      $("btnAtualizar").hidden = false;
      setFonte(`Pasta <b>${esc(handle.name)}</b> — listando os arquivos…`);
      const itens = await lerPasta(handle);
      E.ajustes = await lerAjustes();
      analisa(itens, handle.name);
    } catch (e) {
      setFonte("Não foi possível ler a pasta: " + esc(e.message || e));
    }
  }
  async function escolhePasta() {
    if (E.rodando) return;
    if ("showDirectoryPicker" in window) {
      try {
        const h = await window.showDirectoryPicker({ id: "arrecadacao", mode: "read" });
        idb.set("pasta", h);
        abrePasta(h);
      } catch (e) {
        if (e.name !== "AbortError") toast("Não foi possível abrir a pasta: " + esc(e.message || e), true);
      }
    } else {
      $("inputPasta").value = "";
      $("inputPasta").click();
    }
  }
  $("btnPasta").addEventListener("click", escolhePasta);
  $("btnAtualizar").addEventListener("click", () => { if (E.pasta) abrePasta(E.pasta); });
  $("inputPasta").addEventListener("change", async () => {          // navegadores sem acesso à pasta (Firefox, Safari)
    const files = [...$("inputPasta").files];
    if (!files.length) return;
    const itens = files.map((f) => ({ rel: (f.webkitRelativePath || f.name).split("/").slice(1).join("/") || f.name, file: f }));
    const aj = itens.find((i) => i.rel === ARQ_AJUSTES);
    E.ajustes = aj ? normalizaAjustes(JSON.parse(await aj.file.text())) : ajustesLocais();
    analisa(itens, (files[0].webkitRelativePath || "").split("/")[0] || "pasta");
  });

  // ===== ajustes (orçado digitado e curva editada): ajustes_arrecadacao.json na pasta, para todos =====
  function normalizaAjustes(d) { d = d || {}; d.orcado = d.orcado || {}; d.curva = d.curva || {}; return d; }
  function ajustesLocais() { try { return normalizaAjustes(JSON.parse(localStorage.getItem("arrecadacao_ajustes") || "{}")); } catch (e) { return normalizaAjustes({}); } }
  async function lerAjustes() {
    if (!E.pasta) return ajustesLocais();
    try {
      const texto = await (await (await E.pasta.getFileHandle(ARQ_AJUSTES)).getFile()).text();
      return normalizaAjustes(texto.trim() ? JSON.parse(texto) : {});
    } catch (e) {
      return normalizaAjustes({});
    }
  }
  let fila = Promise.resolve();
  function gravaAjustes(altera) {                     // relê o arquivo, aplica a alteração e grava (fila: uma gravação por vez)
    const tarefa = fila.then(async () => {
      if (!E.pasta) {
        const d = ajustesLocais();
        altera(d);
        try { localStorage.setItem("arrecadacao_ajustes", JSON.stringify(d)); } catch (e) { /* cheio */ }
        E.ajustes = d;
        return { ok: true, local: true };
      }
      let perm = await E.pasta.queryPermission({ mode: "readwrite" });
      if (perm !== "granted") perm = await E.pasta.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") return { ok: false, motivo: "sem permissão para gravar na pasta" };
      const d = await lerAjustes();
      altera(d);
      d.atualizado = new Date().toISOString();
      const w = await (await E.pasta.getFileHandle(ARQ_AJUSTES, { create: true })).createWritable();
      await w.write(JSON.stringify(d, null, 2));
      await w.close();
      E.ajustes = d;
      return { ok: true };
    }).catch((e) => ({ ok: false, motivo: String((e && e.message) || e) }));
    fila = tarefa;
    return tarefa;
  }
  // oque: "Orçado salvo", "Curva salva"…
  function avisoGravacao(r, oque, obs = "") {
    if (r.ok) toast(`${oque} (${r.local ? "só neste navegador: a pasta não foi conectada pelo Chrome/Edge" : `em ${ARQ_AJUSTES}, na pasta`}).${obs}`);
    else toast(`Não foi possível salvar: ${esc(r.motivo)}.`, true);
  }

  // ===== leitura (worker) =====
  let worker = null;
  // ===== Prints do BI para o One page: pasta "One Page" na pasta principal =====
  // Aceita imagens (PNG, JPG…) ou um Excel com as imagens coladas (Inserir > Imagem, ou Ctrl+V sobre as células). Cada print
  // vai para o seu lugar pelo nome: da aba do Excel, ou do arquivo — "Inadimplentes" (maiores inadimplentes) e "Economias"
  // (cartão Economias dos volumes acumulados). Os arquivos dessa pasta não vão para a leitura da arrecadação.
  const PRINTS = [["inadimplentes", /inadimpl/], ["economias", /econom/]];
  const IMG_TIPOS = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp" };
  const semAcento = (t) => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const naPastaOnePage = (rel) => rel.split("/").slice(0, -1).some((p) => semAcento(p).replace(/[\s_-]+/g, "") === "onepage");
  const qualPrint = (nome) => (PRINTS.find(([, re]) => re.test(semAcento(nome))) || [])[0];
  E.prints = {}; E.printsAvisos = [];

  // Leitor mínimo de .zip (o .xlsx é um zip): índice central + DecompressionStream ("deflate-raw")
  async function lerZip(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("não é um arquivo .xlsx válido");
    const ents = new Map();
    let p = dv.getUint32(eocd + 16, true);
    for (let k = dv.getUint16(eocd + 10, true); k > 0 && dv.getUint32(p, true) === 0x02014b50; k--) {
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      ents.set(dec.decode(u8.subarray(p + 46, p + 46 + nl)), { metodo: dv.getUint16(p + 10, true), tam: dv.getUint32(p + 20, true), off: dv.getUint32(p + 42, true) });
      p += 46 + nl + xl + cl;
    }
    const bytes = async (nome) => {
      const e = ents.get(nome);
      if (!e) return null;
      const ini = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true), dados = u8.slice(ini, ini + e.tam);
      if (e.metodo === 0) return dados;
      if (e.metodo !== 8) throw new Error("compressão não suportada");
      return new Uint8Array(await new Response(new Blob([dados]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    };
    return { nomes: [...ents.keys()], bytes, xml: async (nome) => { const b = await bytes(nome); return b ? new DOMParser().parseFromString(dec.decode(b), "application/xml") : null; } };
  }
  const caminhoZip = (base, alvo) => {                 // resolve "../media/image1.png" a partir de "xl/drawings/drawing1.xml"
    if (alvo.startsWith("/")) return alvo.slice(1);
    const partes = base.split("/").slice(0, -1);
    for (const x of alvo.split("/")) { if (x === "..") partes.pop(); else if (x !== ".") partes.push(x); }
    return partes.join("/");
  };
  async function relsDe(z, arq) {                      // Id → { alvo, tipo } das relações de uma parte do zip
    const doc = await z.xml(caminhoZip(arq, `_rels/${arq.split("/").pop()}.rels`)), m = new Map();
    if (doc) for (const r of doc.getElementsByTagName("Relationship")) m.set(r.getAttribute("Id"), { alvo: caminhoZip(arq, r.getAttribute("Target")), tipo: r.getAttribute("Type") || "" });
    return m;
  }
  // Imagens de um Excel, por aba (na ordem em que aparecem no desenho); imagens fora de desenho (na célula) vão para "".
  async function imagensDoExcel(file) {
    const z = await lerZip(await file.arrayBuffer()), out = [], usadas = new Set();
    const wb = await z.xml("xl/workbook.xml"), relWb = await relsDe(z, "xl/workbook.xml");
    for (const sh of wb ? wb.getElementsByTagName("sheet") : []) {
      const rid = sh.getAttribute("r:id") || sh.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"), alvo = relWb.get(rid);
      if (!alvo) continue;
      for (const [, r] of await relsDe(z, alvo.alvo)) {
        if (!/\/drawing$/.test(r.tipo)) continue;
        const relD = await relsDe(z, r.alvo), dr = await z.xml(r.alvo);
        for (const blip of dr ? dr.getElementsByTagName("a:blip") : []) {
          const img = relD.get(blip.getAttribute("r:embed"));
          if (img && !usadas.has(img.alvo)) { usadas.add(img.alvo); out.push({ aba: sh.getAttribute("name"), nome: img.alvo }); }
        }
      }
    }
    for (const n of z.nomes) if (/^xl\/media\//.test(n) && !usadas.has(n)) out.push({ aba: "", nome: n });   // imagem "na célula" ou sem desenho
    for (const x of out) {
      const ext = x.nome.split(".").pop().toLowerCase();
      x.tipo = IMG_TIPOS[ext] || "";
      if (x.tipo) x.blob = new Blob([await z.bytes(x.nome)], { type: x.tipo });
    }
    return out;
  }
  async function lePrintsOnePage(itens) {
    for (const l of Object.values(E.prints)) for (const p of l) URL.revokeObjectURL(p.url);
    const prints = {}, avisos = [], poe = (chave, blob, origem) => { (prints[chave] = prints[chave] || []).push({ url: URL.createObjectURL(blob), origem }); };
    for (const it of itens) {
      const nome = it.rel.split("/").pop(), ext = nome.split(".").pop().toLowerCase();
      try {
        if (IMG_TIPOS[ext]) {
          const k = qualPrint(nome);
          if (k) poe(k, it.file, it.rel); else avisos.push(`${it.rel}: o nome não diz se é “Inadimplentes” ou “Economias”.`);
        } else if (ext === "xlsx" || ext === "xlsm") {
          const imgs = await imagensDoExcel(it.file), kArq = qualPrint(nome);
          if (!imgs.length) { avisos.push(`${it.rel}: nenhuma imagem dentro do Excel.`); continue; }
          for (const x of imgs) {
            const k = qualPrint(x.aba) || kArq;
            if (!x.blob) avisos.push(`${it.rel}${x.aba ? `, aba ${x.aba}` : ""}: imagem em formato que o navegador não mostra (${x.nome.split(".").pop()}); cole o print como PNG.`);
            else if (!k) avisos.push(`${it.rel}${x.aba ? `, aba “${x.aba}”` : ""}: a aba não se chama “Inadimplentes” nem “Economias”.`);
            else poe(k, x.blob, `${it.rel}${x.aba ? ` · aba ${x.aba}` : ""}`);
          }
        } else if (!/^~\$/.test(nome)) avisos.push(`${it.rel}: formato não usado (use imagem ou Excel com as imagens).`);
      } catch (e) {
        avisos.push(`${it.rel}: não foi possível ler (${e.message || e}).`);
      }
    }
    E.prints = prints; E.printsAvisos = avisos;
    if (E.res && E.aba === "onepage") desenhaOnePage();
  }
  function opStatusPrints() {
    const item = (k, rot) => (E.prints[k] ? `✓ ${rot}: ${E.prints[k].map((p) => esc(p.origem)).join(", ")}` : `✗ ${rot}: falta o print`);
    return `<b>Prints do BI (pasta One Page):</b> ${item("economias", "Economias")} · ${item("inadimplentes", "Maiores inadimplentes")}`
      + (E.printsAvisos.length ? `<br>${E.printsAvisos.map(esc).join("<br>")}` : "");
  }
  function analisa(itens, nomePasta) {
    const doOnePage = itens.filter((i) => naPastaOnePage(i.rel));   // prints do BI: não entram na leitura da arrecadação
    E.dupArquivos = itens.filter((i) => naPastaDup(i.rel));          // painel de Duplicidades: também fora da arrecadação
    itens = itens.filter((i) => !naPastaOnePage(i.rel) && !naPastaDup(i.rel));
    if (document.body.classList.contains("modo-dup")) desenhaDuplicidades();
    lePrintsOnePage(doOnePage);
    E.rodando = true;
    $("btnPasta").disabled = true;
    $("btnAtualizar").disabled = true;
    $("progresso").hidden = false;
    progresso(0, "Preparando a leitura…");
    if (worker) worker.terminate();
    worker = new Worker("leitor.worker.js?v=" + VERSAO_SITE);
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.tipo === "progresso") progresso(m.pct, m.texto);
      else if (m.tipo === "pronto") { fim(); carrega(m, nomePasta); }
      else if (m.tipo === "analise") recebeAnalise(m);
      else if (m.tipo === "clientes") recebeClientes(m);
      else if (m.tipo === "matricula") recebeMatricula(m);
      else if (m.tipo === "oportunidades") recebeOportunidades(m);
      else if (m.tipo === "negociacao") recebeNegociacao(m);
      else if (m.tipo === "comparativo") recebeComparativo(m);
      else if (m.tipo === "extracao-progresso") { if (m.id === idBase) $("baseStatus").textContent = `${m.texto}… ${m.pct}%`; }
      else if (m.tipo === "extracao") recebeBase(m);
      else if (m.tipo === "mensal") recebeMensal(m);
      else if (m.tipo === "erro") { fim(); setFonte("Erro na leitura: " + esc(m.mensagem)); console.error(m.detalhe); }
    };
    worker.onerror = (e) => { fim(); setFonte("Erro na leitura: " + esc(e.message)); };
    worker.postMessage({ arquivos: itens });
  }
  function fim() {
    E.rodando = false;
    $("btnPasta").disabled = false;
    $("btnAtualizar").disabled = false;
    $("progresso").hidden = true;
  }
  function progresso(p, texto) {
    $("barraFill").style.width = p + "%";
    $("statusPct").textContent = p + "%";
    $("statusTexto").textContent = texto;
  }

  function carrega(res, nomePasta) {
    E.res = res;
    chaveCl = ""; clRes = null;                      // Clientes e oportunidades: recalcula com a pasta nova
    ajustaRecTipo();
    const d = res.dados;
    const nArr = res.arquivos.filter((a) => a.tipo === "diaria" || a.tipo === "acumulada").length;
    listaArquivos(res);
    if (!d.meses.length) {
      setFonte(`Pasta <b>${esc(nomePasta)}</b>: nenhum arquivo de arrecadação encontrado (CSV com Nº Ligação, Data Crédito e Val. Autenticado). Veja a lista em “Arquivos lidos”.`);
      $("vazio").hidden = false; $("area").hidden = true; $("abas").hidden = true; $("btnPdf").disabled = true; $("btnPrint").disabled = true; $("btnMensal").disabled = true;
      return;
    }
    const ultimo = d.ultimoCredito[d.meses[d.meses.length - 1]];
    setFonte(`Pasta <b>${esc(nomePasta)}</b> · ${nArr} arquivo(s) de arrecadação · crédito até <b>${dataBR(ultimo)}</b>`
      + (d.ultimaAtualizacao ? ` · atualizado em ${dataBR(d.ultimaAtualizacao.slice(0, 10))}${esc(d.ultimaAtualizacao.slice(10))}` : ""));
    $("vazio").hidden = true; $("area").hidden = false; $("abas").hidden = false; $("btnPdf").disabled = false; $("btnPrint").disabled = false; $("btnMensal").disabled = false;
    const sups = supsDisponiveis();
    E.sups = E.sups.filter((x) => sups.includes(x));
    if (!E.sups.length && !E.res.__filtrosIniciados) E.sups = sups.includes("INTERIOR") ? ["INTERIOR"] : [];
    E.res.__filtrosIniciados = true;
    if (!d.meses.includes(E.mes)) E.mes = d.meses[d.meses.length - 1];
    E.meses = E.meses.filter((m) => d.meses.includes(m));
    if (!E.meses.length) E.meses = [E.mes];
    E.mes = E.meses[E.meses.length - 1];
    E.sel = selDoMes(E.mes);
    montaFiltros();
    desenha();
  }

  // faturamento: quantas linhas foram descartadas e por quê (com um exemplo do que veio no arquivo)
  function rejeicao(a) {
    const r = a.rejeitadas;
    if (!r || !a.semChave) return "";
    const motivos = [["lig", "sem matrícula"], ["venc", "vencimento não reconhecido"], ["ref", "referência não reconhecida"], ["valor", "valor não reconhecido"]]
      .filter(([k]) => r[k]).map(([k, t]) => `${t}: ${fmt(r[k])}`).join(", ");
    return `${fmt(a.semChave)} linhas descartadas (${motivos}). Ex.: ${r.exemplo}`;
  }
  function listaArquivos(res) {
    const USO = { diaria: "Arrecadação diária", acumulada: "Arrecadação acumulada", desconto: "Desconto comercial", perfil: "Perfil do cliente", orcado: "Orçado (linha da arrecadação)", faturamento: "Faturamento (Fatura de ciclo)", receber: "Contas a receber", cadastro: "Cadastro (superintendência)", ajustes: "Ajustes do painel (orçado digitado e curva)", ignorado: "Não usado" };
    const linhas = res.arquivos.map((a) => `<tr>${td(esc(a.rel), "rot")}${td((USO[a.tipo] || a.tipo) + (a.recTipo ? (a.recTipo === "nfc" ? " (apenas NFC)" : " (total)") : ""), "rot")}${td(a.registros != null ? fmt(a.registros) : "")}`
      + `${td(esc((a.meses || []).map(C.rotuloMes).join(", ")), "rot")}${td(esc(a.motivo || [a.puladas ? `${fmt(a.puladas)} linhas de mês que está no arquivo diário não foram usadas` : "", rejeicao(a), a.doCache ? "já lido antes (guardado neste navegador)" : ""].filter(Boolean).join("; ")), "rot")}</tr>`).join("");
    const d = res.dados, avisos = [];
    if (!res.temDesconto) avisos.push("Planilha de desconto comercial não encontrada: a arrecadação aparece sem o desconto.");
    if (!res.temPerfil) avisos.push("Planilha de perfil do cliente (Cluster) não encontrada: todos aparecem como “Sem perfil”.");
    if (res.cadastroInfo) avisos.push(`Superintendência pelo cadastro: ${fmt(res.cadastroInfo.matriculas)} matrículas (${Object.entries(res.cadastroInfo.porSup)
      .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(nomeSup(k))} ${fmt(v)}`).join(", ")}); o Interior vai só pela cidade, como no BI (o cadastro não vale lá); nas outras cidades vale o cadastro e, fora dele, “Sem SUP”.`);
    else avisos.push("Sem planilha de cadastro com a SUPERINTENDENCIA: a superintendência vem da cidade.");
    if (!res.orcados.length) avisos.push("Nenhuma planilha de orçado (RF) com a linha da arrecadação: digite o orçado do mês no Resumo (Orçado do mês e curva).");
    if (d.zonasSemSup.length) avisos.push(`Zonas fora da relação de cidades (aparecem em “Sem SUP”): ${esc(d.zonasSemSup.join(", "))}.`);
    if (d.subSemClasse.length) avisos.push(`Subcategorias fora da relação (aparecem em “${R.SEM_CLASSIFICACAO}”): ${esc(d.subSemClasse.join(", "))}.`);
    const descMes = C.descontoPorMes(d);
    const ultimos = d.meses.map((m, i) => [m, descMes[i]]).filter(([, v]) => v).slice(-3);
    if (ultimos.length) {
      // por superintendência (mês inteiro) e o que ficou de fora por a ligação não ter pagado no mês: confere a planilha
      const todas = C.marcaCombos(d, {}), porSup = C.porGrupo(d, ultimos.map(([m]) => d.meses.indexOf(m)), todas, C.MASCARA_MES, (c) => nomeSup(c.sup) || "Sem SUP");
      avisos.push("Desconto comercial abatido (ligações que pagaram no mês, como no BI): " + ultimos.map(([m, v]) => {
        const mi = d.meses.indexOf(m), sp = d.descontoSemPagamento[m] || 0;
        const partes = [...porSup.entries()].map(([k, l]) => [k, (l.get(mi) || {}).desconto || 0]).filter(([, x]) => x).sort((a, b) => a[1] - b[1]);
        return `${C.rotuloMes(m)} ${rs(-v)} (${partes.map(([k, x]) => `${esc(k)} ${rs(x)}`).join(", ")})`
          + (sp ? `; mais ${rs(-sp)} de ligações sem pagamento no mês, fora do total` : "");
      }).join(" · ") + ".");
    }
    const arqDesc = res.arquivos.filter((a) => a.tipo === "desconto");
    if (arqDesc.length) avisos.push(`Planilhas de desconto lidas: ${arqDesc.map((a) => `${esc(a.rel)} (${fmt(a.registros || 0)} linhas)`).join("; ")}.`);
    const fatArqs = res.arquivos.filter((a) => a.tipo === "faturamento");
    if (fatArqs.length && res.cruzamento) {
      const dg = res.cruzamento.diag;
      avisos.push(`Faturamento: ${fatArqs.length} arquivo(s), ${fmt(dg.contas)} contas (referências ${esc([...new Set(fatArqs.flatMap((a) => a.meses || []))].sort().map(C.rotuloMes).join(", "))}).`
        + (dg.fora.contas ? ` ${fmt(dg.fora.contas)} contas Em Análise ficaram de fora (${rs(dg.fora.valor)}).` : "")
        + (dg.duplicadas ? ` ${fmt(dg.duplicadas)} contas repetidas em mais de um arquivo contaram uma vez.` : "")
        + (dg.semChave ? ` ${fmt(dg.semChave)} linhas sem matrícula, vencimento, referência ou valor foram ignoradas.` : ""));
    }
    if (d.descartadas.semCredito) avisos.push(`${fmt(d.descartadas.semCredito)} linhas sem Data Crédito foram ignoradas.`);
    if (d.descartadas.semValor) avisos.push(`${fmt(d.descartadas.semValor)} linhas sem Val. Autenticado foram ignoradas.`);
    E.htmlArquivos = `<table><thead><tr><th>Arquivo</th><th>Uso</th><th>Linhas</th><th>Meses</th><th>Observação</th></tr></thead><tbody>${linhas}</tbody></table>`
      + (avisos.length ? `<ul class="avisos">${avisos.map((a) => `<li>${a}</li>`).join("")}</ul>` : "");
    $("listaArquivos").innerHTML = E.htmlArquivos;
    $("leitura").hidden = false;
  }

  // ===== filtros =====
  function supsDisponiveis() {
    const s = new Set(E.res.dados.combos.map((c) => c.sup));
    return [...R.SUPS.filter((x) => s.has(x)), ...[...s].filter((x) => !R.SUPS.includes(x)).sort()];
  }
  function opcoes(sel, lista, atual) {
    sel.innerHTML = lista.map(([v, t]) => `<option value="${esc(v)}"${v === atual ? " selected" : ""}>${esc(t)}</option>`).join("");
    sel.disabled = false;
  }
  function montaFiltros() {
    const d = E.res.dados;
    filtroSup.define(supsDisponiveis().map((s) => [s, nomeSup(s)]), E.sups);
    const cidades = [...new Set(d.combos.filter((c) => passa(E.sups, c.sup)).map((c) => c.cidade))].sort();
    E.cidades = E.cidades.filter((c) => cidades.includes(c));                       // cidade fora das superintendências escolhidas sai
    filtroCidade.define(cidades.map((c) => [c, c]), E.cidades);
    const grupos = ordena([...new Set(d.combos.map((c) => c.grupo))], R.ORDEM_SUBCATEGORIAS);
    E.grupos = E.grupos.filter((g) => grupos.includes(g));
    filtroGrupo.define(grupos.map((g) => [g, g]), E.grupos);
    filtroMes.define([...d.meses].reverse().map((m) => [m, C.rotuloMes(m)]), E.meses);
    montaSeletorOrcado();
  }
  // Seletor de orçado: as planilhas RF da pasta (a mais nova primeiro) e o valor digitado no painel
  function fontesOrcado() {
    return [...new Set(E.res.orcados.map((o) => o.fonte))].sort((a, b) => C.ordemOrcado(b) - C.ordemOrcado(a) || a.localeCompare(b));
  }
  // Orçado em uso no mês: o escolhido; sem escolha (ou planilha que não está na pasta), o RF mais novo que tem o mês
  function fonteAtiva(mes) {
    const fontes = fontesOrcado();
    if (E.fonte === DIGITADO || fontes.includes(E.fonte)) return E.fonte;
    const comMes = fontes.find((f) => E.res.orcados.some((o) => o.fonte === f && o.mes === mes));
    return comMes || (E.ajustes.orcado[mes] ? DIGITADO : fontes[0] || DIGITADO);
  }
  function montaSeletorOrcado() {
    const mes = E.mes, temMes = (f) => E.res.orcados.some((o) => o.fonte === f && o.mes === mes);
    opcoes($("selOrc"), [...fontesOrcado().map((f) => [f, temMes(f) ? f : `${f} (sem ${C.rotuloMes(mes)})`]), [DIGITADO, "Digitado no painel"]], fonteAtiva(mes));
  }
  $("selOrc").addEventListener("change", (e) => {
    E.fonte = e.target.value;
    try { localStorage.setItem("arrecadacao_orcado", E.fonte); } catch (x) { /* sem armazenamento */ }
    desenha();
  });
  try { E.fonte = localStorage.getItem("arrecadacao_orcado") || ""; } catch (x) { E.fonte = ""; }
  // Filtro de vários itens: botão com o resumo da escolha e, ao clicar, a lista com caixas de marcar. "Todas" limpa a
  // escolha; com muitos itens, uma caixa de busca. Cada marcação já atualiza o painel.
  // semTodas: sem o item "Todas" e sempre com pelo menos um marcado (filtro Mês)
  function multiFiltro(id, nomePlural, aoMudar, semTodas = false) {
    const raiz = $(id), botao = raiz.querySelector(".multi-botao"), lista = raiz.querySelector(".multi-lista");
    let itens = [], sel = [], busca = "";
    const rot = (v) => (itens.find(([x]) => x === v) || [v, v])[1];
    const resumo = () => (!sel.length ? "Todas" : sel.length <= 2 ? sel.map(rot).join(" + ") : `${sel.length} ${nomePlural}`);
    function desenhaLista() {
      const vis = itens.filter(([, t]) => !busca || C.chave(t).includes(C.chave(busca)));
      lista.innerHTML = (itens.length > 8 ? `<input type="search" class="multi-busca" placeholder="Buscar…" value="${esc(busca)}">` : "")
        + (semTodas ? "" : `<label class="multi-item multi-todas"><input type="checkbox" data-todas${sel.length ? "" : " checked"}> Todas</label>`)
        + vis.map(([v, t]) => `<label class="multi-item"><input type="checkbox" value="${esc(v)}"${sel.includes(v) ? " checked" : ""}> ${esc(t)}</label>`).join("")
        + (vis.length ? "" : '<p class="multi-vazio">Nada encontrado.</p>');
    }
    const fecha = () => { lista.hidden = true; botao.setAttribute("aria-expanded", "false"); };
    botao.addEventListener("click", () => {
      const abrir = lista.hidden;
      document.querySelectorAll(".multi-lista").forEach((l) => { l.hidden = true; });
      if (!abrir) { fecha(); return; }
      busca = ""; desenhaLista(); lista.hidden = false; botao.setAttribute("aria-expanded", "true");
      const b = lista.querySelector(".multi-busca"); if (b) b.focus();
    });
    lista.addEventListener("input", (e) => {
      if (e.target.classList.contains("multi-busca")) { busca = e.target.value; desenhaLista(); const b = lista.querySelector(".multi-busca"); b.focus(); b.setSelectionRange(busca.length, busca.length); }
    });
    lista.addEventListener("change", (e) => {
      const cx = e.target;
      if (cx.type !== "checkbox") return;
      if (cx.hasAttribute("data-todas")) sel = [];
      else sel = cx.checked ? [...sel, cx.value] : sel.filter((x) => x !== cx.value);
      if (semTodas && !sel.length) { cx.checked = true; sel = [cx.value]; return; }   // ao menos um mês
      sel = itens.map(([v]) => v).filter((v) => sel.includes(v));                   // na ordem da lista
      botao.textContent = resumo(); botao.title = sel.length ? sel.map(rot).join(", ") : "Todas";
      desenhaLista();
      aoMudar([...sel]);
    });
    document.addEventListener("click", (e) => { if (!raiz.contains(e.target)) fecha(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecha(); });
    return {
      define(novos, escolhidos) {
        itens = novos; sel = escolhidos.filter((v) => itens.some(([x]) => x === v));
        botao.disabled = false; botao.textContent = resumo(); botao.title = sel.length ? sel.map(rot).join(", ") : "Todas";
        if (!lista.hidden) desenhaLista();
      },
    };
  }
  const filtroSup = multiFiltro("selSup", "superintendências", (l) => { E.sups = l; montaFiltros(); desenha(); });
  const filtroCidade = multiFiltro("selCidade", "cidades", (l) => { E.cidades = l; desenha(); });
  const filtroGrupo = multiFiltro("selGrupo", "subcategorias", (l) => { E.grupos = l; desenha(); });
  // Mês: vários meses marcados (lista da mais recente para a mais antiga). As telas de um mês usam o mais recente marcado.
  const filtroMes = multiFiltro("selMes", "meses", (l) => {
    E.meses = [...l].sort();
    const novo = E.meses[E.meses.length - 1];
    if (novo !== E.mes) { E.mes = novo; E.sel = selDoMes(E.mes); montaSeletorOrcado(); }
    desenha();
  }, true);

  function ordena(lista, ordem) {
    const pos = (x) => { const i = ordem.indexOf(x); return i < 0 ? 999 : i; };
    return [...lista].sort((a, b) => pos(a) - pos(b) || String(a).localeCompare(String(b), "pt-BR"));
  }
  // dia útil padrão: o último com crédito no mês (mês fechado: todos)
  function ultimoDiaComDados(mes) {
    const ult = E.res.dados.ultimoCredito[mes];
    if (!ult) return 0;
    let n = 0;
    for (const dia of C.calendario(mes).dias) { if (dia.data > ult) break; if (dia.ordem) n = dia.ordem; }
    return n;
  }
  // Dias úteis marcados: lembrados neste navegador, por mês (não mudam para os outros usuários).
  // Mês sem marcação guardada: do dia 1 ao último dia com dados.
  function selDoMes(mes) {
    try {
      const v = JSON.parse(localStorage.getItem("arrecadacao_dias") || "{}")[mes];
      if (Number.isInteger(v) && v >= 0) return v >>> 0;
    } catch (e) { /* sem armazenamento */ }
    return C.mascaraAte(diaPadrao(mes));
  }
  function guardaSel() {
    try {
      const d = JSON.parse(localStorage.getItem("arrecadacao_dias") || "{}");
      d[E.mes] = E.sel;
      localStorage.setItem("arrecadacao_dias", JSON.stringify(d));
    } catch (e) { /* sem armazenamento */ }
  }
  function diaPadrao(mes) { return Math.max(1, ultimoDiaComDados(mes) || C.calendario(mes).uteis); }

  // ===== dados filtrados =====
  const idxMes = (m) => E.res.dados.meses.indexOf(m);
  const marcas = () => C.marcaCombos(E.res.dados, { sup: E.sups, cidade: E.cidades, grupo: E.grupos });
  const passa = (lista, v) => !lista.length || lista.includes(v);
  const okCombo = (c) => passa(E.sups, c.sup) && passa(E.cidades, c.cidade) && passa(E.grupos, c.grupo);
  // faturamento (só Interior): subcategorias escolhidas no padrão dele (Pequeno Comércio vai junto com Comercial)
  const gruposFat = () => [...new Set(E.grupos.map((g) => grupoCruz(g)))];
  const okFat = (c) => passa(E.cidades, c.cidade) && passa(gruposFat(), c.grupo);
  const comInterior = () => passa(E.sups, "INTERIOR");
  const supsTexto = () => (!E.sups.length ? "Todas" : E.sups.map(nomeSup).join(" + "));
  // texto dos filtros (títulos, notas, PDF): "Interior · Rio Bonito + Cordeiro · 3 subcategorias"
  function filtroTexto(sep = " · ", todas = "Todas") {
    const parte = (l, nome) => (l.length <= 2 ? l.join(" + ") : `${l.length} ${nome}`);
    return [E.sups.length ? E.sups.map(nomeSup).join(" + ") : todas, E.cidades.length ? parte(E.cidades, "cidades") : "", E.grupos.length ? parte(E.grupos, "subcategorias") : ""]
      .filter(Boolean).join(sep);
  }
  const marcasSup = (sup) => C.marcaCombos(E.res.dados, { sup });
  const filtroParcial = () => !!(E.cidades.length || E.grupos.length);

  // Orçado mensal da SUP ("" = todas) no orçado escolhido: uma planilha RF ou o valor digitado no painel
  function orcadoMensal(mes, sup) {
    const f = fonteAtiva(mes);
    if (f === DIGITADO) {
      const dig = (E.ajustes.orcado[mes] || {})[sup || "TODAS"];
      if (dig != null && isFinite(dig)) return { valor: +dig, fonte: "digitado no painel" };
    }
    if (!sup) {
      const partes = supsDisponiveis().filter((s) => R.SUPS.includes(s)).map((s) => orcadoMensal(mes, s));
      const comValor = partes.filter((p) => p.valor != null);
      if (!comValor.length) return { valor: null, fonte: "" };
      return { valor: comValor.reduce((a, p) => a + p.valor, 0), fonte: comValor.length > 1 ? "soma das superintendências" : comValor[0].fonte };
    }
    if (f === DIGITADO) return { valor: null, fonte: "" };
    const linhas = E.res.orcados.filter((o) => o.fonte === f && o.mes === mes && o.sup === sup);
    if (!linhas.length) return { valor: null, fonte: "" };
    return { valor: linhas.reduce((a, o) => a + o.valor, 0), fonte: f };
  }
  // Curva do mês: editada no painel ou a média de janeiro até o mês anterior
  function curvaDoMes(mes, sup) {
    const media = C.curvaMedia(E.res.dados, mes, marcasSup(sup), E.ajustes.curvaInicio);
    let padrao;
    if (media.media) padrao = C.distribuiCurva(media.media, mes);
    else {                                             // sem histórico: divide igualmente entre os dias úteis
      const D = C.calendario(mes).uteis;
      padrao = new Array(C.MAX_DIA + 1).fill(0).map((_, k) => (k >= 1 && k <= D ? 1 / D : 0));
    }
    const ed = (E.ajustes.curva[mes] || {})[sup || "TODAS"];
    return { pesos: Array.isArray(ed) ? ed : padrao, padrao, editada: Array.isArray(ed), mesesMedia: media.meses };
  }

  // ===== desenho =====
  function desenha() {
    if (!E.res) return;
    desenhaDias();
    const filtros = [`Superintendência: ${supsTexto()}`, E.cidades.length ? `Cidade: ${E.cidades.join(", ")}` : "", E.grupos.length ? `Subcategoria: ${E.grupos.join(", ")}` : "",
      `Mês: ${C.rotuloMes(E.mes)}`, E.verOrcado ? `Orçado: ${fonteAtiva(E.mes) === DIGITADO ? "digitado" : fonteAtiva(E.mes)}` : "",
      `dias úteis: ${rotuloDias()}`].filter(Boolean).join(" · ");
    // no PDF, só a 1ª folha (Resumo) leva "Arrecadação Diária" no título
    $("cabecalhoPdf").innerHTML = `<h1>${E.aba === "resumo" ? "Arrecadação Diária — " : ""}${ABAS[E.aba]}</h1><p>${esc(filtros)}</p>`;
    document.querySelectorAll(".ate-dia").forEach((s) => { s.textContent = `dias úteis ${rotuloDias()} de cada mês`; });
    $("diasCard").hidden = E.aba === "dados" || E.aba === "base" || (!!AREA_DA_ABA[E.aba] && !["localidade", "analise", "clientes"].includes(E.aba));   // Diagnóstico, Ranking e Clientes usam os dias marcados
    ({ resumo: desenhaResumo, subcategoria: desenhaSubcategoria, perfil: desenhaPerfil, cidades: desenhaCidades, escada: desenhaEscada, onepage: desenhaOnePage, analise: desenhaAnalise, base: desenhaBase, dados: desenhaDados, fxa: desenhaFxa, fxv: desenhaFxv,
      conversao: desenhaConversao, clientes: desenhaClientes, negociacao: desenhaNegociacao, localidade: desenhaLocalidade })[E.aba]();
  }

  // "1 a 12", "1, 5 e 10", "0 (fins de semana e feriados) e 1 a 3"
  // Seleção usada nos cálculos: a marcada, mais (com o último dia útil do mês marcado) os dias úteis seguintes dos meses
  // comparados que têm mais dias úteis. Orçado e curva do mês escolhido não mudam: os dias a mais não existem nele.
  const selCalc = () => C.estendeSel(E.sel, C.calendario(E.mes).uteis);
  // Texto dos dias marcados, com o aviso dos dias a mais (22 e 23) quando eles entram
  function rotuloDias() {
    const U = C.calendario(E.mes).uteis, extra = C.diasDaMascara(selCalc()).filter((d) => d > U);
    const base = rotuloSel((E.sel & C.mascaraAte(U, true)) >>> 0);
    return extra.length ? `${base} + ${extra.join(" e ")} nos meses com mais dias úteis` : base;
  }
  function rotuloSel(sel) {
    const dias = C.diasDaMascara(sel).filter((d) => d > 0), partes = [];
    for (let i = 0; i < dias.length; i++) {
      let j = i;
      while (j + 1 < dias.length && dias[j + 1] === dias[j] + 1) j++;
      partes.push(j - i >= 2 ? `${dias[i]} a ${dias[j]}` : j > i ? `${dias[i]}, ${dias[j]}` : `${dias[i]}`);
      i = j;
    }
    if (sel & 1) partes.unshift("0 (fins de semana e feriados)");
    if (!partes.length) return "nenhum";
    return partes.length === 1 ? partes[0] : partes.slice(0, -1).join(", ") + " e " + partes[partes.length - 1];
  }
  function desenhaDias() {
    const cal = C.calendario(E.mes), ult = ultimoDiaComDados(E.mes);
    let h = `<button type="button" data-d="0" class="zero${E.sel & 1 ? " sel" : ""}" title="Fins de semana e feriados (${cal.naoUteis} dias)">0</button>`;
    const auto = selCalc();
    for (let k = 1; k <= C.MAX_DIA; k++) {
      if (k > cal.uteis) {                             // não existe neste mês: vale para os meses comparados mais longos
        const marcado = E.sel & (1 << k), entra = auto & (1 << k);
        h += `<button type="button" data-d="${k}" class="extra${marcado ? " sel" : entra ? " auto" : ""}" title="${C.rotuloMes(E.mes)} tem ${cal.uteis} dias úteis: o ${k}º vale para os meses `
          + `comparados com mais dias úteis${entra && !marcado ? " (já entra porque o último dia útil está marcado)" : ""}">${k}</button>`;
        continue;
      }
      const cls = [E.sel & (1 << k) ? "sel" : "", k > ult ? "futuro" : ""].filter(Boolean).join(" ");
      h += `<button type="button" data-d="${k}" class="${cls}" title="${dataBR(cal.dataDoDia[k])}">${k}</button>`;
    }
    h += `<span class="dias-acoes sem-pdf"><button type="button" data-acao="ate" title="Marca do dia útil 1 ao último com dados">1 a ${ult || cal.uteis}</button>`
      + `<button type="button" data-acao="limpa">Limpar</button></span>`;
    $("dias").innerHTML = h;
    $("diasNota").textContent = `${C.rotuloMes(E.mes)}: ${cal.uteis} dias úteis · marcados: ${rotuloDias()} · clique em cada dia para marcar ou desmarcar;`
      + " os outros meses usam os mesmos dias úteis · 0 = fins de semana e feriados"
      + (cal.uteis < C.MAX_DIA ? ` · ${cal.uteis + 1 === C.MAX_DIA ? C.MAX_DIA : cal.uteis + 2 === C.MAX_DIA ? `${cal.uteis + 1} e ${C.MAX_DIA}` : `${cal.uteis + 1} a ${C.MAX_DIA}`}`
        + `: só existem em meses mais longos e entram sozinhos quando o ${cal.uteis}º (último) está marcado` : "");
  }
  $("dias").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.acao === "ate") E.sel = C.mascaraAte(diaPadrao(E.mes));
    else if (b.dataset.acao === "limpa") E.sel = 0;
    else E.sel = (E.sel ^ (1 << +b.dataset.d)) >>> 0;
    guardaSel();
    desenha();
  });

  function tabela(el, cab, linhas) {
    $(el).innerHTML = `<thead><tr>${cab.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${linhas.join("")}</tbody>`;
  }

  // ----- Resumo -----
  function desenhaResumo() {
    const d = E.res.dados, mi = idxMes(E.mes), mk = marcas(), cal = C.calendario(E.mes), sel = selCalc();
    const s = C.serieDoMes(d, mi, mk), tot = C.totalDoMes(d, mi, mk, sel), ult = ultimoDiaComDados(E.mes);
    const dias = C.diasDaMascara(sel).filter((k) => k <= cal.uteis);   // só os dias marcados, nesta ordem (0 primeiro)
    const orc = filtroParcial() ? { valor: null, fonte: "" } : orcadoMensal(E.mes, E.sup);
    const pesos = curvaDoMes(E.mes, E.sup).pesos;
    const temOrc = orc.valor != null;
    const orcDia = (k) => (temOrc ? pesos[k] * orc.valor : NaN);
    let orcAte = 0;
    for (const k of dias) orcAte += orcDia(k);
    const delta = temOrc && orcAte ? tot.valor / orcAte - 1 : NaN;
    const semOrc = filtroParcial() ? "o orçado é por superintendência (Cidade e Subcategoria = Todas)"
      : `sem orçado de ${C.rotuloMes(E.mes)} em ${fonteAtiva(E.mes) === DIGITADO ? "Digitado" : fonteAtiva(E.mes)}`;
    $("kpis").innerHTML = [
      ["Orçado mensal", temOrc ? milhoes(orc.valor) : "—", temOrc ? `${C.rotuloMes(E.mes)} · ${esc(orc.fonte)}` : semOrc],
      ["Orçado nos dias", temOrc ? milhoes(orcAte) : "—", `dias úteis ${rotuloSel(sel)} de ${cal.uteis}`],
      ["Arrecadação nos dias", milhoes(tot.valor), `${rs(tot.valor)}${tot.desconto ? ` (desconto comercial ${rs(tot.desconto)})` : ""}`],
      ["Δ (%)", `<i class="${delta < 0 ? "neg" : ""}" style="font-style:normal">${pct(delta)}</i>`, temOrc ? `${rs(tot.valor - orcAte)} vs orçado` : semOrc],
      ["Ticket médio", tot.contas ? fmt(tot.valor / tot.contas, 2) : "—", `${fmt(tot.contas)} contas pagas`],
    ].filter(([t]) => E.verOrcado || !/^(Orçado|Δ)/.test(t)).map(([t, v, sub]) => `<div class="kpi"><span>${t}</span><b>${v}</b><small>${sub}</small></div>`).join("");
    const verOrc = E.verOrcado;
    $("tituloOrc").textContent = verOrc ? "Orçado × Realizado" : "Realizado";
    $("notaOrc").textContent = !verOrc || temOrc ? "" : "(" + semOrc + ")";

    const linhaOrc = (rot, du, o, a, fora, temDado) => {
      const dif = a - o, p = a / o - 1;
      return `<tr class="${fora ? "fora" : ""}">${td(rot, "rot")}${td(du, "du")}${td(temOrc ? fmt(o) : "—")}`
        + `${td(temDado ? fmt(a) : "")}${temDado && temOrc ? tdNum(dif, fmt) + tdNum(p, pct) : td("") + td("")}</tr>`;
    };
    const rows = dias.map((k) => (k === 0
      ? linhaOrc(`Fins de semana e feriados (${cal.naoUteis})`, 0, orcDia(0), s.valor[0], false, true)
      : linhaOrc(C.rotuloDia(cal.dataDoDia[k]), k, orcDia(k), s.valor[k], false, k <= ult)));
    if (tot.desconto) rows.push(`<tr class="desc">${td("Desconto comercial", "rot")}${td("")}${td("")}${td(fmt(tot.desconto))}${td("")}${td("")}</tr>`);
    rows.push(`<tr class="total">${td("Total", "rot")}${td("")}${td(temOrc ? fmt(orcAte) : "—")}${td(fmt(tot.valor))}`
      + `${temOrc ? tdNum(tot.valor - orcAte, fmt) + tdNum(delta, pct) : td("") + td("")}</tr>`);
    // botão "Orçado" do topo desligado: some Orçado dia, Dif e Δ (colunas 3, 5 e 6), fica só o realizado
    const soReal = (tr) => (verOrc ? tr : tr.replace(/^(<tr[^>]*>)((?:<td[^>]*>.*?<\/td>){6})<\/tr>$/, (m, a, cels) => {
      const c = cels.match(/<td[^>]*>.*?<\/td>/g);
      return a + c[0] + c[1] + c[3] + "</tr>";
    }));
    tabela("tOrc", verOrc ? ["Data", "Dia útil", "Orçado dia", "Arrecadação dia", "Dif", "Δ (%)"] : ["Data", "Dia útil", "Arrecadação dia"], rows.map(soReal));

    // clientes, contas e ticket: mês escolhido e os dois anteriores, até o mesmo dia útil
    const meses = [C.mesAnterior(E.mes, 2), C.mesAnterior(E.mes, 1), E.mes];
    const series = meses.map((m) => (idxMes(m) >= 0 ? C.serieDoMes(d, idxMes(m), mk) : null));
    const totais = meses.map((m) => (idxMes(m) >= 0 ? C.totalDoMes(d, idxMes(m), mk, sel) : null));
    const cab = ["Dia útil", ...meses.map(C.rotuloMes)];
    const tresMeses = (el, porDia, total, dec) => tabela(el, cab, [
      ...dias.map((k) => `<tr>${td(k, "du")}${series.map((sr) => td(sr && porDia(sr, k) != null ? fmt(porDia(sr, k), dec) : "")).join("")}</tr>`),
      `<tr class="total">${td("Total", "du")}${totais.map((t) => td(t && total(t) != null ? fmt(total(t), dec) : "")).join("")}</tr>`,
    ]);
    tresMeses("tCli", (sr, k) => sr.clientes[k], (t) => t.clientes, 0);
    tresMeses("tCon", (sr, k) => sr.contas[k], (t) => t.contas, 0);
    tresMeses("tTic", (sr, k) => (sr.contas[k] ? sr.valor[k] / sr.contas[k] : null), (t) => (t.contas ? t.valor / t.contas : null), 2);
    desenhaCurva();
    desenhaResumoAnalise(s, cal);
  }

  // ----- Resumo: análise por dia útil (gráfico, destaques e consolidado), como no painel de faturamento; fora do PDF -----
  const MESES_LONGOS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const mesLongo = (m) => `${MESES_LONGOS[+m.slice(5, 7) - 1]}/${m.slice(0, 4)}`;
  const curto = (v) => (Math.abs(v) >= 1e6 ? fmt(v / 1e6, 2) + " mi" : fmt(v / 1e3) + " mil");
  const ALERTA = 0.4;                                  // variação que pinta a barra (±40%)
  let idResumo = 0;
  function desenhaResumoAnalise(s, cal) {
    const d = E.res.dados, mk = marcas(), ant = C.mesAnterior(E.mes), miAnt = idxMes(ant);
    const sa = miAnt >= 0 ? C.serieDoMes(d, miAnt, mk) : null, calAnt = C.calendario(ant);
    const dias = C.diasDaMascara(E.sel).filter((k) => k <= cal.uteis);
    const nAt = mesLongo(E.mes), nAnt = mesLongo(ant), filtro = filtroTexto(" — ");
    const at = dias.map((k) => s.valor[k]), an = dias.map((k) => (sa ? sa.valor[k] : 0));
    const rot = (k) => (k ? `Dia ${k}` : "Fins de semana");
    // gráfico de barras (SVG): mês anterior × mês atual em cada dia útil marcado
    $("gTitulo").textContent = `Arrecadação por dia útil — ${nAt} vs ${nAnt}`;
    $("gNota").textContent = "Barras do mês atual em laranja indicam queda acima de 40%; em azul médio, crescimento acima de 40%. Valor aproximado em cada barra; passe o mouse (ou toque) para ver os valores exatos, contas, clientes e ticket do dia.";
    $("gLegenda").innerHTML = `<span><i class="cor-ant"></i>${nAnt}</span><span><i class="cor-at"></i>${nAt}</span><span><i class="cor-alerta"></i>Alerta (±40%)</span>`;
    grafico("grafico", dias.length && ((W) => svgDias(dias, at, an, cal, nAt, nAnt, W, s, sa)), '<p class="nota">Nenhum dia útil marcado.</p>');
    // faixa: dias úteis dos dois meses
    $("faixaDias").innerHTML = `<b>Dias úteis no mês</b><span>${nAt}: <b>${cal.uteis} dias</b></span><span>${nAnt}: <b>${calAnt.uteis} dias</b></span>`
      + `<span><b>Δ ${cal.uteis - calAnt.uteis >= 0 ? "" : "−"}${Math.abs(cal.uteis - calAnt.uteis)} dia${Math.abs(cal.uteis - calAnt.uteis) === 1 ? "" : "s"}</b></span>`
      + `<span>Dias marcados: <b>${rotuloDias()}</b></span>`;
    // destaques
    $("destTitulo").textContent = `Destaques do mês — ${nAt} — ${filtro.toUpperCase()}`;
    const tA = C.totalDoMes(d, idxMes(E.mes), mk, selCalc()), tB = miAnt >= 0 ? C.totalDoMes(d, miAnt, mk, selCalc()) : null;
    const delta = (a, b, f) => (b ? ` (${a - b >= 0 ? "+" : "−"}${f(Math.abs(a - b))} vs ${nAnt})` : "");
    const tic = (t) => (t && t.contas ? t.valor / t.contas : 0);
    const porDia = dias.map((k, i) => ({ k, dif: at[i] - an[i], dt: (s.contas[k] ? s.valor[k] / s.contas[k] : 0) - (sa && sa.contas[k] ? sa.valor[k] / sa.contas[k] : 0), temAnt: !!(sa && sa.contas[k]) && !!s.contas[k] }));
    const lista = (arr, f) => (arr.length ? arr.map((x) => `<li>${f(x)}</li>`).join("") : "<li>—</li>");
    const dia = (k) => (k ? `Dia útil ${k} (${dataBR(cal.dataDoDia[k]).slice(0, 5)})` : "Fins de semana e feriados");
    const blocos = [
      ["Clientes e contas", `<li>${fmt(tA.clientes)} clientes pagantes${tB ? delta(tA.clientes, tB.clientes, fmt) : ""}</li><li>${fmt(tA.contas)} contas pagas${tB ? delta(tA.contas, tB.contas, fmt) : ""}</li>`
        + `<li>Ticket médio R$ ${fmt(tic(tA), 2)}${tB ? delta(tic(tA), tic(tB), (v) => "R$ " + fmt(v, 2)) : ""}</li>`],
      ["Crescimento — Arrecadação", lista(porDia.filter((x) => x.dif > 0).sort((a, b) => b.dif - a.dif).slice(0, 3), (x) => `${dia(x.k)}: arrecadação ${rs(x.dif)} acima`)],
      ["Queda — Arrecadação", lista(porDia.filter((x) => x.dif < 0).sort((a, b) => a.dif - b.dif).slice(0, 3), (x) => `${dia(x.k)}: arrecadação ${rs(-x.dif)} abaixo`)],
      ["Crescimento — Ticket médio", lista(porDia.filter((x) => x.temAnt && x.dt > 0).sort((a, b) => b.dt - a.dt).slice(0, 3), (x) => `${dia(x.k)}: ticket R$ ${fmt(x.dt, 2)} acima`)],
      ["Queda — Ticket médio", lista(porDia.filter((x) => x.temAnt && x.dt < 0).sort((a, b) => a.dt - b.dt).slice(0, 3), (x) => `${dia(x.k)}: ticket R$ ${fmt(-x.dt, 2)} abaixo`)],
      ["Top clientes — Aumentos", '<li id="destAumentos">calculando…</li>'],
      ["Top clientes — Quedas", '<li id="destQuedas">calculando…</li>'],
    ];
    $("destaques").innerHTML = blocos.map(([t, li]) => `<div class="dest"><h3>${t}</h3><ul>${li}</ul></div>`).join("");
    if (worker) worker.postMessage({ tipo: "analise", para: "resumo", id: ++idResumo, mi: idxMes(E.mes), miAnt, marcas: mk, sel: selCalc(), n: 100 });
    // consolidado por dia útil
    $("consNota").textContent = "valores do dia sem o desconto; o total tem o desconto comercial, como nas outras tabelas";
    const linhas = dias.map((k, i) => {
      const v = an[i] ? at[i] / an[i] - 1 : NaN;
      return `<tr>${td(k, "du")}${td(k ? dataBR(cal.dataDoDia[k]) : "fins de semana e feriados", "rot")}${td(fmt(at[i], 2))}${td(fmt(an[i], 2))}${isFinite(v) ? tdNum(v, pct) : td("")}`
        + `${td(fmt(s.clientes[k]))}${td(fmt(s.contas[k]))}${td(s.contas[k] ? fmt(s.valor[k] / s.contas[k], 2) : "")}</tr>`;
    });
    const vT = tB && tB.valor ? tA.valor / tB.valor - 1 : NaN;
    linhas.push(`<tr class="total">${td("Total", "du")}${td("")}${td(fmt(tA.valor, 2))}${td(tB ? fmt(tB.valor, 2) : "")}${isFinite(vT) ? tdNum(vT, pct) : td("")}`
      + `${td(fmt(tA.clientes))}${td(fmt(tA.contas))}${td(tA.contas ? fmt(tic(tA), 2) : "")}</tr>`);
    tabela("tConsolidado", ["Dia útil", "Data", `Arrecadação ${C.rotuloMes(E.mes)}`, `Arrecadação ${C.rotuloMes(ant)}`, "Δ (%)", "Clientes pagantes", "Contas pagas", "Ticket médio"], linhas);
  }
  // barras por dia útil: mês anterior × mês atual (barra do mês atual pintada quando varia mais de ±40%)
  function svgDias(dias, at, an, cal, nAt, nAnt, W, s, sa) {
    const rot = (k) => (k ? `Dia ${k}` : "Fins de semana"), data = (k) => (k ? dataBR(cal.dataDoDia[k]).slice(0, 5) : "");
    const varDe = (i) => (an[i] > 0 ? at[i] / an[i] - 1 : NaN);
    return barras({
      cats: dias.map(rot), sub: dias.map(data), rotulo: curto,
      series: [[an, "b-ant"], [at, (i) => { const v = varDe(i); return v <= -ALERTA ? "b-queda" : v >= ALERTA ? "b-alta" : "b-at"; }]],
      titulo: (i) => {
        const k = dias[i], v = varDe(i), tk = (x) => (x && x.contas[k] ? "R$ " + fmt(x.valor[k] / x.contas[k], 2) : "—");
        return linhaDica(`${rot(k)}${data(k) ? ` (${data(k)})` : ""}`, `${nAt}: ${rs(at[i])}`, `${nAnt}: ${rs(an[i])}`,
          `Diferença: ${rs(at[i] - an[i])}${isFinite(v) ? ` (${pct(v)})` : ""}`,
          `Contas pagas: ${fmt(s.contas[k])} × ${sa ? fmt(sa.contas[k]) : "—"}`, `Clientes: ${fmt(s.clientes[k])} × ${sa ? fmt(sa.clientes[k]) : "—"}`,
          `Ticket médio: ${tk(s)} × ${tk(sa)}`, "Contas, clientes e ticket mostram atual × anterior. Valores do dia sem o desconto comercial");
      },
    }, W);
  }
  function destaquesClientes(m) {
    if (m.id !== idResumo || !$("destAumentos")) return;
    const combos = E.res.dados.combos;
    const quem = (x) => `${esc(x.lig)}${combos[x.c] ? ` (${esc(combos[x.c].cidade)})` : ""}`;
    const bloco = (l, sinal, palavra, total) => (l.length
      ? l.slice(0, 2).map((x, i) => `<li>${i + 1}ª maior ${palavra}: ${quem(x)} — ${rs(sinal * x.dif)}</li>`).join("")
        + `<li>Total de clientes com ${palavra}: ${fmt(total)}</li>`
      : `<li>Nenhum cliente com ${palavra}</li>`);
    $("destAumentos").outerHTML = bloco(m.aumentos, 1, "aumento", m.nAumentos);
    $("destQuedas").outerHTML = bloco(m.quedas, -1, "queda", m.nQuedas);
  }

  // ----- Orçado do mês e curva do orçado diário (editáveis) -----
  const pctInput = (v) => (v * 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // biblioteca de planilhas (SheetJS): carregada só quando precisa (ler matrículas de um Excel, baixar a curva em Excel)
  const carregaXLSX = () => (window.XLSX ? Promise.resolve() : new Promise((ok, erro) => {
    const sc = document.createElement("script"); sc.src = "lib/xlsx.full.min.js"; sc.onload = ok; sc.onerror = erro; document.head.append(sc);
  }));
  // Curva em Excel (para o BI): uma linha por dia do mês, na ordem das datas, com Data, Dia útil e Peso (o peso usado da tela:
  // a média ou o editado). Os fins de semana e feriados (dia útil 0) vêm cada um com a sua data e o peso do 0 dividido
  // igualmente entre eles. Uma 2ª aba traz as informações da curva.
  async function baixaCurvaExcel() {
    try { await carregaXLSX(); } catch (e) { toast("Não foi possível carregar a biblioteca de planilhas.", true); return; }
    const cal = C.calendario(E.mes), sup = E.sup, orc = orcadoMensal(E.mes, sup), cv = curvaDoMes(E.mes, sup), X = window.XLSX;
    const data = (iso) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
    const peso0 = cal.naoUteis ? cv.pesos[0] / cal.naoUteis : 0;
    const linhas = [["Data", "Dia útil", "Peso"], ...cal.dias.map((x) => [data(x.data), x.ordem, x.ordem ? cv.pesos[x.ordem] : peso0])];
    const ws = X.utils.aoa_to_sheet(linhas, { cellDates: true });
    for (let r = 1; r < linhas.length; r++) {
      const d = ws[X.utils.encode_cell({ r, c: 0 })], p = ws[X.utils.encode_cell({ r, c: 2 })];
      if (d) d.z = "dd/mm/yyyy";
      if (p) p.z = "0.00%";
    }
    ws["!cols"] = [{ wch: 12 }, { wch: 9 }, { wch: 12 }];
    const info = X.utils.aoa_to_sheet([
      ["Mês", C.rotuloMes(E.mes)], ["Superintendência", nomeSup(sup)], ["Dias úteis", cal.uteis],
      ["Fins de semana e feriados (dia útil 0)", `${cal.naoUteis} dias, cada um com ${pct(peso0)} (peso do 0 de ${pct(cv.pesos[0])} dividido igualmente)`], ["Orçado mensal", orc.valor != null ? orc.valor : "sem orçado"], ["Fonte do orçado", orc.fonte || "—"],
      ["Curva", cv.editada ? "editada no painel" : "média dos meses anteriores"],
      ["Meses da média", cv.mesesMedia.length ? cv.mesesMedia.map(C.rotuloMes).join(", ") : "nenhum (dividida igualmente)"],
      ["Soma dos pesos", cv.pesos.reduce((a, b) => a + b, 0)], ["Gerado em", new Date().toLocaleString("pt-BR")], ["Versão do painel", VERSAO_SITE],
    ]);
    info["!cols"] = [{ wch: 36 }, { wch: 60 }];
    for (const ref of ["B5", "B9"]) if (info[ref] && typeof info[ref].v === "number") info[ref].z = ref === "B5" ? "#,##0.00" : "0.00%";
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, `Curva ${E.mes}`);
    X.utils.book_append_sheet(wb, info, "Informações");
    X.writeFile(wb, `Curva_orcado_diario_${E.mes}_${(nomeSup(sup) || "Todas").replace(/\s+/g, "_")}.xlsx`);
  }
  function desenhaCurva() {
    const corpo = $("curvaCorpo");
    if (filtroParcial()) {
      $("curvaResumo").textContent = "";
      corpo.innerHTML = '<p class="nota">O orçado e a curva são por superintendência: escolha Cidade e Subcategoria = Todas para ver e editar.</p>';
      return;
    }
    const cal = C.calendario(E.mes), sup = E.sup, orc = orcadoMensal(E.mes, sup), cv = curvaDoMes(E.mes, sup);
    const rot = `${C.rotuloMes(E.mes)} — ${nomeSup(sup)}`;
    $("curvaResumo").textContent = `${rot} · ${orc.valor != null ? rs(orc.valor) : "sem orçado"} · curva ${cv.editada ? "editada" : "pela média"}`;
    const linhas = [];
    const linha = (k, data) => {
      const o = orc.valor != null ? cv.pesos[k] * orc.valor : NaN;
      return `<tr>${td(k ? k : "0", "du")}${td(data, "rot")}${td(pctInput(cv.padrao[k]) + "%")}`
        + `<td><input type="text" inputmode="decimal" data-k="${k}" value="${pctInput(cv.pesos[k])}"${Math.abs(cv.pesos[k] - cv.padrao[k]) > 5e-6 ? ' class="editado"' : ""}></td>`
        + `${td(isFinite(o) ? fmt(o) : "—")}</tr>`;
    };
    for (let k = 1; k <= cal.uteis; k++) linhas.push(linha(k, C.rotuloDia(cal.dataDoDia[k])));
    linhas.push(linha(0, `fins de semana e feriados (${cal.naoUteis} dias)`));
    const somaP = cv.pesos.reduce((a, b) => a + b, 0), somaPad = cv.padrao.reduce((a, b) => a + b, 0);
    linhas.push(`<tr class="total">${td("Total", "du")}${td("")}${td(pctInput(somaPad) + "%")}${td(pctInput(somaP) + "%")}${td(orc.valor != null ? fmt(orc.valor * somaP) : "—")}</tr>`);
    const mesesMedia = cv.mesesMedia.length ? `${C.rotuloMes(cv.mesesMedia[0])} a ${C.rotuloMes(cv.mesesMedia[cv.mesesMedia.length - 1])} (${cv.mesesMedia.length} meses)` : "nenhum mês anterior na pasta: dividida igualmente";
    const inicio = E.ajustes.curvaInicio && E.ajustes.curvaInicio < E.mes ? E.ajustes.curvaInicio : E.mes.slice(0, 4) + "-01";
    const opInicio = E.res.dados.meses.filter((m) => m < E.mes);
    if (!opInicio.includes(inicio)) opInicio.unshift(inicio);
    corpo.innerHTML = `
      <div class="orc-linha"><b>Orçado mensal (arrecadação) — ${esc(rot)}:</b>
        <span>${orc.valor != null ? `<b>${rs(orc.valor)}</b> · ${esc(orc.fonte)}` : "sem valor no orçado escolhido"}</span>
        <span class="salvo">· troque a planilha em <b>Orçado</b>, no cabeçalho, ou digite um valor:</span>
        <input type="text" inputmode="decimal" id="inOrc" value="${orc.fonte === "digitado no painel" ? fmt(orc.valor, 2) : ""}" placeholder="R$">
        <button type="button" class="btn sec" id="btnSalvaOrc">Usar valor digitado</button></div>
      <div class="orc-linha"><b>Média a partir de:</b>
        <select id="selInicio">${opInicio.map((m) => `<option value="${m}"${m === inicio ? " selected" : ""}>${C.rotuloMes(m)}</option>`).join("")}</select>
        <span class="salvo">até o mês anterior ao escolhido (vale para todos que usam a pasta)</span></div>
      <p class="nota">Curva do orçado diário: a <b>média</b> é a participação de cada dia útil no total arrecadado de ${esc(mesesMedia)}.
        Os dias que passam de ${cal.uteis} (o nº de dias úteis de ${C.rotuloMes(E.mes)}) têm a parte dividida igualmente entre os ${cal.uteis} dias;
        o 0 vale para os fins de semana e feriados do mês. Edite o <b>peso usado</b> e salve: a soma é ajustada para 100% e vale para todos que usam a pasta.</p>
      <div class="wrap"><table class="tcurva"><thead><tr><th>Dia útil</th><th>Data</th><th>Média</th><th>Peso usado (%)</th><th>Orçado do dia</th></tr></thead><tbody>${linhas.join("")}</tbody></table></div>
      <div class="orc-linha"><button type="button" class="btn" id="btnSalvaCurva">Salvar curva</button>
        <button type="button" class="btn sec" id="btnCurvaExcel" title="Data, dia útil e peso de cada dia do mês (fins de semana e feriados com o peso do 0 dividido igualmente), para usar no BI">Baixar Excel</button>
        ${cv.editada ? '<button type="button" class="btn sec" id="btnLimpaCurva">Voltar à média</button>' : ""}</div>`;
    const chaveSup = sup || "TODAS";
    $("btnSalvaOrc").onclick = async () => {
      const v = C.numeroBR($("inOrc").value);
      if (!isFinite(v) || v <= 0) { toast("Digite o orçado em reais, ex.: 12.103.044,93", true); return; }
      const r = await gravaAjustes((a) => { (a.orcado[E.mes] = a.orcado[E.mes] || {})[chaveSup] = v; });
      avisoGravacao(r, "Orçado salvo");
      if (r.ok) { E.fonte = DIGITADO; try { localStorage.setItem("arrecadacao_orcado", DIGITADO); } catch (x) { /* sem armazenamento */ } }
      montaSeletorOrcado();
      desenha();
    };
    $("btnCurvaExcel").onclick = baixaCurvaExcel;
    $("selInicio").onchange = async (e) => {
      const v = e.target.value;
      const r = await gravaAjustes((a) => { a.curvaInicio = v; });
      avisoGravacao(r, `Média a partir de ${C.rotuloMes(v)}`);
      desenha();
    };
    $("btnSalvaCurva").onclick = async () => {
      const w = new Array(C.MAX_DIA + 1).fill(0);
      let ok = true;
      corpo.querySelectorAll("input[data-k]").forEach((i) => { const v = C.numeroBR(i.value); if (!isFinite(v) || v < 0) ok = false; else w[+i.dataset.k] = v / 100; });
      const soma = w.reduce((a, b) => a + b, 0);
      if (!ok || soma <= 0) { toast("Os pesos precisam ser números ≥ 0, ex.: 7,42", true); return; }
      const norm = w.map((v) => v / soma);
      const r = await gravaAjustes((a) => { (a.curva[E.mes] = a.curva[E.mes] || {})[chaveSup] = norm; });
      avisoGravacao(r, "Curva salva", Math.abs(soma - 1) > 1e-4 ? ` A soma era ${pctInput(soma)}% e foi ajustada para 100%.` : "");
      desenha();
    };
    if ($("btnLimpaCurva")) $("btnLimpaCurva").onclick = async () => {
      const r = await gravaAjustes((a) => { if (a.curva[E.mes]) delete a.curva[E.mes][chaveSup]; });
      avisoGravacao(r, "Curva voltou à média");
      desenha();
    };
  }

  // ----- abas por grupo (Subcategoria, Perfil, Cidades) -----
  // meses da comparação: o escolhido e os 13 anteriores que existem na pasta
  function mesesDaComparacao() {
    const ini = C.mesAnterior(E.mes, 13);
    return E.res.dados.meses.filter((m) => m >= ini && m <= E.mes);
  }
  // linhas: [{rot, chave, cls}] → três tabelas (valor, clientes, contas)
  function tresTabelas(ids, grupoDe, ordemRot, opcoes = {}) {
    const d = E.res.dados, meses = mesesDaComparacao(), idx = meses.map(idxMes), mk = marcas();
    const g = C.porGrupo(d, idx, mk, selCalc(), grupoDe);
    const det = opcoes.detalheDe ? C.porGrupo(d, idx, mk, selCalc(), opcoes.detalheDe) : null;
    const rotulos = ordemRot([...g.keys()]);
    const cab = [opcoes.titulo, ...meses.map(C.rotuloMes)];
    const total = (campo) => idx.map((m) => { let s = 0; for (const l of g.values()) { const c = l.get(m); if (c) s += c[campo]; } return s; });
    const cel = (l, m, campo, f) => { const c = l && l.get(m); return c ? tdNum(c[campo], f) : td(""); };
    const monta = (campo, f, comDetalhe) => {
      const linhas = [];
      for (const r of rotulos) {
        const l = g.get(r);
        const dets = comDetalhe && det ? [...det.keys()].filter((k) => k.split("\u0001")[0] === r).sort() : [];
        const expansivel = dets.length > 1 || (dets.length === 1 && dets[0].split("\u0001")[1] !== r);
        const aberto = expansivel && E.abertos.has(r);
        linhas.push(`<tr class="${expansivel ? "grupo" + (aberto ? " aberto" : "") : ""}" data-g="${esc(r)}">${td(esc(r), "rot")}${idx.map((m) => cel(l, m, campo, f)).join("")}</tr>`);
        if (expansivel) for (const k of dets) linhas.push(`<tr class="det"${aberto ? "" : " hidden"}>${td(esc(k.split("\u0001")[1]), "rot")}${idx.map((m) => cel(det.get(k), m, campo, f)).join("")}</tr>`);
      }
      linhas.push(`<tr class="total">${td("Total", "rot")}${total(campo).map((v) => tdNum(v, f)).join("")}</tr>`);
      return linhas;
    };
    // valor sem "R$" em cada célula (está no título) para a tabela caber na tela sem rolar para o lado
    tabela(ids[0], [opcoes.titulo + " (R$)", ...cab.slice(1)], monta("valor", fmt, true));
    tabela(ids[1], cab, monta("clientes", fmt, false));
    tabela(ids[2], cab, monta("contas", fmt, false));
  }
  ["tSubValor"].forEach((id) => $(id).addEventListener("click", (e) => {
    const tr = e.target.closest("tr.grupo");
    if (!tr) return;
    const g = tr.dataset.g;
    if (E.abertos.has(g)) E.abertos.delete(g); else E.abertos.add(g);
    desenha();
  }));
  const porOrdem = (ordem, finais) => (lista) => {
    const fim = lista.filter((x) => finais.includes(x)), resto = lista.filter((x) => !finais.includes(x));
    return [...ordena(resto, ordem), ...fim];
  };
  function desenhaSubcategoria() {
    tresTabelas(["tSubValor", "tSubCli", "tSubCon"], (c) => c.grupo, porOrdem(R.ORDEM_SUBCATEGORIAS, [R.SEM_CLASSIFICACAO]),
      { titulo: "Subcategoria", detalheDe: (c) => c.grupo + "\u0001" + c.detalhe });
  }
  function desenhaPerfil() {
    tresTabelas(["tPerValor", "tPerCli", "tPerCon"], (c) => c.perfil, porOrdem(R.ORDEM_PERFIS, [R.SEM_PERFIL]), { titulo: "Perfil (Cluster Saldo)" });
    $("legendaPerfil").innerHTML = `<p><b>Adimplente</b> – cliente sem faturas vencidas e que já realizou ao menos um pagamento.</p>
      <p><b>Inadimplente</b> – cliente com débitos em aberto e que já realizou ao menos um pagamento.</p>
      <p><b>Nunca Pagou</b> – cliente que nunca realizou um pagamento.</p>
      <p><b>${R.SEM_PERFIL}</b> – cliente sem perfil de pagamento definido.</p>`;
  }
  function desenhaCidades() {
    tresTabelas(["tCidValor", "tCidCli", "tCidCon"], (c) => c.cidade, (l) => [...l].sort((a, b) => a.localeCompare(b, "pt-BR")), { titulo: "Cidade" });
  }

  // ----- Escada -----
  function desenhaEscada() {
    const d = E.res.dados, meses = mesesDaComparacao(), idx = meses.map(idxMes);
    const esq = C.escada(d, idx, marcas(), selCalc());
    // no painel, todos os vencimentos; no PDF (executivo), até 2 meses depois do mês escolhido e o resto numa linha só
    const limite = C.mesAnterior(E.mes, -2), POST = "\u0002depois";
    const resumida = document.body.classList.contains("gerando-pdf");
    for (const v of [...esq.linhas.keys()]) {
      if (!resumida || !v || v <= limite) continue;
      let p = esq.linhas.get(POST);
      if (!p) { p = new Map(); esq.linhas.set(POST, p); }
      for (const [m, x] of esq.linhas.get(v)) p.set(m, (p.get(m) || 0) + x);
      esq.linhas.delete(v);
    }
    const ordemV = (v) => (v === POST ? "9998" : v === "" ? "9999" : v);
    const vencs = [...esq.linhas.keys()].sort((a, b) => ordemV(a).localeCompare(ordemV(b)));
    let max = 0;
    for (const l of esq.linhas.values()) for (const v of l.values()) if (v > max) max = v;
    // escada "limpa" (padrão): só as células a partir de R$ 50 mil, e as linhas sem nenhuma somem; o total continua com tudo
    // opções (lembradas neste navegador): preencher = nas linhas que ficam, também as células abaixo de R$ 50 mil (em cinza);
    // demais = linha "Demais vencimentos" com o que não aparece, para cada coluna fechar com o Total
    const limpa = escadaLimpa(), preenche = limpa && escadaOpcao("preenche"), comDemais = limpa && escadaOpcao("demais");
    const grande = (x) => x != null && (!limpa || x >= ESCADA_MINIMO);
    const ficaLinha = (v) => !limpa || [...esq.linhas.get(v).values()].some(grande);
    const aparece = (x, v) => x != null && (grande(x) || (preenche && ficaLinha(v)));
    const linhas = vencs.filter(ficaLinha).map((v) => {
      const l = esq.linhas.get(v);
      const rot = v === POST ? `após ${C.rotuloMes(limite)}` : v ? C.rotuloMes(v) : "(sem vencimento)";
      return `<tr>${td(rot, "rot")}${idx.map((m, j) => {
        const x = l.get(m);
        if (!aparece(x, v)) return x != null ? `<td data-v="${x}"></td>` : td("");
        const a = x > 0 && max ? 0.06 + 0.55 * (x / max) : 0;
        const st = a ? ` style="background:rgba(23,107,156,${a.toFixed(3)})${a > 0.4 ? ";color:#fff" : ""}"` : "";
        return `<td class="${[x < 0 ? "neg" : "", v === meses[j] ? "diag" : "", grande(x) ? "" : "esc-menor"].filter(Boolean).join(" ")}"${st}>${fmt(x)}</td>`;
      }).join("")}</tr>`;
    });
    // escada limpa: o que ficou em branco (abaixo de R$ 50 mil) soma numa linha por mês de crédito, para a coluna fechar com o Total
    if (comDemais) {
      const demais = idx.map((m) => { let s = 0; for (const [v, l] of esq.linhas) { const x = l.get(m); if (x != null && !aparece(x, v)) s += x; } return s; });
      if (demais.some((x) => x)) linhas.push(`<tr class="desc">${td(`Demais vencimentos (abaixo de R$ ${fmt(ESCADA_MINIMO / 1000)} mil)`, "rot")}${demais.map((x) => (x ? tdNum(x, fmt) : td(""))).join("")}</tr>`);
    }
    if ([...esq.desconto.values()].some((v) => v)) linhas.push(`<tr class="desc">${td("Desconto comercial", "rot")}${idx.map((m) => (esq.desconto.get(m) ? tdNum(esq.desconto.get(m), fmt) : td(""))).join("")}</tr>`);
    const tot = idx.map((m) => { let s = esq.desconto.get(m) || 0; for (const l of esq.linhas.values()) s += l.get(m) || 0; return s; });
    linhas.push(`<tr class="total">${td("Total", "rot")}${tot.map((v) => tdNum(v, fmt)).join("")}</tr>`);
    tabela("tEscada", ["Vencimento (R$)", ...meses.map(C.rotuloMes)], linhas);
    $("escadaLimpa").checked = limpa;
    $("escadaPreenche").checked = escadaOpcao("preenche"); $("escadaDemais").checked = escadaOpcao("demais");
    $("escadaPreenche").closest("label").hidden = $("escadaDemais").closest("label").hidden = !limpa;
    const resto = comDemais ? "somam na linha “Demais vencimentos” de cada mês" : "ficam de fora das linhas";
    $("escadaNota").textContent = !limpa ? "Mostrando todos os vencimentos e valores."
      : preenche ? `Mostrando os vencimentos com algum valor a partir de R$ ${fmt(ESCADA_MINIMO)}, com todos os valores da linha (os menores em cinza); os vencimentos só com valores menores ${resto}. O Total soma tudo (inclusive o desconto).`
      : `Mostrando só os valores a partir de R$ ${fmt(ESCADA_MINIMO)}; os menores ${comDemais ? resto : "ficam em branco"}. O Total soma tudo (inclusive o desconto).`;
    // aviso do executivo (só no PDF), quando a escada está resumida
    $("escadaAvisoPdf").textContent = limpa
      ? `Para facilitar a leitura, a escada exibe ${preenche ? `apenas os vencimentos com algum valor a partir de R$ ${fmt(ESCADA_MINIMO / 1000)} mil` : `apenas os valores a partir de R$ ${fmt(ESCADA_MINIMO / 1000)} mil`}${comDemais ? "; o restante soma na linha “Demais vencimentos”" : ""}. Os totais consideram a arrecadação integral de cada mês.`
      : "";
    $("escadaAvisoPdf").hidden = !limpa;
  }
  // Opção da escada: só valores a partir de R$ 50 mil (padrão) ou a escada completa. Lembrada neste navegador.
  const ESCADA_MINIMO = 50000;
  function escadaLimpa() { try { return localStorage.getItem("arrecadacao_escada") !== "completa"; } catch (e) { return true; } }
  // preencher e demais: ligadas por padrão
  function escadaOpcao(k) { try { return localStorage.getItem("arrecadacao_escada_" + k) !== "nao"; } catch (e) { return true; } }
  for (const [id, k] of [["escadaPreenche", "preenche"], ["escadaDemais", "demais"]]) $(id).addEventListener("change", (e) => {
    try { localStorage.setItem("arrecadacao_escada_" + k, e.target.checked ? "sim" : "nao"); } catch (x) { /* sem armazenamento */ }
    desenha();
  });
  $("escadaLimpa").addEventListener("change", (e) => {
    try { localStorage.setItem("arrecadacao_escada", e.target.checked ? "limpa" : "completa"); } catch (x) { /* sem armazenamento */ }
    desenha();
  });

  // ----- Análise: top 100 por ligação (calculado no worker, que guarda o valor de cada ligação por dia) -----
  let idAnalise = 0, ultimaAnalise = null;
  function desenhaAnalise() {
    const mi = idxMes(E.mes), ant = C.mesAnterior(E.mes);
    const filtro = filtroTexto();
    $("analiseNota").textContent = `${C.rotuloMes(E.mes)} × ${C.rotuloMes(ant)} · dias úteis ${rotuloDias()} · ${filtro}. Calculando…`;
    document.querySelectorAll(".analise-sub").forEach((x) => { x.textContent = C.rotuloMes(E.mes); });
    if (!worker) return;
    worker.postMessage({ tipo: "analise", id: ++idAnalise, mi, miAnt: idxMes(ant), marcas: marcas(), sel: selCalc(), n: 100 });
  }
  function recebeAnalise(m) {
    if (m.para === "resumo") { if (!m.erro) destaquesClientes(m); return; }
    if (m.para === "onepage") { recebeTopOnePage(m); return; }
    if (m.id !== idAnalise) return;                  // resposta de um pedido antigo (filtro já mudou)
    if (m.erro) { $("analiseNota").textContent = "Análise indisponível: " + m.erro; return; }
    ultimaAnalise = m;
    const ant = C.rotuloMes(C.mesAnterior(E.mes)), at = C.rotuloMes(E.mes), combos = E.res.dados.combos;
    $("analiseNota").textContent = $("analiseNota").textContent.replace(" Calculando…", "");
    const desc = (x) => { const c = combos[x.c] || {}; return [c.cidade || "", c.grupo || "", c.perfil || ""]; };
    const cab = ["#", "Ligação", "Cliente", "Cidade", "Subcategoria", "Perfil", `${ant} (R$)`, `${at} (R$)`, "Diferença", "Δ (%)"];
    const linha = (x, i) => {
      const [cid, sub, per] = desc(x), p = x.anterior ? x.atual / x.anterior - 1 : NaN;
      return `<tr>${td(i + 1, "du")}${td(esc(x.lig), "rot")}${td(esc(x.nome) || "—", "rot nome")}${td(esc(cid), "rot")}${td(esc(sub), "rot")}${td(esc(per), "rot")}`
        + `${td(fmt(x.anterior))}${td(fmt(x.atual))}${tdNum(x.dif, fmt)}${x.anterior ? tdNum(p, pct) : td("novo")}</tr>`;
    };
    const vazio = (l) => (l.length ? l.map(linha) : [`<tr><td colspan="10" class="rot">Nenhuma ligação.</td></tr>`]);
    const subs = document.querySelectorAll(".analise-sub");
    const totais = [null, m.nAumentos, m.nQuedas];
    [m.maiores, m.aumentos, m.quedas].forEach((l, i) => {
      subs[i].textContent = `${at} · ${fmt(l.length)} cliente${l.length === 1 ? "" : "s"}`
        + (totais[i] != null && totais[i] > l.length ? ` (dos ${fmt(totais[i])} com ${i === 1 ? "aumento" : "queda"})` : "");
    });
    tabela("tTopMaiores", cab, vazio(m.maiores));
    tabela("tTopAumentos", cab, vazio(m.aumentos));
    tabela("tTopQuedas", cab, vazio(m.quedas));
  }
  // CSV (abre no Excel): a lista que está na tela
  document.querySelectorAll("button[data-csv]").forEach((b) => b.addEventListener("click", () => {
    if (!ultimaAnalise) return;
    const qual = { tTopMaiores: "maiores", tTopAumentos: "aumentos", tTopQuedas: "quedas" }[b.dataset.csv];
    const combos = E.res.dados.combos, num = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(".", ",");
    const linhas = [["Posição", "Ligação", "Cliente", "Cidade", "Subcategoria", "Perfil", "Mês anterior", "Mês", "Diferença"].join(";")];
    ultimaAnalise[qual].forEach((x, i) => {
      const c = combos[x.c] || {};
      linhas.push([i + 1, x.lig, `"${String(x.nome || "").replace(/"/g, '""')}"`, c.cidade, c.grupo, c.perfil, num(x.anterior), num(x.atual), num(x.dif)].join(";"));
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + linhas.join("\r\n")], { type: "text/csv;charset=utf-8" }));
    a.download = `TopClientes_${qual}_${E.mes}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }));

  // ----- Base: extração das linhas completas para uma lista de matrículas e meses (o worker relê os CSVs) -----
  let idBase = 0, mesesBase = null;
  const ligsDoTexto = (t) => [...new Set((String(t).match(/\d{4,15}/g) || []).map(C.ligacao))];
  function atualizaQtdBase() { const n = ligsDoTexto($("baseLigs").value).length; $("baseQtd").textContent = `${fmt(n)} matrícula${n === 1 ? "" : "s"}`; }
  function desenhaBase() {
    const meses = [...E.res.dados.meses].reverse();
    if (!mesesBase || mesesBase.some((m) => !meses.includes(m))) mesesBase = [E.mes];
    $("baseMeses").innerHTML = meses.map((m) => `<label><input type="checkbox" value="${m}"${mesesBase.includes(m) ? " checked" : ""}> ${C.rotuloMes(m)}</label>`).join("");
    atualizaQtdBase();
    // base de oportunidades: padrão = pagaram no mês anterior ao do cabeçalho e não pagaram nele
    if (!meses.includes(opA)) opA = meses.includes(C.mesAnterior(E.mes)) ? C.mesAnterior(E.mes) : meses[meses.length - 1];
    if (!meses.includes(opB)) opB = E.mes;
    const opcoes = (sel) => meses.map((m) => `<option value="${m}"${m === sel ? " selected" : ""}>${C.rotuloMes(m)}</option>`).join("");
    $("opA").innerHTML = opcoes(opA); $("opB").innerHTML = opcoes(opB);
    // comparativo por mês: padrão = os meses da base de oportunidades
    if (!mesesCmp || mesesCmp.some((m) => !meses.includes(m))) mesesCmp = [...new Set([opA, opB])];
    atualizaOpcoesExtras();
    $("cmpMeses").innerHTML = meses.map((m) => `<label><input type="checkbox" value="${m}"${mesesCmp.includes(m) ? " checked" : ""}> ${C.rotuloMes(m)}</label>`).join("");
  }
  // rótulos das opções "Incluir dados do faturamento / das contas a receber" (aba Base e Negociação)
  function atualizaOpcoesExtras() {
    const refs = E.res.cruzamento ? [...new Set(E.res.cruzamento.fat.map((f) => f.ref))].sort() : [];
    document.querySelectorAll(".opcao-fat").forEach((cx) => {
      cx.disabled = !refs.length;
      if (!refs.length) cx.checked = false;
      cx.parentElement.querySelector(".rot-fat").textContent = refs.length
        ? `Incluir dados do faturamento (endereço da ligação, grupo, rota e situação da ligação), da referência ${C.rotuloMes(refs[refs.length - 1])}`
        : "Incluir dados do faturamento: sem faturamento aproveitado na pasta";
    });
    const ri = recInfo();
    document.querySelectorAll(".opcao-rec").forEach((cx) => {
      cx.disabled = !ri;
      if (!ri) cx.checked = false;
      cx.parentElement.querySelector(".rot-rec").textContent = ri
        ? `Incluir dados das contas a receber (Saldo total vencido e SIT_LIG, no fim do arquivo), base ${recNome()} de ${dataBR(ri.data)}`
        : "Incluir dados das contas a receber: nenhuma base de contas a receber na pasta";
    });
  }
  let mesesCmp = null, idCmp = 0;
  $("cmpMeses").addEventListener("change", () => { mesesCmp = [...$("cmpMeses").querySelectorAll("input:checked")].map((i) => i.value); });
  $("cmpNenhum").addEventListener("click", () => { mesesCmp = []; $("cmpMeses").querySelectorAll("input").forEach((i) => { i.checked = false; }); });
  $("cmpGerar").addEventListener("click", () => {
    if (!mesesCmp || !mesesCmp.length) { toast("Marque pelo menos um mês.", true); return; }
    const meses = [...mesesCmp].sort();
    $("cmpGerar").disabled = true;
    $("cmpStatus").textContent = "Montando o comparativo…";
    $("cmpResultado").innerHTML = "";
    worker.postMessage({ tipo: "comparativo", id: ++idCmp, mis: meses.map(idxMes), rotulos: meses.map(C.rotuloMes), marcas: marcas(), nomesSup: NOME_SUP, meses,
      comFat: $("cmpFat").checked, comRec: $("cmpRec").checked, recTipo: E.recTipo });
    cmpPedido = meses;
  });
  let cmpPedido = [];
  function recebeComparativo(m) {
    if (m.id !== idCmp) return;
    $("cmpGerar").disabled = false;
    if (m.erro) { $("cmpStatus").textContent = "Erro: " + m.erro; return; }
    const filtro = filtroTexto();
    $("cmpStatus").textContent = `${fmt(m.linhas)} matrículas com pagamento em pelo menos um dos meses · ${filtro}.${textoCadastro(m.cadastro)}${textoReceber(m.comReceber)}`;
    const nome = `Comparativo_por_mes_${cmpPedido[0]}${cmpPedido.length > 1 ? "_a_" + cmpPedido[cmpPedido.length - 1] : ""}.csv`;
    $("cmpResultado").innerHTML = `<table class="compacta base-tabela"><thead><tr><th>Mês</th><th>Matrículas com pagamento</th><th>Arrecadado (R$)</th></tr></thead><tbody>`
      + cmpPedido.map((mes, j) => `<tr>${td(C.rotuloMes(mes), "rot")}${td(fmt(m.porMes[j].matriculas))}${td(fmt(m.porMes[j].valor))}</tr>`).join("")
      + `<tr class="total">${td("Matrículas (linhas do arquivo)", "rot")}${td(fmt(m.linhas))}${td("")}</tr></tbody></table>`
      + `<div class="base-acoes"><button type="button" class="btn" id="cmpBaixar">Baixar comparativo (CSV)</button></div>`
      + (m.linhas > 1048000 ? '<p class="nota">Atenção: passa de 1 milhão de linhas, o limite de uma planilha do Excel. Use os filtros do cabeçalho para dividir.</p>' : "");
    $("cmpBaixar").onclick = () => baixa(m.blob, nome);
    if (m.linhas) baixa(m.blob, nome);
  }
  let opA = "", opB = "", idOp = 0;
  const modoBase = () => document.querySelector('input[name="baseModo"]:checked').value;
  document.querySelectorAll('input[name="baseModo"]').forEach((r) => r.addEventListener("change", () => {
    const todas = modoBase() === "todas";
    $("baseLigs").disabled = todas;
    $("basePorMes").checked = todas;
  }));
  $("baseMeses").addEventListener("change", () => { mesesBase = [...$("baseMeses").querySelectorAll("input:checked")].map((i) => i.value); });
  $("baseTodos").addEventListener("click", () => { mesesBase = [...E.res.dados.meses]; desenhaBase(); });
  $("baseNenhum").addEventListener("click", () => { mesesBase = []; desenhaBase(); });
  $("baseLigs").addEventListener("input", atualizaQtdBase);
  $("baseLimpaLigs").addEventListener("click", () => { $("baseLigs").value = ""; atualizaQtdBase(); });
  // arquivo de matrículas: Excel (coluna Matrícula/Ligação, ou a 1ª coluna) ou texto
  $("baseArquivo").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      let ligs;
      if (/\.xlsx?$/i.test(f.name)) {
        await carregaXLSX();
        const livro = window.XLSX.read(await f.arrayBuffer(), { type: "array" });
        const linhas = window.XLSX.utils.sheet_to_json(livro.Sheets[livro.SheetNames[0]], { header: 1, raw: false, defval: "" });
        const cab = (linhas[0] || []).map(C.chave);
        let col = cab.findIndex((c) => /MATRICULA|LIGACAO/.test(c));
        const ini = col >= 0 ? 1 : 0;
        if (col < 0) col = 0;
        ligs = linhas.slice(ini).map((l) => String(l[col] || "")).join("\n");
      } else ligs = await f.text();
      const lista = ligsDoTexto(ligs);
      $("baseLigs").value = lista.join("\n");
      atualizaQtdBase();
      toast(`${fmt(lista.length)} matrículas carregadas de ${esc(f.name)}.`);
    } catch (x) { toast("Não foi possível ler o arquivo de matrículas: " + esc(x.message || x), true); }
  });
  $("baseExtrair").addEventListener("click", () => {
    const todas = modoBase() === "todas", ligs = todas ? null : ligsDoTexto($("baseLigs").value);
    if (!todas && !ligs.length) { toast("Informe as matrículas (cole a lista ou carregue um arquivo), ou escolha Todas as matrículas.", true); return; }
    if (!mesesBase || !mesesBase.length) { toast("Marque pelo menos um mês.", true); return; }
    if (!worker) return;
    $("baseExtrair").disabled = true;
    $("baseResultado").innerHTML = "";
    $("baseStatus").textContent = "Lendo os arquivos…";
    worker.postMessage({ tipo: "extrair", id: ++idBase, ligs, meses: [...mesesBase].sort(), porMesArquivo: $("basePorMes").checked });
  });
  let ultimaBase = null;
  function recebeBase(m) {
    if (m.id !== idBase) return;
    $("baseExtrair").disabled = false;
    if (m.erro) { $("baseStatus").textContent = "Erro: " + m.erro; return; }
    ultimaBase = m;
    const meses = Object.keys(m.porMes).sort(), nomeArq = (o) => `Base_arrecadacao${m.completa ? "_completa" : ""}_${o.mes || (meses.length ? meses[0] + (meses.length > 1 ? "_a_" + meses[meses.length - 1] : "") : "vazia")}.csv`;
    const mb = (b) => (b.size < 1048576 ? Math.max(1, Math.round(b.size / 1024)) + " KB" : (b.size / 1048576).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " MB");
    $("baseStatus").textContent = `${fmt(m.linhas)} linha${m.linhas === 1 ? "" : "s"} encontrada${m.linhas === 1 ? "" : "s"} em ${m.arquivos} arquivo(s) lido(s).`;
    const grandes = m.saida.filter((o) => o.linhas > 1048000);
    $("baseResultado").innerHTML = `<table class="compacta base-tabela"><thead><tr><th>Mês</th><th>Linhas</th></tr></thead><tbody>`
      + meses.map((x) => `<tr>${td(C.rotuloMes(x), "rot")}${td(fmt(m.porMes[x]))}</tr>`).join("")
      + `<tr class="total">${td("Total", "rot")}${td(fmt(m.linhas))}</tr></tbody></table>`
      + `<div class="base-acoes">${m.saida.map((o, i) => `<button type="button" class="btn" data-base-arq="${i}">Baixar ${o.mes ? C.rotuloMes(o.mes) : "base"} (CSV, ${mb(o.blob)})</button>`).join("")}`
      + (m.naoEncontradas.length ? `<button type="button" class="btn sec" id="baseBaixarNao">Baixar matrículas sem pagamento (${fmt(m.naoEncontradas.length)})</button>` : "")
      + `</div>` + (grandes.length ? `<p class="nota">Atenção: ${grandes.map((o) => o.mes ? C.rotuloMes(o.mes) : "a base").join(", ")} passa${grandes.length > 1 ? "m" : ""} de 1 milhão de linhas, o limite de uma planilha do Excel`
        + `${$("basePorMes").checked ? "" : " (marque Um arquivo por mês para dividir)"}. Para cruzar meses, use a Base de oportunidades abaixo.</p>` : "")
      + (m.naoEncontradas.length ? `<p class="nota">${fmt(m.naoEncontradas.length)} matrícula(s) da lista não têm pagamento nos meses marcados.</p>` : "");
    $("baseResultado").querySelectorAll("button[data-base-arq]").forEach((b) => { b.onclick = () => { const o = ultimaBase.saida[+b.dataset.baseArq]; baixa(o.blob, nomeArq(o)); }; });
    if ($("baseBaixarNao")) $("baseBaixarNao").onclick = () => baixa("\ufeffMatrícula\r\n" + ultimaBase.naoEncontradas.join("\r\n"), "Matriculas_sem_pagamento.csv");
    // baixa sozinho (um arquivo atrás do outro; o navegador pode pedir para permitir vários downloads)
    m.saida.forEach((o, i) => setTimeout(() => baixa(o.blob, nomeArq(o)), i * 800));
  }
  // base de oportunidades: pagaram no mês A e não pagaram no mês B (o worker cruza; os filtros do cabeçalho valem)
  $("opA").addEventListener("change", (e) => { opA = e.target.value; });
  $("opB").addEventListener("change", (e) => { opB = e.target.value; });
  $("opGerar").addEventListener("click", () => {
    if (opA === opB) { toast("Escolha dois meses diferentes.", true); return; }
    $("opGerar").disabled = true;
    $("opStatus").textContent = "Cruzando os meses…";
    $("opResultado").innerHTML = "";
    worker.postMessage({ tipo: "oportunidades", id: ++idOp, miA: idxMes(opA), miB: idxMes(opB), marcas: marcas(), comFat: $("opFat").checked, comRec: $("opRec").checked, recTipo: E.recTipo });
  });
  const textoReceber = (n) => (n != null ? ` Contas a receber (base ${recNome()} de ${dataBR(recInfo().data)}): ${fmt(n)} matrículas com saldo na base.` : "");
  const textoCadastro = (c) => (c ? ` Dados do faturamento da referência ${C.rotuloMes(c.ref)} (${c.arquivos.join(", ")}): ${fmt(c.comCadastro)} matrículas encontradas.` : "");
  function recebeOportunidades(m) {
    if (m.id !== idOp) return;
    $("opGerar").disabled = false;
    if (m.erro) { $("opStatus").textContent = "Erro: " + m.erro; return; }
    const d = E.res.dados, l = m.lista, total = l.reduce((a, x) => a + x.valor, 0), A = C.rotuloMes(opA), B = C.rotuloMes(opB);
    const filtro = filtroTexto();
    const ultB = d.ultimoCredito[opB];
    $("opStatus").textContent = `${fmt(l.length)} matrículas pagaram em ${A} e não pagaram em ${B}${ultB && opB === d.meses[d.meses.length - 1] ? ` (até ${dataBR(ultB)})` : ""} · ${filtro} · ${rs(total)} pagos em ${A}.${textoCadastro(m.cadastro)}${textoReceber(m.comReceber)}`;
    const porCid = new Map();
    for (const x of l) { const c = d.combos[x.c] || {}, o = porCid.get(c.cidade) || { n: 0, v: 0 }; o.n++; o.v += x.valor; porCid.set(c.cidade, o); }
    const cids = [...porCid.entries()].sort((a, b) => b[1].v - a[1].v);
    const n = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(".", ","), txt = (t) => (t == null ? "" : String(t)).replace(/;/g, ",");
    // colunas extras (o worker monta): faturamento depois da Subcategoria; contas a receber no fim
    const csv = "\ufeff" + [["Matrícula", "Nome", "Superintendência", "Cidade", "Subcategoria", ...m.cabFat, `Valor pago em ${A}`, `Dias com pagamento em ${A}`, ...m.cabRec].join(";"),
      ...l.map((x) => {
        const c = d.combos[x.c] || {};
        return [x.lig, txt(x.nome), nomeSup(c.sup), c.cidade, c.grupo, ...x.fat.map(txt), n(x.valor), x.dias, ...x.rec.map(txt)].join(";");
      })].join("\r\n");
    const nome = `Base_oportunidades_pagou_${opA}_nao_pagou_${opB}.csv`;
    $("opResultado").innerHTML = (cids.length ? `<table class="compacta base-tabela"><thead><tr><th>Cidade</th><th>Matrículas</th><th>Pago em ${A} (R$)</th></tr></thead><tbody>`
      + cids.map(([c, o]) => `<tr>${td(esc(c || "—"), "rot")}${td(fmt(o.n))}${td(fmt(o.v))}</tr>`).join("")
      + `<tr class="total">${td("Total", "rot")}${td(fmt(l.length))}${td(fmt(total))}</tr></tbody></table>` : "")
      + `<div class="base-acoes">${l.length ? '<button type="button" class="btn" id="opBaixar">Baixar base de oportunidades (CSV)</button>' : ""}</div>`;
    if ($("opBaixar")) $("opBaixar").onclick = () => baixa(csv, nome);
    if (l.length) baixa(csv, nome);
  }
  // ===== Área Análises — Negociação: pagaram em todos os meses marcados e não pagaram no mês de referência (o worker cruza;
  // os filtros do cabeçalho valem). Padrão: referência = mês do cabeçalho; pagou no mês anterior.
  let ngRef = "", ngMeses = null, idNg = 0, ultimaNg = null;
  function desenhaNegociacao() {
    const meses = E.res.dados.meses;
    if (!meses.includes(ngRef)) { ngRef = E.mes; ngMeses = null; }
    const antes = meses.filter((m) => m < ngRef).reverse();
    if (!ngMeses) ngMeses = antes.includes(C.mesAnterior(ngRef)) ? [C.mesAnterior(ngRef)] : antes.slice(0, 1);
    ngMeses = ngMeses.filter((m) => antes.includes(m));
    $("ngRef").innerHTML = [...meses].reverse().map((m) => `<option value="${m}"${m === ngRef ? " selected" : ""}>${C.rotuloMes(m)}</option>`).join("");
    $("ngMeses").innerHTML = antes.length ? antes.map((m) => `<label><input type="checkbox" value="${m}"${ngMeses.includes(m) ? " checked" : ""}> ${C.rotuloMes(m)}</label>`).join("")
      : `<p class="nota">Sem meses anteriores a ${C.rotuloMes(ngRef)} na pasta.</p>`;
    atualizaOpcoesExtras();
  }
  $("ngRef").addEventListener("change", (e) => { ngRef = e.target.value; ngMeses = null; desenhaNegociacao(); });
  $("ngMeses").addEventListener("change", () => { ngMeses = [...$("ngMeses").querySelectorAll("input:checked")].map((i) => i.value); });
  document.querySelectorAll("[data-ng-ult]").forEach((b) => b.addEventListener("click", () => {
    ngMeses = Array.from({ length: +b.dataset.ngUlt }, (_, i) => C.mesAnterior(ngRef, i + 1));
    desenhaNegociacao();
  }));
  $("ngGerar").addEventListener("click", () => {
    const pagou = [...(ngMeses || [])].sort();
    if (!pagou.length) { toast("Marque pelo menos um mês em que o cliente pagou.", true); return; }
    $("ngGerar").disabled = true; $("ngStatus").textContent = "Cruzando os meses…"; $("ngResultado").innerHTML = "";
    worker.postMessage({ tipo: "negociacao", id: ++idNg, misPagou: pagou.map(idxMes), miRef: idxMes(ngRef), rotulos: pagou.map(C.rotuloMes), rotRef: C.rotuloMes(ngRef), incluiPagantes: $("ngPagantes").checked, marcas: marcas(),
      nomesSup: NOME_SUP, comFat: $("ngFat").checked, comRec: $("ngRec").checked, recTipo: E.recTipo, pagou, ref: ngRef });
    ultimaNg = { pagou, ref: ngRef, todos: $("ngPagantes").checked };
  });
  function recebeNegociacao(m) {
    if (m.id !== idNg) return;
    $("ngGerar").disabled = false;
    if (m.erro) { $("ngStatus").textContent = "Erro: " + m.erro; return; }
    const { pagou, ref, todos } = ultimaNg, d = E.res.dados, R_ = C.rotuloMes(ref), P = pagou.map(C.rotuloMes);
    const ult = d.ultimoCredito[ref], emAndamento = ref === d.meses[d.meses.length - 1] && ult;
    const tot = pagou.map((_, j) => m.porCidade.reduce((a, o) => a + o.vals[j], 0));
    const nomeArq = todos ? `Negociacao_pagou_${pagou.join("_")}_indicativo_${ref}.csv` : `Negociacao_pagou_${pagou.join("_")}_nao_pagou_${ref}.csv`;
    const ate = emAndamento ? ` (até ${dataBR(ult)})` : "";
    $("ngStatus").textContent = (todos ? `${fmt(m.n)} matrículas pagaram em ${P.join(", ")}: ${fmt(m.nNao)} não pagaram em ${R_}${ate} e ${fmt(m.n - m.nNao)} já pagaram`
      : `${fmt(m.n)} matrículas pagaram em ${P.join(", ")} e não pagaram em ${R_}${ate}`) + ` · ${filtroTexto()}.`
      + `${textoCadastro(m.cadastro)}${textoReceber(m.comReceber)}`;
    const cab = (t) => `<thead><tr><th>${t}</th><th>Matrículas</th>${todos ? `<th>Não pagaram em ${R_}</th>` : ""}${P.map((p) => `<th>Pago em ${p} (R$)</th>`).join("")}</tr></thead>`;
    const tab = (titulo, l) => `<div class="card"><h2>${titulo}</h2><div class="wrap"><table class="compacta base-tabela">${cab(titulo)}<tbody>`
      + l.map((o) => `<tr>${td(esc(o.rot), "rot")}${td(fmt(o.n))}${todos ? td(fmt(o.nNao)) : ""}${o.vals.map((v) => td(fmt(v))).join("")}</tr>`).join("")
      + `<tr class="total">${td("Total", "rot")}${td(fmt(m.n))}${todos ? td(fmt(m.nNao)) : ""}${tot.map((v) => td(fmt(v))).join("")}</tr></tbody></table></div></div>`;
    $("ngResultado").innerHTML = !m.n ? '<div class="card"><p class="nota">Nenhuma matrícula nessa situação para os filtros escolhidos.</p></div>'
      : `<div class="card"><div class="base-acoes" style="margin-top:0"><button type="button" class="btn" id="ngBaixar">Baixar lista completa (CSV, ${fmt(m.n)} matrículas)</button></div></div>`
        + tab("Cidade", m.porCidade) + tab("Subcategoria", m.porSub)
        + `<div class="card"><h2>Maiores matrículas <small>as 100 de maior valor pago nos meses marcados</small></h2><div class="wrap lista-rolavel"><table class="compacta base-tabela"><thead><tr>`
        + `<th>Matrícula</th><th>Nome</th><th>Cidade</th><th>Subcategoria</th>${P.map((p) => `<th>Pago em ${p} (R$)</th>`).join("")}<th>Indicativo ${R_}</th></tr></thead><tbody>`
        + m.top.map((x) => `<tr>${td(esc(x.lig), "rot")}${td(esc(x.nome), "rot")}${td(esc(x.cidade), "rot")}${td(esc(x.grupo), "rot")}${x.vals.map((v) => td(fmt(v, 2))).join("")}${td(x.pagouRef ? `Pagou (${fmt(x.valRef, 2)})` : "<b>Não pagou</b>", x.pagouRef ? "rot" : "rot neg")}</tr>`).join("")
        + "</tbody></table></div></div>";
    if ($("ngBaixar")) $("ngBaixar").onclick = () => baixa(m.blob, nomeArq);
  }
  function baixa(texto, nome) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(texto instanceof Blob ? texto : new Blob([texto], { type: "text/csv;charset=utf-8" }));
    a.download = nome;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);   // arquivos grandes: tempo para o download começar
  }

  // ===== Área Análises — Faturamento x Arrecadação (somente Interior: é onde há faturamento) =====
  const grupoCruz = (g) => R.GRUPO_NO_CRUZAMENTO[g] || g;
  const SEL_MES_TODO = C.mascaraAte(C.MAX_DIA, true);          // mês de crédito inteiro (todos os dias)
  let fxaMesEscolhido = "", fxaOrdem = { fxaCid: ["dif", -1], fxaSub: ["dif", -1] }, fxaLinhas = {};
  function desenhaFxa() {
    let cz = E.res.cruzamento;
    const d = E.res.dados;
    // arquivos lidos, mas sem nenhuma conta aproveitada: mostra o motivo (como se não houvesse faturamento)
    const lidosSemConta = E.res.arquivos.filter((x) => x.tipo === "faturamento" && !x.registros && x.semChave);
    if (cz && !cz.fat.length) cz = null;
    $("fxaCorpo").hidden = !cz;
    if (!cz) {
      $("fxaNota").textContent = "";
      // arquivos de faturamento que não foram reconhecidos ou deram erro: mostra o motivo, em vez de "nenhum arquivo"
      const problemas = E.res.arquivos.filter((x) => x.tipo === "ignorado" && (C.chave(x.rel).includes("FATURA") || /faturamento/i.test(x.motivo || "")));
      lidosSemConta.forEach((x) => problemas.push({ rel: x.rel, motivo: rejeicao(x) }));
      $("fxaAviso").innerHTML = problemas.length
        ? `<p class="aviso-pdf">${fmt(problemas.length)} arquivo(s) de faturamento não puderam ser usados:</p><ul class="lista-problemas">`
          + problemas.slice(0, 12).map((x) => `<li><b>${esc(x.rel)}</b>: ${esc(x.motivo)}</li>`).join("") + (problemas.length > 12 ? `<li>… e mais ${problemas.length - 12}</li>` : "")
          + "</ul><p class=\"nota\">Se a mensagem não ajudar, me envie as 3 primeiras linhas de um desses arquivos (abra no Bloco de Notas).</p>"
        : '<p class="aviso-pdf">Nenhum arquivo de faturamento na pasta. Coloque os arquivos <b>Fatura de ciclo MM-AAAA.csv</b> numa subpasta (ex.: <code>Faturamento</code>) e clique em ↻ Atualizar. As abas do Executivo continuam funcionando sem eles.</p>';
      $("fxaMes").innerHTML = ""; return;
    }
    const refs = [...new Set(cz.fat.map((r) => r.ref))].sort();
    const meses = [...new Set([...refs, ...d.meses])].sort();
    if (!meses.includes(fxaMesEscolhido)) fxaMesEscolhido = refs[refs.length - 1] || d.meses[d.meses.length - 1];
    $("fxaMes").innerHTML = [...meses].reverse().map((m) => `<option value="${m}"${m === fxaMesEscolhido ? " selected" : ""}>${C.rotuloMes(m)}${refs.includes(m) ? "" : " (sem faturamento)"}</option>`).join("");
    const M = fxaMesEscolhido, Mant = C.mesAnterior(M);
    const filtroG = gruposFat().join(" + ");
    const mkArr = Uint8Array.from(d.combos, (c) => (c.sup === "INTERIOR" && passa(E.cidades, c.cidade) && passa(gruposFat(), grupoCruz(c.grupo)) ? 1 : 0));
    const avisos = [];
    if (!comInterior()) avisos.push(`O faturamento é só do Interior: o filtro Superintendência = ${supsTexto()} não se aplica aqui (a comparação usa o Interior).`);
    if (E.grupos.includes("PEQUENO COMERCIO")) avisos.push("No cruzamento, Pequeno Comércio está junto com Comercial (o faturamento não separa).");
    $("fxaAviso").innerHTML = avisos.map((a) => `<p class="aviso-pdf">${esc(a)}</p>`).join("");
    const filtroTxt = ["Interior", E.cidades.length > 2 ? `${E.cidades.length} cidades` : E.cidades.join(" + "), filtroG].filter(Boolean).join(" · ");
    const ultimoArr = d.meses[d.meses.length - 1], parcial = M === ultimoArr ? ` · arrecadação de ${C.rotuloMes(M)} até ${dataBR(d.ultimoCredito[M])} (mês em andamento)` : "";
    $("fxaNota").textContent = `${filtroTxt} · faturado pela referência, arrecadado pelo mês de crédito${parcial}.`;
    // séries por mês
    const fatMes = (m) => {
      const o = { valor: 0, credito: 0, contas: 0, matriculas: 0, tem: false };
      for (const r of cz.fat) if (r.ref === m && okFat(cz.combos[r.c])) { o.valor += r.valor; o.credito += r.credito; o.contas += r.contas; o.matriculas += r.matriculas; o.tem = true; }
      return o;
    };
    const arrMes = (m) => { const mi = idxMes(m); return mi >= 0 ? C.totalDoMes(d, mi, mkArr, SEL_MES_TODO) : null; };
    const pagas = (m) => { let n = 0, v = 0; for (const r of cz.coorte) if (r.ref === m && okFat(cz.combos[r.c])) { n += r.contas; v += r.valor; } return { n, v }; };
    const fA = fatMes(M), fB = fatMes(Mant), aA = arrMes(M), aB = arrMes(Mant), pg = pagas(M);
    const varr = (a, b) => (b ? a / b - 1 : NaN);
    const vtxt = (a, b) => (isFinite(varr(a, b)) ? `${varr(a, b) >= 0 ? "+" : ""}${pct(varr(a, b))} vs ${C.rotuloMes(Mant)}` : `sem ${C.rotuloMes(Mant)} para comparar`);
    const card = (t, v, sub, neg) => `<div class="kpi"><span>${t}</span><b${neg ? ' class="neg"' : ""}>${v}</b><small>${sub}</small></div>`;
    $("fxaKpis").innerHTML = [
      card(`Faturado (ref. ${C.rotuloMes(M)})`, fA.tem ? milhoes(fA.valor) : "—", fA.tem ? `${vtxt(fA.valor, fB.tem ? fB.valor : 0)} · ${fmt(fA.contas)} contas · créditos ${rs(fA.credito)}` : `sem faturamento de ${C.rotuloMes(M)} na pasta`),
      card(`Arrecadado (crédito ${C.rotuloMes(M)})`, aA ? milhoes(aA.valor) : "—", aA ? `${vtxt(aA.valor, aB ? aB.valor : 0)} · com desconto` : "sem arrecadação no mês"),
      card("Diferença faturado − arrecadado", fA.tem && aA ? milhoes(fA.valor - aA.valor) : "—", "diferença entre indicadores de períodos diferentes; não é saldo devedor"),
      card("Matrículas faturadas × pagantes", `${fA.tem ? fmt(fA.matriculas) : "—"} × ${aA ? fmt(aA.clientes) : "—"}`, `faturadas na referência × pagantes no mês de crédito`),
      card(`Contas da ref. ${C.rotuloMes(M)} já pagas`, fA.tem && fA.contas ? pct(pg.n / fA.contas) : "—", fA.tem ? `${fmt(pg.n)} de ${fmt(fA.contas)} contas · ${rs(pg.v)} recebidos (mesmo vencimento, qualquer mês)` : "—"),
      card("Ticket médio", `${fA.tem && fA.matriculas ? fmt(fA.valor / fA.matriculas, 2) : "—"} × ${aA && aA.clientes ? fmt(aA.valor / aA.clientes, 2) : "—"}`, "faturado por matrícula × arrecadado por pagante (R$)"),
    ].join("");
    // gráficos: últimos 14 meses até o mês escolhido
    const janela = meses.filter((m) => m <= M).slice(-14);
    const serieF = janela.map((m) => { const f = fatMes(m); return f.tem ? f.valor : null; });
    const serieA = janela.map((m) => { const a = arrMes(m); return a ? a.valor : null; });
    grafico("fxaG1", (W) => svgBarras(janela.map(C.rotuloMes), [[serieF, "b-fat"], [serieA, "b-at"]], curto, W, {
      titulo: (i) => linhaDica(C.rotuloMes(janela[i]), `Faturado (referência): ${rsOu(serieF[i])}`, `Arrecadado (crédito): ${rsOu(serieA[i])}`,
        serieF[i] != null && serieA[i] != null && `Arrecadado − faturado: ${rs(serieA[i] - serieF[i])}`,
        serieF[i] && serieA[i] != null && `Arrecadado ÷ faturado: ${pct(serieA[i] / serieF[i])}`, "Períodos diferentes — a diferença não é saldo devedor") }));
    const varS = (s) => s.map((v, i) => (i && v != null && s[i - 1] ? v / s[i - 1] - 1 : null));
    const vF = varS(serieF), vA = varS(serieA);
    grafico("fxaG2", (W) => svgLinhas(janela.map(C.rotuloMes), [[vF, "l-fat"], [vA, "l-at"]], (v) => pct(v), W, {
      dica: (i) => linhaDica(`${C.rotuloMes(janela[i])} contra ${C.rotuloMes(C.mesAnterior(janela[i]))}`,
        `Faturado: ${pctOu(vF[i])}`, serieF[i] != null && `Faturado (R$): ${rsOu(i ? serieF[i - 1] : null)} → ${rs(serieF[i])}`,
        `Arrecadado: ${pctOu(vA[i])}`, serieA[i] != null && `Arrecadado (R$): ${rsOu(i ? serieA[i - 1] : null)} → ${rs(serieA[i])}`) }));
    const serieMat = [[janela.map((m) => { const f = fatMes(m); return f.tem ? f.matriculas : null; }), "b-fat"],
      [janela.map((m) => { const a = arrMes(m); return a ? a.clientes : null; }), "b-at"]];
    grafico("fxaG3", (W) => svgBarras(janela.map(C.rotuloMes), serieMat, (v) => fmt(v / 1000, 1) + " mil", W, {
      titulo: (i) => { const f = serieMat[0][0][i], a = serieMat[1][0][i];
        return linhaDica(C.rotuloMes(janela[i]), `Matrículas faturadas: ${f == null ? "—" : fmt(f)}`, `Pagantes: ${a == null ? "—" : fmt(a)}`,
          f && a != null && `Pagantes ÷ faturadas: ${pct(a / f)}`, "Faturadas na referência × pagantes no mês de crédito"); } }));
    // tabelas por cidade e por subcategoria (mês escolhido)
    const porLinha = (rotFat, rotArr) => {
      const L = new Map(), cel = (k) => { let o = L.get(k); if (!o) { o = { nome: k, fat: 0, arr: 0, mf: 0, mp: 0 }; L.set(k, o); } return o; };
      for (const r of cz.fat) if (r.ref === M && okFat(cz.combos[r.c])) { const o = cel(rotFat(cz.combos[r.c])); o.fat += r.valor; o.mf += r.matriculas; }
      const mi = idxMes(M);
      if (mi >= 0) for (const [k, l] of C.porGrupo(d, [mi], mkArr, SEL_MES_TODO, rotArr)) { const c = l.get(mi); if (c) { const o = cel(k); o.arr += c.valor; o.mp += c.clientes; } }
      const totF = [...L.values()].reduce((x, o) => x + o.fat, 0);
      return [...L.values()].map((o) => ({ ...o, dif: o.fat - o.arr, part: totF ? o.fat / totF : 0 }));
    };
    fxaLinhas.fxaCid = porLinha((c) => c.cidade, (c) => c.cidade);
    fxaLinhas.fxaSub = porLinha((c) => c.grupo, (c) => grupoCruz(c.grupo));
    desenhaTabelaFxa("fxaCid", "Cidade");
    desenhaTabelaFxa("fxaSub", "Subcategoria");
    // conciliação pelo vencimento (todos os meses de crédito da janela; Interior inteiro)
    const TIPOS = ["Outros", "NF mensal", "NF avulsa", "Parcela"];
    const lin = cz.concil.filter((c) => janela.includes(c.mes) && refs.length && c.mes >= refs[0]).map((c) => {
      const tot = c.achou.reduce((x, v) => x + v, 0) + c.semConta.reduce((x, v) => x + v, 0);
      const nf = c.achou[1] + c.achou[2], nfTot = nf + c.semConta[1] + c.semConta[2];
      return `<tr>${td(C.rotuloMes(c.mes), "rot")}${td(fmt(tot))}${td(fmt(nf))}${td(nfTot ? pct(nf / nfTot) : "—")}${td(fmt(c.semConta[1] + c.semConta[2]))}${td(fmt(c.achou[3] + c.semConta[3]))}${td(fmt(c.achou[0] + c.semConta[0]))}</tr>`;
    });
    tabela("fxaConcil", ["Mês de crédito", "Arrecadado Interior (R$)", "NF mensal/avulsa que achou a conta", "% achou", "NF sem conta na fatura", "Parcelas (acordos)", "Outros tipos"], lin);
    $("fxaConcilNota").textContent = `Valores sem o desconto comercial e sem os filtros de cidade/subcategoria. NF de um mês de crédito só acha a conta se a fatura daquela referência estiver na pasta (${refs.length ? `${C.rotuloMes(refs[0])} a ${C.rotuloMes(refs[refs.length - 1])}` : "nenhuma"}); ${TIPOS[3].toLowerCase()}s de acordos têm vencimento próprio e não se ligam a uma conta.`;
  }
  $("fxaMes").addEventListener("change", (e) => { fxaMesEscolhido = e.target.value; desenha(); });
  const COLS_FXA = [["nome", null], ["fat", "Faturado (R$)"], ["arr", "Arrecadado (R$)"], ["dif", "Diferença (R$)"], ["part", "Part. no faturado"], ["mf", "Matrículas faturadas"], ["mp", "Matrículas pagantes"]];
  function desenhaTabelaFxa(id, titulo) {
    const [col, dir] = fxaOrdem[id], linhas = [...fxaLinhas[id]].sort((a, b) => (col === "nome" ? a.nome.localeCompare(b.nome, "pt-BR") : a[col] - b[col]) * dir);
    const tot = linhas.reduce((t, o) => ({ fat: t.fat + o.fat, arr: t.arr + o.arr, mf: t.mf + o.mf, mp: t.mp + o.mp }), { fat: 0, arr: 0, mf: 0, mp: 0 });
    $(id).innerHTML = `<thead><tr>${COLS_FXA.map(([k, t]) => `<th data-col="${k}" class="${k === col ? (dir > 0 ? "asc" : "desc") : ""}">${t || titulo}</th>`).join("")}</tr></thead><tbody>`
      + linhas.map((o) => `<tr>${td(esc(o.nome), "rot")}${td(fmt(o.fat))}${td(fmt(o.arr))}${tdNum(o.dif, fmt)}${td(pct(o.part))}${td(fmt(o.mf))}${td(fmt(o.mp))}</tr>`).join("")
      + `<tr class="total">${td("Total", "rot")}${td(fmt(tot.fat))}${td(fmt(tot.arr))}${tdNum(tot.fat - tot.arr, fmt)}${td(tot.fat ? "100,00%" : "")}${td(fmt(tot.mf))}${td(fmt(tot.mp))}</tr></tbody>`;
  }
  ["fxaCid", "fxaSub"].forEach((id) => $(id).addEventListener("click", (e) => {
    const th = e.target.closest("th[data-col]");
    if (!th) return;
    const [col, dir] = fxaOrdem[id];
    fxaOrdem[id] = [th.dataset.col, th.dataset.col === col ? -dir : th.dataset.col === "nome" ? 1 : -1];
    desenhaTabelaFxa(id, id === "fxaCid" ? "Cidade" : "Subcategoria");
  }));
  document.querySelectorAll("button[data-fxa-csv]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.fxaCsv, n = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(".", ",");
    const linhas = [[id === "fxaCid" ? "Cidade" : "Subcategoria", "Faturado", "Arrecadado", "Diferença", "Participação", "Matrículas faturadas", "Matrículas pagantes"].join(";"),
      ...(fxaLinhas[id] || []).map((o) => [o.nome, n(o.fat), n(o.arr), n(o.dif), n(o.part * 100), o.mf, o.mp].join(";"))];
    baixa("\ufeff" + linhas.join("\r\n"), `Faturamento_x_Arrecadacao_${id === "fxaCid" ? "cidades" : "subcategorias"}_${fxaMesEscolhido}.csv`);
  }));
  // ===== Fat. x Arrec. — mesmo vencimento: arrecadação do mês ligada às contas que ela pagou (referência de origem) =====
  let fxvSerieLinhas = [];
  let fxvMesEscolhido = "", fxvOrdem = { fxvCid: ["pago", -1], fxvSub: ["pago", -1] }, fxvLinhas = {};
  function desenhaFxv() {
    const cz = E.res.cruzamento && E.res.cruzamento.fat.length ? E.res.cruzamento : null, d = E.res.dados;
    $("fxvCorpo").hidden = !cz;
    if (!cz) {
      $("fxvNota").textContent = ""; $("fxvMes").innerHTML = "";
      $("fxvAviso").innerHTML = '<p class="aviso-pdf">Sem faturamento aproveitado na pasta: veja a aba Faturamento x Arrecadação para o motivo.</p>';
      return;
    }
    const meses = cz.concil.map((c) => c.mes);
    if (!meses.includes(fxvMesEscolhido)) fxvMesEscolhido = meses.includes(E.mes) ? E.mes : meses[meses.length - 1];
    const temPg = new Set(cz.pagas.map((r) => r.mes));
    $("fxvMes").innerHTML = [...meses].reverse().map((m) => `<option value="${m}"${m === fxvMesEscolhido ? " selected" : ""}>${C.rotuloMes(m)}${temPg.has(m) ? "" : " (sem contas ligadas)"}</option>`).join("");
    const M = fxvMesEscolhido, filtroG = gruposFat().join(" + "), ok = okFat;
    const avisos = [];
    if (!comInterior()) avisos.push(`O faturamento é só do Interior: o filtro Superintendência = ${supsTexto()} não se aplica aqui.`);
    $("fxvAviso").innerHTML = avisos.map((a) => `<p class="aviso-pdf">${esc(a)}</p>`).join("");
    const refs = [...new Set(cz.fat.map((r) => r.ref))].sort();
    $("fxvNota").textContent = `${["Interior", E.cidades.length > 2 ? `${E.cidades.length} cidades` : E.cidades.join(" + "), filtroG].filter(Boolean).join(" · ")} · faturas na pasta: ${C.rotuloMes(refs[0])} a ${C.rotuloMes(refs[refs.length - 1])}.`;
    const linhas = cz.pagas.filter((r) => r.mes === M && ok(cz.combos[r.c]));
    const soma = (l, k) => l.reduce((x, r) => x + r[k], 0);
    // mês a mês: arrecadado com conta identificada × faturado dessas mesmas contas; o total e o que ficou sem conta são do
    // Interior inteiro (a conciliação não tem cidade nem subcategoria), por isso só aparecem sem os filtros
    const semFiltro = !(E.cidades.length || E.grupos.length);
    fxvSerieLinhas = meses.filter((m) => temPg.has(m)).map((m) => {
      const l = cz.pagas.filter((r) => r.mes === m && ok(cz.combos[r.c])), c = cz.concil.find((x) => x.mes === m);
      const sem = c.semConta.reduce((x, v) => x + v, 0);
      return { mes: m, total: c.achou.reduce((x, v) => x + v, 0) + sem, pago: soma(l, "pago"), faturado: soma(l, "faturado"), contas: soma(l, "contas"),
        semNF: c.semConta[0] + c.semConta[1] + c.semConta[2], parc: c.semConta[3] };
    });
    const S = fxvSerieLinhas;
    $("fxvNotaSerie").textContent = `${["Interior", E.cidades.length > 2 ? `${E.cidades.length} cidades` : E.cidades.join(" + "), filtroG].filter(Boolean).join(" · ")} · ${S.length ? `${C.rotuloMes(S[0].mes)} a ${C.rotuloMes(S[S.length - 1].mes)}` : ""}`
      + " · arrecadado sem o desconto comercial (o desconto não é por conta). Conta paga em parcelas em meses diferentes entra em cada mês com o faturado inteiro.";
    grafico("fxvSerie", S.length && ((W) => barras({ cats: S.map((x) => C.rotuloMes(x.mes)), series: [[S.map((x) => x.faturado), "b-fat"], [S.map((x) => x.pago), "b-at"]], rotulo: curto,
      titulo: (i) => { const x = S[i];
        return linhaDica(`${C.rotuloMes(x.mes)} (mês da arrecadação)`, `Arrecadado com conta identificada: ${rs(x.pago)}`, `Faturado dessas contas: ${rs(x.faturado)}`,
          `Arrecadado − faturado: ${rs(x.pago - x.faturado)}${x.faturado ? ` (${pct(x.pago / x.faturado - 1)})` : ""}`, `Contas pagas: ${fmt(x.contas)}`,
          semFiltro && `Arrecadado no Interior: ${rs(x.total)}`, semFiltro && x.total && `Identificado: ${pct(x.pago / x.total)}`,
          semFiltro && `Sem conta (NF/fatura · parcelas): ${rs(x.semNF)} · ${rs(x.parc)}`, "Clique na tabela abaixo para ver o detalhe do mês"); } }, W)),
      '<p class="nota">Nenhum pagamento ligado a conta da fatura.</p>');
    const tdS = (v, f = fmt) => (semFiltro ? td(f(v)) : "");
    const linS = S.map((x) => `<tr data-mes="${x.mes}"${x.mes === M ? ' class="sel"' : ""}>${td(C.rotuloMes(x.mes), "rot")}${tdS(x.total)}${td(fmt(x.pago))}`
      + `${semFiltro ? td(x.total ? pct(x.pago / x.total) : "") : ""}${td(fmt(x.faturado))}${tdNum(x.pago - x.faturado, fmt)}${td(x.faturado ? pct(x.pago / x.faturado - 1) : "")}`
      + `${td(fmt(x.contas))}${tdS(x.semNF)}${tdS(x.parc)}</tr>`);
    const tS = S.reduce((a, x) => ({ total: a.total + x.total, pago: a.pago + x.pago, faturado: a.faturado + x.faturado, contas: a.contas + x.contas, semNF: a.semNF + x.semNF, parc: a.parc + x.parc }),
      { total: 0, pago: 0, faturado: 0, contas: 0, semNF: 0, parc: 0 });
    linS.push(`<tr class="total">${td("Total", "rot")}${tdS(tS.total)}${td(fmt(tS.pago))}${semFiltro ? td(tS.total ? pct(tS.pago / tS.total) : "") : ""}${td(fmt(tS.faturado))}`
      + `${tdNum(tS.pago - tS.faturado, fmt)}${td(tS.faturado ? pct(tS.pago / tS.faturado - 1) : "")}${td(fmt(tS.contas))}${tdS(tS.semNF)}${tdS(tS.parc)}</tr>`);
    tabela("fxvMeses", ["Mês da arrecadação", ...(semFiltro ? ["Arrecadado no Interior (R$)"] : []), "Com conta identificada (R$)", ...(semFiltro ? ["% identificado"] : []),
      "Faturado dessas contas (R$)", "Arrecadado − faturado (R$)", "Arrecadado ÷ faturado − 1", "Contas", ...(semFiltro ? ["Sem conta: NF/fatura (R$)", "Sem conta: parcelas (R$)"] : [])], linS);
    const pago = soma(linhas, "pago"), faturado = soma(linhas, "faturado"), contas = soma(linhas, "contas");
    const cc = cz.concil.find((c) => c.mes === M) || { achou: [0, 0, 0, 0], semConta: [0, 0, 0, 0] };
    const semNF = cc.semConta[1] + cc.semConta[2], parc = cc.semConta[3], outros = cc.semConta[0];   // o que achou conta já está em pago
    const total = cc.achou.reduce((x, v) => x + v, 0) + cc.semConta.reduce((x, v) => x + v, 0);
    const porRef = new Map();
    for (const r of linhas) { const o = porRef.get(r.ref) || { ref: r.ref, pago: 0, faturado: 0, contas: 0, matriculas: 0 }; o.pago += r.pago; o.faturado += r.faturado; o.contas += r.contas; o.matriculas += r.matriculas; porRef.set(r.ref, o); }
    const refsOrdem = [...porRef.values()].sort((a, b) => b.ref.localeCompare(a.ref));
    const mesmaRef = porRef.get(M), anterior = porRef.get(C.mesAnterior(M));
    const filtrado = !!(E.cidades.length || E.grupos.length);
    const card = (t, v, sub) => `<div class="kpi"><span>${t}</span><b>${v}</b><small>${sub}</small></div>`;
    $("fxvKpis").innerHTML = [
      card(`Arrecadado em ${C.rotuloMes(M)} com conta identificada`, milhoes(pago), filtrado ? "nos filtros de cidade/subcategoria" : `${total ? pct(pago / total) : "—"} do arrecadado no Interior (${rs(total)}, sem desconto)`),
      card("Faturado dessas contas", milhoes(faturado), `${fmt(contas)} contas · ${fmt(soma(linhas, "matriculas"))} matrículas`),
      card("Arrecadado − faturado", milhoes(pago - faturado), faturado ? `${pct(pago / faturado - 1)} · acima = juros/multas pagos junto; abaixo = pagamento parcial` : "—"),
      card("Referências de origem", fmt(porRef.size), refsOrdem.length ? `${C.rotuloMes(refsOrdem[refsOrdem.length - 1].ref)} a ${C.rotuloMes(refsOrdem[0].ref)}` : "—"),
      card("Da referência do próprio mês / anterior", `${pago ? pct((mesmaRef ? mesmaRef.pago : 0) / pago) : "—"} / ${pago ? pct((anterior ? anterior.pago : 0) / pago) : "—"}`, `${C.rotuloMes(M)} / ${C.rotuloMes(C.mesAnterior(M))}, do arrecadado com conta identificada`),
      card("Sem conta identificada", milhoes(semNF + parc + outros), `NF sem fatura correspondente ${rs(semNF)} · parcelas de acordos ${rs(parc)}${outros ? ` · outros ${rs(outros)}` : ""} (Interior, sem filtros)`),
    ].join("");
    // gráfico por referência de origem (da mais antiga para a mais nova; até 14 referências)
    const g = [...refsOrdem].reverse().slice(-14);
    grafico("fxvG1", g.length && ((W) => svgBarras(g.map((o) => C.rotuloMes(o.ref)), [[g.map((o) => o.faturado), "b-fat"], [g.map((o) => o.pago), "b-at"]], curto, W, {
      titulo: (i) => { const o = g[i];
        return linhaDica(`Referência ${C.rotuloMes(o.ref)}`, `Arrecadado em ${C.rotuloMes(M)}: ${rs(o.pago)}`, `Faturado dessas contas: ${rs(o.faturado)}`,
          `Arrecadado − faturado: ${rs(o.pago - o.faturado)}`, `Contas: ${fmt(o.contas)}`, `Matrículas: ${fmt(o.matriculas)}`, pago && `Parte do arrecadado do mês: ${pct(o.pago / pago)}`); } })),
      '<p class="nota">Nenhum pagamento ligado a conta neste mês.</p>');
    // tabela por referência
    fxvLinhas.fxvRef = refsOrdem;
    const linRef = refsOrdem.map((o) => `<tr>${td(C.rotuloMes(o.ref), "rot")}${td(fmt(o.contas))}${td(fmt(o.matriculas))}${td(fmt(o.faturado))}${td(fmt(o.pago))}${tdNum(o.pago - o.faturado, fmt)}${td(pago ? pct(o.pago / pago) : "")}</tr>`);
    linRef.push(`<tr class="total">${td("Total com conta identificada", "rot")}${td(fmt(contas))}${td(fmt(soma(linhas, "matriculas")))}${td(fmt(faturado))}${td(fmt(pago))}${tdNum(pago - faturado, fmt)}${td(pago ? "100,00%" : "")}</tr>`);
    if (!filtrado) {
      linRef.push(`<tr class="desc">${td("NF sem fatura correspondente na pasta", "rot")}${td("")}${td("")}${td("")}${td(fmt(semNF))}${td("")}${td("")}</tr>`);
      linRef.push(`<tr class="desc">${td("Parcelas de acordos (sem conta da fatura)", "rot")}${td("")}${td("")}${td("")}${td(fmt(parc))}${td("")}${td("")}</tr>`);
      if (outros) linRef.push(`<tr class="desc">${td("Outros tipos", "rot")}${td("")}${td("")}${td("")}${td(fmt(outros))}${td("")}${td("")}</tr>`);
      linRef.push(`<tr class="total">${td("Arrecadado no Interior (sem desconto)", "rot")}${td("")}${td("")}${td("")}${td(fmt(total))}${td("")}${td("")}</tr>`);
    }
    tabela("fxvRef", ["Referência da conta", "Contas", "Matrículas", "Faturado (R$)", `Arrecadado em ${C.rotuloMes(M)} (R$)`, "Arrecadado − faturado", "Part. no arrecadado"], linRef);
    // por cidade e subcategoria
    const agrupa = (rot) => {
      const L = new Map();
      for (const r of linhas) { const k = rot(cz.combos[r.c]); const o = L.get(k) || { nome: k, pago: 0, faturado: 0, contas: 0, matriculas: 0 }; o.pago += r.pago; o.faturado += r.faturado; o.contas += r.contas; o.matriculas += r.matriculas; L.set(k, o); }
      return [...L.values()].map((o) => ({ ...o, dif: o.pago - o.faturado, part: pago ? o.pago / pago : 0 }));
    };
    fxvLinhas.fxvCid = agrupa((c) => c.cidade);
    fxvLinhas.fxvSub = agrupa((c) => c.grupo);
    desenhaTabelaFxv("fxvCid", "Cidade");
    desenhaTabelaFxv("fxvSub", "Subcategoria");
  }
  $("fxvMes").addEventListener("change", (e) => { fxvMesEscolhido = e.target.value; desenha(); });
  $("fxvMeses").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-mes]");
    if (!tr) return;
    fxvMesEscolhido = tr.dataset.mes;
    desenha();
    $("fxvMes").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("fxvMesesCsv").addEventListener("click", () => {
    const n = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(".", ",");
    const linhas = [["Mês da arrecadação", "Arrecadado no Interior", "Com conta identificada", "Faturado dessas contas", "Arrecadado - faturado", "Contas", "Sem conta: NF/fatura", "Sem conta: parcelas"].join(";"),
      ...fxvSerieLinhas.map((x) => [C.rotuloMes(x.mes), n(x.total), n(x.pago), n(x.faturado), n(x.pago - x.faturado), x.contas, n(x.semNF), n(x.parc)].join(";"))];
    baixa("\ufeff" + linhas.join("\r\n"), "Mesmo_vencimento_mes_a_mes.csv");
  });
  const COLS_FXV = [["nome", null], ["contas", "Contas"], ["matriculas", "Matrículas"], ["faturado", "Faturado (R$)"], ["pago", "Arrecadado (R$)"], ["dif", "Arrecadado − faturado"], ["part", "Part. no arrecadado"]];
  function desenhaTabelaFxv(id, titulo) {
    const [col, dir] = fxvOrdem[id], linhas = [...fxvLinhas[id]].sort((a, b) => (col === "nome" ? a.nome.localeCompare(b.nome, "pt-BR") : a[col] - b[col]) * dir);
    const t = linhas.reduce((x, o) => ({ contas: x.contas + o.contas, matriculas: x.matriculas + o.matriculas, faturado: x.faturado + o.faturado, pago: x.pago + o.pago }), { contas: 0, matriculas: 0, faturado: 0, pago: 0 });
    $(id).innerHTML = `<thead><tr>${COLS_FXV.map(([k, tt]) => `<th data-col="${k}" class="${k === col ? (dir > 0 ? "asc" : "desc") : ""}">${tt || titulo}</th>`).join("")}</tr></thead><tbody>`
      + linhas.map((o) => `<tr>${td(esc(o.nome), "rot")}${td(fmt(o.contas))}${td(fmt(o.matriculas))}${td(fmt(o.faturado))}${td(fmt(o.pago))}${tdNum(o.dif, fmt)}${td(pct(o.part))}</tr>`).join("")
      + `<tr class="total">${td("Total", "rot")}${td(fmt(t.contas))}${td(fmt(t.matriculas))}${td(fmt(t.faturado))}${td(fmt(t.pago))}${tdNum(t.pago - t.faturado, fmt)}${td(t.pago ? "100,00%" : "")}</tr></tbody>`;
  }
  ["fxvCid", "fxvSub"].forEach((id) => $(id).addEventListener("click", (e) => {
    const th = e.target.closest("th[data-col]");
    if (!th) return;
    const [col, dir] = fxvOrdem[id];
    fxvOrdem[id] = [th.dataset.col, th.dataset.col === col ? -dir : th.dataset.col === "nome" ? 1 : -1];
    desenhaTabelaFxv(id, id === "fxvCid" ? "Cidade" : "Subcategoria");
  }));
  document.querySelectorAll("button[data-fxv-csv]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.fxvCsv, n = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(".", ",");
    const cab = [id === "fxvRef" ? "Referência" : id === "fxvCid" ? "Cidade" : "Subcategoria", "Contas", "Matrículas", "Faturado", "Arrecadado", "Arrecadado - faturado"];
    const linhas = [cab.join(";"), ...(fxvLinhas[id] || []).map((o) => [o.ref ? C.rotuloMes(o.ref) : o.nome, o.contas, o.matriculas, n(o.faturado), n(o.pago), n(o.pago - o.faturado)].join(";"))];
    baixa("\ufeff" + linhas.join("\r\n"), `Mesmo_vencimento_${id.slice(3).toLowerCase()}_${fxvMesEscolhido}.csv`);
  }));
  // ----- Conversão por referência (matriz por coorte) -----
  let cvRefEscolhida = "", cvOrdem = ["faturado", -1], cvCidLinhas = [], cvMz = null;
  const rotOff = (k, mz) => (k === 12 && mz.maxOff === 12 ? "M+12 em diante" : k ? `M+${k}` : "M");
  function desenhaConversao() {
    const cz = E.res.cruzamento && E.res.cruzamento.fat.length ? E.res.cruzamento : null;
    $("cvCorpo").hidden = !cz;
    if (!cz) {
      $("cvNota").textContent = "";
      $("cvAviso").innerHTML = '<p class="aviso-pdf">Sem faturamento aproveitado na pasta: veja a aba Faturamento x Arrecadação para o motivo.</p>';
      return;
    }
    const filtroG = gruposFat().join(" + "), ok = okFat;
    $("cvAviso").innerHTML = !comInterior()
      ? `<p class="aviso-pdf">${esc(`O faturamento é só do Interior: o filtro Superintendência = ${supsTexto()} não se aplica aqui.`)}</p>` : "";
    const meses = cz.concil.map((c) => c.mes), mz = C.matrizConversao(cz, ok, meses);
    cvMz = mz;
    $("cvCorpo").hidden = !mz.linhas.length;
    if (!mz.linhas.length) { $("cvNota").textContent = ""; $("cvAviso").innerHTML += '<p class="aviso-pdf">Nenhuma conta faturada nos filtros escolhidos.</p>'; return; }
    const porValor = $("cvMedida").value === "valor", acum = $("cvModo").value === "acum";
    const base = (l) => (porValor ? l.faturado : l.contas), med = (c) => (porValor ? c.valor : c.contas);
    $("cvNota").textContent = `${["Interior", E.cidades.length > 2 ? `${E.cidades.length} cidades` : E.cidades.join(" + "), filtroG].filter(Boolean).join(" · ")} · faturas ${C.rotuloMes(mz.linhas[0].ref)} a ${C.rotuloMes(mz.linhas[mz.linhas.length - 1].ref)}`
      + ` · arrecadação ${C.rotuloMes(meses[0])} a ${C.rotuloMes(mz.ultimo)} (crédito até ${dataBR(E.res.dados.ultimoCredito[mz.ultimo])}).`;
    $("cvLegenda").textContent = `${porValor ? "Valor recebido ÷ faturado da referência" : "Contas pagas pela 1ª vez ÷ contas faturadas"}, ${acum ? "acumulado até o mês" : "em cada mês"}. M = mês da referência.`;
    // matriz
    const ks = Array.from({ length: mz.maxOff + 1 }, (_, k) => k);
    let maxMes = 0.0001;
    if (!acum) for (const l of mz.linhas) for (const c of [l.antes, ...l.cel]) if (c && base(l) > 0) maxMes = Math.max(maxMes, med(c) / base(l));
    const cor = (r) => `background:rgba(47,111,235,${(Math.max(0, Math.min(1, acum ? r : r / maxMes)) * 0.42).toFixed(3)})`;
    if (!mz.linhas.some((l) => l.ref === cvRefEscolhida)) cvRefEscolhida = mz.linhas[mz.linhas.length - 1].ref;
    const corpo = mz.linhas.map((l) => {
      const b = base(l);
      let soma = med(l.antes);
      const celulas = ks.map((k) => {
        const c = l.cel[k];
        if (!c) return td("");
        soma += med(c);
        const r = b ? (acum ? soma : med(c)) / b : 0, parcial = C.mesAnterior(l.ref, -k) === mz.ultimo && !c.junta;
        return `<td class="cel${parcial ? " parcial" : ""}" style="${cor(r)}" title="${C.rotuloMes(l.ref)} · ${rotOff(k, mz)}: ${porValor ? rs(c.valor) : fmt(c.contas) + " contas"} no mês">${pct(r)}</td>`;
      });
      const antes = med(l.antes), total = porValor ? l.recebido : l.contasPagas;
      return `<tr data-ref="${l.ref}"${l.ref === cvRefEscolhida ? ' class="sel"' : ""}>${td(C.rotuloMes(l.ref) + (l.desdeInicio ? "" : " *"), "rot")}${td(fmt(l.contas))}${td(fmt(l.faturado))}`
        + `${td(antes && b ? pct(antes / b) : "")}${celulas.join("")}${td(b ? pct(total / b) : "—", "tot")}`
        + `${td(porValor ? fmt(l.semPagamento) : fmt(l.contas - l.contasPagas))}</tr>`;
    });
    tabela("cvMatriz", ["Referência", "Contas", "Faturado (R$)", "Antes de M", ...ks.map((k) => rotOff(k, mz)), "Total", porValor ? "Faturado sem pagamento (R$)" : "Contas sem pagamento"], corpo);
    $("cvLegenda").textContent += mz.linhas.some((l) => !l.desdeInicio) ? ` * Referência anterior ao primeiro mês de arrecadação da pasta (${C.rotuloMes(meses[0])}): faltam os pagamentos dos meses anteriores.` : "";
    desenhaDetalheCv(ok, meses);
  }
  function desenhaDetalheCv(ok, meses) {
    const mz = cvMz, porValor = $("cvMedida").value === "valor";
    $("cvRef").innerHTML = [...mz.linhas].reverse().map((l) => `<option value="${l.ref}"${l.ref === cvRefEscolhida ? " selected" : ""}>${C.rotuloMes(l.ref)}</option>`).join("");
    const l = mz.linhas.find((x) => x.ref === cvRefEscolhida), R = cvRefEscolhida;
    const base = (x) => (porValor ? x.faturado : x.contas), med = (c) => (porValor ? c.valor : c.contas);
    // acumulado por k (antes de M entra no M); null onde o mês ainda não tem arrecadação
    const curva = (x) => { let s = med(x.antes); return x.cel.map((c) => (c ? (s += med(c)) / (base(x) || 1) : null)); };
    const parcialEm = (x, k) => C.mesAnterior(x.ref, -k) === mz.ultimo && !(x.cel[k] && x.cel[k].junta);
    const ultK = l.cel.length - 1, cm = l.cel, mesM = cm[0] ? cm[0].valor : 0, mes1 = cm[1] ? cm[1].valor : 0;
    const anteriores = mz.linhas.filter((x) => x.ref < R && x.desdeInicio);
    const media = Array.from({ length: Math.max(ultK + 1, mz.maxOff + 1) }, (_, k) => {
      const vs = anteriores.filter((x) => x.cel[k] && !parcialEm(x, k)).map((x) => curva(x)[k]);
      return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
    });
    const minha = curva(l), kComp = ultK >= 0 && parcialEm(l, ultK) ? ultK - 1 : ultK;
    const comp = kComp >= 0 && media[kComp] != null && minha[kComp] != null ? minha[kComp] - media[kComp] : null;
    const card = (t, v, sub) => `<div class="kpi"><span>${t}</span><b>${v}</b><small>${sub}</small></div>`;
    $("cvKpis").innerHTML = [
      card(`Faturado da ref. ${C.rotuloMes(R)}`, milhoes(l.faturado), `${fmt(l.contas)} contas · ${fmt(l.matriculas)} matrículas`),
      card("Recebido até agora", milhoes(l.recebido), `${pct(l.recebido / l.faturado)} do faturado${mz.ultimo ? ` · até ${C.rotuloMes(mz.ultimo)}` : ""}`),
      card("Contas pagas", pct(l.contasPagas / l.contas), `${fmt(l.contasPagas)} de ${fmt(l.contas)} contas receberam pagamento`),
      card("Recebido em M / M+1", `${pct(mesM / l.faturado)} / ${cm[1] ? pct(mes1 / l.faturado) : "—"}`, `${C.rotuloMes(R)} / ${C.rotuloMes(C.mesAnterior(R, -1))}${cm[1] ? "" : " (ainda sem arrecadação)"}`),
      card("Faturado ainda sem pagamento", milhoes(l.semPagamento), `${fmt(l.contas - l.contasPagas)} contas · ${pct(l.semPagamento / l.faturado)} do faturado · a investigar`),
      card(`Comparação em ${kComp >= 0 ? rotOff(kComp, mz) : "M"}`, comp == null ? "—" : `${comp >= 0 ? "+" : ""}${fmt(comp * 100, 2)} p.p.`,
        comp == null ? "sem referências anteriores para comparar" : `${pct(minha[kComp])} × média de ${pct(media[kComp])} das referências anteriores (${porValor ? "valor" : "contas"}, acumulado)`),
    ].join("");
    const n = Math.max(ultK + 1, ...media.map((v, k) => (v != null ? k + 1 : 0)));
    const cats = Array.from({ length: n }, (_, k) => rotOff(k, mz));
    $("cvNotaG").textContent = `${porValor ? "Valor recebido ÷ faturado" : "Contas pagas ÷ contas faturadas"}, acumulado do mês da referência em diante. A média usa só referências anteriores com o mês completo.`;
    const serieCv = [[minha.slice(0, n).concat(Array(Math.max(0, n - minha.length)).fill(null)), "l-at"], [media.slice(0, n), "l-fat"]];
    grafico("cvG1", n && ((W) => svgLinhas(cats, serieCv, (v) => fmt(v * 100, 1) + "%", W, {
      dica: (k) => linhaDica(`${rotOff(k, mz)} (crédito em ${C.rotuloMes(C.mesAnterior(R, -k))})`, `Ref. ${C.rotuloMes(R)}: ${pctOu(serieCv[0][0][k])}`,
        `Média das anteriores: ${pctOu(serieCv[1][0][k])}`,
        serieCv[0][0][k] != null && serieCv[1][0][k] != null && `Diferença: ${fmt((serieCv[0][0][k] - serieCv[1][0][k]) * 100, 2)} p.p.`,
        `${porValor ? "Valor recebido ÷ faturado" : "Contas pagas ÷ contas faturadas"}, acumulado`) })));
    // por cidade
    const cidades = [...new Set(cz_combos().filter(ok).map((c) => c.cidade))];
    cvCidLinhas = cidades.map((cid) => {
      const m = C.matrizConversao(E.res.cruzamento, (c) => ok(c) && c.cidade === cid, meses).linhas.find((x) => x.ref === R);
      if (!m) return null;
      const ac = (k) => { let s = m.antes.valor; for (let i = 0; i <= k; i++) if (m.cel[i]) s += m.cel[i].valor; else return null; return m.faturado ? s / m.faturado : 0; };
      return { nome: cid, contas: m.contas, faturado: m.faturado, m0: ac(0), m1: ac(1), m2: ac(2), recebido: m.recebido, conv: m.faturado ? m.recebido / m.faturado : 0,
        pagas: m.contas ? m.contasPagas / m.contas : 0, sem: m.semPagamento };
    }).filter(Boolean);
    desenhaCidCv();
  }
  const cz_combos = () => E.res.cruzamento.combos;
  const COLS_CV = [["nome", "Cidade"], ["contas", "Contas"], ["faturado", "Faturado (R$)"], ["m0", "Até M"], ["m1", "Até M+1"], ["m2", "Até M+2"],
    ["recebido", "Recebido (R$)"], ["conv", "Conversão"], ["pagas", "Contas pagas"], ["sem", "Faturado sem pagamento (R$)"]];
  function desenhaCidCv() {
    const [col, dir] = cvOrdem, L = [...cvCidLinhas].sort((a, b) => (col === "nome" ? a.nome.localeCompare(b.nome, "pt-BR") : (a[col] ?? -1) - (b[col] ?? -1)) * dir);
    const t = L.reduce((x, o) => ({ contas: x.contas + o.contas, faturado: x.faturado + o.faturado, recebido: x.recebido + o.recebido, sem: x.sem + o.sem }), { contas: 0, faturado: 0, recebido: 0, sem: 0 });
    const l = cvMz.linhas.find((x) => x.ref === cvRefEscolhida), acT = (k) => { let s = l.antes.valor; for (let i = 0; i <= k; i++) if (l.cel[i]) s += l.cel[i].valor; else return null; return s / l.faturado; };
    const p = (v) => (v == null ? "" : pct(v));
    $("cvCid").innerHTML = `<thead><tr>${COLS_CV.map(([k, tt]) => `<th data-col="${k}" class="${k === col ? (dir > 0 ? "asc" : "desc") : ""}">${tt}</th>`).join("")}</tr></thead><tbody>`
      + L.map((o) => `<tr>${td(esc(o.nome), "rot")}${td(fmt(o.contas))}${td(fmt(o.faturado))}${td(p(o.m0))}${td(p(o.m1))}${td(p(o.m2))}${td(fmt(o.recebido))}${td(pct(o.conv))}${td(pct(o.pagas))}${td(fmt(o.sem))}</tr>`).join("")
      + `<tr class="total">${td("Total", "rot")}${td(fmt(t.contas))}${td(fmt(t.faturado))}${td(p(acT(0)))}${td(p(acT(1)))}${td(p(acT(2)))}${td(fmt(t.recebido))}`
      + `${td(t.faturado ? pct(t.recebido / t.faturado) : "—")}${td(pct(l.contasPagas / l.contas))}${td(fmt(t.sem))}</tr></tbody>`;
  }
  ["cvMedida", "cvModo"].forEach((id) => $(id).addEventListener("change", () => desenha()));
  $("cvRef").addEventListener("change", (e) => { cvRefEscolhida = e.target.value; desenha(); });
  $("cvMatriz").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-ref]");
    if (!tr) return;
    cvRefEscolhida = tr.dataset.ref;
    desenha();
    $("cvRef").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("cvCid").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-col]");
    if (!th) return;
    cvOrdem = [th.dataset.col, th.dataset.col === cvOrdem[0] ? -cvOrdem[1] : th.dataset.col === "nome" ? 1 : -1];
    desenhaCidCv();
  });
  const nCsv = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(".", ",");
  $("cvCsv").addEventListener("click", () => {
    const mz = cvMz, ks = Array.from({ length: mz.maxOff + 1 }, (_, k) => k), porValor = $("cvMedida").value === "valor";
    const med = (c) => (c ? (porValor ? nCsv(c.valor) : c.contas) : "");
    const cab = ["Referência", "Contas faturadas", "Faturado", "Antes de M", ...ks.map((k) => rotOff(k, mz)), porValor ? "Recebido total" : "Contas pagas", porValor ? "Faturado sem pagamento" : "Contas sem pagamento"];
    const linhas = [`${porValor ? "Valor recebido (R$)" : "Contas pagas pela 1ª vez"} em cada mês`, cab.join(";"),
      ...mz.linhas.map((l) => [C.rotuloMes(l.ref), l.contas, nCsv(l.faturado), med(l.antes), ...ks.map((k) => med(l.cel[k])),
        porValor ? nCsv(l.recebido) : l.contasPagas, porValor ? nCsv(l.semPagamento) : l.contas - l.contasPagas].join(";"))];
    baixa("﻿" + linhas.join("\r\n"), `Conversao_por_referencia_${porValor ? "valor" : "contas"}.csv`);
  });
  $("cvCidCsv").addEventListener("click", () => {
    const p = (v) => (v == null ? "" : nCsv(v * 100));
    const linhas = [["Cidade", "Contas", "Faturado", "Até M (%)", "Até M+1 (%)", "Até M+2 (%)", "Recebido", "Conversão (%)", "Contas pagas (%)", "Faturado sem pagamento"].join(";"),
      ...cvCidLinhas.map((o) => [o.nome, o.contas, nCsv(o.faturado), p(o.m0), p(o.m1), p(o.m2), nCsv(o.recebido), p(o.conv), p(o.pagas), nCsv(o.sem)].join(";"))];
    baixa("﻿" + linhas.join("\r\n"), `Conversao_cidades_ref_${cvRefEscolhida}.csv`);
  });
  // ----- Clientes e oportunidades (as listas são montadas no worker) -----
  let idCl = 0, chaveCl = "", clRes = null, idMat = 0, clOrdem = ["valor", -1];
  const numData = (n) => `${String(n % 100).padStart(2, "0")}/${String(Math.floor(n / 100) % 100).padStart(2, "0")}/${Math.floor(n / 10000)}`;
  const refRot = (n) => C.rotuloMes(`${Math.floor(n / 100)}-${String(n % 100).padStart(2, "0")}`);
  const isoNum = (iso) => +iso.replace(/-/g, "");
  function desenhaClientes() {
    const d = E.res.dados, cz = E.res.cruzamento && E.res.cruzamento.fat.length ? E.res.cruzamento : null, mi = idxMes(E.mes);
    const ultimoMes = d.meses[d.meses.length - 1], hojeIso = d.ultimoCredito[ultimoMes], dias = +$("clCorte").value;
    const corteD = new Date(hojeIso + "T12:00:00Z");
    corteD.setUTCDate(corteD.getUTCDate() - dias);
    const corteIso = corteD.toISOString().slice(0, 10), okFatCl = (c) => comInterior() && okFat(c);
    $("clNota").textContent = `${filtroTexto()} · faturado sem pagamento: contas vencidas até ${dataBR(corteIso)}`
      + ` (último crédito da pasta: ${dataBR(hojeIso)}) · deixaram/voltaram: ${C.rotuloMes(E.mes)}, dias úteis ${rotuloDias()}, contra os 3 meses anteriores.`;
    const avisos = [];
    if (!cz) avisos.push("Sem faturamento aproveitado na pasta: só as listas de deixaram e voltaram a pagar e a arrecadação da matrícula.");
    else if (!comInterior()) avisos.push(`O faturamento é só do Interior: com Superintendência = ${supsTexto()}, o faturado sem pagamento fica vazio.`);
    $("clAviso").innerHTML = avisos.map((a) => `<p class="aviso-pdf">${esc(a)}</p>`).join("");
    const chave = JSON.stringify([E.mes, selCalc(), E.sups, E.cidades, E.grupos, dias, E.recTipo]);
    if (chave === chaveCl && clRes) { desenhaListasCl(); return; }
    chaveCl = chave; clRes = null;
    $("clKpis").innerHTML = '<p class="nota">Calculando…</p>';
    ["clFaixas", "clRefs", "clCid", "clSem", "clDeixaram", "clVoltaram"].forEach((id) => { $(id).innerHTML = ""; });
    worker.postMessage({ tipo: "clientes", id: ++idCl, mi, marcas: marcas(), sel: selCalc(), aceitaFat: cz ? cz.combos.map((c) => (okFatCl(c) ? 1 : 0)) : [],
      hoje: isoNum(hojeIso), corte: isoNum(corteIso), inicio: isoNum(d.meses[0] + "-01"), meses: d.meses, filtroRec: { sups: E.sups, cidades: E.cidades, gruposFat: gruposFat() }, recTipo: E.recTipo });
  }
  function recebeClientes(m) {
    if (m.id !== idCl) return;
    if (m.erro) { $("clKpis").innerHTML = `<p class="nota">Não foi possível montar as listas: ${esc(m.erro)}</p>`; return; }
    clRes = m;
    if (E.aba === "clientes") desenhaListasCl();
  }
  const comboArr = (c) => E.res.dados.combos[c] || { cidade: "", grupo: "" };
  const comboFat = (c) => (E.res.cruzamento && E.res.cruzamento.combos[c]) || { cidade: "", grupo: "" };
  const tdLig = (l) => `<td class="rot"><a href="#" class="lig" data-lig="${esc(l)}">${esc(l)}</a></td>`;
  function desenhaListasCl() {
    const r = clRes, sp = r.semPagamento, d = E.res.dados;
    const somaD = r.deixaram.reduce((a, x) => a + x.media, 0), somaV = r.voltaram.reduce((a, x) => a + x.valor, 0);
    const porCid = new Map();
    for (const pc of sp.porCombo) {
      const c = comboFat(pc.c).cidade, o = porCid.get(c) || { nome: c, matriculas: 0, contas: 0, valor: 0 };
      o.matriculas += pc.matriculas; o.contas += pc.contas; o.valor += pc.valor; porCid.set(c, o);
    }
    const cids = [...porCid.values()].sort((a, b) => b.valor - a.valor);
    const card = (t, v, sub) => `<div class="kpi"><span>${t}</span><b>${v}</b><small>${sub}</small></div>`;
    $("clKpis").innerHTML = [
      card("Faturado sem pagamento (a investigar)", r.temFatura ? milhoes(sp.valor) : "—", r.temFatura ? `${fmt(sp.contas)} contas · ${fmt(sp.matriculas)} matrículas` : "sem faturamento na pasta"),
      card("Sem nenhum pagamento na pasta", r.temFatura ? fmt(sp.semNenhum) : "—", r.temFatura ? `matrículas · ${rs(sp.valorSemNenhum)} faturados sem pagamento` : "—"),
      card("Pagam, mas têm conta sem pagamento", r.temFatura ? fmt(sp.matriculas - sp.semNenhum) : "—", r.temFatura ? `matrículas · ${rs(sp.valor - sp.valorSemNenhum)} · verificar vencimento ou acordo` : "—"),
      card("Deixaram de pagar", r.temHist ? fmt(r.deixaram.length) : "—", r.temHist ? `matrículas · ${rs(somaD)} por mês, em média, nos dias marcados` : "faltam os 3 meses anteriores na pasta"),
      card("Voltaram a pagar", r.temHist ? fmt(r.voltaram.length) : "—", r.temHist ? `matrículas · ${rs(somaV)} no mês` : "faltam os 3 meses anteriores na pasta"),
      sp.confirmacao
        ? card("Confirmados na base de contas a receber", fmt(sp.confirmacao.confirmadas), `de ${fmt(sp.matriculas)} matrículas com faturado sem pagamento · saldo vencido ${rs(sp.confirmacao.saldo)}`
          + ` · ${fmt(sp.confirmacao.fora)} fora da base (${rs(sp.confirmacao.valorFora)}): provável pagamento por acordo ou outro vencimento`)
        : card("Maior faturado sem pagamento", cids.length ? esc(cids[0].nome) : "—", cids.length ? `${rs(cids[0].valor)} · ${pct(cids[0].valor / sp.valor)} do total` : "—"),
    ].join("");
    // faixas, referências e cidades
    const linTotal = `<tr class="total">${td("Total", "rot")}${td(fmt(sp.contas))}${td(fmt(sp.valor))}${td(sp.valor ? "100,00%" : "")}</tr>`;
    tabela("clFaixas", ["Vencida há", "Contas", "Valor (R$)", "% do valor"],
      sp.faixas.map((f) => `<tr>${td(f.rot, "rot")}${td(fmt(f.contas))}${td(fmt(f.valor))}${td(sp.valor ? pct(f.valor / sp.valor) : "")}</tr>`).concat(linTotal));
    tabela("clRefs", ["Referência", "Contas", "Valor (R$)", "% do valor"],
      sp.porRef.map((f) => `<tr>${td(refRot(f.ref), "rot")}${td(fmt(f.contas))}${td(fmt(f.valor))}${td(sp.valor ? pct(f.valor / sp.valor) : "")}</tr>`).concat(linTotal));
    const [col, dir] = clOrdem, L = [...cids].sort((a, b) => (col === "nome" ? a.nome.localeCompare(b.nome, "pt-BR") : a[col] - b[col]) * dir);
    const cab = [["nome", "Cidade"], ["matriculas", "Matrículas"], ["contas", "Contas"], ["valor", "Valor (R$)"]];
    $("clCid").innerHTML = `<thead><tr>${cab.map(([k, t]) => `<th data-col="${k}" class="${k === col ? (dir > 0 ? "asc" : "desc") : ""}">${t}</th>`).join("")}<th>% do valor</th></tr></thead><tbody>`
      + L.map((o) => `<tr>${td(esc(o.nome), "rot")}${td(fmt(o.matriculas))}${td(fmt(o.contas))}${td(fmt(o.valor))}${td(sp.valor ? pct(o.valor / sp.valor) : "")}</tr>`).join("")
      + `<tr class="total">${td("Total", "rot")}${td(fmt(sp.matriculas))}${td(fmt(sp.contas))}${td(fmt(sp.valor))}${td(sp.valor ? "100,00%" : "")}</tr></tbody>`;
    // listas
    const ult = (x) => (x.ultimo >= 0 ? C.rotuloMes(d.meses[x.ultimo]) : "nenhum na pasta");
    const comRec = !!r.receber, tdSaldo = (x) => (comRec ? td(x.saldo ? fmt(x.saldo, 2) : "não está na base") : "");
    tabela("clSem", ["Matrícula", "Nome", "Cidade", "Subcategoria", "Contas", "Valor (R$)", "Ref. mais antiga", "Venc. mais antigo", "Último pagamento", ...(comRec ? ["Saldo vencido na base (R$)"] : [])],
      sp.lista.slice(0, 100).map((x) => {
        const c = comboFat(x.c);
        return `<tr>${tdLig(x.lig)}${td(esc(x.nome), "rot")}${td(esc(c.cidade), "rot")}${td(esc(c.grupo), "rot")}${td(fmt(x.contas))}${td(fmt(x.valor, 2))}${td(refRot(x.refMin))}${td(numData(x.vencMin))}${td(ult(x))}${tdSaldo(x)}</tr>`;
      }));
    const m3 = [3, 2, 1].map((n) => C.rotuloMes(C.mesAnterior(E.mes, n)));
    $("clNotaD").textContent = r.temHist
      ? `${fmt(r.deixaram.length)} matrículas pagaram nos dias úteis ${rotuloDias()} de ${m3.join(", ")} e ainda não pagaram nesses dias em ${C.rotuloMes(E.mes)}.`
      : "Faltam na pasta os 3 meses anteriores ao mês escolhido.";
    tabela("clDeixaram", ["Matrícula", "Nome", "Cidade", "Subcategoria", ...m3.map((m) => m + " (R$)"), "Média (R$)", ...(comRec ? ["Saldo vencido na base (R$)"] : [])],
      r.deixaram.slice(0, 100).map((x) => {
        const c = comboArr(x.c);
        return `<tr>${tdLig(x.lig)}${td(esc(x.nome), "rot")}${td(esc(c.cidade), "rot")}${td(esc(c.grupo), "rot")}${td(fmt(x.m3, 2))}${td(fmt(x.m2, 2))}${td(fmt(x.m1, 2))}${td(fmt(x.media, 2))}${tdSaldo(x)}</tr>`;
      }));
    desenhaReceber(r.receber);
    $("clNotaV").textContent = r.temHist
      ? `${fmt(r.voltaram.length)} matrículas pagaram nos dias úteis ${rotuloDias()} de ${C.rotuloMes(E.mes)} sem nenhum pagamento em ${m3.join(", ")}.`
      : "Faltam na pasta os 3 meses anteriores ao mês escolhido.";
    tabela("clVoltaram", ["Matrícula", "Nome", "Cidade", "Subcategoria", `${C.rotuloMes(E.mes)} (R$)`],
      r.voltaram.slice(0, 100).map((x) => {
        const c = comboArr(x.c);
        return `<tr>${tdLig(x.lig)}${td(esc(x.nome), "rot")}${td(esc(c.cidade), "rot")}${td(esc(c.grupo), "rot")}${td(fmt(x.valor, 2))}</tr>`;
      }));
  }
  $("clCorte").addEventListener("change", () => desenha());
  $("clCid").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-col]");
    if (!th) return;
    clOrdem = [th.dataset.col, th.dataset.col === clOrdem[0] ? -clOrdem[1] : th.dataset.col === "nome" ? 1 : -1];
    desenhaListasCl();
  });
  ["clSem", "clDeixaram", "clVoltaram", "crLista"].forEach((id) => $(id).addEventListener("click", (e) => {
    const a = e.target.closest("a.lig");
    if (!a) return;
    e.preventDefault();
    $("clBusca").value = a.dataset.lig;
    buscaMatricula();
    $("clBusca").scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  document.querySelectorAll("button[data-cl-csv]").forEach((b) => b.addEventListener("click", () => {
    if (!clRes) return;
    const tipo = b.dataset.clCsv, n = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(".", ","), d = E.res.dados;
    const m3 = [3, 2, 1].map((k) => C.rotuloMes(C.mesAnterior(E.mes, k)));
    const txt = (t) => String(t).replace(/;/g, ",");
    let linhas;
    const rec = !!clRes.receber, sd = (x) => (rec ? [x.saldo ? n(x.saldo) : ""] : []), ult = (u) => (u >= 0 ? C.rotuloMes(d.meses[u]) : "nenhum na pasta");
    if (tipo === "sem") linhas = [["Matrícula", "Nome", "Cidade", "Subcategoria", "Contas", "Valor", "Ref. mais antiga", "Venc. mais antigo", "Último pagamento", ...(rec ? ["Saldo vencido na base"] : [])].join(";"),
      ...clRes.semPagamento.lista.map((x) => {
        const c = comboFat(x.c);
        return [x.lig, txt(x.nome), c.cidade, c.grupo, x.contas, n(x.valor), refRot(x.refMin), numData(x.vencMin), ult(x.ultimo), ...sd(x)].join(";");
      })];
    else if (tipo === "deixaram") linhas = [["Matrícula", "Nome", "Cidade", "Subcategoria", ...m3, "Média", ...(rec ? ["Saldo vencido na base"] : [])].join(";"),
      ...clRes.deixaram.map((x) => { const c = comboArr(x.c); return [x.lig, txt(x.nome), c.cidade, c.grupo, n(x.m3), n(x.m2), n(x.m1), n(x.media), ...sd(x)].join(";"); })];
    else if (tipo === "receber") linhas = [["Matrícula", "Nome", "Cidade", "Situação da ligação", "Tipo de ligação", "Contato", "Contas vencidas", "Saldo vencido", "Contas a vencer", "A vencer",
      "Faixa mais antiga", "Último pagamento", `Pago em ${C.rotuloMes(E.mes)}`].join(";"),
      ...clRes.receber.lista.map((x) => [x.lig, txt(x.nome), x.cidade, x.sitLig, x.tipo, x.contato, x.contasV, n(x.vencido), x.contasAV, n(x.aVencer), x.faixaMaxTxt, ult(x.ultimo), x.noMes ? n(x.noMes) : ""].join(";"))];
    else linhas = [["Matrícula", "Nome", "Cidade", "Subcategoria", C.rotuloMes(E.mes)].join(";"),
      ...clRes.voltaram.map((x) => { const c = comboArr(x.c); return [x.lig, txt(x.nome), c.cidade, c.grupo, n(x.valor)].join(";"); })];
    baixa("﻿" + linhas.join("\r\n"), `Clientes_${tipo}_${E.mes}.csv`);
  }));
  // Contas a receber: qual base usar ("nfc" = só notas fiscais; "total" = com parcelas e NFA). Um seletor em cada lugar
  // (Clientes e oportunidades e as bases da aba Base), sempre com o mesmo valor; a escolha fica guardada neste navegador.
  const recInfo = () => (E.res && E.res.receberInfo && E.res.receberInfo[E.recTipo]) || null;
  const recNome = () => (E.recTipo === "nfc" ? "apenas NFC" : "total (com parcelas e NFA)");
  function ajustaRecTipo() {
    const ri = (E.res && E.res.receberInfo) || {};
    let t = E.recTipo;
    if (!t) try { t = localStorage.getItem("arrecadacao_rec_tipo") || ""; } catch (e) { t = ""; }
    if (!ri[t]) t = ri.nfc ? "nfc" : ri.total ? "total" : t || "nfc";   // a escolhida não está na pasta: usa a que houver
    E.recTipo = t;
    document.querySelectorAll(".sel-rec").forEach((sl) => {
      [...sl.options].forEach((o) => { o.disabled = !ri[o.value]; o.textContent = (o.value === "nfc" ? "Apenas NFC" : "Total (com parcelas e NFA)") + (ri[o.value] ? "" : " — sem base na pasta"); });
      sl.value = t;
      sl.disabled = !ri.nfc && !ri.total;
    });
  }
  document.querySelectorAll(".sel-rec").forEach((sl) => sl.addEventListener("change", () => {
    E.recTipo = sl.value;
    try { localStorage.setItem("arrecadacao_rec_tipo", sl.value); } catch (e) { /* sem armazenamento */ }
    ajustaRecTipo();
    desenha();
  }));
  // bloco "Contas a receber" (base de contas vencidas e a vencer informada na pasta)
  function desenhaReceber(rc) {
    const ri = recInfo();
    if (rc) $("clNotaBase").innerHTML = `Com a base de contas a receber ${recNome()} de ${dataBR(ri.data)}, o <b>faturado sem pagamento</b> é conferido por matrícula: está na base com saldo vencido`
      + " (confirmado) ou não está (provável pagamento por acordo, com outro vencimento, ou conta já quitada). A base não traz o vencimento de cada conta.";
    $("crCorpo").hidden = !rc;
    $("crBase").textContent = ri ? `base ${recNome()} de ${dataBR(ri.data)} · ${ri.arquivo}` : "";
    if (!rc) {
      $("crNota").innerHTML = "Nenhuma base de contas a receber na pasta. Coloque a planilha (colunas NUM_LIGACAO, Saldo total e FAIXA_DESCRICAO) em qualquer pasta, de preferência numa"
        + " subpasta “Contas a Receber”, com a data no nome (ex.: Contas a receber 27-10-2026.xlsx), e clique em Atualizar.";
      return;
    }
    const t = rc.tot, M = C.rotuloMes(E.mes), d = E.res.dados;
    const filtro = filtroTexto();
    $("crNota").textContent = `${filtro} · posição de ${dataBR(ri.data)}: ${fmt(t.matriculas)} matrículas na base (${fmt(ri.matriculas)} sem filtros). `
      + `Saldo vencido = todas as faixas menos “00 - A Vencer”. Pagamentos de ${M} até ${dataBR(d.ultimoCredito[E.mes])}.`;
    const ano = rc.porFaixa.filter((f) => f.num >= 366).reduce((a, f) => a + f.saldo, 0);
    const cort = rc.porSit.find((x) => /CORTAD/i.test(x.nome));
    const card = (tt, v, sub) => `<div class="kpi"><span>${tt}</span><b>${v}</b><small>${sub}</small></div>`;
    $("crKpis").innerHTML = [
      card("Saldo vencido", milhoes(t.vencido), `${fmt(t.contasV)} contas · ${fmt(t.devedoras)} matrículas`),
      card("A vencer (vencendo hoje)", milhoes(t.aVencer), `${fmt(t.contasAV)} contas`),
      card("Vencido há mais de 1 ano", milhoes(ano), `${t.vencido ? pct(ano / t.vencido) : "—"} do saldo vencido`),
      card(`Devedoras que pagaram em ${M}`, fmt(rc.pagaram.matriculas), `${rs(rc.pagaram.valor)} pagos no mês · ainda devem ${rs(rc.pagaram.vencido)}`),
      card("Devedoras sem pagamento há 3 meses ou mais", fmt(rc.sem3.matriculas), `saldo vencido ${rs(rc.sem3.vencido)} · nada em ${M} nem nos 2 meses anteriores`),
      card("Ligações cortadas", cort ? fmt(cort.matriculas) : "0", cort ? `saldo vencido ${rs(cort.saldo)} · ${pct(cort.saldo / t.vencido)} do total` : "—"),
    ].join("");
    const linhaTot = (n, c, v, extra = "") => `<tr class="total">${td("Total", "rot")}${td(fmt(n))}${td(fmt(c))}${td(fmt(v))}${extra}</tr>`;
    const totFaixa = rc.porFaixa.reduce((a, f) => a + f.saldo, 0);
    tabela("crFaixas", ["Faixa", "Matrículas", "Contas", "Saldo (R$)", "% do saldo"],
      rc.porFaixa.map((f) => `<tr>${td(esc(f.nome), "rot")}${td(fmt(f.matriculas))}${td(fmt(f.contas))}${td(fmt(f.saldo))}${td(totFaixa ? pct(f.saldo / totFaixa) : "")}</tr>`)
        .concat(`<tr class="total">${td("Total (vencido + a vencer)", "rot")}${td(fmt(t.matriculas))}${td(fmt(t.contasV + t.contasAV))}${td(fmt(totFaixa))}${td("100,00%")}</tr>`));
    const grupoTab = (id, titulo, lista) => tabela(id, [titulo, "Matrículas", "Contas vencidas", "Saldo vencido (R$)", "A vencer (R$)", "% do vencido"],
      lista.map((o) => `<tr>${td(esc(o.nome), "rot")}${td(fmt(o.matriculas))}${td(fmt(o.contas))}${td(fmt(o.saldo))}${td(fmt(o.aVencer))}${td(t.vencido ? pct(o.saldo / t.vencido) : "")}</tr>`)
        .concat(linhaTot(t.matriculas, t.contasV, t.vencido, `${td(fmt(t.aVencer))}${td("100,00%")}`)));
    grupoTab("crSit", "Situação", rc.porSit);
    grupoTab("crContato", "Contato", rc.porContato);
    grupoTab("crCid", "Cidade", rc.porCidade);
    const ult = (u) => (u >= 0 ? C.rotuloMes(d.meses[u]) : "nenhum na pasta");
    tabela("crLista", ["Matrícula", "Nome", "Cidade", "Situação", "Contato", "Contas vencidas", "Saldo vencido (R$)", "A vencer (R$)", "Faixa mais antiga", "Último pagamento", `Pago em ${M} (R$)`],
      rc.lista.slice(0, 100).map((x) => `<tr>${tdLig(x.lig)}${td(esc(x.nome), "rot")}${td(esc(x.cidade), "rot")}${td(esc(x.sitLig), "rot")}${td(esc(x.contato), "rot")}`
        + `${td(fmt(x.contasV))}${td(fmt(x.vencido, 2))}${td(x.aVencer ? fmt(x.aVencer, 2) : "")}${td(esc(x.faixaMaxTxt), "rot")}${td(ult(x.ultimo))}${td(x.noMes ? fmt(x.noMes, 2) : "")}</tr>`));
  }
  // histórico da matrícula: o que a base de contas a receber diz dela
  function histReceber(x) {
    const ri = recInfo();
    if (!ri) return "";
    if (!x) return `<p class="nota">Não está na base de contas a receber ${recNome()} de ${dataBR(ri.data)}.</p>`;
    const linhas = [...x.faixas].sort((a, b) => a.num - b.num).map((f) => `<tr>${td(esc(f.txt), "rot")}${td(fmt(f.contas))}${td(fmt(f.saldo, 2))}</tr>`)
      .concat(`<tr class="total">${td("Total", "rot")}${td(fmt(x.contasV + x.contasAV))}${td(fmt(x.vencido + x.aVencer, 2))}</tr>`);
    return `<h3>Contas a receber (base ${recNome()} de ${dataBR(ri.data)})</h3><p class="nota">Situação: ${esc(x.sitLig)} · ${esc(x.tipo)} · contato: ${esc(x.contato)} · `
      + `saldo vencido ${rs(x.vencido)} em ${fmt(x.contasV)} contas${x.aVencer ? ` · a vencer ${rs(x.aVencer)}` : ""}</p>`
      + `<div class="wrap"><table class="compacta base-tabela"><thead><tr><th>Faixa</th><th>Contas</th><th>Saldo (R$)</th></tr></thead><tbody>${linhas.join("")}</tbody></table></div>`;
  }
  // histórico de uma matrícula
  function buscaMatricula() {
    const l = $("clBusca").value.trim();
    if (!l) return;
    $("clBuscaStatus").textContent = "Buscando…";
    worker.postMessage({ tipo: "matricula", id: ++idMat, lig: l, recTipo: E.recTipo });
  }
  $("clBuscar").addEventListener("click", buscaMatricula);
  $("clBusca").addEventListener("keydown", (e) => { if (e.key === "Enter") buscaMatricula(); });
  const TIPO_PAG = { 1: "nota fiscal", 2: "fatura avulsa", 3: "parcela", 0: "outro" };
  function recebeMatricula(m) {
    if (m.id !== idMat) return;
    if (m.erro) { $("clBuscaStatus").textContent = "Erro: " + m.erro; return; }
    const d = E.res.dados, nada = !m.meses.length && !m.faturas.length && !m.semConta.length && !m.receber;
    $("clBuscaStatus").textContent = nada ? `Matrícula ${m.lig} não encontrada na arrecadação nem no faturamento da pasta.` : "";
    if (nada) { $("clHist").innerHTML = ""; return; }
    const loc = m.meses.length ? comboArr(m.meses[m.meses.length - 1].c) : m.faturas.length ? comboFat(m.faturas[m.faturas.length - 1].c) : { cidade: m.receber.cidade, grupo: "" };
    const totArr = m.meses.reduce((a, x) => a + x.valor, 0), totDesc = m.meses.reduce((a, x) => a + x.desconto, 0);
    const linMes = m.meses.map((x) => `<tr>${td(C.rotuloMes(d.meses[x.mi]), "rot")}${td(fmt(x.valor, 2))}${td(x.desconto ? fmt(-x.desconto, 2) : "")}${td(fmt(x.valor - x.desconto, 2))}${td(fmt(x.dias))}</tr>`)
      .concat(`<tr class="total">${td("Total", "rot")}${td(fmt(totArr, 2))}${td(totDesc ? fmt(-totDesc, 2) : "")}${td(fmt(totArr - totDesc, 2))}${td("")}</tr>`);
    const sit = (f) => (f.valor <= 0 ? "crédito" : !f.pagamentos.length ? "sem pagamento" : f.pago < f.valor - 0.5 ? "paga em parte" : f.pago > f.valor + 0.5 ? "paga acima (juros/multa?)" : "paga");
    const linFat = m.faturas.map((f) => `<tr class="${f.valor > 0 && !f.pagamentos.length ? "alerta" : ""}">${td(refRot(f.ref), "rot")}${td(numData(f.venc))}${td(fmt(f.valor, 2))}`
      + `${td(f.pagamentos.length ? fmt(f.pago, 2) : "")}${td([...new Set(f.pagamentos.map((p) => C.rotuloMes(d.meses[p.mi])))].join(", "), "rot")}${td(sit(f), "rot")}</tr>`);
    const linSem = m.semConta.map((p) => `<tr>${td(C.rotuloMes(d.meses[p.mi]), "rot")}${td(numData(p.venc))}${td(TIPO_PAG[p.tipo] || "outro", "rot")}${td(fmt(p.v, 2))}</tr>`);
    const tab = (cab, linhas) => `<div class="wrap"><table class="compacta"><thead><tr>${cab.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${linhas.join("")}</tbody></table></div>`;
    const nomeM = m.nome || (m.receber && m.receber.nome) || "";
    $("clHist").innerHTML = `<p class="hist-tit"><b>${esc(m.lig)}</b>${nomeM ? " — " + esc(nomeM) : ""} · ${esc(loc.cidade)}${loc.grupo ? " · " + esc(loc.grupo) : ""}</p><div class="grade-2">`
      + `<div><h3>Arrecadação por mês (crédito)</h3>${m.meses.length ? tab(["Mês", "Val. Autenticado (R$)", "Desconto (R$)", "Arrecadação (R$)", "Dias com pagamento"], linMes)
        : '<p class="nota">Nenhum pagamento na arrecadação da pasta.</p>'}</div>`
      + `<div><h3>Contas da fatura (Interior)</h3>${m.faturas.length ? tab(["Referência", "Vencimento", "Faturado (R$)", "Pago (R$)", "Pago em", "Situação"], linFat)
        : '<p class="nota">Nenhuma conta nos arquivos de faturamento da pasta.</p>'}`
      + (linSem.length ? `<h3>Pagamentos sem conta na fatura da pasta</h3>${tab(["Mês do crédito", "Vencimento", "Tipo", "Valor (R$)"], linSem)}` : "")
      + "</div></div>" + histReceber(m.receber);
  }

  // ----- Diagnóstico por localidade -----
  let dgOrdem = ["dv", 1], dgLinhas = [], dgCab = null;
  const NIVEIS_DG = { cidade: ["Cidade", (c) => c.cidade], grupo: ["Subcategoria", (c) => c.grupo], sup: ["Superintendência", (c) => nomeSup(c.sup)],
    cidgrupo: ["Cidade × subcategoria", (c) => `${c.cidade} · ${c.grupo}`] };
  function desenhaLocalidade() {
    const d = E.res.dados, mi = idxMes(E.mes), mk = marcas(), sel = selCalc(), nivel = $("dgNivel").value, [titulo, grupoDe] = NIVEIS_DG[nivel];
    const baseSel = $("dgBase").value, metodo = $("dgMetodo").value;
    const mesesBase = baseSel === "ant" ? [C.mesAnterior(E.mes)] : baseSel === "ano" ? [C.mesAnterior(E.mes, 12)] : [1, 2, 3].map((n) => C.mesAnterior(E.mes, n));
    const comDados = mesesBase.filter((m) => idxMes(m) >= 0);
    const rotBase = baseSel === "media3" ? "Média 3 meses" : C.rotuloMes(mesesBase[0]);
    const linhas = C.comparaGrupos(d, mi, comDados.map(idxMes), mk, sel, grupoDe);
    const total = C.comparaGrupos(d, mi, comDados.map(idxMes), mk, sel, () => "T")[0] || { atual: { valor: 0, contas: 0, clientes: 0 }, base: null };
    // projeção: fração do mês até os dias marcados
    const mm = C.mesesMesmosUteis(d, E.mes);
    const frU = C.fracaoAteDias(d, mm.meses, mk, sel, grupoDe), frUT = C.fracaoAteDias(d, mm.meses, mk, sel, () => "T").get("T");
    const pesos = curvaDoMes(E.mes, E.sup).pesos, frC = C.diasDaMascara(sel).reduce((a, k) => a + (pesos[k] || 0), 0);
    const dr = C.fracaoDiasRestantes(d, E.mes, mk, sel, grupoDe), drT = C.fracaoDiasRestantes(d, E.mes, mk, sel, () => "T"), frRT = drT.fr.get("T");
    const fracao = (rot) => (metodo === "curva" ? frC : metodo === "restantes" ? dr.fr.get(rot) || frRT : frU.get(rot) || frUT);
    const proj = (v, f) => (f > 0 ? v / f : null);
    const projU = proj(total.atual.valor, frUT), projC = proj(total.atual.valor, frC), projR = proj(total.atual.valor, frRT);
    const projT = { curva: projC, restantes: projR }[metodo] ?? projU;
    const orc = filtroParcial() ? null : orcadoMensal(E.mes, E.sup);
    const N = ultimoDiaComDados(E.mes), cal = C.calendario(E.mes);
    const fechado = (d.ultimoCredito[E.mes] || "") >= cal.dias[cal.dias.length - 1].data, mesInteiro = fechado ? C.totalDoMes(d, mi, mk, C.MASCARA_MES).valor : null;
    const criterio = { iguais: `meses de ${E.mes.slice(0, 4)} com ${cal.uteis} dias úteis`, iguais12: `últimos 12 meses com ${cal.uteis} dias úteis (nenhum no ano)`,
      ano: `meses anteriores de ${E.mes.slice(0, 4)} (nenhum com ${cal.uteis} dias úteis)`, ult12: "últimos 12 meses" }[mm.criterio];
    $("dgNota").textContent = `${filtroTexto()} · ${C.rotuloMes(E.mes)}, dias úteis ${rotuloSel(sel)}`
      + ` (crédito até ${dataBR(d.ultimoCredito[E.mes])}; dia útil ${N} de ${cal.uteis}) · comparação com ${baseSel === "media3" ? "a média de " + mesesBase.map(C.rotuloMes).join(", ") : rotBase}, nos mesmos dias.`;
    $("dgAviso").innerHTML = comDados.length < mesesBase.length
      ? `<p class="aviso-pdf">${esc(comDados.length ? `Sem dados de ${mesesBase.filter((m) => !comDados.includes(m)).map(C.rotuloMes).join(", ")} na pasta: a média usa só ${comDados.map(C.rotuloMes).join(", ")}.` : `Sem dados de ${mesesBase.map(C.rotuloMes).join(", ")} na pasta para comparar.`)}</p>` : "";
    // faturado (Interior, referência = mês escolhido) por cidade / superintendência
    const cz = E.res.cruzamento && E.res.cruzamento.fat.length ? E.res.cruzamento : null;
    const fatRef = cz ? cz.fat.filter((f) => f.ref === E.mes) : [];
    const comFat = fatRef.length && (nivel === "cidade" || nivel === "sup") && comInterior();
    const fatDe = new Map();
    if (comFat) for (const f of fatRef) {
      const c = cz.combos[f.c];
      if (!okFat(c)) continue;
      const k = nivel === "cidade" ? c.cidade : nomeSup(c.sup), o = fatDe.get(k) || { valor: 0, matriculas: 0 };
      o.valor += f.valor; o.matriculas += f.matriculas; fatDe.set(k, o);
    }
    const comOrc = nivel === "sup" && !filtroParcial() && E.verOrcado;
    const supDe = new Map(d.combos.map((c) => [nomeSup(c.sup), c.sup]));
    dgLinhas = linhas.map((l) => {
      const a = l.atual, b = l.base, f = fracao(l.rot), pj = proj(a.valor, f), fat = fatDe.get(l.rot);
      const o = comOrc ? orcadoMensal(E.mes, supDe.get(l.rot)).valor : null;
      return { nome: l.rot, v: a.valor, b: b ? b.valor : null, dv: b ? a.valor - b.valor : null, dp: b && b.valor ? a.valor / b.valor - 1 : null,
        cli: a.clientes, dcli: b && b.clientes ? a.clientes / b.clientes - 1 : null, contas: a.contas, ticket: a.contas ? a.valor / a.contas : null,
        proj: pj, fr: f, orc: o, po: o && pj != null ? pj / o : null, fat: fat ? fat.valor : null, mat: fat ? fat.matriculas : null };
    });
    dgCab = [["nome", titulo], ["v", "Arrecadado (R$)"], ["b", `${rotBase} (R$)`], ["dv", "Variação (R$)"], ["dp", "Variação %"], ["cli", "Clientes"], ["dcli", "Var. clientes"],
      ["contas", "Contas"], ["ticket", "Ticket (R$)"], ["proj", "Projeção do mês (R$)"],
      ...(comOrc ? [["orc", "Orçado (R$)"], ["po", "Projeção ÷ orçado"]] : []), ...(comFat ? [["fat", `Faturado ${C.rotuloMes(E.mes)} (R$)`], ["mat", "Matrículas faturadas"]] : [])];
    desenhaTabelaDg(total, projT, orc);
    $("dgNotaTab").textContent = `Variação = arrecadado nos dias marcados − ${rotBase} nos mesmos dias. Projeção do mês (cada localidade com os seus próprios números) pelo método ${NOMES_PROJ[metodo]}, explicado no cartão destacado acima.`
      + ((nivel === "cidade" || nivel === "sup") && !fatRef.length ? ` Faturamento da referência ${C.rotuloMes(E.mes)} não está na pasta.` : "");
    // cards
    const b = total.base, dv = b ? total.atual.valor - b.valor : null;
    const pa = C.pareto(dgLinhas.map((x) => ({ rot: x.nome, v: x.dv == null ? 0 : -x.dv })));
    const card = (t, v, sub) => `<div class="kpi"><span>${t}</span><b>${v}</b><small>${sub}</small></div>`;
    const sinal = (x) => (x == null ? "—" : (x >= 0 ? "+" : "") + pct(x));
    $("dgKpis").innerHTML = [
      card("Arrecadado nos dias marcados", milhoes(total.atual.valor), b ? `${rotBase}: ${rs(b.valor)} · ${sinal(b.valor ? total.atual.valor / b.valor - 1 : null)}` : "sem período de comparação"),
      ...cartoesProjecao({ A: total.atual.valor, metodo, frUT, mm, criterio, frC, drT, projU, projC, projR, N, cal, fechado, mesInteiro }),
      E.verOrcado && card("Projeção ÷ orçado", orc && orc.valor != null && projT != null ? pct(projT / orc.valor) : "—",
        orc ? (orc.valor != null ? `orçado ${rs(orc.valor)} · falta ${rs(Math.max(0, orc.valor - total.atual.valor))} para o orçado` : "sem orçado no mês para o orçado escolhido") : "o orçado é por superintendência (Cidade e Subcategoria = Todas)"),
      card("Clientes pagantes", fmt(total.atual.clientes), b ? `${rotBase}: ${fmt(b.clientes)} · ${sinal(b.clientes ? total.atual.clientes / b.clientes - 1 : null)}` : "—"),
      card("Localidades em queda", b ? `${fmt(pa.itens.length)} de ${fmt(dgLinhas.length)}` : "—",
        b ? (pa.itens.length ? `quedas somam ${rs(pa.total)} · ${fmt(pa.n80)} explicam 80% · variação total ${rs(dv)}` : "nenhuma localidade em queda") : "—"),
    ].filter(Boolean).join("");
    // quedas, altas e Pareto
    const cmp = dgLinhas.filter((x) => x.dv != null);
    const quedas = cmp.filter((x) => x.dv < 0).sort((a, c) => a.dv - c.dv).slice(0, 10), altas = cmp.filter((x) => x.dv > 0).sort((a, c) => c.dv - a.dv).slice(0, 10);
    $("dgNotaQ").textContent = `Até 10 localidades com a maior queda em R$ contra ${rotBase} (variação % ao lado).`;
    $("dgNotaA").textContent = `Até 10 localidades com o maior aumento em R$ contra ${rotBase}.`;
    const dicaDg = (i, l) => { const x = l[i];
      return linhaDica(x.nome, `Arrecadado: ${rs(x.v)}`, `${rotBase}: ${rsOu(x.b)}`, `Variação: ${rs(x.dv)}${x.dp == null ? "" : ` (${pct(x.dp)})`}`,
        `Clientes: ${fmt(x.cli)}${x.dcli == null ? "" : ` (${pct(x.dcli)})`}`, x.ticket != null && `Ticket: R$ ${fmt(x.ticket, 2)}`, x.proj != null && `Projeção do mês: ${rs(x.proj)}`,
        "Nos dias úteis marcados, com o desconto comercial"); };
    grafico("dgQuedas", quedas.length && ((W) => svgBarrasH(quedas.map((x) => [x.nome, x.dv, x.dp]), "b-queda", W, (i) => dicaDg(i, quedas))), '<p class="nota">Nenhuma queda.</p>');
    grafico("dgAltas", altas.length && ((W) => svgBarrasH(altas.map((x) => [x.nome, x.dv, x.dp]), "b-alta", W, (i) => dicaDg(i, altas))), '<p class="nota">Nenhum aumento.</p>');
    const top = pa.itens.slice(0, 20), resto = pa.itens.slice(20);
    $("dgNotaP").textContent = pa.itens.length ? `${fmt(pa.n80)} de ${fmt(pa.itens.length)} localidades em queda somam 80% da queda total (${rs(pa.total)}).${resto.length ? ` As ${fmt(resto.length)} menores ficam em “demais”.` : ""}` : "";
    const itensP = resto.length ? [...top, { rot: "demais", v: resto.reduce((a, x) => a + x.v, 0), acum: 1 }] : top;
    grafico("dgPareto", itensP.length && ((W) => svgPareto(itensP, W, pa.total)), '<p class="nota">Nenhuma localidade em queda no período.</p>');
  }
  // As três projeções do mês, cada uma num cartão com a conta explicada em palavras simples; a escolhida em "Projeção"
  // (a que vai para a tabela) fica destacada
  const NOMES_PROJ = { uteis: "dos meses com os mesmos dias úteis", curva: "da curva do orçado", restantes: "dos dias úteis restantes" };
  function cartoesProjecao(o) {
    const { A, metodo, frUT, mm, criterio, frC, drT, projU, projC, projR, N, cal, fechado, mesInteiro } = o;
    const listaMeses = (l) => (l.length ? l.map(C.rotuloMes).join(", ") : "—");
    const k = drT.k.get("T"), media = drT.n ? A / drT.n : null;
    const iguais = drT.meses.filter((m) => m.peso > 1).map((m) => m.mes), outros = drT.meses.filter((m) => m.peso === 1).map((m) => m.mes);
    const conta = (txt) => `<code class="proj-conta">${txt}</code>`;
    const itens = [
      ["uteis", "Projeção pelos meses com os mesmos dias úteis", projU,
        frUT ? `Olha os meses parecidos com este (${criterio}: ${listaMeses(mm.meses)}). Neles, até os dias úteis marcados já tinha entrado, em média, `
          + `<strong>${pct(frUT)}</strong> do mês. Se este mês seguir o mesmo ritmo, fecha em:` + conta(`${rs(A)} ÷ ${pct(frUT)}`)
          : "Sem meses parecidos na pasta para comparar."],
      ["curva", "Projeção pela curva do orçado", projC,
        frC ? `A curva do orçado diário diz quanto do mês costuma entrar em cada dia útil. Pela curva, os dias úteis marcados valem <strong>${pct(frC)}</strong> do mês. `
          + "Se a arrecadação seguir a curva, fecha em:" + conta(`${rs(A)} ÷ ${pct(frC)}`) : "Sem curva do orçado para este mês."],
      ["restantes", "Projeção pelos dias úteis restantes", projR,
        k != null && drT.n ? (drT.falta > 0
          ? `Até agora: <strong>${fmt(drT.n)}</strong> dias úteis, média de <strong>${rs(media)}</strong> por dia útil. Faltam <strong>${fmt(drT.falta)}</strong> dias úteis. `
            + `Nos últimos 12 meses, cada dia útil do resto do mês rendeu <strong>${fmt(k, 2)}×</strong> um dia útil do começo `
            + `(peso 3 para os meses com ${cal.uteis} dias úteis, como este${iguais.length ? `: ${listaMeses(iguais)}` : ": nenhum na pasta"}; peso 1 para ${outros.length ? listaMeses(outros) : "os outros"}). Fecha em:`
            + conta(`${rs(A)} + ${fmt(drT.falta)} dias × ${rs(media)} × ${fmt(k, 2)}`)
          : "Todos os dias úteis do mês já estão marcados: a projeção é o próprio arrecadado.")
          : "Sem meses anteriores suficientes na pasta para medir o ritmo dos dias restantes."],
    ];
    return itens.map(([m, tit, v, txt]) => `<div class="kpi kpi-proj${m === metodo ? " kpi-proj-sel" : ""}"><span>${tit}${m === metodo ? ' <i class="proj-usada">usada na tabela</i>' : ""}</span>`
      + `<b>${v == null ? "—" : milhoes(v)}</b><small>${txt}${m === metodo && fechado ? ` <br>Mês fechado: realizado no mês inteiro ${rs(mesInteiro)}.` : ""}</small></div>`);
  }
  function desenhaTabelaDg(total, projT, orc) {
    const [col, dir] = dgOrdem.length && dgCab.some(([k]) => k === dgOrdem[0]) ? dgOrdem : ["dv", 1];
    const L = [...dgLinhas].sort((a, b) => (col === "nome" ? a.nome.localeCompare(b.nome, "pt-BR") : ((a[col] ?? Infinity * dir) - (b[col] ?? Infinity * dir)) || 0) * dir);
    const f = { nome: (x) => esc(x), dp: (x) => (x == null ? "" : pct(x)), dcli: (x) => (x == null ? "" : pct(x)), po: (x) => (x == null ? "" : pct(x)), ticket: (x) => (x == null ? "" : fmt(x, 2)) };
    const cel = (k, v) => (v == null && k !== "nome" ? td("") : k === "nome" ? td(esc(v), "rot") : (k === "dv" || k === "dp" || k === "dcli") ? tdNum(v, f[k] || fmt) : td((f[k] || fmt)(v)));
    const soma = (k) => (dgLinhas.some((x) => x[k] != null) ? dgLinhas.reduce((a, x) => a + (x[k] || 0), 0) : null);
    const b = total.base, tot = { nome: "Total", v: total.atual.valor, b: b ? b.valor : null, dv: b ? total.atual.valor - b.valor : null, dp: b && b.valor ? total.atual.valor / b.valor - 1 : null,
      cli: total.atual.clientes, dcli: b && b.clientes ? total.atual.clientes / b.clientes - 1 : null, contas: total.atual.contas, ticket: total.atual.contas ? total.atual.valor / total.atual.contas : null,
      proj: projT, orc: soma("orc"), po: null, fat: soma("fat"), mat: soma("mat") };
    if (tot.orc != null && projT != null) tot.po = projT / tot.orc;
    $("dgTab").innerHTML = `<thead><tr>${dgCab.map(([k, t]) => `<th data-col="${k}" class="${k === col ? (dir > 0 ? "asc" : "desc") : ""}">${t}</th>`).join("")}</tr></thead><tbody>`
      + L.map((o) => `<tr>${dgCab.map(([k]) => cel(k, o[k])).join("")}</tr>`).join("")
      + `<tr class="total">${dgCab.map(([k]) => cel(k, tot[k])).join("")}</tr></tbody>`;
  }
  ["dgNivel", "dgBase", "dgMetodo"].forEach((id) => $(id).addEventListener("change", () => desenha()));
  $("dgTab").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-col]");
    if (!th) return;
    dgOrdem = [th.dataset.col, th.dataset.col === dgOrdem[0] ? -dgOrdem[1] : th.dataset.col === "nome" ? 1 : th.dataset.col === "dv" || th.dataset.col === "dp" ? 1 : -1];
    desenha();
  });
  $("dgCsv").addEventListener("click", () => {
    const n = (v) => (v == null ? "" : (Math.round(v * 100) / 100).toFixed(2).replace(".", ","));
    const pcts = new Set(["dp", "dcli", "po"]);
    const linhas = [dgCab.map(([k, t]) => (pcts.has(k) ? t + " (%)" : t.replace(" (R$)", ""))).join(";"),
      ...dgLinhas.map((o) => dgCab.map(([k]) => (k === "nome" ? o.nome : pcts.has(k) ? n(o[k] == null ? null : o[k] * 100) : n(o[k]))).join(";"))];
    baixa("﻿" + linhas.join("\r\n"), `Diagnostico_${$("dgNivel").value}_${E.mes}.csv`);
  });
  // barras horizontais: itens [rótulo, valor, variação %]; a coluna dos nomes acompanha a largura do quadro
  function svgBarrasH(itens, cls, W, dicaDe) {
    const larg = Math.max(300, W), h = 26, esq = Math.round(Math.min(220, Math.max(110, larg * 0.36))), dirW = larg < 480 ? 92 : 128;
    const alt = itens.length * h + 8, max = Math.max(1, ...itens.map(([, v]) => Math.abs(v))), cabe = Math.max(8, Math.floor((esq - 10) / 6.6));
    let svg = `<svg width="${larg}" height="${alt}" viewBox="0 0 ${larg} ${alt}" class="barras-h">`;
    itens.forEach(([rot, v, p], i) => {
      const y = i * h + 4, w = ((larg - esq - dirW) * Math.abs(v)) / max, nome = rot.length > cabe ? rot.slice(0, cabe - 1) + "…" : rot;
      svg += `<g class="alvo" data-dica="${esc(dicaDe ? dicaDe(i) : linhaDica(rot, `Variação: ${rs(v)}${p == null ? "" : ` (${pct(p)})`}`))}">`
        + `<rect class="hit" x="0" y="${y}" width="${larg}" height="${h}"/><text class="rot-h" x="${esq - 6}" y="${y + 16}">${esc(nome)}</text>`
        + `<rect class="${cls}" x="${esq}" y="${y + 3}" width="${Math.max(1, w)}" height="${h - 8}" rx="2"/>`
        + `<text class="val-h" x="${esq + w + 6}" y="${y + 16}">${curto(v)}${p == null || larg < 480 ? "" : " · " + pct(p)}</text></g>`;
    });
    return svg + "</svg>";
  }
  // Pareto: barras (queda) e linha do acumulado (0–100% da altura das barras), com a marca dos 80%
  function svgPareto(itens, W, total) {
    return barras({
      cats: itens.map((x) => (x.rot.length > 22 ? x.rot.slice(0, 21) + "…" : x.rot)), series: [[itens.map((x) => x.v), "b-queda"]], rotulo: curto,
      titulo: (i) => linhaDica(itens[i].rot, `Queda: ${rs(itens[i].v)}`, total && `Parte da queda total: ${pct(itens[i].v / total)}`, `Acumulado: ${pct(itens[i].acum)}`,
        `Posição: ${i + 1}ª maior queda`), fundo: true,
      sobre: ({ cx, base, plot, larg }) => {
        const ya = (a) => base - plot * a, pts = itens.map((x, i) => `${cx(i)},${ya(x.acum)}`);
        return `<line x1="0" y1="${ya(0.8)}" x2="${larg}" y2="${ya(0.8)}" class="ref80"/><text class="ref80t" x="${larg - 4}" y="${ya(0.8) - 4}">80%</text>`
          + `<polyline class="l-at" points="${pts.join(" ")}"/>` + itens.map((x, i) => `<circle class="l-at" cx="${cx(i)}" cy="${ya(x.acum)}" r="3.5"/>`).join("");
      },
    }, W);
  }
  // ----- balão dos gráficos: ao passar o mouse (ou tocar, no celular) numa coluna, ponto ou linha, mostra os valores exatos
  // e o que mais importa. Cada área sensível tem data-dica: linhas separadas por "\n"; a 1ª é o título e "Rótulo: valor"
  // vira uma linha da tabela do balão.
  const dicaEl = document.createElement("div");
  dicaEl.id = "dicaGrafico";
  dicaEl.hidden = true;
  document.body.append(dicaEl);
  let alvoDica = null;
  function mostraDica(alvo, x, y) {
    if (alvo !== alvoDica) {
      if (alvoDica) alvoDica.classList.remove("ativo");
      alvoDica = alvo;
      alvo.classList.add("ativo");
      const [tit, ...resto] = alvo.dataset.dica.split("\n");
      dicaEl.innerHTML = `<b>${esc(tit)}</b>` + (resto.length ? `<table>${resto.map((l) => {
        const p = l.indexOf(": ");
        return p < 0 ? `<tr><td colspan="2" class="obs">${esc(l)}</td></tr>` : `<tr><td>${esc(l.slice(0, p))}</td><td>${esc(l.slice(p + 2))}</td></tr>`;
      }).join("")}</table>` : "");
      dicaEl.hidden = false;
    }
    dicaEl.style.left = "0px"; dicaEl.style.top = "0px";                 // mede o balão com a largura natural
    const w = dicaEl.offsetWidth, h = dicaEl.offsetHeight, m = 14;
    let left = x + m, top = y + m;
    if (left + w > innerWidth - 6) left = x - w - m;                // perto da borda: o balão vai para o outro lado do cursor
    if (top + h > innerHeight - 6) top = y - h - m;
    dicaEl.style.left = Math.max(6, left) + "px";
    dicaEl.style.top = Math.max(6, top) + "px";
  }
  function escondeDica() {
    if (alvoDica) alvoDica.classList.remove("ativo");
    alvoDica = null;
    dicaEl.hidden = true;
  }
  const alvoDe = (e) => (e.target.closest ? e.target.closest(".grafico [data-dica]") : null);
  document.addEventListener("mousemove", (e) => { const a = alvoDe(e); if (a) mostraDica(a, e.clientX, e.clientY); else if (alvoDica) escondeDica(); });
  document.addEventListener("click", (e) => { const a = alvoDe(e); if (a) mostraDica(a, e.clientX, e.clientY); else escondeDica(); });   // toque no celular
  addEventListener("scroll", escondeDica, { passive: true });
  const linhaDica = (...partes) => partes.filter((x) => x != null && x !== false && x !== "").join("\n");
  const rsOu = (v) => (v == null ? "—" : rs(v)), pctOu = (v) => (v == null || !isFinite(v) ? "—" : pct(v));

  // ----- gráficos responsivos -----
  // Cada gráfico é desenhado na largura real do quadro (1 unidade do SVG = 1 px, o texto não encolhe nem cresce),
  // nunca mais largo que ele (sem barra de rolagem), e redesenhado quando o quadro muda de largura (janela, celular, PDF).
  // Todo valor aparece: na horizontal se couber, senão na vertical; os rótulos do eixo inclinam quando não cabem.
  const graficos = new Map();                          // id do quadro → { fn(largura) → svg, larg }
  const obsGraficos = typeof ResizeObserver !== "undefined" ? new ResizeObserver((ents) => ents.forEach((e) => redesenhaGrafico(e.target.id))) : null;
  const larguraDe = (el) => Math.max(260, Math.floor(el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 900));
  function grafico(id, fn, vazio = "") {
    const el = $(id);
    if (!fn) { graficos.delete(id); el.innerHTML = vazio; return; }
    const larg = larguraDe(el);
    graficos.set(id, { fn, larg });
    el.innerHTML = fn(larg);
    if (obsGraficos && !el.dataset.observado) { obsGraficos.observe(el); el.dataset.observado = "1"; }
  }
  function redesenhaGrafico(id) {
    const g = graficos.get(id), el = $(id);
    if (!g || !el || !el.offsetParent) return;         // escondido: redesenha quando a aba for desenhada de novo
    const larg = larguraDe(el);
    if (Math.abs(larg - g.larg) < 6) return;
    g.larg = larg;
    el.innerHTML = g.fn(larg);
  }
  // largura de um texto na fonte do painel, medida no navegador (sem canvas: estimativa pelo nº de letras)
  const ctxTexto = document.createElement("canvas").getContext("2d");
  const fonteGraficos = () => getComputedStyle(document.body).getPropertyValue("--fonte").trim() || "sans-serif";
  function larguraTexto(t, px = 11.5, negrito = false) {
    if (!ctxTexto) return String(t).length * px * (negrito ? 0.6 : 0.56);
    ctxTexto.font = `${negrito ? 700 : 400} ${px}px ${fonteGraficos()}`;
    return ctxTexto.measureText(String(t)).width;
  }
  // a fonte do site chega depois: redesenha os gráficos com as medidas dela
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => graficos.forEach((g, id) => { const el = $(id); if (el && el.offsetParent) el.innerHTML = g.fn(g.larg); }));
  // corta o texto (com "…") para caber na largura dada
  function cortaTexto(t, w, px = 11.5) {
    t = String(t);
    if (larguraTexto(t, px) <= w) return t;
    while (t.length > 1 && larguraTexto(t + "…", px) > w) t = t.slice(0, -1);
    return t + "…";
  }
  // eixo das categorias: na horizontal se couber; senão, inclinado (devolve o espaço extra que precisa embaixo)
  function eixoX(cats, x, passo, y) {
    const maior = Math.max(0, ...cats.map((c) => larguraTexto(c)));
    if (maior + 8 <= passo) return { svg: cats.map((c, i) => `<text class="x" x="${x(i)}" y="${y}">${esc(c)}</text>`).join(""), extra: 0, pad: 0 };
    return { svg: cats.map((c, i) => `<text class="x-rot" transform="translate(${x(i) + 4},${y - 8}) rotate(-35)">${esc(c)}</text>`).join(""),
      extra: Math.ceil(maior * 0.6), pad: Math.max(0, Math.ceil(maior * 0.82 - x(0))) };   // pad: o 1º rótulo inclinado não sai pela esquerda
  }
  // largura útil e eixo: a margem dos rótulos inclinados sai da largura do quadro (o gráfico nunca fica mais largo que ele)
  function ajustaEixo(cats, W, y) {
    const n = Math.max(1, cats.length), calc = (larg) => ({ larg, passo: larg / n, ex: eixoX(cats, (i) => (larg / n) * i + larg / n / 2, larg / n, y) });
    let r = calc(W);
    for (let t = 0; t < 3 && r.larg + r.ex.pad > W; t++) r = calc(W - r.ex.pad - 2);   // a margem cresce um pouco quando as colunas estreitam
    return r;
  }
  // abre o SVG com a margem esquerda do eixo (o conteúdo é deslocado para a direita)
  const abreSvg = (larg, alt, pad, extra = "") => `<svg width="${larg + pad}" height="${alt}" viewBox="0 0 ${larg + pad} ${alt}"${extra}><g transform="translate(${pad},0)">`;
  // rótulo de valor: na horizontal (x, y = centro e base do texto) ou na vertical, subindo (y = onde começa) ou descendo.
  // fundo: caixa branca atrás do número, para uma linha que passe por ali não atrapalhar a leitura (Pareto e linhas)
  function rotuloValor(cls, px, modo, x, y, txt, desce = false, fundo = false) {
    const w = larguraTexto(txt, px, true), caixa = (x0) => (fundo ? `<rect class="fundo-rot" x="${x0 - 2}" y="${-px + 1}" width="${w + 4}" height="${px + 2}" rx="2"/>` : "");
    if (modo === "h") return `<g transform="translate(${x},${y})">${caixa(-w / 2)}<text class="${cls}" style="font-size:${px}px">${txt}</text></g>`;
    return `<g transform="translate(${x + px * 0.36},${y}) rotate(-90)">${caixa(desce ? -w : 0)}<text class="${cls} ${desce ? "rve" : "rv"}" style="font-size:${px}px">${txt}</text></g>`;
  }

  // Barras agrupadas, com o valor em todas as barras:
  //  - em pé, com o valor na horizontal (fonte 10 ou 9) se couber sobre a barra sem encostar na vizinha; senão na vertical;
  //  - barras finas demais até para o valor na vertical (celular, muitos dias): barras deitadas, uma linha por categoria,
  //    que crescem para baixo em vez de rolar para o lado.
  // o = { cats, sub (2ª linha do rótulo, opcional), series: [[valores, classe | (i) => classe, nome]], rotulo, exato (valor no balão;
  //       padrão R$), titulo(i) (texto do balão, opcional: padrão = categoria e o valor exato de cada série),
  //       sobre({ cx, base, plot, larg }) → svg desenhado por cima das barras e por baixo dos valores (ex.: a linha do Pareto) }
  // null = sem dado; valor 0 não tem barra nem rótulo.
  function barras(o, W) {
    const k = o.series.length, n = Math.max(1, o.cats.length), plot = 180;
    const vals = o.series.flatMap(([v]) => v.filter((x) => x != null && x !== 0)), max = Math.max(1e-9, ...vals.map((x) => Math.max(0, x)));
    const lvDe = (px) => Math.max(0, ...vals.map((x) => larguraTexto(o.rotulo(x), px, true)));
    const cls = (s, i) => (typeof s[1] === "function" ? s[1](i) : s[1]), rotCls = (j) => (j === k - 1 ? "r-at" : "r-ant");
    const exato = o.exato || rs;
    const titulo = (i) => (o.titulo ? o.titulo(i)
      : linhaDica(`${o.cats[i]}${o.sub && o.sub[i] ? ` (${o.sub[i]})` : ""}`, ...o.series.map(([v, , nome], j) => `${nome || `Série ${j + 1}`}: ${v[i] == null ? "—" : exato(v[i])}`)));
    const geo = (larg) => {
      const passo = larg / n, gap = k > 1 ? 2 : 0, bw = Math.max(2, Math.min(46, (passo * (k > 1 ? 0.86 : 0.6) - gap * (k - 1)) / k));
      return { passo, gap, bw, vizinho: k > 1 ? bw + gap : passo * 0.92 };   // espaço até o rótulo da barra ao lado
    };
    const modoDe = (g) => {
      for (const px of [10, 9]) if (lvDe(px) + 3 <= g.vizinho) return { modo: "h", px };
      return g.vizinho >= 11 ? { modo: "v", px: g.vizinho >= 12.5 ? 10 : 9 } : { modo: "deitado", px: 10 };
    };
    let g = geo(W), m = modoDe(g), topo = 0, base = 0, r = null;
    for (let t = 0; t < 3 && m.modo !== "deitado"; t++) {
      topo = m.modo === "v" ? Math.ceil(lvDe(m.px)) + 10 : 20;
      base = topo + plot;
      r = ajustaEixo(o.cats, W, base + 18);
      g = geo(r.larg);
      const m2 = modoDe(g);
      if (m2.modo === m.modo && m2.px === m.px) break;
      m = m2;
    }
    if (m.modo !== "deitado") {
      const { larg, ex } = r, cx = (i) => g.passo * i + g.passo / 2, sub = o.sub && !ex.extra;
      const alt = base + 24 + (sub ? 14 : 0) + ex.extra;
      let svgB = "", svgR = "";
      o.cats.forEach((_, i) => {
        const x0 = cx(i) - (k * g.bw + (k - 1) * g.gap) / 2;
        let gb = `<g class="alvo" data-dica="${esc(titulo(i))}"><rect class="hit" x="${cx(i) - g.passo / 2}" y="0" width="${g.passo}" height="${base + 4}"/>`;
        o.series.forEach((s, j) => {
          const v = s[0][i];
          if (v == null || v === 0) return;
          const h = (plot * Math.max(0, v)) / max, x = x0 + j * (g.bw + g.gap), topoB = base - h;
          gb += `<rect class="${cls(s, i)}" x="${x}" y="${topoB}" width="${g.bw}" height="${h}" rx="2"/>`;
          svgR += rotuloValor(rotCls(j), m.px, m.modo, x + g.bw / 2, topoB - 4, o.rotulo(v), false, !!o.fundo);
        });
        svgB += gb + "</g>";
        if (sub && o.sub[i]) svgB += `<text class="x2" x="${cx(i)}" y="${base + 32}">${o.sub[i]}</text>`;
      });
      const sobre = o.sobre ? o.sobre({ cx, base, plot, larg }) : "";
      return abreSvg(larg, alt, ex.pad) + `<line x1="0" y1="${base}" x2="${larg}" y2="${base}" class="eixo"/>` + svgB + sobre + svgR + ex.svg + "</g></svg>";
    }
    // barras deitadas: nome da categoria à esquerda, uma barra por série e o valor logo depois da barra
    const larg = Math.max(260, W), limite = Math.round(larg * 0.34), comSub = (i) => o.cats[i] + (o.sub && o.sub[i] ? ` · ${o.sub[i]}` : "");
    const maiorDe = (f) => Math.ceil(Math.max(...o.cats.map((_, i) => larguraTexto(f(i))))) + 10;
    const nomeCat = maiorDe(comSub) <= limite ? comSub : (i) => o.cats[i];   // sem espaço: só o nome (a data fica no balão)
    const esq = Math.min(limite, maiorDe(nomeCat));
    const lv = Math.ceil(lvDe(10)) + 8;
    const faixa = Math.max(20, larg - esq - lv), bh = k > 1 ? 10 : 14, linha = k * (bh + 3) + 9, alt = n * linha + 4;
    let svg = `<svg width="${larg}" height="${alt}" viewBox="0 0 ${larg} ${alt}"><line x1="${esq}" y1="0" x2="${esq}" y2="${alt}" class="eixo"/>`;
    o.cats.forEach((_, i) => {
      const y0 = i * linha + 4, nome = cortaTexto(nomeCat(i), esq - 10);
      svg += `<g class="alvo" data-dica="${esc(titulo(i))}"><rect class="hit" x="0" y="${y0 - 3}" width="${larg}" height="${linha}"/>`
        + `<text class="x-cat" x="${esq - 6}" y="${y0 + (k * (bh + 3)) / 2 + 3}">${esc(nome)}</text>`;
      o.series.forEach((s, j) => {
        const v = s[0][i];
        if (v == null || v === 0) return;
        const w = (faixa * Math.max(0, v)) / max, y = y0 + j * (bh + 3);
        svg += `<rect class="${cls(s, i)}" x="${esq}" y="${y}" width="${w}" height="${bh}" rx="2"/>`
          + `<text class="${rotCls(j)} rh" x="${esq + w + 4}" y="${y + bh - 1}">${o.rotulo(v)}</text>`;
      });
      svg += "</g>";
    });
    return svg + "</svg>";
  }
  const svgBarras = (cats, series, rotulo, W, extra = {}) => barras({ cats, series, rotulo, ...extra }, W);

  // Linhas, com o valor em todos os pontos: em cada categoria, o valor da série mais alta fica acima do ponto e o da mais
  // baixa, abaixo (não se sobrepõem); na horizontal se couber entre os pontos vizinhos, senão na vertical.
  // o.dica(i): texto do balão de cada categoria (padrão: o valor de cada série; nome no 3º item da série)
  function svgLinhas(cats, series, rotulo, W, o = {}) {
    const n = Math.max(1, cats.length), plot = 170, vals = series.flatMap(([v]) => v.filter((x) => x != null));
    const max = Math.max(0.01, ...vals), min = Math.min(-0.01, ...vals);
    const lvDe = (px) => Math.max(0, ...vals.map((v) => larguraTexto(rotulo(v), px, true)));
    const modoDe = (passo) => {
      for (const px of [10, 9]) if (lvDe(px) + 4 <= passo) return { modo: "h", px };
      return { modo: "v", px: passo >= 13 ? 10 : 9 };
    };
    let m = modoDe(W / n), r = null, margem = 0;
    for (let t = 0; t < 3; t++) {
      margem = m.modo === "h" ? 22 : Math.ceil(lvDe(m.px)) + 14;
      r = ajustaEixo(cats, W, margem + plot + margem + 14);
      const m2 = modoDe(r.passo);
      if (m2.modo === m.modo && m2.px === m.px) break;
      m = m2;
    }
    const { larg, passo, ex } = r, topo = margem, alt = margem + plot + margem + 22 + ex.extra;
    const y = (v) => topo + ((max - v) / (max - min)) * plot, x = (i) => passo * i + passo / 2;
    const abaixo = (j, i) => series.some(([v], jj) => jj !== j && v[i] != null && (v[i] > series[j][0][i] || (v[i] === series[j][0][i] && jj < j)));
    let linhas = "", pontos = "", rots = "", alvos = "";
    cats.forEach((c, i) => {
      const txt = o.dica ? o.dica(i) : linhaDica(c, ...series.map(([v, , nome], j) => `${nome || `Série ${j + 1}`}: ${v[i] == null ? "—" : rotulo(v[i])}`));
      alvos += `<g class="alvo" data-dica="${esc(txt)}"><rect class="hit" x="${passo * i}" y="0" width="${passo}" height="${alt - ex.extra - 6}"/></g>`;
    });
    series.forEach(([v, cls], j) => {
      const pts = v.map((p, i) => (p == null ? null : `${x(i)},${y(p)}`)).filter(Boolean);
      if (pts.length > 1) linhas += `<polyline class="${cls}" points="${pts.join(" ")}"/>`;
      v.forEach((p, i) => {
        if (p == null) return;
        const yy = y(p), ab = abaixo(j, i);
        pontos += `<circle class="${cls}" cx="${x(i)}" cy="${yy}" r="4"/>`;
        rots += rotuloValor(`r-at rl-${cls}`, m.px, m.modo, x(i), m.modo === "h" ? (ab ? yy + 8 + m.px : yy - 8) : (ab ? yy + 8 : yy - 8), rotulo(p), ab, true);
      });
    });
    return abreSvg(larg, alt, ex.pad) + alvos + `<line x1="0" y1="${y(0)}" x2="${larg}" y2="${y(0)}" class="eixo"/>` + linhas + pontos + rots + ex.svg + "</g></svg>";
  }

  // ----- Dados: os números por trás do que está na tela -----
  function desenhaDados() {
    const d = E.res.dados, mi = idxMes(E.mes), cal = C.calendario(E.mes), mk = marcas();
    const tot = C.totalDoMes(d, mi, mk, selCalc()), orc = filtroParcial() ? null : orcadoMensal(E.mes, E.sup), cv = curvaDoMes(E.mes, E.sup);
    const feriados = cal.dias.filter((x) => x.feriado).map((x) => dataBR(x.data));
    const marcados = C.diasDaMascara(E.sel).filter((k) => k <= cal.uteis);
    const datas = marcados.map((k) => (k ? dataBR(cal.dataDoDia[k]) : "fins de semana e feriados")).join(", ");
    const nArq = E.res.arquivos.filter((a) => a.tipo === "diaria" || a.tipo === "acumulada").length;
    const linhas = [
      ["Mês", `${C.rotuloMes(E.mes)}: ${cal.uteis} dias úteis e ${cal.naoUteis} dias de fim de semana ou feriado`],
      ["Feriados no mês", feriados.length ? feriados.join(", ") : "nenhum"],
      ["Dias úteis marcados", `${rotuloDias()}${datas ? ` (${datas})` : ""}`],
      ["Arrecadação nos dias", `${rs(tot.valor - tot.desconto)} de Val. Autenticado − ${rs(-tot.desconto)} de desconto = ${rs(tot.valor)}`],
      ["Contas pagas e clientes", `${fmt(tot.contas)} contas pagas · ${fmt(tot.clientes)} clientes distintos · ticket ${tot.contas ? fmt(tot.valor / tot.contas, 2) : "—"}`],
      ["Orçado mensal", orc ? (orc.valor != null ? `${rs(orc.valor)} (${esc(orc.fonte)})` : "sem orçado no mês para o orçado escolhido") : "por superintendência (escolha Cidade e Subcategoria = Todas)"],
      ["Curva do orçado", cv.mesesMedia.length ? `média de ${cv.mesesMedia.map(C.rotuloMes).join(", ")}${cv.editada ? " · pesos editados no painel" : ""}` : "sem meses anteriores: dividida igualmente"],
      ["Leitura", `${nArq} arquivo(s) de arrecadação · ${fmt(d.linhas)} linhas usadas · crédito até ${dataBR(d.ultimoCredito[d.meses[d.meses.length - 1]])}`],
    ];
    $("dadosFiltros").textContent = filtroTexto();
    $("dadosParametros").innerHTML = `<table class="explica"><tbody>${linhas.map(([a, b]) => `<tr><td class="rot"><b>${a}</b></td><td class="rot">${b}</td></tr>`).join("")}</tbody></table>`
      + `<details class="arquivos-dados"><summary>Arquivos lidos e avisos</summary>${E.htmlArquivos || ""}</details>`;
    desenhaTabelaBI();
  }

  // Tabela no formato do BI (aba Dados): Cidade, Subcategoria, Mes/ano, Classificação (perfil), IsGrandTotalRowTotal,
  // Arrecadacao_Acumulada, Qtd_clientes_pagantes_acumulado e Qtd_Clientes_pagas_mês_anterior, nos dias marcados e filtros do
  // cabeçalho, nos meses marcados no filtro Mês. A última linha é o total geral (IsGrandTotalRowTotal = VERDADEIRO), com a soma das linhas.
  const BI_COLUNAS = ["Cidade", "Subcategoria", "Mes/ano", "Classificação", "IsGrandTotalRowTotal", "Arrecadacao_Acumulada",
    "Qtd_clientes_pagantes_acumulado", "Qtd_Clientes_pagas_mês_anterior", "Qtd_contas_pagas_acumulado"];
  const mesesDoBI = () => E.meses.filter((m) => E.res.dados.meses.includes(m));   // os meses marcados no filtro Mês
  function linhasBI() {
    const ms = mesesDoBI();
    return C.tabelaBI(E.res.dados, marcas(), selCalc()).filter((x) => ms.includes(x.mes));
  }
  function desenhaTabelaBI() {
    const ms = mesesDoBI(), l = linhasBI();
    const soma = (k) => l.reduce((a, x) => a + (x[k] || 0), 0), td = (v, c = "") => `<td${c ? ` class="${c}"` : ""}>${v}</td>`;
    const rotMeses = ms.length <= 3 ? ms.map(C.rotuloMes).join(", ") : `${ms.length} meses`;
    $("biResumo").textContent = `${filtroTexto()} · ${rotMeses || "nenhum mês"} · ${rotuloDias()} · ${fmt(l.length)} linhas`;
    $("biTabela").innerHTML = l.length ? `<table class="compacta base-tabela"><thead><tr>${BI_COLUNAS.filter((c) => c !== "IsGrandTotalRowTotal").map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>`
      + l.map((x) => `<tr>${td(esc(x.cidade), "rot")}${td(esc(x.grupo), "rot")}${td(C.rotuloMes(x.mes), "rot")}${td(esc(x.perfil), "rot")}${td(fmt(x.valor, 2))}${td(fmt(x.clientes))}${td(x.clientesAnt == null ? "—" : fmt(x.clientesAnt))}${td(fmt(x.contas))}</tr>`).join("")
      + `<tr class="total">${td("Total", "rot")}${td("", "rot")}${td("", "rot")}${td("", "rot")}${td(fmt(soma("valor"), 2))}${td(fmt(soma("clientes")))}${td(fmt(soma("clientesAnt")))}${td(fmt(soma("contas")))}</tr></tbody></table>`
      : `<p class="aviso-pdf">${ms.length ? "Sem arrecadação nos meses marcados para os filtros e dias marcados." : "Marque pelo menos um mês."}</p>`;
  }
  async function baixaTabelaBI() {
    try { await carregaXLSX(); } catch (e) { toast("Não foi possível carregar a biblioteca de planilhas.", true); return; }
    const X = window.XLSX, t = linhasBI(), ms = mesesDoBI();
    if (!ms.length) { toast("Marque pelo menos um mês.", true); return; }
    const soma = (k) => t.reduce((a, x) => a + (x[k] || 0), 0);
    const linhas = [BI_COLUNAS, ...t.map((x) => [x.cidade, x.grupo, new Date(+x.mes.slice(0, 4), +x.mes.slice(5, 7) - 1, 1), x.perfil, false,
      x.valor, x.clientes, x.clientesAnt == null ? null : x.clientesAnt, x.contas]), ["", "", null, "", true, soma("valor"), soma("clientes"), soma("clientesAnt"), soma("contas")]];
    const ws = X.utils.aoa_to_sheet(linhas, { cellDates: true });
    for (let r = 1; r < linhas.length; r++) {
      const m = ws[X.utils.encode_cell({ r, c: 2 })], v = ws[X.utils.encode_cell({ r, c: 5 })];
      if (m) m.z = "mm/yyyy";
      if (v) v.z = "#,##0.00";
      for (const c of [6, 7, 8]) { const q = ws[X.utils.encode_cell({ r, c })]; if (q) q.z = "#,##0"; }
    }
    ws["!cols"] = [{ wch: 22 }, { wch: 18 }, { wch: 9 }, { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
    ws["!autofilter"] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: linhas.length - 1, c: BI_COLUNAS.length - 1 } }) };
    const info = X.utils.aoa_to_sheet([
      ["Filtros", filtroTexto()], ["Dias úteis marcados", rotuloDias()], ["Meses", ms.map(C.rotuloMes).join(", ")],
      ["Classificação", "perfil de pagamento (Cluster Saldo)"],
      ["Arrecadacao_Acumulada", "Val. Autenticado com o desconto comercial, nos dias marcados do mês"],
      ["Qtd_clientes_pagantes_acumulado", "ligações distintas que pagaram nos dias marcados (como o DISTINCTCOUNT do BI)"],
      ["Qtd_Clientes_pagas_mês_anterior", "o mesmo, na mesma linha, no mês anterior; em branco quando o mês anterior não está na pasta"],
      ["Qtd_contas_pagas_acumulado", "contas pagas (Tipo Fatura 1-NOTA FISCAL MENSAL e 2-NOTA FISCAL AVULSA) nos dias marcados do mês, como no Resumo"],
      ["Linha de total (IsGrandTotalRowTotal = VERDADEIRO)", "soma das linhas: um cliente que pagou em mais de uma linha conta em cada uma"],
      ["Gerado em", new Date().toLocaleString("pt-BR")], ["Versão do painel", VERSAO_SITE],
    ]);
    info["!cols"] = [{ wch: 40 }, { wch: 90 }];
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, "Tabela");
    X.utils.book_append_sheet(wb, info, "Informações");
    X.writeFile(wb, `Tabela_BI_arrecadacao_${ms.length > 1 ? `${ms[0]}_a_${ms[ms.length - 1]}` : ms[0]}_${filtroTexto("_").replace(/[^\wÀ-ú+-]+/g, "_")}.xlsx`);
    $("biStatus").textContent = `${fmt(t.length)} linhas baixadas`;
  }
  $("biBaixar").addEventListener("click", baixaTabelaBI);

  // ===== One page: acompanhamento da arrecadação numa folha vertical (mesmo modelo do painel de faturamento água e esgoto;
  // lê bem no celular; PDF de uma página). Segue os filtros do cabeçalho e os dias úteis marcados (com o fechamento do mês).
  // Arrecadação = Val. Autenticado com o desconto comercial (como no Resumo); por dia útil, sem o desconto (o total o desconta).
  // Orçado até o dia = orçado mensal × parte da curva nos dias marcados; tendência = projeção pelos meses com os mesmos dias
  // úteis (aba Diagnóstico por localidade). A folha não tem nada editável.
  const OP_W = 900, OP_RELEVANTE = 0.03, OP_MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  let opAbertas = null, opChaveTop = "", idOnePage = 0, opTop = null;
  const opMes = (m) => `${OP_MESES[+m.slice(5, 7) - 1]}/${m.slice(2, 4)}`;
  function opMoeda(v, dec) {
    if (v == null || !isFinite(v)) return "–";
    const a = Math.abs(v), s = v < 0 ? "-" : "";
    if (a >= 1e6) return `${s}R$ ${fmt(a / 1e6, dec == null ? 2 : dec)} mi`;
    if (a >= 1e3) return `${s}R$ ${fmt(a / 1e3, dec == null ? 1 : dec)} mil`;
    return `${s}R$ ${fmt(a)}`;
  }
  const opPct = (v, sinal) => (v == null || !isFinite(v) ? "–" : (sinal && v > 0 ? "+" : "") + fmt(v * 100, 1) + "%");
  const opVar = (a, b) => (a == null || b == null || !b ? null : (a - b) / Math.abs(b));
  function opSeta(v, rot = "") {                       // ▲ 3,5% vs Set/26 — com cor só quando o desvio passa de 3%
    if (v == null || !isFinite(v)) return `<span class="op-var">– ${esc(rot)}</span>`;
    const cls = Math.abs(v) < OP_RELEVANTE ? "" : v > 0 ? " op-pos" : " op-neg";
    return `<span class="op-var${cls}">${v > 0 ? "▲" : v < 0 ? "▼" : "■"} ${opPct(Math.abs(v))} ${esc(rot)}</span>`;
  }
  // orçado mensal de uma planilha RF para a superintendência ("" = soma das superintendências)
  function orcadoDaFonte(mes, sup, fonte) {
    const sups = sup ? [sup] : supsDisponiveis().filter((s) => R.SUPS.includes(s));
    const l = E.res.orcados.filter((o) => o.fonte === fonte && o.mes === mes && sups.includes(o.sup));
    return l.length ? l.reduce((a, o) => a + o.valor, 0) : null;
  }
  // semana do calendário (domingo a sábado) de uma data do mês: { n, rot: "05 a 11/10" }
  function opSemana(iso) {
    const d = new Date(iso + "T12:00:00"), desl = new Date(d.getFullYear(), d.getMonth(), 1, 12).getDay();
    const n = Math.floor((d.getDate() + desl - 1) / 7) + 1, ult = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const ini = Math.max(1, (n - 1) * 7 - desl + 1), fim = Math.min(ult, n * 7 - desl), p2 = (x) => String(x).padStart(2, "0");
    return { n, rot: `${p2(ini)} a ${p2(fim)}/${iso.slice(5, 7)}` };
  }

  function opDados() {
    const d = E.res.dados, mi = idxMes(E.mes), mk = marcas(), sel = selCalc(), cal = C.calendario(E.mes), U = cal.uteis;
    const ant = C.mesAnterior(E.mes), miAnt = idxMes(ant), dias = C.diasDaMascara(sel).filter((k) => k <= U);
    const tot = C.totalDoMes(d, mi, mk, sel), totA = miAnt >= 0 ? C.totalDoMes(d, miAnt, mk, sel) : null;
    const s = C.serieDoMes(d, mi, mk), sa = miAnt >= 0 ? C.serieDoMes(d, miAnt, mk) : null;
    const parcial = filtroParcial(), orc = parcial || !E.verOrcado ? { valor: null, fonte: "" } : orcadoMensal(E.mes, E.sup), cv = curvaDoMes(E.mes, E.sup);
    const fracCurva = dias.reduce((a, k) => a + (cv.pesos[k] || 0), 0);
    const mm = C.mesesMesmosUteis(d, E.mes), frT = C.fracaoAteDias(d, mm.meses, mk, sel, () => "T").get("T");
    // mês anterior contra o orçado dele (mesma planilha RF), nos mesmos dias úteis: "Setembro/26: R$ 10,03 Mi (-7,7% vs RF3T25)"
    let orcAntAte = null;
    if (orc.valor != null && orc.fonte && orc.fonte !== DIGITADO && totA) {
      const oA = orcadoDaFonte(ant, E.sup, orc.fonte), pA = curvaDoMes(ant, E.sup).pesos, uA = C.calendario(ant).uteis;
      if (oA != null) orcAntAte = oA * C.diasDaMascara(sel).filter((k) => k <= uA).reduce((a, k) => a + (pA[k] || 0), 0);
    }
    return { d, mi, miAnt, mk, sel, cal, U, ant, dias, tot, totA, s, sa, parcial, orc, cv, fracCurva, mm, orcAntAte,
      orcAte: orc.valor != null ? orc.valor * fracCurva : null, proj: frT > 0 ? tot.valor / frT : null, frT,
      ult: d.ultimoCredito[E.mes], N: ultimoDiaComDados(E.mes),
      nUteis: dias.filter((k) => k > 0 && k <= ultimoDiaComDados(E.mes)).length };
  }

  // Modelo do One page (o mesmo feito hoje no PowerPoint): título "INTERIOR: ACOMPANHAMENTO DIÁRIO – 30/10/26", arrecadação
  // contra o orçado (RF), quadros das planilhas RF até o dia, acompanhamento semanal e diário, gráfico, volumes acumulados
  // contra o mês anterior e Top 5 pagantes e inadimplentes. Economias e maiores inadimplentes vêm do BI: prints colocados na
  // pasta "One Page" (imagem ou Excel com as imagens; ver lePrintsOnePage).
  const OP_MESES_LONGOS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const opMesLongo = (m) => OP_MESES_LONGOS[+m.slice(5, 7) - 1];
  const opMi = (v) => (v == null || !isFinite(v) ? "–" : fmt(v / 1e6, 2) + " Mi");
  const opRsMi = (v) => (v == null || !isFinite(v) ? "–" : `${v < 0 ? "-" : ""}R$ ${fmt(Math.abs(v) / 1e6, 2)} Mi`);
  const opDiaMes = (iso) => `${iso.slice(8, 10)}/${OP_MESES[+iso.slice(5, 7) - 1].toLowerCase()}`;
  const opSemDia = (iso) => ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][new Date(iso + "T12:00:00").getDay()];
  function opDelta(v, extra = "", grande = false) {     // ▼ -9,1% (vermelho) / ▲ +29,7% (verde)
    if (v == null || !isFinite(v)) return `<span class="op-var">–${extra ? " " + extra : ""}</span>`;
    return `<span class="op-var ${v >= 0 ? "op-pos" : "op-neg"}${grande ? " op-grande" : ""}">${v >= 0 ? "▲" : "▼"} ${v > 0 ? "+" : ""}${fmt(v * 100, 1)}%${extra ? " " + extra : ""}</span>`;
  }

  // ---- Arrecadação: realizado até o dia contra o orçado no período e a meta do mês ----
  const opBarra = (rot, dir, frac, cls) => `<div class="op-barra-lin"><span>${rot}</span><span>${dir}</span></div>`
    + `<div class="op-barra${cls ? " " + cls : ""}"><i style="width:${Math.max(0, Math.min(1, frac || 0)) * 100}%"></i></div>`;
  function opBlocoDestaque(D) {
    const A = D.tot.valor, temOrc = D.orcAte != null && D.orcAte > 0, ultTxt = D.ult ? dataBR(D.ult).slice(0, 5) : "—";
    const base = temOrc ? D.orcAte : D.totA ? D.totA.valor : null, dv = opVar(A, base);
    const fonte = esc(D.orc.fonte === DIGITADO ? "orçado digitado" : D.orc.fonte);
    let h = `<div class="op-hero"><div class="op-hero-esq"><span class="op-rot">Realizado até ${ultTxt}</span><b class="op-hero-val">${opRsMi(A)}</b></div>`
      + `<div class="op-hero-dir">${opDelta(dv, "", true)}<span>${base == null ? "sem orçado e sem mês anterior"
        : temOrc ? `vs ${fonte} no período: ${opRsMi(A - base)} (meta ${opRsMi(base)})` : `vs ${opMesLongo(D.ant)} nos mesmos dias úteis: ${opRsMi(A - base)}`}</span></div></div>`;
    const ini = D.dias.find((k) => k > 0), periodo = ini && D.ult ? `${dataBR(D.cal.dataDoDia[ini]).slice(0, 5)} a ${ultTxt}` : "—";
    if (temOrc) {
      h += opBarra(`Parcial · ${periodo} (${D.nUteis} dias úteis)`, `${opRsMi(A)} de ${opRsMi(D.orcAte)} · ${opPct(A / D.orcAte)}`, A / D.orcAte);
      h += opBarra(`Meta final do mês (${fonte})`, `${opRsMi(A)} de ${opRsMi(D.orc.valor)} · ${opPct(A / D.orc.valor)}`, A / D.orc.valor, "op-barra-clara");
    } else if (D.parcial && E.verOrcado) h += '<p class="op-nota">O orçado é por superintendência: com Cidade ou Subcategoria escolhida, a comparação é com o mês anterior.</p>';
    const antTxt = D.totA ? `${opMesLongo(D.ant)[0].toUpperCase() + opMesLongo(D.ant).slice(1)}/${D.ant.slice(2, 4)}: ${opRsMi(D.totA.valor)}`
      + (D.orcAntAte ? ` (${opPct(opVar(D.totA.valor, D.orcAntAte), true)} vs ${D.orc.fonte})` : "") : "";
    return { html: h, ant: antTxt };
  }
  // Quadros: cada planilha RF do mês (até 4, da mais antiga para a mais nova) até o dia, contra o realizado
  function opBlocoCards(D) {
    const A = D.tot.valor, quadros = [], ultTxt = D.ult ? dataBR(D.ult).slice(0, 5) : "—";
    if (!D.parcial && E.verOrcado) {
      const rfs = fontesOrcado().filter((f) => orcadoDaFonte(E.mes, E.sup, f) != null).slice(0, 4).reverse();
      for (const f of rfs) {
        const ate = orcadoDaFonte(E.mes, E.sup, f) * D.fracCurva;
        quadros.push(`<div class="op-card"><span class="op-rot">${esc(f)} – até ${ultTxt}</span><b>${opRsMi(ate)}</b>`
          + `${opDelta(opVar(A, ate), `realizado vs ${f === D.orc.fonte ? "orçado" : esc(f)}`)}</div>`);
      }
    }
    if (!quadros.length) {                              // sem orçado: mês anterior e tendência
      if (D.totA) quadros.push(`<div class="op-card"><span class="op-rot">${opMes(D.ant)} – mesmos dias úteis</span><b>${opRsMi(D.totA.valor)}</b>`
        + `${opDelta(opVar(A, D.totA.valor), "realizado vs " + opMes(D.ant))}</div>`);
      if (D.proj != null) quadros.push(`<div class="op-card"><span class="op-rot">Tendência – ${opMes(E.mes)}</span><b>${opRsMi(D.proj)}</b>`
        + (D.miAnt >= 0 ? opDelta(opVar(D.proj, C.totalDoMes(D.d, D.miAnt, D.mk, C.MASCARA_MES).valor), `vs ${opMes(D.ant)} fechado`) : "")
        + `<small class="op-explica">Projeção pelos meses com os mesmos dias úteis (${D.mm.meses.map(opMes).join(", ") || "—"}): neles, até este dia útil já tinha entrado ${opPct(D.frT)} do mês; ${opRsMi(A)} ÷ ${opPct(D.frT)}.</small></div>`);
    }
    return quadros.length ? `<div class="op-cards">${quadros.join("")}</div>` : "";
  }

  // ---- Acompanhamento semanal e diário: semanas (domingo a sábado) dos dias úteis marcados; as duas últimas com dados
  // detalhadas (clique abre ou fecha). Base = orçado do dia pela curva (sem orçado: o mês anterior no mesmo dia útil) ----
  function opSemanas(D) {
    const temOrc = D.orc.valor != null, mapa = new Map();
    const base = (k) => (temOrc ? (D.cv.pesos[k] || 0) * D.orc.valor : D.sa ? D.sa.valor[k] : null);
    for (const k of D.dias) {
      const linha = { k, r: D.s.valor[k], b: base(k), lido: k === 0 || k <= D.N };
      if (k === 0) { linha.rot = `Fins de semana e feriados (${D.cal.naoUteis} dias)`; mapa.set(99, { n: 99, rot: "mês inteiro", dias: [linha] }); continue; }
      const iso = D.cal.dataDoDia[k], sem = opSemana(iso);
      linha.rot = `${opDiaMes(iso)} – ${opSemDia(iso)}`;
      if (!mapa.has(sem.n)) mapa.set(sem.n, { n: sem.n, rot: sem.rot, dias: [] });
      mapa.get(sem.n).dias.push(linha);
    }
    const soma = (l, c) => (l.some((x) => x[c] != null) ? l.reduce((t, x) => t + (x[c] || 0), 0) : null);
    const lista = [...mapa.values()].sort((a, b) => a.n - b.n);
    lista.forEach((w) => { const lidos = w.dias.filter((x) => x.lido); w.r = soma(lidos, "r"); w.b = soma(w.dias, "b"); w.lidos = lidos.length; });
    return lista;
  }
  function opBlocoSemanas(D, S) {
    if (!S.length) return '<p class="op-vazio">Nenhum dia útil marcado.</p>';
    if (opAbertas === null) opAbertas = new Set(S.filter((w) => w.n !== 99 && w.lidos).slice(-2).map((w) => w.n));   // as duas últimas semanas com dados abertas
    const temOrc = D.orc.valor != null, pre = temOrc ? esc(D.orc.fonte === DIGITADO ? "Orç." : D.orc.fonte.replace(/T\d+$/, "")) + " " : "";
    const cols = (o, lido = true) => `<td class="num op-base">${o.b != null ? pre + opMi(o.b) : "–"}</td>`
      + `<td class="num op-forte">${lido ? opMi(o.r) : "–"}</td><td class="num">${lido && o.b ? opDelta(opVar(o.r, o.b)) : "–"}</td>`;
    const corpo = S.map((w) => {
      if (w.n === 99) { const x = w.dias[0]; return `<tr class="op-sem op-sem-fixa"><td>${esc(x.rot)}</td>${cols(x)}</tr>`; }
      const aberta = opAbertas.has(w.n), fechada = w.lidos === w.dias.length && w.dias.every((x) => x.k < D.N);
      const estado = aberta ? (fechada ? "detalhada" : "parcial detalhada") : fechada ? "fechada" : w.lidos ? "parcial" : "sem crédito ainda";
      return `<tr class="op-sem${aberta ? " op-aberta" : ""}" data-semana="${w.n}" title="Clique para ${aberta ? "fechar" : "abrir"} os dias desta semana">`
        + `<td><span class="op-seta-sem">${aberta ? "▾" : "▸"}</span><b>Semana ${w.n}</b><small>${esc(w.rot)} · ${estado}</small></td>${cols(w, w.lidos > 0)}</tr>`
        + (aberta ? w.dias.map((x) => `<tr class="op-grp"><td>${esc(x.rot)}${x.lido ? "" : " <small>sem crédito ainda</small>"}</td>${cols(x, x.lido)}</tr>`).join("") : "");
    }).join("");
    const T = { r: D.tot.valor, b: temOrc ? D.orcAte : D.totA ? D.totA.valor : null };
    return `<table class="op-tab op-tab-grupos"><thead><tr><th></th><th class="num">${temOrc ? esc(D.orc.fonte === DIGITADO ? "Orçado" : D.orc.fonte) : opMes(D.ant)}</th>`
      + `<th class="num">Realizado</th><th class="num">Δ</th></tr></thead><tbody>${corpo}</tbody>`
      + `<tfoot><tr class="op-tot"><td>Total${D.tot.desconto ? ` <small>com o desconto comercial (${opMoeda(D.tot.desconto, 2)})</small>` : ""}</td>${cols(T)}</tr></tfoot></table>`;
  }
  // Gráfico: orçado do dia em barras (sem orçado: o mês anterior), realizado em linha, em R$ milhões; no alto, a diferença
  function svgOpDias(D, W) {
    const ks = D.dias.filter((k) => k > 0 && k <= D.N), temOrc = D.orc.valor != null;
    if (!ks.length) return '<p class="op-vazio">Sem dia útil com crédito nos dias marcados.</p>';
    const base = (k) => (temOrc ? (D.cv.pesos[k] || 0) * D.orc.valor : D.sa ? D.sa.valor[k] : null), rotBase = temOrc ? `Orçado ${D.orc.fonte}` : opMes(D.ant);
    const mi = (v) => fmt(v / 1e6, 2), cats = ks.map((k) => opDiaMes(D.cal.dataDoDia[k]));
    const rots = ks.flatMap((k) => [mi(D.s.valor[k]), base(k) != null ? (D.s.valor[k] - base(k) > 0 ? "+" : "") + mi(D.s.valor[k] - base(k)) : ""]);
    const lv = Math.max(0, ...rots.map((t) => larguraTexto(t, 10, true)));
    let r = ajustaEixo(cats, W, 0), vert = lv + 4 > r.passo;
    const topoRot = vert ? Math.ceil(lv) + 12 : 18, plot = 170, topo = topoRot + (vert ? Math.ceil(lv) + 8 : 22), baseY = topo + plot;
    r = ajustaEixo(cats, W, baseY + 18);
    const { larg, passo, ex } = r, cx = (i) => passo * i + passo / 2, bw = Math.max(3, Math.min(46, passo * 0.62));
    const max = Math.max(1, ...ks.map((k) => Math.max(D.s.valor[k], base(k) || 0)));
    const y = (v) => baseY - (plot * Math.max(0, v)) / max, px = 10, cabeBase = larguraTexto("0,00", 8.5, false) + 2 <= bw;
    let barras = "", alvos = "", textos = "";
    const pts = ks.map((k, i) => `${cx(i)},${y(D.s.valor[k])}`);
    ks.forEach((k, i) => {
      const b = base(k), v = D.s.valor[k], dif = b != null ? v - b : null, iso = D.cal.dataDoDia[k];
      const dica = linhaDica(`Dia útil ${k} (${dataBR(iso)})`, `Realizado: ${rs(v)}`, `${rotBase}: ${b == null ? "—" : rs(b)}`,
        dif != null && `Diferença: ${rs(dif)}${b ? ` (${pct(dif / b)})` : ""}`, temOrc && D.sa && `${opMes(D.ant)} (mesmo dia útil): ${rs(D.sa.valor[k])}`, "Valores do dia sem o desconto comercial");
      alvos += `<g class="alvo" data-dica="${esc(dica)}"><rect class="hit" x="${cx(i) - passo / 2}" y="0" width="${passo}" height="${baseY + 4}"/></g>`;
      if (b != null) {
        barras += `<rect class="op-b-base" x="${cx(i) - bw / 2}" y="${y(b)}" width="${bw}" height="${baseY - y(b)}" rx="2"/>`;
        if (cabeBase && baseY - y(b) > 14 && baseY - y(v) > 26) textos += `<text class="op-r-base" x="${cx(i)}" y="${baseY - 4}">${mi(b)}</text>`;
      }
      textos += rotuloValor("r-at op-r-real", px, vert ? "v" : "h", cx(i), y(v) - 7, mi(v), false, true);
      if (dif != null) textos += rotuloValor(`op-r-dif ${dif >= 0 ? "op-r-pos" : "op-r-neg"}`, 9.5, vert ? "v" : "h", cx(i), vert ? topoRot - 4 : topoRot, (dif > 0 ? "+" : "") + mi(dif));
    });
    const alt = baseY + 24 + ex.extra;
    return abreSvg(larg, alt, ex.pad) + alvos + `<line x1="0" y1="${baseY}" x2="${larg}" y2="${baseY}" class="eixo"/>` + barras
      + `<polyline class="l-at" points="${pts.join(" ")}"/>` + ks.map((k, i) => `<circle class="l-at" cx="${cx(i)}" cy="${y(D.s.valor[k])}" r="3.5"/>`).join("")
      + textos + ex.svg + "</g></svg>";
  }

  // ---- Volumes acumulados contra o mês anterior (mesmos dias úteis); Economias: print do BI ----
  function opBlocoVolumes(D) {
    const t = D.tot, a = D.totA, mA = opMesLongo(D.ant), dd = `${mA} (${D.nUteis} d.úteis)`;
    const card = (tit, val, atual, anterior, fmtA) => `<div class="op-vol"><span class="op-rot">${tit}</span><b>${val}</b>`
      + (a ? `<small>${dd}: ${fmtA(anterior)}</small>${opDelta(opVar(atual, anterior), "vs " + mA)}` : "<small>sem mês anterior</small>") + "</div>";
    const pr = E.prints.economias;
    const eco = `<div class="op-vol op-vol-print"><span class="op-rot">Economias</span>${pr ? opImagens(pr, "Economias (print do BI)")
      : '<b>–</b><small>do BI: coloque o print na pasta <i>One Page</i></small>'}</div>`;
    return '<div class="op-vols">' + [
      card("Arrecadação", opRsMi(t.valor), t.valor, a && a.valor, opRsMi),
      card("Pagantes", fmt(t.clientes), t.clientes, a && a.clientes, fmt),
      card("Faturas", fmt(t.contas), t.contas, a && a.contas, fmt),
      eco,
    ].join("") + "</div>";
  }
  const opImagens = (lista, alt) => lista.map((p) => `<img class="op-print" src="${p.url}" alt="${esc(alt)}" title="${esc(p.origem)}">`).join("");

  // ---- Top 5: maiores pagantes do mês (o worker calcula) e maiores inadimplentes (print do BI) ----
  function opBlocoTop(D) {
    const combos = E.res.dados.combos, mesTit = `${opMesLongo(E.mes)}/${E.mes.slice(2, 4)}`.toUpperCase();
    const itens = opTop ? opTop.maiores.slice(0, 5) : null;
    const pag = `<div class="op-top op-top-pos"><div class="op-top-tit">Maiores pagantes – ${mesTit}</div>`
      + (itens == null ? '<p class="op-vazio">Calculando…</p>' : itens.length ? itens.map((x, i) => {
        const c = combos[x.c] || {}, dica = linhaDica(x.nome || `Matrícula ${x.lig}`, `Matrícula: ${x.lig}`, `${opMes(E.mes)}: ${rs(x.atual)}`, `${opMes(D.ant)}: ${rs(x.anterior)}`,
          `Cidade: ${c.cidade || "—"}`, `Subcategoria: ${c.grupo || "—"}`, "Nos dias úteis marcados, com o desconto comercial");
        return `<div class="op-top-lin" title="${esc(dica.replace(/\n/g, " · "))}"><span class="op-top-nome">${i + 1}. ${esc(x.nome || "Matrícula " + x.lig)}</span>`
          + `<b>R$ ${fmt(x.atual / 1e3, 2)} Mil</b></div>`;
      }).join("") : '<p class="op-vazio">Sem pagantes.</p>') + "</div>";
    const pr = E.prints.inadimplentes, mAntTit = `${opMesLongo(D.ant)}/${D.ant.slice(2, 4)}`.toUpperCase();
    const ina = `<div class="op-top op-top-neg"><div class="op-top-tit">Maiores inadimplentes – ${mAntTit}</div>`
      + (pr ? `<div class="op-print-caixa">${opImagens(pr, "Maiores inadimplentes (print do BI)")}</div>`
        : '<p class="op-vazio">Vem do BI: coloque o print na pasta <i>One Page</i> (imagem ou Excel com o nome “Inadimplentes”).</p>') + "</div>";
    return `<div class="op-tops">${pag}${ina}</div>`;
  }

  function opSecao(titulo, extra, cls) {
    return `<section class="op-secao${cls ? " " + cls : ""}">${titulo ? `<h3>${titulo}${extra || ""}</h3>` : ""}`;
  }
  function desenhaOnePage() {
    const D = opDados(), filtro = filtroTexto(" · ", "Todas as superintendências");
    const dataCab = D.ult ? dataBR(D.ult).slice(0, 6) + D.ult.slice(2, 4) : opMes(E.mes);
    const dest = opBlocoDestaque(D), S = opSemanas(D), temOrc = D.orc.valor != null;
    const fonte = D.orc.fonte === DIGITADO ? "orçado digitado" : D.orc.fonte;
    const faixa = (l, quais) => (l.length ? `${l.length > 1 ? "semanas" : "semana"} ${l.length > 1 ? `${l.slice(0, -1).join(", ")} e ${l[l.length - 1]}` : l[0]} ${quais}` : "");
    let h = `<header class="op-cab"><h2>${esc(filtro.toUpperCase())}: ACOMPANHAMENTO DIÁRIO – ${esc(dataCab)}</h2></header>`;
    h += opSecao("➤ Arrecadação", dest.ant ? `<small class="op-h-dir">${esc(dest.ant)}</small>` : "") + `<div class="op-painel">${dest.html}</div>${opBlocoCards(D)}</section>`;
    const tabSem = opBlocoSemanas(D, S), nSem = S.filter((w) => w.n !== 99);    // opBlocoSemanas decide as semanas abertas
    const ab = nSem.filter((w) => opAbertas && opAbertas.has(w.n)).map((w) => w.n), fe = nSem.filter((w) => !ab.includes(w.n)).map((w) => w.n);
    h += opSecao(`Acompanhamento semanal e diário – ${temOrc ? esc(fonte) : opMes(D.ant)} x realizado`,
      `<small class="op-h-dir">${[faixa(fe, fe.length > 1 ? "resumidas" : "resumida"), faixa(ab, ab.length > 1 ? "detalhadas" : "detalhada")].filter(Boolean).join(" · ")}</small>`)
      + tabSem + '<div class="grafico op-grafico" id="opGrafico"></div>'
      + `<div class="op-legenda"><span><i class="op-leg-barra"></i>${temOrc ? esc("Orçado " + fonte) : opMes(D.ant)}</span><span><i class="op-leg-linha"></i>Realizado</span>`
      + '<span class="op-leg-nota">em R$ milhões · no alto, a diferença · dia sem o desconto comercial</span></div></section>';
    h += `${opSecao("", "", "op-secao-faixa")}<div class="op-faixa">Volumes acumulados – ${opMesLongo(E.mes)} vs ${opMesLongo(D.ant)} (${D.nUteis} d.úteis)</div>${opBlocoVolumes(D)}</section>`;
    h += opSecao("Top 5 pagantes e inadimplentes", "", "op-secao-top") + `<div id="opTopos">${opBlocoTop(D)}</div></section>`;
    h += `<footer class="op-rodape"><span>Fonte: painel de arrecadação · ${esc(filtro)}. Corte: ${D.ult ? dataBR(D.ult).slice(0, 6) + D.ult.slice(2, 4) : "—"} (${D.nUteis} d.úteis).`
      + ` Comparação: ${opMesLongo(D.ant)}/${D.ant.slice(2, 4)} (${D.nUteis} d.úteis)${temOrc ? ` · orçado ${esc(fonte)}` : ""}`
      + `${E.prints.economias || E.prints.inadimplentes ? " · economias e inadimplentes: BI (pasta One Page)" : ""}`
      + ` · gerado em ${new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</span><b class="op-marca">Águas do Rio</b></footer>`;
    $("opFolha").innerHTML = h;
    $("opPrints").innerHTML = opStatusPrints();
    grafico("opGrafico", (W) => svgOpDias(D, W));
    // Top 5: o worker calcula (mesma análise do Ranking de clientes); refaz só quando os filtros mudam
    const chave = JSON.stringify([E.mes, D.sel, E.sups, E.cidades, E.grupos]);
    if (chave !== opChaveTop) {
      opChaveTop = chave; opTop = null;
      if (worker) worker.postMessage({ tipo: "analise", para: "onepage", id: ++idOnePage, mi: D.mi, miAnt: D.miAnt, marcas: D.mk, sel: D.sel, n: 5 });
    }
  }
  function recebeTopOnePage(m) {
    if (m.id !== idOnePage || m.erro) return;
    opTop = m;
    if (E.aba === "onepage" && $("opTopos")) $("opTopos").innerHTML = opBlocoTop(opDados());
  }
  $("opFolha").addEventListener("click", (e) => {
    const tr = e.target.closest("tr.op-sem[data-semana]");
    if (!tr) return;
    const n = +tr.dataset.semana;
    if (opAbertas.has(n)) opAbertas.delete(n); else opAbertas.add(n);
    desenhaOnePage();
  });

  // PDF de uma página (largura de uma A4; a altura acompanha a folha): a folha é copiada numa largura fixa, o gráfico é
  // redesenhado nela e vira imagem (o html2canvas não aplica o CSS dentro do SVG), e a cópia é fotografada.
  const PROPS_SVG = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linejoin", "paint-order", "font-family", "font-size",
    "font-weight", "text-anchor", "opacity", "visibility"];
  function svgParaImagem(svg) {
    const clone = svg.cloneNode(true), orig = [svg, ...svg.querySelectorAll("*")], dest = [clone, ...clone.querySelectorAll("*")];
    orig.forEach((el, i) => { const cs = getComputedStyle(el); dest[i].setAttribute("style", PROPS_SVG.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";")); });
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const img = new Image();
    img.width = +svg.getAttribute("width"); img.height = +svg.getAttribute("height"); img.style.display = "block";
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    svg.replaceWith(img);
    return new Promise((ok) => { if (img.complete) ok(); else { img.onload = ok; img.onerror = ok; } });
  }
  async function opPdf() {
    if (!window.jspdf || !window.html2canvas) { toast("As bibliotecas do PDF ainda estão carregando; tente de novo.", true); return; }
    const btn = $("opPdf");
    btn.disabled = true; btn.textContent = "Gerando o PDF…";
    const caixa = document.createElement("div");
    caixa.style.cssText = `position:fixed; left:-${OP_W + 200}px; top:0; width:${OP_W}px; background:#fff;`;
    const copia = $("opFolha").cloneNode(true);
    copia.querySelectorAll("[id]").forEach((x) => x.removeAttribute("id"));
    copia.removeAttribute("id"); copia.classList.add("op-pdf");
    caixa.appendChild(copia); document.body.appendChild(caixa);
    try {
      const g = graficos.get("opGrafico"), alvo = copia.querySelector(".op-grafico");
      if (g && alvo) alvo.innerHTML = g.fn(alvo.clientWidth);
      await Promise.all([...copia.querySelectorAll("svg")].map(svgParaImagem));
      const foto = await window.html2canvas(copia, { scale: 2, backgroundColor: "#FFFFFF", logging: false, width: OP_W, windowWidth: OP_W });
      const PW = 210, PH = (PW * foto.height) / foto.width;
      const pdf = new window.jspdf.jsPDF({ orientation: "portrait", unit: "mm", format: [PW, PH], compress: true });
      pdf.addImage(foto.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, PW, PH);
      pdf.save(`OnePage_Arrecadacao_${filtroTexto("_").normalize("NFD").replace(/[^A-Za-z0-9_]+/g, "_")}_${E.mes}.pdf`);
    } catch (e) {
      toast("Não foi possível gerar o PDF: " + esc(e.message || e), true);
    } finally {
      caixa.remove(); btn.disabled = false; btn.textContent = "📄 Baixar PDF (uma página)";
    }
  }
  $("opPdf").addEventListener("click", opPdf);

  // ===== abas =====
  function mostraAba(aba) {
    E.aba = aba;
    const area = AREA_DA_ABA[aba] || "executivo";
    ultimaDaArea[area] = aba;
    document.querySelectorAll("#abas .areas button").forEach((b) => b.classList.toggle("active", b.dataset.area === area));
    document.querySelectorAll("#abas .toggle").forEach((g) => { g.hidden = g.dataset.grupo !== area; });
    document.querySelectorAll("#abas .toggle button").forEach((b) => b.classList.toggle("active", b.dataset.aba === aba));
    document.querySelectorAll(".painel-aba").forEach((p) => { p.hidden = p.dataset.painel !== aba; });
    desenha();
  }
  document.querySelectorAll("#abas .toggle button").forEach((b) => b.addEventListener("click", () => mostraAba(b.dataset.aba)));
  document.querySelectorAll("#abas .areas button").forEach((b) => b.addEventListener("click", () => mostraAba(ultimaDaArea[b.dataset.area])));

  // ===== PDF: uma folha (ou mais, se a tabela for comprida) por aba, no visual escolhido =====
  const quadro = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  // botão "Orçado" do topo: mostra ou esconde o orçado do painel (fica guardado neste navegador): cartões, tabela e curva do
  // Resumo, orçado do Diagnóstico por localidade e da One page (que passa a comparar com o mês anterior) e o filtro Orçado
  try { E.verOrcado = localStorage.getItem("arrecadacao_ver_orcado") !== "0"; } catch (x) { E.verOrcado = true; }
  const marcaBtnOrcado = () => {
    const b = $("btnOrcado");
    b.setAttribute("aria-pressed", String(E.verOrcado));
    b.textContent = E.verOrcado ? "👁 Orçado" : "🚫 Orçado";
    b.classList.toggle("desligado", !E.verOrcado);
    // sem orçado: some também o filtro "Orçado" do topo e o quadro da curva do orçado no Resumo
    $("selOrc").closest(".filtro").hidden = !E.verOrcado;
    $("curvaCard").hidden = !E.verOrcado;
  };
  marcaBtnOrcado();
  $("btnOrcado").addEventListener("click", () => {
    E.verOrcado = !E.verOrcado;
    try { localStorage.setItem("arrecadacao_ver_orcado", E.verOrcado ? "1" : "0"); } catch (x) { /* sem armazenamento */ }
    marcaBtnOrcado();
    if (E.res) { opChaveTop = ""; desenha(); }
  });

  $("btnPdf").addEventListener("click", async () => {
    if (!window.jspdf || !window.html2canvas) { toast("As bibliotecas do PDF ainda estão carregando; tente de novo.", true); return; }
    const btn = $("btnPdf"), abaAntes = E.aba;
    btn.disabled = true;
    btn.textContent = "Gerando…";
    document.body.classList.add("gerando-pdf");
    try {
      // cada aba numa folha A4 só: a imagem (em alta resolução, PNG) é reduzida para caber inteira; a folha fica deitada
      // ou em pé, a que deixar o conteúdo maior
      let pdf = null;
      const M = 7;
      for (const aba of ABAS_PDF) {
        mostraAba(aba);
        await quadro();
        const fundo = document.body.classList.contains("bi") ? "#ffffff" : "#f3f6f9";
        const area = $("area");
        const cv = await window.html2canvas(area, { scale: 3, backgroundColor: fundo, windowWidth: 1440, width: area.scrollWidth, height: area.scrollHeight });
        const opcoes = [["landscape", 297, 210], ["portrait", 210, 297]].map(([o, W, H]) => {
          const k = Math.min((W - 2 * M) / cv.width, (H - 2 * M) / cv.height);
          return { o, W, H, k };
        });
        const { o, W, H, k } = opcoes[0].k >= opcoes[1].k ? opcoes[0] : opcoes[1];
        if (!pdf) pdf = new window.jspdf.jsPDF({ orientation: o, unit: "mm", format: "a4", compress: true });
        else pdf.addPage("a4", o);
        const w = cv.width * k, h = cv.height * k;
        pdf.setFillColor(fundo);
        pdf.rect(0, 0, W, H, "F");
        pdf.addImage(cv.toDataURL("image/png"), "PNG", (W - w) / 2, M, w, h, undefined, "FAST");
      }
      pdf.save(`Arrecadacao_${E.mes}_${(E.sups.join("_") || "todas").toLowerCase()}.pdf`);
    } catch (e) {
      toast("Não foi possível gerar o PDF: " + esc(e.message || e), true);
    } finally {
      document.body.classList.remove("gerando-pdf");
      mostraAba(abaAntes);
      btn.disabled = false;
      btn.textContent = "📄 PDF";
    }
  });

  // ===== Prints para a apresentação (mesma ideia do painel de faturamento água e esgoto): cada aba do Executivo (Resumo a
  // Escada) vira uma imagem do tamanho exato de um slide 16:9, em alta resolução. A largura da página é escolhida para a
  // aba ocupar o máximo do slide (letra maior); o fundo completa o que sobra. Uma aba: copia (Ctrl+V no slide) e baixa o
  // PNG; todas: um PowerPoint com um slide por aba (imagem no slide inteiro) ou os PNGs.
  const SLIDE_W = 3840, SLIDE_H = 2160, SLIDE_MARGEM = 0.025;   // 4K, 16:9; margem de 2,5% em volta
  const carregaPptx = () => (window.PptxGenJS ? Promise.resolve() : new Promise((ok, erro) => {
    const sc = document.createElement("script"); sc.src = "lib/pptxgen.bundle.js"; sc.onload = ok; sc.onerror = () => erro(new Error("não carregou a biblioteca do PowerPoint")); document.head.append(sc);
  }));
  const nomePrint = (aba) => `Print_${ABAS[aba]}_${filtroTexto("_")}_${E.mes}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_-]+/g, "_");
  async function fotoDaAba(aba) {
    mostraAba(aba);
    const main = document.querySelector("main"), area = $("area"), fundo = document.body.classList.contains("bi") ? "#ffffff" : "#f3f6f9";
    // testa larguras da página: fica a que, encaixada no slide, deixa o conteúdo maior
    let melhor = null;
    for (let L = 1100; L <= 2600; L += 100) {
      main.style.width = L + "px"; await quadro();
      const nota = Math.min(1 / area.scrollWidth, (SLIDE_H / SLIDE_W) / area.scrollHeight);
      if (!melhor || nota > melhor.nota) melhor = { L, nota };
    }
    main.style.width = melhor.L + "px"; await quadro(); await quadro();
    const w = area.scrollWidth, h = area.scrollHeight;
    const util = 1 - 2 * SLIDE_MARGEM, k = Math.min((SLIDE_W * util) / w, (SLIDE_H * util) / h);
    const cv = await window.html2canvas(area, { scale: Math.min(5, k * 1.05), backgroundColor: fundo, windowWidth: Math.max(1440, melhor.L + 40), width: w, height: h });
    const sl = document.createElement("canvas"); sl.width = SLIDE_W; sl.height = SLIDE_H;
    const g = sl.getContext("2d"), dw = w * k, dh = h * k;
    g.fillStyle = fundo; g.fillRect(0, 0, SLIDE_W, SLIDE_H);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(cv, (SLIDE_W - dw) / 2, (SLIDE_H - dh) / 2, dw, dh);
    return sl;
  }
  async function comAbas(fn) {                         // monta a página no modo do PDF, chama fn e volta como estava
    const abaAntes = E.aba, main = document.querySelector("main"), btn = $("btnPrint");
    if (!window.html2canvas) throw new Error("as bibliotecas de imagem ainda estão carregando; tente de novo");
    btn.disabled = true; btn.textContent = "Gerando…";
    document.body.classList.add("gerando-pdf");
    try { return await fn(); } finally {
      document.body.classList.remove("gerando-pdf"); main.style.width = "";
      mostraAba(abaAntes); btn.disabled = false; btn.textContent = "🖼 Prints ▾";
    }
  }
  const pngDe = (cv) => new Promise((ok) => cv.toBlob(ok, "image/png"));
  function baixa(blob, nome) {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function prints(tipo) {
    if (ABAS_PDF.includes(tipo)) {
      // a promessa vai para a área de transferência na hora do clique: a cópia vale depois do tempo de gerar a imagem
      const imagem = comAbas(async () => pngDe(await fotoDaAba(tipo)));
      let copia = null;
      try { if (navigator.clipboard && window.ClipboardItem) copia = navigator.clipboard.write([new ClipboardItem({ "image/png": imagem })]); } catch (e) { copia = null; }
      const blob = await imagem;
      baixa(blob, nomePrint(tipo) + ".png");
      const copiou = copia ? await copia.then(() => true, () => false) : false;
      toast(copiou ? `Print de <b>${ABAS[tipo]}</b> copiado: cole no slide com Ctrl+V (também foi baixado em PNG).` : `Print de <b>${ABAS[tipo]}</b> baixado em PNG.`);
      return;
    }
    if (tipo === "pptx") await carregaPptx();
    const fotos = await comAbas(async () => { const l = []; for (const aba of ABAS_PDF) l.push([aba, await fotoDaAba(aba)]); return l; });
    if (tipo === "pngs") {
      for (const [aba, cv] of fotos) { baixa(await pngDe(cv), nomePrint(aba) + ".png"); await new Promise((r) => setTimeout(r, 400)); }
      toast(`${fotos.length} prints baixados em PNG.`);
      return;
    }
    const ppt = new window.PptxGenJS();
    ppt.layout = "LAYOUT_WIDE";                         // 13,33 × 7,5 pol. (16:9)
    ppt.title = `Arrecadação — ${filtroTexto()} — ${C.rotuloMes(E.mes)}`;
    for (const [, cv] of fotos) ppt.addSlide().addImage({ data: cv.toDataURL("image/png"), x: 0, y: 0, w: 13.333, h: 7.5 });
    await ppt.writeFile({ fileName: `Apresentacao_Arrecadacao_${filtroTexto("_")}_${E.mes}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_-]+/g, "_") + ".pptx" });
    toast("PowerPoint baixado: um slide por aba, do Resumo à Escada.");
  }
  const menuPrint = $("menuPrint");
  const fechaMenuPrint = () => { menuPrint.hidden = true; $("btnPrint").setAttribute("aria-expanded", "false"); };
  $("btnPrint").addEventListener("click", (e) => {
    e.stopPropagation();
    menuPrint.hidden = !menuPrint.hidden; $("btnPrint").setAttribute("aria-expanded", String(!menuPrint.hidden));
  });
  document.addEventListener("click", (e) => { if (!menuPrint.hidden && !e.target.closest("#menuPrintWrap")) fechaMenuPrint(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menuPrint.hidden) fechaMenuPrint(); });
  menuPrint.querySelectorAll("button[data-print]").forEach((b) => b.addEventListener("click", () => {
    fechaMenuPrint();
    toast("Gerando o print…");
    prints(b.dataset.print).catch((e) => toast("Não foi possível gerar o print: " + esc(e.message || e), true));
  }));

  // ===== Excel de cada quadro: botão "⬇ Excel" em todo quadro com tabela (todas as abas), com a tabela completa: todas as
  // linhas (também as escondidas, como os detalhes fechados da árvore e as células em branco da escada) e o valor exato
  // de cada célula (data-v), sem o arredondamento da tela. Uma aba da planilha por tabela do quadro.
  function valorCelula(c) {
    // texto como na tela (innerText separa os blocos da célula), sem as setas de abrir/fechar
    const txt = (c.innerText || c.textContent).replace(/[▸▾]/g, "").replace(/\s+/g, " ").trim(), pctTxt = /%$/.test(txt);
    let v = c.dataset.v !== undefined ? Number(c.dataset.v) : null;
    if (v == null) {
      const m = /^(-?)(?:R\$\s?)?(-?[\d.]+(?:,\d+)?)\s*(%|mil|mi|Mi)?$/.exec(txt.replace(/^[▲▼■+]\s*/, "").replace(/^(RF\d+|Orç\.)\s+/, ""));
      if (!m || !/\d/.test(m[2])) return txt ? { v: txt, t: "s" } : null;
      v = Number(m[2].replace(/\./g, "").replace(",", ".")) * (m[1] ? -1 : 1);
      if (m[3] === "%") v /= 100; else if (m[3] === "mil") v *= 1e3; else if (m[3]) v *= 1e6;
      if (/^▼/.test(txt) && v > 0) v = -v;
    }
    if (!isFinite(v)) return txt ? { v: txt, t: "s" } : null;
    const dec = (txt.split(",")[1] || "").replace(/\D/g, "").length;
    return { v, t: "n", z: pctTxt ? "0.00%" : dec ? "#,##0." + "0".repeat(Math.min(dec, 4)) : Number.isInteger(v) ? "#,##0" : "#,##0.00" };
  }
  function folhaDaTabela(t) {
    const X = window.XLSX, linhas = [];
    for (const tr of t.rows) linhas.push([...tr.cells].flatMap((c) => {
      const cel = c.tagName === "TH" ? { v: c.textContent.replace(/\s+/g, " ").trim(), t: "s" } : valorCelula(c);
      return [cel, ...Array(Math.max(0, (c.colSpan || 1) - 1)).fill(null)];
    }));
    const ws = X.utils.aoa_to_sheet(linhas.map((l) => l.map((c) => (c ? c.v : null))));
    linhas.forEach((l, i) => l.forEach((c, j) => { if (c && c.t === "n") { const a = X.utils.encode_cell({ r: i, c: j }); ws[a].t = "n"; ws[a].z = c.z; } }));
    ws["!cols"] = (linhas[0] || []).map((_, j) => ({ wch: Math.min(45, Math.max(10, ...linhas.map((l) => String(l[j] ? l[j].v : "").length + 2))) }));
    return ws;
  }
  const tituloQuadro = (q) => {
    const h = q.querySelector("h2, h3, summary");
    const t = h ? [...h.childNodes].filter((n) => n.nodeType === 3 || (n.tagName && !/^(SMALL|LABEL|BUTTON|SELECT)$/.test(n.tagName))).map((n) => n.textContent).join(" ") : "";
    return t.replace(/\s+/g, " ").trim() || ABAS[E.aba] || "Tabela";
  };
  async function baixaExcelQuadro(q) {
    try { await carregaXLSX(); } catch (e) { toast("Não foi possível carregar a biblioteca de planilhas.", true); return; }
    const X = window.XLSX, wb = X.utils.book_new(), tabs = [...q.querySelectorAll("table")].filter((t) => t.rows.length), usados = new Set();
    if (!tabs.length) { toast("Esse quadro ainda não tem tabela para baixar.", true); return; }
    const titulo = tituloQuadro(q);
    tabs.forEach((t, i) => {
      // várias tabelas no quadro: cada aba com o título mais próximo acima da tabela (ou "título 1", "título 2"…)
      const acima = [...q.querySelectorAll("h2, h3, h4, .op-top-tit, summary")].filter((h) => h.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
      let nome = (tabs.length > 1 ? (acima ? acima.textContent.replace(/⬇ Excel/, "").replace(/\s+/g, " ").trim() : "") || `${titulo} ${i + 1}` : titulo)
        .replace(/[\\/?*[\]:]/g, " ").slice(0, 31).trim() || `Tabela ${i + 1}`;
      while (usados.has(nome)) nome = nome.slice(0, 28) + " " + (i + 1);
      usados.add(nome);
      X.utils.book_append_sheet(wb, folhaDaTabela(t), nome);
    });
    const info = X.utils.aoa_to_sheet([["Painel de arrecadação"], ["Quadro", titulo], ["Aba", ABAS[E.aba] || E.aba], ["Filtros", filtroTexto()],
      ["Mês", C.rotuloMes(E.mes)], ["Dias úteis", rotuloDias()], ["Gerado em", new Date().toLocaleString("pt-BR")]]);
    info["!cols"] = [{ wch: 14 }, { wch: 80 }];
    X.utils.book_append_sheet(wb, info, "Filtros");
    X.writeFile(wb, `${ABAS[E.aba] || "Painel"}_${titulo}_${E.mes}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 120) + ".xlsx");
  }
  // põe o botão nos quadros com tabela (o conteúdo é redesenhado o tempo todo: um observador confere de tempos em tempos)
  function poeBotoesExcel() {
    for (const q of document.querySelectorAll("#area .card, #area .op-folha")) {
      if (q.querySelector(":scope > .btn-excel, :scope > h2 .btn-excel, :scope > summary .btn-excel") || !q.querySelector("table")) continue;
      if (q.parentElement.closest("#area .card")) continue;          // quadro dentro de quadro: o de fora baixa tudo
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn-excel sem-pdf"; b.textContent = "⬇ Excel"; b.title = "Baixar a tabela completa deste quadro em Excel (valores exatos, todas as linhas)";
      const h = q.querySelector(":scope > h2, :scope > summary > h2");
      if (q.classList.contains("op-folha")) { const a = q.parentElement.querySelector(".op-acoes"); if (a && !a.querySelector(".btn-excel")) { b.classList.add("btn"); a.appendChild(b); b.dataset.alvo = "opFolha"; } continue; }
      if (h) h.appendChild(b); else q.prepend(b);
    }
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".btn-excel");
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    baixaExcelQuadro(b.dataset.alvo ? $(b.dataset.alvo) : b.closest(".card, .op-folha"));
  }, true);
  let excelPendente = 0;
  new MutationObserver(() => { if (!excelPendente) excelPendente = requestAnimationFrame(() => { excelPendente = 0; poeBotoesExcel(); }); })
    .observe($("area"), { childList: true, subtree: true });

  // ===== Botão "Mensal": planilha do relatório diário (mesmo layout do Excel do relatório): três blocos lado a lado, um
  // por dia do mês (1,dom; 2,seg…): arrecadação por subcategoria × utilização; clientes pagantes e contas pagas por subcategoria
  let idMensal = 0;
  $("btnMensal").addEventListener("click", () => {
    if (!worker || !E.res) return;
    $("btnMensal").disabled = true; $("btnMensal").textContent = "Lendo o mês…";
    toast(`Montando a planilha de ${C.rotuloMes(E.mes)}: os arquivos do mês são lidos de novo (pode levar alguns segundos).`);
    worker.postMessage({ tipo: "mensal", id: ++idMensal, mes: E.mes, sups: E.sups, cidades: E.cidades, grupos: E.grupos });
  });
  async function recebeMensal(m) {
    if (m.id !== idMensal) return;
    $("btnMensal").disabled = false; $("btnMensal").textContent = "📅 Mensal";
    if (m.erro) { toast("Não foi possível montar a planilha: " + esc(m.erro), true); return; }
    try { await carregaXLSX(); } catch (e) { toast("Não foi possível carregar a biblioteca de planilhas.", true); return; }
    const X = window.XLSX, SEM = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
    const rotDia = (iso) => `${+iso.slice(8, 10)},${SEM[new Date(iso + "T12:00:00").getDay()]}`;
    const ordem = (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1], "pt-BR") || a[2].localeCompare(b[2], "pt-BR", { numeric: true });
    const vals = m.valores.slice().sort(ordem), qts = m.quantos.map((x) => [x[0], x[1], "", x[2], x[3]]).sort(ordem);
    const n = Math.max(vals.length, qts.length), aoa = [["Subcategoria", "Utilização (Sub. Categ.)", "Arrecadacao Acumulada", "Data", null,
      "Subcategoria", "Qtd clientes pagantes acumulado", "Data", null, "Subcategoria", "QTD Contas pagas Arrecadação acumulada", "Data"]];
    for (let i = 0; i <= n; i++) aoa.push(Array(12).fill(null));
    vals.forEach((v, i) => { aoa[i + 1][0] = v[1]; aoa[i + 1][1] = v[2]; aoa[i + 1][2] = v[3]; aoa[i + 1][3] = rotDia(v[0]); });
    qts.forEach((q, i) => { const l = aoa[i + 1]; l[5] = q[1]; l[6] = q[3]; l[7] = rotDia(q[0]); l[9] = q[1]; l[10] = q[4]; l[11] = rotDia(q[0]); });
    // total de cada bloco logo abaixo da sua última linha (soma da coluna)
    const soma = (l, j) => l.reduce((t, x) => t + x[j], 0), linhaTot = [vals.length + 1, qts.length + 1, qts.length + 1];
    aoa[linhaTot[0]][0] = "Total"; aoa[linhaTot[0]][2] = soma(vals, 3);
    aoa[linhaTot[1]][5] = "Total"; aoa[linhaTot[1]][6] = soma(qts, 3);
    aoa[linhaTot[2]][9] = "Total"; aoa[linhaTot[2]][10] = soma(qts, 4);
    const ws = X.utils.aoa_to_sheet(aoa);
    const negrito = { font: { bold: true } };
    [[linhaTot[0], [0, 2]], [linhaTot[1], [5, 6]], [linhaTot[2], [9, 10]]].forEach(([r, cs]) => cs.forEach((c) => { const x = ws[X.utils.encode_cell({ r, c })]; if (x) x.s = negrito; }));
    for (let i = 1; i <= n + 1; i++) {
      const c = ws[X.utils.encode_cell({ r: i, c: 2 })]; if (c) c.z = '"R$" #,##0.00';
      for (const j of [6, 10]) { const x = ws[X.utils.encode_cell({ r: i, c: j })]; if (x) x.z = "#,##0"; }
    }
    ws["!cols"] = [18, 30, 20, 9, 3, 18, 28, 9, 3, 18, 36, 9].map((wch) => ({ wch }));
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, "Mensal");
    const tot = vals.reduce((s, v) => s + v[3], 0);
    const info = X.utils.aoa_to_sheet([["Relatório mensal da arrecadação"], ["Mês", C.rotuloMes(m.mes)], ["Filtros", filtroTexto()],
      ["Crédito até", m.ultimo ? dataBR(m.ultimo) : "—"], ["Arrecadação (Val. Autenticado, sem o desconto comercial)", tot], ["Linhas lidas", m.linhas],
      ["Arquivos", m.arquivos.join(", ")],
      ["Regras", "Um dia por linha (fins de semana e feriados também). Clientes pagantes = matrículas distintas no dia e na subcategoria; contas pagas = notas fiscais (mensal e avulsa), como no painel."],
      ["Gerado em", new Date().toLocaleString("pt-BR")]]);
    info["!cols"] = [{ wch: 50 }, { wch: 90 }];
    X.utils.book_append_sheet(wb, info, "Informações");
    X.writeFile(wb, `Mensal_Arrecadacao_${filtroTexto("_")}_${m.mes}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_-]+/g, "_") + ".xlsx");
    toast(`Planilha mensal de ${C.rotuloMes(m.mes)} baixada (${fmt(n)} linhas).`);
  }

  try { aplicaModo(localStorage.getItem("arrecadacao_modo") || "arrecadacao"); } catch (e) { aplicaModo("arrecadacao"); }

  // ===== ao abrir: reconecta a pasta da última visita =====
  (async function inicia() {
    if (!("showDirectoryPicker" in window)) return;
    const h = await idb.get("pasta");
    if (!h) return;
    let perm = "prompt";
    try { perm = await h.queryPermission({ mode: "read" }); } catch (e) { /* handle antigo */ }
    if (perm === "granted") { abrePasta(h); return; }
    setFonte(`Pasta anterior encontrada (<b>${esc(h.name)}</b>) — <b>clique em qualquer lugar da página</b> para reconectar e carregar.`);
    const reconecta = (ev) => {
      document.removeEventListener("pointerdown", reconecta, true);
      document.removeEventListener("keydown", reconecta, true);
      if (ev.target && ev.target.closest && ev.target.closest("#btnPasta")) return;
      abrePasta(h);
    };
    document.addEventListener("pointerdown", reconecta, true);
    document.addEventListener("keydown", reconecta, true);
  })();
})();
