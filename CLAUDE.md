# Regras do repositório

- **Toda atualização muda a versão do site.** Em `index.html`, aumente `VERSAO_SITE` (ex.: `"v1-20261020"` →
  `"v2-AAAAMMDD"`, com a data do dia) e o `?v=` de todos os arquivos `assets/` carregados pela página, para o mesmo valor
  (um teste confere). O selo do cabeçalho vem de `VERSAO_SITE`. A mensagem do commit começa com essa versão (ex.: `v2: ...`).
- Rode `node --test "tests/*.test.js"` antes de enviar.
- Mudou o formato do que `LeituraArquivo.exporta()` devolve, ou a regra dos feriados fixos/móveis em `regras.js`? Aumente
  `CACHE_VERSAO` em `leitor.worker.js`, senão o navegador usa o cache antigo (o dia útil de cada linha fica guardado nele).
  `FERIADOS_EXTRAS` já entra na chave do cache.
- Regras de negócio (cidades, subcategorias, feriados) ficam em `assets/regras.js`.
