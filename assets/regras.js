// Regras de negócio do painel (as mesmas do Power BI "Diário Arrecadação V4"). Para mudar uma cidade, subcategoria
// ou feriado, altere aqui; o restante do painel lê destas tabelas.
(function (raiz, fabrica) {
  const regras = fabrica();
  if (typeof module === "object" && module.exports) module.exports = regras;
  else raiz.REGRAS = regras;
})(typeof self !== "undefined" ? self : this, function () {
  // Zona (Localidade) do arquivo de arrecadação → cidade e superintendência ("Lagos" no BI = INTERIOR; "R4" = LESTE)
  const ZONAS = {
    "1-RIO DE JANEIRO": ["RIO DE JANEIRO", "LESTE"],
    "1-RIO DE JANEIRO - A": ["RIO DE JANEIRO - A", "LESTE"],
    "2-APERIBE": ["APERIBE", "INTERIOR"],
    "3-CACHOEIRAS DE MACACU": ["CACHOEIRAS DE MACACU", "INTERIOR"],
    "4-CAMBUCI": ["CAMBUCI", "INTERIOR"],
    "5-CANTAGALO": ["CANTAGALO", "INTERIOR"],
    "6-CASIMIRO DE ABREU": ["CASIMIRO DE ABREU", "INTERIOR"],
    "7-CORDEIRO": ["CORDEIRO", "INTERIOR"],
    "8-DUAS BARRAS": ["DUAS BARRAS", "INTERIOR"],
    "9-ITABORAI": ["ITABORAI", "LESTE"],
    "10-ITAOCARA": ["ITAOCARA", "INTERIOR"],
    "11-MAGE": ["MAGE", "LESTE"],
    "12-MARICA": ["MARICA", "LESTE"],
    "13-MIRACEMA": ["MIRACEMA", "INTERIOR"],
    "14-RIO BONITO": ["RIO BONITO", "INTERIOR"],
    "15-S.FCO.DO ITABAPOANA": ["S.FCO.DO ITABAPOANA", "INTERIOR"],
    "16-SAO GONCALO": ["SAO GONCALO", "LESTE"],
    "17-S.SEBASTIAO DO ALTO": ["S.SEBASTIAO DO ALTO", "INTERIOR"],
    "18-SAQUAREMA": ["SAQUAREMA", "LESTE"],
    "19-TANGUA": ["TANGUA", "LESTE"],
  };
  const SUPS = ["INTERIOR", "LESTE"];
  const SEM_SUP = "SEM SUP";

  // Utilização (Sub. Categ.) → [Subcategoria, detalhe (Utilização Atualizada)]
  const SUBCATEGORIAS = {
    "106-VERANISTA": ["RESIDENCIAL", "RESIDENCIAL"], "113-RESIDENCIAL EM VILA": ["RESIDENCIAL", "RESIDENCIAL"],
    "202-PUBLICO MUNICIPAL": ["PUBLICO", "402-PUBLICO MUNICIPAL"], "203-PUBLICO ESTADUAL": ["PUBLICO", "403-PUBLICO ESTADUAL"],
    "204-DECISAO JUDICIAL": ["RESIDENCIAL", "RESIDENCIAL"], "209-PEQUENO COMERCIO-PROJETOS": ["PEQUENO COMERCIO", "PEQUENO COMERCIO"],
    "211-ESCOLA/COLEGIO PARTICULAR": ["PUBLICO", "400-PUBLICO NORMAL"], "212-IGREJAS/ TEMPLOS/ SINAGOGAS": ["PUBLICO", "400-PUBLICO NORMAL"],
    "224-FARMACIA / PERFUMARIA": ["COMERCIAL", "COMERCIAL"], "407-HOSPITAIS E CLINICAS MUNICIPAL": ["PUBLICO", "402-PUBLICO MUNICIPAL"],
    "410-TEMPLO RELIGIOSO": ["PUBLICO", "405-ENT.S/FIM LUCRATIVO"], "505-PROJETOS": ["RESIDENCIAL", "RESIDENCIAL"],
    "507-CAD UNICO": ["SOCIAL", "SOCIAL"], "508-BPC": ["SOCIAL", "SOCIAL"], "509-IBGE": ["RESIDENCIAL", "RESIDENCIAL"],
    "200-COMERCIAL NORMAL": ["COMERCIAL", "COMERCIAL"], "207-HOSPITAIS E CLINICAS COMERCIAL": ["COMERCIAL", "COMERCIAL"],
    "210-ACADEMIA DE GINASTICA": ["COMERCIAL", "COMERCIAL"], "213-HOTEL/ MOTEL/ POUSADA": ["COMERCIAL", "COMERCIAL"],
    "217-POSTO DE GASOLINA": ["COMERCIAL", "COMERCIAL"], "219-RESTAURANTE": ["COMERCIAL", "COMERCIAL"],
    "220-SUPERMERCADO": ["COMERCIAL", "COMERCIAL"], "224-FARMACIA/ PERFUMARIA": ["COMERCIAL", "COMERCIAL"],
    "226-LOJA": ["COMERCIAL", "COMERCIAL"], "228-PADARIA": ["COMERCIAL", "COMERCIAL"], "231-BAR": ["COMERCIAL", "COMERCIAL"],
    "245-SALA COMERCIAL": ["COMERCIAL", "COMERCIAL"], "249-CLUBE/ ASSOCIACAO RECREATIVA": ["COMERCIAL", "COMERCIAL"],
    "265-CONDOMÍNIO COMERCIAL": ["COMERCIAL", "COMERCIAL"], "300-INDUSTRIAL NORMAL": ["INDUSTRIAL", "INDUSTRIAL"],
    "311-LIGACAO DE OBRA": ["INDUSTRIAL", "INDUSTRIAL"], "206-PEQUENO COMERCIO": ["PEQUENO COMERCIO", "PEQUENO COMERCIO"],
    "400-PUBLICO NORMAL": ["PUBLICO", "400-PUBLICO NORMAL"], "401-PUBLICO FEDERAL": ["PUBLICO", "401-PUBLICO FEDERAL"],
    "402-PUBLICO MUNICIPAL": ["PUBLICO", "402-PUBLICO MUNICIPAL"], "403-PUBLICO ESTADUAL": ["PUBLICO", "403-PUBLICO ESTADUAL"],
    "405-ENT.S/FIM LUCRATIVO": ["PUBLICO", "405-ENT.S/FIM LUCRATIVO"], "100-RESIDENCIAL NORMAL": ["RESIDENCIAL", "100-RESIDENCIAL NORMAL"],
    "104-DECISAO JUDICIAL": ["RESIDENCIAL", "104-DECISAO JUDICIAL"], "501-BAIXA RENDA": ["SOCIAL", "SOCIAL"],
    "601-SOCIAL": ["SOCIAL", "SOCIAL"], "504-SABREN": ["SOCIAL", "SOCIAL"], "205-HOSPITAIS E CLINICAS": ["COMERCIAL", "COMERCIAL"],
    "274-COMERCIO POPULAR": ["COMERCIAL", "COMERCIAL"], "510-BAIRRO LEGAL 28": ["SOCIAL", "SOCIAL"],
    "605-PROJETOS": ["SOCIAL", "SOCIAL"], "607-CAD UNICO": ["RESIDENCIAL", "RESIDENCIAL"],
  };
  const SEM_CLASSIFICACAO = "Sem classificação";
  const SEM_PERFIL = "Sem perfil";
  // Ordem das linhas nas tabelas (o que não estiver aqui vem depois, em ordem alfabética)
  const ORDEM_SUBCATEGORIAS = ["COMERCIAL", "INDUSTRIAL", "PEQUENO COMERCIO", "PUBLICO", "RESIDENCIAL", "SOCIAL"];
  const ORDEM_PERFIS = ["Adimplente", "Inadimplente", "Nunca Pagou"];

  // Tipo Fatura que conta como conta paga
  const TIPOS_CONTA = ["1-NOTA FISCAL MENSAL", "2-NOTA FISCAL AVULSA"];

  // Feriados que não contam como dia útil: nacionais (com Carnaval, Paixão e Corpus Christi, como no BI) e do estado do RJ.
  // FERIADOS_EXTRAS: datas avulsas (AAAA-MM-DD) para acrescentar, ex.: um ponto facultativo.
  const FERIADOS_EXTRAS = [];
  const FIXOS_NACIONAIS = ["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "12-25"];
  const FIXOS_RJ = ["04-23"];                          // São Jorge
  function pascoa(ano) {                               // algoritmo de Meeus/Jones/Butcher
    const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(ano, mes - 1, dia);
  }
  const cacheFeriados = {};
  function feriados(ano) {
    if (cacheFeriados[ano]) return cacheFeriados[ano];
    const iso = (t) => new Date(t).toISOString().slice(0, 10);
    const s = new Set([...FIXOS_NACIONAIS, ...FIXOS_RJ].map((md) => `${ano}-${md}`));
    s.add(`${ano}-11-20`);                            // Consciência Negra (estadual no RJ; nacional desde 2024)
    const p = pascoa(ano), dia = 86400000;
    [-48, -47, -2, 60].forEach((d) => s.add(iso(p + d * dia)));   // Carnaval (seg e ter), Paixão de Cristo, Corpus Christi
    FERIADOS_EXTRAS.filter((d) => d.startsWith(ano + "-")).forEach((d) => s.add(d));
    return (cacheFeriados[ano] = s);
  }

  return { ZONAS, SUPS, SEM_SUP, SUBCATEGORIAS, SEM_CLASSIFICACAO, SEM_PERFIL, ORDEM_SUBCATEGORIAS, ORDEM_PERFIS,
    TIPOS_CONTA, FERIADOS_EXTRAS, feriados };
});
