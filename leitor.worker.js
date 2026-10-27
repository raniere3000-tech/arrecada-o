// Lê os arquivos da pasta no navegador (nada é enviado para servidor) e devolve as somas que o painel usa.
// CSV de arrecadação: lido em partes (stream), linha a linha. Planilhas (desconto, perfil, orçado): SheetJS.
const V = self.location.search;                         // ?v=versão do site: os scripts novos não vêm do cache do navegador
importScripts("lib/xlsx.full.min.js", "assets/regras.js" + V, "assets/calculos.js" + V);

const C = self.CALC, R = self.REGRAS;
const avisa = (tipo, dados, transferir = []) => self.postMessage({ tipo, ...dados }, transferir);

// Base dos rankings por ligação (aba Análise): fica aqui no worker; a página pede só as listas prontas
let analise = null;
let fontes = null;                                     // arquivos CSV lidos (com os meses de cada um), para a aba Base
let contasFat = null;                                  // contas da fatura com o total pago (aba Clientes e oportunidades)

self.onmessage = async (ev) => {
  if (ev.data.tipo === "analise") { respondeAnalise(ev.data); return; }
  if (ev.data.tipo === "clientes") { responde("clientes", ev.data.id, () => respondeClientes(ev.data)); return; }
  if (ev.data.tipo === "matricula") { responde("matricula", ev.data.id, () => respondeMatricula(ev.data)); return; }
  if (ev.data.tipo === "cobranca") { responde("cobranca", ev.data.id, () => respondeCobranca(ev.data)); return; }
  if (ev.data.tipo === "extrair") { extraiBase(ev.data).catch((e) => avisa("extracao", { id: ev.data.id, erro: String((e && e.message) || e) })); return; }
  try {
    const r = await processa(ev.data.arquivos || []);
    analise = r.dados.analise;
    delete r.dados.analise;
    contasFat = r.cruzamento ? r.cruzamento.base : null;
    if (r.cruzamento) delete r.cruzamento.base;
    avisa("pronto", r, C.buffers(r.dados));          // as tabelas vão para a página sem cópia
  } catch (e) {
    avisa("erro", { mensagem: String((e && e.message) || e), detalhe: String((e && e.stack) || "") });
  }
};

function respondeAnalise({ id, para, mi, miAnt, marcas, sel, n }) {
  if (!analise) { avisa("analise", { id, para, erro: "dados ainda não lidos" }); return; }
  const r = C.rankings(analise, mi, miAnt, marcas, sel, n || 100);
  for (const lista of [r.maiores, r.aumentos, r.quedas]) for (const x of lista) {
    if (x.nome !== undefined) continue;              // a mesma ligação pode estar em duas listas (maiores e aumentos)
    x.nome = analise.nomes.get(x.lig) || "";
    x.lig = x.lig < 1e10 ? String(x.lig) : "(não numérica)";
  }
  avisa("analise", { id, para, ...r });
}

function responde(tipo, id, f) {
  if (!analise) { avisa(tipo, { id, erro: "dados ainda não lidos" }); return; }
  try { avisa(tipo, { id, ...f() }); } catch (e) { avisa(tipo, { id, erro: String((e && e.message) || e) }); }
}
const nomeDe = (l) => analise.nomes.get(l) || (contasFat && contasFat.nomes.get(l)) || "";
const ligTxt = (l) => (l < 1e10 ? String(l) : "(não numérica)");
// aba Clientes e oportunidades: listas completas (a página mostra as primeiras e baixa o resto em CSV)
function respondeClientes(o) {
  const r = C.clientesOportunidades(analise, contasFat, o);
  for (const lista of [r.deixaram, r.voltaram, r.semPagamento.lista]) for (const x of lista) { x.nome = nomeDe(x.lig); x.lig = ligTxt(x.lig); }
  return { ...r, temFatura: !!contasFat };
}
function respondeMatricula({ lig }) {
  const l = C.chaveLig(lig);
  return { lig: l < 1e10 ? String(l) : String(lig).trim(), ...C.historicoMatricula(analise, contasFat, l) };
}

