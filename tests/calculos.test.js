// Testes dos cálculos (node --test tests). Dados sintéticos, com os resultados conferidos à mão.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../assets/calculos.js");
const R = require("../assets/regras.js");

const perto = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
const linha = (lig, credito, valor, extra = {}) => ({
  lig: String(lig), contrato: "1", vencimento: "10/" + credito.slice(3), credito, valor,
  util: "100-RESIDENCIAL NORMAL", zona: "14-RIO BONITO", tipo: "1-NOTA FISCAL MENSAL", ...extra,
});

test("números e datas no formato brasileiro", () => {
  assert.equal(C.numeroBR("1.398,69"), 1398.69);
  assert.equal(C.numeroBR("-50,66"), -50.66);
  assert.equal(C.numeroBR("R$ 12.103.044,93"), 12103044.93);
  assert.equal(C.dataISO("02/10/2026 02:09"), "2026-10-02");
  assert.equal(C.dataISO(""), "");
  assert.equal(C.ligacao("0100000001"), "100000001");
  assert.equal(C.rotuloMes("2026-10"), "out/2026");
  assert.equal(C.mesAnterior("2026-01", 2), "2025-11");
  assert.equal(C.mesAnterior("2026-11", -2), "2027-01");
});

test("dias úteis de outubro/2026 batem com o BI (21 dias, 12 = dia 19)", () => {
  const cal = C.calendario("2026-10");
  assert.equal(cal.uteis, 21);
  assert.equal(cal.ordem["2026-10-01"], 1);
  assert.equal(cal.ordem["2026-10-02"], 2);
  assert.equal(cal.ordem["2026-10-05"], 3);
  assert.equal(cal.ordem["2026-10-12"], 0);           // Nossa Senhora Aparecida
  assert.equal(cal.ordem["2026-10-19"], 12);
  assert.equal(cal.ordem["2026-10-30"], 21);
  assert.equal(C.rotuloDia("2026-10-19"), "19, seg");
});

test("feriados nacionais móveis e do RJ", () => {
  const f = R.feriados(2026);
  ["2026-02-16", "2026-02-17", "2026-04-03", "2026-06-04", "2026-04-23", "2026-11-20"].forEach((d) => assert.ok(f.has(d), d));
  assert.ok(R.feriados(2025).has("2025-03-04"));       // Carnaval 2025
});

test("zona e subcategoria seguem as tabelas do BI", () => {
  assert.deepEqual(C.zonaInfo("14-RIO BONITO"), ["RIO BONITO", "INTERIOR"]);
  assert.deepEqual(C.zonaInfo("16-SAO GONCALO"), ["SAO GONCALO", "LESTE"]);
  assert.deepEqual(C.zonaInfo("99-NOVA CIDADE"), ["NOVA CIDADE", R.SEM_SUP]);
  assert.deepEqual(C.subInfo("202-PUBLICO MUNICIPAL"), ["PUBLICO", "402-PUBLICO MUNICIPAL"]);
  assert.equal(C.subInfo("999-XYZ")[0], R.SEM_CLASSIFICACAO);
});

function exemplo() {
  const perfis = new Map([["1|1", "Adimplente"], ["2|1", "Inadimplente"]]);
  const a = new C.Agregador({ perfis });
  // outubro/2026: dia útil 1 = 01/10, 2 = 02/10, sábado 03/10 = 0
  a.adiciona(linha(1, "01/10/2026", "100,00"));
  a.adiciona(linha(1, "02/10/2026", "50,00", { tipo: "3-PARCELA" }));       // parcela: não conta como conta paga
  a.adiciona(linha(2, "02/10/2026", "200,00", { util: "202-PUBLICO MUNICIPAL" }));
  a.adiciona(linha(3, "03/10/2026", "30,00"));                              // sábado: dia 0
  a.adiciona(linha(4, "05/10/2026", "40,00", { zona: "16-SAO GONCALO" }));   // dia útil 3, Leste
  a.adiciona(linha(5, "", "10,00"));                                         // sem crédito: ignorada
  a.adiciona(linha(1, "01/09/2026", "80,00"));
  const descontos = new Map([["2026-10", new Map([["1", 15], ["9", 7]])]]);
  return a.resultado(descontos);
}

