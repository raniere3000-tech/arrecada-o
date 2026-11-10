# Regras do repositório

- **Toda atualização muda a versão do site.** Em `index.html`, aumente `VERSAO_SITE` (ex.: `"v1-20261020"` →
  `"v2-AAAAMMDD"`, com a data do dia) e o `?v=` de todos os arquivos `assets/` carregados pela página, para o mesmo valor
  (um teste confere). O selo do cabeçalho vem de `VERSAO_SITE`. A mensagem do commit começa com essa versão (ex.: `v2: ...`).
- Rode `node --test "tests/*.test.js"` antes de enviar.
- Mudou o formato do que `LeituraArquivo.exporta()` devolve, ou a regra dos feriados fixos/móveis em `regras.js`? Aumente
  `CACHE_VERSAO` em `leitor.worker.js`, senão o navegador usa o cache antigo (o dia útil de cada linha fica guardado nele).
  `FERIADOS_EXTRAS` já entra na chave do cache. O faturamento tem cache próprio: mudou `LeituraFaturamento.exporta()`?
  Aumente `CACHE_FATURAMENTO` (a arrecadação não é relida).
- Regras de negócio (cidades, subcategorias, feriados) ficam em `assets/regras.js`.
- Gráficos: desenhe com `grafico(id, (largura) => svg…)` em `painel.js`, que usa a largura real do quadro e redesenha
  quando ela muda (celular, janela, PDF). Não use `viewBox` fixo esticado: o texto ficaria gigante ou ilegível. O gráfico
  nunca passa da largura do quadro (sem rolagem lateral) e mostra o valor de todas as barras/pontos sem sobreposição:
  use `barras(...)` e `svgLinhas(...)`, que escolhem o valor na horizontal, na vertical ou barras deitadas.
- Filtros do cabeçalho (Superintendência, Cidade, Subcategoria) são de vários itens: `E.sups`, `E.cidades`, `E.grupos`
  (lista vazia = todas). Para filtrar use `marcas()`, `okCombo()` ou `okFat()`; `E.sup`/`E.cidade`/`E.grupo` só dão o
  item quando há um só escolhido (servem ao orçado e à curva, que são por superintendência).
- Filtro Mês também é de vários itens (`E.meses`, nunca vazio). `E.mes` é o mais recente marcado e é o que as telas
  de um mês usam (Resumo, One page, orçado, curva…); só a tabela do BI da aba Dados usa todos os de `E.meses`.
- **Duplicidade de descontos** (botão no topo, ao lado de Arrecadação): é o painel de `duplicidades/index.html`, num iframe,
  com regras, filtros, aba Dados e base no navegador próprios. Antes de mexer nele, leia `duplicidades/CLAUDE.md`. A
  arrecadação nunca lê a pasta **Duplicidades** (nem a **One Page**): `analisa()` em `painel.js` separa esses arquivos.
