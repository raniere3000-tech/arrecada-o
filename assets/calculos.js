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
  function mesAnterior(mes, n = 1) {
    let a = +mes.slice(0, 4), m = +mes.slice(5, 7) - n;
    while (m < 1) { m += 12; a--; }
    return `${a}-${String(m).padStart(2, "0")}`;
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
  // Cada arquivo vira uma LeituraArquivo: somas por mês × dia útil × combinação (zona, subcategoria, perfil) × mês de
  // vencimento, e os dias em que cada ligação pagou (para contar clientes distintos). O resultado (exporta) é pequeno,
  // fica guardado no navegador e o Agregador junta os arquivos sem precisar relê-los.
  const SEP = "\u0001";
  class LeituraArquivo {
    constructor(perfis) {
      this.perfis = perfis || null;                    // Map "ligação|contrato" → perfil (CLUSTER SALDO)
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
      const lig = ligacao(r.lig);
      const perfil = this.perfis ? (this.perfis.get(lig + "|" + ligacao(r.contrato)) || R.SEM_PERFIL) : R.SEM_PERFIL;
      const ck = String(r.zona || "").trim() + SEP + String(r.util || "").trim() + SEP + perfil;
      const venc = dataISO(r.vencimento).slice(0, 7);
      const kv = ordem + SEP + ck + SEP + venc;
      let a = M.V.get(kv);
      if (!a) { a = [0, 0, 0]; M.V.set(kv, a); }
      a[0] += valor;
      if (R.TIPOS_CONTA.includes(String(r.tipo || "").trim())) a[1]++;
      a[2]++;
      const kl = lig + SEP + ck;
      M.L.set(kl, (M.L.get(kl) || 0) | (1 << ordem));
      if (r.atualizacao) {
        const at = String(r.atualizacao).trim(), comp = dataISO(at) + at.slice(10);
        if (comp > this.ultimaAtualizacao) this.ultimaAtualizacao = comp;
      }
    }
    // { meses: { "AAAA-MM": { V: [[ordem, combo, venc, valor, contas, linhas]], L: [[ligação, combo, dias]], ultimoCredito, linhas } }, … }
    exporta() {
      const meses = {};
      for (const [mes, M] of this.meses) {
        const V = [], L = [];
        for (const [k, a] of M.V) {
          const p = k.split(SEP);
          V.push([+p[0], p[1] + SEP + p[2] + SEP + p[3], p[4], a[0], a[1], a[2]]);
        }
        for (const [k, mask] of M.L) { const p = k.indexOf(SEP); L.push([k.slice(0, p), k.slice(p + 1), mask]); }
        meses[mes] = { V, L, ultimoCredito: M.ultimoCredito, linhas: M.linhas };
      }
      return { meses, descartadas: this.descartadas, ultimaAtualizacao: this.ultimaAtualizacao };
    }
  }

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
      this.combos.push({ zona, cidade, sup, util, grupo, detalhe, perfil });
      this.idxCombo.set(ck, i);
      return i;
    }
    // Junta o que um arquivo exportou; aceitaMes(mes) = false pula o mês (ex.: mês que vem do arquivo diário).
    // Devolve { linhas usadas, puladas, meses }.
    junta(exp, aceitaMes) {
      let usadas = 0, puladas = 0;
      const meses = [];
      for (const [mes, X] of Object.entries(exp.meses)) {
        if (aceitaMes && !aceitaMes(mes)) { puladas += X.linhas; continue; }
        meses.push(mes);
        usadas += X.linhas;
        let M = this.meses.get(mes);
        if (!M) { M = { V: new Map(), L: new Map(), ultimoCredito: "" }; this.meses.set(mes, M); }
        if (X.ultimoCredito > M.ultimoCredito) M.ultimoCredito = X.ultimoCredito;
        for (const [ordem, ck, venc, valor, contas, linhas] of X.V) {
          const kv = ordem + "|" + this.combo(ck) + "|" + venc;
          const a = M.V.get(kv);
          if (a) { a[0] += valor; a[1] += contas; a[2] += linhas; } else M.V.set(kv, [valor, contas, linhas]);
        }
        for (const [lig, ck, mask] of X.L) {
          const kl = lig + "|" + this.combo(ck);
          M.L.set(kl, (M.L.get(kl) || 0) | mask);
        }
      }
      this.linhas += usadas;
      this.descartadas.semCredito += exp.descartadas.semCredito;
      this.descartadas.semValor += exp.descartadas.semValor;
      if (exp.ultimaAtualizacao > this.ultimaAtualizacao) this.ultimaAtualizacao = exp.ultimaAtualizacao;
      return { linhas: usadas, puladas, meses: meses.sort() };
    }
    // Atalho (testes): linha a linha, como um arquivo só
    adiciona(r) {
      if (!this.parcial) this.parcial = new LeituraArquivo(this.perfis);
      this.parcial.adiciona(r);
    }
    // descontos: Map mês → Map ligação → valor do desconto (positivo). O desconto de cada ligação entra no mês da
    // REFERENCIA e só para ligações que pagaram no mês (como no BI), na combinação e no 1º dia útil em que pagou.
    resultado(descontos) {
      if (this.parcial) { this.junta(this.parcial.exporta()); this.parcial = null; }
      const meses = [...this.meses.keys()].sort();
      const V = [], CD = [], CF = [], descontoSemPagamento = {}, ultimoCredito = {};
      meses.forEach((mes, mi) => {
        const M = this.meses.get(mes);
        ultimoCredito[mes] = M.ultimoCredito;
        for (const [k, a] of M.V) {
          const p1 = k.indexOf("|"), p2 = k.indexOf("|", p1 + 1);
          V.push([mi, +k.slice(0, p1), +k.slice(p1 + 1, p2), k.slice(p2 + 1), a[0], a[1], a[2]]);
        }
        const cd = new Map(), cf = new Map(), porLig = new Map();
        for (const [k, mask] of M.L) {
          const p = k.indexOf("|"), lig = k.slice(0, p), c = +k.slice(p + 1);
          let primeiro = 0;
          for (let d = 1; d <= MAX_DIA; d++) if (mask & (1 << d)) { primeiro = d; break; }
          const tem0 = mask & 1 ? 1 : 0;
          for (let d = 0; d <= MAX_DIA; d++) if (mask & (1 << d)) { const kd = c * 32 + d; cd.set(kd, (cd.get(kd) || 0) + 1); }
          const kf = c * 64 + primeiro * 2 + tem0;
          const e = cf.get(kf);
          if (e) e[0]++; else cf.set(kf, [1, 0]);
          const ordemEscolha = primeiro || 99;
          const atual = porLig.get(lig);
          if (!atual || ordemEscolha < atual[1]) porLig.set(lig, [kf, ordemEscolha]);
        }
        const dm = descontos && descontos.get(mes);
        let semPag = 0;
        if (dm) for (const [lig, val] of dm) {
          const x = porLig.get(lig);
          if (x) cf.get(x[0])[1] += val; else semPag += val;
        }
        if (semPag) descontoSemPagamento[mes] = semPag;
        for (const [kd, n] of cd) CD.push([mi, Math.floor(kd / 32), kd % 32, n]);
        for (const [kf, e] of cf) CF.push([mi, Math.floor(kf / 64), Math.floor((kf % 64) / 2), kf % 2, e[0], e[1]]);
      });
      return {
        meses, combos: this.combos, V, CD, CF, descontoSemPagamento, ultimoCredito,
        linhas: this.linhas, descartadas: this.descartadas, ultimaAtualizacao: this.ultimaAtualizacao,
        zonasSemSup: [...this.zonasSemSup.keys()], subSemClasse: [...this.subSemClasse.keys()],
      };
    }
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
  // dia útil d entra no corte: 1..N, e o 0 (fins de semana e feriados do mês inteiro) só se incl0 — como o filtro do BI
  const noCorte = (d, N, incl0) => (d === 0 ? incl0 : d <= N);

  // Por dia útil (0..23) de um mês: valor (sem desconto), contas, clientes distintos no dia
  function serieDoMes(dados, mi, marcas) {
    const s = { valor: new Float64Array(MAX_DIA + 1), contas: new Float64Array(MAX_DIA + 1), clientes: new Float64Array(MAX_DIA + 1) };
    for (const r of dados.V) if (r[0] === mi && marcas[r[2]]) { s.valor[r[1]] += r[4]; s.contas[r[1]] += r[5]; }
    for (const r of dados.CD) if (r[0] === mi && marcas[r[1]]) s.clientes[r[2]] += r[3];
    return s;
  }

  // Tabela por grupo × mês até o dia útil N: { linhas: Map rótulo → Map mi → {valor, desconto, contas, clientes} }
  // `grupoDe(combo)` dá o rótulo da linha (ex.: c => c.cidade). O desconto entra no valor (Arrecadação = Val. Autenticado + desconto).
  function porGrupo(dados, mesesIdx, marcas, N, incl0, grupoDe) {
    const quer = new Set(mesesIdx), linhas = new Map();
    const rotulos = dados.combos.map((c) => grupoDe(c));
    const cel = (rot, mi) => {
      let l = linhas.get(rot);
      if (!l) { l = new Map(); linhas.set(rot, l); }
      let c = l.get(mi);
      if (!c) { c = { valor: 0, desconto: 0, contas: 0, clientes: 0 }; l.set(mi, c); }
      return c;
    };
    for (const r of dados.V) {
      if (!quer.has(r[0]) || !marcas[r[2]] || !noCorte(r[1], N, incl0)) continue;
      const c = cel(rotulos[r[2]], r[0]);
      c.valor += r[4]; c.contas += r[5];
    }
    for (const r of dados.CF) {
      if (!quer.has(r[0]) || !marcas[r[1]]) continue;
      if (!((r[2] >= 1 && r[2] <= N) || (incl0 && r[3]))) continue;
      const c = cel(rotulos[r[1]], r[0]);
      c.clientes += r[4]; c.desconto -= r[5]; c.valor -= r[5];
    }
    return linhas;
  }
  function totalDoMes(dados, mi, marcas, N, incl0) {
    const l = porGrupo(dados, [mi], marcas, N, incl0, () => "T").get("T");
    return (l && l.get(mi)) || { valor: 0, desconto: 0, contas: 0, clientes: 0 };
  }

  // Escada: mês de vencimento × mês de crédito (valor sem desconto) + o desconto de cada mês de crédito à parte
  function escada(dados, mesesIdx, marcas, N, incl0) {
    const quer = new Set(mesesIdx), linhas = new Map(), desconto = new Map();
    for (const r of dados.V) {
      if (!quer.has(r[0]) || !marcas[r[2]] || !noCorte(r[1], N, incl0)) continue;
      let l = linhas.get(r[3]);
      if (!l) { l = new Map(); linhas.set(r[3], l); }
      l.set(r[0], (l.get(r[0]) || 0) + r[4]);
    }
    for (const r of dados.CF) {
      if (!quer.has(r[0]) || !marcas[r[1]] || !r[5]) continue;
      if (!((r[2] >= 1 && r[2] <= N) || (incl0 && r[3]))) continue;
      desconto.set(r[0], (desconto.get(r[0]) || 0) - r[5]);
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
  function mesesDaCurva(dados, mes) {
    const ano = mes.slice(0, 4);
    let lista = dados.meses.filter((m) => m < mes && m.slice(0, 4) === ano);
    if (!lista.length) lista = dados.meses.filter((m) => m < mes && m >= mesAnterior(mes, 12));
    return lista;
  }
  function curvaMedia(dados, mes, marcas) {
    const meses = mesesDaCurva(dados, mes), soma = new Array(MAX_DIA + 1).fill(0);
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
    MAX_DIA, MESES_CURTOS, chave, numeroBR, dataISO, ligacao, rotuloMes, mesAnterior, calendario, rotuloDia,
    zonaInfo, subInfo, LeituraArquivo, Agregador, marcaCombos, serieDoMes, porGrupo, totalDoMes, escada,
    participacoes, mesesDaCurva, curvaMedia, distribuiCurva,
  };
});