const ext = (nome) => (nome.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();

// ---------- classificação ----------
const COLS_ARRECADACAO = ["NLIGACAO", "DATACREDITO", "VALAUTENTICADO"];
// Fatura de ciclo (faturamento): o mesmo arquivo do painel de faturamento, uma linha por rubrica de cada conta.
// Aceita as mesmas variações do painel de faturamento: nome da coluna da ligação, cabeçalho depois de "sep=;" ou de
// linhas de título, e arquivo sem "Referencia de Leitura" (a referência sai do nome: "Fatura de ciclo 09-2026").
const NOMES_LIG_FATURAMENTO = ["NDALIGACAO", "NLIGACAO", "NLIG", "LIGACAO", "MATRICULA"];
const COLS_FATURAMENTO = ["RUBRICA", "VALORPARCELA", "DATADEVENCIMENTO"];
function colunasFaturamento(linha) {                    // → { lig, faltam: [...] }
  const cols = linha.split(";").map(C.chave);
  const lig = NOMES_LIG_FATURAMENTO.find((n) => cols.includes(n));
  const faltam = COLS_FATURAMENTO.filter((c) => !cols.includes(c));
  if (!lig) faltam.unshift("N. da Ligacao");
  return { lig, faltam, ref: cols.includes("REFERENCIADELEITURA") };
}
const ehFaturamento = (linha) => colunasFaturamento(linha).faltam.length === 0;
function refDoNome(nome) {                               // "Fatura de ciclo 09-2026.csv" → "2026-09"
  const m = /(?<!\d)(\d{2})[-/._ ](\d{4})(?!\d)/.exec(nome);
  return m && +m[1] >= 1 && +m[1] <= 12 ? `${m[2]}-${m[1]}` : "";
}
async function primeirasLinhas(file) {                  // as 20 primeiras linhas (o cabeçalho pode vir depois de "sep=;" ou de títulos)
  const bytes = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  return (ehUtf8(bytes) ? new TextDecoder("utf-8") : new TextDecoder("windows-1252")).decode(bytes).split(/\r?\n/).slice(0, 20);
}
function ehUtf8(bytes) {                               // UTF-8 quando válido; senão Windows-1252 (padrão do sistema comercial)
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 65536), { stream: true }); return true; }
  catch (e) { return false; }
}
function ehArrecadacao(linha) {
  const cols = linha.split(";").map(C.chave);
  return COLS_ARRECADACAO.every((c) => cols.includes(c));
}
function leLivro(buffer, linhas) {                    // linhas = 0: a planilha inteira
  return XLSX.read(buffer, { type: "array", cellDates: true, dense: true, ...(linhas ? { sheetRows: linhas } : {}) });
}
function linhasDaAba(livro, aba) {
  return XLSX.utils.sheet_to_json(livro.Sheets[aba], { header: 1, raw: true, defval: null, blankrows: false });
}
// Acha a linha de cabeçalho (até a 15ª) que tenha todas as colunas pedidas; devolve { i, idx: {COL: posição} }
function achaCabecalho(linhas, colunas) {
  for (let i = 0; i < Math.min(linhas.length, 15); i++) {
    const ch = (linhas[i] || []).map(C.chave), idx = {};
    for (const c of colunas) { const p = ch.indexOf(c); if (p < 0) break; idx[c] = p; }
    if (Object.keys(idx).length === colunas.length) return { i, idx, ch };
  }
  return null;
}
const COLS_DESCONTO = ["NUMLIGACAO", "DESCONTO", "REFERENCIA"];
const COLS_PERFIL = ["NUMLIGACAO", "SEQRESPONSAVEL", "CLUSTERSALDO"];
const COLS_ORCADO = ["SUP", "RUBRICA"];

