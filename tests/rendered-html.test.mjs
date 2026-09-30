import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renderiza a aplicacao Orquestracs Face ID", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="pt-BR">/i);
  assert.match(html, /<title>Orquestracs Face ID<\/title>/i);
  assert.match(html, /Orquestracs Face ID/i);
  assert.match(html, /Batidas/i);
  assert.match(html, /LGPD e auditoria/i);
});

test("mantem batidas originais no fluxo protegido do servidor", async () => {
  const [page, punchService, rules] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/services/punches.ts", import.meta.url), "utf8"),
    readFile(new URL("../firestore.rules", import.meta.url), "utf8"),
  ]);

  assert.match(page, /registerRepPunch\(/);
  assert.doesNotMatch(page, /createPunch\(/);
  assert.doesNotMatch(punchService, /export async function createPunch\s*\(/);
  assert.match(rules, /match \/punches\/\{punchId\}/);
  assert.match(rules, /allow create, update, delete: if false/);
  assert.match(rules, /match \/arpRecords\/\{recordId\}/);
});
