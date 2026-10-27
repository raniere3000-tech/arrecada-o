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

test("cliente distinto é a ligação, mesmo com contas de perfis (contratos) diferentes no mês", () => {
  const perfis = new Map([["7|1", "Adimplente"], ["7|2", "Inadimplente"]]);
  const a = new C.Agregador({ perfis });
  a.adiciona(linha(7, "01/10/2026", "10,00", { contrato: "1" }));
  a.adiciona(linha(7, "01/10/2026", "20,00", { contrato: "2" }));
  a.adiciona(linha(7, "02/10/2026", "5,00", { contrato: "2" }));
  a.adiciona(linha(8, "02/10/2026", "5,00"));
  const d = a.resultado(new Map([["2026-10", new Map([["7", 3]])]])), tudo = C.marcaCombos(d, {});
  const t = C.totalDoMes(d, 0, tudo, C.mascaraAte(2));
  assert.equal(t.clientes, 2);                                 // ligações 7 e 8 (antes: 3)
  perto(t.valor, 40 - 3);                                      // desconto da ligação 7 abatido uma vez
  const s = C.serieDoMes(d, 0, tudo);
  assert.equal(s.clientes[1], 1);
  assert.equal(s.clientes[2], 2);
  const p = C.porGrupo(d, [0], tudo, C.mascaraAte(2), (c) => c.perfil);
  assert.equal(p.get("Adimplente").get(0).clientes, 1);       // em cada perfil ela conta uma vez (como no BI)
  assert.equal(p.get("Inadimplente").get(0).clientes, 1);
  perto([...p.values()].reduce((x, l) => x + l.get(0).desconto, 0), -3);
});

test("análise: maiores arrecadações, aumentos e quedas por ligação (mesmos dias úteis, com desconto)", () => {
  const a = new C.Agregador();
  // setembro: 1 paga 100, 2 paga 300, 3 paga 50; outubro: 1 paga 400 (desconto 20), 2 paga 100, 4 paga 70 (novo)
  a.adiciona(linha(1, "01/09/2026", "100,00", { cliente: "ANA" }));
  a.adiciona(linha(2, "01/09/2026", "300,00", { cliente: "BETO" }));
  a.adiciona(linha(3, "02/09/2026", "50,00"));
  a.adiciona(linha(1, "01/10/2026", "250,00", { cliente: "ANA" }));
  a.adiciona(linha(1, "02/10/2026", "150,00"));
  a.adiciona(linha(2, "02/10/2026", "100,00"));
  a.adiciona(linha(4, "01/10/2026", "70,00"));
  a.adiciona(linha(4, "30/10/2026", "999,00"));                  // fora dos dias marcados
  const d = a.resultado(new Map([["2026-10", new Map([["1", 20]])]])), tudo = C.marcaCombos(d, {});
  const r = C.rankings(d.analise, 1, 0, tudo, C.mascaraAte(2));
  assert.deepEqual(r.maiores.map((x) => [x.lig, x.atual]), [[1, 380], [2, 100], [4, 70]]);
  assert.deepEqual(r.aumentos.map((x) => [x.lig, x.dif]), [[1, 280], [4, 70]]);
  assert.deepEqual(r.quedas.map((x) => [x.lig, x.dif]), [[2, -200], [3, -50]]);
  assert.equal(r.nAumentos, 2);
  assert.equal(r.nQuedas, 2);
  assert.equal(d.analise.nomes.get(2), "BETO");               // pagamento ≥ R$ 200 guarda o nome
  assert.equal(d.analise.nomes.get(3), undefined);
  assert.equal(C.rankings(d.analise, 1, 0, tudo, C.mascaraAte(2), 1).maiores.length, 1);
});

// ---------- faturamento (Fatura de ciclo) e cruzamento com a arrecadação ----------
const fat = (lig, venc, valor, extra = {}) => ({ lig: String(lig), venc, ref: "set/26", valor, cidade: "RIO BONITO", categoria: "RESIDENCIAL",
  situacao: "LIBERADA", cliente: "FULANO", ...extra });