async function classifica(item) {
  const { file, rel } = item, e = ext(file.name);
  if (/^ajustes_arrecadacao/i.test(file.name)) return { tipo: "ajustes" };
  if (file.name.startsWith("~$")) return { tipo: "ignorado", motivo: "arquivo temporário do Excel" };
  if (e === "csv" || e === "txt") {
    const linhas = await primeirasLinhas(file);
    if (ehArrecadacao(linhas[0] || "")) return { tipo: C.chave(rel).includes("DIARI") ? "diaria" : "acumulada" };
    const iFat = linhas.findIndex(ehFaturamento);
    if (iFat >= 0) {
      if (C.chave(file.name).includes("AVULSO")) return { tipo: "ignorado", motivo: "serviço avulso: não entra no faturamento (os serviços já vêm nas rubricas da fatura)" };
      const c = colunasFaturamento(linhas[iFat]);
      if (!c.ref && !refDoNome(file.name)) return { tipo: "ignorado", motivo: "faturamento sem a coluna Referencia de Leitura e sem o mês no nome do arquivo (ex.: 09-2026)", erro: true };
      return { tipo: "faturamento" };
    }
    // CSV numa pasta de faturamento que não foi reconhecido: diz o que falta
    if (C.chave(rel).includes("FATURA")) {
      const melhor = linhas.map(colunasFaturamento).sort((a, b) => a.faltam.length - b.faltam.length)[0];
      return { tipo: "ignorado", erro: true, motivo: `parece faturamento, mas faltam as colunas: ${melhor ? melhor.faltam.join(", ") : "todas"} (1ª linha: ${String(linhas[0] || "").slice(0, 120)})` };
    }
    return { tipo: "ignorado", motivo: "CSV sem as colunas Nº Ligação, Data Crédito e Val. Autenticado" };
  }
  if (!["xlsx", "xlsm", "xls", "xlsb"].includes(e)) return { tipo: "ignorado", motivo: "formato não usado" };
  // planilhas grandes conhecidas pelo nome (desconto, cluster): lidas inteiras uma vez só; as outras, só o começo
  const n = C.chave(file.name), inteira = ["DESCONTO", "CLUSTER", "PERFIL"].some((x) => n.includes(x));
  const livro = leLivro(await file.arrayBuffer(), inteira ? 0 : 16);
  for (const aba of livro.SheetNames) {
    const linhas = linhasDaAba(livro, aba);
    const guarda = inteira ? { livro } : {};
    if (achaCabecalho(linhas, COLS_PERFIL)) return { tipo: "perfil", aba, ...guarda };
    if (achaCabecalho(linhas, COLS_DESCONTO)) return { tipo: "desconto", aba, ...guarda };
    if (achaCabecalho(linhas, COLS_ORCADO)) return { tipo: "orcado", aba };
  }
  return { tipo: "ignorado", motivo: "planilha não usada pelo painel (não é desconto, perfil do cliente nem orçado)" };
}

