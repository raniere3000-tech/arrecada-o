// Conferências do site: versão única em todos os arquivos carregados e scripts sem erro de sintaxe.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const raiz = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(raiz, "index.html"), "utf8");

test("a versão do site é a mesma no VERSAO_SITE e em todos os ?v= da página", () => {
  const versao = /const VERSAO_SITE = "([^"]+)"/.exec(html)[1];
  assert.match(versao, /^v\d+-\d{8}$/);
  const vs = [...html.matchAll(/\?v=([^"]+)"/g)].map((m) => m[1]);
  assert.ok(vs.length >= 4);
  vs.forEach((v) => assert.equal(v, versao));
});

test("os scripts do site não têm erro de sintaxe", () => {
  for (const f of ["leitor.worker.js", "assets/painel.js", "assets/calculos.js", "assets/regras.js"]) {
    execFileSync(process.execPath, ["--check", path.join(raiz, f)]);
  }
});

test("os arquivos que a página e o worker carregam existem", () => {
  const worker = fs.readFileSync(path.join(raiz, "leitor.worker.js"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="((?:assets|lib)\/[^"?]+)/g), ...worker.matchAll(/"((?:assets|lib)\/[^"]+\.js)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 6);
  refs.forEach((r) => assert.ok(fs.existsSync(path.join(raiz, r)), r));
});
