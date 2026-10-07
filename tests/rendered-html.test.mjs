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
  const [page, punchService, repService, functions, rules] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/services/punches.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/services/rep-p.ts", import.meta.url), "utf8"),
    readFile(new URL("../functions/index.js", import.meta.url), "utf8"),
    readFile(new URL("../firestore.rules", import.meta.url), "utf8"),
  ]);

  assert.match(page, /registerRepPunch\(/);
  assert.doesNotMatch(page, /createPunch\(/);
  assert.doesNotMatch(punchService, /export async function createPunch\s*\(/);
  assert.match(rules, /match \/punches\/\{punchId\}/);
  assert.match(rules, /allow create, update, delete: if false/);
  assert.match(rules, /match \/arpRecords\/\{recordId\}/);
  assert.match(repService, /listOwnRepReceipts/);
  assert.match(repService, /scheduledPunch/);
  assert.match(functions, /export const listOwnRepReceipts/);
  assert.match(functions, /classifyPunchStatus/);
  assert.match(functions, /scheduledPunch/);
  assert.match(page, /Consultar comprovantes das últimas 48 horas/);
  assert.match(page, /Momento e clima/);
  assert.match(page, /border-2 border-\[#d0443e\]/);
  assert.match(page, /getDailyPendingPunch/);
  assert.match(page, /listEmployeePunches\("main", employeeId\)/);
  assert.match(page, /inferNextPunchFromHistory/);
  assert.match(page, /Entrada atrasada/);
  assert.match(page, /Entrada antecipada/);
  assert.match(page, /Saída antecipada/);
});

test("mantem navegacao responsiva para celular e tablet", async () => {
  const [page, css, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /mobileMenuOpen/);
  assert.match(page, /mobile-navigation-panel/);
  assert.match(page, /hidden[^"\n]*lg:block/);
  assert.match(page, /md:grid-cols-\[minmax\(0,1fr\)_300px\]/);
  assert.match(css, /@media \(max-width: 639px\)/);
  assert.match(css, /touch-action:\s*manipulation/);
  assert.match(css, /\.table-scroll/);
  assert.match(css, /touch-action:\s*pan-x pan-y pinch-zoom/);
  assert.match(page, /className="table-scroll/);
  assert.match(page, /className="space-y-3 p-4 lg:hidden"/);
  assert.match(layout, /width:\s*"device-width"/);
  assert.match(css, /prefers-reduced-motion/);
});

test("mantem a sala de ponto isolada e sincroniza perfis faciais do cadastro", async () => {
  const [page, camera, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/FaceCamera.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /kioskMode/);
  assert.match(page, /profileSources=\{faceProfileSources\}/);
  assert.match(page, /kiosk-clock-header/);
  assert.match(page, /onExit=\{\(\) => setActive\("Painel"\)\}/);
  assert.match(page, /!kioskMode/);
  assert.match(camera, /profileSources\?: FaceProfileSource\[\]/);
  assert.match(camera, /loadRemoteProfiles/);
  assert.match(camera, /fetchImage\(source\.photoUrl\)/);
  assert.match(page, /listFaceIdRecords\("main", employee\.employeeId\)/);
  assert.match(page, /faceRecords\.slice\(0, 3\)/);
  assert.match(page, /if \(!photoPaths\.length && employee\.profilePhotoPath\)/);
  assert.match(camera, /referência\(s\) facial/);
  assert.match(page, /Editar foto principal/);
  assert.match(page, /Refazer Face ID/);
  assert.match(page, /Limpar Face ID/);
  assert.match(page, /Desativar colaborador/);
  assert.match(page, /faceIdStatus: "not_registered"/);
  assert.match(page, /active: false/);
  assert.match(page, /A câmera foi encerrada para evitar associação acidental/);
  assert.match(page, /Cadastrar próximo colaborador/);
  assert.match(page, /setSelectedEmployee\(current\)/);
  assert.match(page, /setShowFaceCamera\(false\)/);
  assert.match(page, /replaceProfile=\{replaceFaceProfile\}/);
  assert.doesNotMatch(page, /updateEmployeeProfilePhoto\(current, photoPath/);
  assert.match(camera, /replacementStartedRef/);
  assert.match(camera, /clearLocalFaceProfile/);
  assert.match(css, /\.kiosk-app-shell/);
  assert.match(css, /\.kiosk-clock-card/);
});
