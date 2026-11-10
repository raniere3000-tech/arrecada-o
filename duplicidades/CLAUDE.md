# Painel de duplicidade de descontos (dentro do painel de Arrecadação)

Contexto para continuar o desenvolvimento no Claude Code. Este arquivo resume tudo o que foi decidido até agora.

**Onde está agora:** este painel veio do repositório `painel-duplicidade-descontos` (desativado) e vive em
`duplicidades/index.html` do painel de Arrecadação. Ele abre pelo botão **Duplicidade de descontos** do topo, num iframe
(isolado: nomes, estilos e base no navegador não se misturam com os da arrecadação). As alterações são feitas aqui.

- **Pasta:** a subpasta **Duplicidades** da pasta principal da arrecadação, com **Descontos** e **Cadastro**. A arrecadação
  não lê nada dessa pasta. O painel de Arrecadação entrega os arquivos ao iframe (`postMessage` `dup-arquivos`) na 1ª vez
  que a área é aberta e a cada ↻ Atualizar; os botões de pasta deste painel ficam escondidos no modo embutido
  (`body.embutido`, script no fim do arquivo). Aberto sozinho, o arquivo continua funcionando como antes.
- **Versão:** toda mudança aqui também muda a versão do painel de Arrecadação (regra do `CLAUDE.md` da raiz); a
  `VERSAO_SITE` daqui (v1.x) é a versão do painel de duplicidades e também sobe a cada mudança dele.
- **Conferência:** `python duplicidades/tests/conferir_totais.py "<pasta>/Duplicidades"`.

## Regras de trabalho

- **Pergunte antes de executar.** Quando houver dúvida sobre regra de negócio, layout ou formato, faça as perguntas necessárias antes de mudar o código. O dono do painel prefere responder perguntas a receber algo diferente do que pediu.
- **Valide os números.** Confira toda mudança de cálculo com `tests/conferir_totais.py`, que recalcula tudo em Python de forma independente.
- **Mantenha um arquivo só.** O painel é um único `index.html`, sem build e sem dependências além das Google Fonts.
- **Escreva em português do Brasil.** Os textos da interface e os comentários do código ficam em português.
- **Mantenha a aba Dados em dia.** Toda mudança de regra atualiza `renderDados()` na mesma versão.
- **Aumente a versão a cada atualização.** A constante `VERSAO_SITE` aparece no cabeçalho.
- **Mesmo padrão visual do painel de economias de esgoto** (repositório economias), que copia o painel de faturamento: cores, fontes, cabeçalho, filtros, faixa de 8 indicadores, gráfico com tabela alinhada, CSV com `;`.

## Objetivo

Identificar descontos registrados mais de uma vez na mesma matrícula. Cada linha do arquivo é um registro de negociação/desconto (um NUM_LOG); o painel mostra o que foi registrado mais de uma vez, mas se refere ao mesmo desconto. Há casos com dezenas de repetições do mesmo desconto, em poucos minutos.

Publicação: junto com o painel de Arrecadação (GitHub Pages do repositório arrecada-o).

## Dados de entrada

Pasta **Duplicidades** (dentro da pasta principal da arrecadação), com as subpastas **Descontos** e **Cadastro**. Ela não vai para o repositório.

- **Descontos:** o painel usa só o .xlsx mais recente (`lastModified`) que tenha as colunas obrigatórias (`OBRIG_DESC`). Um mais recente com outro layout é pulado e listado na aba Dados. O arquivo real (`desconto (23).xlsx`, aba Query1) tem 43.683 linhas, de out/24 a nov/26, da empresa toda.
- **Cadastro:** todos os .xlsx são lidos. `Cadastro_Interior.xlsx` (aba Planilha1, 83.984 matrículas, SUPERINTENDENCIA = LAGOS) e `Cadastro_Leste.xlsx` (aba Query1, 241.541 matrículas, LESTE). 24 colunas, uma linha por matrícula. A superintendência vem da coluna, não do nome do arquivo. **LAGOS = Interior** (pedido do usuário: chamar sempre de Interior).
- **Cruzamento:** CHAVE_LIGACAO do cadastro (`56-100607450`) = `EMP_CODIGO-NUM_LIGACAO` dos descontos. Os prefixos 56 e 57 são da matrícula (57 = "RIO DE JANEIRO - A", no Leste). O worker guarda do cadastro só as matrículas que aparecem nos descontos.
- **Fora das superintendências:** 84% dos lançamentos (36.097, R$ 150,9 mi) são de outras superintendências. Decisão do usuário: continuam lidos, mas ignorados por enquanto; só aparecem na aba Dados (quantidade e o que dariam pelas mesmas regras).
- **Empresa (EMP_CODIGO):** o usuário não sabe o nome dos códigos 3, 56 e 57; fica só no CSV.