test("referência e acentos do faturamento", () => {
  assert.equal(C.refDeTexto("set/26"), "2026-09");
  assert.equal(C.refDeTexto("09/2026"), "2026-09");
  assert.equal(C.refDeTexto("Soma de 01/10/2025".replace(/^Soma de /, "")), "2025-10");
  assert.equal(C.refDeTexto("xyz"), "");
  assert.equal(C.refDeTexto("2026-08"), "2026-08");             // referência tirada do nome do arquivo
  assert.equal(C.vencNum("2026-10-10"), 20261010);
  assert.equal(C.consertaAcento("CORREÃ‡ÃƒO MONETÃ\u0081RIA"), "CORREÇÃO MONETÁRIA");   // como vem no arquivo real (com o \x81)
  assert.equal(C.consertaAcento("NORMAL"), "NORMAL");
});

test("faturamento: conta = matrícula + vencimento, soma todas as rubricas (créditos inclusive), Em Análise fica de fora", () => {
  const f = new C.LeituraFaturamento();
  f.adiciona(fat(1, "10/10/2026", "129,16"));                       // VALOR DE AGUA
  f.adiciona(fat(1, "10/10/2026", "-53,42"));                       // CREDITO/DEBITO DE ARRECADACAO
  f.adiciona(fat(1, "10/10/2026", "4,01"));                         // JUROS
  f.adiciona(fat(2, "05/10/2026", "300,00", { categoria: "PUBLICA", cidade: "CORDEIRO" }));
  f.adiciona(fat(3, "05/10/2026", "999,00", { situacao: "EM ANALISE" }));
  f.adiciona(fat("", "05/10/2026", "1,00"));                        // sem matrícula: ignorada e contada
  const e = f.exporta();
  assert.equal(e.contas.lig.length, 2);
  assert.equal(e.linhas, 4);
  assert.deepEqual(e.fora, { linhas: 1, valor: 999, contas: 1 });
  assert.equal(e.semChave, 1);
  assert.deepEqual(e.refs, ["2026-09"]);
  const i1 = [...e.contas.lig].indexOf(1);
  perto(e.contas.valor[i1], 129.16 - 53.42 + 4.01);
  perto(e.contas.credito[i1], -53.42);
});

test("cruzamento: pagamento acha a conta pela matrícula + vencimento; parcela e conta repetida", () => {
  const f1 = new C.LeituraFaturamento(), f2 = new C.LeituraFaturamento();
  f1.adiciona(fat(1, "10/10/2026", "100,00"));
  f1.adiciona(fat(2, "05/10/2026", "300,00", { categoria: "PUBLICA", cidade: "CORDEIRO" }));
  f1.adiciona(fat(4, "05/10/2026", "50,00"));                       // não paga
  f2.adiciona(fat(1, "10/10/2026", "100,00"));                      // mesma conta em outro arquivo: conta uma vez
  const a = new C.Agregador();
  const arr = (lig, venc, cred, valor, tipo = "1-NOTA FISCAL MENSAL") => ({ lig: String(lig), contrato: "1", vencimento: venc, credito: cred, valor,
    util: "100-RESIDENCIAL NORMAL", zona: "14-RIO BONITO", tipo });
  a.adiciona(arr(1, "10/10/2026", "08/10/2026", "60,00"));          // paga parte em outubro
  a.adiciona(arr(1, "10/10/2026", "03/11/2026", "40,00"));          // e o resto em novembro
  a.adiciona(arr(2, "05/10/2026", "05/10/2026", "300,00"));
  a.adiciona(arr(2, "15/10/2026", "15/10/2026", "80,00", "3-PARCELA"));   // parcela: sem conta na fatura
  a.adiciona({ ...arr(9, "10/10/2026", "08/10/2026", "70,00"), zona: "16-SAO GONCALO" });   // Leste: fora do cruzamento
  const d = a.resultado(new Map());
  const x = C.cruzaFaturamento([f1.exporta(), f2.exporta()], d.analise.pagamentos, d.meses);
  assert.equal(x.diag.contas, 3);
  assert.equal(x.diag.duplicadas, 1);
  const totFat = x.fat.reduce((s, r) => s + r.valor, 0);
  perto(totFat, 450);
  assert.equal(x.fat.reduce((s, r) => s + r.matriculas, 0), 3);
  const out = x.concil.find((c) => c.mes === "2026-10"), nov = x.concil.find((c) => c.mes === "2026-11");
  perto(out.achou[1], 360);
  perto(out.semConta[3], 80);
  perto(out.achou.reduce((s, v) => s + v, 0) + out.semConta.reduce((s, v) => s + v, 0), 440);   // Leste não entra
  perto(nov.achou[1], 40);
  // coorte da referência set/26: 360 em out (2 contas pagas) e 40 em nov (nenhuma conta nova)
  const co = (mes) => x.coorte.filter((r) => r.ref === "2026-09" && r.mes === mes);
  perto(co("2026-10").reduce((s, r) => s + r.valor, 0), 360);
  assert.equal(co("2026-10").reduce((s, r) => s + r.contas, 0), 2);
  assert.equal(co("2026-11").reduce((s, r) => s + r.contas, 0), 0);
  perto(co("2026-10").reduce((s, r) => s + r.faturado, 0), 400);   // faturado das contas pagas pela 1ª vez no mês
  // matriz de conversão: set/26 tem 450 faturados (3 contas; a de 50 não foi paga); out/26 = M+1 (360), nov/26 = M+2 (40)
  const mz = C.matrizConversao(x, () => true, ["2026-09", "2026-10", "2026-11"]);
  const s9 = mz.linhas.find((l) => l.ref === "2026-09");
  perto(s9.faturado, 450);
  assert.equal(s9.contas, 3);
  perto(s9.cel[1].valor, 360);
  perto(s9.cel[2].valor, 40);
  assert.equal(s9.cel[0].valor, 0);
  assert.equal(s9.cel[3], undefined);                 // dez/26 ainda não tem arrecadação
  perto(s9.recebido, 400);
  assert.equal(s9.contasPagas, 2);
  perto(s9.semPagamento, 50);
  assert.equal(mz.maxOff, 2);
  assert.equal(C.matrizConversao(x, (c) => c.cidade === "NADA", ["2026-10"]).linhas.length, 0);
  assert.equal(x.combos.find((c) => c.cidade === "CORDEIRO").grupo, "PUBLICO");
  // mesmo vencimento: em out/26 foram pagos 360 de contas da ref. set/26 cujo faturado é 100 + 300 = 400; em nov/26, 40 da conta de 100
  const pg = (mes) => x.pagas.filter((r) => r.mes === mes);
  perto(pg("2026-10").reduce((s, r) => s + r.pago, 0), 360);
  perto(pg("2026-10").reduce((s, r) => s + r.faturado, 0), 400);
  assert.equal(pg("2026-10").reduce((s, r) => s + r.contas, 0), 2);
  assert.equal(pg("2026-10").reduce((s, r) => s + r.matriculas, 0), 2);
  perto(pg("2026-11").reduce((s, r) => s + r.faturado, 0), 100);
  assert.ok(pg("2026-10").every((r) => r.ref === "2026-09"));
  assert.equal(x.combos[0].sup, "INTERIOR");
});