test("agregação: valores, contas, clientes distintos e desconto", () => {
  const d = exemplo();
  assert.deepEqual(d.meses, ["2026-09", "2026-10"]);
  assert.equal(d.linhas, 6);
  assert.equal(d.descartadas.semCredito, 1);
  assert.deepEqual(d.descontoSemPagamento, { "2026-10": 7 });
  const tudo = C.marcaCombos(d, {}), mi = 1;
  const s = C.serieDoMes(d, mi, tudo);
  assert.equal(s.valor[1], 100);
  assert.equal(s.valor[2], 250);
  assert.equal(s.valor[0], 30);
  assert.equal(s.contas[2], 1);
  assert.equal(s.clientes[2], 2);
  // até o dia útil 2, sem o 0: 350 - desconto 15 da ligação 1 (pagou no dia 1)
  const t2 = C.totalDoMes(d, mi, tudo, C.mascaraAte(2, false));
  perto(t2.valor, 335);
  perto(t2.desconto, -15);
  assert.equal(t2.contas, 2);
  assert.equal(t2.clientes, 2);
  // com o 0 (fins de semana e feriados): + 30 e + 1 cliente
  const t2z = C.totalDoMes(d, mi, tudo, C.mascaraAte(2, true));
  perto(t2z.valor, 365);
  assert.equal(t2z.clientes, 3);
  // só Interior: tira São Gonçalo
  const interior = C.marcaCombos(d, { sup: "INTERIOR" });
  perto(C.totalDoMes(d, mi, interior, C.mascaraAte(3, false)).valor, 335);
  perto(C.totalDoMes(d, mi, tudo, C.mascaraAte(3, false)).valor, 375);
});

test("tabelas por grupo: subcategoria, perfil e o desconto na linha da ligação", () => {
  const d = exemplo(), tudo = C.marcaCombos(d, {});
  const g = C.porGrupo(d, [1], tudo, C.mascaraAte(3), (c) => c.grupo);
  perto(g.get("RESIDENCIAL").get(1).valor, 100 + 50 + 40 - 15);
  perto(g.get("PUBLICO").get(1).valor, 200);
  const p = C.porGrupo(d, [1], tudo, C.mascaraAte(3), (c) => c.perfil);
  assert.equal(p.get("Adimplente").get(1).clientes, 1);
  assert.equal(p.get(R.SEM_PERFIL).get(1).clientes, 1);       // ligação 4 (sem perfil); a 3 pagou só no sábado
});

test("escada: mês de vencimento × mês de crédito e desconto à parte", () => {
  const d = exemplo(), e = C.escada(d, [0, 1], C.marcaCombos(d, {}), C.mascaraAte(23, true));
  assert.equal(e.linhas.get("2026-10").get(1), 100 + 50 + 200 + 30 + 40);
  assert.equal(e.linhas.get("2026-09").get(0), 80);
  assert.equal(e.desconto.get(1), -15);
});

test("curva do orçado: média dos meses anteriores do ano e sobra dividida entre os dias úteis", () => {
  const a = new C.Agregador();
  // agosto/2026 (21 dias úteis) e setembro/2026 (21): o dia útil 1 recebe 60%, o 2 recebe 40%
  for (const [mes, d1, d2] of [["08", "03", "04"], ["09", "01", "02"]]) {
    a.adiciona(linha(1, `${d1}/${mes}/2026`, "60,00"));
    a.adiciona(linha(2, `${d2}/${mes}/2026`, "40,00"));
  }
  a.adiciona(linha(3, "01/10/2026", "1,00"));
  const d = a.resultado(new Map()), tudo = C.marcaCombos(d, {});
  const cm = C.curvaMedia(d, "2026-10", tudo);
  assert.deepEqual(cm.meses, ["2026-08", "2026-09"]);
  perto(cm.media[1], 0.6);
  perto(cm.media[2], 0.4);
  const w = C.distribuiCurva(cm.media, "2026-10");
  perto(w.reduce((x, y) => x + y, 0), 1);
  perto(w[1], 0.6);
  // mês com menos dias úteis: a média nas posições que sobram é dividida igualmente
  const media = new Array(24).fill(0);
  for (let k = 1; k <= 23; k++) media[k] = 1 / 23;
  const fev = C.distribuiCurva(media, "2026-02");          // fevereiro/2026: 18 dias úteis (Carnaval)
  assert.equal(C.calendario("2026-02").uteis, 18);
  perto(fev[1], 1 / 18);
  perto(fev[19], 0);
});