## Regras de negócio (definidas com o usuário; v1.2)

1. **Fora da análise:** DESCONTO ou VALOR_TOTAL sem número (no arquivo real vêm como texto "NULL"), sem REFERENCIA, NUM_LIGACAO 0, desconto = 0.
2. **Cada lançamento é contado no máximo uma vez como lançamento a mais.** O agrupamento começa pelo débito (decisão do usuário na v1.2).
3. **Mesmo débito** = NUM_LIGACAO + REFERENCIA + VALOR_TOTAL (ao centavo), com 2+ lançamentos:
   - um só valor de DESCONTO → **nível 1 – descontos repetidos idênticos**;
   - valores de desconto diferentes → **nível 3 – mesmo total, desconto diferente** (o mesmo débito renegociado com outro percentual).
4. **Nível 2 – total diferente:** do que sobrou de cada débito (o válido de um débito com 2+ lançamentos, ou o lançamento único), os que têm o mesmo DESCONTO com VALOR_TOTAL diferente. Um lançamento pode ser o válido do nível 1 ou 3 e lançamento a mais no nível 2 (aparece nas duas linhas e no CSV duas vezes; o valor entra uma vez).
5. **Válido = mais recente** (DAT_ACESSO + DAT_ACESSO_HORA; empate → maior NUM_LOG) nos três níveis. Valor em duplicidade = soma dos DESCONTO dos lançamentos a mais (no nível 3, cada um com o seu valor). O nível 3 soma no valor em duplicidade (decisão do usuário).
6. **Alerta entre meses** (separado, não soma): mesma matrícula + mesmo DESCONTO em 2+ referências, sem olhar o total.
7. **A verificar:** matrícula + referência que, depois de tirar os lançamentos a mais, ainda tem 2+ valores de desconto (com totais diferentes), como um desconto por fatura. Não é duplicidade; só se confirma entrando na matrícula. A lista mostra todos os lançamentos do mês.
8. **Filtros** (todos com seleção múltipla): Superintendência, Cidade (lista depende das superintendências marcadas), Zona, Usuário, Mês de referência. Local pela matrícula; mês pela referência; usuário: o desconto repetido entra inteiro se tiver algum lançamento do usuário.
10. **Nível 4 – verificado manualmente (v1.3):** nos casos de Alerta e A verificar, os botões **Duplicidade** / **Válido** (clicar de novo desfaz). Duplicidade: o mais recente do caso é o válido; os demais são lançamentos a mais, menos os que já são a mais nos níveis 1–3 ou num caso anterior (cada lançamento conta uma vez); soma no valor em duplicidade. Válido: sai dos pendentes. Chaves: `al|matrícula|desconto em centavos` e `ver|matrícula|AAAA-MM`. Gravadas em `duplicidades` do `ajustes_arrecadacao.json` da pasta principal (o painel de Arrecadação grava: mensagens `dup-marca` e `dup-marcas`); aberto sozinho, no localStorage. O `conferir_totais.py` confere só os níveis 1 a 3.
11. **Resultado (v1.3, 1ª aba, a que abre):** valor recuperado = valor em duplicidade dos níveis 1 a 4; por superintendência, por nível, por mês de referência (nível 4: cada lançamento a mais no seu mês) e a verificação manual (casos marcados e pendentes). A antiga aba Resumo passou a se chamar **Diagnóstico**. (v1.4) A tabela por superintendência tem uma seta em cada uma que abre as cidades; com uma superintendência só no filtro, o cartão vira "Valor recuperado — <superintendência>" (sem os cartões por superintendência) e a tabela passa a ser "Por cidade", já aberta.
9. **Por usuário:** lançamentos a mais e valor ficam com quem fez o lançamento a mais (pela posição no desconto repetido, não pela marcação global).

## Vocabulário da interface (v1.1, pedido do usuário)

