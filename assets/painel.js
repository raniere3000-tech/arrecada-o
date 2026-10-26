// Página do painel: conecta a pasta, manda os arquivos para o worker e desenha as abas a partir das somas que ele devolve.
(function () {
  "use strict";
  const C = window.CALC, R = window.REGRAS;
  const $ = (id) => document.getElementById(id);
  const ARQ_AJUSTES = "ajustes_arrecadacao.json";
  const ABAS = { resumo: "Resumo", subcategoria: "Subcategoria", perfil: "Perfil de pagamento", cidades: "Cidades", escada: "Escada", analise: "Análise", base: "Base", dados: "Dados",
    fxa: "Faturamento x Arrecadação", fxv: "Fat. x Arrec. — mesmo vencimento", conversao: "Conversão por referência", clientes: "Clientes e oportunidades", localidade: "Diagnóstico por localidade" };
  const AREA_DA_ABA = { fxa: "analises", fxv: "analises", conversao: "analises", clientes: "analises", localidade: "analises" };   // as outras: Executivo
  const ultimaDaArea = { executivo: "resumo", analises: "fxa" };
  const ABAS_PDF = ["resumo", "subcategoria", "perfil", "cidades", "escada"];     // Análise e Dados não entram no PDF
  const NOME_SUP = { INTERIOR: "Interior", LESTE: "Leste", [R.SEM_SUP]: "Sem SUP" };
  const DIGITADO = "__digitado";                      // opção do seletor de orçado: o valor digitado no painel
  const E = {
    res: null, sup: "INTERIOR", cidade: "", grupo: "", mes: "", sel: 0, aba: "resumo",
    abertos: new Set(["PUBLICO"]), ajustes: { orcado: {}, curva: {} }, pasta: null, rodando: false,
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
      else if (m.tipo === "analise") recebeAnalise(m);
      else if (m.tipo === "extracao-progresso") { if (m.id === idBase) $("baseStatus").textContent = `${m.texto}… ${m.pct}%`; }
      else if (m.tipo === "extracao") recebeBase(m);
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
    const USO = { diaria: "Arrecadação diária", acumulada: "Arrecadação acumulada", desconto: "Desconto comercial", perfil: "Perfil do cliente", orcado: "Orçado (linha da arrecadação)", faturamento: "Faturamento (Fatura de ciclo)", ajustes: "Ajustes do painel (orçado digitado e curva)", ignorado: "Não usado" };
    const linhas = res.arquivos.map((a) => `<tr>${td(esc(a.rel), "rot")}${td(USO[a.tipo] || a.tipo, "rot")}${td(a.registros != null ? fmt(a.registros) : "")}`
      + `${td(esc((a.meses || []).map(C.rotuloMes).join(", ")), "rot")}${td(esc(a.motivo || [a.puladas ? `${fmt(a.puladas)} linhas de mês que está no arquivo diário não foram usadas` : "", rejeicao(a), a.doCache ? "já lido antes (guardado neste navegador)" : ""].filter(Boolean).join("; ")), "rot")}</tr>`).join("");
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
  $("selMes").addEventListener("change", (e) => { E.mes = e.target.value; E.sel = selDoMes(E.mes); montaSeletorOrcado(); desenha(); });

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
    // no PDF, só a 1ª folha (Resumo) leva "Arrecadação Diária" no título
    $("cabecalhoPdf").innerHTML = `<h1>${E.aba === "resumo" ? "Arrecadação Diária — " : ""}${ABAS[E.aba]}</h1><p>${esc(filtros)}</p>`;
    document.querySelectorAll(".ate-dia").forEach((s) => { s.textContent = `dias úteis ${rotuloSel(E.sel)} de cada mês`; });
    $("diasCard").hidden = E.aba === "dados" || E.aba === "base" || !!AREA_DA_ABA[E.aba];
    ({ resumo: desenhaResumo, subcategoria: desenhaSubcategoria, perfil: desenhaPerfil, cidades: desenhaCidades, escada: desenhaEscada, analise: desenhaAnalise, base: desenhaBase, dados: desenhaDados, fxa: desenhaFxa, fxv: desenhaFxv,
      conversao: () => {}, clientes: () => {}, localidade: () => {} })[E.aba]();
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
    guardaSel();
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
    const nAt = mesLongo(E.mes), nAnt = mesLongo(ant), filtro = [nomeSup(E.sup), E.cidade, E.grupo].filter(Boolean).join(" — ");
    const at = dias.map((k) => s.valor[k]), an = dias.map((k) => (sa ? sa.valor[k] : 0));
    const rot = (k) => (k ? `Dia ${k}` : "Fins de semana");
    // gráfico de barras (SVG): mês anterior × mês atual em cada dia útil marcado
    $("gTitulo").textContent = `Arrecadação por dia útil — ${nAt} vs ${nAnt}`;
    $("gNota").textContent = "Barras do mês atual em laranja indicam queda acima de 40%; em azul médio, crescimento acima de 40%. Rótulos nas duas barras (mês anterior e atual); passe o mouse para ver o valor exato.";
    $("gLegenda").innerHTML = `<span><i class="cor-ant"></i>${nAnt}</span><span><i class="cor-at"></i>${nAt}</span><span><i class="cor-alerta"></i>Alerta (±40%)</span>`;
    const larg = Math.max(720, dias.length * 92), alt = 270, base = 222, topo = 34, max = Math.max(1, ...at, ...an);
    const passo = larg / Math.max(1, dias.length), bw = Math.min(36, passo * 0.32);
    let svg = `<svg viewBox="0 0 ${larg} ${alt}" role="img" aria-label="Arrecadação por dia útil"><line x1="0" y1="${base}" x2="${larg}" y2="${base}" class="eixo"/>`;
    dias.forEach((k, i) => {
      const cx = passo * i + passo / 2, h1 = ((base - topo) * an[i]) / max, h2 = ((base - topo) * at[i]) / max;
      const v = an[i] > 0 ? at[i] / an[i] - 1 : NaN;
      const cls = v <= -ALERTA ? "b-queda" : v >= ALERTA ? "b-alta" : "b-at";
      const data = k ? dataBR(cal.dataDoDia[k]).slice(0, 5) : "";
      svg += `<g><title>${rot(k)}${data ? ` (${data})` : ""}\n${nAnt}: ${rs(an[i])}\n${nAt}: ${rs(at[i])}${isFinite(v) ? `\nΔ ${pct(v)}` : ""}</title>`
        + `<rect class="b-ant" x="${cx - bw - 3}" y="${base - h1}" width="${bw}" height="${Math.max(0, h1)}" rx="2"/>`
        + `<rect class="${cls}" x="${cx + 3}" y="${base - h2}" width="${bw}" height="${Math.max(0, h2)}" rx="2"/>`
        + (an[i] ? `<text class="r-ant" x="${cx - bw / 2 - 3}" y="${base - h1 - 5}">${curto(an[i])}</text>` : "")
        + (at[i] ? `<text class="r-at" x="${cx + bw / 2 + 3}" y="${base - h2 - 5}">${curto(at[i])}</text>` : "")
        + `<text class="x" x="${cx}" y="${base + 18}">${rot(k)}</text><text class="x2" x="${cx}" y="${base + 32}">${data}</text></g>`;
    });
    $("grafico").innerHTML = dias.length ? svg + "</svg>" : '<p class="nota">Nenhum dia útil marcado.</p>';
    // faixa: dias úteis dos dois meses
    $("faixaDias").innerHTML = `<b>Dias úteis no mês</b><span>${nAt}: <b>${cal.uteis} dias</b></span><span>${nAnt}: <b>${calAnt.uteis} dias</b></span>`
      + `<span><b>Δ ${cal.uteis - calAnt.uteis >= 0 ? "" : "−"}${Math.abs(cal.uteis - calAnt.uteis)} dia${Math.abs(cal.uteis - calAnt.uteis) === 1 ? "" : "s"}</b></span>`
      + `<span>Dias marcados: <b>${rotuloSel(E.sel)}</b></span>`;
    // destaques
    $("destTitulo").textContent = `Destaques do mês — ${nAt} — ${filtro.toUpperCase()}`;
    const tA = C.totalDoMes(d, idxMes(E.mes), mk, E.sel), tB = miAnt >= 0 ? C.totalDoMes(d, miAnt, mk, E.sel) : null;
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
    if (worker) worker.postMessage({ tipo: "analise", para: "resumo", id: ++idResumo, mi: idxMes(E.mes), miAnt, marcas: mk, sel: E.sel, n: 100 });
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
    const esq = C.escada(d, idx, marcas(), E.sel);
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
    const limpa = escadaLimpa(), aparece = (x) => x != null && (!limpa || x >= ESCADA_MINIMO);
    const linhas = vencs.filter((v) => !limpa || [...esq.linhas.get(v).values()].some(aparece)).map((v) => {
      const l = esq.linhas.get(v);
      const rot = v === POST ? `após ${C.rotuloMes(limite)}` : v ? C.rotuloMes(v) : "(sem vencimento)";
      return `<tr>${td(rot, "rot")}${idx.map((m, j) => {
        const x = l.get(m);
        if (!aparece(x)) return td("");
        const a = x > 0 && max ? 0.06 + 0.55 * (x / max) : 0;
        const st = a ? ` style="background:rgba(23,107,156,${a.toFixed(3)})${a > 0.4 ? ";color:#fff" : ""}"` : "";
        return `<td class="${[x < 0 ? "neg" : "", v === meses[j] ? "diag" : ""].filter(Boolean).join(" ")}"${st}>${fmt(x)}</td>`;
      }).join("")}</tr>`;
    });
    if ([...esq.desconto.values()].some((v) => v)) linhas.push(`<tr class="desc">${td("Desconto comercial", "rot")}${idx.map((m) => (esq.desconto.get(m) ? tdNum(esq.desconto.get(m), fmt) : td(""))).join("")}</tr>`);
    const tot = idx.map((m) => { let s = esq.desconto.get(m) || 0; for (const l of esq.linhas.values()) s += l.get(m) || 0; return s; });
    linhas.push(`<tr class="total">${td("Total", "rot")}${tot.map((v) => tdNum(v, fmt)).join("")}</tr>`);
    tabela("tEscada", ["Vencimento (R$)", ...meses.map(C.rotuloMes)], linhas);
    $("escadaLimpa").checked = limpa;
    $("escadaNota").textContent = limpa
      ? `Mostrando só os valores a partir de R$ ${fmt(ESCADA_MINIMO)}; os menores ficam em branco, mas o Total soma todos (inclusive o desconto).`
      : "Mostrando todos os valores.";
    // aviso do executivo (só no PDF), quando a escada está resumida
    $("escadaAvisoPdf").textContent = limpa
      ? `Para facilitar a leitura, a escada exibe apenas os valores a partir de R$ ${fmt(ESCADA_MINIMO / 1000)} mil. Os totais consideram a arrecadação integral de cada mês.`
      : "";
    $("escadaAvisoPdf").hidden = !limpa;
  }
  // Opção da escada: só valores a partir de R$ 50 mil (padrão) ou a escada completa. Lembrada neste navegador.
  const ESCADA_MINIMO = 50000;
  function escadaLimpa() { try { return localStorage.getItem("arrecadacao_escada") !== "completa"; } catch (e) { return true; } }
  $("escadaLimpa").addEventListener("change", (e) => {
    try { localStorage.setItem("arrecadacao_escada", e.target.checked ? "limpa" : "completa"); } catch (x) { /* sem armazenamento */ }
    desenha();
  });

  // ----- Análise: top 100 por ligação (calculado no worker, que guarda o valor de cada ligação por dia) -----
  let idAnalise = 0, ultimaAnalise = null;
  function desenhaAnalise() {
    const mi = idxMes(E.mes), ant = C.mesAnterior(E.mes);
    const filtro = [nomeSup(E.sup), E.cidade, E.grupo].filter(Boolean).join(" · ");
    $("analiseNota").textContent = `${C.rotuloMes(E.mes)} × ${C.rotuloMes(ant)} · dias úteis ${rotuloSel(E.sel)} · ${filtro}. Calculando…`;
    document.querySelectorAll(".analise-sub").forEach((x) => { x.textContent = C.rotuloMes(E.mes); });
    if (!worker) return;
    worker.postMessage({ tipo: "analise", id: ++idAnalise, mi, miAnt: idxMes(ant), marcas: marcas(), sel: E.sel, n: 100 });
  }
  function recebeAnalise(m) {
    if (m.para === "resumo") { if (!m.erro) destaquesClientes(m); return; }
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
  }
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
        if (!window.XLSX) await new Promise((ok, erro) => { const sc = document.createElement("script"); sc.src = "lib/xlsx.full.min.js"; sc.onload = ok; sc.onerror = erro; document.head.append(sc); });
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
    const ligs = ligsDoTexto($("baseLigs").value);
    if (!ligs.length) { toast("Informe as matrículas (cole a lista ou carregue um arquivo).", true); return; }
    if (!mesesBase || !mesesBase.length) { toast("Marque pelo menos um mês.", true); return; }
    if (!worker) return;
    $("baseExtrair").disabled = true;
    $("baseResultado").innerHTML = "";
    $("baseStatus").textContent = "Lendo os arquivos…";
    worker.postMessage({ tipo: "extrair", id: ++idBase, ligs, meses: [...mesesBase].sort() });
  });
  let ultimaBase = null;
  function recebeBase(m) {
    if (m.id !== idBase) return;
    $("baseExtrair").disabled = false;
    if (m.erro) { $("baseStatus").textContent = "Erro: " + m.erro; return; }
    ultimaBase = m;
    const meses = Object.keys(m.porMes).sort();
    $("baseStatus").textContent = `${fmt(m.linhas)} linha${m.linhas === 1 ? "" : "s"} encontrada${m.linhas === 1 ? "" : "s"} em ${m.arquivos} arquivo(s).`;
    $("baseResultado").innerHTML = `<table class="compacta base-tabela"><thead><tr><th>Mês</th><th>Linhas</th></tr></thead><tbody>`
      + meses.map((x) => `<tr>${td(C.rotuloMes(x), "rot")}${td(fmt(m.porMes[x]))}</tr>`).join("")
      + `<tr class="total">${td("Total", "rot")}${td(fmt(m.linhas))}</tr></tbody></table>`
      + `<div class="base-acoes">${m.linhas ? '<button type="button" class="btn" id="baseBaixar">Baixar base (CSV)</button>' : ""}`
      + (m.naoEncontradas.length ? `<button type="button" class="btn sec" id="baseBaixarNao">Baixar matrículas sem pagamento (${fmt(m.naoEncontradas.length)})</button>` : "")
      + `</div>` + (m.linhas > 1048000 ? '<p class="nota">Atenção: a base passa de 1 milhão de linhas, o limite de uma planilha do Excel.</p>' : "")
      + (m.naoEncontradas.length ? `<p class="nota">${fmt(m.naoEncontradas.length)} matrícula(s) da lista não têm pagamento nos meses marcados.</p>` : "");
    const nome = `Base_arrecadacao_${meses.length ? meses[0] + (meses.length > 1 ? "_a_" + meses[meses.length - 1] : "") : "vazia"}.csv`;
    if ($("baseBaixar")) $("baseBaixar").onclick = () => baixa(ultimaBase.csv, nome);
    if ($("baseBaixarNao")) $("baseBaixarNao").onclick = () => baixa("\ufeffMatrícula\r\n" + ultimaBase.naoEncontradas.join("\r\n"), "Matriculas_sem_pagamento.csv");
    if (m.linhas) baixa(m.csv, nome);
  }
  function baixa(texto, nome) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([texto], { type: "text/csv;charset=utf-8" }));
    a.download = nome;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
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
    const filtroG = E.grupo ? grupoCruz(E.grupo) : "";
    const okFat = (c) => (!E.cidade || c.cidade === E.cidade) && (!filtroG || c.grupo === filtroG);
    const mkArr = Uint8Array.from(d.combos, (c) => (c.sup === "INTERIOR" && (!E.cidade || c.cidade === E.cidade) && (!filtroG || grupoCruz(c.grupo) === filtroG) ? 1 : 0));
    const avisos = [];
    if (E.sup && E.sup !== "INTERIOR") avisos.push(`O faturamento é só do Interior: o filtro Superintendência = ${nomeSup(E.sup)} não se aplica aqui (a comparação usa o Interior).`);
    if (E.grupo === "PEQUENO COMERCIO") avisos.push("No cruzamento, Pequeno Comércio está junto com Comercial (o faturamento não separa).");
    $("fxaAviso").innerHTML = avisos.map((a) => `<p class="aviso-pdf">${esc(a)}</p>`).join("");
    const filtroTxt = ["Interior", E.cidade, filtroG].filter(Boolean).join(" · ");
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
    $("fxaG1").innerHTML = svgBarras(janela.map(C.rotuloMes), [[serieF, "b-fat"], [serieA, "b-at"]], curto);
    const varS = (s) => s.map((v, i) => (i && v != null && s[i - 1] ? v / s[i - 1] - 1 : null));
    $("fxaG2").innerHTML = svgLinhas(janela.map(C.rotuloMes), [[varS(serieF), "l-fat"], [varS(serieA), "l-at"]], (v) => pct(v));
    $("fxaG3").innerHTML = svgBarras(janela.map(C.rotuloMes), [[janela.map((m) => { const f = fatMes(m); return f.tem ? f.matriculas : null; }), "b-fat"],
      [janela.map((m) => { const a = arrMes(m); return a ? a.clientes : null; }), "b-at"]], (v) => fmt(v / 1000, 1) + " mil");
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
    const M = fxvMesEscolhido, filtroG = E.grupo ? grupoCruz(E.grupo) : "";
    const ok = (c) => (!E.cidade || c.cidade === E.cidade) && (!filtroG || c.grupo === filtroG);
    const avisos = [];
    if (E.sup && E.sup !== "INTERIOR") avisos.push(`O faturamento é só do Interior: o filtro Superintendência = ${nomeSup(E.sup)} não se aplica aqui.`);
    $("fxvAviso").innerHTML = avisos.map((a) => `<p class="aviso-pdf">${esc(a)}</p>`).join("");
    const refs = [...new Set(cz.fat.map((r) => r.ref))].sort();
    $("fxvNota").textContent = `${["Interior", E.cidade, filtroG].filter(Boolean).join(" · ")} · pagamentos creditados em ${C.rotuloMes(M)} ligados às contas pela matrícula + vencimento`
      + ` · faturas na pasta: ${C.rotuloMes(refs[0])} a ${C.rotuloMes(refs[refs.length - 1])}.`;
    const linhas = cz.pagas.filter((r) => r.mes === M && ok(cz.combos[r.c]));
    const soma = (l, k) => l.reduce((x, r) => x + r[k], 0);
    const pago = soma(linhas, "pago"), faturado = soma(linhas, "faturado"), contas = soma(linhas, "contas");
    const cc = cz.concil.find((c) => c.mes === M) || { achou: [0, 0, 0, 0], semConta: [0, 0, 0, 0] };
    const semNF = cc.semConta[1] + cc.semConta[2], parc = cc.semConta[3], outros = cc.semConta[0];   // o que achou conta já está em pago
    const total = cc.achou.reduce((x, v) => x + v, 0) + cc.semConta.reduce((x, v) => x + v, 0);
    const porRef = new Map();
    for (const r of linhas) { const o = porRef.get(r.ref) || { ref: r.ref, pago: 0, faturado: 0, contas: 0, matriculas: 0 }; o.pago += r.pago; o.faturado += r.faturado; o.contas += r.contas; o.matriculas += r.matriculas; porRef.set(r.ref, o); }
    const refsOrdem = [...porRef.values()].sort((a, b) => b.ref.localeCompare(a.ref));
    const mesmaRef = porRef.get(M), anterior = porRef.get(C.mesAnterior(M));
    const filtrado = !!(E.cidade || filtroG);
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
    $("fxvG1").innerHTML = g.length ? svgBarras(g.map((o) => C.rotuloMes(o.ref)), [[g.map((o) => o.faturado), "b-fat"], [g.map((o) => o.pago), "b-at"]], curto) : '<p class="nota">Nenhum pagamento ligado a conta neste mês.</p>';
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
  // gráficos simples (SVG): barras agrupadas e linhas; null = sem dado (não desenha)
  function svgBarras(cats, series, rotulo) {
    const larg = Math.max(720, cats.length * 80), alt = 260, base = 214, topo = 30;
    const max = Math.max(1, ...series.flatMap(([v]) => v.filter((x) => x != null)));
    const passo = larg / Math.max(1, cats.length), bw = Math.min(30, (passo * 0.7) / series.length);
    let svg = `<svg viewBox="0 0 ${larg} ${alt}"><line x1="0" y1="${base}" x2="${larg}" y2="${base}" class="eixo"/>`;
    cats.forEach((cat, i) => {
      const cx = passo * i + passo / 2;
      series.forEach(([v, cls], j) => {
        if (v[i] == null) return;
        const h = ((base - topo) * Math.max(0, v[i])) / max, x = cx + (j - series.length / 2) * (bw + 4) + 2;
        svg += `<g><title>${cat}: ${rotulo(v[i])}</title><rect class="${cls}" x="${x}" y="${base - h}" width="${bw}" height="${h}" rx="2"/>`
          + `<text class="r-${j ? "at" : "ant"}" x="${x + bw / 2}" y="${base - h - 4}">${rotulo(v[i])}</text></g>`;
      });
      svg += `<text class="x" x="${cx}" y="${base + 18}">${cat}</text>`;
    });
    return svg + "</svg>";
  }
  function svgLinhas(cats, series, rotulo) {
    const larg = Math.max(720, cats.length * 80), alt = 240, topo = 24, baixo = 200;
    const vals = series.flatMap(([v]) => v.filter((x) => x != null));
    const max = Math.max(0.01, ...vals), min = Math.min(-0.01, ...vals), y = (v) => topo + ((max - v) / (max - min)) * (baixo - topo);
    const passo = larg / Math.max(1, cats.length), x = (i) => passo * i + passo / 2;
    let svg = `<svg viewBox="0 0 ${larg} ${alt}"><line x1="0" y1="${y(0)}" x2="${larg}" y2="${y(0)}" class="eixo"/>`;
    series.forEach(([v, cls]) => {
      const pts = v.map((p, i) => (p == null ? null : `${x(i)},${y(p)}`)).filter(Boolean);
      if (pts.length > 1) svg += `<polyline class="${cls}" points="${pts.join(" ")}"/>`;
      v.forEach((p, i) => { if (p != null) svg += `<g><title>${cats[i]}: ${rotulo(p)}</title><circle class="${cls}" cx="${x(i)}" cy="${y(p)}" r="4"/><text class="r-at" x="${x(i)}" y="${y(p) - 8}">${rotulo(p)}</text></g>`; });
    });
    cats.forEach((c, i) => { svg += `<text class="x" x="${x(i)}" y="${baixo + 26}">${c}</text>`; });
    return svg + "</svg>";
  }

  // ----- Dados: os números por trás do que está na tela -----
  function desenhaDados() {
    const d = E.res.dados, mi = idxMes(E.mes), cal = C.calendario(E.mes), mk = marcas();
    const tot = C.totalDoMes(d, mi, mk, E.sel), orc = filtroParcial() ? null : orcadoMensal(E.mes, E.sup), cv = curvaDoMes(E.mes, E.sup);
    const feriados = cal.dias.filter((x) => x.feriado).map((x) => dataBR(x.data));
    const marcados = C.diasDaMascara(E.sel).filter((k) => k <= cal.uteis);
    const datas = marcados.map((k) => (k ? dataBR(cal.dataDoDia[k]) : "fins de semana e feriados")).join(", ");
    const nArq = E.res.arquivos.filter((a) => a.tipo === "diaria" || a.tipo === "acumulada").length;
    const linhas = [
      ["Mês", `${C.rotuloMes(E.mes)}: ${cal.uteis} dias úteis e ${cal.naoUteis} dias de fim de semana ou feriado`],
      ["Feriados no mês", feriados.length ? feriados.join(", ") : "nenhum"],
      ["Dias úteis marcados", `${rotuloSel(E.sel)}${datas ? ` (${datas})` : ""}`],
      ["Arrecadação nos dias", `${rs(tot.valor - tot.desconto)} de Val. Autenticado − ${rs(-tot.desconto)} de desconto = ${rs(tot.valor)}`],
      ["Contas pagas e clientes", `${fmt(tot.contas)} contas pagas · ${fmt(tot.clientes)} clientes distintos · ticket ${tot.contas ? fmt(tot.valor / tot.contas, 2) : "—"}`],
      ["Orçado mensal", orc ? (orc.valor != null ? `${rs(orc.valor)} (${esc(orc.fonte)})` : "sem orçado no mês para o orçado escolhido") : "por superintendência (escolha Cidade e Subcategoria = Todas)"],
      ["Curva do orçado", cv.mesesMedia.length ? `média de ${cv.mesesMedia.map(C.rotuloMes).join(", ")}${cv.editada ? " · pesos editados no painel" : ""}` : "sem meses anteriores: dividida igualmente"],
      ["Leitura", `${nArq} arquivo(s) de arrecadação · ${fmt(d.linhas)} linhas usadas · crédito até ${dataBR(d.ultimoCredito[d.meses[d.meses.length - 1]])}`],
    ];
    $("dadosFiltros").textContent = [nomeSup(E.sup), E.cidade, E.grupo].filter(Boolean).join(" · ");
    $("dadosParametros").innerHTML = `<table class="explica"><tbody>${linhas.map(([a, b]) => `<tr><td class="rot"><b>${a}</b></td><td class="rot">${b}</td></tr>`).join("")}</tbody></table>`
      + `<details class="arquivos-dados"><summary>Arquivos lidos e avisos</summary>${E.htmlArquivos || ""}</details>`;
  }

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