test("cruzamento sem faturamento ou sem arrecadação não quebra", () => {
  const vazio = C.cruzaFaturamento([], [], []);
  assert.deepEqual(vazio.fat, []);
  assert.equal(vazio.diag.contas, 0);
  const f = new C.LeituraFaturamento();
  f.adiciona(fat(1, "10/10/2026", "10,00"));
  assert.equal(C.cruzaFaturamento([f.exporta()], undefined, []).fat.length, 1);
});

test("faturamento: campos entre aspas, ano com 2 dígitos e motivo das linhas descartadas", () => {
  assert.deepEqual(C.separaCsv('"101";"10/10/2026";"R. A; casa";"1,50"'), ["101", "10/10/2026", "R. A; casa", "1,50"]);
  assert.deepEqual(C.separaCsv('a;"di""z";c'), ["a", 'di"z', "c"]);
  assert.equal(C.dataISO("10/10/26"), "2026-10-10");
  assert.equal(C.dataISO('"10/10/2026"'), "2026-10-10");
  assert.equal(C.dataISO("10-10-2026"), "2026-10-10");
  assert.equal(C.dataISO("2026/03/01"), "2026-03-01");          // como vem na Fatura de ciclo (ano/mês/dia)
  assert.equal(C.dataISO("2026/3/1"), "2026-03-01");
  const f = new C.LeituraFaturamento();
  f.adiciona(fat(1, "10/10/26", "10,00"));
  f.adiciona(fat(3, "2026/03/01", "5,00", { ref: "01/2026" }));
  f.adiciona(fat(2, "xx", "10,00"));
  const e = f.exporta();
  assert.equal(e.contas.lig.length, 2);
  assert.equal(e.rejeitadas.venc, 1);
  assert.deepEqual(e.refs, ["2026-01", "2026-09"]);
  assert.match(e.rejeitadas.exemplo, /vencimento "xx"/);
});
