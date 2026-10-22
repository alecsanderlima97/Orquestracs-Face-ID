import crypto from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";

initializeApp();

const db = getFirestore();
const pinPepper = defineSecret("PIN_PEPPER");
const portalConnectorUrl = defineSecret("ORQUESTRA_PORTAL_CONNECTOR_URL");
const portalConnectorSecret = defineSecret("ORQUESTRA_CONNECTOR_SHARED_SECRET");
const callableOptions = { region: "us-east1", secrets: [pinPepper] };
const adminCallableOptions = { region: "us-east1" };
const portalCallableOptions = {
  region: "us-east1",
  secrets: [portalConnectorUrl, portalConnectorSecret],
};
const portalCommandOptions = {
  region: "us-east1",
  secrets: [portalConnectorSecret],
};
const portalTriggerOptions = {
  region: "us-east1",
  secrets: [portalConnectorUrl, portalConnectorSecret],
};
const portalSyncStateRef = db.doc("connectorState/portal");

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function commandRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function commandDate(value) {
  const normalized = normalizedText(value);
  return normalized && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(normalized) ? normalized.slice(0, 10) : null;
}

function commandSecretMatches(received, expected) {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function errorMessage(error) {
  return normalizedText(error instanceof Error ? error.message : error) || "Falha desconhecida no conector.";
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function dateToIso(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const brDate = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const parsed = brDate
      ? new Date(`${brDate[3]}-${brDate[2]}-${brDate[1]}T12:00:00.000Z`)
      : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function moneyValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const raw = normalizedText(value).replace(/[^\d,.-]/g, "");
  if (!raw) return null;
  const normalized = raw.lastIndexOf(",") > raw.lastIndexOf(".")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function subscriptionStatus(value) {
  const status = normalizedText(value).toLowerCase();
  if (!status) return null;
  if (status === "ativo") return "ativo";
  if (status === "bloqueado" || status === "pausado") return "bloqueado";
  if (status === "cancelado") return "cancelado";
  return "trial";
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

async function requireTenantMember(request, companyId) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre no sistema para continuar.");

  const email = normalizedText(request.auth.token.email).toLowerCase();
  if (email === "orquestracs@gmail.com") return;

  const membership = await db.doc(`tenants/${companyId}/users/${request.auth.uid}`).get();
  if (!membership.exists || !["owner", "admin", "reader"].includes(membership.data()?.role)) {
    throw new HttpsError("permission-denied", "Seu usuario nao pertence a esta empresa.");
  }
}

async function requirePlatformOwner(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre no sistema para continuar.");
  const email = normalizedText(request.auth.token.email).toLowerCase();
  if (email !== "orquestracs@gmail.com") {
    throw new HttpsError("permission-denied", "Apenas o administrador da plataforma pode executar esta acao.");
  }
}

function creditAmount(value, { maximum, label }) {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount < 1 || amount > maximum) {
    throw new HttpsError("invalid-argument", `${label} deve ser um numero inteiro entre 1 e ${maximum}.`);
  }
  return amount;
}

function digits(value) {
  return normalizedText(value).replace(/\D/g, "");
}

function sanitizeLocation(value) {
  const allowedStatuses = ["captured", "denied", "unavailable", "timeout"];
  const status = allowedStatuses.includes(value?.status) ? value.status : "unavailable";
  const location = { status };
  if (status === "captured") {
    const latitude = Number(value?.latitude);
    const longitude = Number(value?.longitude);
    const accuracy = Number(value?.accuracy);
    if (Number.isFinite(latitude) && latitude >= -90 && latitude <= 90) location.latitude = latitude;
    if (Number.isFinite(longitude) && longitude >= -180 && longitude <= 180) location.longitude = longitude;
    if (Number.isFinite(accuracy) && accuracy >= 0) location.accuracy = accuracy;
  }
  return location;
}

async function findEmployee(companyId, employeeId) {
  const direct = await db.doc(`companies/${companyId}/employees/${employeeId}`).get();
  if (direct.exists) return direct;

  const matches = await db
    .collection(`companies/${companyId}/employees`)
    .where("employeeId", "==", employeeId)
    .limit(2)
    .get();
  if (matches.size !== 1) return null;
  return matches.docs[0];
}

function formatRepDateTime(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
    year: "numeric",
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00-0300`;
}

function buildAfdPunchRecord({ employeeCpf, markedAt, nsr, previousHash, recordedAt }) {
  const nsrField = String(nsr).padStart(9, "0");
  const cpfField = employeeCpf.padStart(12, "0");
  const collectorId = "02";
  const offline = "0";
  const hashInput = `${nsrField}7${markedAt}${cpfField}${recordedAt}${collectorId}${offline}${previousHash || ""}`;
  const hash = crypto.createHash("sha256").update(hashInput, "latin1").digest("hex");
  return {
    hash,
    line: `${nsrField}7${markedAt}${cpfField}${recordedAt}${collectorId}${offline}${hash}`,
  };
}

function crc16Kermit(value) {
  let crc = 0;
  for (const byte of Buffer.from(value, "latin1")) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0x8408) : (crc >>> 1);
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function latinText(value, length) {
  return normalizedText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, " ")
    .slice(0, length)
    .padEnd(length, " ");
}

function numericText(value, length) {
  return digits(value).slice(0, length).padEnd(length, " ");
}

function dateFromUnknown(value) {
  if (value?.toDate) return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateOnly(date) {
  return formatRepDateTime(date).slice(0, 10);
}

function timeOnly(value) {
  return normalizedText(value).replace(":", "").slice(0, 4);
}

function minutesFromTime(value) {
  const compact = timeOnly(value);
  if (!/^\d{4}$/.test(compact)) return null;
  const hours = Number(compact.slice(0, 2));
  const minutes = Number(compact.slice(2));
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function classifyPunchStatus({ employee, occurredAt, origin, scheduledPunch }) {
  if (origin === "external") return "external_work";

  const expectedByPunch = {
    "Entrada 1": employee.schedule?.start,
    "Saída 1": employee.schedule?.breakStart,
    "Entrada 2": employee.schedule?.breakEnd,
    "Saída 2": employee.schedule?.end,
  };
  const expectedMinutes = minutesFromTime(expectedByPunch[scheduledPunch]);
  const currentMinutes = occurredAt.getHours() * 60 + occurredAt.getMinutes();
  const toleranceMinutes = Number(employee.schedule?.toleranceMinutes || 10);

  if (expectedMinutes === null) return "on_time";
  if (scheduledPunch === "Saída 2" && currentMinutes > expectedMinutes) return "bank_hours";
  if (Math.abs(currentMinutes - expectedMinutes) <= toleranceMinutes) return "on_time";
  return currentMinutes < expectedMinutes ? "early" : "late";
}

function buildAfdHeader({ company, firstDate, generatedAt, inpiRegistration, lastDate }) {
  const employerId = digits(company.cnpj || company.cpf);
  const developerId = digits(company.repP?.developerCnpj || company.repP?.developerCpf);
  const typeEmployer = employerId.length === 14 ? "1" : "2";
  const typeDeveloper = developerId.length === 14 ? "1" : "2";
  const body = [
    "000000000",
    "1",
    typeEmployer,
    numericText(employerId, 14),
    numericText(company.cno || company.caepf, 14),
    latinText(company.legalName || company.tradeName, 150),
    numericText(inpiRegistration, 17),
    dateOnly(firstDate),
    dateOnly(lastDate),
    formatRepDateTime(generatedAt),
    "004",
    typeDeveloper,
    numericText(developerId, 14),
    latinText("", 30),
  ].join("");
  return `${body}${crc16Kermit(body)}`;
}

function asIsoMinute(date) {
  return formatRepDateTime(date);
}

function aeJMarkType(type) {
  if (["entry", "lunch_back"].includes(type)) return "E";
  return "S";
}

function aeJSequence(type) {
  return ["entry", "lunch_out"].includes(type) ? "1" : "2";
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

export const registerRepPunch = onCall(callableOptions, async (request) => {
  const companyId = normalizedText(request.data?.companyId);
  const requestedEmployeeId = normalizedText(request.data?.employeeId);
  const type = normalizedText(request.data?.type);
  const source = normalizedText(request.data?.source);
  const scheduledPunch = normalizedText(request.data?.scheduledPunch);
  const origin = normalizedText(request.data?.origin);
  const deviceId = normalizedText(request.data?.deviceId).slice(0, 160);
  const photoPath = normalizedText(request.data?.photoPath).slice(0, 500);
  const externalReason = normalizedText(request.data?.externalReason).slice(0, 500);
  const validTypes = ["entry", "lunch_out", "lunch_back", "exit"];
  const validSources = ["face_id", "pin_photo", "external_face_id", "external_pin_photo", "manager"];
  const validOrigins = ["kiosk", "external", "manager_adjustment"];
  const validScheduledPunches = ["Entrada 1", "Saída 1", "Entrada 2", "Saída 2"];

  if (!companyId || !requestedEmployeeId || !validTypes.includes(type)) {
    throw new HttpsError("invalid-argument", "Empresa, colaborador e tipo de marcacao sao obrigatorios.");
  }
  if (!validSources.includes(source) || !validOrigins.includes(origin) || !deviceId) {
    throw new HttpsError("invalid-argument", "Origem, metodo e dispositivo invalidos.");
  }
  if (scheduledPunch && !validScheduledPunches.includes(scheduledPunch)) {
    throw new HttpsError("invalid-argument", "Etapa da jornada invalida.");
  }

  await requireManager(request, companyId);
  const [companySnapshot, employeeSnapshot] = await Promise.all([
    db.doc(`companies/${companyId}`).get(),
    findEmployee(companyId, requestedEmployeeId),
  ]);
  if (!companySnapshot.exists) throw new HttpsError("failed-precondition", "Cadastre a empresa antes de registrar ponto.");
  if (!employeeSnapshot) throw new HttpsError("not-found", "Colaborador nao encontrado.");

  const company = companySnapshot.data();
  const employee = employeeSnapshot.data();
  const companyCnpj = digits(company.cnpj);
  const employeeCpf = digits(employee.cpf);
  const inpiRegistration = digits(company.repP?.inpiRegistration || company.inpiRegistration);
  const complianceMode = company.repP?.mode === "production" ? "production" : "pilot";
  const missingFields = [];
  if (companyCnpj.length !== 14) missingFields.push("CNPJ da empresa");
  if (employeeCpf.length !== 11) missingFields.push("CPF do colaborador");
  if (!inpiRegistration) missingFields.push("registro do programa no INPI");
  if (complianceMode === "production" && missingFields.length) {
    throw new HttpsError("failed-precondition", `Modo oficial bloqueado: faltam ${missingFields.join(", ")}.`);
  }

  const now = Timestamp.now();
  const occurredAt = now.toDate().toISOString();
  const repDateTime = formatRepDateTime(now.toDate());
  const employeeId = normalizedText(employee.employeeId) || employeeSnapshot.id;
  const stateRef = db.doc(`companies/${companyId}/repState/main`);
  const punchRef = db.collection(`companies/${companyId}/punches`).doc();
  const arpRef = db.doc(`companies/${companyId}/arpRecords/${punchRef.id}`);
  const location = sanitizeLocation(request.data?.location);

  const result = await db.runTransaction(async (transaction) => {
    const stateSnapshot = await transaction.get(stateRef);
    const state = stateSnapshot.data() || {};
    const nsr = Number(state.lastNsr || 0) + 1;
    const previousHash = normalizedText(state.lastHash);
    const afdRecord = buildAfdPunchRecord({
      employeeCpf,
      markedAt: repDateTime,
      nsr,
      previousHash,
      recordedAt: repDateTime,
    });
    const hash = afdRecord.hash;
    const status = classifyPunchStatus({ employee, occurredAt: now.toDate(), origin, scheduledPunch });
    const punch = {
      companyId,
      deviceId,
      employeeId,
      employeeDocumentId: employeeSnapshot.id,
      externalReason,
      hash,
      location,
      nsr,
      occurredAt: now,
      origin,
      photoPath,
      previousHash,
      repDateTime,
      recordedBy: request.auth.uid,
      serverRecordedAt: now,
      source,
      status,
      type,
    };
    transaction.create(punchRef, punch);
    transaction.create(arpRef, {
      ...punch,
      afdRecord: afdRecord.line,
      recordType: "punch",
      schemaVersion: 1,
    });
    transaction.set(stateRef, {
      lastHash: hash,
      lastNsr: nsr,
      updatedAt: now,
    }, { merge: true });
    return { hash, nsr };
  });

  return {
    complianceMode,
    missingFields,
    punchId: punchRef.id,
    receipt: {
      companyCnpj,
      companyName: normalizedText(company.legalName || company.tradeName),
      employeeCpf,
      employeeId,
      employeeName: normalizedText(employee.name),
      hash: result.hash,
      inpiRegistration,
      nsr: result.nsr,
      occurredAt,
      title: "Comprovante de Registro de Ponto do Trabalhador",
    },
  };
});

export const listRecentRepReceipts = onCall(callableOptions, async (request) => {
  const companyId = normalizedText(request.data?.companyId);
  const employeeId = normalizedText(request.data?.employeeId);
  if (!companyId || !employeeId) {
    throw new HttpsError("invalid-argument", "Empresa e colaborador sao obrigatorios.");
  }

  await requireManager(request, companyId);
  const [companySnapshot, employeeSnapshot] = await Promise.all([
    db.doc(`companies/${companyId}`).get(),
    findEmployee(companyId, employeeId),
  ]);
  if (!companySnapshot.exists) throw new HttpsError("failed-precondition", "Empresa nao cadastrada.");
  if (!employeeSnapshot) throw new HttpsError("not-found", "Colaborador nao encontrado.");

  const start = Timestamp.fromDate(new Date(Date.now() - (48 * 60 * 60 * 1000)));
  const recentSnapshot = await db
    .collection(`companies/${companyId}/arpRecords`)
    .where("occurredAt", ">=", start)
    .get();
  const company = companySnapshot.data();
  const employee = employeeSnapshot.data();
  const resolvedEmployeeId = normalizedText(employee.employeeId) || employeeSnapshot.id;
  const inpiRegistration = digits(company.repP?.inpiRegistration || company.inpiRegistration);
  const receipts = recentSnapshot.docs
    .map((document) => ({ id: document.id, ...document.data() }))
    .filter((record) => record.recordType === "punch" && normalizedText(record.employeeId) === resolvedEmployeeId)
    .sort((left, right) => Number(right.nsr || 0) - Number(left.nsr || 0))
    .slice(0, 100)
    .map((record) => ({
      companyCnpj: digits(company.cnpj),
      companyName: normalizedText(company.legalName || company.tradeName),
      employeeCpf: digits(employee.cpf),
      employeeId: resolvedEmployeeId,
      employeeName: normalizedText(employee.name),
      hash: normalizedText(record.hash),
      inpiRegistration,
      nsr: Number(record.nsr || 0),
      occurredAt: dateFromUnknown(record.occurredAt)?.toISOString() || "",
      source: normalizedText(record.source),
      title: "Comprovante de Registro de Ponto do Trabalhador",
      type: normalizedText(record.type),
    }));

  return {
    generatedAt: new Date().toISOString(),
    receipts,
    windowHours: 48,
  };
});

export const listOwnRepReceipts = onCall(callableOptions, async (request) => {
  const companyId = normalizedText(request.data?.companyId);
  const pin = validatePin(request.data?.pin);
  if (!companyId) throw new HttpsError("invalid-argument", "Empresa obrigatoria.");

  await requireTenantMember(request, companyId);
  const matches = await db
    .collection(`companies/${companyId}/employees`)
    .where("pinHash", "==", pinDigest(companyId, pin))
    .limit(2)
    .get();
  if (matches.empty) throw new HttpsError("not-found", "PIN nao encontrado.");
  if (matches.size > 1) throw new HttpsError("failed-precondition", "PIN duplicado. Procure o responsavel.");

  const employeeSnapshot = matches.docs[0];
  const employee = employeeSnapshot.data();
  const employeeId = normalizedText(employee.employeeId) || employeeSnapshot.id;
  const start = Timestamp.fromDate(new Date(Date.now() - (48 * 60 * 60 * 1000)));
  const recentSnapshot = await db
    .collection(`companies/${companyId}/arpRecords`)
    .where("occurredAt", ">=", start)
    .get();
  const companySnapshot = await db.doc(`companies/${companyId}`).get();
  if (!companySnapshot.exists) throw new HttpsError("failed-precondition", "Empresa nao cadastrada.");

  const company = companySnapshot.data();
  const inpiRegistration = digits(company.repP?.inpiRegistration || company.inpiRegistration);
  const receipts = recentSnapshot.docs
    .map((document) => ({ id: document.id, ...document.data() }))
    .filter((record) => record.recordType === "punch" && normalizedText(record.employeeId) === employeeId)
    .sort((left, right) => Number(right.nsr || 0) - Number(left.nsr || 0))
    .slice(0, 100)
    .map((record) => ({
      companyCnpj: digits(company.cnpj),
      companyName: normalizedText(company.legalName || company.tradeName),
      employeeCpf: digits(employee.cpf),
      employeeId,
      employeeName: normalizedText(employee.name),
      hash: normalizedText(record.hash),
      inpiRegistration,
      nsr: Number(record.nsr || 0),
      occurredAt: dateFromUnknown(record.occurredAt)?.toISOString() || "",
      source: normalizedText(record.source),
      title: "Comprovante de Registro de Ponto do Trabalhador",
      type: normalizedText(record.type),
    }));

  await db.collection(`companies/${companyId}/receiptAccessLogs`).add({
    accessedAt: Timestamp.now(),
    employeeId,
    requestedBy: request.auth.uid,
    windowHours: 48,
  });

  return {
    employeeId,
    employeeName: normalizedText(employee.name),
    generatedAt: new Date().toISOString(),
    receipts,
    windowHours: 48,
  };
});

export const generateRepExports = onCall(callableOptions, async (request) => {
  const companyId = normalizedText(request.data?.companyId);
  const startDate = normalizedText(request.data?.startDate);
  const endDate = normalizedText(request.data?.endDate);
  if (!companyId || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new HttpsError("invalid-argument", "Empresa e periodo no formato AAAA-MM-DD sao obrigatorios.");
  }
  await requireManager(request, companyId);

  const start = Timestamp.fromDate(new Date(`${startDate}T00:00:00-03:00`));
  const end = Timestamp.fromDate(new Date(`${endDate}T23:59:59-03:00`));
  const [companySnapshot, arpSnapshot, employeesSnapshot, adjustmentsSnapshot] = await Promise.all([
    db.doc(`companies/${companyId}`).get(),
    db.collection(`companies/${companyId}/arpRecords`).where("occurredAt", ">=", start).where("occurredAt", "<=", end).get(),
    db.collection(`companies/${companyId}/employees`).get(),
    db.collection(`companies/${companyId}/adjustments`).where("adjustedTime", ">=", start).where("adjustedTime", "<=", end).get(),
  ]);
  if (!companySnapshot.exists) throw new HttpsError("failed-precondition", "Empresa nao cadastrada.");

  const company = companySnapshot.data();
  const inpiRegistration = digits(company.repP?.inpiRegistration || company.inpiRegistration);
  const developerId = digits(company.repP?.developerCnpj || company.repP?.developerCpf);
  const missingFields = [];
  if (digits(company.cnpj).length !== 14) missingFields.push("CNPJ da empresa");
  if (!inpiRegistration) missingFields.push("registro INPI");
  if (![11, 14].includes(developerId.length)) missingFields.push("CPF/CNPJ do desenvolvedor");
  if (!normalizedText(company.repP?.developerName)) missingFields.push("razao social do desenvolvedor");
  if (!normalizedText(company.repP?.developerEmail)) missingFields.push("email do desenvolvedor");

  const employees = employeesSnapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
  const employeeById = new Map();
  employees.forEach((employee, index) => {
    const employeeId = normalizedText(employee.employeeId) || employee.id;
    const mappedEmployee = { ...employee, aejId: index + 1 };
    employeeById.set(employee.id, mappedEmployee);
    employeeById.set(employeeId, mappedEmployee);
    if (digits(employee.cpf).length !== 11) missingFields.push(`CPF de ${normalizedText(employee.name) || employeeId}`);
  });

  const punches = arpSnapshot.docs
    .map((document) => ({ id: document.id, ...document.data() }))
    .filter((record) => record.recordType === "punch")
    .sort((a, b) => Number(a.nsr || 0) - Number(b.nsr || 0));
  const generatedAt = new Date();
  const firstPunchDate = dateFromUnknown(punches[0]?.occurredAt) || start.toDate();
  const lastPunchDate = dateFromUnknown(punches[punches.length - 1]?.occurredAt) || end.toDate();
  const afdLines = [
    buildAfdHeader({ company, firstDate: firstPunchDate, generatedAt, inpiRegistration, lastDate: lastPunchDate }),
    ...punches.map((punch) => normalizedText(punch.afdRecord)).filter(Boolean),
    `${"999999999"}${"0".padStart(9, "0")}${"0".padStart(9, "0")}${"0".padStart(9, "0")}${"0".padStart(9, "0")}${"0".padStart(9, "0")}${String(punches.length).padStart(9, "0")}9`,
    latinText("ASSINATURA_DIGITAL_EM_ARQUIVO_P7S", 100),
  ];

  const employerId = digits(company.cnpj || company.cpf);
  const aejLines = [
    ["01", employerId.length === 14 ? "1" : "2", employerId, digits(company.caepf), digits(company.cno), normalizedText(company.legalName || company.tradeName), startDate, endDate, asIsoMinute(generatedAt), "002"].join("|"),
    ["02", "1", "3", inpiRegistration].join("|"),
    ...employees.map((employee) => ["03", employee.aejId, digits(employee.cpf), normalizedText(employee.name)].join("|")),
    ...employees.map((employee) => {
      const schedule = employee.schedule || {};
      const startMinutes = minutesFromTime(schedule.start);
      const breakStartMinutes = minutesFromTime(schedule.breakStart);
      const breakEndMinutes = minutesFromTime(schedule.breakEnd);
      const endMinutes = minutesFromTime(schedule.end);
      const duration = [startMinutes, breakStartMinutes, breakEndMinutes, endMinutes].every(Number.isFinite)
        ? Math.max(0, (breakStartMinutes - startMinutes) + (endMinutes - breakEndMinutes))
        : 0;
      return ["04", `CH${employee.aejId}`, duration, timeOnly(schedule.start), timeOnly(schedule.breakStart), timeOnly(schedule.breakEnd), timeOnly(schedule.end)].join("|");
    }),
    ...punches.map((punch) => {
      const employee = employeeById.get(normalizedText(punch.employeeId));
      const occurredAt = dateFromUnknown(punch.occurredAt);
      if (!employee || !occurredAt) return "";
      const type = normalizedText(punch.type);
      return ["05", employee.aejId, asIsoMinute(occurredAt), "1", aeJMarkType(type), aeJSequence(type), "O", type === "entry" ? `CH${employee.aejId}` : "", ""].join("|");
    }).filter(Boolean),
    ...adjustmentsSnapshot.docs.map((document) => {
      const adjustment = document.data();
      const employee = employeeById.get(normalizedText(adjustment.employeeId));
      const adjustedAt = dateFromUnknown(adjustment.adjustedTime);
      if (!employee || !adjustedAt) return "";
      const type = normalizedText(adjustment.adjustedPunchType);
      return ["05", employee.aejId, asIsoMinute(adjustedAt), "", aeJMarkType(type), aeJSequence(type), "I", type === "entry" ? `CH${employee.aejId}` : "", normalizedText(adjustment.reason).slice(0, 150)].join("|");
    }).filter(Boolean),
    ["08", "Orquestracs Face ID", "1.0", developerId.length === 14 ? "1" : "2", developerId, normalizedText(company.repP?.developerName), normalizedText(company.repP?.developerEmail)].join("|"),
  ];
  const counts = Array.from({ length: 8 }, (_, index) => aejLines.filter((line) => line.startsWith(`0${index + 1}|`)).length);
  aejLines.push(["99", ...counts].join("|"));
  aejLines.push(latinText("ASSINATURA_DIGITAL_EM_ARQUIVO_P7S", 100));

  return {
    aej: aejLines.join("\r\n"),
    afd: afdLines.join("\r\n"),
    filenames: {
      aej: `AEJ_${startDate}_${endDate}.txt`,
      afd: `AFD${inpiRegistration}${employerId}REP_P.txt`,
    },
    missingFields: Array.from(new Set([
      ...missingFields,
      "assinatura digital ICP-Brasil PAdES/CAdES",
      "historico ARP completo de inclusoes, alteracoes e eventos sensiveis",
    ])),
    officialReady: false,
    signatureStatus: "missing_icp_brasil",
  };
});

export const consumeAiCredit = onCall(adminCallableOptions, async (request) => {
  const tenantId = normalizedText(request.data?.tenantId);
  const amount = creditAmount(request.data?.amount ?? 1, { label: "A quantidade", maximum: 100 });
  if (!tenantId) throw new HttpsError("invalid-argument", "Empresa obrigatoria.");

  await requireTenantMember(request, tenantId);
  const tenantRef = db.doc(`tenants/${tenantId}`);
  const usageRef = tenantRef.collection("aiCreditUsage").doc();
  const result = await db.runTransaction(async (transaction) => {
    const tenantSnapshot = await transaction.get(tenantRef);
    const aiCredits = tenantSnapshot.data()?.aiCredits || {};
    const balance = Number(aiCredits.balance || 0);
    const included = Number(aiCredits.included || 0);
    const bonus = Number(aiCredits.bonus || 0);
    const used = Number(aiCredits.used || 0);
    if (aiCredits.status === "Bloqueado" || balance < amount) {
      throw new HttpsError("resource-exhausted", "Creditos IA esgotados ou bloqueados.");
    }

    const nextBalance = balance - amount;
    const nextUsed = used + amount;
    transaction.set(tenantRef, {
      aiCredits: {
        ...aiCredits,
        balance: nextBalance,
        bonus,
        included,
        used: nextUsed,
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.create(usageRef, {
      amount,
      createdAt: Timestamp.now(),
      createdBy: request.auth.uid,
      email: normalizedText(request.auth.token.email).toLowerCase(),
      type: "assistant_question",
    });
    return { balance: nextBalance, bonus, included, used: nextUsed };
  });

  return { tenantId, ...result };
});

export const adjustAiCredits = onCall(adminCallableOptions, async (request) => {
  await requirePlatformOwner(request);
  const tenantId = normalizedText(request.data?.tenantId);
  const credits = creditAmount(request.data?.credits, { label: "Os creditos", maximum: 100000 });
  const reason = normalizedText(request.data?.reason);
  if (!tenantId) throw new HttpsError("invalid-argument", "Empresa obrigatoria.");
  if (reason.length < 5 || reason.length > 300) {
    throw new HttpsError("invalid-argument", "O motivo deve conter entre 5 e 300 caracteres.");
  }

  const tenantRef = db.doc(`tenants/${tenantId}`);
  const adjustmentRef = tenantRef.collection("aiCreditAdjustments").doc();
  const createdAt = Timestamp.now();
  const adjustmentBy = normalizedText(request.auth.token.email).toLowerCase();
  const result = await db.runTransaction(async (transaction) => {
    const tenantSnapshot = await transaction.get(tenantRef);
    const aiCredits = tenantSnapshot.data()?.aiCredits || {};
    const balanceBefore = Number(aiCredits.balance || 0);
    const bonusBefore = Number(aiCredits.bonus || 0);
    const balanceAfter = balanceBefore + credits;
    const bonusAfter = bonusBefore + credits;
    transaction.set(tenantRef, {
      aiCredits: {
        ...aiCredits,
        balance: balanceAfter,
        bonus: bonusAfter,
        included: Number(aiCredits.included || 0),
        lastAdjustmentAt: createdAt.toDate().toISOString(),
        lastAdjustmentBy: adjustmentBy,
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.create(adjustmentRef, {
      balanceAfter,
      balanceBefore,
      bonusAfter,
      bonusBefore,
      createdAt,
      createdBy: adjustmentBy,
      credits,
      reason,
      type: "manual_bonus",
    });
    return {
      balance: balanceAfter,
      bonus: bonusAfter,
      included: Number(aiCredits.included || 0),
      used: Number(aiCredits.used || 0),
    };
  });

  return { tenantId, adjustmentId: adjustmentRef.id, ...result };
});

export const receivePortalCommand = onRequest(portalCommandOptions, async (request, response) => {
  if (request.method !== "POST") {
    response.status(405).json({ error: "Método não permitido." });
    return;
  }
  const expectedSecret = normalizedText(portalConnectorSecret.value());
  const authorization = request.get("authorization") || "";
  const receivedSecret = normalizedText(request.get("x-orquestra-connector-secret") || authorization.replace(/^Bearer\s+/i, ""));
  if (!expectedSecret || !commandSecretMatches(receivedSecret, expectedSecret)) {
    response.status(401).json({ error: "Conector não autorizado." });
    return;
  }

  const body = commandRecord(request.body);
  const commandId = normalizedText(body.commandId);
  const sourceSystem = normalizedText(body.sourceSystem);
  const targetSystem = normalizedText(body.targetSystem);
  const commandType = normalizedText(body.commandType);
  const externalTenantId = normalizedText(body.externalTenantId);
  const contract = commandRecord(body.contract);
  if (!commandId || !externalTenantId || sourceSystem !== "orquestra_portal" || targetSystem !== "orquestracs_face_id" || commandType !== "tenant.updated") {
    response.status(400).json({ error: "Comando contratual inválido." });
    return;
  }

  const tenantId = externalTenantId.replace(/^orquestracs_face_id_/, "");
  const tenantRef = db.doc(`tenants/${tenantId}`);
  const companyRef = db.doc(`companies/${tenantId}`);
  const commandRef = db.doc(`connectorCommands/${commandId}`);
  const plan = normalizedText(contract.plan);
  const amount = contract.monthlyFee === null || contract.monthlyFee === undefined || contract.monthlyFee === "" ? null : moneyValue(contract.monthlyFee);
  const billingDay = contract.billingDay === null || contract.billingDay === undefined || contract.billingDay === "" ? null : Number(contract.billingDay);
  const graceDays = contract.graceDays === null || contract.graceDays === undefined || contract.graceDays === "" ? null : Number(contract.graceDays);
  const startDate = commandDate(contract.startDate);
  const renewalDate = commandDate(contract.renewalDate || contract.nextDueDate);
  const paymentMethod = normalizedText(contract.paymentMethod);
  const billingStatus = normalizedText(contract.billingStatus);
  const subscriptionStatus = normalizedText(contract.subscriptionStatus).toLowerCase();
  const notes = normalizedText(contract.notes);
  if (amount !== null && !Number.isFinite(amount)) { response.status(400).json({ error: "Mensalidade inválida." }); return; }
  if (billingDay !== null && (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 31)) { response.status(400).json({ error: "Dia de vencimento inválido." }); return; }
  if (graceDays !== null && (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 90)) { response.status(400).json({ error: "Tolerância inválida." }); return; }
  if ((contract.startDate !== undefined && !startDate) || (contract.renewalDate !== undefined && !renewalDate) || (contract.nextDueDate !== undefined && !renewalDate)) { response.status(400).json({ error: "Data contratual inválida." }); return; }

  let duplicate = false;
  try {
    await db.runTransaction(async (transaction) => {
      const [commandSnapshot, tenantSnapshot, companySnapshot] = await Promise.all([transaction.get(commandRef), transaction.get(tenantRef), transaction.get(companyRef)]);
      if (commandSnapshot.exists) { duplicate = true; return; }
      if (!tenantSnapshot.exists) throw new Error("tenant_not_found");
      const currentBilling = commandRecord(tenantSnapshot.data()?.billing);
      const billing = { ...currentBilling };
      if (amount !== null) billing.amount = amount;
      if (billingDay !== null) billing.billingDay = billingDay;
      if (graceDays !== null) billing.graceDays = graceDays;
      if (renewalDate) billing.renewalDate = renewalDate;
      if (paymentMethod) billing.paymentMethod = paymentMethod;
      if (billingStatus) billing.status = billingStatus;
      const tenantUpdates = { billing, updatedAt: FieldValue.serverTimestamp() };
      if (plan) tenantUpdates.plan = plan;
      if (startDate) tenantUpdates.startDate = startDate;
      if (subscriptionStatus) tenantUpdates.status = subscriptionStatus;
      if (notes) tenantUpdates.notes = notes;
      transaction.set(tenantRef, tenantUpdates, { merge: true });
      if (companySnapshot.exists && (paymentMethod || notes || startDate)) {
        const companyUpdates = {};
        if (paymentMethod) companyUpdates.paymentMethod = paymentMethod;
        if (notes) companyUpdates.internalNotes = notes;
        if (startDate) companyUpdates.registrationDate = startDate;
        transaction.set(companyRef, companyUpdates, { merge: true });
      }
      const now = new Date().toISOString();
      transaction.create(commandRef, { commandId, commandType, sourceSystem, targetSystem, externalTenantId, status: "applied", createdAt: now, appliedAt: now });
      transaction.set(db.doc(`tenants/${tenantId}/auditLogs/${commandId}`), { action: "tenant.contract_updated_from_portal", actorRole: "system", actorUserId: "orquestra_portal", createdAt: now, targetId: tenantId, targetType: "tenant" });
    });
    await portalSyncStateRef.set({
      lastInboundAt: Timestamp.now(),
      lastInboundCommandId: commandId,
      lastInboundStatus: duplicate ? "duplicate" : "applied",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    response.json({ ok: true, duplicate, tenantId });
  } catch (error) {
    if (error instanceof Error && error.message === "tenant_not_found") { response.status(404).json({ error: "Empresa de origem não encontrada." }); return; }
    console.error("Face ID portal command failed", error);
    response.status(500).json({ error: "Não foi possível aplicar o comando no sistema de origem." });
  }
});

async function sendFacePortalSnapshot() {
  const endpoint = normalizedText(portalConnectorUrl.value());
  const secret = normalizedText(portalConnectorSecret.value());
  if (!endpoint || !secret) {
    throw new HttpsError("failed-precondition", "Conector do Portal ainda nao configurado.");
  }

  const tenantsSnapshot = await db.collection("tenants").limit(100).get();
  const mainCompanySnapshot = await db.doc("companies/main").get();
  const tenantDocuments = tenantsSnapshot.empty && mainCompanySnapshot.exists
    ? [{ id: "main", data: () => ({}) }]
    : tenantsSnapshot.docs;
  const generatedAt = new Date().toISOString();
  const tenants = await Promise.all(tenantDocuments.map(async (tenantDocument) => {
    const tenant = tenantDocument.data() || {};
    const companyDocument = await db.doc(`companies/${tenantDocument.id}`).get();
    const company = companyDocument.data() || {};
    const usersSnapshot = await db.collection(`tenants/${tenantDocument.id}/users`).limit(500).get();
    const users = usersSnapshot.docs.filter((userDocument) => normalizedText(userDocument.data()?.email).toLowerCase() !== "orquestracs@gmail.com").map((userDocument) => {
      const user = userDocument.data() || {};
      const lastSeenAt = dateToIso(user.lastSeenAt || user.lastActivityAt || user.updatedAt);
      const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : 0;
      return {
        externalUserId: userDocument.id,
        name: normalizedText(user.name) || normalizedText(user.email) || "Usuario",
        email: normalizedText(user.email).toLowerCase(),
        role: normalizedText(user.role) || "reader",
        active: user.active !== false,
        lastActivityAt: dateToIso(user.lastActivityAt || user.updatedAt),
        lastSeenAt,
        lastLoginAt: dateToIso(user.lastLoginAt || user.lastAccessAt),
        deviceType: normalizedText(user.deviceType || user.device?.type) || null,
        operatingSystem: normalizedText(user.operatingSystem || user.device?.operatingSystem) || null,
        browser: normalizedText(user.browser || user.device?.browser) || null,
        online: Boolean(lastSeenMs && Date.now() - lastSeenMs <= 2 * 60 * 1000),
      };
    });
    const billing = tenant.billing && typeof tenant.billing === "object" ? tenant.billing : {};
    const address = company.address && typeof company.address === "object" ? company.address : {};
    const dueDate = dateToIso(billing.dueDate);
    const billingDay = dueDate ? new Date(dueDate).getUTCDate() : null;
    const companyName = normalizedText(tenant.name)
      || normalizedText(company.tradeName)
      || normalizedText(company.legalName)
      || `Empresa ${tenantDocument.id}`;
    const contract = {};
    const plan = normalizedText(tenant.plan);
    const monthlyFee = moneyValue(billing.amount);
    const startDate = dateToIso(company.registrationDate || company.createdAt || tenant.createdAt);
    const renewalDate = dateToIso(billing.renewalDate || billing.nextBillingDate);
    const paidThroughDate = dateToIso(billing.paidThroughDate || billing.paidUntil || billing.nextBillingDate);
    const paymentMethod = normalizedText(company.paymentMethod || billing.paymentMethod);
    const billingStatus = normalizedText(billing.status || tenant.billingStatus);
    const graceDays = Number(billing.graceDays);
    const notes = normalizedText(company.internalNotes || tenant.notes);
    const currentStatus = subscriptionStatus(tenant.status);
    const sourceUpdatedAt = dateToIso(tenant.updatedAt) || generatedAt;
    if (plan) contract.plan = plan;
    if (monthlyFee !== null) contract.monthlyFee = monthlyFee;
    if (billingDay !== null) contract.billingDay = billingDay;
    if (Number.isInteger(graceDays) && graceDays >= 0 && graceDays <= 90) contract.graceDays = graceDays;
    if (startDate) contract.startDate = startDate;
    if (renewalDate) contract.renewalDate = renewalDate;
    if (dueDate) contract.nextDueDate = dueDate;
    if (paymentMethod) contract.paymentMethod = paymentMethod;
    if (billingStatus) contract.billingStatus = billingStatus.toLowerCase();
    if (paidThroughDate) contract.paidThroughDate = paidThroughDate;
    if (notes) contract.notes = notes;
    if (currentStatus) contract.subscriptionStatus = currentStatus;
    if (Number.isInteger(tenant.dataVersion)) contract.dataVersion = tenant.dataVersion;
    if (sourceUpdatedAt) contract.sourceUpdatedAt = sourceUpdatedAt;

    return {
      externalTenantId: tenantDocument.id,
      companyName,
      customer: {
        companyName,
        legalName: normalizedText(company.legalName) || null,
        tradeName: normalizedText(company.tradeName) || companyName,
        responsibleName: normalizedText(company.contactName) || null,
        contactEmail: normalizedText(company.contactEmail).toLowerCase() || null,
        contactPhone: normalizedText(company.contactPhone) || null,
        document: digits(company.cnpj || company.cpf) || null,
        documentType: digits(company.cnpj).length === 14 ? "CNPJ" : digits(company.cpf).length === 11 ? "CPF" : null,
        street: normalizedText(address.street) || null,
        number: normalizedText(address.number) || null,
        complement: normalizedText(address.complement) || null,
        neighborhood: normalizedText(address.district || address.neighborhood) || null,
        city: normalizedText(address.city) || null,
        state: normalizedText(address.state) || null,
        cep: digits(address.zipCode || address.cep) || null,
        googleBusinessUrl: normalizedText(company.mapsUrl || company.googleMapsUrl) || null,
        notes: normalizedText(company.internalNotes || tenant.notes) || null,
      },
      contract,
      lastActivityAt: users.map((user) => user.lastActivityAt).filter(Boolean).sort().at(-1) || null,
      onlineUserCount: users.filter((user) => user.online).length,
      presenceTracking: users.some((user) => Boolean(user.lastSeenAt)),
      users,
    };
  }));

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-orquestra-connector-secret": secret,
    },
    body: JSON.stringify({
      sourceSystem: "orquestracs_face_id",
      snapshotId: crypto.randomUUID(),
      generatedAt,
      tenants,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Portal snapshot rejected", response.status, result);
    throw new HttpsError("unavailable", "O Portal nao confirmou a sincronizacao.");
  }

  return {
    ok: true,
    clients: tenants.length,
    users: tenants.reduce((total, tenant) => total + tenant.users.length, 0),
    result,
  };
}

async function runPortalSync(reason, { delayMs = 0, force = false } = {}) {
  if (delayMs > 0) await wait(delayMs);

  const decision = await db.runTransaction(async (transaction) => {
    const stateSnapshot = await transaction.get(portalSyncStateRef);
    const state = stateSnapshot.data() || {};
    const lastAttemptAt = timestampMillis(state.lastAttemptAt);
    const now = Date.now();
    const stillRunning = state.status === "syncing" && now - lastAttemptAt < 2 * 60 * 1000;
    const recentlyRequested = !force && lastAttemptAt > 0 && now - lastAttemptAt < 5 * 1000;

    if (stillRunning || recentlyRequested) {
      return {
        run: false,
        clients: Number(state.lastClients || 0),
        users: Number(state.lastUsers || 0),
      };
    }

    transaction.set(portalSyncStateRef, {
      lastAttemptAt: Timestamp.now(),
      lastReason: reason,
      lastError: FieldValue.delete(),
      status: "syncing",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { run: true };
  });

  if (!decision.run) {
    return { ok: true, skipped: true, clients: decision.clients, users: decision.users };
  }

  try {
    const result = await sendFacePortalSnapshot();
    await portalSyncStateRef.set({
      lastClients: result.clients,
      lastSuccessAt: Timestamp.now(),
      lastUsers: result.users,
      status: "success",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return result;
  } catch (error) {
    await portalSyncStateRef.set({
      lastError: errorMessage(error).slice(0, 500),
      lastFailureAt: Timestamp.now(),
      status: "error",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    throw error;
  }
}

export const syncPortalSnapshot = onCall(portalCallableOptions, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre no sistema para continuar.");
  const email = normalizedText(request.auth.token.email).toLowerCase();
  if (!["orquestracs@gmail.com", "limaalecsander@gmail.com"].includes(email)) {
    throw new HttpsError("permission-denied", "Apenas a equipe Orquestra.cs pode sincronizar a Central.");
  }
  return runPortalSync("manual", { force: true });
});

export const syncPortalSnapshotScheduled = onSchedule({
  region: "us-east1",
  schedule: "every 15 minutes",
  timeZone: "America/Sao_Paulo",
  timeoutSeconds: 120,
  secrets: [portalConnectorUrl, portalConnectorSecret],
}, async () => {
  await runPortalSync("scheduled");
});

export const syncPortalOnTenantWrite = onDocumentWritten({
  ...portalTriggerOptions,
  document: "tenants/{tenantId}",
}, async (event) => {
  if (!event.data) return;
  await runPortalSync(`event:tenant:${event.params.tenantId}`, { delayMs: 1500 });
});

export const syncPortalOnCompanyWrite = onDocumentWritten({
  ...portalTriggerOptions,
  document: "companies/{companyId}",
}, async (event) => {
  if (!event.data) return;
  await runPortalSync(`event:company:${event.params.companyId}`, { delayMs: 1500 });
});

export const syncPortalOnUserWrite = onDocumentWritten({
  ...portalTriggerOptions,
  document: "tenants/{tenantId}/users/{userId}",
}, async (event) => {
  if (!event.data) return;
  await runPortalSync(`event:user:${event.params.tenantId}:${event.params.userId}`, { delayMs: 1500 });
});
