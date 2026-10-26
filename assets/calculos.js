// Cálculos do painel de arrecadação: calendário de dias úteis, agregação das linhas dos arquivos e as tabelas de cada aba.
// Roda no navegador (worker e página) e no Node (testes). Não depende de nada além de regras.js.
(function (raiz, fabrica) {
  const noNode = typeof module === "object" && module.exports;
  const calc = fabrica(noNode ? require("./regras.js") : raiz.REGRAS);
  if (noNode) module.exports = calc;
  else raiz.CALC = calc;
})(typeof self !== "undefined" ? self : this, function (R) {
  const MAX_DIA = 23;                                   // maior nº de dias úteis num mês
  const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const DIAS_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

  // ---------- texto, números e datas ----------
  function chave(t) {
    return String(t == null ? "" : t).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  function numeroBR(t) {                                // "1.398,69" → 1398.69; "-50,66" → -50.66
    if (typeof t === "number") return t;
    let s = String(t == null ? "" : t).trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
    if (!s) return NaN;
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    return Number(s);
  }
  function dataISO(t) {                                 // "02/10/2026 02:09" ou "2026-10-02" → "2026-10-02"; inválida → ""
    if (t instanceof Date) return isNaN(t) ? "" : new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    let s = String(t == null ? "" : t).trim();
    if (s.charCodeAt(0) === 34) s = s.replace(/^"|"$/g, "").trim();     // "10/10/2026" entre aspas
    let m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/.exec(s);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(s);       // ano/mês/dia: 2026-10-02, 2026/03/01 (faturamento)
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})(?!\d)/.exec(s);           // ano com 2 dígitos: 10/10/26
    return m ? `20${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
  }
  // Linha de CSV com ";" — campos entre aspas (com ";" ou aspas dobradas dentro) também
  function separaCsv(linha) {
    if (linha.indexOf('"') < 0) return linha.split(";");
    const out = [];
    let campo = "", aspas = false;
    for (let i = 0; i < linha.length; i++) {
      const ch = linha[i];
      if (aspas) {
        if (ch === '"') { if (linha[i + 1] === '"') { campo += '"'; i++; } else aspas = false; }
        else campo += ch;
      } else if (ch === '"') aspas = true;
      else if (ch === ";") { out.push(campo); campo = ""; }
      else campo += ch;
    }
    out.push(campo);
    return out;
  }
  function ligacao(t) {                                 // "0100000001" e 100000001 viram a mesma chave
    const s = String(t == null ? "" : t).trim();
    return /^\d+(\.0+)?$/.test(s) ? String(parseInt(s, 10)) : s;
  }
  // "set/26", "setembro/2026", "09/2026", "01/09/2026" ou Date → "2026-09" ("" se não reconhecer)
  function refDeTexto(v) {
    if (v instanceof Date) return dataISO(v).slice(0, 7);
    const s = String(v == null ? "" : v).trim();
    const iso = dataISO(s);
    if (iso) return iso.slice(0, 7);
    let m = /^(\d{4})-(\d{2})$/.exec(s);                    // já no formato "AAAA-MM"
    if (m && +m[2] >= 1 && +m[2] <= 12) return s;
    m = /^(\d{1,2})\/(\d{4})$/.exec(s);
    if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${m[1].padStart(2, "0")}`;
    m = /^([A-Za-zçÇ]{3})[A-Za-zçÇ]*[\/\-\s.]*(\d{2}|\d{4})$/.exec(s);
    if (m) {
      const i = MESES_CURTOS.indexOf(chave(m[1]).toLowerCase().slice(0, 3));
      if (i >= 0) return `${m[2].length === 2 ? "20" + m[2] : m[2]}-${String(i + 1).padStart(2, "0")}`;
    }
    return "";
  }
  const vencNum = (iso) => (iso ? +iso.replace(/-/g, "") : 0);   // "2026-10-10" → 20261010
  // Texto com acento quebrado (UTF-8 lido como Windows-1252, ex.: "CORREÃ‡ÃƒO") → "CORREÇÃO"
  function consertaAcento(t) {
    const s = String(t == null ? "" : t);
    if (!/[ÃÂ]/.test(s)) return s;
    try {
      const bytes = Uint8Array.from(s, (ch) => { const c = ch.charCodeAt(0); return c < 256 ? c : (CP1252_INV[c] || 63); });
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) { return s; }
  }
  const CP1252_INV = { 0x20ac: 0x80, 0x201a: 0x82, 0x192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2c6: 0x88, 0x2030: 0x89,
    0x160: 0x8a, 0x2039: 0x8b, 0x152: 0x8c, 0x17d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96,
    0x2014: 0x97, 0x2dc: 0x98, 0x2122: 0x99, 0x161: 0x9a, 0x203a: 0x9b, 0x153: 0x9c, 0x17e: 0x9e, 0x178: 0x9f };
  function rotuloMes(mes) {                             // "2026-10" → "out/2026"
    if (!mes) return "(sem data)";
    return `${MESES_CURTOS[+mes.slice(5, 7) - 1]}/${mes.slice(0, 4)}`;
  }
  function mesAnterior(mes, n = 1) {                    // n negativo: meses depois
    let a = +mes.slice(0, 4), m = +mes.slice(5, 7) - n;
    while (m < 1) { m += 12; a--; }
    while (m > 12) { m -= 12; a++; }
    return `${a}-${String(m).padStart(2, "0")}`;
  }

  // Linha do orçado que é a arrecadação: "ARRECADAÇÃO CRÉDITO", "(+) Arrecadação", "05.01. Arrecadação"
  function ehLinhaArrecadacao(rubrica) {
    const k = chave(String(rubrica == null ? "" : rubrica).replace(/^\s*[\d.]+\s*/, "").replace(/^\s*\([+\-=]\)\s*/, ""));
    return k === "ARRECADACAO" || k === "ARRECADACAOCREDITO";
  }
  // Nome da planilha de orçado → ordem (RF3T25 < RF01T26 < RF02T26): ano e nº da revisão
  function ordemOrcado(nome) {
    const m = /RF\s*0*(\d+)\s*T\s*(\d{2})/i.exec(nome || "");
    return m ? (2000 + +m[2]) * 100 + +m[1] : 0;
  }

  // ---------- calendário: ordem do dia útil (0 = fim de semana ou feriado) ----------
  const cacheCal = {};
  function calendario(mes) {
    if (cacheCal[mes]) return cacheCal[mes];
    const a = +mes.slice(0, 4), m = +mes.slice(5, 7), fer = R.feriados(a);
    const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
    const dias = [], ordem = {}, dataDoDia = [null];
    let n = 0;
    for (let d = 1; d <= ultimo; d++) {
      const data = `${mes}-${String(d).padStart(2, "0")}`, sem = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
      const util = sem >= 1 && sem <= 5 && !fer.has(data);
      const o = util ? ++n : 0;
      dias.push({ data, dia: d, semana: sem, ordem: o, feriado: fer.has(data) });
      ordem[data] = o;
      if (o) dataDoDia[o] = data;
    }
    return (cacheCal[mes] = { mes, dias, ordem, uteis: n, naoUteis: ultimo - n, dataDoDia });
  }
  function rotuloDia(data) {                            // "2026-10-05" → "5, seg"
    const d = new Date(data + "T12:00:00Z");
    return `${d.getUTCDate()}, ${DIAS_SEMANA[d.getUTCDay()]}`;
  }

  // ---------- classificação de zona, subcategoria ----------
  const ZONAS_POR_CHAVE = {}, SUB_POR_CHAVE = {};
  for (const [z, v] of Object.entries(R.ZONAS)) { ZONAS_POR_CHAVE[chave(z)] = v; ZONAS_POR_CHAVE[chave(v[0])] = v; }
  for (const [u, v] of Object.entries(R.SUBCATEGORIAS)) SUB_POR_CHAVE[chave(u)] = v;
  function zonaInfo(zona) {                             // → [cidade, SUP]
    const v = R.ZONAS[zona] || ZONAS_POR_CHAVE[chave(zona)] || ZONAS_POR_CHAVE[chave(String(zona).replace(/^\s*\d+\s*-\s*/, ""))];
    if (v) return v;
    const cidade = String(zona || "").replace(/^\s*\d+\s*-\s*/, "").trim() || "(sem zona)";
    return [cidade, R.SEM_SUP];
  }
  function subInfo(util) {                              // → [Subcategoria, detalhe]
    return R.SUBCATEGORIAS[util] || SUB_POR_CHAVE[chave(util)] || [R.SEM_CLASSIFICACAO, util ? String(util).trim() : R.SEM_CLASSIFICACAO];
  }

  // ---------- agregação das linhas dos arquivos ----------
  // Pensado para pastas de vários GB: nada guarda texto por linha. A ligação vira número; cada combinação
  // (zona, subcategoria, perfil) vira um índice; as chaves são números e o que um arquivo exporta são listas tipadas.
  //  - V: somas por mês × dia útil × combinação × mês de vencimento (valor, contas, linhas)
  //  - L: por mês, os dias úteis em que cada ligação pagou (máscara de bits), para contar clientes distintos
  const SEP = "\u0001";
  // COMBOS_ARQ: combinações num arquivo; DIAS_L: posições de dia útil (0..23) na chave ligação × combinação × dia
  const MAX_COMBOS = 65536, MAX_VENC = 1024, LIG_HASH = 1e10, COMBOS_ARQ = 16384, DIAS_L = 24, VALOR_COM_NOME = 200;
  function chaveLig(t) {                                 // ligação → número (as que não são números: hash, acima de 1e10)
    if (typeof t === "number" && Number.isInteger(t) && t >= 0 && t < LIG_HASH) return t;
    const s = String(t == null ? "" : t).trim();
    if (/^\d{1,11}(\.0+)?$/.test(s)) { const n = parseInt(s, 10); if (n < LIG_HASH) return n; }
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return LIG_HASH + h;
  }
  function vencIdx(mes) {                                // "AAAA-MM" → 1..1023 (0 = sem vencimento ou fora da faixa)
    if (!mes) return 0;
    const i = (+mes.slice(0, 4) - 1990) * 12 + +mes.slice(5, 7);
    return i > 0 && i < MAX_VENC ? i : 0;
  }
  function mesDoVenc(i) {
    if (!i) return "";
    return `${1990 + Math.floor((i - 1) / 12)}-${String(((i - 1) % 12) + 1).padStart(2, "0")}`;
  }

  class LeituraArquivo {
    constructor(perfis) {
      this.perfis = perfis || null;                    // Map "ligação|contrato" → perfil (CLUSTER SALDO)
      this.idxCk = new Map();
      this.cks = [];
      this.meses = new Map();
      this.descartadas = { semCredito: 0, semValor: 0 };
      this.ultimaAtualizacao = "";
      this.nomes = new Map();                          // ligação → nome do cliente (só de quem tem pagamento ≥ R$ 200: aba Análise)
      this.supDaZona = new Map();
    }
    // r: { lig, contrato, vencimento, credito, valor, util, zona, tipo, atualizacao, cliente } — texto como vem do arquivo
    adiciona(r) {
      const credito = dataISO(r.credito);
      if (!credito) { this.descartadas.semCredito++; return; }
      const valor = numeroBR(r.valor);
      if (!isFinite(valor)) { this.descartadas.semValor++; return; }
      const mes = credito.slice(0, 7), ordem = calendario(mes).ordem[credito];
      let M = this.meses.get(mes);
      if (!M) { M = { V: new Map(), L: new Map(), P: new Map(), ultimoCredito: "", linhas: 0 }; this.meses.set(mes, M); }
      M.linhas++;
      if (credito > M.ultimoCredito) M.ultimoCredito = credito;
      const perfil = this.perfis ? (this.perfis.get(ligacao(r.lig) + "|" + ligacao(r.contrato)) || R.SEM_PERFIL) : R.SEM_PERFIL;
      const ck = String(r.zona || "").trim() + SEP + String(r.util || "").trim() + SEP + perfil;
      let c = this.idxCk.get(ck);
      if (c === undefined) {
        c = this.cks.length;
        if (c >= COMBOS_ARQ) throw new Error("combinações de zona × subcategoria × perfil demais num arquivo");
        this.cks.push(ck); this.idxCk.set(ck, c);
      }
      const kv = (ordem * MAX_COMBOS + c) * MAX_VENC + vencIdx(dataISO(r.vencimento).slice(0, 7));
      let a = M.V.get(kv);
      if (!a) { a = [0, 0, 0]; M.V.set(kv, a); }
      a[0] += valor;
      if (R.TIPOS_CONTA.includes(String(r.tipo || "").trim())) a[1]++;
      a[2]++;
      // valor de cada ligação × combinação × dia útil (dá os dias em que pagou e os rankings da aba Análise)
      const lig = chaveLig(r.lig), kl = (lig * COMBOS_ARQ + c) * DIAS_L + ordem;
      M.L.set(kl, (M.L.get(kl) || 0) + valor);
      if (valor >= VALOR_COM_NOME && r.cliente && !this.nomes.has(lig)) this.nomes.set(lig, String(r.cliente).trim().split("").join(""));   // split/join: cópia solta da linha
      // pagamentos do Interior (onde há faturamento) por ligação + vencimento + tipo: base do cruzamento com a fatura
      const zona = String(r.zona || "").trim();
      let sup = this.supDaZona.get(zona);
      if (sup === undefined) { sup = zonaInfo(zona)[1]; this.supDaZona.set(zona, sup); }
      if (sup === "INTERIOR") {
        const t = String(r.tipo || "").trim(), tipo = t.startsWith("1-") ? 1 : t.startsWith("2-") ? 2 : t.startsWith("3-") ? 3 : 0;
        const kp = lig + "|" + vencNum(dataISO(r.vencimento)) + "|" + tipo;
        M.P.set(kp, (M.P.get(kp) || 0) + valor);
      }
      if (r.atualizacao) {
        const at = String(r.atualizacao).trim(), comp = dataISO(at) + at.slice(10);
        if (comp > this.ultimaAtualizacao) this.ultimaAtualizacao = comp;
      }
    }
    exporta() {
      const meses = {};
      for (const [mes, M] of this.meses) {
        const n = M.V.size, V = { k: new Float64Array(n), valor: new Float64Array(n), contas: new Uint32Array(n), linhas: new Uint32Array(n) };
        let i = 0;
        for (const [k, a] of M.V) { V.k[i] = k; V.valor[i] = a[0]; V.contas[i] = a[1]; V.linhas[i] = a[2]; i++; }
        const L = { k: new Float64Array(M.L.size), d: new Uint8Array(M.L.size), v: new Float32Array(M.L.size) };
        i = 0;
        for (const [k, v] of M.L) { const d = k % DIAS_L; L.k[i] = (k - d) / DIAS_L; L.d[i] = d; L.v[i] = v; i++; }
        const P = { lig: new Float64Array(M.P.size), venc: new Int32Array(M.P.size), tipo: new Uint8Array(M.P.size), v: new Float64Array(M.P.size) };
        i = 0;
        for (const [k, v] of M.P) { const [l, vc, t] = k.split("|"); P.lig[i] = +l; P.venc[i] = +vc; P.tipo[i] = +t; P.v[i] = v; i++; }
        meses[mes] = { V, L, P, ultimoCredito: M.ultimoCredito, linhas: M.linhas };
      }
      return { combos: this.cks.slice(), meses, descartadas: this.descartadas, ultimaAtualizacao: this.ultimaAtualizacao,
        // nomes em forma compacta: as ligações numa lista de números e os nomes num texto só
        nomes: { lig: Float64Array.from(this.nomes.keys()), txt: [...this.nomes.values()].join(SEP) } };
    }
  }

  // Junta o que os arquivos exportaram e monta as tabelas compactas que a página usa (colunas tipadas).
  class Agregador {
    constructor(opcoes = {}) {
      this.perfis = opcoes.perfis || null;
      this.combos = [];
      this.idxCombo = new Map();
      this.meses = new Map();
      this.descartadas = { semCredito: 0, semValor: 0 };
      this.zonasSemSup = new Map();
      this.subSemClasse = new Map();
      this.linhas = 0;
      this.ultimaAtualizacao = "";
      this.parcial = null;
      this.nomes = new Map();
    }
    combo(ck) {
      let i = this.idxCombo.get(ck);
      if (i !== undefined) return i;
      const [zona, util, perfil] = ck.split(SEP);
      const [cidade, sup] = zonaInfo(zona), [grupo, detalhe] = subInfo(util);
      if (sup === R.SEM_SUP) this.zonasSemSup.set(zona, 1);
      if (grupo === R.SEM_CLASSIFICACAO) this.subSemClasse.set(util, 1);
      i = this.combos.length;
      if (i >= MAX_COMBOS) throw new Error("combinações de zona × subcategoria × perfil demais");
      this.combos.push({ zona, cidade, sup, util, grupo, detalhe, perfil });
      this.idxCombo.set(ck, i);
      return i;
    }
    // aceitaMes(mes) = false pula o mês (ex.: mês que vem do arquivo diário). Devolve { linhas usadas, puladas, meses }.
    // As listas L não são copiadas aqui: ficam referenciadas e só são juntadas no resultado, um mês por vez.
    junta(exp, aceitaMes) {
      let usadas = 0, puladas = 0;
      const meses = [], mapa = Int32Array.from(exp.combos, (ck) => this.combo(ck));
      for (const [mes, X] of Object.entries(exp.meses)) {
        if (aceitaMes && !aceitaMes(mes)) { puladas += X.linhas; continue; }
        meses.push(mes);
        usadas += X.linhas;
        let M = this.meses.get(mes);
        if (!M) { M = { V: new Map(), partes: [], pags: [], ultimoCredito: "" }; this.meses.set(mes, M); }
        if (X.ultimoCredito > M.ultimoCredito) M.ultimoCredito = X.ultimoCredito;
        const V = X.V;
        for (let i = 0; i < V.k.length; i++) {
          const k = V.k[i], vi = k % MAX_VENC, t = (k - vi) / MAX_VENC, c = t % MAX_COMBOS, ordem = (t - c) / MAX_COMBOS;
          const nk = (ordem * MAX_COMBOS + mapa[c]) * MAX_VENC + vi;
          const a = M.V.get(nk);
          if (a) { a[0] += V.valor[i]; a[1] += V.contas[i]; a[2] += V.linhas[i]; } else M.V.set(nk, [V.valor[i], V.contas[i], V.linhas[i]]);
        }
        M.partes.push({ L: X.L, mapa });
        if (X.P) M.pags.push(X.P);
      }
      this.linhas += usadas;
      this.descartadas.semCredito += exp.descartadas.semCredito;
      this.descartadas.semValor += exp.descartadas.semValor;
      if (exp.ultimaAtualizacao > this.ultimaAtualizacao) this.ultimaAtualizacao = exp.ultimaAtualizacao;
      if (exp.nomes && exp.nomes.lig.length) {
        const txt = exp.nomes.txt.split(SEP);
        exp.nomes.lig.forEach((lig, i) => { if (!this.nomes.has(lig)) this.nomes.set(lig, txt[i]); });
      }
      return { linhas: usadas, puladas, meses: meses.sort() };
    }
    adiciona(r) {                                      // atalho (testes): linha a linha, como um arquivo só
      if (!this.parcial) this.parcial = new LeituraArquivo(this.perfis);
      this.parcial.adiciona(r);
    }
    // descontos: Map mês → Map ligação → valor do desconto (positivo). O desconto de cada ligação entra no mês da
    // REFERENCIA e só para ligações que pagaram no mês (como no BI), na combinação e no 1º dia útil em que pagou.
    resultado(descontos) {
      if (this.parcial) { this.junta(this.parcial.exporta()); this.parcial = null; }
      const meses = [...this.meses.keys()].sort();
      const VD = colunas(["mi", "d", "c", "valor", "contas"]), VE = colunas(["mi", "d", "c", "v", "valor"]);
      const CF = colunas(["mi", "ini", "len", "n", "desc"]), SE = colunas(["c", "m"]);
      const descontoSemPagamento = {}, ultimoCredito = {}, entradas = [], descPorLig = [], pagamentos = [];
      meses.forEach((mes, mi) => {
        const M = this.meses.get(mes);
        ultimoCredito[mes] = M.ultimoCredito;
        const semVenc = new Map();
        for (const [k, a] of M.V) {
          const vi = k % MAX_VENC, t = (k - vi) / MAX_VENC, c = t % MAX_COMBOS, d = (t - c) / MAX_COMBOS;
          VE.add(mi, d, c, vi, a[0]);
          const s = semVenc.get(t);
          if (s) { s[0] += a[0]; s[1] += a[1]; } else semVenc.set(t, [a[0], a[1]]);
        }
        for (const [t, a] of semVenc) { const c = t % MAX_COMBOS; VD.add(mi, (t - c) / MAX_COMBOS, c, a[0], a[1]); }
        M.V = null;
        // dias em que cada (ligação, combinação) pagou: junta as partes do mês (arquivos R1, R4…)
        const L = new Map();
        for (const { L: P, mapa } of M.partes) for (let i = 0; i < P.k.length; i++) {
          const cl = P.k[i] % COMBOS_ARQ, lig = (P.k[i] - cl) / COMBOS_ARQ, nk = lig * MAX_COMBOS + mapa[cl];
          L.set(nk, (L.get(nk) || 0) | (1 << P.d[i]));
        }
        entradas[mi] = M.partes;                       // aba Análise: as próprias listas dos arquivos (sem cópia)
        pagamentos[mi] = M.pags;                       // cruzamento com o faturamento (Interior, por ligação + vencimento)
        M.partes = null;
        const dm = new Map();
        if (descontos && descontos.get(mes)) for (const [lig, v] of descontos.get(mes)) { const k = chaveLig(lig); dm.set(k, (dm.get(k) || 0) + v); }
        const descMes = new Map(dm);
        // Cliente distinto é a LIGAÇÃO (como o DISTINCTCOUNT do BI), mesmo que ela apareça em mais de uma combinação
        // (ex.: contas com contratos de perfis diferentes). Cada ligação vira uma "assinatura": a lista de
        // (combinação, dias em que pagou). Ligações com a mesma assinatura são somadas numa linha.
        const chaves = Float64Array.from(L.keys()).sort();
        const sigs = new Map();                        // chave da assinatura → { ent: [[c, máscara]], n, desc }
        for (let a = 0; a < chaves.length;) {
          const lig = Math.floor(chaves[a] / MAX_COMBOS);
          let b = a;
          while (b < chaves.length && Math.floor(chaves[b] / MAX_COMBOS) === lig) b++;
          const ent = [];
          for (let x = a; x < b; x++) ent.push([chaves[x] - lig * MAX_COMBOS, L.get(chaves[x])]);
          if (ent.length > 1) ent.sort((e1, e2) => primeiroDia(e1[1]) - primeiroDia(e2[1]) || e1[0] - e2[0]);
          const k = ent.length === 1 ? ent[0][0] * DIAS_MASK + ent[0][1] : ent.map((e) => e[0] + ":" + e[1]).join(",");
          let sg = sigs.get(k);
          if (!sg) { sg = { ent, n: 0, desc: 0 }; sigs.set(k, sg); }
          sg.n++;
          const d = dm.get(lig);
          if (d) { sg.desc += d; dm.delete(lig); }
          a = b;
        }
        descPorLig[mi] = descMes;
        let semPag = 0;
        for (const v of dm.values()) semPag += v;
        if (semPag) descontoSemPagamento[mes] = semPag;
        for (const sg of sigs.values()) {
          CF.add(mi, SE.tam(), sg.ent.length, sg.n, sg.desc);
          for (const [c, m] of sg.ent) SE.add(c, m);
        }
      });
      this.meses = new Map();
      return {
        meses, combos: this.combos, VD: VD.fim(TIPOS_VD), VE: VE.fim(TIPOS_VE), CF: CF.fim(TIPOS_CF), SE: SE.fim(TIPOS_SE),
        descontoSemPagamento, ultimoCredito,
        linhas: this.linhas, descartadas: this.descartadas, ultimaAtualizacao: this.ultimaAtualizacao,
        zonasSemSup: [...this.zonasSemSup.keys()], subSemClasse: [...this.subSemClasse.keys()],
        // fica no worker (não vai para a página): base dos rankings por ligação da aba Análise
        analise: { entradas, descontos: descPorLig, nomes: this.nomes, pagamentos },
      };
    }
  }
  const TIPOS_VD = { mi: Uint8Array, d: Uint8Array, c: Uint16Array, valor: Float64Array, contas: Float64Array };
  const TIPOS_VE = { mi: Uint8Array, d: Uint8Array, c: Uint16Array, v: Uint16Array, valor: Float64Array };
  // CF: por mês × assinatura (SE[ini .. ini+len-1] = combinações e dias em que a ligação pagou): nº de ligações e o desconto delas
  const TIPOS_CF = { mi: Uint8Array, ini: Uint32Array, len: Uint16Array, n: Uint32Array, desc: Float64Array };
  const TIPOS_SE = { c: Uint16Array, m: Uint32Array };
  const primeiroDia = (mask) => { for (let d = 1; d <= MAX_DIA; d++) if (mask & (1 << d)) return d; return 99; };
  const DIAS_MASK = 2 ** 24;
  function colunas(nomes) {                              // tabela por colunas: add(...valores) e fim(tipos) → { tam, coluna: TypedArray }
    const cols = nomes.map(() => []);
    return {
      add(...v) { for (let i = 0; i < cols.length; i++) cols[i].push(v[i]); },
      tam() { return cols[0].length; },
      fim(tipos) {
        const t = { tam: cols[0].length };
        nomes.forEach((nome, i) => { t[nome] = tipos[nome].from(cols[i]); cols[i] = null; });
        return t;
      },
    };
  }
  // buffers das tabelas, para o worker transferir sem copiar
  function buffers(dados) {
    const out = [];
    for (const t of [dados.VD, dados.VE, dados.CF, dados.SE]) for (const v of Object.values(t)) if (ArrayBuffer.isView(v)) out.push(v.buffer);
    return out;
  }

  // ---------- consultas (página) ----------
  // dados = resultado(); filtro = { sup, cidade, grupo } ("" = todos)
  function marcaCombos(dados, filtro = {}) {
    const f = new Uint8Array(dados.combos.length);
    dados.combos.forEach((c, i) => {
      f[i] = (!filtro.sup || c.sup === filtro.sup) && (!filtro.cidade || c.cidade === filtro.cidade)
        && (!filtro.grupo || c.grupo === filtro.grupo) ? 1 : 0;
    });
    return f;
  }
  // Seleção de dias úteis = máscara de bits (bit d = dia útil d; bit 0 = fins de semana e feriados do mês inteiro),
  // igual ao filtro de dias úteis do BI: só os dias marcados entram, em todos os meses comparados.
  const mascaraAte = (N, incl0 = false) => { let m = incl0 ? 1 : 0; for (let d = 1; d <= N; d++) m |= 1 << d; return m >>> 0; };
  const diasDaMascara = (sel) => { const out = []; for (let d = 0; d <= MAX_DIA; d++) if (sel & (1 << d)) out.push(d); return out; };
  const noCorte = (d, sel) => (sel & (1 << d)) !== 0;
  const flagsMeses = (dados, mesesIdx) => { const q = new Uint8Array(dados.meses.length + 1); mesesIdx.forEach((m) => { if (m >= 0) q[m] = 1; }); return q; };

  // Por dia útil (0..23) de um mês: valor (sem desconto), contas, clientes distintos no dia
  function serieDoMes(dados, mi, marcas) {
    const s = { valor: new Float64Array(MAX_DIA + 1), contas: new Float64Array(MAX_DIA + 1), clientes: new Float64Array(MAX_DIA + 1) };
    const V = dados.VD, F = dados.CF, S = dados.SE;
    for (let i = 0; i < V.tam; i++) if (V.mi[i] === mi && marcas[V.c[i]]) { s.valor[V.d[i]] += V.valor[i]; s.contas[V.d[i]] += V.contas[i]; }
    for (let i = 0; i < F.tam; i++) {
      if (F.mi[i] !== mi) continue;
      let u = 0;                                       // dias em que a ligação pagou em alguma combinação do filtro
      for (let e = F.ini[i]; e < F.ini[i] + F.len[i]; e++) if (marcas[S.c[e]]) u |= S.m[e];
      for (let d = 0; u && d <= MAX_DIA; d++) if (u & (1 << d)) s.clientes[d] += F.n[i];
    }
    return s;
  }

  // Tabela por grupo × mês até o dia útil N: Map rótulo → Map mi → {valor, desconto, contas, clientes}
  // `grupoDe(combo)` dá o rótulo da linha (ex.: c => c.cidade). O desconto entra no valor (Arrecadação = Val. Autenticado + desconto).
  function porGrupo(dados, mesesIdx, marcas, sel, grupoDe) {
    const quer = flagsMeses(dados, mesesIdx), linhas = new Map();
    const rotulos = dados.combos.map((c) => grupoDe(c));
    const cel = (rot, mi) => {
      let l = linhas.get(rot);
      if (!l) { l = new Map(); linhas.set(rot, l); }
      let c = l.get(mi);
      if (!c) { c = { valor: 0, desconto: 0, contas: 0, clientes: 0 }; l.set(mi, c); }
      return c;
    };
    const V = dados.VD, F = dados.CF, S = dados.SE;
    for (let i = 0; i < V.tam; i++) {
      if (!quer[V.mi[i]] || !marcas[V.c[i]] || !noCorte(V.d[i], sel)) continue;
      const c = cel(rotulos[V.c[i]], V.mi[i]);
      c.valor += V.valor[i]; c.contas += V.contas[i];
    }
    // a ligação conta uma vez em cada linha onde pagou nos dias marcados; o desconto vai para a 1ª delas
    const vistos = [];
    for (let i = 0; i < F.tam; i++) {
      if (!quer[F.mi[i]]) continue;
      vistos.length = 0;
      for (let e = F.ini[i]; e < F.ini[i] + F.len[i]; e++) {
        if (!marcas[S.c[e]] || !(S.m[e] & sel)) continue;
        const rot = rotulos[S.c[e]];
        if (vistos.includes(rot)) continue;
        const c = cel(rot, F.mi[i]);
        c.clientes += F.n[i];
        if (!vistos.length) { c.desconto -= F.desc[i]; c.valor -= F.desc[i]; }
        vistos.push(rot);
      }
    }
    return linhas;
  }
  function totalDoMes(dados, mi, marcas, sel) {
    const l = porGrupo(dados, [mi], marcas, sel, () => "T").get("T");
    return (l && l.get(mi)) || { valor: 0, desconto: 0, contas: 0, clientes: 0 };
  }
  // Desconto abatido em cada mês (todas as combinações, mês inteiro)
  function descontoPorMes(dados) {
    const out = new Float64Array(dados.meses.length), F = dados.CF;
    for (let i = 0; i < F.tam; i++) out[F.mi[i]] += F.desc[i];
    return out;
  }

  // Escada: mês de vencimento ("AAAA-MM"; "" = sem) × mês de crédito (valor sem desconto) + o desconto de cada mês à parte
  function escada(dados, mesesIdx, marcas, sel) {
    const quer = flagsMeses(dados, mesesIdx), linhas = new Map(), desconto = new Map();
    const E = dados.VE, F = dados.CF, S = dados.SE;
    for (let i = 0; i < E.tam; i++) {
      if (!quer[E.mi[i]] || !marcas[E.c[i]] || !noCorte(E.d[i], sel)) continue;
      const v = mesDoVenc(E.v[i]);
      let l = linhas.get(v);
      if (!l) { l = new Map(); linhas.set(v, l); }
      l.set(E.mi[i], (l.get(E.mi[i]) || 0) + E.valor[i]);
    }
    for (let i = 0; i < F.tam; i++) {
      if (!quer[F.mi[i]] || !F.desc[i]) continue;
      let pagou = false;
      for (let e = F.ini[i]; e < F.ini[i] + F.len[i] && !pagou; e++) pagou = marcas[S.c[e]] && (S.m[e] & sel) !== 0;
      if (pagou) desconto.set(F.mi[i], (desconto.get(F.mi[i]) || 0) - F.desc[i]);
    }
    return { linhas, desconto };
  }

  // ---------- faturamento (Fatura de ciclo) ----------
  // Uma linha por rubrica de cada conta. A conta é a matrícula + Data de Vencimento (o arquivo não tem nº da conta);
  // o valor da conta é a soma de TODAS as rubricas, inclusive as negativas (créditos/abatimentos). Contas "Em Análise" saem.
  class LeituraFaturamento {
    constructor() {
      this.contas = new Map();                         // "ligação|vencimento" → [valor, créditos, ref, combo, rubricas]
      this.idxCk = new Map();
      this.cks = [];
      this.linhas = 0;
      this.fora = { linhas: 0, valor: 0, contas: new Set() };
      this.semChave = 0;
      this.rejeitadas = { lig: 0, venc: 0, ref: 0, valor: 0, exemplo: "" };   // por que as linhas foram descartadas
      this.nomes = new Map();
    }
    // r: { lig, venc, ref, valor, cidade, categoria, situacao, cliente } — texto como vem do arquivo
    adiciona(r) {
      const valor = numeroBR(r.valor), venc = vencNum(dataISO(r.venc)), ref = refDeTexto(r.ref);
      if (!r.lig || !venc || !ref || !isFinite(valor)) {
        this.semChave++;
        const rj = this.rejeitadas;
        if (!r.lig) rj.lig++; if (!venc) rj.venc++; if (!ref) rj.ref++; if (!isFinite(valor)) rj.valor++;
        if (!rj.exemplo) rj.exemplo = `matrícula "${r.lig}", vencimento "${r.venc}", referência "${r.ref}", valor "${r.valor}"`;
        return;
      }
      const lig = chaveLig(r.lig), k = lig + "|" + venc;
      if (R.SITUACOES_FORA_DO_FATURAMENTO.includes(chave(r.situacao))) {
        this.fora.linhas++; this.fora.valor += valor; this.fora.contas.add(k);
        return;
      }
      this.linhas++;
      let cat = chave(r.categoria);
      cat = R.CATEGORIAS_FATURAMENTO[cat] || String(r.categoria || "").trim().toUpperCase() || R.SEM_CLASSIFICACAO;
      const ck = String(r.cidade || "").trim().toUpperCase() + SEP + cat;
      let c = this.idxCk.get(ck);
      if (c === undefined) { c = this.cks.length; this.cks.push(ck); this.idxCk.set(ck, c); }
      let a = this.contas.get(k);
      if (!a) { a = [0, 0, +ref.replace("-", ""), c, 0]; this.contas.set(k, a); }
      a[0] += valor;
      if (valor < 0) a[1] += valor;
      a[4]++;
      if (r.cliente && !this.nomes.has(lig)) this.nomes.set(lig, consertaAcento(String(r.cliente).trim()).split("").join(""));
    }
    exporta() {
      const n = this.contas.size;
      const C_ = { lig: new Float64Array(n), venc: new Int32Array(n), ref: new Int32Array(n), c: new Uint16Array(n), valor: new Float64Array(n), credito: new Float64Array(n) };
      let i = 0;
      for (const [k, a] of this.contas) {
        const p = k.indexOf("|");
        C_.lig[i] = +k.slice(0, p); C_.venc[i] = +k.slice(p + 1); C_.valor[i] = a[0]; C_.credito[i] = a[1]; C_.ref[i] = a[2]; C_.c[i] = a[3]; i++;
      }
      const refs = [...new Set(C_.ref)].sort().map((x) => `${String(x).slice(0, 4)}-${String(x).slice(4)}`);
      return { contas: C_, combos: this.cks.slice(), linhas: this.linhas, semChave: this.semChave, rejeitadas: this.rejeitadas, refs,
        fora: { linhas: this.fora.linhas, valor: this.fora.valor, contas: this.fora.contas.size },
        nomes: { lig: Float64Array.from(this.nomes.keys()), txt: [...this.nomes.values()].join(SEP) } };
    }
  }

  // Cruzamento faturamento × arrecadação (Interior). Junta as contas de todos os arquivos de fatura (conta repetida em dois
  // arquivos conta uma vez) e liga cada pagamento à conta de mesma matrícula + vencimento. Devolve só somas pequenas:
  //  fat:     por referência × cidade × categoria: valor faturado, créditos, contas, matrículas
  //  coorte:  por referência da conta × mês de crédito × cidade × categoria: valor pago e contas pagas pela 1ª vez
  //  concil:  por mês de crédito × tipo de fatura: valor arrecadado que achou (ou não) a conta pelo vencimento
  function cruzaFaturamento(exportsFat, pagamentos, mesesArrec) {
    const combos = [], idxCombo = new Map(), comboDe = (ck) => {
      let i = idxCombo.get(ck);
      if (i === undefined) { i = combos.length; const [cidade, grupo] = ck.split(SEP); combos.push({ cidade, grupo, sup: zonaInfo(cidade)[1] }); idxCombo.set(ck, i); }
      return i;
    };
    const conta = new Map();                           // "ligação|vencimento" → posição
    const lig = [], venc = [], ref = [], cmb = [], valor = [], credito = [];
    let duplicadas = 0, linhas = 0, semChave = 0;
    const fora = { linhas: 0, valor: 0, contas: 0 };
    for (const e of exportsFat) {
      linhas += e.linhas; semChave += e.semChave; fora.linhas += e.fora.linhas; fora.valor += e.fora.valor; fora.contas += e.fora.contas;
      const mapa = e.combos.map(comboDe), C_ = e.contas;
      for (let i = 0; i < C_.lig.length; i++) {
        const k = C_.lig[i] + "|" + C_.venc[i];
        if (conta.has(k)) { duplicadas++; continue; }
        conta.set(k, lig.length);
        lig.push(C_.lig[i]); venc.push(C_.venc[i]); ref.push(C_.ref[i]); cmb.push(mapa[C_.c[i]]); valor.push(C_.valor[i]); credito.push(C_.credito[i]);
      }
    }
    const refTxt = (x) => `${String(x).slice(0, 4)}-${String(x).slice(4)}`;
    const fat = new Map(), ligsRef = new Map();
    for (let p = 0; p < lig.length; p++) {
      const k = ref[p] + "|" + cmb[p];
      let f = fat.get(k);
      if (!f) { f = { ref: refTxt(ref[p]), c: cmb[p], valor: 0, credito: 0, contas: 0, matriculas: 0 }; fat.set(k, f); ligsRef.set(k, new Set()); }
      f.valor += valor[p]; f.credito += credito[p]; f.contas++;
      ligsRef.get(k).add(lig[p]);
    }
    for (const [k, f] of fat) f.matriculas = ligsRef.get(k).size;
    // pagamentos, em ordem de mês de crédito: a conta fica "paga" no 1º mês em que recebe pagamento
    const pagaEm = new Int32Array(lig.length).fill(-1), coorte = new Map(), concil = [];
    (pagamentos || []).forEach((partes, mi) => {
      const cc = { mes: mesesArrec[mi], achou: [0, 0, 0, 0], semConta: [0, 0, 0, 0], linhasAchou: 0, linhasSem: 0 };
      for (const P of partes || []) for (let i = 0; i < P.lig.length; i++) {
        const p = conta.get(P.lig[i] + "|" + P.venc[i]);
        if (p === undefined) { cc.semConta[P.tipo[i]] += P.v[i]; cc.linhasSem++; continue; }
        cc.achou[P.tipo[i]] += P.v[i]; cc.linhasAchou++;
        const k = ref[p] + "|" + mi + "|" + cmb[p];
        let o = coorte.get(k);
        if (!o) { o = { ref: refTxt(ref[p]), mes: mesesArrec[mi], c: cmb[p], valor: 0, contas: 0 }; coorte.set(k, o); }
        o.valor += P.v[i];
        if (pagaEm[p] < 0) { pagaEm[p] = mi; o.contas++; }
      }
      concil.push(cc);
    });
    return { combos, fat: [...fat.values()], coorte: [...coorte.values()], concil,
      diag: { contas: lig.length, duplicadas, linhas, semChave, fora } };
  }

  // ---------- aba Análise: rankings por ligação ----------
  // Valor de cada ligação nos dias marcados e nas combinações do filtro, menos o desconto dela (como nas abas), no mês
  // e no mês anterior. Cidade/subcategoria/perfil mostrados: os do maior pagamento da ligação no mês (ou no anterior).
  // Para pastas grandes: um Map ligação → posição e listas de números; das listas só saem os n maiores (sem ordenar tudo).
  function rankings(an, mi, miAnt, marcas, sel, n = 100) {
    const pos = new Map(), lig = [], val = [[], []], pagou = [[], []], comb = [[], []], maior = [[], []];
    [mi, miAnt].forEach((m, t) => {
      const partes = m >= 0 ? an.entradas[m] : null;
      if (!partes) return;
      for (const { L, mapa } of partes) for (let i = 0; i < L.k.length; i++) {
        if (!(sel & (1 << L.d[i]))) continue;
        const cl = L.k[i] % COMBOS_ARQ, c = mapa[cl];
        if (!marcas[c]) continue;
        const l = (L.k[i] - cl) / COMBOS_ARQ;
        let p = pos.get(l);
        if (p === undefined) {
          p = lig.length; pos.set(l, p); lig.push(l);
          for (let u = 0; u < 2; u++) { val[u].push(0); pagou[u].push(0); comb[u].push(0); maior[u].push(-Infinity); }
        }
        val[t][p] += L.v[i]; pagou[t][p] = 1;
        if (L.v[i] > maior[t][p]) { maior[t][p] = L.v[i]; comb[t][p] = c; }
      }
      const dm = an.descontos[m];
      if (dm) for (const [l, d] of dm) { const p = pos.get(l); if (p !== undefined && pagou[t][p]) val[t][p] -= d; }
    });
    const item = (p) => ({ lig: lig[p], c: pagou[0][p] ? comb[0][p] : comb[1][p], atual: val[0][p], anterior: val[1][p], dif: val[0][p] - val[1][p] });
    // os n de maior nota (nota > 0), em ordem decrescente
    const topo = (nota) => {
      const sel_ = [];
      let piso = 0;
      for (let p = 0; p < lig.length; p++) {
        const x = nota(p);
        if (!(x > 0) || (sel_.length >= n && x <= piso)) continue;
        sel_.push([x, p]);
        if (sel_.length > 2 * n) { sel_.sort((a, b) => b[0] - a[0]); sel_.length = n; piso = sel_[n - 1][0]; }
      }
      sel_.sort((a, b) => b[0] - a[0]);
      return sel_.slice(0, n).map(([, p]) => item(p));
    };
    let nAumentos = 0, nQuedas = 0;                    // quantas ligações tiveram aumento / queda (as listas param em n)
    for (let p = 0; p < lig.length; p++) { const x = val[0][p] - val[1][p]; if (x > 0) nAumentos++; else if (x < 0) nQuedas++; }
    return {
      maiores: topo((p) => (pagou[0][p] ? val[0][p] : 0)),
      aumentos: topo((p) => val[0][p] - val[1][p]),
      quedas: topo((p) => val[1][p] - val[0][p]),
      nAumentos, nQuedas,
    };
  }

  // ---------- orçado diário ----------
  // Participação de cada posição de dia útil (0 = fins de semana e feriados) no total arrecadado do mês (sem desconto)
  function participacoes(dados, mi, marcas) {
    const s = serieDoMes(dados, mi, marcas).valor;
    const total = s.reduce((a, b) => a + b, 0);
    return total > 0 ? Array.from(s, (v) => v / total) : null;
  }
  // Meses da média: janeiro até o mês anterior ao escolhido (em janeiro: os 12 meses anteriores), só os que têm dados
  // inicio ("AAAA-MM", opcional): 1º mês da média; sem ele, janeiro do ano do mês escolhido
  function mesesDaCurva(dados, mes, inicio) {
    const de = inicio && inicio < mes ? inicio : mes.slice(0, 4) + "-01";
    let lista = dados.meses.filter((m) => m < mes && m >= de);
    if (!lista.length) lista = dados.meses.filter((m) => m < mes && m >= mesAnterior(mes, 12));
    return lista;
  }
  function curvaMedia(dados, mes, marcas, inicio) {
    const meses = mesesDaCurva(dados, mes, inicio), soma = new Array(MAX_DIA + 1).fill(0);
    let n = 0;
    const usados = [];
    for (const m of meses) {
      const p = participacoes(dados, dados.meses.indexOf(m), marcas);
      if (!p) continue;
      p.forEach((v, i) => { soma[i] += v; });
      n++;
      usados.push(m);
    }
    return { media: n ? soma.map((v) => v / n) : null, meses: usados };
  }
  // Pesos do mês: posições 1..D da média; o que a média tem nos dias D+1..23 é dividido igualmente entre os D dias úteis;
  // o peso do 0 vai para os fins de semana e feriados. Soma 1.
  function distribuiCurva(media, mes) {
    const cal = calendario(mes), D = cal.uteis, w = new Array(MAX_DIA + 1).fill(0);
    if (!media || !D) return w;
    let sobra = 0;
    for (let k = D + 1; k <= MAX_DIA; k++) sobra += media[k] || 0;
    for (let k = 1; k <= D; k++) w[k] = (media[k] || 0) + sobra / D;
    w[0] = cal.naoUteis ? media[0] || 0 : 0;
    const t = w.reduce((a, b) => a + b, 0);
    return t > 0 ? w.map((v) => v / t) : w;
  }

  return {
    MAX_DIA, MESES_CURTOS, chave, separaCsv, refDeTexto, vencNum, consertaAcento, LeituraFaturamento, cruzaFaturamento, ehLinhaArrecadacao, ordemOrcado, numeroBR, dataISO, ligacao, rotuloMes, mesAnterior, calendario, rotuloDia,
    zonaInfo, subInfo, chaveLig, mascaraAte, diasDaMascara, vencIdx, mesDoVenc, LeituraArquivo, Agregador, buffers, marcaCombos, serieDoMes, porGrupo, totalDoMes,
    descontoPorMes, escada, rankings,
    participacoes, mesesDaCurva, curvaMedia, distribuiCurva,
  };
});
