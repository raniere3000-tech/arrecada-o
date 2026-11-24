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
let combosArr = null;                                  // cidade/subcategoria/SUP de cada combinação da arrecadação
let fontesFat = null;                                  // arquivos de faturamento lidos (com as referências de cada um)
let cadastroFat = null;                                // endereço, grupo, rota e situação da ligação da referência mais recente
let combosFat = null;                                  // combinações (cidade, categoria) da fatura
// contas a receber: duas bases possíveis na pasta, a total e a só de notas fiscais ("NFC" no nome do arquivo);
// cada uma é um Map matrícula → resumo. As consultas dizem qual usar (recTipo: "nfc" ou "total").
let receberBases = { total: null, nfc: null };
let arquivosPasta = [];                                // todos os arquivos da pasta, com o motivo dos ignorados (conferência de matrícula)
let cadastroSup = null;                                // Map ligação → superintendência do cadastro (null = sem cadastro na pasta)
const recBase = (tipo) => receberBases[tipo] || null;

self.onmessage = async (ev) => {
  if (ev.data.tipo === "analise") { respondeAnalise(ev.data); return; }
  if (ev.data.tipo === "clientes") { responde("clientes", ev.data.id, () => respondeClientes(ev.data)); return; }
  if (ev.data.tipo === "matricula") { responde("matricula", ev.data.id, () => respondeMatricula(ev.data)); return; }
  if (ev.data.tipo === "comparativo") { responde("comparativo", ev.data.id, () => respondeComparativo(ev.data)); return; }
  if (ev.data.tipo === "conferir") { responde("conferir", ev.data.id, () => conferirMatriculas(ev.data)); return; }
  if (ev.data.tipo === "bimatriculas") { responde("bimatriculas", ev.data.id, () => respondeBIMatriculas(ev.data)); return; }
  if (ev.data.tipo === "negociacao") { responde("negociacao", ev.data.id, () => respondeNegociacao(ev.data)); return; }
  if (ev.data.tipo === "oportunidades") { responde("oportunidades", ev.data.id, () => respondeOportunidades(ev.data)); return; }
  if (ev.data.tipo === "mensal") { responde("mensal", ev.data.id, () => extraiMensal(ev.data)); return; }
  if (ev.data.tipo === "extrair") { extraiBase(ev.data).catch((e) => avisa("extracao", { id: ev.data.id, erro: String((e && e.message) || e) })); return; }
  try {
    const r = await processa(ev.data.arquivos || []);
    analise = r.dados.analise;
    delete r.dados.analise;
    contasFat = r.cruzamento ? r.cruzamento.base : null;
    combosArr = r.dados.combos;
    combosFat = r.cruzamento ? r.cruzamento.combos : null;
    grupoFat = null;                                   // refeito na 1ª consulta desta pasta
    receberBases = r.receberMapas;
    delete r.receberMapas;
    cadastroSup = r.cadastroMapa;
    delete r.cadastroMapa;
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

function responde(tipo, id, f) {                       // f pode devolver uma promessa (quando precisa ler um arquivo)
  if (!analise) { avisa(tipo, { id, erro: "dados ainda não lidos" }); return; }
  Promise.resolve().then(f).then((r) => avisa(tipo, { id, ...r }), (e) => avisa(tipo, { id, erro: String((e && e.message) || e) }));
}
// Dados de cadastro do faturamento (aba Base): lidos só quando pedidos, do(s) arquivo(s) da referência mais recente da
// pasta, e guardados aqui. Matrícula → [endereço, grupo, rota, situação da ligação] (1ª linha da matrícula no arquivo).
const COLS_CADASTRO = ["ENDERECOLIGACAO", "GRUPO", "ROTA", "SITUACAOLIGACAO"];
async function leCadastroFat() {
  if (cadastroFat) return cadastroFat;
  const refs = (fontesFat || []).flatMap((a) => a.meses);
  if (!refs.length) return null;
  const ref = refs.sort()[refs.length - 1], arqs = fontesFat.filter((a) => a.meses.includes(ref)), mapa = new Map();
  for (const a of arqs) {
    let idx = null;
    await linhasDoArquivo(a.file, (linha) => {
      const p = C.separaCsv(linha);
      if (!idx) {
        if (!ehFaturamento(linha)) return;
        const ch = p.map(C.chave);
        idx = { lig: ch.indexOf(colunasFaturamento(linha).lig), ref: ch.indexOf("REFERENCIADELEITURA"), cols: COLS_CADASTRO.map((c) => ch.indexOf(c)) };
        return;
      }
      if (idx.ref >= 0) { const r = C.refDeTexto(p[idx.ref]); if (r && r !== ref) return; }
      const l = C.chaveLig(p[idx.lig]);
      if (!p[idx.lig] || mapa.has(l)) return;
      mapa.set(l, idx.cols.map((j) => (j >= 0 ? C.consertaAcento(String(p[j] || "").trim()) : "")));
    }, () => {});
  }
  cadastroFat = { ref, arquivos: arqs.map((a) => a.rel), mapa };
  return cadastroFat;
}
const nomeDe = (l) => analise.nomes.get(l) || (contasFat && contasFat.nomes.get(l)) || "";
const ligTxt = (l) => (l < 1e10 ? String(l) : "(não numérica)");
// aba Clientes e oportunidades: listas completas (a página mostra as primeiras e baixa o resto em CSV)
function respondeClientes(o) {
  const r = C.clientesOportunidades(analise, contasFat, o), receber = recBase(o.recTipo);
  if (receber) {
    // faturado sem pagamento: a matrícula está na base de contas a receber com saldo vencido? (confirma o "a investigar")
    const conf = { confirmadas: 0, valorFat: 0, saldo: 0, fora: 0, valorFora: 0 };
    for (const x of r.semPagamento.lista) {
      const rc = receber.get(x.lig);
      x.saldo = rc && rc.vencido > 0 ? rc.vencido : null;
      if (x.saldo) { conf.confirmadas++; conf.valorFat += x.valor; conf.saldo += x.saldo; } else { conf.fora++; conf.valorFora += x.valor; }
    }
    r.semPagamento.confirmacao = conf;
    for (const x of r.deixaram) { const rc = receber.get(x.lig); x.saldo = rc && rc.vencido > 0 ? rc.vencido : null; }
    const f = o.filtroRec || {}, sup = supDaCidade();
    const passa = (l, v) => !l || !l.length || l.includes(v);           // listas dos filtros de vários itens (vazia = todas)
    const supDe = (x) => {                            // a mesma regra da arrecadação (calculos.js, LeituraArquivo.adiciona)
      const sc = sup.get(x.cidade);
      if (!cadastroSup || R.SUPS_PELA_CIDADE.includes(sc)) return sc;
      const s = cadastroSup.get(C.ligacao(String(x.lig)));
      return !s ? R.SEM_SUP : R.SUPS_PELA_CIDADE.includes(s) ? sc : s;
    };
    const aceita = (x) => passa(f.sups, supDe(x)) && passa(f.cidades, x.cidade) && passa(f.gruposFat, grupoFatDe(x.lig));
    r.receber = C.analisaReceber(receber, analise, o.mi, aceita, o.meses);
    for (const x of r.receber.lista) { x.nome = x.nome || nomeDe(x.lig); x.lig = ligTxt(x.lig); }
  }
  for (const lista of [r.deixaram, r.voltaram, r.semPagamento.lista]) for (const x of lista) { x.nome = nomeDe(x.lig); x.lig = ligTxt(x.lig); }
  return { ...r, temFatura: !!contasFat };
}
// cidade → superintendência (pela tabela de zonas); subcategoria da fatura de cada matrícula (conta mais recente)
let supCidade = null, grupoFat = null;
function supDaCidade() {
  if (!supCidade) supCidade = new Map(Object.values(R.ZONAS).map(([cidade, sup]) => [cidade, sup]));
  return supCidade;
}
function grupoFatDe(l) {
  if (!grupoFat) {
    grupoFat = new Map();
    const refDe = new Map();
    if (contasFat) for (let p = 0; p < contasFat.lig.length; p++) {
      const k = contasFat.lig[p];
      if ((refDe.get(k) || 0) <= contasFat.ref[p]) { refDe.set(k, contasFat.ref[p]); grupoFat.set(k, (combosFat[contasFat.cmb[p]] || {}).grupo); }
    }
  }
  return grupoFat.get(l);
}
function respondeMatricula({ lig, recTipo }) {
  const receber = recBase(recTipo);
  const l = C.chaveLig(lig);
  return { lig: l < 1e10 ? String(l) : String(lig).trim(), ...C.historicoMatricula(analise, contasFat, l), receber: (receber && receber.get(l)) || null };
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
const COLS_RECEBER = ["NUMLIGACAO", "SALDOTOTAL", "FAIXADESCRICAO"];   // contas a receber (vencidas e a vencer, por faixa de atraso)
const COLS_CAD_SUP = ["NUMLIGACAO", "SUPERINTENDENCIA"];    // cadastro: superintendência de cada matrícula
const COLS_PERFIL = ["NUMLIGACAO", "SEQRESPONSAVEL", "CLUSTERSALDO"];
const COLS_ORCADO = ["SUP", "RUBRICA"];

async function classifica(item) {
  const { file, rel } = item, e = ext(file.name);
  if (/^ajustes_arrecadacao/i.test(file.name)) return { tipo: "ajustes" };
  if (file.name.startsWith("~$")) return { tipo: "ignorado", motivo: "arquivo temporário do Excel" };
  if (e === "csv" || e === "txt") {
    const linhas = await primeirasLinhas(file);
    if (ehArrecadacao(linhas[0] || "")) return { tipo: C.chave(rel).includes("DIARI") ? "diaria" : "acumulada" };
    const iCad = linhas.findIndex((l) => { const cs = l.split(/[;,\t]/).map(C.chave);   // cadastro, e não desconto/perfil/receber com a SUP
      return COLS_CAD_SUP.every((c) => cs.includes(c)) && ![COLS_DESCONTO, COLS_PERFIL, COLS_RECEBER].some((t) => t.every((c) => cs.includes(c))); });
    if (iCad >= 0) return { tipo: "cadastro", csv: true };
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
  if (!inteira && file.size > XLSX_GRANDE && e === "xlsx") {          // grande (ex.: cadastro): reconhece só pelo começo, em fluxo
    const { out } = await fxPrimeiras(file);
    for (const { aba, linhas } of out) {
      if (achaCabecalho(linhas, COLS_DESCONTO)) return { tipo: "desconto", aba };
      if (achaCabecalho(linhas, COLS_PERFIL)) return { tipo: "perfil", aba };
      if (achaCabecalho(linhas, COLS_RECEBER)) return { tipo: "receber", aba };
      if (achaCabecalho(linhas, COLS_CAD_SUP)) return { tipo: "cadastro", aba, fluxo: true };
      if (achaCabecalho(linhas, COLS_ORCADO)) return { tipo: "orcado", aba };
    }
    return { tipo: "ignorado", motivo: "planilha não usada pelo painel (não é desconto, perfil do cliente, orçado, contas a receber nem cadastro com a superintendência)" };
  }
  const livro = leLivro(await file.arrayBuffer(), inteira ? 0 : 16);
  for (const aba of livro.SheetNames) {
    const linhas = linhasDaAba(livro, aba);
    const guarda = inteira ? { livro } : {};
    // desconto, perfil e contas a receber primeiro: essas planilhas podem ter também a coluna SUPERINTENDENCIA
    // (ex.: base de desconto da Leste e do Interior) e não podem ser tomadas pelo cadastro
    if (achaCabecalho(linhas, COLS_DESCONTO)) return { tipo: "desconto", aba, ...guarda };
    if (achaCabecalho(linhas, COLS_PERFIL)) return { tipo: "perfil", aba, ...guarda };
    if (achaCabecalho(linhas, COLS_RECEBER)) return { tipo: "receber", aba };
    if (achaCabecalho(linhas, COLS_CAD_SUP)) return { tipo: "cadastro", aba };
    if (achaCabecalho(linhas, COLS_ORCADO)) return { tipo: "orcado", aba };
  }
  return { tipo: "ignorado", motivo: "planilha não usada pelo painel (não é desconto, perfil do cliente, orçado, contas a receber nem cadastro com a superintendência)" };
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
// data da base de contas a receber: do nome do arquivo (27-10-2026, 2026-10-27, 27.10.2026) ou a data de modificação
function dataDoArquivo(file) {
  let m = /(\d{4})[-_.](\d{2})[-_.](\d{2})/.exec(file.name);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(\d{2})[-_.](\d{2})[-_.](\d{4})/.exec(file.name);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return new Date(file.lastModified).toISOString().slice(0, 10);
}
async function leReceber(arq) {
  const linhas = linhasDaAba(leLivro(await arq.file.arrayBuffer()), arq.aba);
  const cab = achaCabecalho(linhas, COLS_RECEBER), ix = (c) => cab.ch.indexOf(c);
  const col = { lig: ix("NUMLIGACAO"), nome: ix("NOMCLIENTE"), contas: ix("CONTASTOTAIS"), saldo: ix("SALDOTOTAL"), faixa: ix("FAIXADESCRICAO"),
    sitLig: ix("SITLIG"), tipo: ix("TIPOLIGACAO"), contato: ix("CONTATO"), cidade: ix("CIDADE") };
  const regs = [];
  for (let i = cab.i + 1; i < linhas.length; i++) {
    const l = linhas[i];
    if (!l || l[col.lig] == null || l[col.lig] === "") continue;
    const v = (k) => (col[k] >= 0 && l[col[k]] != null ? l[col[k]] : "");
    regs.push({ lig: String(v("lig")), nome: v("nome"), contas: String(v("contas")), saldo: typeof v("saldo") === "number" ? String(v("saldo")).replace(".", ",") : String(v("saldo")), faixa: v("faixa"),
      sitLig: v("sitLig"), tipo: v("tipo"), contato: v("contato"), cidade: v("cidade") });
  }
  return { mapa: C.montaReceber(regs), linhas: regs.length };
}
// Cadastro: ligação → superintendência (nome do painel: LAGOS = Interior). Planilha (.xlsx) ou CSV (; , ou tab).
// Matrícula repetida com superintendências diferentes: vale a 1ª e conta como divergente. Em branco ou "-": não entra.
async function leCadastro(arq, mapa) {
  let n = 0, divergentes = 0;
  const guarda = (lig, sup) => {
    const l = C.ligacao(lig), x = R.supDoCadastro(sup);
    if (!l || !x) return;
    const ja = mapa.get(l);
    if (ja === undefined) { mapa.set(l, x); n++; } else if (ja !== x) divergentes++;
  };
  if (arq.csv) {
    let idx = null, sep = ";";
    await linhasDoArquivo(arq.file, (linha) => {
      if (!idx) {
        sep = [";", "\t", ","].find((x) => linha.includes(x)) || ";";
        const ch = linha.split(sep).map(C.chave);
        if (!COLS_CAD_SUP.every((c) => ch.includes(c))) return;    // título antes do cabeçalho
        idx = { lig: ch.indexOf("NUMLIGACAO"), sup: ch.indexOf("SUPERINTENDENCIA") };
        return;
      }
      const p = linha.split(sep);
      guarda(String(p[idx.lig] || "").replace(/"/g, "").trim(), String(p[idx.sup] || "").replace(/"/g, ""));
    }, () => {});
  } else if (arq.fluxo || arq.file.size > XLSX_GRANDE) {
    // planilha grande: linha a linha, sem montar a planilha na memória
    const { sst, abas } = await fxAbre(arq.file), aba = abas.find((x) => x.nome === arq.aba) || abas[0];
    if (!aba) throw new Error("planilha sem abas");
    const primeiras = [];
    let cab = null, vistas = 0;
    await fxBlocos(arq.file, aba.e, "</row>", (b) => {
      const l = fxCelulas(b.slice(b.lastIndexOf("<row")), sst);
      if (!cab) {
        primeiras.push(l); vistas++;
        cab = achaCabecalho(primeiras, COLS_CAD_SUP);
        if (!cab && vistas > 15) return false;
        return;
      }
      const { NUMLIGACAO: a, SUPERINTENDENCIA: s } = cab.idx;
      if (l[a] != null) guarda(l[a], l[s]);
    }, (f) => avisa("progresso", { pct: 13, texto: `Lendo cadastro (superintendência): ${arq.rel} (${Math.round(f * 100)}%)` }));
    if (!cab) throw new Error("não achei as colunas NUM_LIGACAO e SUPERINTENDENCIA");
  } else {
    const linhas = linhasDaAba(leLivro(await arq.file.arrayBuffer()), arq.aba);
    const cab = achaCabecalho(linhas, COLS_CAD_SUP), { NUMLIGACAO: a, SUPERINTENDENCIA: b } = cab.idx;
    for (let i = cab.i + 1; i < linhas.length; i++) { const l = linhas[i]; if (l && l[a] != null) guarda(l[a], l[b]); }
  }
  return { n, divergentes };
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
// Planilha de orçado (RF): TODAS as abas com as colunas SUP e RUBRICA (ex.: uma aba Interior e outra Leste, no mesmo
// formato). A superintendência vem da coluna SUP (LAGOS = Interior); se ela não for uma superintendência do painel, vale o
// nome da aba (ex.: aba "Leste"). Devolve também as abas lidas (aba Dados).
async function leOrcado(file) {
  const livro = leLivro(await file.arrayBuffer()), out = [], abas = [];
  const supDe = (t) => { const k = C.chave(t); return k === "LAGOS" ? "INTERIOR" : R.SUPS.find((x) => k === x || k.includes(x)) || (k.includes("LAGOS") ? "INTERIOR" : ""); };
  for (const aba of livro.SheetNames) {
    const linhas = linhasDaAba(livro, aba), cab = achaCabecalho(linhas, COLS_ORCADO);
    if (!cab) continue;
    const { SUP: s, RUBRICA: r } = cab.idx, colMes = [];
    linhas[cab.i].forEach((v, j) => { const ref = refDaCelula(v); if (ref && j !== s && j !== r) colMes.push([j, ref]); });
    let n = 0;
    for (let i = cab.i + 1; i < linhas.length; i++) {
      const l = linhas[i];
      if (!l || !C.ehLinhaArrecadacao(l[r])) continue;
      const sup = supDe(l[s]) || supDe(aba) || C.chave(l[s]);
      for (const [j, ref] of colMes) {
        const v = C.numeroBR(l[j] == null ? "" : l[j]);
        if (isFinite(v)) { out.push({ sup, mes: ref, valor: v, aba }); n++; }
      }
    }
    if (n) abas.push(aba);
  }
  out.abas = abas;
  return out;
}


// ---------- .xlsx grande, lido em fluxo (linha a linha) ----------
// O SheetJS monta a planilha inteira na memória: um cadastro de centenas de milhares de linhas passa do limite do navegador
// (o XML da aba vira um texto grande demais) e a leitura falha. Acima de XLSX_GRANDE, o arquivo é lido por partes: o zip
// pelo índice central (com zip64), cada aba descompactada em fluxo (DecompressionStream) e cortada em </row>.
const XLSX_GRANDE = 25 * 1048576;
function fxDec(s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (x, e) =>
    e === "amp" ? "&" : e === "lt" ? "<" : e === "gt" ? ">" : e === "quot" ? '"' : e === "apos" ? "'" : e[1] === "x" ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(+e.slice(1)));
}
function fxTextos(xml) {
  xml = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "", m; const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  while ((m = re.exec(xml))) out += m[1];
  return fxDec(out);
}
const fxCol = (letras) => { let n = 0; for (let i = 0; i < letras.length; i++) n = n * 26 + (letras.charCodeAt(i) - 64); return n - 1; };
async function fxZip(file) {
  const tailLen = Math.min(file.size, 65557 + 22), tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("não parece ser um .xlsx válido");
  let n = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  if ((cdOff === 0xFFFFFFFF || n === 0xFFFF) && eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {
    const z64 = Number(tail.getBigUint64(eocd - 12, true)), z = new DataView(await file.slice(z64, z64 + 56).arrayBuffer());
    n = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
  }
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer()), td = new TextDecoder(), ents = new Map();
  let p = 0;
  while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50) {
    const metodo = cd.getUint16(p + 10, true), nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    let csize = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true), off = cd.getUint32(p + 42, true);
    const nome = td.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl));
    let q = p + 46 + nl; const fim = q + xl;
    while (q + 4 <= fim) {
      const id = cd.getUint16(q, true), sz = cd.getUint16(q + 2, true); let r = q + 4;
      if (id === 0x0001) {
        if (usize === 0xFFFFFFFF) { usize = Number(cd.getBigUint64(r, true)); r += 8; }
        if (csize === 0xFFFFFFFF) { csize = Number(cd.getBigUint64(r, true)); r += 8; }
        if (off === 0xFFFFFFFF) { off = Number(cd.getBigUint64(r, true)); r += 8; }
      }
      q += 4 + sz;
    }
    ents.set(nome, { nome, metodo, csize, usize, off });
    p = fim + cl;
  }
  return ents;
}
async function fxFluxo(file, e) {
  const lh = new DataView(await file.slice(e.off, e.off + 30).arrayBuffer()), ini = e.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  let st = file.slice(ini, ini + e.csize).stream();
  if (e.metodo === 8) st = st.pipeThrough(new DecompressionStream("deflate-raw"));
  else if (e.metodo !== 0) throw new Error("compressão não suportada em " + e.nome);
  return st.pipeThrough(new TextDecoderStream());
}
async function fxTexto(file, e) { const r = (await fxFluxo(file, e)).getReader(); let o = ""; for (;;) { const { value, done } = await r.read(); if (done) break; o += value; } return o; }
async function fxBlocos(file, e, fecho, aoBloco, aoLer) {
  const r = (await fxFluxo(file, e)).getReader();
  let buf = "", lidos = 0;
  for (;;) {
    const { value, done } = await r.read();
    if (done) break;
    lidos += value.length; buf += value;
    let pos = 0, i;
    while ((i = buf.indexOf(fecho, pos)) !== -1) {
      const blk = buf.slice(pos, i); pos = i + fecho.length;
      if (aoBloco(blk) === false) { try { await r.cancel(); } catch (x) { /* já fechado */ } return; }
    }
    buf = buf.slice(pos);
    if (aoLer) aoLer(Math.min(1, lidos / Math.max(1, e.usize)));
  }
}
const FX_C = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, FX_R = /\br="([A-Z]+)/, FX_T = /\bt="([^"]+)"/, FX_V = /<v>([\s\S]*?)<\/v>/;
function fxCelulas(blk, sst) {
  const out = []; let m, seq = 0; FX_C.lastIndex = 0;
  while ((m = FX_C.exec(blk))) {
    const a = m[1], dentro = m[2], rm = FX_R.exec(a), col = rm ? fxCol(rm[1]) : seq; seq = col + 1;
    if (dentro === undefined) continue;
    const tm = FX_T.exec(a), t = tm ? tm[1] : "n";
    if (t === "inlineStr") { out[col] = fxTextos(dentro); continue; }
    const vm = FX_V.exec(dentro); if (!vm) continue;
    out[col] = t === "s" ? sst[+vm[1]] : t === "str" || t === "e" ? fxDec(vm[1]) : t === "b" ? vm[1] === "1" : +vm[1];
  }
  for (let j = 0; j < out.length; j++) if (out[j] === undefined) out[j] = null;
  return out;
}
// abre o .xlsx: textos compartilhados (sst) e as abas na ordem do arquivo
async function fxAbre(file) {
  const ents = await fxZip(file), sst = [], se = ents.get("xl/sharedStrings.xml");
  if (se) await fxBlocos(file, se, "</si>", (b) => { sst.push(fxTextos(b.slice(b.indexOf("<si")))); });
  const abas = [], wb = ents.get("xl/workbook.xml"), rel = ents.get("xl/_rels/workbook.xml.rels");
  if (wb && rel) {
    const wx = await fxTexto(file, wb), rx = await fxTexto(file, rel), alvo = {};
    for (const m of rx.matchAll(/<Relationship\b[^>]*>/g)) { const id = /\bId="([^"]+)"/.exec(m[0]), tg = /\bTarget="([^"]+)"/.exec(m[0]); if (id && tg) alvo[id[1]] = tg[1]; }
    for (const m of wx.matchAll(/<sheet\b[^>]*>/g)) {
      const nm = /\bname="([^"]*)"/.exec(m[0]), id = /\br:id="([^"]+)"/.exec(m[0]);
      if (!nm || !id || !alvo[id[1]]) continue;
      let t = alvo[id[1]]; t = t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, "");
      if (ents.has(t)) abas.push({ nome: fxDec(nm[1]), e: ents.get(t) });
    }
  }
  return { sst, abas };
}
// as primeiras n linhas de cada aba (para reconhecer o tipo da planilha pelo cabeçalho)
async function fxPrimeiras(file, n = 16) {
  const { sst, abas } = await fxAbre(file), out = [];
  for (const a of abas) {
    const linhas = [];
    await fxBlocos(file, a.e, "</row>", (b) => { linhas.push(fxCelulas(b.slice(b.lastIndexOf("<row")), sst)); return linhas.length < n; });
    out.push({ aba: a.nome, linhas });
  }
  return { sst, abas, out };
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
const CACHE_VERSAO = 11;                                // 11: contas pagas por ligação (base do BI por matrícula); 10: perfil atualizado
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

  const perfis = new Map(), perfisAtu = new Map(), descontos = new Map(), orcados = [], cadastro = new Map();
  // perfil do cliente: o congelado (set/2026, o arquivo de sempre, lido também pelo BI) e o atualizado (planilha de perfil com
  // ATUALIZADO no nome, na pasta principal). Mais de um atualizado: vale o mais recente (data no nome ou de modificação).
  const ehAtu = (a) => a.tipo === "perfil" && C.chave(a.file.name).includes("ATUALIZADO");
  const atus = arquivos.filter(ehAtu).sort((x, y) => dataDoArquivo(y.file).localeCompare(dataDoArquivo(x.file)) || y.file.lastModified - x.file.lastModified);
  atus.slice(1).forEach((a) => Object.assign(a, { tipo: "ignorado", motivo: `perfil atualizado mais antigo: vale ${atus[0].rel}` }));
  const perfilInfo = { congelado: [], atualizado: null };
  for (const a of arquivos) {
    try {
      if (a.tipo === "cadastro") {
        avisa("progresso", { pct: 13, texto: `Lendo cadastro (superintendência): ${a.rel}` });
        const r = await leCadastro(a, cadastro);
        a.registros = r.n;
        if (r.divergentes) a.motivo = `${r.divergentes} matrícula(s) repetida(s) com outra superintendência: vale a 1ª`;
      }
      if (a.tipo === "perfil") {
        const atu = ehAtu(a);
        avisa("progresso", { pct: 12, texto: `Lendo perfil ${atu ? "atualizado" : "congelado"}: ${a.rel}` });
        a.registros = await lePerfil(a, atu ? perfisAtu : perfis); a.livro = null; a.perfilTipo = atu ? "atualizado" : "congelado";
        if (atu) perfilInfo.atualizado = { arquivo: a.rel, registros: a.registros, data: dataDoArquivo(a.file) }; else perfilInfo.congelado.push(a.rel);
      }
      if (a.tipo === "desconto") { avisa("progresso", { pct: 14, texto: `Lendo descontos: ${a.rel}` }); a.registros = await leDesconto(a, descontos); a.livro = null; }
      if (a.tipo === "orcado") {
        const o = await leOrcado(a.file);
        a.abas = o.abas;
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

  // contas a receber: até duas bases, a total e a só de notas fiscais ("NFC" no nome); de cada tipo vale a mais recente
  // (data no nome do arquivo ou de modificação)
  const receberMapas = { total: null, nfc: null }, receberInfo = { total: null, nfc: null };
  for (const tipo of ["total", "nfc"]) {
    const bases = arquivos.filter((a) => a.tipo === "receber" && (C.chave(a.file.name).includes("NFC") ? "nfc" : "total") === tipo)
      .map((a) => ({ a, data: dataDoArquivo(a.file) })).sort((x, y) => y.data.localeCompare(x.data) || y.a.file.lastModified - x.a.file.lastModified);
    const nome = tipo === "nfc" ? "contas a receber só de notas fiscais (NFC)" : "contas a receber total";
    for (const [i, { a, data }] of bases.entries()) {
      if (i > 0) { Object.assign(a, { tipo: "ignorado", motivo: `base de ${nome} mais antiga: vale a de ${bases[0].data.split("-").reverse().join("/")} (${bases[0].a.rel})` }); continue; }
      try {
        avisa("progresso", { pct: 15, texto: `Lendo ${nome}: ${a.rel}` });
        const r = await leReceber(a);
        receberMapas[tipo] = r.mapa;
        a.registros = r.linhas;
        a.recTipo = tipo;
        receberInfo[tipo] = { arquivo: a.rel, data, linhas: r.linhas, matriculas: r.mapa.size };
      } catch (e) { Object.assign(a, { tipo: "ignorado", motivo: `${nome}: não foi possível ler: ` + ((e && e.message) || e), erro: true }); }
    }
  }

  const agregador = new C.Agregador();
  const diarias = arquivos.filter((a) => a.tipo === "diaria"), acumuladas = arquivos.filter((a) => a.tipo === "acumulada");
  // o perfil entra na leitura de cada linha: trocar a planilha de perfil invalida o cache
  const assinaturaPerfil = arquivos.filter((a) => a.tipo === "perfil" || a.tipo === "cadastro").map((a) => `${a.tipo}|${a.rel}|${a.tamanho}|${a.file.lastModified}`).join(";");
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
        }), new C.LeituraArquivo(perfis.size ? perfis : null, cadastro.size ? cadastro : null, perfisAtu.size ? perfisAtu : null));
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
  cadastroFat = null;
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
  fontesFat = faturas.filter((a) => a.tipo === "faturamento" && a.meses && a.meses.length);
  if (db) await cacheLimpa(db, usados);
  // O arquivo diário é o mais novo: os meses que ele traz não são lidos dos arquivos acumulados DA MESMA BASE (a base de cada
  // arquivo é a superintendência, pela cidade, com mais valor nele: Interior/Lagos ou Leste). Assim o diário do Interior não
  // tira do painel o acumulado da Leste do mesmo mês, e vice-versa.
  // O mês do diário só vale quando ele tem pelo menos tantas linhas desse mês quanto os acumulados da mesma base: um diário
  // de outubro com umas poucas linhas creditadas em 30/09 não pode tirar do painel o acumulado de setembro inteiro.
  const mesesDiaria = new Set(), diariaDaBase = new Set();       // "SUP|mês"
  const contaLinhas = (lista) => {
    const n = new Map();
    for (const a of lista) {
      if (!exportados.has(a)) continue;
      const exp = exportados.get(a), b = C.supPrincipal(exp);
      for (const [m, X] of Object.entries(exp.meses)) n.set(b + "|" + m, (n.get(b + "|" + m) || 0) + X.linhas);
    }
    return n;
  };
  const nAcum = contaLinhas(acumuladas), nDiaria = contaLinhas(diarias);
  for (const a of diarias) {
    if (!exportados.has(a)) continue;
    const exp = exportados.get(a), base = C.supPrincipal(exp);
    const r = agregador.junta(exp, (m) => (nDiaria.get(base + "|" + m) || 0) >= (nAcum.get(base + "|" + m) || 0));
    r.meses.forEach((m) => { mesesDiaria.add(m); diariaDaBase.add(base + "|" + m); });
    Object.assign(a, { registros: r.linhas, meses: r.meses, puladas: r.puladas, base });
  }
  for (const a of acumuladas) {
    if (!exportados.has(a)) continue;
    const exp = exportados.get(a), base = C.supPrincipal(exp);
    const r = agregador.junta(exp, (m) => !diariaDaBase.has(base + "|" + m));
    Object.assign(a, { registros: r.linhas, meses: r.meses, puladas: r.puladas, base });
  }
  // arquivos de cada mês, para a extração da base (aba Base): o mês do arquivo diário sai só dele
  fontes = { diarias: diarias.filter((a) => a.meses), acumuladas: acumuladas.filter((a) => a.meses), mesesDiaria };
  arquivosPasta = arquivos;
  avisa("progresso", { pct: 99, texto: "Montando as tabelas…" });
  const dados = agregador.resultado(descontos);
  // cruzamento com o faturamento (só somas pequenas vão para a página)
  let cruzamento = null;
  if (exportsFat.length) {
    avisa("progresso", { pct: 99, texto: "Cruzando faturamento e arrecadação…" });
    cruzamento = C.cruzaFaturamento(exportsFat, dados.analise.pagamentos, dados.meses);
  }
  return {
    dados, orcados, cruzamento, receberInfo, receberMapas,
    temPerfil: perfis.size > 0, temDesconto: descontos.size > 0, perfilInfo,
    cadastroInfo: cadastro.size ? { matriculas: cadastro.size, porSup: [...cadastro.values()].reduce((o, x) => ((o[x] = (o[x] || 0) + 1), o), {}) } : null,
    cadastroMapa: cadastro.size ? cadastro : null,
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
  // a.meses do acumulado = só os meses usados dele (os que o diário da mesma base não substituiu)
  const arquivos = [
    ...fontes.diarias.filter((a) => a.meses.some((m) => mesesQ.has(m))).map((a) => ({ a, aceita: (m) => mesesQ.has(m) })),
    ...fontes.acumuladas.filter((a) => a.meses.some((m) => mesesQ.has(m))).map((a) => ({ a, aceita: (m) => mesesQ.has(m) && a.meses.includes(m) })),
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
// Conferência de matrícula (aba Dados): procura as matrículas em TODOS os CSV/TXT da pasta (inclusive os que o painel não
// usa) e diz, linha a linha, em que arquivo e mês está, o valor e se o painel contou — e, se não, por quê.
async function conferirMatriculas({ ligs, sups, cidades, grupos, meses, sel }) {
  const quer = new Set(ligs.map(C.ligacao)), passa = (l, v) => !l || !l.length || l.includes(v), zonas = new Map();
  const supDe = (zona, lig) => {
    let z = zonas.get(zona);
    if (!z) { z = C.zonaInfo(zona); zonas.set(zona, z); }
    const [cidade, supZona] = z;
    if (!cadastroSup || R.SUPS_PELA_CIDADE.includes(supZona)) return [cidade, supZona];
    const s = cadastroSup.get(C.ligacao(lig));
    return [cidade, !s ? R.SEM_SUP : R.SUPS_PELA_CIDADE.includes(s) ? supZona : s];
  };
  const linhas = [], porLig = new Map(), csvs = arquivosPasta.filter((a) => ["csv", "txt"].includes(ext(a.file.name)));
  let lidosArq = 0;
  for (const a of csvs) {
    lidosArq++;
    const usado = a.tipo === "diaria" || a.tipo === "acumulada";
    let idx = null, vistas = 0;
    await linhasDoArquivo(a.file, (linha) => {
      const p = linha.split(";");
      if (!idx) {
        if (++vistas > 30) return;
        const ch = p.map(C.chave);
        if (ch.includes("NLIGACAO")) idx = { lig: ch.indexOf("NLIGACAO"), cred: ch.indexOf("DATACREDITO"), pag: ch.indexOf("DATAPAGTO"), val: ch.indexOf("VALAUTENTICADO"),
          pago: ch.indexOf("VALORPAGO"), util: ch.indexOf("UTILIZACAOSUBCATEG"), zona: ch.indexOf("ZONALOCALIDADE"), tipo: ch.indexOf("TIPOFATURA"), venc: ch.indexOf("VENCIMENTO") };
        return;
      }
      const lig = C.ligacao(p[idx.lig]);
      if (!quer.has(lig)) return;
      const g = (j) => (j >= 0 ? String(p[j] || "").trim() : "");
      const cred = C.dataISO(g(idx.cred)), v = C.numeroBR(g(idx.val) || g(idx.pago)), zona = g(idx.zona), util = g(idx.util);
      const [cidade, sup] = supDe(zona, lig), grupo = util ? C.subInfo(util)[0] : R.SEM_CLASSIFICACAO, mes = cred ? cred.slice(0, 7) : "";
      const dia = cred ? C.calendario(mes).ordem[cred] : null;
      let situacao, contada = false;
      if (!usado) situacao = "Arquivo não usado pelo painel: " + (a.motivo || a.tipo);
      else if (!cred) situacao = "Sem Data Crédito: a linha é descartada";
      else if (!isFinite(v)) situacao = "Val. Autenticado sem número: a linha é descartada";
      else if (!(a.meses || []).includes(mes)) situacao = `O mês ${C.rotuloMes(mes)} deste arquivo não entra: vem de outro arquivo da mesma base (diário × acumulado)`;
      else {
        const fora = [];
        if (!passa(sups, sup)) fora.push(`Superintendência ${sup}`);
        if (!passa(cidades, cidade)) fora.push(`Cidade ${cidade}`);
        if (!passa(grupos, grupo)) fora.push(`Subcategoria ${grupo}`);
        if (fora.length) situacao = "Lida, mas fora dos filtros do cabeçalho: " + fora.join(", ");
        else if (meses && meses.length && !meses.includes(mes)) situacao = `Lida; ${C.rotuloMes(mes)} não está marcado no filtro Mês`;
        else if (!(sel & (1 << dia))) situacao = `Lida; crédito ${dia ? "no dia útil " + dia : "em fim de semana ou feriado"}, fora dos dias úteis marcados`;
        else { situacao = "Contada na tela"; contada = true; }
      }
      linhas.push({ lig: g(idx.lig), arquivo: a.rel, usado, credito: cred, mes, pagto: g(idx.pag), venc: g(idx.venc), valor: isFinite(v) ? v : null,
        tipo: g(idx.tipo), zona, util, cidade, sup, grupo, dia, situacao, contada, lida: usado && !!cred && isFinite(v) && (a.meses || []).includes(mes) });
      porLig.set(lig, (porLig.get(lig) || 0) + 1);
    }, () => avisa("conferir-progresso", { texto: `Procurando em ${a.rel} (${lidosArq} de ${csvs.length})` }));
  }
  const naoEncontradas = [...quer].filter((l) => !porLig.has(l));
  const xlsx = arquivosPasta.filter((a) => !["csv", "txt"].includes(ext(a.file.name)) && a.tipo === "ignorado").map((a) => a.rel);
  return { linhas, naoEncontradas, arquivos: csvs.length, xlsxIgnorados: xlsx };
}
// Relatório mensal (botão "Mensal"): o mês escolhido, dia a dia do calendário (fins de semana e feriados também), lido de
// novo dos CSVs (o painel guarda os fins de semana juntos no dia útil 0). Por dia: Val. Autenticado (sem o desconto
// comercial) por subcategoria × utilização; clientes pagantes (matrículas distintas) e contas pagas (notas fiscais, como
// no painel) por subcategoria. Segue os filtros do cabeçalho, com a mesma regra de superintendência da leitura.
async function extraiMensal({ mes, sups, cidades, grupos }) {
  if (!fontes) throw new Error("dados ainda não lidos");
  const arqs = [...fontes.diarias, ...fontes.acumuladas].filter((a) => a.meses.includes(mes));   // por base: diário ou acumulado
  const passa = (l, v) => !l || !l.length || l.includes(v), zonas = new Map();
  const supDe = (zona, lig) => {
    let z = zonas.get(zona);
    if (!z) { z = C.zonaInfo(zona); zonas.set(zona, z); }
    const [cidade, supZona] = z;
    if (!cadastroSup || R.SUPS_PELA_CIDADE.includes(supZona)) return [cidade, supZona];
    const s = cadastroSup.get(C.ligacao(lig));
    return [cidade, !s ? R.SEM_SUP : R.SUPS_PELA_CIDADE.includes(s) ? supZona : s];
  };
  const valores = new Map(), quantos = new Map();
  let linhas = 0, ultimo = "";
  const leitura = {
    adiciona(r) {
      const cred = C.dataISO(r.credito);
      if (!cred || cred.slice(0, 7) !== mes) return;
      const v = C.numeroBR(r.valor);
      if (!isFinite(v)) return;
      const zona = String(r.zona || "").trim(), util = String(r.util || "").trim(), [cidade, sup] = supDe(zona, r.lig);
      const grupo = util ? C.subInfo(util)[0] : "";
      if (!passa(sups, sup) || !passa(cidades, cidade) || !passa(grupos, grupo || R.SEM_CLASSIFICACAO)) return;
      linhas++; if (cred > ultimo) ultimo = cred;
      const kv = cred + "\u0001" + grupo + "\u0001" + util;
      valores.set(kv, (valores.get(kv) || 0) + v);
      const kq = cred + "\u0001" + grupo;
      let q = quantos.get(kq);
      if (!q) { q = { ligs: new Set(), contas: 0 }; quantos.set(kq, q); }
      q.ligs.add(C.chaveLig(r.lig));
      if (R.TIPOS_CONTA.includes(String(r.tipo || "").trim())) q.contas++;
    },
    exporta() { return null; },
  };
  for (const a of arqs) await leCsv(a.file, () => {}, leitura);
  return {
    mes, linhas, ultimo, arquivos: arqs.map((a) => a.rel),
    valores: [...valores].map(([k, v]) => [...k.split("\u0001"), v]),
    quantos: [...quantos].map(([k, q]) => [...k.split("\u0001"), q.ligs.size, q.contas]),
  };
}
// Comparativo por mês: uma linha por matrícula e uma coluna de valor por mês (em branco = sem pagamento no mês).
// O CSV é montado aqui, em blocos, porque pode ter centenas de milhares de linhas.
async function respondeComparativo({ mis, rotulos, marcas, nomesSup, comFat, comRec, recTipo }) {
  const r = C.valoresPorMes(analise, mis, marcas), k = r.k, ex = await colunasExtras(comFat, comRec, recTipo);
  const txt = (t) => String(t == null ? "" : t).replace(/[;\r\n]/g, " ");
  const ordem = r.ligs.map((_, p) => p).sort((a, b) => r.ligs[a] - r.ligs[b]);
  const blobs = [], partes = [], porMes = rotulos.map(() => ({ matriculas: 0, valor: 0 }));
  let tam = 0;
  for (const p of ordem) {
    const c = combosArr[r.comb[p]] || {}, e = ex.de(r.ligs[p]);
    const cols = [ligTxt(r.ligs[p]), txt(nomeDe(r.ligs[p])), nomesSup[c.sup] || c.sup || "", c.cidade || "", c.grupo || "", ...e.fat.map(txt)];
    for (let j = 0; j < k; j++) {
      if (r.pagou[p * k + j]) { cols.push(nBR(r.vals[p * k + j])); porMes[j].matriculas++; porMes[j].valor += r.vals[p * k + j]; } else cols.push("");
    }
    cols.push(...e.rec.map(txt));
    const linha = cols.join(";");
    partes.push(linha); tam += linha.length + 2;
    if (tam > 4e6) { blobs.push(new Blob([partes.join("\r\n") + "\r\n"])); partes.length = 0; tam = 0; }
  }
  if (partes.length) blobs.push(new Blob([partes.join("\r\n") + "\r\n"]));
  const cab = ["Matrícula", "Nome", "Superintendência", "Cidade", "Subcategoria", ...ex.cabFat, ...rotulos.map((m) => `Arrecadado ${m}`), ...ex.cabRec].join(";");
  return { linhas: ordem.length, porMes, ...ex.info(), blob: new Blob(["\ufeff" + cab + "\r\n", ...blobs], { type: "text/csv;charset=utf-8" }) };
}
// Base de oportunidades: pagaram em pelo menos um dos meses A e deixaram de pagar em pelo menos um dos meses B (nas combinações marcadas pelos filtros do cabeçalho)
async function respondeOportunidades({ misA, misB, mesesA, mesesB, marcas, comFat, comRec, recTipo }) {
  const lista = C.pagaramNaoPagaramMeses(analise, misA, misB, marcas), ex = await colunasExtras(comFat, comRec, recTipo);
  for (const x of lista) {
    const e = ex.de(x.lig);
    x.fat = e.fat; x.rec = e.rec;
    x.nome = nomeDe(x.lig); x.lig = ligTxt(x.lig);
  }
  return { lista, mesesA, mesesB, cabFat: ex.cabFat, cabRec: ex.cabRec, ...ex.info() };
}
// Tabela do BI por matrícula (aba Dados): CSV em blocos (pode ter centenas de milhares de linhas)
function respondeBIMatriculas({ mis, misAnt, meses, marcas, sel, ligs, nomesSup }) {
  const quer = ligs ? new Set(ligs.map((l) => C.chaveLig(l))) : null;
  const mesTxt = meses.map((m) => C.rotuloMes(m));
  const blobs = [], partes = [], vistas = new Set();
  let tam = 0, valor = 0, n = 0;
  C.porMatricula(analise, combosArr, mis, misAnt, marcas, sel, quer, (x) => {
    if (x.pagou) vistas.add(x.lig); valor += x.valor; n++;
    // as colunas da tabela do BI, uma linha por matrícula: somando as linhas, dá a tabela (cliente pagante = 1)
    const linha = [ligTxt(x.lig), x.cidade, x.grupo, mesTxt[x.j], x.perfil, nBR(x.valor), x.pagou ? 1 : 0, x.pagouAnt == null ? "" : x.pagouAnt ? 1 : 0, x.contas].join(";");
    partes.push(linha); tam += linha.length + 2;
    if (tam > 4e6) { blobs.push(new Blob([partes.join("\r\n") + "\r\n"])); partes.length = 0; tam = 0; }
  });
  if (partes.length) blobs.push(new Blob([partes.join("\r\n") + "\r\n"]));
  const cab = ["Matrícula", "Cidade", "Subcategoria", "Mes/ano", "Classificação", "Arrecadacao_Acumulada", "Qtd_clientes_pagantes_acumulado",
    "Qtd_Clientes_pagas_mês_anterior", "Qtd_contas_pagas_acumulado"].join(";");
  const naoEncontradas = ligs ? ligs.filter((l) => !vistas.has(C.chaveLig(l))) : null;
  return { linhas: n, matriculas: vistas.size, valor, naoEncontradas,
    blob: new Blob(["\ufeff" + cab + "\r\n", ...blobs], { type: "text/csv;charset=utf-8" }) };
}
// Negociação (área Análises): pagaram em todos os meses misPagou e não pagaram no mês de referência miRef. Devolve o resumo por
// cidade e subcategoria, as 100 maiores matrículas (para a tela) e o CSV completo, montado aqui em blocos.
async function respondeNegociacao({ misPagou, miRef, rotulos, rotRef, incluiPagantes, marcas, nomesSup, comFat, comRec, recTipo, sel }) {
  const lista = C.negociacao(analise, misPagou, miRef, marcas, incluiPagantes, sel == null ? null : sel), n = misPagou.length, ex = await colunasExtras(comFat, comRec, recTipo);
  const txt = (t) => String(t == null ? "" : t).replace(/[;\r\n]/g, " ");
  const porCidade = new Map(), porSub = new Map(), top = [], blobs = [], partes = [];
  const soma = (mapa, k, x) => { let o = mapa.get(k); if (!o) { o = { rot: k, n: 0, nNao: 0, vals: new Array(n).fill(0) }; mapa.set(k, o); } o.n++; if (!x.pagouRef) o.nNao++; x.vals.forEach((v, j) => { o.vals[j] += v; }); };
  let tam = 0;
  for (const x of lista) {
    const c = combosArr[x.c] || {}, e = ex.de(x.lig);
    soma(porCidade, c.cidade || "—", x); soma(porSub, c.grupo || "—", x);
    if (top.length < 100) top.push({ lig: ligTxt(x.lig), nome: nomeDe(x.lig), sup: c.sup || "", cidade: c.cidade || "", grupo: c.grupo || "", vals: x.vals, pagouRef: x.pagouRef, valRef: x.valRef });
    const linha = [ligTxt(x.lig), txt(nomeDe(x.lig)), nomesSup[c.sup] || c.sup || "", c.cidade || "", c.grupo || "", ...e.fat.map(txt),
      ...x.vals.map(nBR), nBR(x.total), x.pagouRef ? "Pagou" : "Não pagou", x.pagouRef ? nBR(x.valRef) : "", ...e.rec.map(txt)].join(";");
    partes.push(linha); tam += linha.length + 2;
    if (tam > 4e6) { blobs.push(new Blob([partes.join("\r\n") + "\r\n"])); partes.length = 0; tam = 0; }
  }
  if (partes.length) blobs.push(new Blob([partes.join("\r\n") + "\r\n"]));
  const cab = ["Matrícula", "Nome", "Superintendência", "Cidade", "Subcategoria", ...ex.cabFat, ...rotulos.map((m) => `Arrecadado ${m}`), "Total pago nos meses", `Indicativo ${rotRef}`, `Arrecadado ${rotRef}`, ...ex.cabRec].join(";");
  const ordena = (m) => [...m.values()].sort((a, b) => b.vals.reduce((s, v) => s + v, 0) - a.vals.reduce((s, v) => s + v, 0));
  return { n: lista.length, nNao: lista.filter((x) => !x.pagouRef).length, porCidade: ordena(porCidade), porSub: ordena(porSub), top, ...ex.info(),
    blob: new Blob(["\ufeff" + cab + "\r\n", ...blobs], { type: "text/csv;charset=utf-8" }) };
}
// Colunas extras das bases de oportunidades e comparativo, para cada matrícula:
//  fat: Endereço da ligação, Grupo, Rota (e Situação da ligação, só quando a base de contas a receber não entra)
//  rec: Saldo total vencido (sem o a vencer) e SIT_LIG, no fim do arquivo. SIT_LIG é uma coluna só: a da base de contas a
//       receber; sem a matrícula nela, a do faturamento escrita no mesmo padrão.
async function colunasExtras(comFat, comRec, recTipo) {
  const receber = recBase(recTipo), rec = !!(comRec && receber), todo = comFat || rec ? await leCadastroFat() : null, cad = comFat ? todo : null;
  const cabFat = cad ? ["Endereço da ligação", "Grupo", "Rota", ...(rec ? [] : ["Situação da ligação"])] : [];
  const cabRec = rec ? ["Saldo total vencido", "SIT_LIG"] : [];
  let nCad = 0, nRec = 0;
  const de = (l) => {
    const f = todo ? todo.mapa.get(l) : null;
    if (cad && f) nCad++;
    const fat = cad ? (f ? f.slice(0, cabFat.length) : cabFat.map(() => "")) : [];
    let r = [];
    if (rec) {
      const x = receber.get(l), c = C.colunasReceber(x, f ? f[3] : "");
      if (x) nRec++;
      r = [c.saldo == null ? "" : nBR(c.saldo), c.sit];
    }
    return { fat, rec: r };
  };
  return { cabFat, cabRec, de, info: () => ({ cadastro: cad && { ref: cad.ref, arquivos: cad.arquivos, comCadastro: nCad }, comReceber: rec ? nRec : null }) };
}
const nBR = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(".", ",");
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
