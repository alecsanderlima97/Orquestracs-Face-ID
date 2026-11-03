// Testa as Cloud Functions reais (registerRepPunch e verifyEmployeePin) contra os emuladores locais.
// Execução: PIN_PEPPER=<valor-de-teste> firebase emulators:exec --only firestore,functions --project demo-orquestracs-face-id "node tests/punch-flow-emulator.test.mjs"
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { dayKeyFor } from "../functions/punch-guard.js";

const projectId = "demo-orquestracs-face-id";
const pepper = process.env.PIN_PEPPER;
if (!pepper) throw new Error("Defina PIN_PEPPER para o teste (valor apenas de desenvolvimento).");
const firestoreRules = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");
const testEnv = await initializeTestEnvironment({ firestore: { rules: firestoreRules }, projectId });

const endpoint = (name) => `http://127.0.0.1:5001/${projectId}/us-east1/${name}`;
// Token sem assinatura aceito pelo emulador. O e-mail da plataforma passa por requireManager.
const token = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "owner-a", user_id: "owner-a", email: "orquestracs@gmail.com" })).toString("base64url"),
  "",
].join(".");

async function call(name, data) {
  const response = await fetch(endpoint(name), {
    body: JSON.stringify({ data }),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await response.json();
  return { ok: response.ok, body };
}

const companyId = "tenant-a";
const employeeId = "employee-a";
const validPhoto = `companies/${companyId}/employees/${employeeId}/punches/2026-11-03/p1.webp`;
const digest = (pin) => crypto.createHmac("sha256", pepper).update(`${companyId}:${pin}`, "utf8").digest("hex");

function punchPayload(overrides = {}) {
  return {
    companyId,
    deviceId: "device-test-1",
    employeeId,
    idempotencyKey: `${companyId}:${employeeId}:intent-1`,
    location: { status: "unavailable" },
    origin: "kiosk",
    photoPath: validPhoto,
    scheduledPunch: "Entrada 1",
    source: "face_id",
    type: "entry",
    ...overrides,
  };
}

try {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, `companies/${companyId}`), {
      cnpj: "12345678000195",
      legalName: "Empresa A",
      repP: { mode: "pilot" },
      inpiRegistration: "",
    });
    await setDoc(doc(db, `companies/${companyId}/employees/${employeeId}`), {
      active: true,
      cpf: "12345678909",
      employeeId,
      name: "Colaborador A",
      pinConfigured: true,
      schedule: { end: "17:15", periods: [{ start: "07:00", end: "11:30" }, { start: "13:00", end: "17:15" }], start: "07:00" },
    });
    await setDoc(doc(db, `companies/${companyId}/employeePins/${employeeId}`), {
      employeeId,
      pinHash: digest("4321"),
    });
  });

  // 1) Batida valida com evidencia correta e registrada.
  const first = await call("registerRepPunch", punchPayload());
  if (!first.ok || !first.body.result?.receipt) throw new Error(`Batida valida falhou: ${JSON.stringify(first.body)}`);
  console.log("ok: batida valida registrada, NSR", first.body.result.receipt.nsr);

  // 2) Mesma intencao (mesma chave) reenviada: devolve o resultado original, sem duplicar.
  const replay = await call("registerRepPunch", punchPayload());
  if (!replay.ok || replay.body.result?.receipt?.nsr !== first.body.result.receipt.nsr) {
    throw new Error(`Reenvio com a mesma chave deveria reaproveitar o registro: ${JSON.stringify(replay.body)}`);
  }
  console.log("ok: reenvio com a mesma chave nao duplica");

  // 3) Nova intencao logo depois: bloqueada pelo intervalo minimo no servidor.
  const tooSoon = await call("registerRepPunch", punchPayload({
    idempotencyKey: `${companyId}:${employeeId}:intent-2`,
    scheduledPunch: "Saída 1",
    type: "exit",
  }));
  if (tooSoon.ok || !/Aguarde/.test(JSON.stringify(tooSoon.body))) {
    throw new Error(`Intervalo minimo nao foi aplicado no servidor: ${JSON.stringify(tooSoon.body)}`);
  }
  console.log("ok: intervalo minimo aplicado no servidor");

  // 4) Evidencia de outro colaborador ou ausente: marcacao recusada.
  const badPhoto = await call("registerRepPunch", punchPayload({
    idempotencyKey: `${companyId}:${employeeId}:intent-3`,
    photoPath: "pending-storage-photo",
  }));
  if (badPhoto.ok || !/Evidencia/.test(JSON.stringify(badPhoto.body))) {
    throw new Error(`Batida sem evidencia valida deveria ser recusada: ${JSON.stringify(badPhoto.body)}`);
  }
  console.log("ok: batida sem evidencia valida recusada");

  // 5) Mesma etapa ja registrada hoje, com cooldown vencido: somente a regra de etapa duplicada pode bloquear.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `companies/${companyId}/punchGuard/${employeeId}`), {
      dayKey: dayKeyFor(new Date()),
      doneToday: ["Entrada 1"],
      lastOccurredAtMs: Date.now() - 3 * 60 * 60 * 1000,
    });
  });
  const duplicateStage = await call("registerRepPunch", punchPayload({
    idempotencyKey: `${companyId}:${employeeId}:intent-4`,
    scheduledPunch: "Entrada 1",
  }));
  if (duplicateStage.ok || !/já foi registrada hoje/.test(JSON.stringify(duplicateStage.body))) {
    throw new Error(`Etapa duplicada no mesmo dia deveria ser bloqueada: ${JSON.stringify(duplicateStage.body)}`);
  }
  console.log("ok: etapa duplicada no mesmo dia bloqueada pelo servidor");

  // 6a) Gravacao do PIN pelo servidor: hash vai para employeePins e sai do cadastro do colaborador.
  const setPin = await call("setEmployeePin", { companyId, employeeId, pin: "2468" });
  if (!setPin.ok || setPin.body?.result?.pinConfigured !== true) {
    throw new Error(`setEmployeePin deveria gravar o PIN: ${JSON.stringify(setPin.body)}`);
  }
  const acceptedPin = await call("verifyEmployeePin", { companyId, pin: "2468" });
  if (!acceptedPin.ok || acceptedPin.body?.result?.employeeId !== employeeId) {
    throw new Error(`PIN recem-gravado deveria ser aceito: ${JSON.stringify(acceptedPin.body)}`);
  }
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const snapshot = await getDoc(doc(context.firestore(), `companies/${companyId}/employees/${employeeId}`));
    const data = snapshot.data() || {};
    if ("pinHash" in data || "pinUpdatedAt" in data || "pin" in data || data.pinConfigured !== true) {
      throw new Error("Cadastro do colaborador nao deveria conter hash do PIN");
    }
  });
  console.log("ok: PIN gravado no servidor e ausente do cadastro do colaborador");

  // 6) PIN: cinco falhas seguidas bloqueiam novas tentativas.
  for (let index = 0; index < 5; index += 1) {
    const wrong = await call("verifyEmployeePin", { companyId, pin: "9999" });
    if (wrong.ok) throw new Error("PIN errado nao deveria ser aceito");
  }
  const locked = await call("verifyEmployeePin", { companyId, pin: "4321" });
  if (locked.ok || !/Muitas tentativas/.test(JSON.stringify(locked.body))) {
    throw new Error(`PIN deveria estar bloqueado apos 5 falhas: ${JSON.stringify(locked.body)}`);
  }
  console.log("ok: PIN bloqueado apos 5 falhas (mesmo com PIN correto)");
} finally {
  await testEnv.cleanup();
}

console.log("Punch flow emulator checks: OK");
