// Página do painel: conecta a pasta, manda os arquivos para o worker e desenha as abas a partir das somas que ele devolve.
(function () {
  "use strict";
  const C = window.CALC, R = window.REGRAS;
  const $ = (id) => document.getElementById(id);
  const ARQ_AJUSTES = "ajustes_arrecadacao.json";
  const ABAS = { resumo: "Resumo", subcategoria: "Subcategoria", perfil: "Perfil de pagamento", cidades: "Cidades", escada: "Escada" };
  const NOME_SUP = { INTERIOR: "Interior", LESTE: "Leste", [R.SEM_SUP]: "Sem SUP" };
  const DIGITADO = "__digitado";                      // opção do seletor de orçado: o valor digitado no painel
  const E = {
    res: null, sup: "INTERIOR", cidade: "", grupo: "", mes: "", sel: 0, aba: "resumo",
    abertos: new Set(), ajustes: { orcado: {}, curva: {} }, pasta: null, rodando: false,
  };
  try { $("versao").textContent = VERSAO_SITE.split("-")[0]; } catch (e) { /* sem versão */ }

  // ===== formatação =====
  const fmt = (v, d = 0) => (isFinite(v) ? v : 0).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const rs = (v) => (v < 0 ? "-R$ " : "R$ ") + fmt(Math.abs(v));
  const pct = (v) => (isFinite(v) ? (v * 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%" : "—");
  const milhoes = (v) => (isFinite(v) ? fmt(v / 1e6, 2) + " Mi" : "—");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const td = (txt, cls = "") => `<td${cls ? ` class="${cls}"` : ""}>${txt}</td>`;
  const tdNum = (v, f, extra = "") => td(f(v), [v < 0 ? "neg" : "", extra].filter(Boolean).join(" "));
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

  // ===== visual (painel de faturamento × Power BI) =====
  function aplicaVisual(v) {
    document.body.classList.toggle("bi", v === "bi");
    document.querySelectorAll(".chave-visual button").forEach((b) => b.classList.toggle("on", b.dataset.visual === v));
    try { localStorage.setItem("arrecadacao_visual", v); } catch (e) { /* navegador sem armazenamento */ }
  }
  document.querySelectorAll(".chave-visual button").forEach((b) => b.addEventListener("click", () => aplicaVisual(b.dataset.visual)));
  try { aplicaVisual(localStorage.getItem("arrecadacao_visual") || "painel"); } catch (e) { aplicaVisual("painel"); }

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
  function analisa(itens, nomePasta) {
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
    const d = res.dados;
    const nArr = res.arquivos.filter((a) => a.tipo === "diaria" || a.tipo === "acumulada").length;
    listaArquivos(res);
    if (!d.meses.length) {
      setFonte(`Pasta <b>${esc(nomePasta)}</b>: nenhum arquivo de arrecadação encontrado (CSV com Nº Ligação, Data Crédito e Val. Autenticado). Veja a lista em “Arquivos lidos”.`);
      $("vazio").hidden = false; $("area").hidden = true; $("abas").hidden = true; $("btnPdf").disabled = true;
      return;
    }
    const ultimo = d.ultimoCredito[d.meses[d.meses.length - 1]];
    setFonte(`Pasta <b>${esc(nomePasta)}</b> · ${nArr} arquivo(s) de arrecadação · crédito até <b>${dataBR(ultimo)}</b>`
      + (d.ultimaAtualizacao ? ` · atualizado em ${dataBR(d.ultimaAtualizacao.slice(0, 10))}${esc(d.ultimaAtualizacao.slice(10))}` : ""));
    $("vazio").hidden = true; $("area").hidden = false; $("abas").hidden = false; $("btnPdf").disabled = false;
    const sups = supsDisponiveis();
    if (!sups.includes(E.sup)) E.sup = sups.includes("INTERIOR") ? "INTERIOR" : sups[0] || "";
    if (!d.meses.includes(E.mes)) E.mes = d.meses[d.meses.length - 1];
    E.sel = C.mascaraAte(diaPadrao(E.mes));
    montaFiltros();
    desenha();
  }

  function listaArquivos(res) {
    const USO = { diaria: "Arrecadação diária", acumulada: "Arrecadação acumulada", desconto: "Desconto comercial", perfil: "Perfil do cliente", orcado: "Orçado (linha da arrecadação)", ajustes: "Ajustes do painel (orçado digitado e curva)", ignorado: "Não usado" };
    const linhas = res.arquivos.map((a) => `<tr>${td(esc(a.rel), "rot")}${td(USO[a.tipo] || a.tipo, "rot")}${td(a.registros != null ? fmt(a.registros) : "")}`
      + `${td(esc((a.meses || []).map(C.rotuloMes).join(", ")), "rot")}${td(esc(a.motivo || [a.puladas ? `${fmt(a.puladas)} linhas de mês que está no arquivo diário não foram usadas` : "", a.doCache ? "já lido antes (guardado neste navegador)" : ""].filter(Boolean).join("; ")), "rot")}</tr>`).join("");
    const d = res.dados, avisos = [];
    if (!res.temDesconto) avisos.push("Planilha de desconto comercial não encontrada: a arrecadação aparece sem o desconto.");
    if (!res.temPerfil) avisos.push("Planilha de perfil do cliente (Cluster) não encontrada: todos aparecem como “Sem perfil”.");
    if (!res.orcados.length) avisos.push("Nenhuma planilha de orçado (RF) com a linha da arrecadação: digite o orçado do mês no Resumo (Orçado do mês e curva).");
    if (d.zonasSemSup.length) avisos.push(`Zonas fora da relação de cidades (aparecem em “Sem SUP”): ${esc(d.zonasSemSup.join(", "))}.`);
    if (d.subSemClasse.length) avisos.push(`Subcategorias fora da relação (aparecem em “${R.SEM_CLASSIFICACAO}”): ${esc(d.subSemClasse.join(", "))}.`);
    const descMes = C.descontoPorMes(d);
    const ultimos = d.meses.map((m, i) => [m, descMes[i]]).filter(([, v]) => v).slice(-3);
    if (ultimos.length) avisos.push("Desconto comercial abatido (ligações que pagaram no mês, como no BI): "
      + ultimos.map(([m, v]) => `${C.rotuloMes(m)} ${rs(-v)}`).join("; ") + ".");
    if (d.descartadas.semCredito) avisos.push(`${fmt(d.descartadas.semCredito)} linhas sem Data Crédito foram ignoradas.`);
    if (d.descartadas.semValor) avisos.push(`${fmt(d.descartadas.semValor)} linhas sem Val. Autenticado foram ignoradas.`);
    $("listaArquivos").innerHTML = `<table><thead><tr><th>Arquivo</th><th>Uso</th><th>Linhas</th><th>Meses</th><th>Observação</th></tr></thead><tbody>${linhas}</tbody></table>`
      + (avisos.length ? `<ul class="avisos">${avisos.map((a) => `<li>${a}</li>`).join("")}</ul>` : "");
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
    opcoes($("selSup"), [...supsDisponiveis().map((s) => [s, nomeSup(s)]), ["", "Todas"]], E.sup);
    const cidades = [...new Set(d.combos.filter((c) => !E.sup || c.sup === E.sup).map((c) => c.cidade))].sort();
    if (!cidades.includes(E.cidade)) E.cidade = "";
    opcoes($("selCidade"), [["", "Todas"], ...cidades.map((c) => [c, c])], E.cidade);
    const grupos = ordena([...new Set(d.combos.map((c) => c.grupo))], R.ORDEM_SUBCATEGORIAS);
    if (!grupos.includes(E.grupo)) E.grupo = "";
    opcoes($("selGrupo"), [["", "Todas"], ...grupos.map((g) => [g, g])], E.grupo);
    opcoes($("selMes"), [...d.meses].reverse().map((m) => [m, C.rotuloMes(m)]), E.mes);
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
  $("selSup").addEventListener("change", (e) => { E.sup = e.target.value; montaFiltros(); desenha(); });
  $("selCidade").addEventListener("change", (e) => { E.cidade = e.target.value; desenha(); });
  $("selGrupo").addEventListener("change", (e) => { E.grupo = e.target.value; desenha(); });
  $("selMes").addEventListener("change", (e) => { E.mes = e.target.value; E.sel = C.mascaraAte(diaPadrao(E.mes)); montaSeletorOrcado(); desenha(); });

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
  function diaPadrao(mes) { return Math.max(1, ultimoDiaComDados(mes) || C.calendario(mes).uteis); }

  // ===== dados filtrados =====
  const idxMes = (m) => E.res.dados.meses.indexOf(m);
  const marcas = () => C.marcaCombos(E.res.dados, { sup: E.sup, cidade: E.cidade, grupo: E.grupo });
  const marcasSup = (sup) => C.marcaCombos(E.res.dados, { sup });
  const filtroParcial = () => !!(E.cidade || E.grupo);

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
    const filtros = [`Superintendência: ${nomeSup(E.sup)}`, E.cidade ? `Cidade: ${E.cidade}` : "", E.grupo ? `Subcategoria: ${E.grupo}` : "",
      `Mês: ${C.rotuloMes(E.mes)}`, `Orçado: ${fonteAtiva(E.mes) === DIGITADO ? "digitado" : fonteAtiva(E.mes)}`,
      `dias úteis: ${rotuloSel(E.sel)}`].filter(Boolean).join(" · ");
    $("cabecalhoPdf").innerHTML = `<h1>Arrecadação Diária — ${ABAS[E.aba]}</h1><p>${esc(filtros)}</p>`;
    document.querySelectorAll(".ate-dia").forEach((s) => { s.textContent = `dias úteis ${rotuloSel(E.sel)} de cada mês`; });
    ({ resumo: desenhaResumo, subcategoria: desenhaSubcategoria, perfil: desenhaPerfil, cidades: desenhaCidades, escada: desenhaEscada })[E.aba]();
  }

  // "1 a 12", "1, 5 e 10", "0 (fins de semana e feriados) e 1 a 3"
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
    for (let k = 1; k <= cal.uteis; k++) {
      const cls = [E.sel & (1 << k) ? "sel" : "", k > ult ? "futuro" : ""].filter(Boolean).join(" ");
      h += `<button type="button" data-d="${k}" class="${cls}" title="${dataBR(cal.dataDoDia[k])}">${k}</button>`;
    }
    h += `<span class="dias-acoes sem-pdf"><button type="button" data-acao="ate" title="Marca do dia útil 1 ao último com dados">1 a ${ult || cal.uteis}</button>`
      + `<button type="button" data-acao="limpa">Limpar</button></span>`;
    $("dias").innerHTML = h;
    $("diasNota").textContent = `${C.rotuloMes(E.mes)}: ${cal.uteis} dias úteis · marcados: ${rotuloSel(E.sel)} · clique em cada dia para marcar ou desmarcar;`
      + " os outros meses usam os mesmos dias úteis · 0 = fins de semana e feriados";
  }
  $("dias").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.acao === "ate") E.sel = C.mascaraAte(diaPadrao(E.mes));
    else if (b.dataset.acao === "limpa") E.sel = 0;
    else E.sel = (E.sel ^ (1 << +b.dataset.d)) >>> 0;
    desenha();
  });

  function tabela(el, cab, linhas) {
    $(el).innerHTML = `<thead><tr>${cab.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${linhas.join("")}</tbody>`;
  }

  // ----- Resumo -----
  function desenhaResumo() {
    const d = E.res.dados, mi = idxMes(E.mes), mk = marcas(), cal = C.calendario(E.mes), sel = E.sel;
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
    ].map(([t, v, sub]) => `<div class="kpi"><span>${t}</span><b>${v}</b><small>${sub}</small></div>`).join("");
    $("notaOrc").textContent = temOrc ? "" : "(" + semOrc + ")";

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
    tabela("tOrc", ["Data", "Dia útil", "Orçado dia", "Arrecadação dia", "Dif", "Δ (%)"], rows);

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
  }

  // ----- Orçado do mês e curva do orçado diário (editáveis) -----
  const pctInput = (v) => (v * 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    const g = C.porGrupo(d, idx, mk, E.sel, grupoDe);
    const det = opcoes.detalheDe ? C.porGrupo(d, idx, mk, E.sel, opcoes.detalheDe) : null;
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
        if (aberto) for (const k of dets) linhas.push(`<tr class="det">${td(esc(k.split("\u0001")[1]), "rot")}${idx.map((m) => cel(det.get(k), m, campo, f)).join("")}</tr>`);
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
    const arq = E.res.arquivos.filter((a) => a.tipo === "perfil").map((a) => a.rel).join(", ");
    $("legendaPerfil").innerHTML = `<p><b>Perfil do cliente</b>${arq ? ` — planilha ${esc(arq)}` : " — planilha de cluster não encontrada na pasta"}</p>
      <p><b>Adimplente</b> – cliente sem faturas vencidas e que já realizou ao menos um pagamento.</p>
      <p><b>Inadimplente</b> – cliente com débitos em aberto e que já realizou ao menos um pagamento.</p>
      <p><b>Nunca Pagou</b> – cliente que nunca realizou um pagamento.</p>
      <p><b>${R.SEM_PERFIL}</b> – ligação + contrato que não está na planilha de perfil.</p>`;
  }
  function desenhaCidades() {
    tresTabelas(["tCidValor", "tCidCli", "tCidCon"], (c) => c.cidade, (l) => [...l].sort((a, b) => a.localeCompare(b, "pt-BR")), { titulo: "Cidade" });
  }

  // ----- Escada -----
  function desenhaEscada() {
    const d = E.res.dados, meses = mesesDaComparacao(), idx = meses.map(idxMes);
    const esq = C.escada(d, idx, marcas(), E.sel);
    // linhas: do 1º vencimento até 2 meses depois do mês escolhido; os vencimentos posteriores somam numa linha só
    const limite = C.mesAnterior(E.mes, -2), POST = "\u0002depois";
    for (const v of [...esq.linhas.keys()]) {
      if (!v || v <= limite) continue;
      let p = esq.linhas.get(POST);
      if (!p) { p = new Map(); esq.linhas.set(POST, p); }
      for (const [m, x] of esq.linhas.get(v)) p.set(m, (p.get(m) || 0) + x);
      esq.linhas.delete(v);
    }
    const ordemV = (v) => (v === POST ? "9998" : v === "" ? "9999" : v);
    const vencs = [...esq.linhas.keys()].sort((a, b) => ordemV(a).localeCompare(ordemV(b)));
    let max = 0;
    for (const l of esq.linhas.values()) for (const v of l.values()) if (v > max) max = v;
    const linhas = vencs.map((v) => {
      const l = esq.linhas.get(v);
      const rot = v === POST ? `após ${C.rotuloMes(limite)}` : v ? C.rotuloMes(v) : "(sem vencimento)";
      return `<tr>${td(rot, "rot")}${idx.map((m, j) => {
        const x = l.get(m);
        if (x == null) return td("");
        const a = x > 0 && max ? 0.06 + 0.55 * (x / max) : 0;
        const st = a ? ` style="background:rgba(23,107,156,${a.toFixed(3)})${a > 0.4 ? ";color:#fff" : ""}"` : "";
        return `<td class="${[x < 0 ? "neg" : "", v === meses[j] ? "diag" : ""].filter(Boolean).join(" ")}"${st}>${fmt(x)}</td>`;
      }).join("")}</tr>`;
    });
    if ([...esq.desconto.values()].some((v) => v)) linhas.push(`<tr class="desc">${td("Desconto comercial", "rot")}${idx.map((m) => (esq.desconto.get(m) ? tdNum(esq.desconto.get(m), fmt) : td(""))).join("")}</tr>`);
    const tot = idx.map((m) => { let s = esq.desconto.get(m) || 0; for (const l of esq.linhas.values()) s += l.get(m) || 0; return s; });
    linhas.push(`<tr class="total">${td("Total", "rot")}${tot.map((v) => tdNum(v, fmt)).join("")}</tr>`);
    tabela("tEscada", ["Vencimento (R$)", ...meses.map(C.rotuloMes)], linhas);
  }

  // ===== abas =====
  function mostraAba(aba) {
    E.aba = aba;
    document.querySelectorAll("#abas button").forEach((b) => b.classList.toggle("active", b.dataset.aba === aba));
    document.querySelectorAll(".painel-aba").forEach((p) => { p.hidden = p.dataset.painel !== aba; });
    desenha();
  }
  document.querySelectorAll("#abas button").forEach((b) => b.addEventListener("click", () => mostraAba(b.dataset.aba)));

  // ===== PDF: uma folha (ou mais, se a tabela for comprida) por aba, no visual escolhido =====
  const quadro = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
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
      for (const aba of Object.keys(ABAS)) {
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
      pdf.save(`Arrecadacao_${E.mes}_${(E.sup || "todas").toLowerCase()}.pdf`);
    } catch (e) {
      toast("Não foi possível gerar o PDF: " + esc(e.message || e), true);
    } finally {
      document.body.classList.remove("gerando-pdf");
      mostraAba(abaAntes);
      btn.disabled = false;
      btn.textContent = "📄 PDF";
    }
  });

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
