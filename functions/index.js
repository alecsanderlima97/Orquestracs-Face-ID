import crypto from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";

initializeApp();

const db = getFirestore();
const pinPepper = defineSecret("PIN_PEPPER");
const callableOptions = { region: "us-east1", secrets: [pinPepper] };

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validatePin(value) {
  const pin = normalizedText(value);
  if (!/^\d{4,6}$/.test(pin)) {
    throw new HttpsError("invalid-argument", "O PIN deve conter de 4 a 6 numeros.");
  }
  return pin;
}

function pinDigest(companyId, pin) {
  return crypto
    .createHmac("sha256", pinPepper.value())
    .update(`${companyId}:${pin}`, "utf8")
    .digest("hex");
}

async function requireManager(request, companyId) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre no sistema para continuar.");

  const email = normalizedText(request.auth.token.email).toLowerCase();
  if (email === "orquestracs@gmail.com") return;

  const membership = await db.doc(`tenants/${companyId}/users/${request.auth.uid}`).get();
  const role = membership.data()?.role;
  if (!membership.exists || !["owner", "admin"].includes(role)) {
    throw new HttpsError("permission-denied", "Seu perfil nao pode administrar PINs.");
  }
}

export const setEmployeePin = onCall(callableOptions, async (request) => {
  const companyId = normalizedText(request.data?.companyId);
  const employeeId = normalizedText(request.data?.employeeId);
  const pin = validatePin(request.data?.pin);
  if (!companyId || !employeeId) {
    throw new HttpsError("invalid-argument", "Empresa e colaborador sao obrigatorios.");
  }

  await requireManager(request, companyId);
  const employeeRef = db.doc(`companies/${companyId}/employees/${employeeId}`);
  const employee = await employeeRef.get();
  if (!employee.exists) throw new HttpsError("not-found", "Colaborador nao encontrado.");

  const digest = pinDigest(companyId, pin);
  const duplicate = await db
    .collection(`companies/${companyId}/employees`)
    .where("pinHash", "==", digest)
    .limit(2)
    .get();
  if (duplicate.docs.some((item) => item.id !== employeeId)) {
    throw new HttpsError("already-exists", "Este PIN ja pertence a outro colaborador.");
  }

  await employeeRef.update({
    pin: FieldValue.delete(),
    pinHash: digest,
    pinUpdatedAt: FieldValue.serverTimestamp(),
  });

  return { employeeId, pinConfigured: true };
});

export const verifyEmployeePin = onCall(callableOptions, async (request) => {
  const companyId = normalizedText(request.data?.companyId);
  const pin = validatePin(request.data?.pin);
  if (!companyId) throw new HttpsError("invalid-argument", "Empresa obrigatoria.");

  await requireManager(request, companyId);
  const matches = await db
    .collection(`companies/${companyId}/employees`)
    .where("pinHash", "==", pinDigest(companyId, pin))
    .limit(2)
    .get();

  if (matches.empty) throw new HttpsError("not-found", "PIN nao encontrado.");
  if (matches.size > 1) throw new HttpsError("failed-precondition", "PIN duplicado. Procure o responsavel.");

  const employee = matches.docs[0];
  const data = employee.data();
  return {
    employeeId: normalizedText(data.employeeId) || employee.id,
    externalPunchAllowed: data.externalPunchAllowed === true,
    name: normalizedText(data.name) || "Colaborador",
  };
});