// ---------- planilhas ----------
async function lePerfil(arq, mapa) {
  const linhas = linhasDaAba(arq.livro || leLivro(await arq.file.arrayBuffer()), arq.aba);
  const cab = achaCabecalho(linhas, COLS_PERFIL), { NUMLIGACAO: a, SEQRESPONSAVEL: b, CLUSTERSALDO: c } = cab.idx;
  let n = 0;
  for (let i = cab.i + 1; i < linhas.length; i++) {
    const l = linhas[i];
    if (!l || l[a] == null) continue;
    const k = C.ligacao(l[a]) + "|" + C.ligacao(l[b]);
    if (!mapa.has(k)) { mapa.set(k, String(l[c] == null ? "" : l[c]).trim() || "Sem perfil"); n++; }   // repetida: vale a 1ª (como no BI)
  }
  return n;
}
async function leDesconto(arq, mapa) {
  const linhas = linhasDaAba(arq.livro || leLivro(await arq.file.arrayBuffer()), arq.aba);
  const cab = achaCabecalho(linhas, COLS_DESCONTO), { NUMLIGACAO: a, DESCONTO: d, REFERENCIA: r } = cab.idx;
  let n = 0;
  for (let i = cab.i + 1; i < linhas.length; i++) {
    const l = linhas[i];
    if (!l) continue;
    const v = C.numeroBR(l[d] == null ? "" : l[d]), ref = refDaCelula(l[r]);
    if (!isFinite(v) || !v || !ref) continue;
    const lig = C.ligacao(l[a]);
    let m = mapa.get(ref);
    if (!m) { m = new Map(); mapa.set(ref, m); }
    m.set(lig, (m.get(lig) || 0) + v);
    n++;
  }
  return n;
}
function refDaCelula(v) {                              // data (Date, serial do Excel ou texto) → "AAAA-MM"
  if (v == null || v === "") return "";
  if (v instanceof Date) return C.dataISO(v).slice(0, 7);
  if (typeof v === "number") { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, "0")}` : ""; }
  const s = String(v).trim().replace(/^soma\s+de\s+/i, "");     // "Soma de 01/10/2025" (tabela dinâmica)
  const iso = C.dataISO(s);
  if (iso) return iso.slice(0, 7);
  let m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[2]}-${m[1].padStart(2, "0")}`;
  m = /^([a-zç]{3})[a-zç]*[\/\-\s.]*(\d{2}|\d{4})$/i.exec(s);
  if (m) {
    const mi = C.MESES_CURTOS.indexOf(C.chave(m[1]).toLowerCase().slice(0, 3));
    if (mi >= 0) return `${m[2].length === 2 ? "20" + m[2] : m[2]}-${String(mi + 1).padStart(2, "0")}`;
  }
  return "";
}
// Orçado (RF): colunas Sup, Rubrica e um mês por coluna; usa a linha da arrecadação ("(+) Arrecadação", "05.01. Arrecadação"…)
async function leOrcado(file, aba) {
  const linhas = linhasDaAba(leLivro(await file.arrayBuffer()), aba);
  const cab = achaCabecalho(linhas, COLS_ORCADO), { SUP: s, RUBRICA: r } = cab.idx;
  const colMes = [];
  linhas[cab.i].forEach((v, j) => { const ref = refDaCelula(v); if (ref && j !== s && j !== r) colMes.push([j, ref]); });
  const out = [];
  for (let i = cab.i + 1; i < linhas.length; i++) {
    const l = linhas[i];
    if (!l || !C.ehLinhaArrecadacao(l[r])) continue;
    let sup = C.chave(l[s]);
    if (sup === "LAGOS") sup = "INTERIOR";
    for (const [j, ref] of colMes) {
      const v = C.numeroBR(l[j] == null ? "" : l[j]);
      if (isFinite(v)) out.push({ sup, mes: ref, valor: v });
    }
  }
  return out;
}

// ---------- CSV de arrecadação ----------
async function leCsv(file, aoLer, leitura) {
  const leitor = file.stream().getReader();
  let utf8 = null, resto = "", idx = null, lidos = 0, ultimoAviso = 0;
  const dec8 = new TextDecoder("utf-8"), dec1252 = new TextDecoder("windows-1252");
  const trata = (linha) => {
    if (!linha) return;
    const p = linha.split(";");
    if (!idx) {
      const ch = p.map(C.chave), pos = (c) => ch.indexOf(c);
      idx = { lig: pos("NLIGACAO"), venc: pos("VENCIMENTO"), cred: pos("DATACREDITO"), val: pos("VALAUTENTICADO"),
        util: pos("UTILIZACAOSUBCATEG"), zona: pos("ZONALOCALIDADE"), contrato: pos("NCONTRATO"), tipo: pos("TIPOFATURA"),
        atual: pos("DATAATUALIZ"), cliente: pos("CLIENTE") };
      return;
    }
    leitura.adiciona({ lig: p[idx.lig], contrato: idx.contrato >= 0 ? p[idx.contrato] : "", vencimento: p[idx.venc], credito: p[idx.cred] || "",
      valor: p[idx.val], util: idx.util >= 0 ? p[idx.util] : "", zona: idx.zona >= 0 ? p[idx.zona] : "",
      tipo: idx.tipo >= 0 ? p[idx.tipo] : "", atualizacao: idx.atual >= 0 ? p[idx.atual] : "", cliente: idx.cliente >= 0 ? p[idx.cliente] : "" });
  };
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    if (utf8 === null) utf8 = ehUtf8(value);
    resto += (utf8 ? dec8 : dec1252).decode(value, { stream: true });
    const partes = resto.split("\n");
    resto = partes.pop();
    for (const l of partes) trata(l.endsWith("\r") ? l.slice(0, -1) : l);
    lidos += value.length;
    if (lidos - ultimoAviso > 4e6) { ultimoAviso = lidos; aoLer(lidos); }
  }
  resto += (utf8 ? dec8 : dec1252).decode();
  if (resto) trata(resto.replace(/\r$/, ""));
  aoLer(lidos);
  if (!idx) throw new Error("arquivo vazio");
  return leitura.exporta();
}