- **"Grupo" não aparece na tela:** o usuário achou vago. Cada grupo de duplicidade é um **desconto repetido** (o mesmo valor de desconto lançado mais de uma vez na mesma matrícula e mês).
- Os lançamentos que sobram (todos menos o válido) são **lançamentos a mais**; não usar "repetições".
- Indicadores (9, em duas linhas: 4 + 5): "Lançamentos com desconto analisados", "Matrículas com desconto em duplicidade", "Lançamentos a mais" (em N descontos repetidos), "Valor registrado em duplicidade"; "Nível 1 – descontos repetidos idênticos", "Nível 2 – descontos repetidos com total diferente" (linha de baixo: "lançados N vezes a mais"), "Nível 3 – mesmo total, desconto diferente", "Alerta: mesmo desconto em meses diferentes", "Matrículas a verificar".
- Tabela: "Vezes lançado", "Lançamentos a mais", "Valor em duplicidade (R$)"; situação "Válido (mais recente)" ou "Lançamento a mais".
- CSV: `ID_DESCONTO_REPETIDO, NIVEL, SITUACAO (VALIDO / LANCAMENTO_A_MAIS), ORDEM_DO_LANCAMENTO, VEZES_LANCADO, VALOR_EM_DUPLICIDADE`; alerta `ID_ALERTA`, a verificar `ID_CASO`.
- No código, os nomes internos continuam (`dups`, `g.rep`, `recRep`, `recG`).

## Arquitetura (index.html)

- **Worker inline** (`<script type="text/plain" id="worker-src">`): leitor de .xlsx próprio, copiado do painel de economias (zip com zip64, `DecompressionStream`, XML em fluxo por `</row>`). `lerDescontos()` devolve typed arrays por lançamento (`emp, mat, zona, ref, dt, log, ano, usr, vav, desc, tot, pct, ok`); `dt` em ms com o horário "de parede" (UTC, sem fuso). `lerCadastro()` devolve `keys, nomes, sup, cid` só das matrículas com desconto.
- **Página:** `separa()` divide os arquivos pelas subpastas; `derive()` calcula uma vez os grupos sobre a base inteira (`dups`, `al`, `ver`, `recRep`, `recG`); os filtros só selecionam grupos (`okDup`, `okAl`, `okVer`, `okRec`). `calcula()` monta o Resumo.
- **Armazenamento:** IndexedDB `painel-duplicidade-descontos`, store `dados`, chaves `atual` (resultado do worker, `formato: 1`) e `pasta` (handle da File System Access API). Sem `showDirectoryPicker` (Firefox/Safari), usa `<input webkitdirectory>`.

## Layout

- **Resumo:** 9 indicadores em duas linhas (4 de visão geral + nível 1, nível 2, nível 3, alerta, a verificar); gráfico por mês de referência com nível 1 (marinho `#102840`), nível 2 (azul `#176b9c`) e nível 3 (azul-claro `#9cc3dc`, texto marinho) empilhados, seletor Lançamentos / Matrículas / Valor, valores exatos em cima, tabela alinhada embaixo com a coluna de rótulos fixa e rolagem que abre nos meses mais recentes; tabela por usuário (pedido do usuário), ordenável, com o número de repetições levando para a lista filtrada.
- **Duplicidades:** seletor Duplicidades / Alerta entre meses / A verificar; busca, nível, ordenação; uma linha por grupo, que abre os lançamentos; 100 por página; CSV com uma linha por lançamento.
- **Dados:** arquivos lidos, lançamentos considerados e as regras numeradas.

## Valores de referência (arquivos reais de 09/11/2026, regra da v1.2)

Base: 6.932 lançamentos, R$ 16.071.966,08, 5.304 matrículas. 500 matrículas com duplicidade; 766 lançamentos a mais em 549 descontos repetidos; R$ 2.715.591,31. Nível 1: 302 descontos repetidos, 433 lançamentos a mais, R$ 1.748.203,83. Nível 2: 84, 85, R$ 181.871,16. Nível 3: 163, 248, R$ 785.516,32. Alerta: 47 descontos, 46 matrículas. A verificar: 335 matrículas, 341 casos. Interior: 139 matrículas, 155 descontos repetidos (82 + 26 + 47), 235 lançamentos a mais, R$ 748.708,94, alerta 10, a verificar 93. Exemplos conferidos: matrícula 103447593 (out/26) = nível 3, 14 lançamentos, 13 a mais, R$ 37.304,22; 101774763 (ago/26) = 3 a mais.

## Como validar uma mudança

```bash
python duplicidades/tests/conferir_totais.py "<pasta principal>/Duplicidades"
python duplicidades/tests/conferir_totais.py "<pasta principal>/Duplicidades" --sup Interior
# abra o painel, clique em Duplicidade de descontos e compare com o Resumo
```

Nunca suba arquivos `.xlsx` ou `.csv` para o repositório: os dados têm nomes de clientes.
