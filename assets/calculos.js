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
    const s = String(t == null ? "" : t).trim();
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
  }
  function ligacao(t) {                                 // "0100000001" e 100000001 viram a mesma chave
    const s = String(t == null ? "" : t).trim();
    return /^\d+(\.0+)?$/.test(s) ? String(parseInt(s, 10)) : s;
  }
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
  const MAX_COMBOS = 65536, MAX_VENC = 1024, LIG_HASH = 1e11;
  function chaveLig(t) {                                 // ligação → número (as que não são números: hash, acima de 1e11)
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
    }
    // r: { lig, contrato, vencimento, credito, valor, util, zona, tipo, atualizacao } — texto como vem do arquivo
    adiciona(r) {
      const credito = dataISO(r.credito);
      if (!credito) { this.descartadas.semCredito++; return; }
      const valor = numeroBR(r.valor);
      if (!isFinite(valor)) { this.descartadas.semValor++; return; }
      const mes = credito.slice(0, 7), ordem = calendario(mes).ordem[credito];
      let M = this.meses.get(mes);
      if (!M) { M = { V: new Map(), L: new Map(), ultimoCredito: "", linhas: 0 }; this.meses.set(mes, M); }
      M.linhas++;
      if (credito > M.ultimoCredito) M.ultimoCredito = credito;
      const perfil = this.perfis ? (this.perfis.get(ligacao(r.lig) + "|" + ligacao(r.contrato)) || R.SEM_PERFIL) : R.SEM_PERFIL;
      const ck = String(r.zona || "").trim() + SEP + String(r.util || "").trim() + SEP + perfil;
      let c = this.idxCk.get(ck);
      if (c === undefined) {
        c = this.cks.length;
        if (c >= MAX_COMBOS) throw new Error("combinações de zona × subcategoria × perfil demais num arquivo");
        this.cks.push(ck); this.idxCk.set(ck, c);
      }
      const kv = (ordem * MAX_COMBOS + c) * MAX_VENC + vencIdx(dataISO(r.vencimento).slice(0, 7));
      let a = M.V.get(kv);
      if (!a) { a = [0, 0, 0]; M.V.set(kv, a); }
      a[0] += valor;
      if (R.TIPOS_CONTA.includes(String(r.tipo || "").trim())) a[1]++;
      a[2]++;
      const kl = chaveLig(r.lig) * MAX_COMBOS + c;
      M.L.set(kl, (M.L.get(kl) || 0) | (1 << ordem));
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
        const L = { k: new Float64Array(M.L.size), m: new Uint32Array(M.L.size) };
        i = 0;
        for (const [k, m] of M.L) { L.k[i] = k; L.m[i] = m; i++; }
        meses[mes] = { V, L, ultimoCredito: M.ultimoCredito, linhas: M.linhas };
      }
      return { combos: this.cks.slice(), meses, descartadas: this.descartadas, ultimaAtualizacao: this.ultimaAtualizacao };
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
        if (!M) { M = { V: new Map(), partes: [], ultimoCredito: "" }; this.meses.set(mes, M); }
        if (X.ultimoCredito > M.ultimoCredito) M.ultimoCredito = X.ultimoCredito;
        const V = X.V;
        for (let i = 0; i < V.k.length; i++) {
          const k = V.k[i], vi = k % MAX_VENC, t = (k - vi) / MAX_VENC, c = t % MAX_COMBOS, ordem = (t - c) / MAX_COMBOS;
          const nk = (ordem * MAX_COMBOS + mapa[c]) * MAX_VENC + vi;
          const a = M.V.get(nk);
          if (a) { a[0] += V.valor[i]; a[1] += V.contas[i]; a[2] += V.linhas[i]; } else M.V.set(nk, [V.valor[i], V.contas[i], V.linhas[i]]);
        }
        M.partes.push({ L: X.L, mapa });
      }
      this.linhas += usadas;
      this.descartadas.semCredito += exp.descartadas.semCredito;
      this.descartadas.semValor += exp.descartadas.semValor;
      if (exp.ultimaAtualizacao > this.ultimaAtualizacao) this.ultimaAtualizacao = exp.ultimaAtualizacao;
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
      const CD = colunas(["mi", "c", "d", "n"]), CF = colunas(["mi", "c", "m", "n", "desc"]);
      const descontoSemPagamento = {}, ultimoCredito = {};
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
        let L;
        if (M.partes.length === 1 && M.partes[0].mapa.every((g, i) => g === i)) L = null;
        else {
          L = new Map();
          for (const { L: P, mapa } of M.partes) for (let i = 0; i < P.k.length; i++) {
            const c = P.k[i] % MAX_COMBOS, nk = P.k[i] - c + mapa[c];
            L.set(nk, (L.get(nk) || 0) | P.m[i]);
          }
        }
        const cd = new Map(), cf = new Map(), dm = new Map(), escolha = new Map();
        if (descontos && descontos.get(mes)) for (const [lig, v] of descontos.get(mes)) { const k = chaveLig(lig); dm.set(k, (dm.get(k) || 0) + v); }
        const visita = (k, mask) => {
          const c = k % MAX_COMBOS, lig = (k - c) / MAX_COMBOS;
          let primeiro = 0;
          for (let d = 1; d <= MAX_DIA; d++) if (mask & (1 << d)) { primeiro = d; break; }
          for (let d = 0; d <= MAX_DIA; d++) if (mask & (1 << d)) { const kd = c * 32 + d; cd.set(kd, (cd.get(kd) || 0) + 1); }
          const kf = c * DIAS_MASK + mask, e = cf.get(kf);
          if (e) e[0]++; else cf.set(kf, [1, 0]);
          if (dm.has(lig)) {
            const ordemEscolha = primeiro || 99, atual = escolha.get(lig);
            if (!atual || ordemEscolha < atual[1]) escolha.set(lig, [kf, ordemEscolha]);
          }
        };
        if (L) for (const [k, mask] of L) visita(k, mask);
        else { const P = M.partes[0].L; for (let i = 0; i < P.k.length; i++) visita(P.k[i], P.m[i]); }
        M.partes = null;
        let semPag = 0;
        for (const [lig, v] of dm) { const x = escolha.get(lig); if (x) cf.get(x[0])[1] += v; else semPag += v; }
        if (semPag) descontoSemPagamento[mes] = semPag;
        for (const [kd, n] of cd) CD.add(mi, Math.floor(kd / 32), kd % 32, n);
        for (const [kf, e] of cf) CF.add(mi, Math.floor(kf / DIAS_MASK), kf % DIAS_MASK, e[0], e[1]);
      });
      this.meses = new Map();
      return {
        meses, combos: this.combos, VD: VD.fim(TIPOS_VD), VE: VE.fim(TIPOS_VE), CD: CD.fim(TIPOS_CD), CF: CF.fim(TIPOS_CF),
        descontoSemPagamento, ultimoCredito,
        linhas: this.linhas, descartadas: this.descartadas, ultimaAtualizacao: this.ultimaAtualizacao,
        zonasSemSup: [...this.zonasSemSup.keys()], subSemClasse: [...this.subSemClasse.keys()],
      };
    }
  }
  const TIPOS_VD = { mi: Uint8Array, d: Uint8Array, c: Uint16Array, valor: Float64Array, contas: Float64Array };
  const TIPOS_VE = { mi: Uint8Array, d: Uint8Array, c: Uint16Array, v: Uint16Array, valor: Float64Array };
  const TIPOS_CD = { mi: Uint8Array, c: Uint16Array, d: Uint8Array, n: Uint32Array };
  // CF: por mês × combinação × conjunto de dias em que a ligação pagou (máscara): nº de ligações e o desconto delas
  const TIPOS_CF = { mi: Uint8Array, c: Uint16Array, m: Uint32Array, n: Uint32Array, desc: Float64Array };
  const DIAS_MASK = 2 ** 24;
  function colunas(nomes) {                              // tabela por colunas: add(...valores) e fim(tipos) → { tam, coluna: TypedArray }
    const cols = nomes.map(() => []);
    return {
      add(...v) { for (let i = 0; i < cols.length; i++) cols[i].push(v[i]); },
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
    for (const t of [dados.VD, dados.VE, dados.CD, dados.CF]) for (const v of Object.values(t)) if (ArrayBuffer.isView(v)) out.push(v.buffer);
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
  const cfNoCorte = (CF, i, sel) => (CF.m[i] & sel) !== 0;
  const flagsMeses = (dados, mesesIdx) => { const q = new Uint8Array(dados.meses.length + 1); mesesIdx.forEach((m) => { if (m >= 0) q[m] = 1; }); return q; };

  // Por dia útil (0..23) de um mês: valor (sem desconto), contas, clientes distintos no dia
  function serieDoMes(dados, mi, marcas) {
    const s = { valor: new Float64Array(MAX_DIA + 1), contas: new Float64Array(MAX_DIA + 1), clientes: new Float64Array(MAX_DIA + 1) };
    const V = dados.VD, D = dados.CD;
    for (let i = 0; i < V.tam; i++) if (V.mi[i] === mi && marcas[V.c[i]]) { s.valor[V.d[i]] += V.valor[i]; s.contas[V.d[i]] += V.contas[i]; }
    for (let i = 0; i < D.tam; i++) if (D.mi[i] === mi && marcas[D.c[i]]) s.clientes[D.d[i]] += D.n[i];
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
    const V = dados.VD, F = dados.CF;
    for (let i = 0; i < V.tam; i++) {
      if (!quer[V.mi[i]] || !marcas[V.c[i]] || !noCorte(V.d[i], sel)) continue;
      const c = cel(rotulos[V.c[i]], V.mi[i]);
      c.valor += V.valor[i]; c.contas += V.contas[i];
    }
    for (let i = 0; i < F.tam; i++) {
      if (!quer[F.mi[i]] || !marcas[F.c[i]] || !cfNoCorte(F, i, sel)) continue;
      const c = cel(rotulos[F.c[i]], F.mi[i]);
      c.clientes += F.n[i]; c.desconto -= F.desc[i]; c.valor -= F.desc[i];
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
    const E = dados.VE, F = dados.CF;
    for (let i = 0; i < E.tam; i++) {
      if (!quer[E.mi[i]] || !marcas[E.c[i]] || !noCorte(E.d[i], sel)) continue;
      const v = mesDoVenc(E.v[i]);
      let l = linhas.get(v);
      if (!l) { l = new Map(); linhas.set(v, l); }
      l.set(E.mi[i], (l.get(E.mi[i]) || 0) + E.valor[i]);
    }
    for (let i = 0; i < F.tam; i++) {
      if (!quer[F.mi[i]] || !marcas[F.c[i]] || !F.desc[i] || !cfNoCorte(F, i, sel)) continue;
      desconto.set(F.mi[i], (desconto.get(F.mi[i]) || 0) - F.desc[i]);
    }
    return { linhas, desconto };
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
    MAX_DIA, MESES_CURTOS, chave, ehLinhaArrecadacao, ordemOrcado, numeroBR, dataISO, ligacao, rotuloMes, mesAnterior, calendario, rotuloDia,
    zonaInfo, subInfo, chaveLig, mascaraAte, diasDaMascara, vencIdx, mesDoVenc, LeituraArquivo, Agregador, buffers, marcaCombos, serieDoMes, porGrupo, totalDoMes,
    descontoPorMes, escada,
    participacoes, mesesDaCurva, curvaMedia, distribuiCurva,
  };
});