// ---------- CSV do faturamento (Fatura de ciclo) ----------
async function leFaturamento(file, aoLer) {
  const leitura = new C.LeituraFaturamento(), refNome = refDoNome(file.name);
  let idx = null;
  await linhasDoArquivo(file, (linha) => {
    const p = C.separaCsv(linha);
    if (!idx) {
      if (!ehFaturamento(linha)) return;                // "sep=;" ou título antes do cabeçalho
      const ch = p.map(C.chave), pos = (c) => ch.indexOf(c);
      idx = { lig: pos(colunasFaturamento(linha).lig), venc: pos("DATADEVENCIMENTO"), ref: pos("REFERENCIADELEITURA"), val: pos("VALORPARCELA"),
        cidade: pos("NOMEDALOCALIDADE"), cat: pos("CATEGORIA"), sit: pos("SITUACAOCONTA"), cliente: pos("NOMECLIENTE") };
      return;
    }
    const v = (j) => (j >= 0 ? p[j] : "");
    leitura.adiciona({ lig: v(idx.lig), venc: v(idx.venc), ref: idx.ref >= 0 ? v(idx.ref) : refNome, valor: v(idx.val), cidade: v(idx.cidade),
      categoria: v(idx.cat), situacao: v(idx.sit), cliente: v(idx.cliente) });
  }, aoLer);
  if (!idx) throw new Error("cabeçalho do faturamento não encontrado");
  return leitura.exporta();
}

