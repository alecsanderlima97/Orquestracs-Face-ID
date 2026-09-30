import crypto from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
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
  const origin = normalizedText(request.data?.origin);
  const deviceId = normalizedText(request.data?.deviceId).slice(0, 160);
  const photoPath = normalizedText(request.data?.photoPath).slice(0, 500);
  const externalReason = normalizedText(request.data?.externalReason).slice(0, 500);
  const validTypes = ["entry", "lunch_out", "lunch_back", "exit"];
  const validSources = ["face_id", "pin_photo", "external_face_id", "external_pin_photo", "manager"];
  const validOrigins = ["kiosk", "external", "manager_adjustment"];

  if (!companyId || !requestedEmployeeId || !validTypes.includes(type)) {
    throw new HttpsError("invalid-argument", "Empresa, colaborador e tipo de marcacao sao obrigatorios.");
  }
  if (!validSources.includes(source) || !validOrigins.includes(origin) || !deviceId) {
    throw new HttpsError("invalid-argument", "Origem, metodo e dispositivo invalidos.");
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
    const status = origin === "external" ? "external_work" : "on_time";
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
      employeeName: normalizedText(employee.name),
      hash: result.hash,
      inpiRegistration,
      nsr: result.nsr,
      occurredAt,
      title: "Comprovante de Registro de Ponto do Trabalhador",
    },
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
