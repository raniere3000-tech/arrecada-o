# Arrecadação Diária

Painel da arrecadação diária nos moldes do painel de faturamento: abre no navegador (GitHub Pages), lê a pasta da
arrecadação no próprio computador e reproduz o relatório do Power BI **Diário Arrecadação V4**. Nenhum arquivo é enviado
para a internet: tudo é processado no navegador.

## Navegação

- **Executivo** (acompanhamento e resultado): Resumo, Subcategoria, Perfil de pagamento, Cidades, Escada e Base (extração das linhas
  completas por matrículas ou a base completa dos meses marcados, a base de cobrança: pagaram num mês e não pagaram em outro;
  e o comparativo por mês: uma linha por matrícula e uma coluna de valor por mês; as duas podem trazer endereço,
  grupo, rota e situação da ligação do faturamento mais recente da pasta).
- **Análises** (cruzamentos e oportunidades): Faturamento x Arrecadação; Fat. x Arrec. — mesmo vencimento; Conversão por
  referência (matriz por coorte: quanto de cada referência foi recebido em M, M+1, ...); Diagnóstico por localidade (comparação
  por cidade/subcategoria/superintendência nos mesmos dias úteis, quedas, altas, Pareto e projeção de fechamento pelos meses com
  os mesmos dias úteis ou pela curva do orçado); Ranking de clientes (top 100 maiores, aumentos e quedas por cliente) e Clientes
  e oportunidades (contas a receber: saldo vencido e a vencer por faixa, situação, contato e cidade, maiores devedores e quem pagou;
  faturado sem pagamento a investigar, deixaram e voltaram a pagar, histórico de uma matrícula; com a base de
  contas a receber na pasta, o “a investigar” é conferido por matrícula). O PDF é só do Executivo.
- **Dados**: área à parte com as regras e a conferência dos números.

## Como usar

1. Abra o site e clique em **📁 Conectar pasta**. Escolha a pasta da arrecadação; as subpastas também são lidas.
2. No Chrome e no Edge a pasta fica lembrada: nas próximas visitas basta clicar em qualquer lugar da página.
   **↻ Atualizar** relê a pasta depois que o arquivo do dia for trocado.
3. Use os filtros do cabeçalho (Superintendência, Cidade, Subcategoria, Mês) e os botões de **dias úteis**.
4. **Painel / Power BI** troca o visual. **📄 PDF** gera o executivo com as 5 abas no visual escolhido (sem a aba Dados).
5. A aba **Análise** traz os top clientes (até 100): maiores arrecadações, aumentos e quedas em relação ao mês anterior,
   com download em CSV. A aba **Base** extrai as linhas completas dos CSVs para uma lista de matrículas e meses.
   A aba **Dados** explica todos os cálculos. Essas abas não entram no PDF.

Os CSVs já lidos ficam guardados no navegador: na atualização do dia, só o arquivo diário é lido de novo.

## Arquivos da pasta

| Arquivo | Como é reconhecido | Uso |
|---|---|---|
| Arrecadação diária (`Acomp. de Arrecadação R1.csv`, R4…) | CSV com Nº Ligação, Data Crédito e Val. Autenticado, numa pasta com "Diária" no caminho | Mês atual. Substitui o anterior a cada dia |
| Arrecadação acumulada | o mesmo CSV em qualquer outra pasta (um por mês) | Meses anteriores. O mês que está no diário é lido só do diário |
| `Base_Desconto - 25.05.xlsx` | colunas NUM_LIGACAO, REFERENCIA e DESCONTO | Desconto comercial |
| `Cluster_Cliente_Lagos - 08.08.xlsx` | colunas NUM_LIGACAO, SEQ_RESPONSAVEL e CLUSTER SALDO | Perfil de pagamento |
| Orçados (RF01T26, RF02T26, RF3T25…) | colunas Sup, Rubrica e um mês por coluna (`jan/26` ou `Soma de 01/10/2025`), com a linha da arrecadação: `(+) Arrecadação`, `05.01. Arrecadação` ou `ARRECADAÇÃO CRÉDITO` | Orçado mensal; o seletor **Orçado** do cabeçalho escolhe a planilha |
| Faturamento (`Fatura de ciclo MM-AAAA.csv`) | CSV com N. da Ligacao, Rubrica, Valor Parcela, Referencia de Leitura e Data de Vencimento (sugestão: subpasta `Faturamento`) | Área **Análises**: faturamento × arrecadação (só Interior) |
| `ajustes_arrecadacao.json` | gravado pelo painel | Orçado digitado e curva do orçado diário editada (vale para todos que usam a pasta) |