// ---------- cache: o que cada CSV exportou fica no navegador (IndexedDB); arquivo igual não é lido de novo ----------
const CACHE_VERSAO = 5;
const CACHE_FATURAMENTO = 4;                           // cache do faturamento é separado: muda sem reler a arrecadação
const banco = () => new Promise((ok, erro) => {
  const r = indexedDB.open("arrecadacao_cache", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("arquivos");
  r.onsuccess = () => ok(r.result);
  r.onerror = () => erro(r.error);
});
const pedido = (r) => new Promise((ok, erro) => { r.onsuccess = () => ok(r.result); r.onerror = () => erro(r.error); });
async function cacheLe(db, id) { try { return await pedido(db.transaction("arquivos").objectStore("arquivos").get(id)); } catch (e) { return null; } }
async function cacheGrava(db, id, valor) {
  try { await pedido(db.transaction("arquivos", "readwrite").objectStore("arquivos").put(valor, id)); } catch (e) { /* cota cheia: segue sem cache */ }
}
async function cacheLimpa(db, usados) {                // apaga o que não é desta pasta (arquivos trocados ou removidos)
  try {
    const chaves = await pedido(db.transaction("arquivos").objectStore("arquivos").getAllKeys());
    const t = db.transaction("arquivos", "readwrite"), st = t.objectStore("arquivos");
    for (const k of chaves) if (!usados.has(k)) st.delete(k);
  } catch (e) { /* sem cache */ }
}

// ---------- tudo ----------
async function processa(itens) {
  const arquivos = [], vistos = new Set();
  let i = 0;
  for (const item of itens) {
    i++;
    avisa("progresso", { pct: Math.round((i / itens.length) * 10), texto: `Reconhecendo arquivos (${i} de ${itens.length})…` });
    const assinatura = item.file.name + "|" + item.file.size + "|" + item.file.lastModified;
    let info;
    if (vistos.has(assinatura)) info = { tipo: "ignorado", motivo: "cópia de outro arquivo da pasta" };
    else {
      try { info = await classifica(item); }
      catch (e) { info = { tipo: "ignorado", motivo: "não foi possível ler: " + ((e && e.message) || e), erro: true }; }
    }
    vistos.add(assinatura);
    arquivos.push({ rel: item.rel, file: item.file, tamanho: item.file.size, ...info });
  }

  const perfis = new Map(), descontos = new Map(), orcados = [];
  for (const a of arquivos) {
    try {
      if (a.tipo === "perfil") { avisa("progresso", { pct: 12, texto: `Lendo perfis de pagamento: ${a.rel}` }); a.registros = await lePerfil(a, perfis); a.livro = null; }
      if (a.tipo === "desconto") { avisa("progresso", { pct: 14, texto: `Lendo descontos: ${a.rel}` }); a.registros = await leDesconto(a, descontos); a.livro = null; }
      if (a.tipo === "orcado") {
        const o = await leOrcado(a.file, a.aba);
        const fonte = a.rel.split("/").pop().replace(/\.[^.]+$/, "");
        o.forEach((x) => { x.arquivo = a.rel; x.fonte = fonte; });
        orcados.push(...o);
        a.registros = o.length;
        if (!o.length) { a.tipo = "ignorado"; a.motivo = "planilha de orçado sem a linha da arrecadação"; }
      }
    } catch (e) {
      a.motivo = "não foi possível ler: " + ((e && e.message) || e); a.erro = true; a.tipo = "ignorado";
    }
  }

  const agregador = new C.Agregador();
  const diarias = arquivos.filter((a) => a.tipo === "diaria"), acumuladas = arquivos.filter((a) => a.tipo === "acumulada");
  // o perfil entra na leitura de cada linha: trocar a planilha de perfil invalida o cache
  const assinaturaPerfil = arquivos.filter((a) => a.tipo === "perfil").map((a) => `${a.rel}|${a.tamanho}|${a.file.lastModified}`).join(";");
  let db = null;
  try { db = await banco(); } catch (e) { /* navegador sem IndexedDB: lê tudo */ }
  const usados = new Set(), exportados = new Map();
  const faturas = arquivos.filter((a) => a.tipo === "faturamento");
  const totalBytes = [...diarias, ...acumuladas, ...faturas].reduce((s, a) => s + a.tamanho, 0) || 1;
  let base = 0;
  for (const a of [...diarias, ...acumuladas]) {
    const id = `v${CACHE_VERSAO}|${R.FERIADOS_EXTRAS.join(",")}|${a.rel}|${a.tamanho}|${a.file.lastModified}|${assinaturaPerfil}`;
    usados.add(id);
    let exp = db ? await cacheLe(db, id) : null;
    if (exp) { a.doCache = true; avisa("progresso", { pct: 15 + Math.round((base / totalBytes) * 83), texto: `Já lido antes: ${a.rel}` }); }
    else {
      try {
        exp = await leCsv(a.file, (lidos) => avisa("progresso", {
          pct: 15 + Math.round(((base + lidos) / totalBytes) * 83),
          texto: `Lendo ${a.rel} (${(lidos / 1048576).toFixed(0)} de ${(a.tamanho / 1048576).toFixed(0)} MB)`,
        }), new C.LeituraArquivo(perfis.size ? perfis : null));
        if (db) await cacheGrava(db, id, exp);
      } catch (e) {
        Object.assign(a, { tipo: "ignorado", motivo: "não foi possível ler: " + ((e && e.message) || e), erro: true });
      }
    }
    if (exp) exportados.set(a, exp);
    base += a.tamanho;
  }
  // faturamento: cada arquivo lido uma vez e guardado (chave própria, "fat|…")
  const exportsFat = [];
  for (const a of faturas) {
    const id = `fat|v${CACHE_FATURAMENTO}|${a.rel}|${a.tamanho}|${a.file.lastModified}`;
    usados.add(id);
    let exp = db ? await cacheLe(db, id) : null;
    if (exp) { a.doCache = true; avisa("progresso", { pct: 15 + Math.round((base / totalBytes) * 83), texto: `Já lido antes: ${a.rel}` }); }
    else {
      try {
        exp = await leFaturamento(a.file, (lidos) => avisa("progresso", {
          pct: 15 + Math.round(((base + lidos) / totalBytes) * 83),
          texto: `Lendo faturamento ${a.rel} (${(lidos / 1048576).toFixed(0)} de ${(a.tamanho / 1048576).toFixed(0)} MB)`,
        }));
        if (db) await cacheGrava(db, id, exp);
      } catch (e) {
        Object.assign(a, { tipo: "ignorado", motivo: "faturamento: não foi possível ler: " + ((e && e.message) || e), erro: true });
      }
    }
    if (exp) {
      exportsFat.push(exp);
      Object.assign(a, { registros: exp.linhas, meses: exp.refs, fora: exp.fora, semChave: exp.semChave, rejeitadas: exp.rejeitadas });
    }
    base += a.tamanho;
  }
  if (db) await cacheLimpa(db, usados);
  // O arquivo diário é o mais novo: os meses que ele traz não são lidos dos arquivos acumulados
  const mesesDiaria = new Set();
  for (const a of diarias) {
    if (!exportados.has(a)) continue;
    const r = agregador.junta(exportados.get(a));
    r.meses.forEach((m) => mesesDiaria.add(m));
    Object.assign(a, { registros: r.linhas, meses: r.meses });
  }
  for (const a of acumuladas) {
    if (!exportados.has(a)) continue;
    const r = agregador.junta(exportados.get(a), (m) => !mesesDiaria.has(m));
    Object.assign(a, { registros: r.linhas, meses: r.meses, puladas: r.puladas });
  }
  // arquivos de cada mês, para a extração da base (aba Base): o mês do arquivo diário sai só dele
  fontes = { diarias: diarias.filter((a) => a.meses), acumuladas: acumuladas.filter((a) => a.meses), mesesDiaria };
  avisa("progresso", { pct: 99, texto: "Montando as tabelas…" });
  const dados = agregador.resultado(descontos);
  // cruzamento com o faturamento (só somas pequenas vão para a página)
  let cruzamento = null;
  if (exportsFat.length) {
    avisa("progresso", { pct: 99, texto: "Cruzando faturamento e arrecadação…" });
    cruzamento = C.cruzaFaturamento(exportsFat, dados.analise.pagamentos, dados.meses);
  }
  return {
    dados, orcados, cruzamento,
    temPerfil: perfis.size > 0, temDesconto: descontos.size > 0,
    mesesDiaria: [...mesesDiaria].sort(),
    mesesDesconto: [...descontos.keys()].sort(),
    arquivos: arquivos.map(({ file, livro, ...a }) => a),
  };
}

// ---------- aba Base: linhas completas dos CSVs para uma lista de matrículas e meses ----------
// Relê só os arquivos que têm os meses pedidos (as linhas inteiras não ficam guardadas). A saída tem as colunas do 1º
// arquivo, na mesma ordem; arquivos com colunas em outra ordem são reorganizados pelo nome da coluna.
// ligs = null: todas as matrículas (base completa). porMesArquivo: um CSV para cada mês. O CSV é montado em blocos (Blob)
// de alguns MB, para um mês inteiro não virar um texto só na memória.
async function extraiBase({ id, ligs, meses, porMesArquivo }) {
  if (!fontes) throw new Error("dados ainda não lidos");
  const quer = ligs ? new Set(ligs.map(C.ligacao)) : null, mesesQ = new Set(meses);
  const usaDiaria = (m) => fontes.mesesDiaria.has(m);
  const arquivos = [
    ...fontes.diarias.filter((a) => a.meses.some((m) => mesesQ.has(m))).map((a) => ({ a, aceita: (m) => mesesQ.has(m) })),
    ...fontes.acumuladas.filter((a) => a.meses.some((m) => mesesQ.has(m) && !usaDiaria(m))).map((a) => ({ a, aceita: (m) => mesesQ.has(m) && !usaDiaria(m) })),
  ];
  const total = arquivos.reduce((t, x) => t + x.a.tamanho, 0) || 1;
  let base = 0, cab = null, chavesCab = null, linhas = 0;
  const saidas = new Map(), porMes = {}, achadas = new Set();
  const fecha = (o) => { if (o.partes.length) { o.blobs.push(new Blob([o.partes.join("\r\n") + "\r\n"])); o.partes = []; o.tam = 0; } };
  const escreve = (k, linha) => {
    let o = saidas.get(k);
    if (!o) { o = { partes: [], tam: 0, blobs: [], linhas: 0 }; saidas.set(k, o); }
    o.partes.push(linha); o.tam += linha.length + 2; o.linhas++;
    if (o.tam > 4e6) fecha(o);
  };
  for (const { a, aceita } of arquivos) {
    let idx = null, ordem = null;
    await linhasDoArquivo(a.file, (linha) => {
      const p = linha.split(";");
      if (!idx) {
        const ch = p.map(C.chave);
        idx = { lig: ch.indexOf("NLIGACAO"), cred: ch.indexOf("DATACREDITO") };
        if (!cab) { cab = linha; chavesCab = ch; }
        else if (ch.join(";") !== chavesCab.join(";")) ordem = chavesCab.map((c) => ch.indexOf(c));
        return;
      }
      const cred = p[idx.cred] || "";
      const mes = cred.length >= 10 ? cred.slice(6, 10) + "-" + cred.slice(3, 5) : "";
      if (!aceita(mes)) return;
      if (quer) {
        const lig = C.ligacao(p[idx.lig]);
        if (!quer.has(lig)) return;
        achadas.add(lig);
      }
      porMes[mes] = (porMes[mes] || 0) + 1;
      linhas++;
      escreve(porMesArquivo ? mes : "", ordem ? ordem.map((j) => (j >= 0 ? p[j] : "")).join(";") : linha);
    }, (lidos) => avisa("extracao-progresso", { id, pct: Math.round(((base + lidos) / total) * 100), texto: `Lendo ${a.rel}` }));
    base += a.tamanho;
  }
  const saida = [...saidas.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([mes, o]) => {
    fecha(o);
    return { mes, linhas: o.linhas, blob: new Blob(["\ufeff" + cab + "\r\n", ...o.blobs], { type: "text/csv;charset=utf-8" }) };
  });
  const naoEncontradas = quer ? [...quer].filter((l) => !achadas.has(l)) : [];
  avisa("extracao", { id, saida, linhas, porMes, naoEncontradas, arquivos: arquivos.length, completa: !quer });
}
// Base de cobrança: pagaram no mês A e não pagaram no mês B (nas combinações marcadas pelos filtros do cabeçalho)
function respondeCobranca({ miA, miB, marcas }) {
  const lista = C.pagaramNaoPagaram(analise, miA, miB, marcas);
  for (const x of lista) { x.nome = nomeDe(x.lig); x.lig = ligTxt(x.lig); }
  return { lista };
}
async function linhasDoArquivo(file, aoLinha, aoLer) {
  const leitor = file.stream().getReader();
  let resto = "", dec = null, lidos = 0, ultimo = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    if (!dec) dec = new TextDecoder(ehUtf8(value) ? "utf-8" : "windows-1252");
    resto += dec.decode(value, { stream: true });
    const partes = resto.split("\n");
    resto = partes.pop();
    for (const l of partes) { const x = l.endsWith("\r") ? l.slice(0, -1) : l; if (x) aoLinha(x); }
    lidos += value.length;
    if (lidos - ultimo > 8e6) { ultimo = lidos; aoLer(lidos); }
  }
  if (dec) resto += dec.decode();
  if (resto.replace(/\r$/, "")) aoLinha(resto.replace(/\r$/, ""));
  aoLer(lidos);
}
