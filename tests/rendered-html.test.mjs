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
  const [page, punchService, repService, functions, rules, credits, tenantAccess] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/services/punches.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/services/rep-p.ts", import.meta.url), "utf8"),
    readFile(new URL("../functions/index.js", import.meta.url), "utf8"),
    readFile(new URL("../firestore.rules", import.meta.url), "utf8"),
    readFile(new URL("../lib/services/ai-credits.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/services/tenant-access.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /registerRepPunch\(/);
  assert.doesNotMatch(page, /createPunch\(/);
  assert.match(page, /const TenantIdContext = createContext\(""\)/);
  assert.match(page, /async function refreshCompanyProfile\(companyId: string\)/);
  assert.doesNotMatch(page, /refreshCompanyProfile\(\);/);
  assert.doesNotMatch(page, /resolveNextPunch\(employeeId: string, companyId = "main"\)/);
  assert.match(page, /isPlatformOwnerEmail\(user\.email\) \? "main" : ""/);
  assert.doesNotMatch(credits, /consumeAiCredit\(tenantId = "main"/);
  assert.doesNotMatch(tenantAccess, /(?:listTenantInvites|getTenantSaasConfig|saveTenantSaasConfig)\([^)]*tenantId = DEFAULT_TENANT_ID/);
  assert.match(tenantAccess, /export async function getUserTenantAccesses\(user: User\)/);
  assert.match(page, /getUserTenantAccesses\(currentUser\)/);
  assert.match(page, /orquestracs-active-tenant/);
  assert.doesNotMatch(punchService, /export async function createPunch\s*\(/);
  assert.match(rules, /match \/punches\/\{punchId\}/);
  assert.match(rules, /allow create, update, delete: if false/);
  assert.match(rules, /match \/arpRecords\/\{recordId\}/);
  assert.match(repService, /listOwnRepReceipts/);
  assert.match(repService, /scheduledPunch/);
  assert.match(functions, /export const listOwnRepReceipts/);
  assert.match(functions, /classifyPunchStatus/);
  assert.match(functions, /bank_hours/);
  assert.match(functions, /scheduledPunch/);
  assert.match(functions, /idempotencyKey/);
  assert.match(functions, /export const createPunchAdjustment/);
  assert.match(functions, /export const reviewPunchAdjustment/);
  assert.match(functions, /export const createAttendanceJustification/);
  assert.match(functions, /export const reviewAttendanceJustification/);
  assert.match(functions, /export const registerFaceIdCapture/);
  assert.match(functions, /export const auditEmployeeWrite/);
  assert.match(rules, /match \/auditLogs\/\{logId\}/);
  assert.match(rules, /match \/repIdempotency\/\{requestId\}/);
  assert.match(page, /Consultar comprovantes das últimas 48 horas/);
  assert.match(page, /Momento e clima/);
  assert.match(page, /dashboard-punch-time/);
  assert.match(page, /getDailyPendingPunch/);
  assert.match(page, /listEmployeePunches\(companyId, employeeId\)/);
  assert.match(page, /inferNextPunchFromHistory/);
  assert.match(page, /Entrada atrasada/);
  assert.match(page, /Entrada antecipada/);
  assert.match(page, /Saída antecipada/);
  assert.match(page, /Banco de horas/);
  assert.match(page, /scheduledPunchOrder: ScheduledPunch\[\] = Array\.from\(\{ length: 4 \}/);
  assert.match(page, /const activePeriodIndex = periods\.findIndex/);
  assert.match(page, /currentMinutes >= start && currentMinutes < nextStart/);
  assert.match(page, /const dashboardStages = scheduledPunchOrder\.slice/);
  assert.match(page, /Ativar banco de horas para esta empresa/);
  assert.doesNotMatch(page, /Defina entrada, saida almoco, volta almoco e fim do dia/);
  assert.match(functions, /employee\.workPolicy = company\.workPolicy \|\| \{\}/);
  assert.match(functions, /bankHoursEnabled && stage\?\.\[1\] === "Saída"/);
  assert.match(page, /differenceMinutes > schedule\.toleranceMinutes/);
});

test("mantem a Central Admin protegida e operacional", async () => {
  const [page, central, rules, functions, tenantAccess] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/AdminCentral.tsx", import.meta.url), "utf8"),
    readFile(new URL("../firestore.rules", import.meta.url), "utf8"),
    readFile(new URL("../functions/index.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/services/tenant-access.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /centralAdminMode/);
  assert.match(page, /AdminCentral/);
  assert.match(central, /Admin Orquestra\.cs/);
  assert.match(central, /Detalhes operacionais/);
  assert.match(central, /Salvar alterações/);
  assert.match(central, /Adicionar créditos/);
  assert.match(central, /draggable/);
  assert.match(central, /Clientes inativos/);
  assert.match(page, /Comprar créditos no Portal/);
  assert.match(page, /NEXT_PUBLIC_ORQUESTRA_PORTAL_PAYMENTS_URL/);
  assert.match(rules, /isPlatformOwner\(\)/);
  assert.match(rules, /"aiCredits"/);
  assert.match(functions, /export const adjustAiCredits/);
  assert.match(functions, /export const consumeAiCredit/);
  assert.match(functions, /aiCreditAdjustments/);
  assert.match(tenantAccess, /email\?: string/);
  assert.match(tenantAccess, /invite-email-mismatch/);
  assert.match(page, /Gerar termo do colaborador/);
  assert.match(page, /Termo de informação e manifestação sobre biometria facial/);
  assert.match(page, /Convite criado para \$\{email\}/);
  assert.match(page, /Copiar link/);
  assert.match(rules, /request\.resource\.data\.role != "owner" \|\| isTenantOwner/);
  assert.match(rules, /request\.auth\.token\.email == get\(/);
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
  assert.match(page, /dashboard-mobile-list/);
  assert.match(page, /dashboard-panel/);
  assert.match(page, /DashboardMetricCard/);
  assert.match(layout, /width:\s*"device-width"/);
  assert.match(css, /prefers-reduced-motion/);
});

test("mantem a sala de ponto isolada e sincroniza perfis faciais do cadastro", async () => {
  const [page, camera, css, faceConfig] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/FaceCamera.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/face-id/config.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /kioskMode/);
  assert.match(page, /profileSources=\{faceProfileSources\}/);
  assert.match(page, /autoRecognize/);
  assert.match(page, /autoStart/);
  assert.match(page, /recognitionPaused=\{Boolean\(recognizedEmployee \|\| confirmation \|\| sequenceLoading\)\}/);
  assert.match(page, /speakPunchConfirmation/);
  assert.match(page, /voiceschanged/);
  assert.match(page, /speakWithAvailableVoice/);
  assert.match(page, /Aguardando o próximo funcionário/);
  assert.match(page, /kiosk-clock-header/);
  assert.match(page, /onExit=\{handleKioskExit\}/);
  assert.match(page, /reauthenticateWithCredential/);
  assert.match(page, /reauthenticateWithPopup/);
  assert.match(page, /auth\/unauthorized-domain/);
  assert.match(page, /auth\/popup-blocked/);
  assert.match(page, /A senha não confere com a conta responsável conectada/);
  assert.match(page, /Sair da sala de ponto/);
  assert.match(page, /!kioskMode/);
  assert.match(camera, /profileSources\?: FaceProfileSource\[\]/);
  assert.match(camera, /autoRecognize\?: boolean/);
  assert.match(camera, /autoStart\?: boolean/);
  assert.match(camera, /recognitionPaused\?: boolean/);
  assert.match(camera, /lastRecognitionDescriptorRef/);
  assert.match(camera, /loadRemoteProfiles/);
  assert.match(camera, /fetchImage\(source\.photoUrl\)/);
  assert.match(camera, /profileSources\.slice\(index, index \+ 4\)\.map/);
  assert.match(camera, /remoteProfilesPromiseRef/);
  assert.match(camera, /Reconhecimento ativo\. Aguardando um rosto em frente à câmera/);
  assert.match(camera, /Rosto detectado, mas não reconhecido/);
  assert.match(camera, /Nenhum perfil facial sincronizado/);
  assert.match(camera, /Falha ao carregar ou comparar os perfis faciais/);
  assert.match(camera, /onProfileUpdated\?\.\(descriptors\.length, await captureFrame\(\)\)/);
  assert.match(camera, /não foi sincronizada com o sistema/);
  assert.match(faceConfig, /FACE_ID_REQUIRED_CAPTURES = 3/);
  assert.match(camera, /slice\(-FACE_ID_REQUIRED_CAPTURES\)/);
  assert.match(page, /FACE_ID_REQUIRED_CAPTURES/);
  assert.match(page, /documentId: String\(employee\.documentId \|\| fallbackId\)/);
  assert.match(page, /if \(employee\.documentId\) return employee\.documentId/);
  assert.match(page, /employeeId: selectedEmployee\?\.employeeId \|\| crypto\.randomUUID\(\)/);
  assert.match(page, /listFaceIdSources\(companyId\)/);
  assert.match(page, /employee\.photoPaths\.slice\(0, 3\)/);
  assert.match(page, /getStorageFileUrl\(photoPath\)/);
  assert.match(camera, /O cadastro aparece como ativo, mas não há fotos faciais vinculadas/);
  assert.match(camera, /Não foi possível baixar as fotos faciais neste aparelho/);
  assert.match(camera, /As fotos chegaram, mas não foi possível identificar rostos nelas/);
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
  assert.match(page, /biometricConsentAccepted/);
  assert.match(page, /captura .*sincronizada no Firebase/);
  assert.match(page, /A captura foi feita neste aparelho, mas não foi salva no Firebase/);
  assert.match(camera, /registrationAllowed\?: boolean/);
  assert.doesNotMatch(page, /updateEmployeeProfilePhoto\(current, photoPath/);
  assert.match(camera, /replacementStartedRef/);
  assert.match(camera, /clearLocalFaceProfile/);
  assert.match(css, /\.kiosk-app-shell/);
  assert.match(css, /\.kiosk-clock-card/);
});