test("arquivos lidos separados e juntados: o mês do arquivo diário substitui o acumulado", () => {
  const diaria = new C.LeituraArquivo(), acumulada = new C.LeituraArquivo();
  diaria.adiciona(linha(1, "01/10/2026", "100,00"));
  acumulada.adiciona(linha(1, "01/10/2026", "999,00"));        // outubro velho no acumulado: não entra
  acumulada.adiciona(linha(1, "01/09/2026", "50,00"));
  acumulada.adiciona(linha(2, "02/09/2026", "70,00", { zona: "16-SAO GONCALO" }));
  const a = new C.Agregador();
  const rd = a.junta(diaria.exporta());
  const ra = a.junta(acumulada.exporta(), (m) => !rd.meses.includes(m));
  assert.deepEqual(rd.meses, ["2026-10"]);
  assert.deepEqual(ra.meses, ["2026-09"]);
  assert.equal(ra.puladas, 1);
  const d = a.resultado(new Map()), tudo = C.marcaCombos(d, {});
  perto(C.totalDoMes(d, 1, tudo, C.mascaraAte(23, true)).valor, 100);
  perto(C.totalDoMes(d, 0, tudo, C.mascaraAte(23, true)).valor, 120);
  assert.equal(d.combos.length, 2);                            // Rio Bonito e São Gonçalo: mesma combinação reaproveitada
});

test("a mesma ligação em dois arquivos do mês conta uma vez como cliente", () => {
  const x = new C.LeituraArquivo(), y = new C.LeituraArquivo();
  x.adiciona(linha(1, "01/10/2026", "10,00"));
  y.adiciona(linha(1, "02/10/2026", "10,00"));
  const a = new C.Agregador();
  a.junta(x.exporta()); a.junta(y.exporta());
  const d = a.resultado(new Map());
  assert.equal(C.totalDoMes(d, 0, C.marcaCombos(d, {}), C.mascaraAte(2)).clientes, 1);
  assert.equal(C.serieDoMes(d, 0, C.marcaCombos(d, {})).clientes[2], 1);
});

test("dias úteis escolhidos um a um (ex.: só o 1 e o 3)", () => {
  const d = exemplo(), tudo = C.marcaCombos(d, {}), so13 = (1 << 1) | (1 << 3);
  const t = C.totalDoMes(d, 1, tudo, so13);
  perto(t.valor, 100 + 40 - 15);                               // dia 1 (ligação 1, com o desconto dela) + dia 3
  assert.equal(t.clientes, 2);
  assert.equal(C.totalDoMes(d, 1, tudo, 1 << 2).clientes, 2);   // só o dia 2: ligações 1 e 2
  perto(C.totalDoMes(d, 1, tudo, 1 << 2).desconto, -15);        // a ligação 1 também pagou no dia 2
  assert.equal(C.totalDoMes(d, 1, tudo, 0).valor, 0);
  assert.deepEqual(C.diasDaMascara(so13), [1, 3]);
});

test("orçado: linha da arrecadação nos três modelos de RF e ordem das planilhas", () => {
  ["ARRECADAÇÃO CRÉDITO", "(+) Arrecadação", "05.01. Arrecadação"].forEach((r) => assert.ok(C.ehLinhaArrecadacao(r), r));
  ["ARRECADAÇÃO BAIXA", "Faturamento Bruto", "", null].forEach((r) => assert.ok(!C.ehLinhaArrecadacao(r), String(r)));
  const ordem = ["RF02T26", "RF3T25", "RF01T26"].sort((a, b) => C.ordemOrcado(a) - C.ordemOrcado(b));
  assert.deepEqual(ordem, ["RF3T25", "RF01T26", "RF02T26"]);
});

test("curva: a média começa no mês escolhido (padrão: janeiro do ano)", () => {
  const d = { meses: ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03"] };
  assert.deepEqual(C.mesesDaCurva(d, "2026-03"), ["2026-01", "2026-02"]);
  assert.deepEqual(C.mesesDaCurva(d, "2026-03", "2025-12"), ["2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(C.mesesDaCurva(d, "2026-01"), ["2025-11", "2025-12"]);   // janeiro: os 12 meses anteriores
});