Outras planilhas (Cadastro, Faturões…) são listadas em "Arquivos lidos e avisos" como não usadas.

## Regras (as mesmas do BI)

- **Arrecadação** = soma do Val. Autenticado pela **Data Crédito**. O **desconto comercial** (planilha de desconto, mês da
  REFERENCIA) é abatido das ligações que pagaram no mês. Na tabela Orçado × Realizado ele entra só no total, numa linha própria.
- **Contas pagas**: Tipo Fatura `1-NOTA FISCAL MENSAL` ou `2-NOTA FISCAL AVULSA`. **Clientes pagantes**: matrículas distintas.
  **Ticket médio** = arrecadação ÷ contas pagas.
- **Dia útil**: sem fins de semana e feriados nacionais e do RJ (`assets/regras.js`). Todos os meses são comparados até o mesmo
  nº de dia útil. O botão **0** inclui os créditos de fins de semana e feriados (no BI ele fica desmarcado).
- **Orçado mensal**: linha da arrecadação do RF escolhido em **Orçado** (padrão: o RF mais novo que tem o mês), pela Sup
  (LAGOS = Interior). Também dá para digitar o valor no Resumo ("Digitado no painel").
- **Orçado diário**: curva média da participação de cada dia útil (1 a 23) no total arrecadado do mês escolhido em
  "Média a partir de" (padrão: janeiro do ano) até o mês anterior (em janeiro, os 12 meses anteriores). Num mês com menos dias úteis, a parte dos dias que sobram é dividida igualmente entre os
  dias do mês; o 0 (fins de semana e feriados) também sai da média. A curva pode ser editada em **Resumo › Orçado do mês e curva**.
- **Superintendência** pela cidade (Zona): cidades "Lagos" do BI = **Interior**, "R4" = **Leste** (`assets/regras.js`).
- **Subcategoria** e o detalhe do Público pela tabela do BI (47 códigos); código fora da tabela aparece em "Sem classificação".

### Diferenças em relação ao BI

- Feriados: o painel considera **São Jorge (23/04)** e **Consciência Negra (20/11)** em todos os anos; o BI só os tinha em 2025.
  Em abril e novembro de 2026 a numeração dos dias úteis muda a partir dessas datas.
- No BI o desconto do mês fica ligado ao dia 1º; quando o dia 1º cai em fim de semana ou feriado e o filtro de dias úteis não
  inclui o 0, o desconto daquele mês some. No painel o desconto do mês entra sempre.
- Escada: o desconto comercial aparece numa linha própria (no BI ele se espalha pelos meses de vencimento das ligações).

## Estrutura

- `index.html`: página. `assets/painel.css` (os dois visuais) e `assets/painel.js` (filtros, abas, curva, PDF).
- `leitor.worker.js`: lê os arquivos fora da página (CSV em partes; planilhas com SheetJS) e guarda o cache.
- `assets/calculos.js`: calendário de dias úteis, agregação e as tabelas (roda no navegador e nos testes).
- `assets/regras.js`: cidades, superintendências, subcategorias e feriados.
- `lib/`: SheetJS (leitura de Excel), html2canvas e jsPDF (PDF).

## Testes

```bash
node --test "tests/*.test.js"
```

Rodam também no GitHub Actions a cada envio.
