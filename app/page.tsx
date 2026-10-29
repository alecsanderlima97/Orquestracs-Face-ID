"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  browserLocalPersistence,
  getRedirectResult,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth";
import { clearLocalFaceProfile, FaceCamera, type FaceProfileSource, type RecognizedFace } from "@/app/components/FaceCamera";
import AdminCentral from "@/app/components/AdminCentral";
import { auth } from "@/lib/firebase/client";
import { FACE_ID_REQUIRED_CAPTURES } from "@/lib/face-id/config";
import { getCompany, getMainCompany, saveMainCompany, saveTenantCompany, uploadCompanyLogo } from "@/lib/services/companies";
import type {
  AttendanceJustification,
  AttendanceJustificationPeriod,
  AttendanceJustificationType,
  AdjustmentType,
  BankHoursAdjustment,
  PunchAdjustment,
  Punch,
  PunchStatus,
  PunchType,
} from "@/lib/models";
import { createFaceIdRecord, listFaceIdRecords, uploadFacePhoto } from "@/lib/services/face-id";
import { saveEmployeePin, verifyEmployeePin } from "@/lib/services/employee-pins";
import { listEmployees, upsertEmployee } from "@/lib/services/employees";
import { uploadPunchPhoto } from "@/lib/services/punch-photos";
import {
  createPunchAdjustment,
  listEmployeePunches,
  listEmployeePunchesByIds,
  listPunchAdjustments,
  reviewPunchAdjustment,
} from "@/lib/services/punches";
import {
  createAttendanceJustification,
  listAttendanceJustifications,
  reviewAttendanceJustification,
  uploadAttendanceEvidence,
} from "@/lib/services/attendance-justifications";
import {
  createBankHoursAdjustment,
  listBankHoursAdjustments,
  reviewBankHoursAdjustment,
} from "@/lib/services/hours-bank";
import {
  generateRepExports,
  listOwnRepReceipts,
  listRecentRepReceipts,
  registerRepPunch,
  type RepPunchReceipt,
} from "@/lib/services/rep-p";
import { getStorageFileUrl } from "@/lib/services/storage-files";
import { syncPortalSnapshot } from "@/lib/services/portal-sync";
import { applyCreditResult, consumeAiCredit } from "@/lib/services/ai-credits";
import {
  acceptTenantInvite,
  createTenantInvite,
  getTenantSaasConfig,
  getUserTenantAccesses,
  isPlatformOwnerEmail,
  listTenantInvites,
  saveTenantSaasConfig,
  type TenantAccess,
  type TenantInvite,
  type TenantSaasConfig,
} from "@/lib/services/tenant-access";

type Section =
  | "Painel"
  | "Empresa"
  | "Colaboradores"
  | "Sala de ponto"
  | "Ponto externo"
  | "Batidas"
  | "Banco de horas"
  | "Fechamento mensal"
  | "Relatorios"
  | "LGPD e auditoria"
  | "Configuracoes"
  | "Admin";

type MaskType = "name" | "cpf" | "cnpj" | "phone" | "time" | "pin" | "date" | "cep";
type EmployeeSection = "detail" | "face" | "form" | "list";

const employees: EmployeeRow[] = [];

// O tenant só existe depois que a sessão e o convite/membership foram resolvidos.
// Manter o contexto vazio durante essa fase evita consultar a empresa principal por engano.
const TenantIdContext = createContext("");

function useActiveCompanyId() {
  return useContext(TenantIdContext);
}

type EmployeeRow = {
  active?: boolean;
  admissionDate?: string;
  bank: string;
  cbo?: string;
  cpf: string;
  department?: string;
  documentId?: string;
  employeeId?: string;
  faceCaptureCount?: number;
  externalPunchAllowed?: boolean;
  faceIdStatus?: "not_registered" | "registered";
  lastPunch: string;
  name: string;
  phone?: string;
  pin?: string;
  pinConfigured?: boolean;
  profilePhotoPath?: string;
  registration?: string;
  role: string;
  shift: string;
  status: string;
};

type LocalEmployee = EmployeeRow & {
  employeeId: string;
  faceIdStatus: "not_registered" | "registered";
  pin: string;
  pinConfigured: boolean;
  punchMode: "automatic" | "manual";
  schedule: {
    breakEnd: string;
    breakStart: string;
    end: string;
    periods?: Array<{ start: string; end: string }>;
    start: string;
    toleranceMinutes: number;
  };
};

type ImportedEmployee = {
  active?: boolean;
  admissionDate?: string;
  cbo?: string;
  collectiveJourneyId?: string;
  cpf?: string;
  department?: string;
  externalPunchAllowed?: boolean;
  faceIdStatus?: "not_registered" | "registered";
  journeyMode?: "collective" | "individual";
  name: string;
  phone?: string;
  pin?: string;
  registration?: string;
  role?: string;
};

type HoleriteImportDraft = {
  fileName: string;
  fields: ImportedEmployee;
  missing: string[];
  pages?: number;
  warnings: string[];
};

const LOCAL_EMPLOYEES_KEY = "orquestracs-face-id-local-employees-v2";

function getLocalEmployees() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(LOCAL_EMPLOYEES_KEY) || "[]") as LocalEmployee[];
    return saved.map((employee) => ({
      ...employee,
      pin: "",
      pinConfigured: Boolean(employee.pinConfigured || employee.pin),
    })).filter((employee) => employee.active !== false);
  } catch {
    return [];
  }
}

function toLocalEmployee(employee: Record<string, unknown>, fallbackId: string): LocalEmployee {
  const schedule = (employee.schedule || {}) as LocalEmployee["schedule"];

  return {
    active: employee.active !== false,
    admissionDate: String(employee.admissionDate || "Nao informado"),
    bank: String(employee.bank || "00:00"),
    cbo: String(employee.cbo || ""),
    cpf: String(employee.cpf || "Nao informado"),
    department: String(employee.department || "Geral"),
    documentId: String(employee.documentId || fallbackId),
    employeeId: String(employee.employeeId || employee.id || fallbackId),
    faceCaptureCount: Number(employee.faceCaptureCount || 0),
    externalPunchAllowed: employee.externalPunchAllowed === true,
    faceIdStatus: (employee.faceIdStatus || "not_registered") as LocalEmployee["faceIdStatus"],
    lastPunch: String(employee.lastPunch || "Sem batida hoje"),
    name: String(employee.name || "Colaborador sem nome"),
    phone: String(employee.phone || ""),
    pin: "",
    pinConfigured: Boolean(employee.pinHash || employee.pin || employee.pinConfigured),
    profilePhotoPath: String(employee.profilePhotoPath || ""),
    punchMode: (employee.punchMode || "automatic") as LocalEmployee["punchMode"],
    registration: String(employee.registration || ""),
    role: String(employee.role || "Nao informado"),
    schedule: {
      breakEnd: schedule.breakEnd || "13:00",
      breakStart: schedule.breakStart || "11:30",
      end: schedule.end || "17:15",
      periods: Array.isArray(schedule.periods)
        ? schedule.periods.filter((period) => period?.start && period?.end).slice(0, 4)
        : undefined,
      start: schedule.start || "07:00",
      toleranceMinutes: Number(schedule.toleranceMinutes || 10),
    },
    shift: String(employee.shift || "Jornada da empresa"),
    status: String(employee.status || "Pre-cadastro"),
  };
}

function employeeDocumentId(employee: Pick<LocalEmployee, "documentId" | "employeeId" | "name" | "registration">) {
  if (employee.documentId) return employee.documentId;

  const registration = onlyDigits(employee.registration || "");
  if (registration) return `matricula-${registration}`;

  return `colaborador-${employee.name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || employee.employeeId}`;
}

const navItems: Section[] = [
  "Painel",
  "Empresa",
  "Colaboradores",
  "Sala de ponto",
  "Ponto externo",
  "Banco de horas",
  "Fechamento mensal",
  "Relatorios",
  "LGPD e auditoria",
  "Configuracoes",
  "Admin",
];

type AuthenticationPreference = {
  mode: "face" | "fingerprint" | "either" | "both" | "pin";
  pinFallback: boolean;
  readerModel: string;
};

type MainCompanyProfile = Record<string, unknown> & {
  cnpj?: string;
  legalName?: string;
  logoUrl?: string;
  tradeName?: string;
  workPolicy?: WorkPolicy;
};

type WeatherSnapshot = {
  available: boolean;
  city?: string;
  isDay?: boolean;
  kind?: "clear" | "cloudy" | "rain" | "storm";
  source?: "company" | "current";
  temperature?: number | null;
};

type WeatherCoordinates = {
  latitude: number;
  longitude: number;
};

type WorkPolicy = {
  absenceMode: "day" | "period";
  afternoonAbsenceWeight: number;
  bankHoursEnabled: boolean;
  externalWorkPolicy: string;
  forgottenPunchPolicy: string;
  fullDayAbsenceWeight: number;
  morningAbsenceWeight: number;
  scheduledDays: number;
  toleranceMinutes: number;
};

const DEFAULT_WORK_POLICY: WorkPolicy = {
  absenceMode: "period",
  afternoonAbsenceWeight: 1,
  bankHoursEnabled: true,
  externalWorkPolicy: "Permitir com justificativa",
  forgottenPunchPolicy: "Exige aprovacao",
  fullDayAbsenceWeight: 2,
  morningAbsenceWeight: 1,
  scheduledDays: 5,
  toleranceMinutes: 10,
};

const auditLogs = [
  ["Original imutavel", "Batidas bloqueadas contra edicao direta"],
  ["Ajuste rastreado", "Responsavel, motivo e horario obrigatorios"],
  ["Prova digital", "Foto, PIN, IP, aparelho e hash por marcacao"],
  ["Relatorio mensal", "Espelho pronto para assinatura e conferencia"],
];

const monthlyClosingRows: string[][] = [];

const monthOptions = [
  ["01", "Janeiro"],
  ["02", "Fevereiro"],
  ["03", "Marco"],
  ["04", "Abril"],
  ["05", "Maio"],
  ["06", "Junho"],
  ["07", "Julho"],
  ["08", "Agosto"],
  ["09", "Setembro"],
  ["10", "Outubro"],
  ["11", "Novembro"],
  ["12", "Dezembro"],
].map(([value, label]) => ({ label, value }));

type MonthPeriod = {
  end: Date;
  label: string;
  month: number;
  start: Date;
  year: number;
};

type MonthlyMirrorRow = {
  balanceMinutes: number;
  date: Date;
  earlyLeaveMinutes: number;
  incompleteAfternoon: boolean;
  incompleteMorning: boolean;
  isWorkday: boolean;
  justifiedAfternoon: boolean;
  justifiedMorning: boolean;
  label: string;
  lateMinutes: number;
  missingAfternoon: boolean;
  missingMorning: boolean;
  scheduledPunches: Partial<Record<ScheduledPunch, Punch>>;
  status: string;
  workedMinutes: number;
};

type MonthlyMirrorSummary = {
  absencePoints: number;
  bankAdjustmentMinutes: number;
  earlyLeaveMinutes: number;
  employee: LocalEmployee;
  incompleteAfternoons: number;
  incompleteMornings: number;
  lateMinutes: number;
  missingAfternoons: number;
  missingMornings: number;
  pendingDays: number;
  periodLabel: string;
  rows: MonthlyMirrorRow[];
  totalBalanceMinutes: number;
  totalPunches: number;
  totalWorkedMinutes: number;
};

const initialShifts = [
  {
    name: "Escala 07h as 17h15",
    weeklyHours: "43:45",
    start: "07:00",
    end: "17:15",
    breakStart: "11:30",
    breakEnd: "13:00",
    days: "5",
    tolerance: "10 min",
    extraPercent: "60%",
  },
  {
    name: "Escala 09h as 19h",
    weeklyHours: "40:00",
    start: "09:00",
    end: "19:00",
    breakStart: "13:00",
    breakEnd: "15:00",
    days: "5",
    tolerance: "10 min",
    extraPercent: "60%",
  },
];

function onlyDigits(value: string) {
  return value.replace(/\D/g, "");
}

function maskName(value: string) {
  return value
    .replace(/[^a-zA-ZÀ-ÿ\s]/g, "")
    .replace(/\s+/g, " ")
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
    .slice(0, 70);
}

function maskCpf(value: string) {
  const digits = onlyDigits(value).slice(0, 11);
  return digits
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
}

function maskCnpj(value: string) {
  const digits = onlyDigits(value).slice(0, 14);
  return digits
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2");
}

function maskPhone(value: string) {
  const digits = onlyDigits(value).slice(0, 11);
  if (digits.length <= 10) {
    return digits
      .replace(/^(\d{2})(\d)/, "($1) $2")
      .replace(/(\d{4})(\d)/, "$1-$2");
  }

  return digits
    .replace(/^(\d{2})(\d)/, "($1) $2")
    .replace(/(\d{5})(\d)/, "$1-$2");
}

function maskDate(value: string) {
  const digits = onlyDigits(value).slice(0, 8);
  return digits
    .replace(/^(\d{2})(\d)/, "$1/$2")
    .replace(/^(\d{2})\/(\d{2})(\d)/, "$1/$2/$3");
}

function maskCep(value: string) {
  const digits = onlyDigits(value).slice(0, 8);
  return digits.replace(/^(\d{5})(\d)/, "$1-$2");
}

function maskTime(value: string) {
  const digits = onlyDigits(value).slice(0, 4);
  if (digits.length <= 2) return digits;

  const hour = Math.min(Number(digits.slice(0, 2)), 23).toString().padStart(2, "0");
  const minute = Math.min(Number(digits.slice(2, 4)), 59).toString().padStart(2, "0");
  return `${hour}:${minute}`;
}

function timeToMinutes(value: string) {
  const [hour = "0", minute = "0"] = maskTime(value).split(":");
  return Number(hour) * 60 + Number(minute);
}

function minutesToDuration(totalMinutes: number) {
  const safeMinutes = Math.max(0, totalMinutes);
  const hours = Math.floor(safeMinutes / 60).toString().padStart(2, "0");
  const minutes = (safeMinutes % 60).toString().padStart(2, "0");

  return `${hours}:${minutes}`;
}

function calculateDailyMinutes({
  breakEnd,
  breakStart,
  end,
  start,
}: {
  breakEnd: string;
  breakStart: string;
  end: string;
  start: string;
}) {
  const morning = timeToMinutes(breakStart) - timeToMinutes(start);
  const afternoon = timeToMinutes(end) - timeToMinutes(breakEnd);

  return Math.max(0, morning) + Math.max(0, afternoon);
}

function calculateWeeklyHours({
  breakEnd,
  breakStart,
  days,
  end,
  start,
}: {
  breakEnd: string;
  breakStart: string;
  days: number;
  end: string;
  start: string;
}) {
  return minutesToDuration(calculateDailyMinutes({ breakEnd, breakStart, end, start }) * days);
}

function getJourneyAlert({
  breakEnd,
  breakStart,
  days,
  end,
  start,
}: {
  breakEnd: string;
  breakStart: string;
  days: number;
  end: string;
  start: string;
}) {
  const dailyMinutes = calculateDailyMinutes({ breakEnd, breakStart, end, start });
  const weeklyMinutes = dailyMinutes * days;

  if (dailyMinutes > 600) {
    return {
      tone: "critical",
      title: "Alerta critico",
      message: "Jornada acima de 10h no dia. Revisar antes de usar.",
    };
  }

  if (weeklyMinutes > 2640) {
    return {
      tone: "warning",
      title: "Possivel hora extra",
      message: "Carga semanal acima de 44h. Pode gerar hora extra.",
    };
  }

  if (dailyMinutes > 480) {
    return {
      tone: "attention",
      title: "Exige compensacao",
      message: "Passa de 8h por dia, mas fica ate 44h semanais.",
    };
  }

  return {
    tone: "ok",
    title: "Dentro da regra basica",
    message: "A jornada esta ate 8h por dia e ate 44h semanais.",
  };
}

function applyMask(value: string, mask: MaskType) {
  const masks = {
    name: maskName,
    cpf: maskCpf,
    cnpj: maskCnpj,
    phone: maskPhone,
    time: maskTime,
    pin: (current: string) => onlyDigits(current).slice(0, 6),
    date: maskDate,
    cep: maskCep,
  };

  return masks[mask](value);
}

function collectVisibleFormData() {
  const labels = Array.from(document.querySelectorAll("main label"));
  const fields: Record<string, string> = {};

  labels.forEach((label) => {
    const control = label.querySelector("input, select, textarea") as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
      | null;
    const labelText = Array.from(label.childNodes)
      .find((node) => node.nodeType === Node.TEXT_NODE)
      ?.textContent?.trim();

    if (control && labelText) {
      fields[labelText] = control.value;
    }
  });

  return fields;
}

function appendLocalRecord(action: string, section: Section, fields: Record<string, string>) {
  const key = "orquestracs-face-id-local-records";
  const current = JSON.parse(window.localStorage.getItem(key) || "[]") as unknown[];
  const record = {
    action,
    fields,
    id: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
    section,
  };

  window.localStorage.setItem(key, JSON.stringify([record, ...current]));
  return record;
}

function downloadTextFile(filename: string, content: string, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

type LocalRecord = {
  action: string;
  fields: Record<string, string>;
  id: string;
  savedAt: string;
  section: Section;
};

type PunchException = {
  currentTime: string;
  differenceMinutes: number;
  expectedTime: string;
  timingLabel: string;
};

type PunchLocation = NonNullable<Punch["location"]>;

type PunchContext = {
  deviceId?: string;
  externalReason?: string;
  location?: PunchLocation;
  origin?: "kiosk" | "external";
};

type ScheduledPunch = `Entrada ${1 | 2 | 3 | 4}` | `Saída ${1 | 2 | 3 | 4}`;

const scheduledPunchOrder: ScheduledPunch[] = Array.from({ length: 4 }, (_, index) => [
  `Entrada ${index + 1}` as ScheduledPunch,
  `Saída ${index + 1}` as ScheduledPunch,
]).flat();

function getSchedulePeriods(schedule?: LocalEmployee["schedule"]) {
  const configured = schedule?.periods?.filter((period) => period.start && period.end) || [];
  if (configured.length) return configured.slice(0, 4);
  return [
    { start: schedule?.start || "07:00", end: schedule?.breakStart || "11:30" },
    { start: schedule?.breakEnd || "13:00", end: schedule?.end || "17:15" },
  ];
}

function getPunchDeviceId() {
  const storageKey = "orquestracs-face-id-device-id";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;

  const created = `web-${crypto.randomUUID()}`;
  window.localStorage.setItem(storageKey, created);
  return created;
}

function capturePunchLocation(): Promise<PunchLocation> {
  if (!("geolocation" in navigator)) return Promise.resolve({ status: "unavailable" });

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        accuracy: Math.round(position.coords.accuracy),
        latitude: Number(position.coords.latitude.toFixed(6)),
        longitude: Number(position.coords.longitude.toFixed(6)),
        status: "captured",
      }),
      (error) => resolve({
        status: error.code === error.PERMISSION_DENIED
          ? "denied"
          : error.code === error.TIMEOUT
            ? "timeout"
            : "unavailable",
      }),
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 12000 },
    );
  });
}

function getLocalRecords() {
  return JSON.parse(
    window.localStorage.getItem("orquestracs-face-id-local-records") || "[]",
  ) as LocalRecord[];
}

function inferNextPunchFromHistory(
  punches: Array<Pick<Punch, "occurredAt" | "type" | "scheduledPunch">>,
  now = new Date(),
  schedule?: LocalEmployee["schedule"],
) {
  const orderedPunches = punches
    .map((punch) => ({ punch, date: punchDate(punch as Punch) }))
    .filter((item) => !Number.isNaN(item.date.getTime()))
    .sort((first, second) => first.date.getTime() - second.date.getTime())
    .map((item) => item);

  const completed = new Set<ScheduledPunch>();
  orderedPunches.forEach(({ punch, date }, index) => {
    if (punch.scheduledPunch && scheduledPunchOrder.includes(punch.scheduledPunch)) {
      completed.add(punch.scheduledPunch);
      return;
    }

    // Registros antigos não tinham a etapa da jornada. Recuperamos a etapa
    // pelo tipo e pelo horário para manter a sequência entre máquinas.
    const punchMinutes = date.getHours() * 60 + date.getMinutes();
    const periods = getSchedulePeriods(schedule);
    const isEntry = punch.type === "entry" || punch.type === "lunch_back";
    const periodIndex = periods.findIndex((period, periodNumber) => {
      const start = minutesFromTime(period.start);
      const end = minutesFromTime(period.end);
      const nextStart = periods[periodNumber + 1]
        ? minutesFromTime(periods[periodNumber + 1].start)
        : Number.POSITIVE_INFINITY;
      return isEntry
        ? punchMinutes >= start && punchMinutes < nextStart
        : punchMinutes > start && punchMinutes <= end;
    });
    const inferredIndex = periodIndex >= 0 ? periodIndex : Math.min(index, periods.length - 1);
    completed.add(`${isEntry ? "Entrada" : "Saída"} ${inferredIndex + 1}` as ScheduledPunch);
  });

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const periods = getSchedulePeriods(schedule);
  const stageOrder = scheduledPunchOrder.slice(0, periods.length * 2);
  const completedIndex = stageOrder.reduce(
    (highest, stage, index) => completed.has(stage) ? Math.max(highest, index) : highest,
    -1,
  );
  if (completedIndex >= stageOrder.length - 1) return null;
  if (completedIndex >= 0) return stageOrder[completedIndex + 1];

  const activePeriodIndex = periods.findIndex((period, index) => {
    const start = minutesFromTime(period.start);
    const nextStart = periods[index + 1]
      ? minutesFromTime(periods[index + 1].start)
      : Number.POSITIVE_INFINITY;
    return currentMinutes >= start && currentMinutes < nextStart;
  });
  if (activePeriodIndex >= 0) return `Entrada ${activePeriodIndex + 1}` as ScheduledPunch;
  if (currentMinutes < minutesFromTime(periods[0]?.start || "07:00")) return "Entrada 1";
  return null;
}

function inferNextPunch(employeeId: string, schedule?: LocalEmployee["schedule"]) {
  const today = new Date().toDateString();
  const punches = getLocalRecords()
    .filter((record) => {
      const timestamp = record.fields.Horário || record.savedAt;
      return (
        record.action.startsWith("Batida:") &&
        record.fields["ID do colaborador"] === employeeId &&
        new Date(timestamp).toDateString() === today
      );
    })
    .map((record) => ({
      occurredAt: new Date(record.fields.Horário || record.savedAt),
      scheduledPunch: scheduledPunchOrder.includes(record.fields.Tipo as ScheduledPunch)
        ? record.fields.Tipo as ScheduledPunch
        : undefined,
      type: mapPunchType(record.fields.Tipo || ""),
    }));

  return inferNextPunchFromHistory(punches, new Date(), schedule);
}

async function resolveNextPunch(employeeId: string, companyId: string, schedule?: LocalEmployee["schedule"]) {
  const localNextPunch = inferNextPunch(employeeId, schedule);

  try {
    const serverPunches = await listEmployeePunches(companyId, employeeId);
    const today = new Date();
    const todayPunches = serverPunches.filter((punch) => sameDay(punchDate(punch), today));
    return todayPunches.length
      ? inferNextPunchFromHistory(todayPunches, today, schedule)
      : localNextPunch;
  } catch (error) {
    console.warn("Não foi possível consultar a sequência real das batidas; usando o histórico local.", error);
    return localNextPunch;
  }
}

function minutesFromTime(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatDurationShort(totalMinutes: number) {
  const sign = totalMinutes < 0 ? "-" : "";
  const absolute = Math.abs(totalMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;

  if (!hours) return `${sign}${minutes} min`;
  if (!minutes) return `${sign}${hours}h`;
  return `${sign}${hours}h${String(minutes).padStart(2, "0")}`;
}

function formatDurationClock(totalMinutes: number) {
  const sign = totalMinutes < 0 ? "-" : "";
  const absolute = Math.abs(totalMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatDurationSpeech(totalMinutes: number) {
  const absolute = Math.abs(totalMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  const parts = [];

  if (hours) parts.push(`${hours} ${hours === 1 ? "hora" : "horas"}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? "minuto" : "minutos"}`);
  return parts.join(" e ") || "0 minuto";
}

function getPunchTiming(employee: RecognizedFace, punchType: string, bankHoursEnabled = true) {
  const schedule = employee.schedule || {
    breakEnd: "13:00",
    breakStart: "11:30",
    end: "17:15",
    start: "07:00",
    toleranceMinutes: 10,
  };
  const periods = getSchedulePeriods(schedule);
  const stage = scheduledPunchOrder.includes(punchType as ScheduledPunch)
    ? punchType as ScheduledPunch
    : "Entrada 1";
  const stageMatch = /^(Entrada|Saída) ([1-4])$/.exec(stage);
  const stagePeriod = stageMatch ? periods[Number(stageMatch[2]) - 1] : undefined;
  const expectedByPunch: Record<string, string> = {
    Entrada: schedule.start,
    "Entrada 1": schedule.start,
    "Saída almoço": schedule.breakStart,
    "Saída 1": schedule.breakStart,
    "Volta almoço": schedule.breakEnd,
    "Entrada 2": schedule.breakEnd,
    "Fim do dia": schedule.end,
    "Saída 2": schedule.end,
    ...Object.fromEntries(periods.flatMap((period, index) => [
      [`Entrada ${index + 1}`, period.start],
      [`Saída ${index + 1}`, period.end],
    ])),
  };
  const expectedTime = stagePeriod ? (stageMatch?.[1] === "Entrada" ? stagePeriod.start : stagePeriod.end) : expectedByPunch[punchType];
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const differenceMinutes = currentMinutes - minutesFromTime(expectedTime);
  const isExitPunch = punchType.startsWith("Saída") || punchType === "Fim do dia";
  const hasBankHours = bankHoursEnabled
    && isExitPunch
    && differenceMinutes > schedule.toleranceMinutes;
  const timingLabel = hasBankHours
    ? "Banco de horas"
    : Math.abs(differenceMinutes) <= schedule.toleranceMinutes
    ? "No horário"
      : differenceMinutes < 0
      ? isExitPunch
        ? "Saída antecipada"
        : "Entrada antecipada"
      : isExitPunch
        ? "Saída após o horário"
        : "Entrada atrasada";

  return {
    currentTime: now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    differenceMinutes,
    expectedTime,
    timingLabel,
    outsideTolerance: hasBankHours || Math.abs(differenceMinutes) > schedule.toleranceMinutes,
  };
}

function getLastEmployeePunch(employeeId: string) {
  return getLocalRecords()
    .filter(
      (record) =>
        record.action.startsWith("Batida:") &&
        record.fields["ID do colaborador"] === employeeId,
    )
    .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))[0];
}

export default function Home() {
  const [active, setActive] = useState<Section>("Painel");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarAutoCompact, setSidebarAutoCompact] = useState(false);
  const [sidebarAutoOverride, setSidebarAutoOverride] = useState<"collapsed" | "expanded" | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [accessLoading, setAccessLoading] = useState(true);
  const [accessError, setAccessError] = useState("");
  const [appAccess, setAppAccess] = useState<TenantAccess | null>(null);
  const [tenantAccesses, setTenantAccesses] = useState<TenantAccess[]>([]);
  const [currentDateTime, setCurrentDateTime] = useState("");
  const [companyProfile, setCompanyProfile] = useState<MainCompanyProfile | null>(null);
  const [weatherSnapshot, setWeatherSnapshot] = useState<WeatherSnapshot | null>(null);
  const [weatherCoordinates, setWeatherCoordinates] = useState<WeatherCoordinates | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [saasConfig, setSaasConfig] = useState<TenantSaasConfig | null>(null);
  const [tenantInvites, setTenantInvites] = useState<TenantInvite[]>([]);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginMessage, setLoginMessage] = useState("");
  const [notice, setNotice] = useState("Sistema pronto. Cadastre empresa, usuarios e colaboradores para iniciar.");
  const [pin, setPin] = useState("");
  const [lastPunchReceipt, setLastPunchReceipt] = useState<RepPunchReceipt | null>(null);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("convite");
    if (code) setInviteCode(code.trim().toUpperCase());
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 901px) and (max-width: 1180px)");
    const syncSidebarMode = () => {
      setSidebarAutoCompact(mediaQuery.matches);
      setSidebarAutoOverride(null);
    };

    syncSidebarMode();
    mediaQuery.addEventListener?.("change", syncSidebarMode);
    return () => mediaQuery.removeEventListener?.("change", syncSidebarMode);
  }, []);

  async function refreshCompanyProfile(companyId: string) {
    if (!companyId) {
      setCompanyProfile(null);
      return;
    }

    const company = companyId === "main" ? await getMainCompany() : await getCompany(companyId);
    if (company) {
      setCompanyProfile(company as MainCompanyProfile);
      return;
    }

    setCompanyProfile(null);
    setNotice("Cadastre os dados reais da empresa para iniciar. Nenhum dado demonstrativo foi criado.");
  }

  async function refreshAccess(currentUser: User) {
    setAccessLoading(true);
    setAccessError("");
    setCompanyProfile(null);
    setTenantInvites([]);
    setSaasConfig(null);
    try {
      const access = await Promise.race([
        getUserTenantAccesses(currentUser),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error("access-timeout")), 10000);
        }),
      ]);
      setTenantAccesses(access);
      const rememberedTenantId = window.localStorage.getItem(`orquestracs-active-tenant:${currentUser.uid}`);
      const selectedAccess = access.find((item) => item.tenantId === rememberedTenantId) || access[0] || null;
      setAppAccess(selectedAccess);
      if (selectedAccess) {
        window.localStorage.setItem(`orquestracs-active-tenant:${currentUser.uid}`, selectedAccess.tenantId);
        void refreshCompanyProfile(selectedAccess.tenantId);
      } else {
        setCompanyProfile(null);
      }
      if (selectedAccess) {
        const invitesPromise = listTenantInvites(selectedAccess.tenantId);
        const configPromise = selectedAccess.role === "developer"
          ? getTenantSaasConfig(selectedAccess.tenantId)
          : Promise.resolve(null);
        const [invites, config] = await Promise.all([invitesPromise, configPromise]);
        setTenantInvites(invites);
        if (config) setSaasConfig(config);
      }
    } catch (error) {
      console.error(error);
      setAppAccess(null);
      setTenantAccesses([]);
      setAccessError("Nao foi possivel carregar as permissoes agora. Verifique sua conexao e tente novamente.");
    } finally {
      setAccessLoading(false);
    }
  }

  useEffect(() => {
    function refreshClock() {
      setCurrentDateTime(
        new Intl.DateTimeFormat("pt-BR", {
          dateStyle: "short",
          timeStyle: "medium",
        }).format(new Date()),
      );
    }

    refreshClock();
    const timer = window.setInterval(refreshClock, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void setPersistence(auth, browserLocalPersistence);
    return onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
      if (currentUser) {
        void refreshAccess(currentUser);
      } else {
        setAppAccess(null);
        setTenantAccesses([]);
        setCompanyProfile(null);
        setAccessLoading(false);
      }
    });
  }, []);

  useEffect(() => {
    const address = (companyProfile?.address || {}) as Record<string, unknown>;
    const city = String(address.city || "").trim();
    const state = String(address.state || "").trim();
    if (!city && !weatherCoordinates) {
      return;
    }

    const controller = new AbortController();
    let mounted = true;

    async function loadWeather() {
      setWeatherLoading(true);
      try {
        const params = new URLSearchParams();
        if (city) params.set("city", city);
        if (state) params.set("state", state);
        if (weatherCoordinates) {
          params.set("latitude", String(weatherCoordinates.latitude));
          params.set("longitude", String(weatherCoordinates.longitude));
        }
        const response = await fetch(`/api/weather?${params.toString()}`, { signal: controller.signal });
        const data = (await response.json()) as WeatherSnapshot;
        if (mounted) setWeatherSnapshot(data.available ? data : null);
      } catch (error) {
        if ((error as { name?: string }).name !== "AbortError") console.error(error);
        if (mounted) setWeatherSnapshot(null);
      } finally {
        if (mounted) setWeatherLoading(false);
      }
    }

    void loadWeather();
    const refresh = window.setInterval(() => void loadWeather(), 15 * 60 * 1000);
    return () => {
      mounted = false;
      controller.abort();
      window.clearInterval(refresh);
    };
  }, [companyProfile, weatherCoordinates]);

  useEffect(() => {
    if (!companyProfile || typeof window === "undefined" || !navigator.geolocation) return;
    if (window.sessionStorage.getItem("orquestracs-weather-location-requested") === "1") return;

    window.sessionStorage.setItem("orquestracs-weather-location-requested", "1");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setWeatherCoordinates({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      (error) => {
        if (error.code !== error.PERMISSION_DENIED) console.warn("Current location unavailable", error.message);
      },
      { enableHighAccuracy: false, maximumAge: 15 * 60 * 1000, timeout: 8000 },
    );
  }, [companyProfile]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setAuthLoading((loading) => {
        if (loading) {
          setLoginMessage("A inicializacao demorou. Atualize a pagina para tentar novamente.");
        }
        return false;
      });
    }, 8000);

    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    getRedirectResult(auth)
      .then((result) => {
        if (result?.user) {
          setUser(result.user);
          setLoginMessage("");
        }
      })
      .catch((error: { code?: string; message?: string }) => {
        console.error(error);
        setLoginMessage(`Erro no Google: ${error.code || error.message || "falha ao autenticar"}.`);
      })
      .finally(() => setAuthLoading(false));
  }, []);

  async function handleLogin() {
    setLoginMessage("Entrando...");
    try {
      await signInWithEmailAndPassword(auth, loginEmail, loginPassword);
      setLoginPassword("");
      setLoginMessage("");
    } catch (error) {
      console.error(error);
      setLoginMessage("Nao foi possivel entrar. Confira e-mail e senha.");
    }
  }

  async function handleGoogleLogin() {
    setLoginMessage("Abrindo login do Google...");
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await setPersistence(auth, browserLocalPersistence);
      await signInWithPopup(auth, provider);
      setLoginMessage("");
    } catch (error: unknown) {
      console.error(error);
      const authError = error as { code?: string; message?: string };
      if (authError.code === "auth/popup-blocked" || authError.code === "auth/cancelled-popup-request") {
        setLoginMessage("Popup bloqueado. Permita popups para faceid.orquestracs.com e tente novamente.");
        return;
      }

      if (authError.code === "auth/popup-closed-by-user") {
        setLoginMessage("Login Google cancelado antes de concluir.");
        return;
      }

      try {
        setLoginMessage("Popup indisponivel. Redirecionando para o Google...");
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        await signInWithRedirect(auth, provider);
      } catch (redirectError: unknown) {
        const redirectAuthError = redirectError as { code?: string; message?: string };
        setLoginMessage(
          `Erro no Google: ${redirectAuthError.code || authError.code || redirectAuthError.message || "falha ao iniciar login"}.`,
        );
      }
    }
  }

  async function handleLogout() {
    await signOut(auth);
  }

  async function handleKioskExit(method: "google" | "password", password = "") {
    if (!user) return "Sessão do responsável não encontrada.";

    try {
      if (method === "google") {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        await reauthenticateWithPopup(user, provider);
      } else {
        if (!user.email || !password.trim()) return "Informe a senha da conta responsável.";
        const credential = EmailAuthProvider.credential(user.email, password);
        await reauthenticateWithCredential(user, credential);
      }

      setActive("Painel");
      setNotice("Sala de ponto encerrada pelo responsável autenticado.");
      return "";
    } catch (error) {
      console.error(error);
      const authError = error as { code?: string };
      switch (authError.code) {
        case "auth/unauthorized-domain":
          return "Este endereço não está autorizado no Firebase Authentication. Adicione localhost aos domínios autorizados e tente novamente.";
        case "auth/popup-blocked":
          return "O navegador bloqueou a janela do Google. Permita pop-ups para este endereço e tente novamente.";
        case "auth/popup-closed-by-user":
        case "auth/cancelled-popup-request":
          return "A confirmação do Google foi cancelada. Tente novamente e conclua a seleção da conta.";
        case "auth/wrong-password":
        case "auth/invalid-credential":
          return "A senha não confere com a conta responsável conectada.";
        case "auth/requires-recent-login":
          return "Por segurança, entre novamente na conta responsável e depois saia do modo quiosque.";
        case "auth/network-request-failed":
          return "A confirmação falhou por instabilidade de rede. Confira a conexão e tente novamente.";
        default:
          return `Não foi possível confirmar a conta responsável${authError.code ? ` (${authError.code})` : ""}. Confira o método de acesso e tente novamente.`;
      }
    }
  }

  async function saveAuthenticationPreferences(preferences: AuthenticationPreference) {
    const payload = { authenticationPreferences: preferences };
    if (activeCompanyId === "main") await saveMainCompany(payload);
    else await saveTenantCompany(activeCompanyId, payload);
    await refreshCompanyProfile(activeCompanyId);
    setNotice("Preferencias de identificacao salvas para esta empresa.");
  }

  async function handleAcceptInvite() {
    if (!user) return;
    setLoginMessage("Validando convite...");
    try {
      const access = await acceptTenantInvite(inviteCode, user);
      setAppAccess(access);
      setTenantAccesses((current) => current.some((item) => item.tenantId === access.tenantId) ? current : [...current, access]);
      setCompanyProfile(null);
      window.localStorage.setItem(`orquestracs-active-tenant:${user.uid}`, access.tenantId);
      void refreshCompanyProfile(access.tenantId);
      void listTenantInvites(access.tenantId).then(setTenantInvites);
      setLoginMessage("");
      setNotice(`Acesso liberado para ${access.companyName}.`);
    } catch (error) {
      console.error(error);
      const inviteError = error as { code?: string; message?: string };
      setLoginMessage(inviteError.message === "invite-email-mismatch"
        ? "Este convite foi emitido para outro e-mail. Entre com a conta convidada e tente novamente."
        : inviteError.code === "permission-denied"
          ? "Não foi possível validar o convite para esta conta. Confira o e-mail convidado e as permissões da empresa."
          : "Convite inválido, expirado ou já utilizado.");
    }
  }

  function handleTenantChange(tenantId: string) {
    const nextAccess = tenantAccesses.find((item) => item.tenantId === tenantId);
    if (!nextAccess || nextAccess.tenantId === appAccess?.tenantId) return;

    setAppAccess(nextAccess);
    setCompanyProfile(null);
    setWeatherSnapshot(null);
    setWeatherCoordinates(null);
    setTenantInvites([]);
    setSaasConfig(null);
    setActive("Painel");
    setMobileMenuOpen(false);
    if (user) window.localStorage.setItem(`orquestracs-active-tenant:${user.uid}`, nextAccess.tenantId);
    void refreshCompanyProfile(nextAccess.tenantId);
    void listTenantInvites(nextAccess.tenantId).then(setTenantInvites);
    if (nextAccess.role === "developer") void getTenantSaasConfig(nextAccess.tenantId).then(setSaasConfig);
  }

  const title = useMemo(() => {
    const subtitles: Record<Section, string> = {
      Painel: "Visao geral da operacao",
      Empresa: "Cadastro e configuracao do CNPJ do sistema",
      Colaboradores: "Equipe, documentos, jornadas e biometria",
      "Sala de ponto": "Tablet de reconhecimento facial",
      "Ponto externo": "Registro autorizado pelo celular",
      Batidas: "Registro por PIN, foto e evidencias",
      "Banco de horas": "Saldos, faltantes, extras e abonos",
      "Fechamento mensal": "Conferencia mensal para contador",
      Relatorios: "Espelho de ponto e jornada detalhada",
      "LGPD e auditoria": "Consentimento, logs e trilha inviolavel",
      Configuracoes: "Metodos de identificacao e dispositivos",
      Admin: "Controle interno, convites e permissoes",
    };

    return subtitles[active];
  }, [active]);

  function go(section: Section) {
    setActive(section);
    setMobileMenuOpen(false);
    setNotice(`Tela "${section}" aberta.`);
  }

  async function demoAction(action: string, overrideFields: Record<string, string> = {}) {
    const fields = { ...collectVisibleFormData(), ...overrideFields };
    appendLocalRecord(action, active, fields);

    if (action === "Cadastro da empresa principal") {
      const cnpj = fields.CNPJ?.replace(/\D/g, "") || "";
      if (cnpj.length !== 14) {
        setNotice("CNPJ incompleto. Preencha 14 digitos antes de salvar.");
        return;
      }

      try {
        const companyData = {
          address: {
            city: fields.Cidade || "",
            complement: fields.Complemento || "",
            district: fields.Bairro || "",
            number: fields.Numero || "",
            state: fields.UF || "",
            street: fields.Logradouro || "",
            zipCode: fields.CEP || "",
          },
          cnpj: fields.CNPJ || "",
          contactEmail: fields["E-mail"] || "",
          contactName: fields.Responsavel || "",
          contactPhone: fields.Celular || "",
          legalName: fields["Razao social"] || "",
          stateRegistration: fields["Inscricao estadual"] || "",
          tradeName: fields["Nome fantasia"] || "",
        };
        if (activeCompanyId === "main") await saveMainCompany(companyData);
        else await saveTenantCompany(activeCompanyId, companyData);
        await refreshCompanyProfile(activeCompanyId);
        setNotice(`Empresa salva no Firebase em companies/${activeCompanyId}.`);
      } catch (error) {
        console.error(error);
        setNotice("Nao foi possivel salvar no Firebase. Verifique Auth/Regras do Firestore.");
      }
      return;
    }

    if (action === "Politica de calculo da empresa") {
      try {
        const workPolicy = {
          workPolicy: {
            absenceMode: fields["Tipo de controle"] === "Por dia" ? "day" : "period",
            afternoonAbsenceWeight: Number(fields["Valor falta tarde"] || DEFAULT_WORK_POLICY.afternoonAbsenceWeight),
            bankHoursEnabled: fields["Banco de horas"] !== "Inativo",
            externalWorkPolicy: fields["Trabalho externo"] || DEFAULT_WORK_POLICY.externalWorkPolicy,
            forgottenPunchPolicy: fields["Aprovacao de ajuste"] || DEFAULT_WORK_POLICY.forgottenPunchPolicy,
            fullDayAbsenceWeight: Number(fields["Valor falta dia inteiro"] || DEFAULT_WORK_POLICY.fullDayAbsenceWeight),
            morningAbsenceWeight: Number(fields["Valor falta manha"] || DEFAULT_WORK_POLICY.morningAbsenceWeight),
            scheduledDays: Number(fields["Dias por semana"] || DEFAULT_WORK_POLICY.scheduledDays),
            toleranceMinutes: Number.parseInt(fields["Tolerancia padrao"] || "", 10) || DEFAULT_WORK_POLICY.toleranceMinutes,
          },
        };
        if (activeCompanyId === "main") await saveMainCompany(workPolicy);
        else await saveTenantCompany(activeCompanyId, workPolicy);
        await refreshCompanyProfile(activeCompanyId);
        setNotice("Politica de calculo salva para esta empresa.");
      } catch (error) {
        console.error(error);
        setNotice("Nao foi possivel salvar a politica de calculo.");
      }
      return;
    }

    if (action === "Escala coletiva da empresa") {
      const defaultSchedule = {
        breakEnd: fields["Entrada 2"] || "13:00",
        breakStart: fields["Saída 1"] || "11:30",
        end: fields["Saída 2"] || "17:15",
        name: fields["Nome da escala"] || "Jornada padrão da empresa",
        periods: Array.from({ length: 4 }, (_, index) => ({
          start: fields[`Entrada ${index + 1}`] || "",
          end: fields[`Saída ${index + 1}`] || "",
        })).filter((period) => period.start && period.end),
        start: fields["Entrada 1"] || "07:00",
        bankHoursEnabled: fields["Banco de horas"] !== "Inativo",
        workDaysPerWeek: Number(fields["Dias por semana"] || 5),
      };
      const invalidPeriods = defaultSchedule.periods.some((period) =>
        !/^\d{2}:\d{2}$/.test(period.start)
        || !/^\d{2}:\d{2}$/.test(period.end)
        || timeToMinutes(period.end) <= timeToMinutes(period.start),
      );
      if (invalidPeriods || defaultSchedule.periods.length === 0) {
        setNotice("Configure pelo menos um período completo, com a saída depois da entrada.");
        return;
      }
      try {
          const payload = {
            defaultSchedule,
            workPolicy: {
              ...getCompanyWorkPolicy(companyProfile),
              bankHoursEnabled: defaultSchedule.bankHoursEnabled,
              scheduledDays: defaultSchedule.workDaysPerWeek,
              toleranceMinutes: Number.parseInt(fields["Tolerancia padrao"] || "", 10) || DEFAULT_WORK_POLICY.toleranceMinutes,
            },
          };
        if (activeCompanyId === "main") await saveMainCompany(payload);
        else await saveTenantCompany(activeCompanyId, payload);
        await refreshCompanyProfile(activeCompanyId);
        setNotice("Escala coletiva salva e definida como padrão para novos colaboradores.");
      } catch (error) {
        console.error(error);
        setNotice("Não foi possível salvar a escala coletiva. Verifique as permissões da empresa.");
      }
      return;
    }

    if (action === "Previa da jornada coletiva") {
      const periods = Array.from({ length: 4 }, (_, index) => ({
        start: fields[`Entrada ${index + 1}`] || "",
        end: fields[`Saída ${index + 1}`] || "",
      })).filter((period) => period.start && period.end);
      setNotice(`Prévia: ${periods.map((period, index) => `Entrada ${index + 1} ${period.start} / Saída ${index + 1} ${period.end}`).join(" · ")}. Jornada de ${fields["Dias por semana"] || "5"} dias.`);
      return;
    }

    if (action === "Convite por e-mail") {
      try {
        const email = String(fields.Email || "").trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          setNotice("Informe um e-mail válido para vincular o convite à pessoa certa.");
          return;
        }
        const roleByLabel: Record<string, "owner" | "admin" | "reader"> = {
          Administrador: "admin",
          Leitor: "reader",
          Proprietario: "owner",
        };
        const invite = await createTenantInvite({
          companyName: fields.Cliente || fields.Empresa || String(companyProfile?.tradeName || companyProfile?.legalName || "Empresa convidada"),
          email,
          role: roleByLabel[fields.Perfil || fields.Permissao || "Proprietario"] || "owner",
          tenantId: activeCompanyId,
        });
        const invites = await listTenantInvites(activeCompanyId);
        setTenantInvites(invites);
        const inviteUrl = new URL(window.location.origin);
        inviteUrl.searchParams.set("convite", invite.code);
        setNotice(`Convite criado para ${email}: ${invite.code}. Envie também o link ${inviteUrl.toString()}`);
      } catch (error) {
        console.error(error);
        const code = (error as { code?: string }).code || "";
        setNotice(code.includes("permission-denied")
          ? "Seu perfil não tem permissão para convidar usuários nesta empresa. Peça ao proprietário para verificar seu acesso."
          : "Não foi possível criar o convite. Confira o e-mail e tente novamente.");
      }
      return;
    }

    if (action === "Salvar configuracao Admin SaaS") {
      const tenantId = activeCompanyId;
      const config = {
        aiCredits: {
          balance: Number(onlyDigits(fields["Creditos disponiveis"] || fields["Creditos mensais"] || "150")) || 150,
          bonus: 0,
          included: Number(onlyDigits(fields["Creditos mensais"] || "150")) || 150,
          renewalMonth: new Date().toISOString().slice(0, 7),
          status: fields["Status IA"] === "Bloqueado" ? "Bloqueado" as const : "Ativo" as const,
          used: Number(onlyDigits(fields["Creditos usados"] || "0")) || 0,
        },
        billing: {
          amount: fields.Mensalidade || "R$ 0,00",
          dueDate: fields.Vencimento || "",
          graceDays: Number(onlyDigits(fields["Bloqueio apos"] || "5")) || 5,
          status: (fields["Status pagamento"] || "Teste") as TenantSaasConfig["billing"]["status"],
        },
        employeeLimit: Number(onlyDigits(fields["Limite funcionarios"] || "25")) || 25,
        name: fields.Cliente || String(companyProfile?.tradeName || companyProfile?.legalName || "Cliente Face ID"),
        plan: (fields.Plano || "Essencial") as TenantSaasConfig["plan"],
        status: (fields["Status cliente"] || "Teste") as TenantSaasConfig["status"],
      };

      await saveTenantSaasConfig(tenantId, config);
      setSaasConfig({ ...config, tenantId });
      setNotice(`Configuracao SaaS salva em tenants/${tenantId}.`);
      return;
    }

    if (action === "Upload de logo da empresa" || action === "Anexo de comprovante") {
      document.getElementById("local-file-picker")?.click();
      setNotice(`${action}: selecione um arquivo para anexar em modo local.`);
      return;
    }

    if (action === "Backup local completo") {
      downloadTextFile(
        `backup-orquestracs-face-id-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            mode: "local-backup",
            records: getLocalRecords(),
            system: "Orquestracs Face ID",
          },
          null,
          2,
        ),
        "application/json",
      );
      setNotice("Backup local gerado em JSON com os registros salvos neste navegador.");
      return;
    }

    if (action === "Geracao de PDF") {
      const printWindow = window.open("", "_blank", "width=1100,height=800");
      if (!printWindow) {
        setNotice("O navegador bloqueou a janela do PDF. Permita pop-ups para este site e tente novamente.");
        return;
      }
      openPrintableDataReport({ company: companyProfile, fields, printWindow, title: "Relatório de jornada" });
      setNotice("PDF do relatório aberto. Na janela de impressão, escolha Salvar como PDF.");
      return;
    }

    if (action === "Exportacao fiscal") {
      const printWindow = window.open("", "_blank", "width=1100,height=800");
      if (!printWindow) {
        setNotice("O navegador bloqueou a janela do PDF. Permita pop-ups para este site e tente novamente.");
        return;
      }
      openPrintableDataReport({ company: companyProfile, fields, printWindow, title: "Resumo de exportação fiscal" });
      setNotice("PDF fiscal aberto. Os arquivos AFD/AEJ técnicos continuam disponíveis na aba Relatórios.");
      return;
    }

    if (action === "Folha mensal para contador") {
      const printWindow = window.open("", "_blank", "width=1100,height=800");
      if (!printWindow) {
        setNotice("O navegador bloqueou a janela do PDF. Permita pop-ups para este site e tente novamente.");
        return;
      }
      openPrintableDataReport({ company: companyProfile, fields, printWindow, rows: monthlyClosingRows, title: "Folha mensal para contador" });
      setNotice("PDF da folha mensal aberto. Na janela de impressão, escolha Salvar como PDF.");
      return;
    }

    if (action === "Ficha individual de ciencia") {
      const printWindow = window.open("", "_blank", "width=1100,height=800");
      if (!printWindow) {
        setNotice("O navegador bloqueou a janela do PDF. Permita pop-ups para este site e tente novamente.");
        return;
      }
      openPrintableDataReport({ company: companyProfile, fields, printWindow, title: "Ficha individual de ciência" });
      setNotice("PDF da ficha individual aberto.");
      return;
    }

    if (action === "Termo LGPD" || action === "Relatorio de impacto") {
      const printWindow = window.open("", "_blank", "width=1100,height=800");
      if (!printWindow) {
        setNotice("O navegador bloqueou a janela do PDF. Permita pop-ups para este site e tente novamente.");
        return;
      }
      openPrintableDataReport({ company: companyProfile, fields, printWindow, title: action });
      setNotice("PDF do documento aberto.");
      return;
    }

    if (action === "Validacao de CNPJ") {
      const cnpj = fields.CNPJ?.replace(/\D/g, "") || "";
      setNotice(
        cnpj.length === 14
          ? "CNPJ com formato valido. Validacao oficial sera conectada depois."
          : "CNPJ incompleto. Preencha 14 digitos.",
      );
      return;
    }

    setNotice(action);
  }

  async function registerPunch(
    kind: string,
    employee?: RecognizedFace,
    exception?: PunchException,
    photoBlob?: Blob,
    context: PunchContext = {},
  ) {
    if (!employee && !pin.trim()) {
      setNotice("Informe o PIN do colaborador.");
      return false;
    }

    const occurredAt = new Date();
    let employeeName = employee?.name || "";
    let employeeId = employee?.employeeId || "";

    if (!employee) {
      try {
        const verified = await verifyEmployeePin(activeCompanyId, pin.trim());
        employeeName = verified.name;
        employeeId = verified.employeeId;
      } catch (error) {
        console.error(error);
        setNotice("PIN nao reconhecido. Confira os numeros ou procure o responsavel.");
        return false;
      }
    }
    const punchId = crypto.randomUUID();
    let photoPath = employee ? "face-id-local-profile" : "pending-storage-photo";

    if (photoBlob) {
      try {
        photoPath = await uploadPunchPhoto({
          blob: photoBlob,
          companyId: activeCompanyId,
          employeeId,
          occurredAt,
          punchId,
        });
      } catch (error) {
        console.error(error);
        setNotice("A foto nao foi salva no Storage. A batida continuara com evidencia pendente.");
      }
    }

    const external = context.origin === "external";
    const punchPayload = {
      deviceId: context.deviceId || getPunchDeviceId(),
      employeeId,
      externalReason: context.externalReason || "",
      location: context.location || { status: "unavailable" as const },
      origin: external ? "external" as const : "kiosk" as const,
      photoPath,
      source: employee
        ? external ? "external_face_id" as const : "face_id" as const
        : external ? "external_pin_photo" as const : "pin_photo" as const,
      scheduledPunch: kind as ScheduledPunch,
      type: mapPunchType(kind),
    };

    try {
      const registered = await registerRepPunch({
        companyId: activeCompanyId,
        idempotencyKey: `${activeCompanyId}:${employeeId}:${punchId}`,
        ...punchPayload,
      });
      setLastPunchReceipt(registered.receipt);
      appendLocalRecord("Comprovante de ponto", external ? "Ponto externo" : "Sala de ponto", {
        Hash: registered.receipt.hash,
        NSR: String(registered.receipt.nsr),
        "Modo de conformidade": registered.complianceMode,
        "Pendencias cadastrais": registered.missingFields.join(", ") || "Nenhuma",
      });
      setNotice(
        `${employeeName}: ${kind.toLowerCase()} registrada. NSR ${registered.receipt.nsr}.` +
        (registered.missingFields.length
          ? ` Piloto: regularize ${registered.missingFields.join(", ")}.`
          : ""),
      );
    } catch (error) {
      console.error(error);
      setNotice("Nao foi possivel salvar a batida no Firebase. Verifique a conexao e tente novamente.");
      return false;
    }

    appendLocalRecord(`Batida: ${kind}`, external ? "Ponto externo" : "Sala de ponto", {
      Colaborador: employeeName,
      "ID do colaborador": employeeId,
      Horário: occurredAt.toISOString(),
      Método: employee ? "Face ID" : "PIN + foto",
      Origem: external ? "Externa" : "Sala de ponto",
      Localização: context.location?.status || "Nao solicitada",
      Tipo: kind,
      ...(exception
        ? {
            "Confirmação de exceção": "Sim",
            "Diferença": formatDurationClock(exception.differenceMinutes),
            "Classificação": exception.timingLabel,
            "Horário previsto": exception.expectedTime,
          }
        : {}),
    });
    setPin("");
    return true;
  }

  if (authLoading) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f4f6f8] px-4 text-[#17202a]">
        <div className="rounded-lg border border-[#d9e0e7] bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold text-[#26323f]">Carregando acesso...</p>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="login-screen">
        <section className="login-visual" aria-label="Orquestracs Face ID">
          <img alt="" className="login-visual-image" src="/login-face-id-hero.png" />
          <div className="login-visual-content">
            <img
              alt="Orquestracs Face ID"
              className="login-visual-logo"
              src="/orquestracs-face-id-wordmark.svg"
            />
            <p className="login-visual-kicker">CONTROLE DE JORNADA</p>
            <h1>Reconhecimento que acompanha a sua operação.</h1>
            <p className="login-visual-description">
              Registre cada período da jornada com agilidade, segurança e rastreabilidade.
            </p>
            <div className="login-visual-methods" aria-label="Formas de identificação e controle">
              <div className="login-visual-method">
                <span className="login-method-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M7 21H5a2 2 0 0 1-2-2v-2M17 21h2a2 2 0 0 0 2-2v-2" />
                    <circle cx="12" cy="11" r="4.2" />
                    <path d="M9.8 16.5c.7.5 1.4.7 2.2.7s1.5-.2 2.2-.7" />
                  </svg>
                </span>
                <span><strong>Face ID</strong><small>Rosto</small></span>
              </div>
              <div className="login-visual-method">
                <span className="login-method-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M12 4.2a6.1 6.1 0 0 0-6.1 6.1M12 7.2a3.1 3.1 0 0 0-3.1 3.1M12 4.2a6.1 6.1 0 0 1 6.1 6.1c0 4.1-1.1 6.9-2.7 9.2M12 10.3c0 4.8-.8 7.4-2.6 9.6M12 7.2a3.1 3.1 0 0 1 3.1 3.1c0 2.4-.4 4.3-1.1 6.1M5.9 10.3c0 3.2.6 5.3 1.8 7M18.1 10.3c0 1-.1 1.9-.3 2.7" />
                  </svg>
                </span>
                <span><strong>Digital</strong><small>Biometria</small></span>
              </div>
              <div className="login-visual-method">
                <span className="login-method-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M20 10c0 5.5-8 11-8 11S4 15.5 4 10a8 8 0 1 1 16 0Z" />
                    <circle cx="12" cy="10" r="2.5" />
                  </svg>
                </span>
                <span><strong>Local</strong><small>Geolocalização</small></span>
              </div>
            </div>
          </div>
        </section>

        <section className="login-form-shell">
          <div className="login-form-card">
            <div className="login-form-heading">
              <p className="login-form-kicker">ACESSO SEGURO</p>
              <h2>Entrar no sistema</h2>
              <p>Acesso restrito para usuários convidados da empresa.</p>
            </div>

            <div className="login-form-fields">
              <Field label="E-mail">
                <input
                  className="input"
                  onChange={(event) => setLoginEmail(event.target.value)}
                  placeholder="usuario@empresa.com"
                  type="email"
                  value={loginEmail}
                />
              </Field>
              <Field label="Senha">
                <input
                  className="input"
                  onChange={(event) => setLoginPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleLogin();
                  }}
                  placeholder="Sua senha"
                  type="password"
                  value={loginPassword}
                />
              </Field>
              <button className="primary-button" onClick={handleLogin} type="button">
                Entrar
              </button>
              <button className="google-button" onClick={handleGoogleLogin} type="button">
                <span className="google-mark">G</span>
                Entrar com Google
              </button>
              {loginMessage && (
                <p className="rounded-md border border-[#efd9a8] bg-[#fff8e9] p-3 text-sm font-semibold text-[#8a5a00]">
                  {loginMessage}
                </p>
              )}
            </div>

            <p className="login-form-footer">Ambiente protegido pela Orquestracs.</p>
          </div>
        </section>
      </main>
    );
  }

  if (accessLoading) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f4f6f8] px-4 text-[#17202a]">
        <div className="rounded-lg border border-[#d9e0e7] bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold text-[#26323f]">Carregando permissoes...</p>
        </div>
      </main>
    );
  }

  if (accessError) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f4f6f8] px-4 text-[#17202a]">
        <section className="w-full max-w-md rounded-lg border border-[#efd9a8] bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a5a00]">Orquestracs Face ID</p>
          <h1 className="mt-2 text-2xl font-semibold text-[#101923]">Acesso temporariamente indisponivel</h1>
          <p className="mt-3 text-sm leading-6 text-[#667085]">{accessError}</p>
          <button className="primary-button mt-5 w-full" onClick={() => window.location.reload()} type="button">
            Tentar novamente
          </button>
        </section>
      </main>
    );
  }

  if (!appAccess && !isPlatformOwnerEmail(user.email)) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f4f6f8] px-4 text-[#17202a]">
        <section className="w-full max-w-md rounded-lg border border-[#d9e0e7] bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#2d6c5d]">
            Orquestracs Face ID
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-[#101923]">Ativar convite</h1>
          <p className="mt-2 text-sm leading-6 text-[#667085]">
            Informe o codigo enviado pela Orquestracs para liberar o acesso da empresa.
          </p>
          <div className="mt-6 grid gap-3">
            <Field label="Codigo do convite">
              <input
                className="input uppercase"
                onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
                placeholder="FACE1234"
                value={inviteCode}
              />
            </Field>
            <button className="primary-button" onClick={handleAcceptInvite} type="button">
              Ativar acesso
            </button>
            <button className="secondary-button" onClick={handleLogout} type="button">
              Sair
            </button>
            {loginMessage && (
              <p className="rounded-md border border-[#efd9a8] bg-[#fff8e9] p-3 text-sm font-semibold text-[#8a5a00]">
                {loginMessage}
              </p>
            )}
          </div>
        </section>
      </main>
    );
  }

  const isDeveloperUser = appAccess?.role === "developer" || isPlatformOwnerEmail(user.email);
  const activeCompanyId = appAccess?.tenantId || (isPlatformOwnerEmail(user.email) ? "main" : "");
  const canManage = isDeveloperUser || appAccess?.role === "owner" || appAccess?.role === "admin";
  const readerSections: Section[] = [
    "Painel",
    "Empresa",
    "Colaboradores",
    "Banco de horas",
    "Relatorios",
    "LGPD e auditoria",
    "Configuracoes",
  ];
  const visibleNavItems = navItems.filter((item) =>
    (item !== "Admin" || isDeveloperUser)
    && (canManage || readerSections.includes(item)),
  );
  const companyName =
    companyProfile?.tradeName || companyProfile?.legalName || "Empresa principal";
  const companyCnpj = companyProfile?.cnpj || "CNPJ nao cadastrado";
  const headerMoment = new Date();
  const headerDaypart = getDaypart(headerMoment);
  const headerWeather = getWeatherVisual(headerDaypart, weatherSnapshot, weatherLoading);
  const headerDate = headerMoment.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "long",
    weekday: "long",
  });
  const headerTime = headerMoment.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const kioskMode = active === "Sala de ponto";
  const centralAdminMode = active === "Admin" && isDeveloperUser;
  const sidebarIsCollapsed = sidebarAutoOverride === "expanded"
    ? false
    : sidebarAutoOverride === "collapsed"
      ? true
      : sidebarCollapsed || sidebarAutoCompact;
  const toggleSidebar = () => {
    if (sidebarAutoCompact) {
      setSidebarAutoOverride(sidebarIsCollapsed ? "expanded" : "collapsed");
      return;
    }
    setSidebarCollapsed((collapsed) => !collapsed);
  };
  const companyAddress = (companyProfile?.address || {}) as Record<string, string>;
  const kioskLocation = weatherSnapshot?.source === "current"
    ? "Localização atual"
    : [companyAddress.city, companyAddress.state].filter(Boolean).join(" - ") || "Local da empresa";
  const canExitKioskWithPassword = Boolean(user.providerData.some((provider) => provider.providerId === "password"));
  const canExitKioskWithGoogle = Boolean(user.providerData.some((provider) => provider.providerId === "google.com"));

  return (
    <TenantIdContext.Provider value={activeCompanyId}>
      <main className={`app-shell min-h-screen overflow-x-hidden text-[#17202a] ${kioskMode ? "kiosk-app-shell" : "bg-[#f4f6f8]"}`}>
      <div className={`sticky top-0 z-30 border-b border-[#d9e0e7] bg-white/95 px-3 py-2 shadow-sm backdrop-blur lg:hidden ${kioskMode ? "hidden" : ""}`}>
        <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-3">
          <button
            aria-expanded={mobileMenuOpen}
            aria-label="Abrir menu principal"
            className="mobile-menu-button"
            onClick={() => setMobileMenuOpen(true)}
            type="button"
          >
            <span />
            <span />
            <span />
          </button>
          <div className="app-mobile-brand min-w-0 flex-1">
            <img
              alt="Orquestracs Face ID"
              className="app-brand-wordmark-light"
              src="/orquestracs-face-id-wordmark-light.svg"
            />
            <div className="min-w-0">
              <p className="truncate text-xs text-[#667085]">{title}</p>
            </div>
          </div>
          {active !== "Painel" && (
            <div className="shrink-0 text-right">
              <p className="text-[10px] font-semibold uppercase text-[#667085]">{headerWeather.icon} {headerWeather.label}</p>
              <p className="whitespace-nowrap text-xs font-bold text-[#101923]">
                {currentDateTime.split(", ").at(-1) || currentDateTime}
              </p>
            </div>
          )}
        </div>
      </div>

      {mobileMenuOpen && !kioskMode && (
        <div className="mobile-navigation-shell lg:hidden">
          <button
            aria-label="Fechar menu"
            className="mobile-navigation-backdrop"
            onClick={() => setMobileMenuOpen(false)}
            type="button"
          />
          <aside aria-label="Menu principal" className="mobile-navigation-panel">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
              <div className="min-w-0">
                <img
                  alt="Orquestracs Face ID"
                  className="app-brand-wordmark-dark app-brand-wordmark-menu"
                  src="/orquestracs-face-id-wordmark.svg"
                />
              </div>
              <button
                aria-label="Fechar menu"
                className="mobile-menu-close"
                onClick={() => setMobileMenuOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="mt-4 rounded-md border border-white/10 bg-white/[0.04] p-3">
              <p className="text-xs uppercase text-white/45">Empresa ativa</p>
              {tenantAccesses.length > 1 ? (
                <select
                  aria-label="Selecionar empresa ativa"
                  className="mt-2 min-h-10 w-full rounded-md border border-white/15 bg-[#16242f] px-2 text-sm font-semibold text-white outline-none focus:border-[#8bcab9]"
                  onChange={(event) => handleTenantChange(event.target.value)}
                  value={appAccess?.tenantId || ""}
                >
                  {tenantAccesses.map((tenant) => <option key={tenant.tenantId} value={tenant.tenantId}>{tenant.companyName}</option>)}
                </select>
              ) : (
                <p className="mt-1 truncate text-sm font-semibold text-white">{String(companyName)}</p>
              )}
              <p className="mt-1 truncate text-xs text-white/55">{String(companyCnpj)}</p>
            </div>
            <nav className="mt-4 grid gap-1 overflow-y-auto pb-5 text-sm">
              {visibleNavItems.map((item) => (
                <button
                  className={`min-h-11 rounded-md px-3 py-2.5 text-left font-medium transition ${
                    active === item
                      ? "bg-[#dcebe6] text-[#143f37]"
                      : "text-white/75 hover:bg-white/[0.06] hover:text-white"
                  }`}
                  key={item}
                  onClick={() => go(item)}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </nav>
            <button
              className="mt-auto min-h-11 rounded-md border border-white/15 px-3 py-2.5 text-left text-sm font-semibold text-white/80 transition hover:border-white/30 hover:bg-white/[0.06] hover:text-white"
              onClick={handleLogout}
              type="button"
            >
              Sair da conta
            </button>
          </aside>
        </div>
      )}

      <div className={kioskMode ? "kiosk-content-shell" : `app-layout mx-auto grid max-w-[1480px] gap-4 px-3 py-3 sm:px-4 sm:py-4 lg:gap-6 lg:px-6 ${sidebarIsCollapsed ? "app-layout-collapsed lg:grid-cols-[76px_minmax(0,1fr)]" : "lg:grid-cols-[292px_minmax(0,1fr)]"}`}>
        <aside className={kioskMode ? "hidden" : `app-sidebar app-sidebar-collapsible hidden rounded-lg border border-[#d9e0e7] p-4 text-white shadow-sm lg:sticky lg:top-4 lg:block lg:h-[calc(100vh-2rem)] ${sidebarIsCollapsed ? "app-sidebar-collapsed" : ""}`}>
          <div className="flex h-full flex-col">
            <div className="app-sidebar-heading border-b border-white/10 pb-5">
              <div className="app-sidebar-brand-row">
              <div className="min-w-0">
                <img
                  alt="Orquestracs Face ID"
                  className="app-brand-wordmark-dark app-brand-wordmark-sidebar"
                  src="/orquestracs-face-id-wordmark.svg"
                />
              </div>
                <button
                  aria-label={sidebarIsCollapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
                  className="app-sidebar-collapse-button"
                  onClick={toggleSidebar}
                  title={sidebarIsCollapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
                  type="button"
                >
                  {sidebarIsCollapsed ? "›" : "‹"}
                </button>
              </div>
              <div className="app-sidebar-company mt-5 rounded-md border border-white/10 bg-white/[0.04] p-3">
                <p className="text-xs uppercase tracking-[0.12em] text-white/45">Empresa ativa</p>
                <div className="mt-2 flex items-center gap-3">
                  {companyProfile?.logoUrl ? (
                    <img
                      alt={`Logo ${companyName}`}
                      className="h-9 w-9 rounded-md border border-white/10 object-cover"
                      src={companyProfile.logoUrl}
                    />
                  ) : (
                    <div className="grid h-9 w-9 place-items-center rounded-md bg-[#dcebe6] text-xs font-bold text-[#164d42]">
                      O
                    </div>
                  )}
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold">{String(companyName)}</h2>
                    <p className="mt-1 truncate text-xs text-white/55">{String(companyCnpj)}</p>
                  </div>
                </div>
                {tenantAccesses.length > 1 ? (
                  <select
                    aria-label="Selecionar empresa ativa"
                    className="mt-3 min-h-10 w-full rounded-md border border-white/15 bg-[#16242f] px-2 text-sm font-semibold text-white outline-none focus:border-[#8bcab9]"
                    onChange={(event) => handleTenantChange(event.target.value)}
                    value={appAccess?.tenantId || ""}
                  >
                    {tenantAccesses.map((tenant) => <option key={tenant.tenantId} value={tenant.tenantId}>{tenant.companyName}</option>)}
                  </select>
                ) : null}
              </div>
            </div>

            <nav className="mt-5 grid gap-1 text-sm">
              {visibleNavItems.map((item) => (
                <button
                  aria-label={item}
                  className={`rounded-md px-3 py-2.5 text-left font-medium transition ${
                    active === item
                      ? "bg-[#dcebe6] text-[#143f37]"
                      : "text-white/70 hover:bg-white/[0.06] hover:text-white"
                  }`}
                  key={item}
                  onClick={() => go(item)}
                  title={item}
                  type="button"
                >
                  <span aria-hidden="true" className="sidebar-nav-glyph">{item.slice(0, 1)}</span>
                  <span className="sidebar-nav-label">{item}</span>
                </button>
              ))}
            </nav>

            <div className="app-sidebar-footer mt-auto rounded-md border border-[#314450] bg-[#182530] p-3">
              <p className="text-xs font-semibold text-[#b7d7ce]">Ambiente seguro</p>
              <p className="mt-1 text-xs leading-5 text-white/60">
                Logs inviolaveis, biometria controlada e trilha de auditoria.
              </p>
            </div>
          </div>
        </aside>

        <section className={kioskMode ? "kiosk-content-section" : centralAdminMode ? "app-main-content min-w-0" : "app-main-content grid min-w-0 gap-4 sm:gap-5"}>
          <header className={kioskMode || centralAdminMode || active === "Painel" ? "hidden" : "app-header rounded-lg border border-[#d9e0e7] bg-white px-4 py-4 shadow-sm sm:px-5"}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#2d6c5d]">
                  Orquestracs Face ID
                </p>
                <h1 className="mt-1 text-xl font-semibold text-[#101923] sm:text-2xl">
                  {active === "Painel" ? "Controle de jornada" : title}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[#667085]">
                  Ponto inteligente com reconhecimento facial, auditoria e fechamento mensal.
                </p>
              </div>

              <button
                className="secondary-button shrink-0"
                onClick={handleLogout}
                type="button"
              >
                Sair
              </button>
            </div>

            <div className="mt-3 flex items-center gap-2 text-xs font-medium text-[#667085]">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#edf5f2] text-[11px] font-bold text-[#18594c]">
                i
              </span>
              <p className="leading-5">{notice}</p>
            </div>
          </header>

          {lastPunchReceipt && !kioskMode && !centralAdminMode && (
            <PunchReceiptCard
              onClose={() => setLastPunchReceipt(null)}
              receipt={lastPunchReceipt}
            />
          )}

          {active === "Painel" && (
            <>
              <DailyOperationsPanel onLogout={handleLogout} scheduledDays={getCompanyWorkPolicy(companyProfile).scheduledDays} />
            </>
          )}

          {active === "Empresa" && (
            <CompaniesScreen
              canEdit={isPlatformOwnerEmail(user.email) || appAccess?.role !== "reader"}
              canInviteOwner={isPlatformOwnerEmail(user.email) || appAccess?.role === "owner"}
              company={companyProfile}
              invites={tenantInvites}
              key={String(companyProfile?.updatedAt || companyProfile?.logoUrl || "empty-company")}
              onAction={demoAction}
            />
          )}
          {active === "Colaboradores" && <EmployeesScreen canEdit={canManage} company={companyProfile} onAction={demoAction} />}
          {active === "Sala de ponto" && (
            <KioskScreen
              bankHoursEnabled={getCompanyWorkPolicy(companyProfile).bankHoursEnabled}
              dateLabel={headerDate}
              canExitWithGoogle={canExitKioskWithGoogle}
              canExitWithPassword={canExitKioskWithPassword}
              locationLabel={kioskLocation}
              onAction={demoAction}
              onExit={handleKioskExit}
              onRegister={registerPunch}
              pin={pin}
              setPin={setPin}
              timeLabel={headerTime}
              weatherDetail={headerWeather.detail}
              weatherIcon={headerWeather.icon}
              weatherLabel={headerWeather.label}
            />
          )}
          {active === "Ponto externo" && (
            <ExternalPunchScreen onAction={demoAction} onRegister={registerPunch} />
          )}
          {active === "Batidas" && (
            <PunchesScreen
              onAction={demoAction}
              onRegister={registerPunch}
              pin={pin}
              setPin={setPin}
            />
          )}
          {active === "Banco de horas" && <HoursBankScreen canEdit={canManage} company={companyProfile} onAction={demoAction} />}
          {active === "Fechamento mensal" && <MonthlyClosingScreen company={companyProfile} onAction={demoAction} />}
          {active === "Relatorios" && <ReportsScreen company={companyProfile} onAction={demoAction} />}
          {active === "LGPD e auditoria" && <AuditScreen company={companyProfile} onAction={demoAction} />}
          {active === "Configuracoes" && (
            <AuthenticationSettingsScreen
              canEdit={canManage}
              company={companyProfile}
              key={`${activeCompanyId}-${String(companyProfile?.updatedAt || "")}`}
              onSave={saveAuthenticationPreferences}
            />
          )}
          {active === "Admin" && (
            <AdminScreen company={companyProfile} config={saasConfig} invites={tenantInvites} onAction={demoAction} />
          )}
        </section>
      </div>

      {!kioskMode && <button
        aria-label="Abrir Assistente Face ID"
        className="assistant-launcher"
        onClick={() => setAssistantOpen(true)}
        type="button"
      >
        <span className="assistant-launcher-short">?</span>
        <span className="assistant-launcher-label">Assistente Face ID</span>
      </button>}

      {assistantOpen && !kioskMode && (
        <AssistantPanel
          active={active}
          config={saasConfig}
          onClose={() => setAssistantOpen(false)}
          onConsumeCredit={async () => {
            const updated = await consumeAiCredit(activeCompanyId, 1);
            setSaasConfig((current) => current ? applyCreditResult(current, updated) : current);
          }}
          onNavigate={go}
        />
      )}
      <input
        className="hidden"
        id="local-file-picker"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void uploadCompanyLogo(activeCompanyId, file)
              .then(async () => {
                await refreshCompanyProfile(activeCompanyId);
                setNotice(`Logo "${file.name}" salva no Firebase Storage.`);
              })
              .catch((error) => {
                console.error(error);
                setNotice("Nao foi possivel salvar a logo. Verifique regras do Storage.");
              });
          }
        }}
        type="file"
      />
      </main>
    </TenantIdContext.Provider>
  );
}

function Metrics() {
  const dashboardMetrics = useMemo(() => {
    const employeesList = getLocalEmployees();
    const today = new Date().toDateString();
    const todayPunches = getLocalRecords().filter((record) => {
      const timestamp = record.fields["Horário"] || record.fields["HorÃ¡rio"] || record.savedAt;
      return record.action.startsWith("Batida:") && new Date(timestamp).toDateString() === today;
    });
    const faceReady = employeesList.filter((employee) => employee.faceIdStatus === "registered").length;
    const pendingFace = employeesList.filter((employee) => employee.faceIdStatus !== "registered").length;

    return [
      ["Colaboradores", String(employeesList.length), "cadastros na base"],
      ["Face ID", String(faceReady), "cadastros prontos"],
      ["Batidas hoje", String(todayPunches.length), "registros do dia"],
      ["Pendencias", String(pendingFace), "Face ID pendente"],
    ];
  }, []);

  return (
    <div className="app-metric-grid">
      {dashboardMetrics.map(([label, value, detail], index) => (
        <DashboardMetricCard
          detail={detail}
          icon={index === 0 ? "◌" : index === 1 ? "＋" : index === 2 ? "↗" : "!"}
          key={label}
          label={label}
          loading={false}
          tone={index === 3 ? "red" : index === 2 ? "green" : "teal"}
          value={value}
        />
      ))}
    </div>
  );
}

type DailyStatusKey =
  | "absence_afternoon"
  | "absence_full_day"
  | "absence_morning"
  | "break"
  | "between_periods"
  | "done"
  | "off"
  | "pending"
  | "waiting"
  | "working";

type DailyEmployeeRow = {
  employee: LocalEmployee;
  pendingPunches: ScheduledPunch[];
  punches: Punch[];
  statusKey: DailyStatusKey;
  statusLabel: string;
  latestPunch: Punch | null;
};

function getTimeMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours * 60 + minutes;
}

function isScheduledWorkday(date: Date, scheduledDays: number) {
  const day = date.getDay();
  if (scheduledDays >= 7) return true;
  if (scheduledDays === 6) return day !== 0;
  return day >= 1 && day <= 5;
}

function isSameCalendarDay(date: Date, reference: Date) {
  return date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate();
}

type Daypart = {
  detail: string;
  icon: string;
  label: string;
};

function getDaypart(date: Date): Daypart {
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes < 6 * 60) return { detail: "A operação ainda não começou.", icon: "🌙", label: "Madrugada" };
  if (minutes < 9 * 60) return { detail: "Início da jornada e conferência de entradas.", icon: "🌅", label: "Bom dia" };
  if (minutes < 12 * 60) return { detail: "Jornada da manhã em andamento.", icon: "☀️", label: "Manhã" };
  if (minutes < 14 * 60) return { detail: "Pausa entre períodos da jornada.", icon: "☀️", label: "Tarde" };
  if (minutes < 18 * 60) return { detail: "Jornada da tarde em andamento.", icon: "☀️", label: "Tarde" };
  if (minutes < 20 * 60) return { detail: "Conferência do encerramento da jornada.", icon: "🌇", label: "Entardecer" };
  return { detail: "A jornada do dia foi encerrada.", icon: "🌙", label: "Noite" };
}

type WeatherVisual = {
  detail: string;
  icon: string;
  label: string;
  shellClass: string;
};

function getWeatherVisual(daypart: Daypart, weather: WeatherSnapshot | null, loading: boolean): WeatherVisual {
  if (loading) {
    return {
      detail: `${daypart.detail} Consultando o tempo local...`,
      icon: daypart.icon,
      label: daypart.label,
      shellClass: "border-[#b9ddd3] bg-[#f1faf7]",
    };
  }

  if (!weather?.available || !weather.kind) {
    return {
      detail: `${daypart.detail} Clima local indisponível no momento.`,
      icon: daypart.icon,
      label: daypart.label,
      shellClass: "border-[#b9ddd3] bg-[#f1faf7]",
    };
  }

  const temperature = typeof weather.temperature === "number" ? ` · ${Math.round(weather.temperature)}°C` : "";
  const location = weather.source === "current" ? "Localização atual" : weather.city;
  const night = weather.isDay === false;
  if (weather.kind === "rain" || weather.kind === "storm") {
    return {
      detail: `${weather.kind === "storm" ? "Chuva forte" : "Chuva"}${temperature}${location ? ` · ${location}` : ""}.`,
      icon: night ? "🌙🌧️" : "🌧️",
      label: night ? "Noite com chuva" : "Chuva",
      shellClass: "border-[#b8cbea] bg-[#eef4ff]",
    };
  }

  if (weather.kind === "cloudy") {
    return {
      detail: `Céu nublado${temperature}${location ? ` · ${location}` : ""}.`,
      icon: night ? "🌙☁️" : "🌥️",
      label: night ? "Noite nublada" : "Nublado",
      shellClass: "border-[#c7d1dc] bg-[#f3f6f9]",
    };
  }

  return {
    detail: `Céu aberto${temperature}${location ? ` · ${location}` : ""}.`,
    icon: night ? "🌙" : "☀️",
    label: night ? "Noite limpa" : daypart.label,
    shellClass: night ? "border-[#b8cbea] bg-[#eef4ff]" : "border-[#e8d59b] bg-[#fffaf0]",
  };
}

function scheduledStageForPunch(punch: Punch, schedule: LocalEmployee["schedule"]): ScheduledPunch | null {
  if (punch.scheduledPunch && scheduledPunchOrder.includes(punch.scheduledPunch)) return punch.scheduledPunch;
  const date = punchDate(punch);
  const currentMinutes = date.getHours() * 60 + date.getMinutes();
  const periods = getSchedulePeriods(schedule);
  const entryLike = punch.type === "entry" || punch.type === "lunch_back";
  const nearest = periods.reduce<{ stage: ScheduledPunch; distance: number } | null>((best, period, index) => {
    const expected = getTimeMinutes(entryLike ? period.start : period.end);
    const distance = Math.abs(currentMinutes - expected);
    const stage = `${entryLike ? "Entrada" : "Saída"} ${index + 1}` as ScheduledPunch;
    return !best || distance < best.distance ? { distance, stage } : best;
  }, null);
  return nearest?.stage || null;
}

function getDailyPendingPunches(
  employee: LocalEmployee,
  punches: Punch[],
  now: Date,
  scheduledDays: number,
  justifications: AttendanceJustification[] = [],
): ScheduledPunch[] {
  if (!isScheduledWorkday(now, scheduledDays)) return [];

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const schedule = employee.schedule;
  const todayPunches = punches.filter((punch) => isSameCalendarDay(punchDate(punch), now));
  const periods = getSchedulePeriods(schedule);
  const completed = new Set(todayPunches.map((punch) => scheduledStageForPunch(punch, schedule)).filter(Boolean));
  const pending: ScheduledPunch[] = [];
  periods.forEach((period, index) => {
    const stagePair = [
      [`Entrada ${index + 1}`, period.start],
      [`Saída ${index + 1}`, period.end],
    ] as const;
    stagePair.forEach(([stage, expected]) => {
      if (currentMinutes < getTimeMinutes(expected) + schedule.toleranceMinutes) return;
      if (completed.has(stage as ScheduledPunch)) return;
      const justificationPeriod = index === 0 ? "morning" : "afternoon";
      if (hasApprovedAbsenceJustification(justifications, employee.employeeId, now, justificationPeriod)) return;
      pending.push(stage as ScheduledPunch);
    });
  });
  return pending;
}

function getDailyAbsencePeriods(
  employee: LocalEmployee,
  punches: Punch[],
  now: Date,
  scheduledDays: number,
  justifications: AttendanceJustification[] = [],
) {
  if (!isScheduledWorkday(now, scheduledDays)) {
    return { afternoon: false, fullDay: false, morning: false };
  }

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const schedule = employee.schedule;
  const todayPunches = punches.filter((punch) => isSameCalendarDay(punchDate(punch), now));
  const periods = getSchedulePeriods(schedule);
  const completed = new Set(todayPunches.map((punch) => scheduledStageForPunch(punch, schedule)).filter(Boolean));
  const morningJustified = hasApprovedAbsenceJustification(justifications, employee.employeeId, now, "morning");
  const afternoonJustified = hasApprovedAbsenceJustification(justifications, employee.employeeId, now, "afternoon");
  const closedPeriods = periods.map((period, index) => ({
    index,
    closed: currentMinutes >= getTimeMinutes(period.end) + schedule.toleranceMinutes,
    missed: !completed.has(`Entrada ${index + 1}` as ScheduledPunch)
      && !completed.has(`Saída ${index + 1}` as ScheduledPunch),
  }));
  const morningMissing = closedPeriods.some(({ index, closed, missed }) => index === 0 && closed && missed) && !morningJustified;
  const afternoonMissing = closedPeriods.some(({ index, closed, missed }) => index > 0 && closed && missed) && !afternoonJustified;
  const dayClosed = currentMinutes >= getTimeMinutes(periods.at(-1)?.end || schedule.end) + schedule.toleranceMinutes;
  const fullDayMissing = dayClosed && !completed.size && !morningJustified && !afternoonJustified;

  return {
    afternoon: afternoonMissing && !morningMissing,
    fullDay: fullDayMissing || (morningMissing && afternoonMissing),
    morning: morningMissing && !afternoonMissing,
  };
}

function getDailyEmployeeStatus(
  employee: LocalEmployee,
  punches: Punch[],
  now: Date,
  scheduledDays: number,
  justifications: AttendanceJustification[] = [],
): DailyStatusKey {
  if (!isScheduledWorkday(now, scheduledDays)) return "off";

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const schedule = employee.schedule;
  const periods = getSchedulePeriods(schedule);
  if (currentMinutes < getTimeMinutes(periods[0]?.start || schedule.start)) return "waiting";
  const absencePeriods = getDailyAbsencePeriods(employee, punches, now, scheduledDays, justifications);
  if (absencePeriods.fullDay) return "absence_full_day";
  if (absencePeriods.morning) return "absence_morning";
  if (absencePeriods.afternoon) return "absence_afternoon";
  if (getDailyPendingPunches(employee, punches, now, scheduledDays, justifications).length > 0) return "pending";
  if (currentMinutes < getTimeMinutes(periods.at(-1)?.end || schedule.end)) {
    const betweenPeriods = periods.some((period, index) => {
      const nextPeriod = periods[index + 1];
      return nextPeriod
        && currentMinutes > getTimeMinutes(period.end)
        && currentMinutes < getTimeMinutes(nextPeriod.start);
    });
    return betweenPeriods ? "between_periods" : "working";
  }
  return "done";
}

function dailyStatusLabel(statusKey: DailyStatusKey) {
  const labels: Record<DailyStatusKey, string> = {
    absence_afternoon: "Falta tarde - justificar",
    absence_full_day: "Falta dia inteiro - justificar",
    absence_morning: "Falta manhã - justificar",
    break: "Entre períodos",
    between_periods: "Entre períodos",
    done: "Jornada concluída",
    off: "Fora da escala",
    pending: "Batida pendente",
    waiting: "Aguardando entrada",
    working: "Em jornada",
  };
  return labels[statusKey];
}

function dailyStatusClass(statusKey: DailyStatusKey) {
  const classes: Record<DailyStatusKey, string> = {
    absence_afternoon: "border-[#d0443e] bg-[#fff0ef] text-[#a33a3a]",
    absence_full_day: "border-[#d0443e] bg-[#fff0ef] text-[#a33a3a]",
    absence_morning: "border-[#d0443e] bg-[#fff0ef] text-[#a33a3a]",
    break: "border-[#efd9a8] bg-[#fff8e9] text-[#8a5a00]",
    between_periods: "border-[#d9e0e7] bg-[#f8fafb] text-[#667085]",
    done: "border-[#b9ddd3] bg-[#f1faf7] text-[#18594c]",
    off: "border-[#d9e0e7] bg-[#f8fafb] text-[#667085]",
    pending: "border-[#f2b8b5] bg-[#fff0ef] text-[#a33a3a]",
    waiting: "border-[#d9e0e7] bg-[#fbfcfd] text-[#667085]",
    working: "border-[#b9ddd3] bg-[#f1faf7] text-[#18594c]",
  };
  return classes[statusKey];
}

function isDailyAttentionStatus(statusKey: DailyStatusKey) {
  return statusKey === "pending"
    || statusKey === "absence_afternoon"
    || statusKey === "absence_full_day"
    || statusKey === "absence_morning";
}

type DashboardMetricTone = "amber" | "green" | "red" | "teal";

function DashboardMetricCard({
  detail,
  icon,
  label,
  loading,
  tone = "teal",
  value,
}: {
  detail: string;
  icon: string;
  label: string;
  loading: boolean;
  tone?: DashboardMetricTone;
  value: string;
}) {
  return (
    <article className="dashboard-metric-card" data-tone={tone}>
      <div className="dashboard-metric-top">
        <span>{label}</span>
        <span aria-hidden="true" className="dashboard-metric-icon">{icon}</span>
      </div>
      <strong className="dashboard-metric-value">{loading ? "-" : value}</strong>
      <span className="dashboard-metric-detail">{detail}</span>
    </article>
  );
}

function DashboardSystemItem({
  detail,
  title,
  tone = "success",
}: {
  detail: string;
  title: string;
  tone?: "error" | "success" | "warning";
}) {
  return (
    <div className="dashboard-system-item">
      <span aria-hidden="true" className={`dashboard-system-dot ${tone === "success" ? "" : tone}`} />
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function DailyOperationsPanel({
  onLogout,
  scheduledDays,
}: {
  onLogout: () => Promise<void>;
  scheduledDays: number;
}) {
  const companyId = useActiveCompanyId();
  const [employeesList, setEmployeesList] = useState<LocalEmployee[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [attendanceJustifications, setAttendanceJustifications] = useState<AttendanceJustification[]>([]);
  const [employeePhotoUrls, setEmployeePhotoUrls] = useState<Record<string, string>>({});
  const [now, setNow] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<DailyStatusKey | "all">("all");
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    let mounted = true;

    async function loadDailyData() {
      setLoading(true);
      setError("");
      try {
        const saved = await listEmployees(companyId);
        const mapped = saved.map((employee) =>
          toLocalEmployee(employee as unknown as Record<string, unknown>, employee.id),
        );
        const [recentPunches, savedJustifications] = await Promise.all([
          listEmployeePunchesByIds(companyId, mapped.map((employee) => employee.employeeId)),
          listAttendanceJustifications(companyId),
        ]);
        if (!mounted) return;
        setEmployeesList(mapped);
        setPunches(recentPunches);
        setAttendanceJustifications(savedJustifications);
      } catch (loadError) {
        console.error(loadError);
        if (!mounted) return;
        setEmployeesList([]);
        setPunches([]);
        setError("Não foi possível carregar os dados reais do dia. Tente atualizar novamente.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void loadDailyData();
    const refresh = window.setInterval(() => void loadDailyData(), 30000);
    return () => {
      mounted = false;
      window.clearInterval(refresh);
    };
  }, [companyId, refreshToken]);

  useEffect(() => {
    employeesList.forEach((employee) => {
      if (!employee.profilePhotoPath || employeePhotoUrls[employee.employeeId]) return;

      void getStorageFileUrl(employee.profilePhotoPath)
        .then((url) => setEmployeePhotoUrls((current) => ({ ...current, [employee.employeeId]: url })))
        .catch(() => undefined);
    });
  }, [employeePhotoUrls, employeesList]);

  const rows = useMemo<DailyEmployeeRow[]>(() => {
    const currentRows = employeesList.map((employee) => {
      const employeePunches = punches
        .filter((punch) => punch.employeeId === employee.employeeId)
        .sort((first, second) => punchDate(second).getTime() - punchDate(first).getTime());
      const statusKey = getDailyEmployeeStatus(employee, employeePunches, now, scheduledDays, attendanceJustifications);
      return {
        employee,
        latestPunch: employeePunches[0] || null,
        pendingPunches: getDailyPendingPunches(employee, employeePunches, now, scheduledDays, attendanceJustifications),
        punches: employeePunches,
        statusKey,
        statusLabel: dailyStatusLabel(statusKey),
      };
    });

    const query = search.trim().toLocaleLowerCase("pt-BR");
    return currentRows
      .filter((row) => !query || [row.employee.name, row.employee.role, row.employee.shift].some((value) => value.toLocaleLowerCase("pt-BR").includes(query)))
      .filter((row) => statusFilter === "all" || row.statusKey === statusFilter)
      .sort((first, second) => Number(second.statusKey === "pending") - Number(first.statusKey === "pending"));
  }, [attendanceJustifications, employeesList, now, punches, scheduledDays, search, statusFilter]);

  const todayPunches = punches.filter((punch) => isSameCalendarDay(punchDate(punch), now));
  const dashboardStages = scheduledPunchOrder.slice(
    0,
    Math.max(2, ...employeesList.map((employee) => getSchedulePeriods(employee.schedule).length)) * 2,
  );
  const pendingCount = employeesList.filter((employee) => {
    const employeePunches = punches.filter((punch) => punch.employeeId === employee.employeeId);
    return isDailyAttentionStatus(getDailyEmployeeStatus(employee, employeePunches, now, scheduledDays, attendanceJustifications));
  }).length;
  const okCount = employeesList.length - pendingCount;
  const activityPeriods = [6, 8, 10, 12, 14, 16, 18, 20].map((hour) => ({
    count: todayPunches.filter((punch) => punchDate(punch).getHours() >= hour && punchDate(punch).getHours() < hour + 2).length,
    label: `${String(hour).padStart(2, "0")}h`,
  }));
  const activityMax = Math.max(1, ...activityPeriods.map((period) => period.count));
  const period = getDaypart(now);
  const currentDate = now.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", weekday: "long" });
  const currentTime = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function renderPunchCell(row: DailyEmployeeRow, stage: ScheduledPunch, expected: string) {
    const punch = row.punches.find((item) =>
      isSameCalendarDay(punchDate(item), now)
      && scheduledStageForPunch(item, row.employee.schedule) === stage,
    );
    const confirmed = Boolean(punch);
    const pending = row.pendingPunches.includes(stage);
    return (
      <span
        className={`dashboard-punch-time ${
          pending
            ? "pending"
            : confirmed
              ? "confirmed"
              : "expected"
        }`}
        title={punch ? `Batida registrada às ${formatPunchDateTime(punch)}` : undefined}
      >
        {confirmed && punch ? formatPunchTime(punch) : expected}
      </span>
    );
  }

  return (
    <>
      <section className="dashboard-panel">
        <header className="dashboard-overview-header">
          <div>
            <p className="dashboard-eyebrow">Acompanhamento diário</p>
            <h2>Visão geral da operação</h2>
            <p>Acompanhe as marcações do dia e identifique pendências antes do fechamento.</p>
          </div>
          <div className="dashboard-live-actions">
            <div className="dashboard-live-meta">
              <span>{period.icon} {period.label} · ao vivo</span>
              <strong>{currentTime}</strong>
              <small>{currentDate}</small>
            </div>
            <button className="secondary-button dashboard-logout-button" onClick={() => void onLogout()} type="button">
              Sair da conta
            </button>
          </div>
        </header>
        <div className="dashboard-metric-grid">
          <DashboardMetricCard detail="cadastros ativos" icon="◌" label="Colaboradores" loading={loading} value={String(employeesList.length)} />
          <DashboardMetricCard detail="registros recebidos" icon="✓" label="Batidas hoje" loading={loading} tone="green" value={String(todayPunches.length)} />
          <DashboardMetricCard detail="acompanhamento normal" icon="↗" label="Sem pendência" loading={loading} tone="green" value={String(okCount)} />
          <DashboardMetricCard detail="bater ou justificar" icon="!" label="Pendências e faltas" loading={loading} tone={pendingCount ? "red" : "green"} value={String(pendingCount)} />
        </div>
      </section>

      <div className="dashboard-content-grid">
        <section className="dashboard-activity-card">
          <div className="dashboard-card-heading">
            <div>
              <p className="dashboard-eyebrow">Movimento do dia</p>
              <h3>Registros de hoje</h3>
              <p>Distribuição real das marcações por período.</p>
            </div>
            <span className="dashboard-card-caption">{todayPunches.length} registro(s)</span>
          </div>
          <div aria-label="Registros de hoje por período" className="dashboard-bars" role="img">
            {activityPeriods.map((periodItem) => (
              <div className="dashboard-bar-column" key={periodItem.label}>
                <span className="dashboard-bar-value">{periodItem.count || "-"}</span>
                <div className="dashboard-bar" style={{ height: `${Math.max(8, (periodItem.count / activityMax) * 100)}%` }} />
                <span className="dashboard-bar-label">{periodItem.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="dashboard-system-card">
          <div className="dashboard-card-heading">
            <div>
              <p className="dashboard-eyebrow">Integridade</p>
              <h3>Status do sistema</h3>
            </div>
          </div>
          <div className="dashboard-system-list">
            <DashboardSystemItem detail={error || `${employeesList.length} colaborador(es) carregado(s) para hoje.`} title="Dados do dia" tone={error ? "error" : "success"} />
            <DashboardSystemItem detail="Sincronização automática a cada 30 segundos." title="Atualização automática" />
            <DashboardSystemItem detail={pendingCount ? `${pendingCount} registro(s) aguardando conferência.` : "Nenhuma pendência identificada."} title="Acompanhamento" tone={pendingCount ? "warning" : "success"} />
          </div>
        </section>
      </div>

      <section className="dashboard-table-panel">
        <div className="dashboard-table-header">
          <div>
            <p className="dashboard-eyebrow">Controle em tempo real</p>
            <h2>Funcionários e status das batidas</h2>
            <p>As marcações pendentes ficam destacadas para conferência.</p>
          </div>
          <button className="secondary-button" disabled={loading} onClick={() => setRefreshToken((token) => token + 1)} type="button">
            {loading ? "Atualizando..." : "Atualizar agora"}
          </button>
        </div>
        <div className="dashboard-filter-bar">
          <label>
            Filtrar colaborador, cargo ou escala
            <input className="input" onChange={(event) => setSearch(event.target.value)} placeholder="Digite para filtrar" value={search} />
          </label>
          <label>
            Filtrar status
            <select className="input" onChange={(event) => setStatusFilter(event.target.value as DailyStatusKey | "all")} value={statusFilter}>
              <option value="all">Todos</option>
              <option value="pending">Batida pendente</option>
              <option value="absence_morning">Falta manhã</option>
              <option value="absence_afternoon">Falta tarde</option>
              <option value="absence_full_day">Falta dia inteiro</option>
              <option value="working">Em jornada</option>
              <option value="between_periods">Entre períodos</option>
              <option value="done">Jornada concluída</option>
              <option value="waiting">Aguardando entrada</option>
              <option value="off">Fora da escala</option>
            </select>
          </label>
        </div>
        {error && <p className="mx-6 mt-4 rounded-lg border border-[#f2b8b5] bg-[#fff0ef] p-3 text-sm font-semibold text-[#a33a3a]">{error}</p>}
        <div className="dashboard-table-scroll hidden lg:block">
          <table className="dashboard-table">
            <thead>
              <tr>
                {["Funcionário", "Escala", ...dashboardStages, "Última batida", "Status"].map((head) => (
                  <th key={head}>{head}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={dashboardStages.length + 4}><div className="dashboard-empty-state">Carregando colaboradores...</div></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={dashboardStages.length + 4}><div className="dashboard-empty-state">{employeesList.length ? "Nenhum colaborador corresponde ao filtro." : "Nenhum colaborador cadastrado."}</div></td></tr>
              ) : rows.map((row) => (
                <tr className={isDailyAttentionStatus(row.statusKey) ? "dashboard-row-attention" : ""} key={row.employee.employeeId}>
                  <td>
                    <div className="dashboard-employee-cell">
                      <span className="dashboard-employee-photo">
                        {employeePhotoUrls[row.employee.employeeId] ? <img alt={`Foto de ${row.employee.name}`} src={employeePhotoUrls[row.employee.employeeId]} /> : row.employee.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span>{row.employee.name}</span>
                    </div>
                  </td>
                  <td className="text-[#64748b]">{row.employee.shift}</td>
                  {dashboardStages.map((stage, index) => {
                    const period = getSchedulePeriods(row.employee.schedule)[Math.floor(index / 2)];
                    const expected = stage.startsWith("Entrada") ? period?.start : period?.end;
                    return <td key={stage}>{renderPunchCell(row, stage, expected || "--:--")}</td>;
                  })}
                  <td className="text-[#64748b]">{row.latestPunch ? formatPunchDateTime(row.latestPunch) : "Sem batida hoje"}</td>
                  <td><span className={`dashboard-status-pill ${dailyStatusClass(row.statusKey)}`}>{row.statusLabel}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dashboard-mobile-list lg:hidden">
          {loading ? (
            <div className="dashboard-empty-state">Carregando colaboradores...</div>
          ) : rows.length === 0 ? (
            <div className="dashboard-empty-state">{employeesList.length ? "Nenhum colaborador corresponde ao filtro." : "Nenhum colaborador cadastrado."}</div>
          ) : rows.map((row) => (
            <article className={`dashboard-mobile-row ${isDailyAttentionStatus(row.statusKey) ? "attention" : ""}`} key={`mobile-${row.employee.employeeId}`}>
              <div className="flex min-w-0 items-start gap-3">
                <span className="dashboard-employee-photo">
                  {employeePhotoUrls[row.employee.employeeId] ? <img alt={`Foto de ${row.employee.name}`} src={employeePhotoUrls[row.employee.employeeId]} /> : row.employee.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 break-words text-sm font-semibold text-[#142235]">{row.employee.name}</p>
                    <span className={`dashboard-status-pill ${dailyStatusClass(row.statusKey)}`}>{row.statusLabel}</span>
                  </div>
                  <p className="mt-1 break-words text-xs text-[#64748b]">{row.employee.shift}</p>
                </div>
              </div>
              <div className="dashboard-mobile-punch-grid">
                {dashboardStages.map((stage, index) => {
                  const period = getSchedulePeriods(row.employee.schedule)[Math.floor(index / 2)];
                  const expected = stage.startsWith("Entrada") ? period?.start : period?.end;
                  return { label: stage, value: renderPunchCell(row, stage, expected || "--:--") };
                }).map(({ label, value }) => (
                  <div className="dashboard-mobile-punch" key={label}>
                    <p>{label}</p>
                    <div>{value}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 break-words text-xs text-[#64748b]">Última batida: <span className="font-semibold text-[#142235]">{row.latestPunch ? formatPunchDateTime(row.latestPunch) : "Sem batida hoje"}</span></p>
            </article>
          ))}
        </div>
        <div className="dashboard-note"><strong>Pendência ou falta indicada</strong> exige batida, atestado ou justificativa aprovada antes do fechamento. A batida original nunca é apagada.</div>
      </section>
    </>
  );
}

function PunchReceiptCard({
  onClose,
  receipt,
}: {
  onClose: () => void;
  receipt: RepPunchReceipt;
}) {
  const companyId = useActiveCompanyId();
  const missingLegalData = !receipt.inpiRegistration || receipt.employeeCpf.length !== 11 || receipt.companyCnpj.length !== 14;
  const [recentReceipts, setRecentReceipts] = useState<RepPunchReceipt[] | null>(null);
  const [loadingRecent, setLoadingRecent] = useState(false);
  const [recentError, setRecentError] = useState("");

  function printReceipt() {
    const printWindow = window.open("", "_blank", "width=760,height=900");
    if (!printWindow) return;
    printWindow.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Comprovante NSR ${receipt.nsr}</title><style>body{font-family:Arial,sans-serif;color:#17202a;padding:40px;line-height:1.5}main{max-width:680px;margin:auto;border:1px solid #cfd8e3;padding:28px}h1{font-size:20px;margin:0 0 24px}dl{display:grid;grid-template-columns:180px 1fr;gap:10px;margin:0}dt{color:#667085}dd{margin:0;font-weight:700;overflow-wrap:anywhere}.warning{margin-top:24px;padding:12px;border:1px solid #e3b04b;background:#fff8e9}.signature{margin-top:24px;font-size:12px;color:#667085}@media print{body{padding:0}main{border:0}}</style></head><body><main><h1>${escapeHtml(receipt.title)}</h1><dl><dt>NSR</dt><dd>${receipt.nsr}</dd><dt>Data e horario</dt><dd>${escapeHtml(new Date(receipt.occurredAt).toLocaleString("pt-BR"))}</dd><dt>Empregador</dt><dd>${escapeHtml(receipt.companyName || "Nao informado")}</dd><dt>CNPJ</dt><dd>${escapeHtml(maskCnpj(receipt.companyCnpj) || "Nao informado")}</dd><dt>Trabalhador</dt><dd>${escapeHtml(receipt.employeeName)}</dd><dt>CPF</dt><dd>${escapeHtml(maskCpf(receipt.employeeCpf) || "Nao informado")}</dd><dt>Registro INPI</dt><dd>${escapeHtml(receipt.inpiRegistration || "Pendente")}</dd><dt>Hash SHA-256</dt><dd>${escapeHtml(receipt.hash)}</dd></dl>${missingLegalData ? '<p class="warning"><strong>Documento de piloto.</strong> Ainda nao possui todos os dados necessarios para uso como comprovante REP-P oficial.</p>' : ""}<p class="signature">Assinatura digital PAdES: pendente de configuracao do certificado ICP-Brasil.</p></main><script>window.print()</script></body></html>`);
    printWindow.document.close();
  }

  async function loadRecentReceipts() {
    setLoadingRecent(true);
    setRecentError("");
    try {
      const result = await listRecentRepReceipts(companyId, receipt.employeeId);
      setRecentReceipts(result.receipts);
    } catch (error) {
      console.error(error);
      setRecentError("Nao foi possivel consultar a janela de 48 horas neste acesso.");
    } finally {
      setLoadingRecent(false);
    }
  }

  return (
    <section aria-live="polite" className="rounded-lg border border-[#b9ddd3] bg-[#f1faf7] p-5 shadow-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase text-[#18594c]">Comprovante da marcacao</p>
          <h2 className="mt-1 text-lg font-semibold text-[#101923]">NSR {receipt.nsr}</h2>
          <p className="mt-1 text-sm text-[#51606f]">
            {receipt.employeeName} · {new Date(receipt.occurredAt).toLocaleString("pt-BR")}
          </p>
          <p className="mt-2 break-all text-xs text-[#667085]">SHA-256: {receipt.hash}</p>
          {missingLegalData && (
            <p className="mt-3 text-sm font-semibold text-[#8a5a00]">
              Piloto: complete CPF, CNPJ e registro INPI antes do modo oficial.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button className="primary-button" onClick={printReceipt} type="button">Imprimir</button>
          <button className="secondary-button" disabled={loadingRecent} onClick={() => void loadRecentReceipts()} type="button">
            {loadingRecent ? "Consultando..." : "Ultimas 48h"}
          </button>
          <button className="secondary-button" onClick={onClose} type="button">Fechar</button>
        </div>
      </div>
      <div className="mt-4 rounded-md border border-[#d9e0e7] bg-white p-4">
        <p className="text-sm font-semibold text-[#26323f]">Extração de comprovantes</p>
        <p className="mt-1 text-xs leading-5 text-[#667085]">
          Consulta autenticada dos comprovantes desse colaborador registrados nas últimas 48 horas.
        </p>
        {recentError && <p className="mt-2 text-sm font-semibold text-[#a33a3a]">{recentError}</p>}
        {recentReceipts && (
          <div className="mt-3 grid gap-2">
            {recentReceipts.length ? recentReceipts.map((item) => (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#e3e8ee] bg-[#fbfcfd] px-3 py-2 text-sm" key={item.nsr}>
                <span className="font-semibold text-[#101923]">NSR {item.nsr}</span>
                <span className="text-[#667085]">{new Date(item.occurredAt).toLocaleString("pt-BR")}</span>
                <span className="text-[#667085]">{item.type || "marcação"}</span>
              </div>
            )) : (
              <p className="text-sm text-[#667085]">Nenhum comprovante encontrado nas últimas 48 horas.</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function OwnReceiptLookupCard() {
  const companyId = useActiveCompanyId();
  const [receiptPin, setReceiptPin] = useState("");
  const [result, setResult] = useState<{
    employeeName: string;
    receipts: RepPunchReceipt[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function consultReceipts() {
    if (receiptPin.length < 4) {
      setError("Informe o PIN de 4 a 6 numeros.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const response = await listOwnRepReceipts(companyId, receiptPin);
      setResult({ employeeName: response.employeeName, receipts: response.receipts });
    } catch (requestError) {
      console.error(requestError);
      setResult(null);
      setError("Nao foi possivel consultar. Confira o PIN ou procure o responsavel.");
    } finally {
      setLoading(false);
    }
  }

  const typeLabels: Record<string, string> = {
    entry: "Entrada",
    exit: "Saída",
    lunch_back: "Entrada",
    lunch_out: "Saída",
  };

  return (
    <section className="rounded-lg border border-[#cfe3dc] bg-[#f1faf7] p-4 text-[#24594d] shadow-sm md:p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#18594c]">Acesso do trabalhador</p>
      <h2 className="mt-1 text-lg font-semibold text-[#101923]">Consultar comprovantes das últimas 48 horas</h2>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-[#51606f]">
        Informe seu PIN para consultar somente as suas próprias marcações recentes.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="PIN do colaborador">
          <input
            className="input min-w-0 sm:w-52"
            inputMode="numeric"
            maxLength={6}
            onChange={(event) => setReceiptPin(event.target.value.replace(/\D/g, ""))}
            placeholder="0000"
            value={receiptPin}
          />
        </Field>
        <button className="primary-button min-h-11" disabled={loading} onClick={() => void consultReceipts()} type="button">
          {loading ? "Consultando..." : "Consultar minhas batidas"}
        </button>
      </div>
      {error && <p className="mt-3 text-sm font-semibold text-[#a33a3a]" role="alert">{error}</p>}
      {result && (
        <div className="mt-4 rounded-md border border-[#d9e0e7] bg-white p-4">
          <p className="text-sm font-semibold text-[#26323f]">{result.employeeName}</p>
          <p className="mt-1 text-xs text-[#667085]">Comprovantes encontrados no período de 48 horas.</p>
          <div className="mt-3 grid gap-2">
            {result.receipts.length ? result.receipts.map((receipt) => (
              <div className="grid gap-1 rounded-md border border-[#e3e8ee] bg-[#fbfcfd] px-3 py-3 text-sm sm:grid-cols-[auto_1fr_auto] sm:items-center sm:gap-3" key={receipt.nsr}>
                <strong className="text-[#101923]">NSR {receipt.nsr}</strong>
                <span className="text-[#667085]">{new Date(receipt.occurredAt).toLocaleString("pt-BR")}</span>
                <span className="font-medium text-[#18594c]">{typeLabels[receipt.type || ""] || "Marcação"}</span>
                <span className="break-all text-xs text-[#7c8895] sm:col-span-3">Hash: {receipt.hash}</span>
              </div>
            )) : (
              <p className="text-sm text-[#667085]">Nenhuma batida encontrada nas últimas 48 horas.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function PunchCard({
  onRegister,
  pin,
  setPin,
}: {
  onRegister: (kind: string, employee?: RecognizedFace, exception?: PunchException, photoBlob?: Blob, context?: PunchContext) => Promise<boolean>;
  pin: string;
  setPin: (value: string) => void;
}) {
  return (
    <section className="app-panel">
      <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-start">
        <div>
          <p className="text-sm font-medium text-[#667085]">Registro rapido</p>
          <h2 className="mt-1 text-xl font-semibold text-[#101923]">Batida com PIN + foto</h2>
        </div>
        <span className="w-fit rounded-full border border-[#efd9a8] bg-[#fff8e9] px-3 py-1 text-xs font-semibold text-[#8a5a00]">
          Reconhecimento facial preparado
        </span>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_240px]">
        <div className="grid gap-4">
          <Field label="PIN do colaborador">
            <input
              className="input"
              maxLength={6}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
              placeholder="0000"
              value={pin}
            />
          </Field>

          <div className="punch-actions">
            {scheduledPunchOrder.map((label) => (
              <button className="secondary-button punch-action-button" key={label} onClick={() => void onRegister(label)} type="button">
                {label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 rounded-md border border-[#cfe3dc] bg-[#f1faf7] p-4 text-sm text-[#24594d] sm:grid-cols-3">
            <span>Foto obrigatoria</span>
            <span>Horario do servidor</span>
            <span>Hash de auditoria</span>
          </div>
        </div>

        <FaceCamera compact />
      </div>
    </section>
  );
}

function ComplianceCard() {
  return (
    <section className="app-panel">
      <p className="text-sm font-medium text-[#667085]">Compliance</p>
      <h2 className="mt-1 text-xl font-semibold text-[#101923]">Controles sensiveis</h2>
      <div className="mt-4 grid gap-3">
        {auditLogs.map(([title, detail]) => (
          <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={title}>
            <p className="text-sm font-semibold text-[#26323f]">{title}</p>
            <p className="mt-1 text-xs leading-5 text-[#667085]">{detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const fingerprintReaderCandidates = [
  {
    id: "secugen-hamster-pro-20",
    manufacturer: "SecuGen",
    model: "Hamster Pro 20",
    integration: "WebAPI e SDK oficial; requer cliente local no computador do quiosque.",
    url: "https://secugen.com/products/hamster-pro-20/",
    docsUrl: "https://secugen.com/products/webapi/",
  },
  {
    id: "secugen-hamster-pro-30",
    manufacturer: "SecuGen",
    model: "Hamster Pro 30",
    integration: "WebAPI e SDK oficial; validar disponibilidade e compatibilidade do cliente local.",
    url: "https://secugen.com/products/",
    docsUrl: "https://secugen.com/products/webapi/",
  },
  {
    id: "hid-digitalpersona-4500",
    manufacturer: "HID DigitalPersona",
    model: "4500",
    integration: "SDK oficial e API web; exige componente DigitalPersona instalado localmente.",
    url: "https://www.hidglobal.com/products/4500-fingerprint-reader",
    docsUrl: "https://docs.hidglobal.com/digitalpersona-v4.3.0/ad/dev/web-client-api.htm",
  },
  {
    id: "controlid-idbio-pro",
    manufacturer: "Control iD",
    model: "iDBio Pro",
    integration: "SDK e documentacao do fabricante; confirmar interface e modo de integracao para o quiosque.",
    url: "https://www.controlid.com.br/docs/idbio-pt/",
    docsUrl: "https://www.controlid.com.br/docs/idbio-pt/",
  },
  {
    id: "xperix-biomini-slim-3",
    manufacturer: "Xperix",
    model: "BioMini Slim 3",
    integration: "BioMini SDK oficial para Windows, Linux e Android; requer prova de conceito no dispositivo alvo.",
    url: "https://www.xperix.com/products/biomini-slim-3",
    docsUrl: "https://www.xperix.com/products/developer/sdks",
  },
] as const;

function AuthenticationSettingsScreen({
  canEdit,
  company,
  onSave,
}: {
  canEdit: boolean;
  company: MainCompanyProfile | null;
  onSave: (preferences: AuthenticationPreference) => Promise<void>;
}) {
  const saved = (company?.authenticationPreferences || {}) as Partial<AuthenticationPreference>;
  const [mode, setMode] = useState<AuthenticationPreference["mode"]>(
    saved.mode && ["face", "fingerprint", "either", "both", "pin"].includes(saved.mode)
      ? saved.mode
      : "either",
  );
  const [pinFallback, setPinFallback] = useState(saved.pinFallback !== false);
  const [readerModel, setReaderModel] = useState(saved.readerModel || "");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [hasError, setHasError] = useState(false);

  async function submitPreferences() {
    setSaving(true);
    setFeedback("");
    setHasError(false);
    try {
      await onSave({ mode, pinFallback, readerModel });
      setFeedback("Preferencias salvas. Elas ainda nao alteram a marcacao em producao.");
    } catch (error) {
      console.error(error);
      setHasError(true);
      setFeedback("Nao foi possivel salvar. Confira sua permissao e tente novamente.");
    } finally {
      setSaving(false);
    }
  }

  const methods: Array<{ id: AuthenticationPreference["mode"]; title: string; detail: string }> = [
    { id: "face", title: "Somente facial", detail: "Reconhecimento facial como metodo principal." },
    { id: "fingerprint", title: "Somente digital", detail: "Leitor dedicado, apos integracao e validacao." },
    { id: "either", title: "Facial ou digital", detail: "Funcionario escolhe um dos metodos habilitados." },
    { id: "both", title: "Facial e digital", detail: "Duas verificacoes; depende de compatibilidade tecnica." },
    { id: "pin", title: "PIN + foto", detail: "Alternativa por codigo e evidencia fotografica." },
  ];

  return (
    <div className="grid min-w-0 gap-4">
      <section className="app-panel overflow-hidden">
        <div className="app-panel-heading app-panel-heading-soft">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#187e69]">Configuracoes da empresa</p>
          <h2 className="mt-1 text-lg font-semibold text-[#102a35]">Identificacao para registro de ponto</h2>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-[#526773]">
            Defina a preferencia para esta empresa. O quiosque continua usando Face ID e PIN + foto ate a integracao do leitor ser testada e ativada.
          </p>
        </div>

        <div className="app-panel-content grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
          <div>
            <h3 className="text-sm font-semibold text-[#102a35]">Preferencia de autenticacao</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {methods.map((method) => (
                <label
                  className={`flex min-h-[82px] cursor-pointer gap-3 rounded-md border p-3 transition ${
                    mode === method.id
                      ? "border-[#0fae8a] bg-[#effbf7] ring-1 ring-[#0fae8a]"
                      : "border-[#d6e0e5] bg-white hover:border-[#79bdae]"
                  } ${!canEdit ? "cursor-not-allowed opacity-65" : ""}`}
                  key={method.id}
                >
                  <input
                    checked={mode === method.id}
                    className="mt-1 accent-[#07846d]"
                    disabled={!canEdit}
                    name="authentication-mode"
                    onChange={() => setMode(method.id)}
                    type="radio"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-[#102a35]">{method.title}</span>
                    <span className="mt-1 block text-xs leading-4 text-[#60717d]">{method.detail}</span>
                  </span>
                </label>
              ))}
            </div>

            <label className={`mt-4 flex items-start gap-3 rounded-md border border-[#d6e0e5] bg-[#f8fafb] p-3 ${!canEdit ? "opacity-65" : ""}`}>
              <input
                checked={pinFallback}
                className="mt-1 accent-[#07846d]"
                disabled={!canEdit}
                onChange={(event) => setPinFallback(event.target.checked)}
                type="checkbox"
              />
              <span>
                <span className="block text-sm font-semibold text-[#102a35]">Manter PIN + foto como alternativa</span>
                <span className="mt-1 block text-xs leading-4 text-[#60717d]">Recomendado para falha de leitura ou indisponibilidade do equipamento.</span>
              </span>
            </label>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button className="primary-button" disabled={!canEdit || saving} onClick={submitPreferences} type="button">
                {saving ? "Salvando..." : "Salvar preferencias"}
              </button>
              {!canEdit && <span className="text-xs text-[#667085]">Somente administradores podem alterar.</span>}
              {feedback && (
                <span aria-live="polite" className={`text-sm font-medium ${hasError ? "text-[#b42318]" : "text-[#187e69]"}`}>
                  {feedback}
                </span>
              )}
            </div>
          </div>

          <aside className="rounded-md border border-[#e8d6a8] bg-[#fff9e9] p-4">
            <h3 className="text-sm font-semibold text-[#674d12]">Ativacao da digital: pendente</h3>
            <ul className="mt-2 grid gap-2 text-xs leading-5 text-[#6b5b32]">
              <li>As preferencias acima sao registradas por empresa, mas ainda nao mudam o fluxo real do quiosque.</li>
              <li>Antes de ativar: escolher e testar um leitor, instalar o componente local e validar a comunicacao com o backend.</li>
              <li>Templates biometricos exigem protecao, acesso restrito, retencao definida e revisao da base legal LGPD.</li>
              <li>Nao armazenar imagem bruta da digital sem necessidade tecnica comprovada.</li>
            </ul>
          </aside>
        </div>
      </section>

      <section className="app-panel overflow-hidden">
        <div className="app-panel-heading flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#187e69]">Leitores candidatos</p>
            <h2 className="mt-1 text-base font-semibold text-[#102a35]">Cinco modelos para avaliacao</h2>
          </div>
          <span className="rounded-full bg-[#fff5dd] px-3 py-1 text-xs font-semibold text-[#795b12]">Nenhum aprovado ou conectado</span>
        </div>
        <div className="app-panel-content grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {fingerprintReaderCandidates.map((reader) => (
            <article className="flex min-w-0 flex-col rounded-md border border-[#d6e0e5] bg-[#fbfcfd] p-3" key={reader.id}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold uppercase text-[#60717d]">{reader.manufacturer}</p>
                  <h3 className="mt-1 text-sm font-semibold text-[#102a35]">{reader.model}</h3>
                </div>
                <label className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold text-[#51636e]">
                  <input
                    aria-label={`Selecionar ${reader.manufacturer} ${reader.model} para avaliacao`}
                    checked={readerModel === reader.id}
                    className="accent-[#07846d]"
                    disabled={!canEdit}
                    name="fingerprint-reader"
                    onChange={() => setReaderModel(reader.id)}
                    type="radio"
                  />
                  Avaliar
                </label>
              </div>
              <p className="mt-2 flex-1 text-xs leading-5 text-[#60717d]">{reader.integration}</p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold">
                <a className="text-[#087a70] underline-offset-2 hover:underline" href={reader.url} rel="noreferrer" target="_blank">Produto oficial</a>
                <a className="text-[#087a70] underline-offset-2 hover:underline" href={reader.docsUrl} rel="noreferrer" target="_blank">SDK / API</a>
              </div>
            </article>
          ))}
        </div>
        <p className="app-panel-footer">
          A lista e uma triagem tecnica, nao um ranking de vendas nem recomendacao de compra. O modelo final depende do tablet/computador, sistema operacional, politica de dados e teste do fornecedor.
        </p>
      </section>
    </div>
  );
}

function CompaniesScreen({
  canEdit,
  canInviteOwner,
  company,
  invites,
  onAction,
}: {
  canEdit: boolean;
  canInviteOwner: boolean;
  company: MainCompanyProfile | null;
  invites: TenantInvite[];
  onAction: (action: string, overrideFields?: Record<string, string>) => Promise<void> | void;
}) {
  const [openCompanySections, setOpenCompanySections] = useState({
    adjustments: false,
    backup: false,
    photos: false,
    profile: true,
    rules: false,
    shifts: false,
    users: false,
  });
  const savedCompanySchedule = (company?.defaultSchedule || {}) as Record<string, unknown>;
  const savedCompanyPeriods = Array.isArray(savedCompanySchedule.periods)
    ? savedCompanySchedule.periods as Array<{ start?: string; end?: string }>
    : [];
  const [companyJourney, setCompanyJourney] = useState({
    days: String(savedCompanySchedule.workDaysPerWeek || getCompanyWorkPolicy(company).scheduledDays),
  });
  const [companyPeriods, setCompanyPeriods] = useState(() => Array.from({ length: 4 }, (_, index) => ({
    start: String(savedCompanyPeriods[index]?.start || (savedCompanyPeriods.length ? "" : index === 0 ? "07:00" : index === 1 ? "13:00" : "")),
    end: String(savedCompanyPeriods[index]?.end || (savedCompanyPeriods.length ? "" : index === 0 ? "11:30" : index === 1 ? "17:15" : "")),
  })));
  const [companyBankHours, setCompanyBankHours] = useState(
    savedCompanySchedule.bankHoursEnabled !== false && getCompanyWorkPolicy(company).bankHoursEnabled,
  );
  const [companyScheduleName, setCompanyScheduleName] = useState(
    String(savedCompanySchedule.name || "Jornada padrão da empresa"),
  );
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"Proprietario" | "Administrador" | "Leitor">("Administrador");

  function updateCompanyJourney(field: keyof typeof companyJourney, value: string) {
    setCompanyJourney((current) => ({ ...current, [field]: value }));
  }

  function setCompanySection(section: keyof typeof openCompanySections, open: boolean) {
    setOpenCompanySections((current) => ({ ...current, [section]: open }));
  }

  async function copyInviteLink(code: string) {
    const query = new URLSearchParams({ convite: code });
    const link = `${window.location.origin}/?${query.toString()}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        const input = document.createElement("textarea");
        input.value = link;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.append(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      onAction("Link do convite copiado. Envie-o manualmente para o e-mail convidado.");
    } catch {
      onAction(`Copie e envie este link para o e-mail convidado: ${link}`);
    }
  }

  const address = (company?.address || {}) as Record<string, string>;
  const workPolicy = getCompanyWorkPolicy(company);

  return (
    <>
      {!canEdit && (
        <div className="rounded-lg border border-[#efd9a8] bg-[#fff8e9] p-4 text-sm font-semibold text-[#8a5a00]">
          Seu perfil permite visualizar, mas nao alterar as configuracoes da empresa.
        </div>
      )}

      <CollapsiblePanel
        isOpen={openCompanySections.profile}
        onToggle={() => setCompanySection("profile", !openCompanySections.profile)}
        title="Perfil da empresa"
        subtitle="Dados principais do CNPJ"
      >
        <fieldset disabled={!canEdit}>
          <div className="grid gap-3 md:grid-cols-3">
            <MaskedField label="Razao social" mask="name" placeholder="Razao social da empresa" value={String(company?.legalName || "")} />
            <MaskedField label="Nome fantasia" mask="name" placeholder="Nome fantasia" value={String(company?.tradeName || "")} />
            <MaskedField label="CNPJ" mask="cnpj" placeholder="00.000.000/0000-00" value={String(company?.cnpj || "")} />
            <Field label="Inscricao estadual"><input className="input" defaultValue={String(company?.stateRegistration || "")} placeholder="000.000.000.000" /></Field>
            <MaskedField label="Responsavel" mask="name" placeholder="Nome Do Responsavel" value={String(company?.contactName || "")} />
            <MaskedField label="Celular" mask="phone" placeholder="(00) 00000-0000" value={String(company?.contactPhone || "")} />
            <Field label="E-mail"><input className="input" defaultValue={String(company?.contactEmail || "")} placeholder="contato@empresa.com" /></Field>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <MaskedField label="CEP" mask="cep" placeholder="00000-000" value={address.zipCode || ""} />
            <Field label="Logradouro"><input className="input" defaultValue={address.street || ""} placeholder="Rua, avenida ou estrada" /></Field>
            <Field label="Numero"><input className="input" defaultValue={address.number || ""} placeholder="123" /></Field>
            <Field label="Complemento"><input className="input" defaultValue={address.complement || ""} placeholder="Galpao, sala, lote" /></Field>
            <Field label="Bairro"><input className="input" defaultValue={address.district || ""} placeholder="Centro" /></Field>
            <Field label="Cidade"><input className="input" defaultValue={address.city || ""} placeholder="Cidade" /></Field>
            <Field label="UF">
              <select className="input" defaultValue={address.state || "SP"}>
                <option>SP</option>
                <option>MG</option>
                <option>RJ</option>
                <option>PR</option>
                <option>SC</option>
                <option>RS</option>
                <option>GO</option>
                <option>BA</option>
              </select>
            </Field>
          </div>
        </fieldset>
          <ActionRow>
            <SaveButton disabled={!canEdit} onClick={() => onAction("Cadastro da empresa principal")}>Salvar empresa</SaveButton>
            <button className="secondary-button" disabled={!canEdit} onClick={() => onAction("Validacao de CNPJ")} type="button">Validar CNPJ</button>
          </ActionRow>
      </CollapsiblePanel>

      <CollapsiblePanel
        isOpen={openCompanySections.backup}
        onToggle={() => setCompanySection("backup", !openCompanySections.backup)}
        title="Foto e backup"
        subtitle="Identidade visual e seguranca local"
      >
          <div className="grid gap-4">
            <div className="grid min-h-[180px] place-items-center rounded-md border border-dashed border-[#aeb9c5] bg-[#fbfcfd] p-4 text-center">
              <div>
                {company?.logoUrl ? (
                  <img
                    alt="Logo da empresa"
                    className="mx-auto h-20 w-20 rounded-md border border-[#d9e0e7] object-cover"
                    src={company.logoUrl}
                  />
                ) : (
                  <div className="mx-auto grid h-20 w-20 place-items-center rounded-md bg-[#edf5f2] text-2xl font-black text-[#18594c]">
                    O
                  </div>
                )}
                <p className="mt-3 text-sm font-semibold text-[#26323f]">Logo ou foto da empresa</p>
                <p className="mt-1 text-xs leading-5 text-[#667085]">Usada em perfil, relatorios e tela do tablet.</p>
              </div>
            </div>
            <button className="secondary-button" disabled={!canEdit} onClick={() => onAction("Upload de logo da empresa")} type="button">Selecionar imagem</button>
            <SaveButton disabled={!canEdit} onClick={() => onAction("Backup local completo")}>Gerar backup local</SaveButton>
            <CheckList
              items={[
                "Backup inclui dados, relatorios e referencias das fotos",
                "Fotos ficam na nuvem e podem entrar no pacote quando disponivel",
                "Use backup mensal como camada extra de seguranca",
              ]}
            />
          </div>
      </CollapsiblePanel>

      <CollapsiblePanel
        isOpen={openCompanySections.shifts}
        onToggle={() => setCompanySection("shifts", !openCompanySections.shifts)}
        title="Escalas da empresa"
        subtitle="Até quatro pares de entrada e saída, configuráveis por empresa"
      >
        <fieldset disabled={!canEdit}>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Nome da escala"><input className="input" onChange={(event) => setCompanyScheduleName(event.target.value)} value={companyScheduleName} /></Field>
          {companyPeriods.map((period, index) => (
            <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={index}>
              <p className="mb-3 text-sm font-semibold text-[#26323f]">Período {index + 1}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <TimeStepper label={`Entrada ${index + 1}`} onChange={(value) => setCompanyPeriods((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, start: value } : item))} value={period.start} />
                <TimeStepper label={`Saída ${index + 1}`} onChange={(value) => setCompanyPeriods((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, end: value } : item))} value={period.end} />
              </div>
            </div>
          ))}
          <Field label="Dias por semana">
            <select className="input" onChange={(event) => updateCompanyJourney("days", event.target.value)} value={companyJourney.days}>
              <option value="5">5 dias</option>
              <option value="6">6 dias</option>
              <option value="7">7 dias</option>
            </select>
          </Field>
          <label className="flex items-center gap-3 rounded-md border border-[#e3e8ee] bg-white p-3 text-sm font-semibold text-[#26323f]">
            <input checked={companyBankHours} onChange={(event) => setCompanyBankHours(event.target.checked)} type="checkbox" />
            Ativar banco de horas para esta empresa
          </label>
        </div>
        </fieldset>
        <ActionRow>
          <SaveButton disabled={!canEdit} onClick={() => onAction("Escala coletiva da empresa", {
            "Dias por semana": companyJourney.days,
            "Banco de horas": companyBankHours ? "Ativo" : "Inativo",
            ...Object.fromEntries(companyPeriods.flatMap((period, index) => [
              [`Entrada ${index + 1}`, period.start],
              [`Saída ${index + 1}`, period.end],
            ])),
          })}>Salvar escala</SaveButton>
          <button className="secondary-button" onClick={() => onAction("Previa da jornada coletiva")} type="button">Ver previa</button>
        </ActionRow>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {companyPeriods.map((period, index) => (
            <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={`${period.start}-${period.end}-${index}`}>
              <p className="text-sm font-semibold text-[#26323f]">Período {index + 1}</p>
              <p className="mt-1 text-xs text-[#667085]">Entrada {index + 1}: {period.start} · Saída {index + 1}: {period.end}</p>
            </div>
          ))}
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel
        isOpen={openCompanySections.photos}
        onToggle={() => setCompanySection("photos", !openCompanySections.photos)}
        title="Politica de fotos"
        subtitle="Armazenamento e LGPD"
      >
        <fieldset disabled={!canEdit}>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Retencao das fotos">
              <select className="input" defaultValue={workPolicy.absenceMode === "day" ? "Por dia" : "Por periodo"}>
                <option>5 anos</option>
                <option>2 anos</option>
                <option>Personalizado</option>
              </select>
            </Field>
            <Field label="Qualidade da foto">
              <select className="input">
                <option>Compactada - recomendado</option>
                <option>Alta qualidade</option>
              </select>
            </Field>
            <Field label="Banco de horas">
              <select className="input">
                <option>Ativo</option>
                <option>Inativo</option>
              </select>
            </Field>
            <Field label="Tolerancia padrao">
              <input className="input" placeholder="10 min" />
            </Field>
          </div>
        </fieldset>
      </CollapsiblePanel>

      <CollapsiblePanel
        isOpen={openCompanySections.rules}
        onToggle={() => setCompanySection("rules", !openCompanySections.rules)}
        title="Politica de faltas"
        subtitle="Configuravel conforme a regra do cliente"
      >
        <fieldset disabled={!canEdit}>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Tipo de controle">
              <select className="input">
                <option>Por periodo</option>
                <option>Por dia</option>
                <option>Personalizado</option>
              </select>
            </Field>
            <Field label="Aprovacao de ajuste">
              <select className="input" defaultValue={workPolicy.forgottenPunchPolicy}>
                <option>Obrigatoria</option>
                <option>Exige aprovacao</option>
                <option>Opcional</option>
                <option>Bloqueada</option>
              </select>
            </Field>
            <Field label="Valor falta manha"><input className="input" defaultValue={String(workPolicy.morningAbsenceWeight)} placeholder="1" /></Field>
            <Field label="Valor falta tarde"><input className="input" defaultValue={String(workPolicy.afternoonAbsenceWeight)} placeholder="1" /></Field>
            <Field label="Valor falta dia inteiro"><input className="input" defaultValue={String(workPolicy.fullDayAbsenceWeight)} placeholder="2" /></Field>
            <Field label="Dias por semana">
              <select className="input" defaultValue={String(workPolicy.scheduledDays)}>
                <option value="5">5 dias</option>
                <option value="6">6 dias</option>
                <option value="7">7 dias</option>
              </select>
            </Field>
            <Field label="Tolerancia padrao">
              <input className="input" defaultValue={String(workPolicy.toleranceMinutes)} placeholder="10 min" />
            </Field>
            <Field label="Banco de horas">
              <select className="input" defaultValue={workPolicy.bankHoursEnabled ? "Ativo" : "Inativo"}>
                <option>Ativo</option>
                <option>Inativo</option>
              </select>
            </Field>
            <Field label="Trabalho externo">
              <select className="input" defaultValue={workPolicy.externalWorkPolicy}>
                <option>Permitir com justificativa</option>
                <option>Permitir com foto</option>
                <option>Permitir com geolocalizacao</option>
                <option>Nao permitir</option>
              </select>
            </Field>
          </div>
          <CheckList
            items={[
              "As faltas e esquecimentos seguem a politica salva para este cliente",
              "Mudancas devem ficar registradas em log de auditoria",
            ]}
          />
        </fieldset>
        <ActionRow>
          <SaveButton disabled={!canEdit} onClick={() => onAction("Politica de calculo da empresa")}>Salvar politica</SaveButton>
        </ActionRow>
      </CollapsiblePanel>

      <CollapsiblePanel
        isOpen={openCompanySections.users}
        onToggle={() => setCompanySection("users", !openCompanySections.users)}
        title="Usuarios da empresa"
        subtitle="Login por convite"
      >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="E-mail do usuário">
              <input className="input" autoComplete="email" onChange={(event) => setInviteEmail(event.target.value)} placeholder="usuario@empresa.com" type="email" value={inviteEmail} />
            </Field>
            <Field label="Perfil de acesso">
              <select className="input" onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)} value={inviteRole}>
                <option>Administrador</option>
                <option>Leitor</option>
                {canInviteOwner && <option>Proprietario</option>}
              </select>
            </Field>
          </div>
          <CheckList
            items={[
              "Proprietario tem acesso total",
              "Administrador gerencia operacao",
              "Leitor apenas visualiza relatorios",
              "Convites ativos exibem link para compartilhamento",
            ]}
          />
        <ActionRow>
            <SaveButton disabled={!canEdit || !inviteEmail.trim()} onClick={() => onAction("Convite por e-mail", { Email: inviteEmail, Perfil: inviteRole })}>Convidar usuario</SaveButton>
        </ActionRow>
        <div className="mt-4 grid gap-2">
          {invites.length ? invites.map((invite) => (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#d9e0e7] bg-[#fbfcfd] p-3" key={invite.code}>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[#142235]">{invite.email || "Convite sem e-mail vinculado"}</p>
                  <p className="mt-1 text-xs text-[#64748b]">{invite.role} · {invite.status} · código {invite.code}</p>
                </div>
                {invite.status === "Ativo" && (
                  <button className="secondary-button" onClick={() => void copyInviteLink(invite.code)} type="button">Copiar link</button>
                )}
              </div>
          )) : <p className="text-sm text-[#64748b]">Nenhum convite criado para esta empresa.</p>}
        </div>
        <p className="mt-2 text-xs text-[#64748b]">O sistema gera código e link; o envio por e-mail é manual, pois não há serviço de envio configurado.</p>
      </CollapsiblePanel>

      <CollapsiblePanel
        isOpen={openCompanySections.adjustments}
        onToggle={() => setCompanySection("adjustments", !openCompanySections.adjustments)}
        title="Ajuste permitido"
        subtitle="Configurado pela politica do cliente"
      >
          <CheckList
            items={[
              "Esquecimento pode exigir evidencia no mesmo periodo",
              "Ajuste manual exige motivo e responsavel",
              "Batida do gestor pode ser permitida para trabalho externo",
              "Relatorio mostra a classificacao conforme a politica ativa",
            ]}
          />
      </CollapsiblePanel>
    </>
  );
}

function EmployeesScreen({ canEdit, company, onAction }: { canEdit: boolean; company: MainCompanyProfile | null; onAction: (action: string) => void }) {
  const companyId = useActiveCompanyId();
  const [journeyMode, setJourneyMode] = useState<"coletiva" | "individual">("coletiva");
  const emptyEmployeeForm = {
    admissionDate: "",
    cbo: "",
    cpf: "",
    department: "",
    externalPunchAllowed: false,
    name: "",
    phone: "",
    pin: "",
    punchMode: "automatic" as "automatic" | "manual",
    registration: "",
    role: "",
  };
  const [employeeForm, setEmployeeForm] = useState(emptyEmployeeForm);
  const [editingEmployeeId, setEditingEmployeeId] = useState<string | null>(null);
  const [localEmployees, setLocalEmployees] = useState<LocalEmployee[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<LocalEmployee | null>(null);
  const [selectedEmployeePunches, setSelectedEmployeePunches] = useState<Punch[]>([]);
  const [selectedEmployeePunchesLoading, setSelectedEmployeePunchesLoading] = useState(false);
  const [employeePhotoUrls, setEmployeePhotoUrls] = useState<Record<string, string>>({});
  const [holeriteImportDraft, setHoleriteImportDraft] = useState<HoleriteImportDraft | null>(null);
  const [holeriteImportLoading, setHoleriteImportLoading] = useState(false);
  const [employeeSource, setEmployeeSource] = useState<"manual" | "holerite">("manual");
  const [openEmployeeSections, setOpenEmployeeSections] = useState<Record<EmployeeSection, boolean>>({
    detail: false,
    face: false,
    form: false,
    list: true,
  });
  const [showFaceCamera, setShowFaceCamera] = useState(false);
  const [replaceFaceProfile, setReplaceFaceProfile] = useState(false);
  const [biometricConsentAccepted, setBiometricConsentAccepted] = useState(false);
  const [faceSaving, setFaceSaving] = useState(false);
  const [faceCompletion, setFaceCompletion] = useState<{
    employee: LocalEmployee;
    nextPending: LocalEmployee | null;
  } | null>(null);
  const [employeeJourney, setEmployeeJourney] = useState({ days: "5" });
  const [employeePeriods, setEmployeePeriods] = useState([
    { start: "07:00", end: "11:30" },
    { start: "13:00", end: "17:15" },
    { start: "", end: "" },
    { start: "", end: "" },
  ]);
  const companyPeriods = Array.isArray((company?.defaultSchedule as Record<string, unknown> | undefined)?.periods)
    ? (company?.defaultSchedule as { periods: Array<{ start: string; end: string }> }).periods.slice(0, 4)
    : [
        { start: "07:00", end: "11:30" },
        { start: "13:00", end: "17:15" },
      ];

  function updateEmployeeJourney(field: keyof typeof employeeJourney, value: string) {
    setEmployeeJourney((current) => ({ ...current, [field]: value }));
  }

  const faceReadyCount = localEmployees.filter((employee) => employee.faceIdStatus === "registered").length;
  const facePendingEmployees = localEmployees.filter((employee) => employee.faceIdStatus !== "registered");
  const facePendingCount = facePendingEmployees.length;
  const faceProgress = localEmployees.length
    ? Math.round((faceReadyCount / localEmployees.length) * 100)
    : 0;

  function setEmployeeSection(section: EmployeeSection, open: boolean) {
    setOpenEmployeeSections((current) => ({ ...current, [section]: open }));
  }

  async function loadEmployeePhoto(employee: LocalEmployee) {
    if (!employee.profilePhotoPath || employeePhotoUrls[employee.employeeId]) return;

    try {
      const url = await getStorageFileUrl(employee.profilePhotoPath);
      setEmployeePhotoUrls((current) => ({ ...current, [employee.employeeId]: url }));
    } catch {
      // A foto continua opcional; falha de exibicao nao pode bloquear a ficha.
    }
  }

  async function loadEmployeePunches(employee: LocalEmployee) {
    setSelectedEmployeePunchesLoading(true);
    try {
      const punches = await listEmployeePunchesByIds(companyId, [
        employee.employeeId,
      ]);
      const sorted = punches.sort((first, second) =>
        punchDate(second).getTime() - punchDate(first).getTime(),
      );
      setSelectedEmployeePunches(sorted);
      setSelectedEmployee((current) =>
        current?.employeeId === employee.employeeId
          ? { ...current, lastPunch: sorted[0] ? formatPunchDateTime(sorted[0]) : "Sem batidas registradas" }
          : current,
      );
    } catch {
      setSelectedEmployeePunches([]);
      onAction("Nao foi possivel carregar as batidas reais deste colaborador.");
    } finally {
      setSelectedEmployeePunchesLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;

    async function loadEmployees() {
      const savedInBrowser = getLocalEmployees();
      setLocalEmployees(savedInBrowser);

      try {
        const savedInFirebase = await listEmployees(companyId);
        if (!mounted) return;

        const legacyPins = savedInFirebase
          .map((employee) => ({
            employeeId: employee.id,
            pin: String((employee as unknown as Record<string, unknown>).pin || ""),
          }))
          .filter((employee) => employee.pin);

        if (canEdit && legacyPins.length) {
          await Promise.all(legacyPins.map((employee) =>
            saveEmployeePin(companyId, employee.employeeId, employee.pin),
          ));
        }

        const mapped = savedInFirebase
          .map((employee) => toLocalEmployee(employee as unknown as Record<string, unknown>, employee.id))
          .filter((employee) => employee.active !== false);
        setLocalEmployees(mapped);
        window.localStorage.setItem(LOCAL_EMPLOYEES_KEY, JSON.stringify(mapped));
      } catch {
        if (savedInBrowser.length === 0) setLocalEmployees([]);
      }
    }

    void loadEmployees();

    return () => {
      mounted = false;
    };
  }, [canEdit, companyId]);

  useEffect(() => {
    localEmployees.forEach((employee) => {
      if (!employee.profilePhotoPath || employeePhotoUrls[employee.employeeId]) return;

      void getStorageFileUrl(employee.profilePhotoPath)
        .then((url) => setEmployeePhotoUrls((current) => ({ ...current, [employee.employeeId]: url })))
        .catch(() => undefined);
    });
  }, [employeePhotoUrls, localEmployees]);

  function updateEmployeeForm<K extends keyof typeof employeeForm>(field: K, value: (typeof employeeForm)[K]) {
    setEmployeeForm((current) => ({ ...current, [field]: value }));
  }

  function startNewEmployee() {
    if (!canEdit) return;
    setEmployeeForm(emptyEmployeeForm);
    setHoleriteImportDraft(null);
    setEmployeeSource("manual");
    setEditingEmployeeId(null);
    setSelectedEmployee(null);
    setEmployeePeriods(Array.from({ length: 4 }, (_, index) => ({
      start: companyPeriods[index]?.start || "",
      end: companyPeriods[index]?.end || "",
    })));
    setShowFaceCamera(false);
    setBiometricConsentAccepted(false);
    setReplaceFaceProfile(false);
    setFaceCompletion(null);
    setOpenEmployeeSections({ detail: false, face: false, form: true, list: true });
    onAction("Novo colaborador: formulario limpo para cadastro.");
    document.getElementById("employee-form-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function cancelEmployeeEdit() {
    setEmployeeForm(emptyEmployeeForm);
    setHoleriteImportDraft(null);
    setEmployeeSource("manual");
    setEditingEmployeeId(null);
    setShowFaceCamera(false);
    setBiometricConsentAccepted(false);
    setReplaceFaceProfile(false);
    setFaceCompletion(null);
    setEmployeeSection("form", false);
    onAction("Edicao cancelada. Nenhuma alteracao foi salva.");
  }

  function startFaceRegistration(employee?: EmployeeRow, options?: { replace?: boolean }) {
    if (!canEdit) return;
    const target = employee
      ? toLocalEmployee(employee as unknown as Record<string, unknown>, employee.employeeId || employee.name)
      : facePendingEmployees[0];

    if (!target) {
      onAction("Todos os colaboradores ja estao com Face ID cadastrado.");
      return;
    }

    setSelectedEmployee(target);
    setEditingEmployeeId(null);
    setReplaceFaceProfile(options?.replace === true);
    setBiometricConsentAccepted(false);
    setFaceCompletion(null);
    setShowFaceCamera(true);
    setOpenEmployeeSections({ detail: false, face: true, form: false, list: true });
    onAction(options?.replace ? `Refazendo o Face ID de ${target.name}. As capturas antigas serão mantidas no histórico.` : `Cadastro de Face ID iniciado para ${target.name}.`);
    window.setTimeout(
      () => document.getElementById("face-id-flow-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      50,
    );
  }

  function viewEmployee(employee: EmployeeRow) {
    const selected = toLocalEmployee(employee as unknown as Record<string, unknown>, employee.employeeId || employee.name);
    setSelectedEmployee(selected);
    setSelectedEmployeePunches([]);
    setShowFaceCamera(false);
    setBiometricConsentAccepted(false);
    setReplaceFaceProfile(false);
    setFaceCompletion(null);
    setOpenEmployeeSections({ detail: true, face: false, form: false, list: true });
    onAction(`Visualizando cadastro de ${selected.name}.`);
    void loadEmployeePhoto(selected);
    void loadEmployeePunches(selected);
    window.setTimeout(
      () => document.getElementById("employee-detail-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      50,
    );
  }

  function editEmployee(employee: EmployeeRow) {
    if (!canEdit) return;
    const selected = toLocalEmployee(employee as unknown as Record<string, unknown>, employee.employeeId || employee.name);
    setSelectedEmployee(selected);
    setEmployeePeriods(Array.from({ length: 4 }, (_, index) => ({
      start: selected.schedule.periods?.[index]?.start || "",
      end: selected.schedule.periods?.[index]?.end || "",
    })));
    setHoleriteImportDraft(null);
    setEmployeeSource("manual");
    setEditingEmployeeId(employeeDocumentId(selected));
    setShowFaceCamera(false);
    setBiometricConsentAccepted(false);
    setReplaceFaceProfile(false);
    setFaceCompletion(null);
    setOpenEmployeeSections({ detail: false, face: false, form: true, list: true });
    setEmployeeForm({
      admissionDate: selected.admissionDate || "",
      cbo: selected.cbo || "",
      cpf: selected.cpf === "Nao informado" ? "" : selected.cpf,
      department: selected.department || "",
      externalPunchAllowed: selected.externalPunchAllowed === true,
      name: selected.name,
      phone: selected.phone || "",
      pin: selected.pin || "",
      punchMode: selected.punchMode,
      registration: selected.registration || "",
      role: selected.role === "Nao informado" ? "" : selected.role,
    });
    onAction(`Editando cadastro de ${selected.name}.`);
    window.setTimeout(
      () => document.getElementById("employee-form-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      50,
    );
  }

  function importEmployeesFromJson(file?: File) {
    if (!canEdit) return;
    if (!file) return;

    const reader = new FileReader();

    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}")) as
          | ImportedEmployee[]
          | { employees?: ImportedEmployee[] };
        const imported = Array.isArray(parsed) ? parsed : parsed.employees || [];
        const mappedEmployees: LocalEmployee[] = imported
          .filter((employee) => employee.name?.trim())
          .map((employee) => ({
            admissionDate: employee.admissionDate || "Nao informado",
            bank: "00:00",
            cbo: employee.cbo || "",
            cpf: employee.cpf || "Nao informado",
            department: employee.department || "Geral",
            employeeId: employee.registration ? `matricula-${onlyDigits(employee.registration)}` : crypto.randomUUID(),
            externalPunchAllowed: employee.externalPunchAllowed === true,
            faceIdStatus: employee.faceIdStatus || "not_registered",
            lastPunch: "Sem batida hoje",
            name: employee.name.trim(),
            phone: employee.phone || "",
            pin: employee.pin || "",
            pinConfigured: Boolean(employee.pin),
            punchMode: "automatic",
            registration: employee.registration || "",
            role: employee.role || "Nao informado",
            schedule: {
              breakEnd: initialShifts[0].breakEnd,
              breakStart: initialShifts[0].breakStart,
              end: initialShifts[0].end,
              start: initialShifts[0].start,
              toleranceMinutes: Number.parseInt(initialShifts[0].tolerance, 10) || 10,
            },
            shift: "Jornada da empresa",
            status: "Pre-cadastro - revisar",
          }));

        if (!mappedEmployees.length) {
          onAction("Nenhum colaborador valido encontrado no arquivo.");
          return;
        }

        await Promise.all(mappedEmployees.map(async (employee) => {
          const documentId = employeeDocumentId(employee);
          const { pin: importedPin, ...employeeWithoutPin } = employee;
          await upsertEmployee(companyId, documentId, {
            ...employeeWithoutPin,
            importSource: "json-import",
            importedAt: new Date().toISOString(),
          });
          if (importedPin) await saveEmployeePin(companyId, documentId, importedPin);
        }));

        const existingIds = new Set(mappedEmployees.map((employee) => employeeDocumentId(employee)));
        const sanitizedEmployees = mappedEmployees.map((employee) => ({ ...employee, pin: "" }));
        const updated = [
          ...sanitizedEmployees,
          ...localEmployees.filter((employee) => !existingIds.has(employeeDocumentId(employee))),
        ];
        window.localStorage.setItem(LOCAL_EMPLOYEES_KEY, JSON.stringify(updated));
        setLocalEmployees(updated);
        setSelectedEmployee(sanitizedEmployees[0]);
        onAction(`${mappedEmployees.length} colaboradores importados do arquivo JSON.`);
      } catch {
        onAction("Nao foi possivel importar os colaboradores. Verifique login e permissoes.");
      }
    };

    reader.readAsText(file);
  }

  function prepareHoleriteDraft(
    fields: ImportedEmployee,
    fileName: string,
    missing: string[],
    pages?: number,
    warnings: string[] = [],
  ) {
    setEmployeeForm((current) => ({
      ...current,
      admissionDate: fields.admissionDate || "",
      cbo: fields.cbo || "",
      cpf: fields.cpf || "",
      department: fields.department || "",
      name: fields.name || "",
      phone: fields.phone || "",
      pin: "",
      registration: fields.registration || "",
      role: fields.role || "",
    }));
    setEmployeeSource("holerite");
    setEditingEmployeeId(null);
    setSelectedEmployee(null);
    setHoleriteImportDraft({ fileName, fields, missing, pages, warnings });
    setOpenEmployeeSections({ detail: false, face: false, form: true, list: true });
    onAction("Dados do holerite carregados para conferência. Nenhum colaborador foi salvo ainda.");
    window.setTimeout(
      () => document.getElementById("employee-form-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      50,
    );
  }

  async function importEmployeeFromHolerite(file?: File) {
    if (!canEdit || !file) return;
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      onAction("Envie um holerite em PDF. Imagens escaneadas precisarão de OCR em uma etapa posterior.");
      return;
    }

    setHoleriteImportLoading(true);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) {
        onAction("Sua sessão expirou. Entre novamente para importar o holerite.");
        return;
      }

      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/holerite/parse", {
        body: formData,
        headers: { Authorization: `Bearer ${idToken}` },
        method: "POST",
      });
      const result = await response.json() as {
        error?: string;
        fields?: ImportedEmployee;
        fileName?: string;
        missing?: string[];
        pages?: number;
        warnings?: string[];
      };

      if (!response.ok || !result.fields) {
        onAction(result.error || "Não foi possível extrair os dados do holerite.");
        return;
      }

      prepareHoleriteDraft(
        result.fields,
        result.fileName || file.name,
        result.missing || [],
        result.pages,
        result.warnings || [],
      );
    } catch {
      onAction("Não foi possível ler o holerite. Verifique sua conexão e tente novamente.");
    } finally {
      setHoleriteImportLoading(false);
    }
  }

  function discardHoleriteDraft() {
    setHoleriteImportDraft(null);
    setEmployeeSource("manual");
    setEmployeeForm(emptyEmployeeForm);
    onAction("Importação descartada. Nenhum dado do holerite foi salvo.");
  }

  async function saveEmployee() {
    if (!canEdit) return;
    if (!employeeForm.name.trim() || (!editingEmployeeId && employeeForm.pin.length < 4)) {
      onAction("Informe o nome e um PIN de pelo menos 4 números.");
      return;
    }

    const companyShift = initialShifts[0];
    const completedEmployeePeriods = employeePeriods.filter((period) => period.start && period.end);
    const invalidEmployeePeriods = completedEmployeePeriods.some((period) =>
      !/^\d{2}:\d{2}$/.test(period.start)
      || !/^\d{2}:\d{2}$/.test(period.end)
      || timeToMinutes(period.end) <= timeToMinutes(period.start),
    );
    if (journeyMode === "individual" && (!completedEmployeePeriods.length || invalidEmployeePeriods)) {
      onAction("A jornada individual precisa de pelo menos um par válido de entrada e saída.");
      return;
    }
    const schedule =
      journeyMode === "individual"
        ? {
            breakEnd: completedEmployeePeriods[1]?.start || "",
            breakStart: completedEmployeePeriods[0]?.end || "",
            end: completedEmployeePeriods[completedEmployeePeriods.length - 1]?.end || "",
            periods: completedEmployeePeriods,
            start: completedEmployeePeriods[0]?.start || "",
            toleranceMinutes: 10,
          }
        : {
            breakEnd: companyPeriods[1]?.start || companyShift.breakEnd,
            breakStart: companyPeriods[0]?.end || companyShift.breakStart,
            end: companyPeriods[companyPeriods.length - 1]?.end || companyShift.end,
            periods: companyPeriods,
            start: companyPeriods[0]?.start || companyShift.start,
            toleranceMinutes: Number.parseInt(companyShift.tolerance, 10) || 10,
          };
    const employee: LocalEmployee = {
      active: selectedEmployee?.active !== false,
      admissionDate: employeeForm.admissionDate || "Nao informado",
      bank: "00:00",
      cbo: employeeForm.cbo || "",
      cpf: employeeForm.cpf || "Não informado",
      department: employeeForm.department || "Geral",
      documentId: selectedEmployee?.documentId,
      employeeId: selectedEmployee?.employeeId || crypto.randomUUID(),
      externalPunchAllowed: employeeForm.externalPunchAllowed,
      faceIdStatus: selectedEmployee?.faceIdStatus || "not_registered",
      lastPunch: "Sem batida hoje",
      name: employeeForm.name.trim(),
      phone: employeeForm.phone || "",
      pin: "",
      pinConfigured: Boolean(employeeForm.pin || selectedEmployee?.pinConfigured),
      punchMode: employeeForm.punchMode,
      registration: employeeForm.registration || "",
      role: employeeForm.role || "Não informado",
      schedule,
      shift: "Jornada da empresa",
      status: editingEmployeeId ? "Atualizado" : "Cadastrado",
    };
    const documentId = editingEmployeeId || employeeDocumentId(employee);
    const updated = editingEmployeeId
      ? localEmployees.map((item) => (employeeDocumentId(item) === documentId ? employee : item))
      : [employee, ...localEmployees];

    const employeeWithoutPin = Object.fromEntries(
      Object.entries(employee).filter(([key]) => key !== "pin" && key !== "documentId"),
    );
    await upsertEmployee(companyId, documentId, {
      ...employeeWithoutPin,
      ...(editingEmployeeId ? {} : { createdAt: new Date().toISOString() }),
      source: employeeSource === "holerite" ? "holerite-import" : "manual",
      ...(employeeSource === "holerite" ? { importFileName: holeriteImportDraft?.fileName || "holerite.pdf" } : {}),
    });
    if (employeeForm.pin) await saveEmployeePin(companyId, documentId, employeeForm.pin);

    window.localStorage.setItem(LOCAL_EMPLOYEES_KEY, JSON.stringify(updated));
    setLocalEmployees(updated);
    setSelectedEmployee(employee);
    setEditingEmployeeId(documentId);
    setShowFaceCamera(false);
    setHoleriteImportDraft(null);
    setEmployeeSource("manual");
    onAction(`${employee.name} ${editingEmployeeId ? "atualizado" : "cadastrado"} com sucesso.`);
  }

  function openFaceRegistration() {
    if (!selectedEmployee) {
      onAction("Cadastre primeiro o colaborador para vincular o Face ID.");
      return;
    }
    setShowFaceCamera(true);
  }

  function updateEmployeeProfilePhoto(employee: LocalEmployee, photoPath: string, previewUrl?: string) {
    if (previewUrl) {
      setEmployeePhotoUrls((urls) => ({ ...urls, [employee.employeeId]: previewUrl }));
    }
    setLocalEmployees((employees) => {
      const updated = employees.map((item) =>
        item.employeeId === employee.employeeId ? { ...item, profilePhotoPath: photoPath } : item,
      );
      window.localStorage.setItem(LOCAL_EMPLOYEES_KEY, JSON.stringify(updated));
      return updated;
    });
    setSelectedEmployee((current) =>
      current?.employeeId === employee.employeeId ? { ...current, profilePhotoPath: photoPath } : current,
    );
  }

  async function changeEmployeePhoto(file?: File) {
    if (!canEdit) return;
    if (!file || !selectedEmployee) return;

    if (!file.type.startsWith("image/")) {
      onAction("Escolha um arquivo de imagem para a foto do colaborador.");
      return;
    }

    try {
      const photoPath = await uploadFacePhoto({
        blob: file,
        companyId,
        employeeId: selectedEmployee.employeeId,
        photoId: `perfil-${crypto.randomUUID()}`,
      });
      updateEmployeeProfilePhoto(selectedEmployee, photoPath, URL.createObjectURL(file));
      await upsertEmployee(companyId, employeeDocumentId(selectedEmployee), { profilePhotoPath: photoPath });
      onAction(`Foto de ${selectedEmployee.name} atualizada.`);
    } catch (error) {
      console.error(error);
      onAction("Nao foi possivel salvar a foto do colaborador. Verifique Storage e permissao.");
    }
  }

  async function resetFaceId(employee: LocalEmployee) {
    if (!canEdit) return;
    const confirmed = window.confirm(
      `Limpar o Face ID de ${employee.name}? O cadastro facial ativo será removido e será necessário fazer novas capturas. A foto principal e o histórico serão preservados.`,
    );
    if (!confirmed) return;

    try {
      await upsertEmployee(companyId, employeeDocumentId(employee), {
        faceCaptureCount: 0,
        faceIdStatus: "not_registered",
        faceRegisteredAt: null,
        status: "Face ID pendente",
      });
      clearLocalFaceProfile(employee.employeeId);
      const updated = localEmployees.map((item) =>
        item.employeeId === employee.employeeId
          ? { ...item, faceIdStatus: "not_registered" as const, status: "Face ID pendente" }
          : item,
      );
      window.localStorage.setItem(LOCAL_EMPLOYEES_KEY, JSON.stringify(updated));
      setLocalEmployees(updated);
      setSelectedEmployee((current) =>
        current?.employeeId === employee.employeeId
          ? { ...current, faceIdStatus: "not_registered", status: "Face ID pendente" }
          : current,
      );
      setReplaceFaceProfile(false);
      setFaceCompletion(null);
      onAction(`Face ID de ${employee.name} limpo. O histórico antigo foi preservado.`);
    } catch (error) {
      console.error(error);
      onAction("Não foi possível limpar o Face ID. Verifique sua sessão e tente novamente.");
    }
  }

  async function deactivateEmployee(employee: LocalEmployee) {
    if (!canEdit) return;
    const confirmed = window.confirm(
      `Desativar ${employee.name}? Ele sairá da lista ativa e da sala de ponto, mas as batidas e relatórios antigos serão preservados.`,
    );
    if (!confirmed) return;

    try {
      await upsertEmployee(companyId, employeeDocumentId(employee), {
        active: false,
        status: "Inativo",
      });
      const updated = localEmployees.filter((item) => item.employeeId !== employee.employeeId);
      window.localStorage.setItem(LOCAL_EMPLOYEES_KEY, JSON.stringify(updated));
      setLocalEmployees(updated);
      setSelectedEmployee(null);
      setSelectedEmployeePunches([]);
      setShowFaceCamera(false);
      setReplaceFaceProfile(false);
      setFaceCompletion(null);
      setOpenEmployeeSections({ detail: false, face: false, form: false, list: true });
      onAction(`${employee.name} foi desativado. Histórico preservado.`);
    } catch (error) {
      console.error(error);
      onAction("Não foi possível desativar o colaborador. Verifique sua sessão e tente novamente.");
    }
  }

  async function markFaceRegistered(captureCount: number, photoBlob?: Blob) {
    if (!selectedEmployee) return;
    if (!biometricConsentAccepted) {
      onAction("Confirme o aceite biometrico antes de salvar o cadastro facial.");
      throw new Error("Aceite biométrico não confirmado.");
    }
    if (!photoBlob) {
      onAction("A câmera não conseguiu gerar a foto da captura. Tente novamente com o rosto centralizado.");
      throw new Error("Foto da captura facial indisponível.");
    }

    const employeeAtStart = selectedEmployee;
    const captureId = crypto.randomUUID();

    setFaceSaving(true);
    try {
      const photoPath = await uploadFacePhoto({
        blob: photoBlob,
        companyId,
        employeeId: employeeAtStart.employeeId,
        photoId: captureId,
      });
      await createFaceIdRecord({
        capturedBy: "server-authenticated",
        companyId,
        consentAcceptedAt: new Date(),
        createdAt: new Date(),
        employeeId: employeeAtStart.employeeId,
        photoPath,
      });

      const completed = captureCount >= FACE_ID_REQUIRED_CAPTURES;
      const updated = localEmployees.map((employee) =>
        employee.employeeId === employeeAtStart.employeeId
          ? {
              ...employee,
              faceIdStatus: completed ? "registered" as const : employee.faceIdStatus,
              status: completed ? "Face ID cadastrado" : `Face ID ${captureCount}/${FACE_ID_REQUIRED_CAPTURES}`,
            }
          : employee,
      );
      const current = updated.find((employee) => employee.employeeId === employeeAtStart.employeeId) || null;
      const nextPending = updated.find(
        (employee) => employee.employeeId !== employeeAtStart.employeeId && employee.faceIdStatus !== "registered",
      );

      if (current) {
        await upsertEmployee(companyId, employeeDocumentId(current), {
          faceCaptureCount: captureCount,
          faceIdStatus: completed ? "registered" : current.faceIdStatus,
          ...(completed
            ? { faceRegisteredAt: new Date().toISOString(), status: "Face ID cadastrado" }
            : { status: `Face ID ${captureCount}/${FACE_ID_REQUIRED_CAPTURES}` }),
        });
      }

      window.localStorage.setItem(LOCAL_EMPLOYEES_KEY, JSON.stringify(updated));
      setLocalEmployees(updated);
      setSelectedEmployee(current);

      if (completed) {
        setReplaceFaceProfile(false);
        setShowFaceCamera(false);
        if (current) {
          setFaceCompletion({ employee: current, nextPending: nextPending || null });
        }
        onAction(
          `${employeeAtStart.name}: Face ID concluído e sincronizado. Confira o nome antes de cadastrar outro colaborador.`,
        );
        return;
      }

      onAction(`${employeeAtStart.name}: captura ${captureCount}/${FACE_ID_REQUIRED_CAPTURES} sincronizada no Firebase.`);
    } catch (error) {
      console.error("Não foi possível sincronizar o cadastro facial.", error);
      onAction("A captura foi feita neste aparelho, mas não foi salva no Firebase. Verifique sua sessão e tente novamente.");
      throw error;
    } finally {
      setFaceSaving(false);
    }
  }

  return (
    <>
      <div id="employee-form-panel">
      <CollapsiblePanel
        isOpen={openEmployeeSections.form}
        onToggle={() => setEmployeeSection("form", !openEmployeeSections.form)}
        title={editingEmployeeId ? "Editar colaborador" : "Novo colaborador"}
        subtitle="Dados para ponto, holerite e relatorio mensal"
      >
        <p className="text-sm font-semibold text-[#26323f]">Dados pessoais</p>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <MaskedField label="Nome" mask="name" onChange={(value) => updateEmployeeForm("name", value)} placeholder="Primeira Letra Maiuscula" value={employeeForm.name} />
          <MaskedField label="CPF" mask="cpf" onChange={(value) => updateEmployeeForm("cpf", value)} placeholder="000.000.000-00" value={employeeForm.cpf} />
          <MaskedField label={editingEmployeeId ? "Novo PIN (opcional)" : "PIN"} mask="pin" onChange={(value) => updateEmployeeForm("pin", value)} placeholder="0000" value={employeeForm.pin} />
          <MaskedField label="Celular" mask="phone" onChange={(value) => updateEmployeeForm("phone", value)} placeholder="(00) 00000-0000" value={employeeForm.phone} />
        </div>

        <p className="mt-5 text-sm font-semibold text-[#26323f]">Dados trabalhistas</p>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <Field label="Matricula">
            <input className="input" onChange={(event) => updateEmployeeForm("registration", event.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="00001" value={employeeForm.registration} />
          </Field>
          <MaskedField label="Data de admissao" mask="date" onChange={(value) => updateEmployeeForm("admissionDate", value)} placeholder="00/00/0000" value={employeeForm.admissionDate} />
          <MaskedField label="Cargo" mask="name" onChange={(value) => updateEmployeeForm("role", value)} placeholder="Vendedor" value={employeeForm.role} />
          <MaskedField label="Departamento" mask="name" onChange={(value) => updateEmployeeForm("department", value)} placeholder="Geral" value={employeeForm.department} />
          <Field label="Modo da batida">
            <select
              className="input"
              onChange={(event) =>
                updateEmployeeForm("punchMode", event.target.value as "automatic" | "manual")
              }
              value={employeeForm.punchMode}
            >
              <option value="automatic">Automático - escala normal</option>
              <option value="manual">Manual - horário irregular</option>
            </select>
          </Field>
          <Field label="CBO"><input className="input" onChange={(event) => updateEmployeeForm("cbo", event.target.value.replace(/[^\d-]/g, "").slice(0, 7))} placeholder="0000-00" value={employeeForm.cbo} /></Field>
          <Field label="Tolerancia"><input className="input" placeholder="10 min" /></Field>
        </div>

        <div className="mt-4 flex items-start gap-3 rounded-md border border-[#cfe3dc] bg-[#f1faf7] p-4">
          <input
            checked={employeeForm.externalPunchAllowed}
            className="mt-1 h-4 w-4 accent-[#176b5b]"
            id="external-punch-allowed"
            onChange={(event) => updateEmployeeForm("externalPunchAllowed", event.target.checked)}
            type="checkbox"
          />
          <label className="cursor-pointer" htmlFor="external-punch-allowed">
            <span className="block text-sm font-semibold text-[#173f37]">Autorizar ponto externo</span>
            <span className="mt-1 block text-xs leading-5 text-[#53736c]">
              Permite que este colaborador registre pelo celular com PIN, reconhecimento facial e localizacao como evidencia.
            </span>
          </label>
        </div>

        <div className="mt-5 rounded-md border border-[#d9e0e7] bg-[#fbfcfd] p-4">
          <div className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-semibold text-[#26323f]">Jornada do colaborador</p>
              <p className="mt-1 text-xs leading-5 text-[#667085]">
                Escolha uma escala cadastrada na empresa. Use individual apenas
                quando este funcionario tiver excecao.
              </p>
            </div>
            <div className="grid grid-cols-2 rounded-md border border-[#cbd5df] bg-white p-1 text-xs font-semibold">
              <button
                className={`rounded px-3 py-2 ${journeyMode === "coletiva" ? "bg-[#dcebe6] text-[#143f37]" : "text-[#667085]"}`}
                onClick={() => setJourneyMode("coletiva")}
                type="button"
              >
                Coletiva
              </button>
              <button
                className={`rounded px-3 py-2 ${journeyMode === "individual" ? "bg-[#dcebe6] text-[#143f37]" : "text-[#667085]"}`}
                onClick={() => setJourneyMode("individual")}
                type="button"
              >
                Individual
              </button>
            </div>
          </div>

          {journeyMode === "coletiva" ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <Field label="Jornada coletiva da empresa">
                <select className="input">
                  <option>{String((company?.defaultSchedule as Record<string, unknown> | undefined)?.name || "Jornada padrão da empresa")}</option>
                </select>
              </Field>
              <div className="rounded-md border border-[#cfe3dc] bg-[#f1faf7] p-3 text-sm text-[#24594d]">
                O colaborador seguira a regra padrao da empresa. Se precisar
                excecao, selecione jornada individual.
              </div>
            </div>
          ) : (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {employeePeriods.map((period, index) => (
                <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={index}>
                  <p className="mb-3 text-sm font-semibold text-[#26323f]">Período {index + 1}</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <TimeStepper label={`Entrada ${index + 1}`} onChange={(value) => setEmployeePeriods((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, start: value } : item))} value={period.start} />
                    <TimeStepper label={`Saída ${index + 1}`} onChange={(value) => setEmployeePeriods((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, end: value } : item))} value={period.end} />
                  </div>
                </div>
              ))}
              <Field label="Dias por semana">
                <select className="input" onChange={(event) => updateEmployeeJourney("days", event.target.value)} value={employeeJourney.days}>
                  <option value="5">5 dias</option>
                  <option value="6">6 dias</option>
                  <option value="7">7 dias</option>
                </select>
              </Field>
              <JourneySummary
                breakEnd={employeePeriods[1]?.start || "13:00"}
                breakStart={employeePeriods[0]?.end || "11:30"}
                days={Number(employeeJourney.days)}
                end={employeePeriods.filter((item) => item.start && item.end).slice(-1)[0]?.end || "17:15"}
                start={employeePeriods.find((item) => item.start && item.end)?.start || "07:00"}
              />
            </div>
          )}
        </div>
        <ActionRow>
          <SaveButton disabled={!canEdit} onClick={saveEmployee}>{editingEmployeeId ? "Salvar alteracoes" : "Cadastrar colaborador"}</SaveButton>
          {editingEmployeeId && (
            <button className="secondary-button" onClick={cancelEmployeeEdit} type="button">Cancelar edicao</button>
          )}
           <button className="secondary-button" disabled={!canEdit} onClick={() => startFaceRegistration(selectedEmployee || undefined, { replace: selectedEmployee?.faceIdStatus === "registered" })} type="button">
             {selectedEmployee?.faceIdStatus === "registered" ? "Refazer Face ID" : "Cadastrar Face ID do selecionado"}
           </button>
          <label className={`secondary-button ${canEdit ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}>
            {holeriteImportLoading ? "Lendo holerite..." : "Importar holerite PDF"}
            <input
              accept="application/pdf,.pdf"
              className="hidden"
              disabled={!canEdit || holeriteImportLoading}
              onChange={(event) => {
                void importEmployeeFromHolerite(event.target.files?.[0]);
                event.currentTarget.value = "";
              }}
              type="file"
            />
          </label>
          <label className={`secondary-button ${canEdit ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}>
            Importar lista JSON
            <input
              accept="application/json"
              className="hidden"
              disabled={!canEdit}
              onChange={(event) => importEmployeesFromJson(event.target.files?.[0])}
              type="file"
            />
          </label>
        </ActionRow>
        {holeriteImportDraft && (
          <div className="mt-4 rounded-md border border-[#e5cf91] bg-[#fffaf0] p-4">
            <div className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-sm font-semibold text-[#604b16]">Conferência do holerite</p>
                <p className="mt-1 text-xs leading-5 text-[#806c35]">
                  {holeriteImportDraft.fileName}{holeriteImportDraft.pages ? ` · ${holeriteImportDraft.pages} página(s)` : ""}. Os dados abaixo foram apenas pré-preenchidos.
                </p>
              </div>
              <span className="rounded-full border border-[#e5cf91] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#806c35]">
                Ainda não salvo
              </span>
            </div>
            <div className="mt-3 grid gap-2 text-xs text-[#5f5b4c] md:grid-cols-3">
              <span>Nome: {holeriteImportDraft.fields.name || "não localizado"}</span>
              <span>CPF: {holeriteImportDraft.fields.cpf || "não localizado"}</span>
              <span>Matrícula: {holeriteImportDraft.fields.registration || "não localizada"}</span>
              <span>Cargo: {holeriteImportDraft.fields.role || "não localizado"}</span>
              <span>Admissão: {holeriteImportDraft.fields.admissionDate || "não localizada"}</span>
              <span>CBO: {holeriteImportDraft.fields.cbo || "não localizado"}</span>
            </div>
            {holeriteImportDraft.missing.length > 0 && (
              <p className="mt-3 text-xs leading-5 text-[#7b5c12]">
                Não localizado no arquivo: {holeriteImportDraft.missing.join(", ")}. Complete os campos manualmente antes de salvar.
              </p>
            )}
            {holeriteImportDraft.warnings.map((warning) => (
              <p className="mt-3 text-xs leading-5 text-[#7b5c12]" key={warning}>
                Atenção: {warning}
              </p>
            ))}
            <p className="mt-3 text-xs leading-5 text-[#604b16]">
              O holerite não define PIN, foto ou escala. Informe o PIN no formulário, confira a jornada e depois confirme o cadastro.
            </p>
            <ActionRow>
              <SaveButton disabled={!canEdit} onClick={saveEmployee}>Confirmar e salvar colaborador</SaveButton>
              <button className="secondary-button" disabled={!canEdit} onClick={discardHoleriteDraft} type="button">Descartar importação</button>
            </ActionRow>
          </div>
        )}
        {false && showFaceCamera && selectedEmployee && (
          <div className="mt-5 grid gap-4 rounded-lg border border-[#cfe3dc] bg-[#101923] p-4 text-white lg:grid-cols-[minmax(0,1fr)_280px]">
            <FaceCamera
              compact
               employee={{
                employeeId: selectedEmployee!.employeeId,
                externalPunchAllowed: selectedEmployee!.externalPunchAllowed,
                name: selectedEmployee!.name,
                punchMode: selectedEmployee!.punchMode || "automatic",
                schedule: selectedEmployee!.schedule,
               }}
               onProfileUpdated={markFaceRegistered}
               onStatus={onAction}
             />
            <div>
              <p className="text-sm font-semibold text-[#b7d7ce]">Face ID de {selectedEmployee!.name}</p>
              <p className="mt-2 text-xs leading-5 text-white/65">
                Faça de 3 a 5 capturas, olhando para frente e virando levemente o rosto.
                Isso melhora o reconhecimento neste aparelho.
              </p>
              <p className="mt-3 text-xs font-semibold text-white">
                Status: {faceSaving ? "Salvando no Firebase..." : selectedEmployee!.faceIdStatus === "registered" ? "Face ID cadastrado" : "Aguardando captura"}
              </p>
            </div>
          </div>
        )}
      </CollapsiblePanel>
      </div>
      <CollapsiblePanel
        isOpen={openEmployeeSections.face}
        onToggle={() => setEmployeeSection("face", !openEmployeeSections.face)}
        title="Implantacao do Face ID"
        subtitle={`${faceReadyCount}/${localEmployees.length} colaboradores com Face ID`}
      >
        <div id="face-id-flow-panel" className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div>
            <div className="grid gap-3 md:grid-cols-3">
              {[
                ["Colaboradores", String(localEmployees.length)],
                ["Face ID pronto", String(faceReadyCount)],
                ["Pendentes", String(facePendingCount)],
              ].map(([label, value]) => (
                <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={label}>
                  <p className="text-xs font-semibold uppercase text-[#667085]">{label}</p>
                  <p className="mt-1 text-2xl font-semibold text-[#101923]">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 h-3 overflow-hidden rounded-full bg-[#e9eef3]">
              <div className="h-full rounded-full bg-[#18594c]" style={{ width: `${faceProgress}%` }} />
            </div>
            <p className="mt-2 text-xs font-semibold text-[#667085]">{faceProgress}% concluido</p>
            <ActionRow>
              <button className="primary-button" disabled={Boolean(faceCompletion)} onClick={() => startFaceRegistration()} type="button">Iniciar proximo pendente</button>
              {selectedEmployee && (
                <button className="secondary-button" onClick={() => startFaceRegistration(selectedEmployee, { replace: selectedEmployee.faceIdStatus === "registered" })} type="button">
                  {selectedEmployee.faceIdStatus === "registered" ? "Refazer Face ID" : "Capturar selecionado"}
                </button>
              )}
            </ActionRow>
          </div>
          <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3">
            <p className="text-sm font-semibold text-[#26323f]">Proximos pendentes</p>
            <div className="mt-3 grid max-h-64 gap-2 overflow-auto">
              {facePendingEmployees.slice(0, 8).map((employee) => (
                <button
                  className="rounded-md border border-[#d9e0e7] bg-white px-3 py-2 text-left text-sm font-semibold text-[#26323f] hover:border-[#18594c] hover:text-[#18594c]"
                  key={employee.employeeId}
                  onClick={() => startFaceRegistration(employee)}
                  type="button"
                >
                  {employee.name}
                </button>
              ))}
              {!facePendingEmployees.length && (
                <p className="rounded-md border border-[#cfe3dc] bg-[#f1faf7] p-3 text-sm font-semibold text-[#24594d]">
                  Todos os colaboradores estao com Face ID cadastrado.
                </p>
              )}
            </div>
          </div>
        </div>
        {faceCompletion && (
          <div className="mt-5 rounded-lg border border-[#b7d7ce] bg-[#f1faf7] p-4 text-[#24594d]">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#2d6c5d]">Captura concluída</p>
            <p className="mt-1 text-lg font-semibold text-[#143f37]">Face ID associado a {faceCompletion.employee.name}</p>
            <p className="mt-2 text-sm leading-6">
              A câmera foi encerrada para evitar associação acidental. Confira o nome e escolha manualmente o próximo colaborador.
            </p>
            <ActionRow>
              {faceCompletion.nextPending && (
                <button
                  className="primary-button"
                  onClick={() => {
                    const nextEmployee = faceCompletion.nextPending;
                    if (!nextEmployee) return;
                    setFaceCompletion(null);
                    startFaceRegistration(nextEmployee);
                  }}
                  type="button"
                >
                  Cadastrar próximo colaborador
                </button>
              )}
              <button className="secondary-button" onClick={() => setFaceCompletion(null)} type="button">Fechar aviso</button>
            </ActionRow>
          </div>
        )}
        {showFaceCamera && selectedEmployee && (
          <div className="mt-5 grid gap-4 rounded-lg border border-[#cfe3dc] bg-[#101923] p-4 text-white lg:grid-cols-[minmax(0,1fr)_280px]">
            <FaceCamera
              compact
              employee={{
                employeeId: selectedEmployee!.employeeId,
                externalPunchAllowed: selectedEmployee!.externalPunchAllowed,
                name: selectedEmployee!.name,
                punchMode: selectedEmployee!.punchMode || "automatic",
                schedule: selectedEmployee!.schedule,
               }}
               registrationAllowed={biometricConsentAccepted}
               onProfileUpdated={markFaceRegistered}
               onStatus={onAction}
               replaceProfile={replaceFaceProfile}
             />
            <div>
              <p className="text-sm font-semibold text-[#b7d7ce]">Face ID de {selectedEmployee!.name}</p>
              <p className="mt-2 text-xs leading-5 text-white/65">
                Faça {FACE_ID_REQUIRED_CAPTURES} capturas com boa luz. Ao concluir, a câmera será encerrada e você confirmará o próximo nome manualmente.
              </p>
              <p className="mt-3 text-xs font-semibold text-white">
                Status: {selectedEmployee!.faceIdStatus === "registered" ? "Face ID cadastrado" : "Aguardando captura"}
              </p>
              <label className="mt-4 flex items-start gap-2 rounded-md border border-white/15 bg-white/[0.06] p-3 text-xs leading-5 text-white/80">
                <input
                  checked={biometricConsentAccepted}
                  className="mt-1"
                  onChange={(event) => setBiometricConsentAccepted(event.target.checked)}
                  type="checkbox"
                />
                <span>Confirmo que o colaborador foi informado sobre o uso da imagem e do reconhecimento facial para controle de jornada, conforme a politica da empresa.</span>
              </label>
            </div>
          </div>
        )}
      </CollapsiblePanel>

      {selectedEmployee && (
        <CollapsiblePanel
          isOpen={openEmployeeSections.detail}
          onToggle={() => setEmployeeSection("detail", !openEmployeeSections.detail)}
          title="Ficha do colaborador"
          subtitle="Conferencia do cadastro selecionado"
        >
          <div className="mb-4 flex flex-col gap-4 rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-4 sm:flex-row sm:items-center">
            {employeePhotoUrls[selectedEmployee.employeeId] ? (
              <img
                alt={`Foto de ${selectedEmployee.name}`}
                className="h-20 w-20 rounded-lg border border-[#d9e0e7] object-cover"
                src={employeePhotoUrls[selectedEmployee.employeeId]}
              />
            ) : (
              <div className="grid h-20 w-20 place-items-center rounded-lg border border-[#d9e0e7] bg-white text-2xl font-bold text-[#18594c]">
                {selectedEmployee.name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div>
              <p className="text-lg font-semibold text-[#101923]">{selectedEmployee.name}</p>
              <p className="mt-1 text-sm text-[#667085]">
                {selectedEmployee.profilePhotoPath ? "Foto vinculada ao cadastro" : "Adicione uma foto manual ou cadastre o Face ID"}
              </p>
               <label className={`secondary-button mt-3 inline-flex items-center ${canEdit ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}>
                 Editar foto principal
                 <input
                   accept="image/*"
                   className="hidden"
                   disabled={!canEdit}
                   onChange={(event) => void changeEmployeePhoto(event.target.files?.[0])}
                   type="file"
                 />
               </label>
               <p className="mt-2 max-w-md text-xs leading-5 text-[#667085]">
                 Esta foto aparece no perfil e nas listas. As capturas usadas pelo Face ID ficam registradas separadamente.
               </p>
            </div>
          </div>
          <div id="employee-detail-panel" className="grid gap-3 md:grid-cols-4">
            {[
              ["Nome", selectedEmployee.name],
              ["Matricula", selectedEmployee.registration || "-"],
              ["PIN", selectedEmployee.pinConfigured ? "Configurado" : "Pendente"],
              ["CPF", selectedEmployee.cpf || "-"],
              ["Admissao", selectedEmployee.admissionDate || "-"],
              ["Cargo", selectedEmployee.role || "-"],
              ["Departamento", selectedEmployee.department || "-"],
              ["CBO", selectedEmployee.cbo || "-"],
              ["Jornada", selectedEmployee.shift || "-"],
              ["Face ID", selectedEmployee.faceIdStatus === "registered" ? "Cadastrado" : "Pendente"],
              ["Ponto externo", selectedEmployee.externalPunchAllowed ? "Autorizado" : "Nao autorizado"],
              ["Ultima batida", selectedEmployee.lastPunch || "-"],
              ["Status", selectedEmployee.status || "-"],
            ].map(([label, value]) => (
              <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={label}>
                <p className="text-xs font-semibold uppercase text-[#667085]">{label}</p>
                <p className="mt-1 text-sm font-semibold text-[#26323f]">{value}</p>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-md border border-[#e3e8ee] bg-white">
            <div className="border-b border-[#e3e8ee] px-4 py-3">
              <p className="text-sm font-semibold text-[#26323f]">Batidas registradas</p>
              <p className="mt-1 text-xs text-[#667085]">Consulta real no Firebase para este colaborador.</p>
            </div>
            <div className="grid gap-2 p-4">
              {selectedEmployeePunchesLoading ? (
                <p className="text-sm font-semibold text-[#667085]">Carregando batidas...</p>
              ) : selectedEmployeePunches.length ? (
                selectedEmployeePunches.slice(0, 8).map((punch) => (
                  <div className="grid gap-2 rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3 text-sm md:grid-cols-4" key={punch.id}>
                    <span className="font-semibold text-[#101923]">{formatPunchType(punch.type)}</span>
                    <span className="text-[#667085]">{formatPunchDateTime(punch)}</span>
                    <span className="text-[#667085]">{formatPunchStatus(punch.status)}</span>
                    <span className="truncate text-xs text-[#667085]">{punch.photoPath}</span>
                  </div>
                ))
              ) : (
                <p className="rounded-md border border-[#efd9a8] bg-[#fff8e9] p-3 text-sm font-semibold text-[#8a5a00]">
                  Nenhuma batida encontrada para este colaborador.
                </p>
              )}
            </div>
          </div>
          <ActionRow>
           <button className="secondary-button" onClick={() => editEmployee(selectedEmployee)} type="button">Editar cadastro</button>
            <button className="secondary-button" disabled={!canEdit} onClick={() => startFaceRegistration(selectedEmployee, { replace: selectedEmployee.faceIdStatus === "registered" })} type="button">
              {selectedEmployee.faceIdStatus === "registered" ? "Refazer Face ID" : "Cadastrar Face ID"}
            </button>
            <button className="secondary-button border-[#e5b6b1] bg-[#fff5f3] text-[#a33a3a] hover:border-[#c94c43] hover:bg-[#ffe9e6]" disabled={!canEdit} onClick={() => void resetFaceId(selectedEmployee)} type="button">Limpar Face ID</button>
            <label className={`secondary-button ${canEdit ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}>
              Editar foto principal
              <input
                accept="image/*"
                className="hidden"
                disabled={!canEdit}
                onChange={(event) => void changeEmployeePhoto(event.target.files?.[0])}
                type="file"
              />
            </label>
            <button className="secondary-button border-[#e5b6b1] bg-[#fff5f3] text-[#a33a3a] hover:border-[#c94c43] hover:bg-[#ffe9e6]" disabled={!canEdit} onClick={() => void deactivateEmployee(selectedEmployee)} type="button">Desativar colaborador</button>
          </ActionRow>
        </CollapsiblePanel>
      )}
      <CollapsiblePanel
        isOpen={openEmployeeSections.list}
        onToggle={() => setEmployeeSection("list", !openEmployeeSections.list)}
        title="Colaboradores"
        subtitle={`${localEmployees.length} cadastros na base`}
      >
        <EmployeesTable
          canEdit={canEdit}
          embedded
          employeesList={localEmployees}
          onAction={onAction}
          onEdit={editEmployee}
          onNew={startNewEmployee}
          onView={viewEmployee}
          photoUrls={employeePhotoUrls}
        />
      </CollapsiblePanel>
    </>
  );
}

function ShiftsScreen({ canEdit, onAction }: { canEdit: boolean; onAction: (action: string) => void }) {
  const [shifts, setShifts] = useState(initialShifts);
  const [editingIndex, setEditingIndex] = useState(0);
  const [form, setForm] = useState(initialShifts[0]);

  function updateForm(field: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function editShift(index: number) {
    setEditingIndex(index);
    setForm(shifts[index]);
    onAction(`Editando ${shifts[index].name}`);
  }

  function saveShift() {
    if (!canEdit) return;
    setShifts((current) =>
      current.map((shift, index) => (index === editingIndex ? form : shift)),
    );
    onAction(`Turno ${form.name} atualizado na tela`);
  }

  return (
    <>
      <TwoColumn>
        <Panel title="Editar turno" subtitle="Jornada, intervalo, tolerancia e regras">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Nome da escala">
              <input className="input" onChange={(event) => updateForm("name", event.target.value)} value={form.name} />
            </Field>
            <Field label="Dias por semana">
              <select className="input" onChange={(event) => updateForm("days", event.target.value)} value={form.days}>
                <option value="5">5 dias</option>
                <option value="6">6 dias</option>
                <option value="7">7 dias</option>
              </select>
            </Field>
            <TimeStepper label="Entrada" onChange={(value) => updateForm("start", value)} value={form.start} />
            <TimeStepper label="Saida almoco" onChange={(value) => updateForm("breakStart", value)} value={form.breakStart} />
            <TimeStepper label="Volta almoco" onChange={(value) => updateForm("breakEnd", value)} value={form.breakEnd} />
            <TimeStepper label="Fim do dia" onChange={(value) => updateForm("end", value)} value={form.end} />
            <JourneySummary
              breakEnd={form.breakEnd}
              breakStart={form.breakStart}
              days={Number(form.days)}
              end={form.end}
              start={form.start}
            />
            <Field label="Tolerancia">
              <input className="input" onChange={(event) => updateForm("tolerance", event.target.value)} value={form.tolerance} />
            </Field>
            <Field label="% hora extra">
              <input className="input" onChange={(event) => updateForm("extraPercent", event.target.value)} value={form.extraPercent} />
            </Field>
          </div>
          <ActionRow>
            <SaveButton disabled={!canEdit} onClick={saveShift}>Salvar alteracoes</SaveButton>
            <button className="secondary-button" onClick={() => onAction("Previa de calculo do turno")} type="button">Ver calculo</button>
          </ActionRow>
        </Panel>
        <Panel title="Regras trabalhistas" subtitle="Base visual do calculo">
          <CheckList items={["Horas extras em dias uteis configuraveis", "Feriados e DSR: regra separada", "Banco por vigencia mensal", "Folga e feriado como ocorrencia"]} />
        </Panel>
      </TwoColumn>

      <Panel title="Turnos cadastrados" subtitle="Selecione um turno para editar">
        <div className="table-scroll">
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <thead className="bg-[#f8fafb] text-xs uppercase text-[#667085]">
              <tr>
                <th className="px-5 py-3 font-semibold">Turno</th>
                <th className="px-5 py-3 font-semibold">Jornada</th>
                <th className="px-5 py-3 font-semibold">Intervalo</th>
                <th className="px-5 py-3 font-semibold">Carga</th>
                <th className="px-5 py-3 font-semibold">Tolerancia</th>
                <th className="px-5 py-3 font-semibold">Extra</th>
                <th className="px-5 py-3 font-semibold">Acoes</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((shift, index) => (
                <tr className="border-t border-[#e3e8ee]" key={shift.name}>
                  <td className="px-5 py-4 font-semibold text-[#101923]">{shift.name}</td>
                  <td className="px-5 py-4 text-[#667085]">{shift.start} - {shift.end}</td>
                  <td className="px-5 py-4 text-[#667085]">{shift.breakStart} - {shift.breakEnd}</td>
                  <td className="px-5 py-4 text-[#667085]">
                    {calculateWeeklyHours({
                      breakEnd: shift.breakEnd,
                      breakStart: shift.breakStart,
                      days: Number(shift.days),
                      end: shift.end,
                      start: shift.start,
                    })}
                  </td>
                  <td className="px-5 py-4 text-[#667085]">{shift.tolerance}</td>
                  <td className="px-5 py-4 text-[#667085]">{shift.extraPercent}</td>
                  <td className="px-5 py-4">
                    <button className="mini-button" onClick={() => editShift(index)} type="button">Editar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function PunchesScreen({
  onAction,
  onRegister,
  pin,
  setPin,
}: {
  onAction: (action: string) => void;
  onRegister: (kind: string, employee?: RecognizedFace, exception?: PunchException, photoBlob?: Blob, context?: PunchContext) => Promise<boolean>;
  pin: string;
  setPin: (value: string) => void;
}) {
  return (
    <>
      <PunchCard onRegister={onRegister} pin={pin} setPin={setPin} />
      <Panel title="Ajuste de batida" subtitle="A batida original nao e alterada; o ajuste cria um novo registro">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Colaborador">
            <select className="input">
              <option>Nenhum colaborador cadastrado</option>
            </select>
          </Field>
          <Field label="Data"><input className="input" placeholder="19/06/2026" /></Field>
          <MaskedField label="Horario" mask="time" placeholder="08:00" />
          <Field label="Tipo"><select className="input"><option>Entrada</option><option>Saida intervalo</option><option>Retorno</option><option>Saida</option></select></Field>
          <Field label="Tipo de ajuste">
            <select className="input">
              <option>Esquecimento com evidencia</option>
              <option>Trabalho externo</option>
              <option>Batida pelo gestor</option>
              <option>Erro operacional</option>
            </select>
          </Field>
          <Field label="Motivo"><input className="input" placeholder="Esquecimento de marcacao" /></Field>
          <MaskedField label="Responsavel" mask="name" placeholder="RH" />
        </div>
        <ActionRow>
          <button className="primary-button" onClick={() => onAction("Ajuste manual")} type="button">Justificar ajuste</button>
          <button className="secondary-button" onClick={() => onAction("Anexo de comprovante")} type="button">Anexar comprovante</button>
        </ActionRow>
      </Panel>
      <Panel title="Politica operacional ativa" subtitle="A interpretacao depende da configuracao da empresa">
        <div className="grid gap-3 md:grid-cols-2">
          <CheckList
            items={[
              "O cliente escolhe se a falta sera por dia ou por periodo",
              "O cliente define o peso de cada falta",
              "Esquecimento pode ser aceito, bloqueado ou exigir aprovacao",
              "Trabalho externo pode ser permitido conforme a politica",
            ]}
          />
          <CheckList
            items={[
              "Lancamento do gestor aparece marcado no relatorio quando permitido",
              "Todo ajuste exige justificativa",
              "A batida original nunca e apagada",
              "Mudancas de politica ficam em log de auditoria",
            ]}
          />
        </div>
      </Panel>
    </>
  );
}

function ExternalPunchScreen({
  onAction,
  onRegister,
}: {
  onAction: (action: string) => void;
  onRegister: (kind: string, employee?: RecognizedFace, exception?: PunchException, photoBlob?: Blob, context?: PunchContext) => Promise<boolean>;
}) {
  const companyId = useActiveCompanyId();
  const [employeesList, setEmployeesList] = useState<LocalEmployee[]>([]);
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState("");
  const [selectedPunch, setSelectedPunch] = useState("Entrada 1");
  const [recognizedEmployee, setRecognizedEmployee] = useState<RecognizedFace | null>(null);
  const [recognizedPhoto, setRecognizedPhoto] = useState<Blob | undefined>();
  const [location, setLocation] = useState<PunchLocation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    let mounted = true;
    void listEmployees(companyId)
      .then((saved) => {
        if (!mounted) return;
        setEmployeesList(saved.map((employee) =>
          toLocalEmployee(employee as unknown as Record<string, unknown>, employee.id),
        ));
      })
      .catch((error) => console.error("Falha ao carregar autorizacoes de ponto externo.", error));

    return () => { mounted = false; };
  }, [companyId]);

  async function identifyExternalEmployee(employee: RecognizedFace, photoBlob?: Blob) {
    setConfirmation("");
    setLocation(null);
    const registered = employeesList.find((item) => item.employeeId === employee.employeeId);

    if (!registered) {
      setRecognizedEmployee(null);
      onAction("Rosto reconhecido, mas o colaborador nao foi encontrado no cadastro da empresa.");
      return;
    }
    if (!registered.externalPunchAllowed) {
      setRecognizedEmployee(null);
      onAction(`${registered.name} nao possui autorizacao para ponto externo.`);
      return;
    }
    if (!pin) {
      setRecognizedEmployee(null);
      onAction("Informe o PIN do colaborador.");
      return;
    }

    try {
      const verified = await verifyEmployeePin(companyId, pin);
      if (verified.employeeId !== registered.employeeId) {
        setRecognizedEmployee(null);
        onAction("O PIN informado nao corresponde ao rosto reconhecido.");
        return;
      }
    } catch (error) {
      console.error(error);
      setRecognizedEmployee(null);
      onAction("PIN nao reconhecido. Confira os numeros ou procure o responsavel.");
      return;
    }

    const nextPunch = inferNextPunch(registered.employeeId, registered.schedule);
    const recognized = {
      ...employee,
      employeeId: registered.employeeId,
      externalPunchAllowed: true,
      name: registered.name,
      punchMode: registered.punchMode,
      schedule: registered.schedule,
    };
    setRecognizedEmployee(recognized);
    setRecognizedPhoto(photoBlob);
    if (nextPunch) setSelectedPunch(nextPunch);
    onAction(`${registered.name} identificado e autorizado para ponto externo.`);
  }

  async function confirmExternalPunch() {
    if (!recognizedEmployee || submitting) return;
    if (!reason.trim()) {
      onAction("Informe onde ou por que o trabalho esta sendo realizado fora da empresa.");
      return;
    }

    setSubmitting(true);
    const capturedLocation = await capturePunchLocation();
    setLocation(capturedLocation);
    const saved = await onRegister(selectedPunch, recognizedEmployee, undefined, recognizedPhoto, {
      deviceId: getPunchDeviceId(),
      externalReason: reason.trim(),
      location: capturedLocation,
      origin: "external",
    });
    setSubmitting(false);

    if (!saved) return;
    setConfirmation(`${selectedPunch} registrada para ${recognizedEmployee.name}.`);
    setRecognizedEmployee(null);
    setRecognizedPhoto(undefined);
    setPin("");
    setReason("");
  }

  return (
    <section className="app-panel app-narrow-panel mx-auto max-w-3xl">
      <div className="flex flex-col gap-2 border-b border-[#e3e8ee] pb-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase text-[#2d6c5d]">Registro pelo celular</p>
          <h2 className="mt-1 text-xl font-semibold text-[#101923]">Ponto externo</h2>
          <p className="mt-1 text-sm leading-6 text-[#667085]">
            Exclusivo para colaboradores autorizados. A localizacao e registrada como evidencia e nao bloqueia a marcacao.
          </p>
        </div>
        <span className="w-fit rounded-md border border-[#cfe3dc] bg-[#f1faf7] px-3 py-2 text-xs font-semibold text-[#24594d]">
          PIN + reconhecimento facial
        </span>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          <Field label="PIN do colaborador">
            <input
              className="input"
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => {
                setPin(event.target.value.replace(/\D/g, ""));
                setRecognizedEmployee(null);
              }}
              placeholder="0000"
              value={pin}
            />
          </Field>
          <div className="mt-4 rounded-lg bg-[#101923] p-3 text-white">
            <FaceCamera compact onRecognized={identifyExternalEmployee} onStatus={onAction} />
          </div>
        </div>

        <div className="grid content-start gap-4">
          <Field label="Local ou motivo do trabalho externo">
            <input
              className="input"
              maxLength={120}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ex.: entrega no cliente"
              value={reason}
            />
          </Field>
          <Field label="Marcacao">
            <select className="input" onChange={(event) => setSelectedPunch(event.target.value)} value={selectedPunch}>
              {scheduledPunchOrder.slice(0, getSchedulePeriods(recognizedEmployee?.schedule).length * 2).map((stage) => (
                <option key={stage} value={stage}>{stage}</option>
              ))}
            </select>
          </Field>

          <div className={`rounded-md border p-3 text-sm ${recognizedEmployee ? "border-[#9ed3c5] bg-[#eaf7f3] text-[#174f43]" : "border-[#d9e0e7] bg-[#fbfcfd] text-[#667085]"}`}>
            {recognizedEmployee
              ? `${recognizedEmployee.name} identificado. Confira a marcacao e confirme.`
              : "Informe o PIN e toque em Reconhecer rosto."}
          </div>

          <button
            className="primary-button min-h-12 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!recognizedEmployee || submitting}
            onClick={() => void confirmExternalPunch()}
            type="button"
          >
            {submitting ? "Obtendo localizacao..." : "Confirmar ponto externo"}
          </button>

          {location && (
            <p className="text-xs leading-5 text-[#667085]">
              Localizacao: {location.status === "captured" ? `capturada com precisao aproximada de ${location.accuracy} m` : "nao disponivel; a ocorrencia foi registrada"}.
            </p>
          )}
          {confirmation && (
            <div aria-live="polite" className="rounded-md border border-[#8bcab9] bg-[#dff5ed] p-4 text-sm font-semibold text-[#155548]">
              {confirmation}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function KioskScreen({
  bankHoursEnabled,
  canExitWithGoogle,
  canExitWithPassword,
  dateLabel,
  locationLabel,
  onAction,
  onExit,
  onRegister,
  pin,
  setPin,
  timeLabel,
  weatherDetail,
  weatherIcon,
  weatherLabel,
}: {
  bankHoursEnabled: boolean;
  canExitWithGoogle: boolean;
  canExitWithPassword: boolean;
  dateLabel: string;
  locationLabel: string;
  onAction: (action: string) => void;
  onExit: (method: "google" | "password", password?: string) => Promise<string>;
  onRegister: (kind: string, employee?: RecognizedFace, exception?: PunchException, photoBlob?: Blob, context?: PunchContext) => Promise<boolean>;
  pin: string;
  setPin: (value: string) => void;
  timeLabel: string;
  weatherDetail: string;
  weatherIcon: string;
  weatherLabel: string;
}) {
  const companyId = useActiveCompanyId();
  const [recognizedEmployee, setRecognizedEmployee] = useState<RecognizedFace | null>(null);
  const [selectedPunch, setSelectedPunch] = useState("Entrada 1");
  const [journeyFinished, setJourneyFinished] = useState(false);
  const [sequenceLoading, setSequenceLoading] = useState(false);
  const [timingWarning, setTimingWarning] = useState<PunchException | null>(null);
  const [recognizedPhoto, setRecognizedPhoto] = useState<Blob | undefined>();
  const [cameraState, setCameraState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [blockingMessage, setBlockingMessage] = useState("");
  const [kioskDetailsOpen, setKioskDetailsOpen] = useState(false);
  const [pinFallbackOpen, setPinFallbackOpen] = useState(false);
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [exitPassword, setExitPassword] = useState("");
  const [exitError, setExitError] = useState("");
  const [exitLoading, setExitLoading] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    employeeName: string;
    time: string;
    type: string;
  } | null>(null);
  const [faceProfileSources, setFaceProfileSources] = useState<FaceProfileSource[]>([]);
  const confirmPanelRef = useRef<HTMLDivElement>(null);
  const resetTimerRef = useRef<number | null>(null);

  async function confirmKioskExit(method: "google" | "password") {
    setExitLoading(true);
    setExitError("");
    const errorMessage = await onExit(method, exitPassword);
    setExitLoading(false);
    if (errorMessage) {
      setExitError(errorMessage);
      return;
    }

    setExitPassword("");
    setExitDialogOpen(false);
  }

  useEffect(() => {
    let mounted = true;

    async function loadFaceProfileSources() {
      try {
        const saved = await listEmployees(companyId);
        const registered = saved
          .map((employee) => toLocalEmployee(employee as unknown as Record<string, unknown>, employee.id))
          .filter((employee) => employee.active !== false && employee.faceIdStatus === "registered");

        const sources = (await Promise.all(
          registered.map(async (employee) => {
            try {
              let photoPaths: string[] = [];
              try {
                const employeeIds = [...new Set([employee.employeeId, employee.documentId].filter((id): id is string => Boolean(id)))];
                const recordGroups = await Promise.all(employeeIds.map(async (id) => {
                  try {
                    return await listFaceIdRecords(companyId, id);
                  } catch (error) {
                    console.warn(`Não foi possível consultar as capturas faciais de ${employee.name}.`, error);
                    return [];
                  }
                }));
                photoPaths = [...new Set(recordGroups.flat().map((record) => record.photoPath).filter(Boolean))].slice(0, 3);
              } catch (error) {
                console.warn(`Não foi possível consultar o histórico facial de ${employee.name}.`, error);
              }
              if (!photoPaths.length && employee.profilePhotoPath) {
                photoPaths = [employee.profilePhotoPath];
              }

              const employeeSources: FaceProfileSource[] = [];
              for (const photoPath of [...new Set(photoPaths.filter(Boolean))]) {
                try {
                  const photoUrl = await getStorageFileUrl(photoPath);
                  employeeSources.push({
                    employeeId: employee.employeeId,
                    name: employee.name,
                    photoUrl,
                    punchMode: employee.punchMode || "automatic",
                    schedule: employee.schedule,
                  });
                } catch {
                  // Tenta a próxima captura histórica quando a foto resumida não existe mais.
                }
              }
              return employeeSources;
            } catch {
              return [];
            }
          }),
        ))
          .flat();

        if (mounted) setFaceProfileSources(sources);
      } catch (error) {
        console.error("Não foi possível carregar os rostos cadastrados para a sala de ponto.", error);
        if (mounted) setFaceProfileSources([]);
      }
    }

    void loadFaceProfileSources();
    return () => {
      mounted = false;
    };
  }, [companyId]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
      window.speechSynthesis?.cancel();
    };
  }, []);

  function speak(message: string) {
    const speech = window.speechSynthesis;
    if (!speech) return;

    speech.cancel();
    const voiceMessage = new SpeechSynthesisUtterance(message);
    voiceMessage.lang = "pt-BR";
    voiceMessage.rate = 1.16;
    voiceMessage.pitch = 1.03;
    voiceMessage.volume = 0.92;
    voiceMessage.onerror = (event) => console.warn("A voz do navegador não foi reproduzida.", event.error);
    let spoken = false;
    const speakWithAvailableVoice = () => {
      if (spoken) return;
      spoken = true;
      const portugueseVoices = speech.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith("pt"));
      const naturalVoice =
        portugueseVoices.find((voice) => /natural|online|francisca|luciana|maria/i.test(voice.name)) ||
        portugueseVoices[0];
      if (naturalVoice) voiceMessage.voice = naturalVoice;
      speech.speak(voiceMessage);
    };
    if (speech.getVoices().length) {
      speakWithAvailableVoice();
    } else {
      speech.addEventListener("voiceschanged", speakWithAvailableVoice, { once: true });
      window.setTimeout(speakWithAvailableVoice, 700);
    }
  }

  function voiceName(name: string) {
    return name.trim().split(/\s+/)[0] || "colaborador";
  }

  function speakPunchConfirmation(type: string, name: string) {
    const firstName = voiceName(name);
    const message = type === "Saída 2"
      ? `Ponto registrado, ${firstName}. Jornada encerrada.`
      : `Ponto registrado, ${firstName}.`;
    speak(message);
  }

  async function identifyFace(employee: RecognizedFace, photoBlob?: Blob) {
    setSequenceLoading(true);
    const nextPunch = await resolveNextPunch(employee.employeeId, companyId, employee.schedule);
    setSequenceLoading(false);
    setTimingWarning(null);
    setBlockingMessage("");
    setRecognizedPhoto(photoBlob);
    setRecognizedEmployee(employee);
    setJourneyFinished(nextPunch === null);
    if (employee.punchMode !== "manual" && nextPunch) setSelectedPunch(nextPunch);
    onAction(`${employee.name} reconhecido. Sequência atualizada pela última batida registrada.`);
    if (nextPunch === null) {
      speak(`${voiceName(employee.name)}, jornada encerrada.`);
    } else if (employee.punchMode === "manual") {
      speak(`${voiceName(employee.name)}, escolha a marcação.`);
    } else {
      speak(`${voiceName(employee.name)}, confirme o ponto.`);
    }
    window.setTimeout(() => {
      confirmPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
  }

  function resetRecognition(message = "Reconhecimento cancelado. Tente novamente.") {
    setRecognizedEmployee(null);
    setSelectedPunch("Entrada 1");
    setJourneyFinished(false);
    setTimingWarning(null);
    setRecognizedPhoto(undefined);
    setBlockingMessage("");
    setConfirmation(null);
    onAction(message);
    speak(message);
  }

  function usePinFallback() {
    resetRecognition("Use o PIN do colaborador para registrar.");
    setPinFallbackOpen(true);
    window.setTimeout(() => {
      document.getElementById("kiosk-pin-fallback")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
  }

  async function confirmPunch() {
    if (!recognizedEmployee || confirmation) {
      if (!recognizedEmployee) {
        onAction("Faça o reconhecimento do rosto antes de confirmar.");
        speak("Primeiro faça o reconhecimento do rosto.");
      }
      return;
    }

    const lastPunch = getLastEmployeePunch(recognizedEmployee.employeeId);
    if (lastPunch && Date.now() - Date.parse(lastPunch.savedAt) < 2 * 60 * 1000) {
      setBlockingMessage("A última batida foi realizada há menos de 2 minutos.");
      speak("Batida já registrada. Aguarde um pouco.");
      return;
    }

    const timing = getPunchTiming(recognizedEmployee, selectedPunch, bankHoursEnabled);
    if (!timingWarning && timing.outsideTolerance) {
      const warning = {
        currentTime: timing.currentTime,
        differenceMinutes: timing.differenceMinutes,
        expectedTime: timing.expectedTime,
        timingLabel: timing.timingLabel,
      };
      setTimingWarning(warning);
      const direction = timing.differenceMinutes < 0 ? "antes" : "depois";
      speak(`${timing.timingLabel}. ${formatDurationSpeech(timing.differenceMinutes)} ${direction} do horário. Confirme novamente.`);
      return;
    }

    if (!(await onRegister(selectedPunch, recognizedEmployee, timingWarning || undefined, recognizedPhoto))) return;

    const time = new Date().toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
    setConfirmation({
      employeeName: recognizedEmployee.name,
      time,
      type: selectedPunch,
    });
    speakPunchConfirmation(selectedPunch, recognizedEmployee.name);

    resetTimerRef.current = window.setTimeout(() => {
      setConfirmation(null);
      setRecognizedEmployee(null);
      setSelectedPunch("Entrada 1");
      setJourneyFinished(false);
      setTimingWarning(null);
      setRecognizedPhoto(undefined);
      setBlockingMessage("");
    }, 1800);
  }

  const configuredPunchOrder = scheduledPunchOrder.slice(0, getSchedulePeriods(recognizedEmployee?.schedule).length * 2);
  const punchOptions = configuredPunchOrder.map((value, index) => ({
    description: value.startsWith("Entrada") ? `Início do período ${Math.floor(index / 2) + 1}` : `Fim do período ${Math.floor(index / 2) + 1}`,
    icon: value.startsWith("Entrada") ? "◉" : "✓",
    label: value,
    value,
  }));
  const selectedPresentation =
    punchOptions.find((option) => option.value === selectedPunch) || punchOptions[0];
  const manualSelection = recognizedEmployee?.punchMode === "manual";

  const cameraStatusLabel = cameraState === "ready"
    ? "Câmera pronta"
    : cameraState === "loading"
      ? "Preparando câmera"
      : cameraState === "error"
        ? "Câmera indisponível"
        : "Câmera aguardando";
  const cameraStatusClass = cameraState === "ready"
    ? "kiosk-status-ready"
    : cameraState === "error"
      ? "kiosk-status-error"
      : "kiosk-status-pending";

  return (
    <section className="kiosk-screen min-h-[100dvh] text-white">
      <header className="kiosk-clock-header">
        <div className="kiosk-brand-lockup">
          <img alt="Orquestracs Face ID" className="kiosk-brand-wordmark" src="/orquestracs-face-id-wordmark.svg" />
        </div>
        <div className="kiosk-title-block">
          <p className="kiosk-eyebrow">Orquestracs Face ID</p>
          <h1>Sala de ponto</h1>
          <p>Reconhecimento facial e confirmação da jornada</p>
        </div>
        <div className="kiosk-header-actions">
          <div className="kiosk-clock-card">
            <span aria-hidden="true" className="kiosk-weather-icon">{weatherIcon}</span>
            <div className="min-w-0">
              <p className="kiosk-card-label">Momento e clima</p>
              <div className="kiosk-clock-line">
                <span className="kiosk-weather-label">{weatherLabel}</span>
                <span className="kiosk-time">{timeLabel}</span>
              </div>
              <p className="kiosk-date-line">{dateLabel} · {weatherDetail}</p>
              <p className="kiosk-location-line">{locationLabel}</p>
            </div>
          </div>
          <div className={`kiosk-system-status ${cameraStatusClass}`}>
            <span className="kiosk-status-dot" aria-hidden="true" />
            <div>
              <strong>{cameraStatusLabel}</strong>
              <span>Reconhecimento automático</span>
            </div>
          </div>
          <button
            className="kiosk-exit-button"
            onClick={() => {
              setExitError("");
              setExitPassword("");
              setExitDialogOpen(true);
            }}
            type="button"
          >
            Sair
          </button>
        </div>
      </header>

      <div className="kiosk-workspace md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="kiosk-recognition-panel">
          <div className="kiosk-stepper" aria-label="Etapas do registro">
            {[
              ["1", "Reconhecimento", "Posicione o rosto"],
              ["2", "Identificação", "Validando funcionário"],
              ["3", "Confirmar", "Confirme o ponto"],
            ].map(([step, label, detail], index) => (
              <div className={`kiosk-step ${index === 0 && !recognizedEmployee ? "is-active" : recognizedEmployee && index === 1 ? "is-active" : confirmation && index === 2 ? "is-active" : ""}`} key={step}>
                <span className="kiosk-step-icon">{index === 0 ? "◉" : index === 1 ? "♙" : "✓"}</span>
                <strong>{step}. {label}</strong>
                <span>{detail}</span>
              </div>
            ))}
          </div>

          <div className="kiosk-camera-heading">
            <div>
              <p className="kiosk-eyebrow">Reconhecimento automático</p>
              <h2>Fique em frente à câmera</h2>
              <p>O sistema identifica o funcionário sem tocar na tela.</p>
            </div>
            <span className={`kiosk-camera-badge ${cameraStatusClass}`}>
              <span className="kiosk-status-dot" aria-hidden="true" /> {cameraStatusLabel}
            </span>
          </div>

          <div className="kiosk-camera-shell">
            <FaceCamera
              autoRecognize
              autoStart
              onCameraState={setCameraState}
              onRecognized={identifyFace}
              onStatus={onAction}
              profileSources={faceProfileSources}
              recognitionPaused={Boolean(recognizedEmployee || confirmation || sequenceLoading)}
            />
          </div>
          <div className="kiosk-live-status">
            <span className="kiosk-live-item"><span className="kiosk-status-dot" aria-hidden="true" /> {cameraState === "ready" ? "Aguardando o próximo funcionário..." : "Câmera em preparação"}</span>
            <span className="kiosk-live-item"><span className="kiosk-status-dot" aria-hidden="true" /> Conexão protegida</span>
            <span className="kiosk-live-item"><span className="kiosk-status-dot" aria-hidden="true" /> Registro em tempo real</span>
          </div>
        </div>

        <aside className="kiosk-side-panel">
          <div className="kiosk-side-card kiosk-last-card">
            <div className="kiosk-side-heading"><span aria-hidden="true">◷</span><h2>Última marcação</h2></div>
            <div className="kiosk-last-record">
              <span className="kiosk-avatar">{confirmation ? confirmation.employeeName.split(" ").map((part) => part[0]).slice(0, 2).join("") : "--"}</span>
              <div className="min-w-0">
                <strong>{confirmation ? confirmation.employeeName : "Aguardando funcionário"}</strong>
                <span>{confirmation ? `${confirmation.type} · hoje às ${confirmation.time}` : "Nenhuma marcação nesta sessão"}</span>
              </div>
              <span className="kiosk-record-icon" aria-hidden="true">✓</span>
            </div>
          </div>

          <div className="kiosk-side-card kiosk-next-card">
            <div className="kiosk-side-heading"><span aria-hidden="true">▣</span><h2>Próxima marcação</h2></div>
            <div className="kiosk-next-record">
              <span className="kiosk-next-icon" aria-hidden="true">{selectedPresentation.icon}</span>
              <div className="min-w-0">
                <strong>{journeyFinished ? "Jornada encerrada" : selectedPunch}</strong>
                <span>{journeyFinished ? "Todas as marcações foram realizadas" : selectedPresentation.description}</span>
              </div>
            </div>
          </div>

          <div className="kiosk-side-card kiosk-identification-card" ref={confirmPanelRef}>
            <div className="kiosk-side-heading"><span aria-hidden="true">♙</span><h2>{manualSelection ? "Escolha a marcação" : "Marcação identificada"}</h2></div>
            <div className="mt-3 grid gap-3">
              {manualSelection ? (
                <div className="grid grid-cols-2 gap-3">
                  {punchOptions.map((option) => (
                    <button
                      aria-pressed={selectedPunch === option.value}
                      className={`min-h-24 rounded-xl border-2 p-3 text-center transition ${
                        selectedPunch === option.value
                          ? "border-[#7ee2c4] bg-[#dcebe6] text-[#143f37]"
                          : "border-white/20 bg-white/[0.06] text-white"
                      }`}
                      key={option.value}
                      onClick={() => {
                        setSelectedPunch(option.value);
                        setTimingWarning(null);
                        setBlockingMessage("");
                        speak(option.label);
                      }}
                      type="button"
                    >
                      <span aria-hidden="true" className="block text-3xl">{option.icon}</span>
                      <span className="mt-2 block text-sm font-bold">{option.label}</span>
                      <span className="mt-1 block text-[11px] opacity-75">{option.description}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="kiosk-punch-card">
                  <span aria-hidden="true" className="block text-6xl">
                    {journeyFinished ? "✅" : selectedPresentation.icon}
                  </span>
                  <span className="mt-3 block text-2xl font-black">
                    {journeyFinished ? "JORNADA ENCERRADA" : selectedPunch.toUpperCase()}
                  </span>
                  <span className="mt-2 block text-sm font-semibold">
                    {journeyFinished
                      ? "Todas as marcações de hoje já foram realizadas."
                      : `${selectedPresentation.description}. Calculado pela sequência do dia.`}
                  </span>
                </div>
              )}
              {timingWarning && (
                <div aria-live="assertive" className="rounded-xl border-4 border-[#f5b942] bg-[#fff4d6] p-5 text-center text-[#6b4500]">
                  <span aria-hidden="true" className="block text-5xl">⚠️</span>
                    <p className="mt-2 text-xl font-black">{timingWarning.timingLabel.toUpperCase()}</p>
                  <p className="mt-3 text-base font-bold">
                    Previsto: {timingWarning.expectedTime} • Agora: {timingWarning.currentTime}
                  </p>
                  <p className="mt-2 text-sm">
                    {formatDurationShort(Math.abs(timingWarning.differenceMinutes))}{" "}
                    {timingWarning.differenceMinutes < 0 ? "antes" : "depois"} do horário previsto.
                  </p>
                  <p className="mt-3 text-sm font-bold">Toque novamente para registrar mesmo assim.</p>
                </div>
              )}
              {blockingMessage && (
                <div aria-live="assertive" className="rounded-xl border-4 border-[#ef6b6b] bg-[#ffe5e5] p-5 text-center text-[#7a2020]">
                  <span aria-hidden="true" className="block text-5xl">✋</span>
                  <p className="mt-2 text-xl font-black">BATIDA NÃO REGISTRADA</p>
                  <p className="mt-2 text-sm font-semibold">{blockingMessage}</p>
                </div>
              )}
              <button
                className="kiosk-confirm-button"
                disabled={!recognizedEmployee || sequenceLoading || journeyFinished || Boolean(confirmation) || Boolean(blockingMessage)}
                onClick={() => void confirmPunch()}
                type="button"
              >
                {timingWarning ? "⚠ CONFIRMAR MESMO ASSIM" : "✓ CONFIRMAR PONTO"}
              </button>
              {recognizedEmployee && !confirmation && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    className="kiosk-cancel-button"
                    onClick={() => resetRecognition()}
                    type="button"
                  >
                    Cancelar
                  </button>
                  <button
                    className="kiosk-pin-button"
                    onClick={usePinFallback}
                    type="button"
                  >
                    Nao sou eu / usar PIN
                  </button>
                </div>
              )}
            </div>
          </div>

          {confirmation && (
            <div aria-live="assertive" className="kiosk-confirmation-card">
              <span aria-hidden="true" className="block text-6xl">✓</span>
              <p className="mt-3 text-2xl font-black">PONTO REGISTRADO</p>
              <p className="mt-2 text-lg font-bold">{confirmation.employeeName}</p>
              <p className="mt-1 text-base">{confirmation.type} • {confirmation.time}</p>
            </div>
          )}

          <div className="kiosk-side-card kiosk-light-card" id="kiosk-pin-fallback">
            <button
              aria-expanded={pinFallbackOpen}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
              onClick={() => setPinFallbackOpen((open) => !open)}
              type="button"
            >
              <span>
                <span className="block text-sm font-semibold text-[#26323f]">PIN + foto</span>
                <span className="mt-1 block text-xs text-[#667085]">Usar quando o rosto nao reconhecer</span>
              </span>
              <span className="grid h-8 w-8 place-items-center rounded-md border border-[#d9e0e7] bg-[#fbfcfd] font-semibold">
                {pinFallbackOpen ? "-" : "+"}
              </span>
            </button>
            {pinFallbackOpen && (
            <div className="grid gap-3 border-t border-[#e3e8ee] p-4">
              <Field label="PIN do colaborador">
                <input
                  className="input"
                  maxLength={6}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
                  placeholder="0000"
                  value={pin}
                />
              </Field>
              <button
                className="secondary-button"
                onClick={() => {
                  void (async () => {
                  let nextPunch: string | null = selectedPunch;
                  try {
                    setSequenceLoading(true);
                    const verified = await verifyEmployeePin(companyId, pin.trim());
                    const savedEmployees = await listEmployees(companyId);
                    const registered = savedEmployees.find((employee) => employee.id === verified.employeeId);
                    const employeeSchedule = registered
                      ? toLocalEmployee(registered as unknown as Record<string, unknown>, registered.id).schedule
                      : undefined;
                    nextPunch = await resolveNextPunch(verified.employeeId, companyId, employeeSchedule);
                    setSequenceLoading(false);
                    if (!nextPunch) {
                      setBlockingMessage("Todas as marcações previstas para hoje já foram registradas.");
                      speak("A jornada de hoje já foi encerrada.");
                      return;
                    }
                    const resolvedPunch = nextPunch;
                    setSelectedPunch(resolvedPunch);
                    if (await onRegister(resolvedPunch)) {
                      const time = new Date().toLocaleTimeString("pt-BR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      });
                      speak(`${resolvedPunch} registrada com sucesso às ${time}.`);
                    }
                    return;
                  } catch {
                    setSequenceLoading(false);
                  }

                  if (await onRegister(selectedPunch)) {
                    const time = new Date().toLocaleTimeString("pt-BR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    });
                    speak(`${selectedPunch} registrada com sucesso às ${time}.`);
                  }
                  })();
                }}
                type="button"
              >
                Registrar por PIN + foto
              </button>
            </div>
            )}
          </div>

          <div className="kiosk-side-card kiosk-light-card kiosk-details-card">
            <button
              aria-expanded={kioskDetailsOpen}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
              onClick={() => setKioskDetailsOpen((open) => !open)}
              type="button"
            >
              <span className="text-sm font-semibold">Detalhes do registro</span>
              <span className="grid h-8 w-8 place-items-center rounded-md border border-[#cfe3dc] bg-white font-semibold">
                {kioskDetailsOpen ? "-" : "+"}
              </span>
            </button>
            {kioskDetailsOpen && (
            <div className="grid gap-2 border-t border-[#cfe3dc] p-4 text-xs leading-5">
              <span>Funcionario identificado</span>
              <span>Foto da batida</span>
              <span>Horario do servidor</span>
              <span>Status: no horario, atraso ou fora da jornada</span>
              <span>Log inviolavel</span>
            </div>
            )}
          </div>
          <div className="kiosk-side-card kiosk-digital-card">
            <div className="kiosk-side-heading"><span aria-hidden="true">◎</span><h2>Leitor digital</h2></div>
            <p>Disponível após a escolha e validação do equipamento.</p>
            <span className="kiosk-coming-soon">Em breve</span>
          </div>
        </aside>
      </div>
      {exitDialogOpen && (
        <div className="kiosk-exit-backdrop" role="presentation">
          <section aria-labelledby="kiosk-exit-title" aria-modal="true" className="kiosk-exit-dialog" role="dialog">
            <p className="kiosk-card-label">Acesso do responsável</p>
            <h2 id="kiosk-exit-title">Sair da sala de ponto</h2>
            <p>Confirme a conta administrativa para voltar ao painel. Os funcionários não conseguem encerrar o modo quiosque sem essa confirmação.</p>

            {canExitWithPassword && (
              <form
                className="kiosk-exit-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void confirmKioskExit("password");
                }}
              >
                <label htmlFor="kiosk-exit-password">Senha da conta responsável</label>
                <input
                  autoComplete="current-password"
                  autoFocus
                  disabled={exitLoading}
                  id="kiosk-exit-password"
                  onChange={(event) => setExitPassword(event.target.value)}
                  placeholder="Digite a senha"
                  type="password"
                  value={exitPassword}
                />
                <button className="primary-button" disabled={exitLoading || !exitPassword.trim()} type="submit">
                  {exitLoading ? "Confirmando..." : "Confirmar com senha"}
                </button>
              </form>
            )}

            {canExitWithGoogle && (
              <button
                className="secondary-button kiosk-google-exit"
                disabled={exitLoading}
                onClick={() => void confirmKioskExit("google")}
                type="button"
              >
                {exitLoading ? "Confirmando..." : "Confirmar com Google"}
              </button>
            )}

            {!canExitWithPassword && !canExitWithGoogle && (
              <p className="kiosk-exit-warning">Esta conta não possui um método de confirmação compatível. Entre novamente com Google ou e-mail e senha.</p>
            )}

            {exitError && <p aria-live="assertive" className="kiosk-exit-error">{exitError}</p>}
            <button
              className="kiosk-exit-cancel"
              disabled={exitLoading}
              onClick={() => setExitDialogOpen(false)}
              type="button"
            >
              Continuar na sala de ponto
            </button>
          </section>
        </div>
      )}
    </section>
  );
}

function HoursBankScreen({ canEdit, company, onAction }: { canEdit: boolean; company: MainCompanyProfile | null; onAction: (action: string) => void }) {
  const companyId = useActiveCompanyId();
  const now = new Date();
  const [month, setMonth] = useState(String(now.getMonth() + 1).padStart(2, "0"));
  const [year, setYear] = useState(String(now.getFullYear()));
  const [employeesList, setEmployeesList] = useState<LocalEmployee[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [attendanceJustifications, setAttendanceJustifications] = useState<AttendanceJustification[]>([]);
  const [bankAdjustments, setBankAdjustments] = useState<BankHoursAdjustment[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [direction, setDirection] = useState<BankHoursAdjustment["direction"]>("add");
  const [adjustmentHours, setAdjustmentHours] = useState("1");
  const [adjustmentMinutes, setAdjustmentMinutes] = useState("00");
  const [effectiveDate, setEffectiveDate] = useState(now.toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [responsibleName, setResponsibleName] = useState("");
  const [loading, setLoading] = useState(true);
  const adjustmentPanelRef = useRef<HTMLDivElement | null>(null);
  const adjustmentEmployeeRef = useRef<HTMLSelectElement | null>(null);

  async function loadData() {
    try {
      const savedEmployees = await listEmployees(companyId);
      const mappedEmployees = savedEmployees.map((employee) =>
        toLocalEmployee(employee as unknown as Record<string, unknown>, employee.id),
      );
      const employeeIds = mappedEmployees.map((employee) => employee.employeeId);
      const [savedPunches, savedJustifications, savedAdjustments] = await Promise.all([
        listEmployeePunchesByIds(companyId, employeeIds),
        listAttendanceJustifications(companyId),
        listBankHoursAdjustments(companyId),
      ]);
      setEmployeesList(mappedEmployees);
      setPunches(savedPunches);
      setAttendanceJustifications(savedJustifications);
      setBankAdjustments(savedAdjustments);
      setSelectedEmployeeId((current) => current || mappedEmployees[0]?.employeeId || "");
    } catch (error) {
      console.error(error);
      const localEmployees = getLocalEmployees();
      setEmployeesList(localEmployees);
      setPunches([]);
      setAttendanceJustifications([]);
      setBankAdjustments([]);
      setSelectedEmployeeId((current) => current || localEmployees[0]?.employeeId || "");
      onAction("Não foi possível carregar o banco de horas do Firebase. Exibindo os colaboradores locais.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Carrega os dados externos quando a empresa ativa muda.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadData();
    // A empresa ativa muda quando o usuário troca de cliente no mesmo acesso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const selectedYear = Number(year) || now.getFullYear();
  const selectedMonth = Number(month) || now.getMonth() + 1;
  const period = getMonthPeriod(selectedYear, selectedMonth);
  const summaries = useMemo(
    () => {
      const summaryYear = Number(year) || new Date().getFullYear();
      const summaryMonth = Number(month) || new Date().getMonth() + 1;
      const selectedPeriod = getMonthPeriod(summaryYear, summaryMonth);
      const workPolicy = getCompanyWorkPolicy(company);
      return employeesList.map((employee) => buildMonthlyMirrorSummary(
        employee,
        punches.filter((punch) => punch.employeeId === employee.employeeId),
        selectedPeriod,
        workPolicy,
        attendanceJustifications,
        bankAdjustments,
      ));
    },
    [attendanceJustifications, bankAdjustments, company, employeesList, month, punches, year],
  );
  const pendingAdjustments = bankAdjustments.filter((adjustment) => adjustment.status === "pending");
  const historicAdjustments = bankAdjustments
    .filter((adjustment) => adjustment.status !== "pending")
    .sort((first, second) => String(second.effectiveDate).localeCompare(String(first.effectiveDate)))
    .slice(0, 20);

  async function saveBankAdjustment() {
    const hours = Number(adjustmentHours);
    const minutes = Number(adjustmentMinutes);
    const totalMinutes = hours * 60 + minutes;
    if (!selectedEmployeeId || !Number.isInteger(hours) || hours < 0 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59 || totalMinutes < 1) {
      onAction("Informe o colaborador e uma quantidade válida de horas e minutos.");
      return;
    }
    if (!effectiveDate || !reason.trim() || !responsibleName.trim()) {
      onAction("Informe data, motivo e responsável antes de registrar o ajuste.");
      return;
    }

    await createBankHoursAdjustment(companyId, {
      direction,
      effectiveDate,
      employeeId: selectedEmployeeId,
      minutes: totalMinutes,
      reason: reason.trim(),
      responsibleName: responsibleName.trim(),
    });
    setReason("");
    setAdjustmentHours("1");
    setAdjustmentMinutes("00");
    await loadData();
    onAction("Ajuste de banco registrado e enviado para aprovação.");
  }

  async function reviewAdjustment(adjustmentId: string, decision: "approved" | "rejected") {
    try {
      await reviewBankHoursAdjustment(
        companyId,
        adjustmentId,
        decision,
        decision === "rejected" ? "Rejeitado pelo responsável no banco de horas." : "Aprovado pelo responsável no banco de horas.",
      );
      await loadData();
      onAction(decision === "approved" ? "Ajuste aprovado e incluído no saldo." : "Ajuste rejeitado e mantido fora do saldo.");
    } catch (error) {
      console.error(error);
      onAction("Não foi possível revisar o ajuste de banco. Verifique sua permissão.");
    }
  }

  function employeeName(employeeId: string) {
    return employeesList.find((employee) => employee.employeeId === employeeId)?.name || "Colaborador não encontrado";
  }

  function prepareAdjustment(employeeId: string) {
    setSelectedEmployeeId(employeeId);
    onAction(`Ajuste preparado para ${employeeName(employeeId)}. Confira os campos antes de registrar.`);
    window.setTimeout(() => {
      adjustmentPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      adjustmentEmployeeRef.current?.focus();
    }, 0);
  }

  function balanceTone(minutes: number) {
    if (minutes > 0) return "border-[#b7e4cf] bg-[#e8f8f0] text-[#0d7a58]";
    if (minutes < 0) return "border-[#f2b8b5] bg-[#fff0ef] text-[#b42318]";
    return "border-[#d9e0e7] bg-[#f8fafc] text-[#667085]";
  }

  return (
    <>
      <Metrics />
      <Panel title="Banco de horas" subtitle="Saldos por colaborador e periodo">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Mês">
            <select className="input" onChange={(event) => setMonth(event.target.value)} value={month}>
              {monthOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
          <Field label="Ano">
            <input className="input" inputMode="numeric" onChange={(event) => setYear(event.target.value.replace(/\D/g, "").slice(0, 4))} value={year} />
          </Field>
          <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3 text-sm text-[#667085]">
            <span className="text-xs font-semibold uppercase">Período consultado</span>
            <strong className="mt-2 block text-[#101923]">{period.label}</strong>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-4">
          {[
            ["Funcionários", String(summaries.length)],
            ["Saldo positivo", String(summaries.filter((summary) => summary.totalBalanceMinutes > 0).length)],
            ["Saldo negativo", String(summaries.filter((summary) => summary.totalBalanceMinutes < 0).length)],
            ["Ajustes pendentes", String(pendingAdjustments.length)],
          ].map(([label, value]) => (
            <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={label}>
              <p className="text-xs font-semibold uppercase text-[#667085]">{label}</p>
              <strong className="mt-2 block text-lg text-[#101923]">{value}</strong>
            </div>
          ))}
        </div>

        <div className="table-scroll mt-5">
          <table className="w-full min-w-[900px] border-collapse text-left text-sm">
            <thead className="bg-[#101923] text-xs uppercase text-white">
              <tr>
                <th className="px-3 py-3">Funcionário</th>
                <th className="px-3 py-3">Faltas</th>
                <th className="px-3 py-3">Horas extras</th>
                <th className="px-3 py-3">Banco de horas</th>
                <th className="px-3 py-3">Situação</th>
                <th className="px-3 py-3">Ação</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td className="px-3 py-8 text-center text-[#667085]" colSpan={6}>Carregando saldos...</td></tr>
              ) : summaries.length === 0 ? (
                <tr><td className="px-3 py-8 text-center text-[#667085]" colSpan={6}>Nenhum colaborador cadastrado.</td></tr>
              ) : summaries.map((summary) => {
                const balance = summary.totalBalanceMinutes;
                return (
                  <tr className="border-b border-[#e3e8ee]" key={summary.employee.employeeId}>
                    <td className="px-3 py-3"><strong className="text-[#101923]">{summary.employee.name}</strong><span className="text-xs text-[#667085]">{summary.employee.role || "Cargo não informado"}</span></td>
                    <td className="px-3 py-3 font-semibold text-[#26323f]">{summary.absencePoints}</td>
                    <td className="px-3 py-3 font-semibold text-[#0d7a58]">{formatDurationClock(Math.max(balance, 0))}</td>
                    <td className="px-3 py-3 font-semibold">{formatDurationClock(balance)}</td>
                    <td className="px-3 py-3"><span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${balanceTone(balance)}`}>{balance > 0 ? "Positivo" : balance < 0 ? "Negativo" : "Zerado"}</span></td>
                    <td className="px-3 py-3">{canEdit ? <button className="secondary-button px-3 py-2 text-xs" onClick={() => prepareAdjustment(summary.employee.employeeId)} type="button">Ajustar</button> : <span className="text-xs text-[#667085]">Somente consulta</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {canEdit && (
        <div className="scroll-mt-6" ref={adjustmentPanelRef}>
          <Panel title="Ajuste manual do banco" subtitle="Adicione ou desconte horas somente com motivo e responsável">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Colaborador">
              <select className="input" disabled={loading} onChange={(event) => setSelectedEmployeeId(event.target.value)} ref={adjustmentEmployeeRef} value={selectedEmployeeId}>
                {employeesList.map((employee) => <option key={employee.employeeId} value={employee.employeeId}>{employee.name}</option>)}
              </select>
            </Field>
            <Field label="Operação">
              <select className="input" onChange={(event) => setDirection(event.target.value as BankHoursAdjustment["direction"])} value={direction}>
                <option value="add">Adicionar horas</option>
                <option value="remove">Descontar horas</option>
              </select>
            </Field>
            <Field label="Horas">
              <input className="input" min="0" onChange={(event) => setAdjustmentHours(event.target.value.replace(/\D/g, ""))} type="number" value={adjustmentHours} />
            </Field>
            <Field label="Minutos">
              <input className="input" max="59" min="0" onChange={(event) => setAdjustmentMinutes(event.target.value.replace(/\D/g, "").slice(0, 2))} type="number" value={adjustmentMinutes} />
            </Field>
            <Field label="Data de referência">
              <input className="input" onChange={(event) => setEffectiveDate(event.target.value)} type="date" value={effectiveDate} />
            </Field>
            <Field label="Responsável">
              <input className="input" onChange={(event) => setResponsibleName(event.target.value)} placeholder="Nome do responsável" value={responsibleName} />
            </Field>
            <div className="md:col-span-2">
              <Field label="Motivo">
                <textarea className="input min-h-[42px]" onChange={(event) => setReason(event.target.value)} placeholder="Ex.: acordo de compensação aprovado" value={reason} />
              </Field>
            </div>
          </div>
          <ActionRow>
            <SaveButton disabled={loading || !employeesList.length} onClick={saveBankAdjustment}>Registrar ajuste</SaveButton>
          </ActionRow>
          <p className="mt-3 text-xs leading-5 text-[#667085]">O lançamento fica pendente. Depois da aprovação, ele entra no saldo do funcionário e no histórico de auditoria. A batida original nunca é alterada.</p>
          </Panel>
        </div>
      )}

      <Panel title="Ajustes do banco" subtitle="Pendentes e lançamentos já analisados">
        {pendingAdjustments.length === 0 && historicAdjustments.length === 0 ? (
          <p className="text-sm text-[#667085]">Nenhum ajuste de banco registrado para esta empresa.</p>
        ) : (
          <div className="table-scroll">
            <table className="w-full min-w-[840px] border-collapse text-left text-sm">
              <thead className="bg-[#101923] text-xs uppercase text-white"><tr><th className="px-3 py-3">Funcionário</th><th className="px-3 py-3">Data</th><th className="px-3 py-3">Valor</th><th className="px-3 py-3">Motivo</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Ação</th></tr></thead>
              <tbody>
                {[...pendingAdjustments, ...historicAdjustments].map((adjustment) => (
                  <tr className="border-b border-[#e3e8ee]" key={adjustment.id}>
                    <td className="px-3 py-3">{employeeName(adjustment.employeeId)}</td>
                    <td className="px-3 py-3">{new Date(`${adjustment.effectiveDate}T12:00:00`).toLocaleDateString("pt-BR")}</td>
                    <td className={`px-3 py-3 font-semibold ${adjustment.minutes >= 0 ? "text-[#0d7a58]" : "text-[#b42318]"}`}>{formatDurationClock(adjustment.minutes)}</td>
                    <td className="max-w-[260px] px-3 py-3">{adjustment.reason}<span className="block text-xs text-[#667085]">Responsável: {adjustment.responsibleName}</span></td>
                    <td className="px-3 py-3">{adjustment.status === "pending" ? "Pendente" : adjustment.status === "approved" ? "Aprovado" : "Rejeitado"}</td>
                    <td className="px-3 py-3">{canEdit && adjustment.status === "pending" ? <div className="flex flex-wrap gap-2"><button className="primary-button px-3 py-2 text-xs" onClick={() => void reviewAdjustment(adjustment.id, "approved")} type="button">Aprovar</button><button className="secondary-button px-3 py-2 text-xs" onClick={() => void reviewAdjustment(adjustment.id, "rejected")} type="button">Rejeitar</button></div> : <span className="text-xs text-[#667085]">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

function MonthlyClosingScreen({
  company,
  onAction,
}: {
  company: MainCompanyProfile | null;
  onAction: (action: string) => void;
}) {
  const companyId = useActiveCompanyId();
  const now = new Date();
  const [employeesList, setEmployeesList] = useState<LocalEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(String(now.getMonth() + 1).padStart(2, "0"));
  const [year, setYear] = useState(String(now.getFullYear()));
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("all");
  const [responsible, setResponsible] = useState("");
  const [lastSummary, setLastSummary] = useState<MonthlyMirrorSummary[]>([]);
  const [attendanceJustifications, setAttendanceJustifications] = useState<AttendanceJustification[]>([]);
  const [bankAdjustments, setBankAdjustments] = useState<BankHoursAdjustment[]>([]);
  const [punchAdjustments, setPunchAdjustments] = useState<PunchAdjustment[]>([]);
  const [adjustmentEmployeeId, setAdjustmentEmployeeId] = useState("");
  const [adjustmentDate, setAdjustmentDate] = useState(now.toISOString().slice(0, 10));
  const [adjustmentTime, setAdjustmentTime] = useState("07:00");
  const [adjustmentPunchType, setAdjustmentPunchType] = useState<PunchType>("entry");
  const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>("forgotten_with_evidence");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [justificationPeriod, setJustificationPeriod] = useState<AttendanceJustificationPeriod>("morning");
  const [justificationType, setJustificationType] = useState<AttendanceJustificationType>("medical_certificate");
  const [justificationFile, setJustificationFile] = useState<File | null>(null);
  const [justificationSaving, setJustificationSaving] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const [savedInFirebase, savedJustifications, savedBankAdjustments, savedAdjustments] = await Promise.all([
          listEmployees(companyId),
          listAttendanceJustifications(companyId),
          listBankHoursAdjustments(companyId),
          listPunchAdjustments(companyId),
        ]);
        if (!mounted) return;
        setEmployeesList(
          savedInFirebase.map((employee) =>
            toLocalEmployee(employee as unknown as Record<string, unknown>, employee.id),
          ),
        );
        setAttendanceJustifications(savedJustifications);
        setBankAdjustments(savedBankAdjustments);
        setPunchAdjustments(savedAdjustments);
      } catch {
        if (mounted) setEmployeesList(getLocalEmployees());
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void load();

    return () => {
      mounted = false;
    };
  }, [companyId]);

  const selectedEmployees =
    selectedEmployeeId === "all"
      ? employeesList
      : employeesList.filter((employee) => employee.employeeId === selectedEmployeeId);
  const selectedAdjustmentEmployeeId = adjustmentEmployeeId || employeesList[0]?.employeeId || "";
  const workPolicy = getCompanyWorkPolicy(company);

  async function loadMonthlySummaries() {
    if (!selectedEmployees.length) {
      onAction("Nenhum colaborador selecionado para gerar espelho mensal.");
      return null;
    }

    const period = getMonthPeriod(Number(year), Number(month));
    const summaries = await Promise.all(
      selectedEmployees.map(async (employee) => {
        const punches = await listEmployeePunchesByIds(companyId, [
          employee.employeeId,
        ]);
          return buildMonthlyMirrorSummary(employee, punches, period, workPolicy, attendanceJustifications, bankAdjustments);
      }),
    );
    setLastSummary(summaries);
    return { period, summaries };
  }

  async function generateMonthlyMirror() {
    if (!selectedEmployees.length) {
      onAction("Nenhum colaborador selecionado para gerar espelho mensal.");
      return;
    }

    const printWindow = window.open("", "_blank", "width=1100,height=800");
    if (!printWindow) {
      onAction("O navegador bloqueou a janela do PDF. Permita pop-ups para este site e tente novamente.");
      return;
    }

    printWindow.document.write("<p style=\"font-family:Arial,sans-serif;padding:24px\">Gerando o espelho de ponto...</p>");
    printWindow.document.close();

    try {
      const result = await loadMonthlySummaries();
      if (!result) {
        printWindow.close();
        return;
      }

      openPrintableMonthlyMirror({
        company,
        generatedAt: new Date(),
        period: result.period,
        printWindow,
        responsible,
        summaries: result.summaries,
        workPolicy,
      });
      onAction("PDF do fechamento aberto. Na janela de impressão, escolha Salvar como PDF.");
    } catch (error) {
      console.error(error);
      printWindow.close();
      onAction("Não foi possível gerar o PDF do fechamento. Verifique a conexão e tente novamente.");
    }
  }

  async function generateMonthlySummary() {
    if (!selectedEmployees.length) {
      onAction("Nenhum colaborador selecionado para gerar o espelho resumido.");
      return;
    }

    const printWindow = window.open("", "_blank", "width=1100,height=800");
    if (!printWindow) {
      onAction("O navegador bloqueou a janela do PDF. Permita pop-ups para este site e tente novamente.");
      return;
    }

    printWindow.document.write("<p style=\"font-family:Arial,sans-serif;padding:24px\">Gerando o espelho resumido mensal...</p>");
    printWindow.document.close();

    try {
      const result = await loadMonthlySummaries();
      if (!result) {
        printWindow.close();
        return;
      }

      openPrintableMonthlySummary({
        company,
        generatedAt: new Date(),
        period: result.period,
        printWindow,
        responsible,
        summaries: result.summaries,
      });
      onAction("Espelho de ponto resumido mensal aberto. Na janela de impressão, escolha Salvar como PDF.");
    } catch (error) {
      console.error(error);
      printWindow.close();
      onAction("Não foi possível gerar o espelho resumido. Verifique a conexão e tente novamente.");
    }
  }

  async function saveManualAdjustment() {
    const employee = employeesList.find((item) => item.employeeId === selectedAdjustmentEmployeeId);
    if (!employee) {
      onAction("Selecione um colaborador para registrar o ajuste.");
      return;
    }

    if (!adjustmentDate || !adjustmentTime || !adjustmentReason.trim() || !responsible.trim()) {
      onAction("Informe data, horario, motivo e responsavel antes de salvar o ajuste.");
      return;
    }

    const adjustedAt = dateTimeFromInputs(adjustmentDate, adjustmentTime);
    if (!adjustedAt) {
      onAction("Data ou horario do ajuste invalido.");
      return;
    }

    try {
      const created = await createPunchAdjustment(companyId, {
        adjustedPunchType: adjustmentPunchType,
        adjustedTime: adjustedAt,
        companyId,
        createdAt: new Date(),
        createdBy: responsible.trim(),
        employeeId: employee.employeeId,
        evidence: "Ajuste manual registrado no fechamento mensal.",
        reason: adjustmentReason.trim(),
        type: adjustmentType,
      });

      setPunchAdjustments((current) => [
        ...current,
        {
          adjustedPunchType: adjustmentPunchType,
          adjustedTime: adjustedAt,
          companyId,
          createdAt: new Date(),
          createdBy: responsible.trim(),
          employeeId: employee.employeeId,
          evidence: "Ajuste manual registrado no fechamento mensal.",
          id: created.id,
          reason: adjustmentReason.trim(),
          status: "pending",
          type: adjustmentType,
        },
      ]);

      setAdjustmentReason("");
      onAction(`Ajuste de ${employee.name} registrado para aprovacao do responsavel.`);
    } catch (error) {
      console.error(error);
      onAction("Nao foi possivel salvar o ajuste no Firebase. Verifique a conexao e tente novamente.");
      throw error;
    }
  }

  async function reviewAdjustment(adjustmentId: string, decision: "approved" | "rejected") {
    try {
      const result = await reviewPunchAdjustment(companyId, adjustmentId, decision, responsible.trim());
      setPunchAdjustments((current) => current.map((item) =>
        item.id === adjustmentId ? { ...item, status: result.status as PunchAdjustment["status"] } : item,
      ));
      onAction(decision === "approved" ? "Ajuste aprovado e incluído na conferencia." : "Ajuste rejeitado; a batida original foi preservada.");
    } catch (error) {
      console.error(error);
      onAction("Nao foi possivel revisar o ajuste. Verifique sua permissao.");
    }
  }

  async function saveAttendanceJustification() {
    const employee = employeesList.find((item) => item.employeeId === selectedAdjustmentEmployeeId);
    if (!employee) {
      onAction("Selecione um colaborador para registrar a justificativa.");
      return;
    }

    if (!adjustmentDate || !adjustmentReason.trim() || !responsible.trim()) {
      onAction("Informe data, justificativa e responsável antes de salvar.");
      return;
    }

    if (justificationFile && (!justificationFile.type.match(/^(image\/|application\/pdf$)/) || justificationFile.size > 10 * 1024 * 1024)) {
      onAction("O anexo deve ser uma imagem ou PDF de até 10 MB.");
      return;
    }

    setJustificationSaving(true);
    try {
      const evidenceId = crypto.randomUUID();
      const evidencePath = justificationFile
        ? await uploadAttendanceEvidence({
            blob: justificationFile,
            companyId,
            date: adjustmentDate,
            employeeId: employee.employeeId,
            evidenceId,
          })
        : undefined;
      const justification: Omit<AttendanceJustification, "id"> = {
        companyId,
        createdAt: new Date(),
        createdBy: responsible.trim(),
        date: adjustmentDate,
        employeeId: employee.employeeId,
        ...(evidencePath ? { evidencePath, evidenceName: justificationFile?.name } : {}),
        period: justificationPeriod,
        reason: adjustmentReason.trim(),
        status: "pending",
        type: justificationType,
      };
      const created = await createAttendanceJustification(companyId, justification);
      setAttendanceJustifications((current) => [...current, { ...justification, id: created.id }]);
      setJustificationFile(null);
      setAdjustmentReason("");
      onAction(`Justificativa de ${employee.name} registrada para análise do responsável.`);
    } catch (error) {
      console.error(error);
      onAction("Não foi possível salvar a justificativa. Verifique a conexão e as permissões.");
    } finally {
      setJustificationSaving(false);
    }
  }

  async function reviewJustification(justificationId: string, decision: "approved" | "rejected") {
    try {
      const result = await reviewAttendanceJustification(companyId, justificationId, decision, responsible.trim());
      setAttendanceJustifications((current) => current.map((item) =>
        item.id === justificationId ? { ...item, status: result.status as AttendanceJustification["status"] } : item,
      ));
      onAction(decision === "approved" ? "Justificativa aprovada e considerada no fechamento." : "Justificativa rejeitada; a pendencia permanece para conferencia.");
    } catch (error) {
      console.error(error);
      onAction("Nao foi possivel revisar a justificativa. Verifique sua permissao.");
    }
  }

  return (
    <>
      <Panel title="Fechamento mensal" subtitle="Conferencia antes de enviar para o contador">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Mes">
            <select className="input" onChange={(event) => setMonth(event.target.value)} value={month}>
              {monthOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Ano">
            <input className="input" onChange={(event) => setYear(event.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="2026" value={year} />
          </Field>
          <Field label="Colaborador">
            <select className="input" disabled={loading} onChange={(event) => setSelectedEmployeeId(event.target.value)} value={selectedEmployeeId}>
              <option value="all">Todos os colaboradores</option>
              {employeesList.map((employee) => (
                <option key={employee.employeeId} value={employee.employeeId}>{employee.name}</option>
              ))}
            </select>
          </Field>
          <MaskedField label="Responsavel" mask="name" onChange={setResponsible} placeholder="Nome Do Responsavel" value={responsible} />
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-5">
          {[
            ["Funcionarios", String(selectedEmployees.length)],
            ["Periodo", `${month}/${year}`],
            ["Gerados", String(lastSummary.length)],
            ["Faltas", String(lastSummary.reduce((total, item) => total + item.absencePoints, 0))],
            ["Banco", formatDurationClock(lastSummary.reduce((total, item) => total + item.totalBalanceMinutes, 0))],
          ].map(([label, value]) => (
            <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={label}>
              <p className="text-xs font-semibold uppercase text-[#667085]">{label}</p>
              <strong className="mt-2 block text-lg text-[#101923]">{value}</strong>
            </div>
          ))}
        </div>

        <ActionRow>
          <button className="primary-button" disabled={loading} onClick={() => void generateMonthlyMirror()} type="button">Gerar PDF para contador</button>
          <button className="secondary-button" disabled={loading} onClick={() => void generateMonthlySummary()} type="button">Espelho de ponto resumido mensal</button>
          <button className="secondary-button" onClick={() => onAction("Fechamento mensal bloqueado")} type="button">Fechar mes</button>
        </ActionRow>
      </Panel>

      <Panel title="Ajuste manual de batida" subtitle="Use somente para esquecimento, trabalho externo ou correcao aprovada">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Colaborador">
            <select
              className="input"
              disabled={loading}
              onChange={(event) => setAdjustmentEmployeeId(event.target.value)}
              value={selectedAdjustmentEmployeeId}
            >
              {employeesList.length === 0 ? (
                <option value="">Nenhum colaborador cadastrado</option>
              ) : (
                employeesList.map((employee) => (
                  <option key={employee.employeeId} value={employee.employeeId}>{employee.name}</option>
                ))
              )}
            </select>
          </Field>
          <Field label="Data">
            <input className="input" onChange={(event) => setAdjustmentDate(event.target.value)} type="date" value={adjustmentDate} />
          </Field>
          <TimeStepper label="Horario" onChange={setAdjustmentTime} value={adjustmentTime} />
          <Field label="Batida">
            <select className="input" onChange={(event) => setAdjustmentPunchType(event.target.value as PunchType)} value={adjustmentPunchType}>
              <option value="entry">Entrada</option>
              <option value="lunch_out">Intervalo</option>
              <option value="lunch_back">Retorno</option>
              <option value="exit">Saida</option>
            </select>
          </Field>
          <Field label="Tipo de ajuste">
            <select className="input" onChange={(event) => setAdjustmentType(event.target.value as AdjustmentType)} value={adjustmentType}>
              <option value="forgotten_with_evidence">Esquecimento com evidencia</option>
              <option value="external_work">Trabalho externo</option>
              <option value="manager_punch">Lancado pelo responsavel</option>
              <option value="operational_error">Erro operacional</option>
            </select>
          </Field>
          <Field label="Motivo">
            <input
              className="input"
              onChange={(event) => setAdjustmentReason(maskName(event.target.value))}
              placeholder="Ex.: esqueceu a entrada, mas bateu intervalo"
              value={adjustmentReason}
            />
          </Field>
          <Field label="Responsavel">
            <input
              className="input"
              onChange={(event) => setResponsible(maskName(event.target.value))}
              placeholder="Nome Do Responsavel"
              value={responsible}
            />
          </Field>
        </div>
        <ActionRow>
          <SaveButton disabled={loading || !employeesList.length} onClick={saveManualAdjustment}>
            Salvar ajuste
          </SaveButton>
          <button
            className="secondary-button"
            onClick={() => {
              setAdjustmentReason("");
              onAction("Ajuste manual limpo.");
            }}
            type="button"
          >
            Limpar ajuste
          </button>
        </ActionRow>
      </Panel>

      <Panel title="Atestado ou justificativa" subtitle="Resolva falta, esquecimento, trabalho externo ou atraso acima da tolerância">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Período da ocorrência">
            <select className="input" onChange={(event) => setJustificationPeriod(event.target.value as AttendanceJustificationPeriod)} value={justificationPeriod}>
              <option value="morning">Manhã</option>
              <option value="afternoon">Tarde</option>
              <option value="full_day">Dia inteiro</option>
            </select>
          </Field>
          <Field label="Tipo de justificativa">
            <select className="input" onChange={(event) => setJustificationType(event.target.value as AttendanceJustificationType)} value={justificationType}>
              <option value="medical_certificate">Atestado médico</option>
              <option value="external_work">Trabalho externo</option>
              <option value="forgotten_punch">Esquecimento de batida</option>
              <option value="late_justification">Atraso justificado</option>
              <option value="other">Outra justificativa</option>
            </select>
          </Field>
          <Field label="Anexo opcional">
            <input
              accept="image/*,application/pdf"
              className="input"
              onChange={(event) => setJustificationFile(event.target.files?.[0] || null)}
              type="file"
            />
          </Field>
          <div className="rounded-md border border-[#cfe3dc] bg-[#f1faf7] p-3 text-xs leading-5 text-[#24594d]">
            <strong>Classificação:</strong> a ocorrência entra como pendente e só deixa de contar como falta após aprovação do responsável.
          </div>
        </div>
        {justificationFile && <p className="mt-3 text-xs text-[#667085]">Anexo selecionado: {justificationFile.name}</p>}
        <ActionRow>
          <SaveButton disabled={loading || justificationSaving || !employeesList.length} onClick={saveAttendanceJustification}>
            {justificationSaving ? "Salvando justificativa..." : "Salvar justificativa"}
          </SaveButton>
        </ActionRow>
      </Panel>

      <Panel title="Ajustes pendentes" subtitle="Aprovacao server-side antes de entrar na conferencia do fechamento">
        <div className="grid gap-2">
          {punchAdjustments.filter((item) => item.status === "pending").map((item) => {
            const employee = employeesList.find((candidate) => candidate.employeeId === item.employeeId);
            return (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#efd9a8] bg-[#fff8e9] px-3 py-3" key={item.id}>
                <div>
                  <p className="text-sm font-semibold text-[#26323f]">{employee?.name || "Colaborador"} · {formatUnknownDateTime(item.adjustedTime)}</p>
                  <p className="mt-1 text-xs text-[#6f4c0a]">{item.type} · {item.adjustedPunchType} · {item.reason}</p>
                </div>
                <div className="flex gap-2">
                  <button className="primary-button" onClick={() => void reviewAdjustment(item.id, "approved")} type="button">Aprovar</button>
                  <button className="secondary-button" onClick={() => void reviewAdjustment(item.id, "rejected")} type="button">Rejeitar</button>
                </div>
              </div>
            );
          })}
          {!punchAdjustments.some((item) => item.status === "pending") && (
            <p className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3 text-sm text-[#667085]">Nenhum ajuste pendente.</p>
          )}
        </div>
      </Panel>

      <Panel title="Justificativas pendentes" subtitle="Aprovação server-side antes de alterar a leitura do fechamento">
        <div className="grid gap-2">
          {attendanceJustifications.filter((item) => item.status === "pending").map((item) => {
            const employee = employeesList.find((candidate) => candidate.employeeId === item.employeeId);
            return (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#efd9a8] bg-[#fff8e9] px-3 py-3" key={item.id}>
                <div>
                  <p className="text-sm font-semibold text-[#26323f]">{employee?.name || "Colaborador"} · {item.date}</p>
                  <p className="mt-1 text-xs text-[#6f4c0a]">{item.type} · {item.period} · {item.reason}</p>
                </div>
                <div className="flex gap-2">
                  <button className="primary-button" onClick={() => void reviewJustification(item.id, "approved")} type="button">Aprovar</button>
                  <button className="secondary-button" onClick={() => void reviewJustification(item.id, "rejected")} type="button">Rejeitar</button>
                </div>
              </div>
            );
          })}
          {!attendanceJustifications.some((item) => item.status === "pending") && (
            <p className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3 text-sm text-[#667085]">Nenhuma justificativa pendente.</p>
          )}
        </div>
      </Panel>

      <Panel title="Conferencia por funcionario" subtitle="Base do arquivo mensal e da ficha individual">
        <div className="table-scroll">
          <table className="w-full min-w-[980px] border-collapse text-left text-sm">
            <thead className="bg-[#101923] text-xs uppercase text-white">
              <tr>
                {[
                  "Funcionario",
                  "CPF",
                  "Cargo",
                  "Dias",
                  "Falta manha",
                  "Falta tarde",
                  "Batida incompleta",
                  "Atrasos",
                  "Banco",
                  "Observacao",
                ].map((head) => (
                  <th className="px-4 py-3 font-semibold" key={head}>{head}</th>
                ))}
              </tr>
          </thead>
          <tbody>
            {lastSummary.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-[#667085]" colSpan={10}>
                  Gere o espelho mensal para visualizar a conferencia por funcionario.
                </td>
              </tr>
            ) : (
              lastSummary.map((summary) => (
                  <tr className="border-b border-[#e3e8ee]" key={summary.employee.employeeId}>
                    {[
                      summary.employee.name,
                      summary.employee.cpf,
                      summary.employee.role,
                      String(summary.rows.length),
                      String(summary.missingMornings),
                      String(summary.missingAfternoons),
                      String(summary.incompleteMornings + summary.incompleteAfternoons),
                      formatDurationClock(summary.lateMinutes),
                      formatDurationClock(summary.totalBalanceMinutes),
                      summary.pendingDays ? `${summary.pendingDays} dias com pendencia` : "Sem pendencia aparente",
                    ].map((cell, index) => (
                      <td
                        className={`px-4 py-3 ${index === 0 ? "font-semibold text-[#101923]" : "text-[#667085]"}`}
                        key={`${summary.employee.employeeId}-${cell}-${index}`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))
            )}
          </tbody>
        </table>
        </div>
      </Panel>

      <TwoColumn>
        <Panel title="Pendencias antes do fechamento" subtitle="Itens que o responsavel deve conferir">
          <CheckList
            items={[
              "Ajustes manuais com justificativa preenchida",
              "Trabalho externo aprovado conforme politica da empresa",
              "Faltas por periodo revisadas antes do envio",
              "Banco de horas conferido com o responsavel",
            ]}
          />
        </Panel>
        <Panel title="Entrega para contador" subtitle="Arquivos previstos">
          <CheckList
            items={[
              "PDF mensal para conferencia do contador",
              "Ficha individual para ciencia do funcionario",
              "Historico de ajustes e abonos do periodo",
            ]}
          />
        </Panel>
      </TwoColumn>
    </>
  );
}

function ReportsScreen({ company, onAction }: { company: MainCompanyProfile | null; onAction: (action: string) => void }) {
  const companyId = useActiveCompanyId();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const [startDate, setStartDate] = useState(monthStart);
  const [endDate, setEndDate] = useState(today);
  const [employeesList, setEmployeesList] = useState<LocalEmployee[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("all");
  const [reportType, setReportType] = useState<"bank" | "journey" | "mirror">("journey");
  const [reportPunches, setReportPunches] = useState<Punch[]>([]);
  const [reportLoading, setReportLoading] = useState(true);
  const [reportError, setReportError] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let mounted = true;
    listEmployees(companyId)
      .then((saved) => {
        if (!mounted) return;
        setEmployeesList(saved
          .map((employee) => toLocalEmployee(employee as unknown as Record<string, unknown>, employee.id))
          .filter((employee) => employee.active !== false));
      })
      .catch((error) => {
        console.error(error);
        if (mounted) setReportError("Não foi possível carregar os colaboradores desta empresa.");
      })
      .finally(() => {
        if (mounted) setReportLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [companyId]);

  async function loadReportData() {
    if (!startDate || !endDate || startDate > endDate) {
      setReportError("Informe um período válido.");
      return [] as Punch[];
    }

    const selectedIds = selectedEmployeeId === "all"
      ? employeesList.map((employee) => employee.employeeId)
      : [selectedEmployeeId];
    if (!selectedIds.length) {
      setReportPunches([]);
      setReportError("Cadastre um colaborador antes de gerar o relatório.");
      return [] as Punch[];
    }

    setReportLoading(true);
    setReportError("");
    try {
      const loaded = await listEmployeePunchesByIds(companyId, selectedIds);
      const start = new Date(`${startDate}T00:00:00`).getTime();
      const end = new Date(`${endDate}T23:59:59.999`).getTime();
      const filtered = loaded
        .filter((punch) => {
          const occurredAt = punchDate(punch).getTime();
          return occurredAt >= start && occurredAt <= end;
        })
        .sort((first, second) => punchDate(first).getTime() - punchDate(second).getTime());
      setReportPunches(filtered);
      return filtered;
    } catch (error) {
      console.error(error);
      setReportPunches([]);
      setReportError("Não foi possível carregar as batidas do período.");
      return [] as Punch[];
    } finally {
      setReportLoading(false);
    }
  }

  useEffect(() => {
    if (!employeesList.length) return;
    const timer = window.setTimeout(() => void loadReportData(), 0);
    // A prévia acompanha os filtros atuais; a função mantém a validação em um único ponto.
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeesList, endDate, selectedEmployeeId, startDate]);

  function employeeName(employeeId: string) {
    return employeesList.find((employee) => employee.employeeId === employeeId)?.name || "Colaborador não encontrado";
  }

  function reportRows(punches: Punch[]) {
    const sourceLabels: Record<Punch["source"], string> = {
      external_face_id: "Ponto externo - Face ID",
      external_pin_photo: "Ponto externo - PIN + foto",
      face_id: "Sala de ponto - Face ID",
      manager: "Ajuste do responsável",
      pin_photo: "Sala de ponto - PIN + foto",
    };
    return [
      ["Colaborador", "Data e hora", "Marcação", "Situação", "Origem"],
      ...punches.map((punch) => [
        employeeName(punch.employeeId),
        formatPunchDateTime(punch),
        punch.scheduledPunch || formatPunchType(punch.type),
        formatPunchStatus(punch.status),
        sourceLabels[punch.source],
      ]),
    ];
  }

  async function exportReportPdf() {
    const printWindow = window.open("", "_blank", "width=1100,height=800");
    if (!printWindow) {
      onAction("O navegador bloqueou a janela do PDF. Permita pop-ups para este site e tente novamente.");
      return;
    }

    printWindow.document.write("<p style=\"font-family:Arial,sans-serif;padding:24px\">Gerando o relatório de jornada...</p>");
    printWindow.document.close();
    setExporting(true);
    try {
      const punches = await loadReportData();
      const selectedEmployee = selectedEmployeeId === "all" ? "Todos os colaboradores" : employeeName(selectedEmployeeId);
      const reportTitles = {
        bank: "Relatório de banco de horas",
        journey: "Relatório de jornada detalhada",
        mirror: "Espelho de ponto",
      };
      openPrintableDataReport({
        company,
        fields: {
          "Período": `${startDate} a ${endDate}`,
          "Colaborador": selectedEmployee,
          "Registros encontrados": String(punches.length),
        },
        printWindow,
        rows: reportRows(punches),
        title: reportTitles[reportType],
      });
      onAction("Relatório aberto para impressão ou salvamento em PDF.");
    } catch (error) {
      console.error(error);
      printWindow.close();
      onAction("Não foi possível gerar o PDF. Confira o período e as permissões.");
    } finally {
      setExporting(false);
    }
  }

  async function exportFiscalFiles() {
    if (!startDate || !endDate || startDate > endDate) {
      onAction("Informe um periodo valido para a exportacao fiscal.");
      return;
    }
    setExporting(true);
    try {
      const exported = await generateRepExports(companyId, startDate, endDate);
      downloadTextFile(exported.filenames.afd, exported.afd, "text/plain;charset=iso-8859-1");
      window.setTimeout(() => {
        downloadTextFile(exported.filenames.aej, exported.aej, "text/plain;charset=iso-8859-1");
      }, 300);
      onAction(
        exported.officialReady
          ? "AFD e AEJ gerados com configuracao fiscal completa."
          : `Previas AFD e AEJ geradas. Pendencias: ${exported.missingFields.join(", ") || "certificado ICP-Brasil"}.`,
      );
    } catch (error) {
      console.error(error);
      onAction("Nao foi possivel gerar AFD e AEJ. Confira o periodo e os dados obrigatorios.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <Panel title="Gerar relatorio" subtitle="Espelho de ponto e jornada detalhada">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Colaborador">
            <select className="input" onChange={(event) => setSelectedEmployeeId(event.target.value)} value={selectedEmployeeId}>
              <option value="all">Todos os colaboradores</option>
              {employeesList.map((employee) => <option key={employee.employeeId} value={employee.employeeId}>{employee.name}</option>)}
            </select>
          </Field>
          <Field label="Inicio"><input className="input" onChange={(event) => setStartDate(event.target.value)} type="date" value={startDate} /></Field>
          <Field label="Fim"><input className="input" onChange={(event) => setEndDate(event.target.value)} type="date" value={endDate} /></Field>
          <Field label="Tipo">
            <select className="input" onChange={(event) => setReportType(event.target.value as typeof reportType)} value={reportType}>
              <option value="journey">Jornada detalhada</option>
              <option value="mirror">Espelho de ponto</option>
              <option value="bank">Banco de horas</option>
            </select>
          </Field>
        </div>
        <ActionRow>
          <button className="primary-button" disabled={exporting || reportLoading || !employeesList.length} onClick={() => void exportReportPdf()} type="button">{exporting ? "Gerando PDF..." : "Gerar PDF para contador"}</button>
          <button className="secondary-button" disabled={exporting} onClick={() => void exportFiscalFiles()} type="button">
            {exporting ? "Gerando..." : "Baixar AFD + AEJ técnicos"}
          </button>
        </ActionRow>
        {reportError && <p className="mt-3 rounded-md border border-[#fecaca] bg-[#fff1f2] p-3 text-sm font-semibold text-[#a62929]">{reportError}</p>}
        <p className="mt-3 text-xs leading-5 text-[#667085]">O PDF é o documento de conferência para o escritório contábil. AFD e AEJ permanecem em arquivo técnico próprio, porque sistemas oficiais exigem o formato estruturado original.</p>
      </Panel>
      <ReportPreview
        employees={employeesList}
        endDate={endDate}
        loading={reportLoading}
        punches={reportPunches}
        selectedEmployeeId={selectedEmployeeId}
        startDate={startDate}
      />
    </>
  );
}

function openBiometricConsentTerm({
  company,
  employee,
  retentionPeriod,
}: {
  company: MainCompanyProfile | null;
  employee: LocalEmployee;
  retentionPeriod: string;
}) {
  const printWindow = window.open("", "_blank", "width=1000,height=800");
  if (!printWindow) throw new Error("biometric-consent-popup-blocked");

  const companyName = String(company?.legalName || company?.tradeName || "Empresa");
  const cnpj = String(company?.cnpj || "Não informado");
  const identifier = employee.registration ? `Matrícula: ${employee.registration}` : "";
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Termo de biometria facial - ${escapeHtml(employee.name)}</title>
    <style>
      @page{size:A4;margin:16mm}*{box-sizing:border-box}body{margin:0;color:#142235;font:12px/1.55 Arial,sans-serif;background:#eef2f5}.toolbar{position:sticky;top:0;display:flex;justify-content:flex-end;padding:12px;background:#0b1722;gap:8px}.toolbar button{border:0;border-radius:6px;padding:10px 14px;font-weight:700;cursor:pointer}.print{background:#087f69;color:#fff}.close{background:#fff;color:#142235}main{width:210mm;min-height:270mm;margin:14px auto;padding:14mm;background:#fff}header{border-bottom:2px solid #087f69;padding-bottom:12px}h1{font-size:20px;line-height:1.25;margin:4px 0 8px}.eyebrow{font-size:9px;font-weight:800;letter-spacing:.14em;color:#087f69;text-transform:uppercase}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.meta div{border:1px solid #d9e0e7;border-radius:5px;padding:8px}.meta strong{display:block;font-size:9px;color:#64748b;text-transform:uppercase}.meta span{display:block;margin-top:3px;font-weight:700}.section{margin-top:14px}.section h2{font-size:12px;margin:0 0 5px}.section p{margin:4px 0}.choice{border:1px solid #cbd5e1;border-radius:5px;padding:10px;margin-top:8px}.signature{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:48px;text-align:center}.line{border-top:1px solid #142235;padding-top:6px}.notice{margin-top:18px;border:1px solid #ead6a8;background:#fff9e9;border-radius:5px;padding:9px;font-size:10px;color:#6f4c0a}.footer{margin-top:16px;color:#64748b;font-size:9px}@media print{body{background:#fff}.toolbar{display:none}main{width:auto;min-height:auto;margin:0;padding:0}}
    </style></head><body><div class="toolbar"><button class="close" onclick="window.close()">Fechar</button><button class="print" onclick="window.print()">Imprimir / salvar PDF</button></div><main>
      <header><p class="eyebrow">Orquestracs Face ID · Proteção de dados</p><h1>Termo de informação e manifestação sobre biometria facial</h1><p>Controle de jornada e autenticação de marcações de ponto</p></header>
      <div class="meta"><div><strong>Empresa controladora</strong><span>${escapeHtml(companyName)}</span></div><div><strong>CNPJ</strong><span>${escapeHtml(cnpj)}</span></div><div><strong>Colaborador(a)</strong><span>${escapeHtml(employee.name)}</span></div><div><strong>Identificação</strong><span>${escapeHtml(identifier || employee.employeeId)}</span></div></div>
      <section class="section"><h2>1. Finalidade e dados tratados</h2><p>A empresa informa que poderá tratar uma imagem facial e características biométricas dela derivadas para identificar e autenticar este(a) colaborador(a) no registro de jornada. A finalidade é restrita ao controle de ponto. A imagem e a biometria não devem ser usadas para publicidade, avaliação de desempenho ou finalidade incompatível.</p></section>
      <section class="section"><h2>2. Armazenamento, acesso e prazo</h2><p>Os dados serão mantidos em ambiente digital com acesso restrito às pessoas autorizadas e aos prestadores de infraestrutura necessários à operação do sistema, observadas as medidas de segurança e as instruções da empresa.</p><p><strong>Prazo informado pela empresa:</strong> ${escapeHtml(retentionPeriod)}. Ao fim da finalidade, os dados serão eliminados ou anonimizados, ressalvadas hipóteses legais de conservação.</p></section>
      <section class="section"><h2>3. Alternativa e direitos</h2><p>Há alternativa de registro por PIN + foto na sala de ponto. O(a) titular pode solicitar informações, acesso, correção e demais direitos aplicáveis, inclusive revogação quando o tratamento estiver baseado em consentimento, pelo canal de privacidade indicado pela empresa: <strong>${escapeHtml(String(company?.contactEmail || "________________________________________"))}</strong>.</p></section>
      <section class="section"><h2>4. Manifestação do(a) titular</h2><p>Declaro que recebi informações sobre a finalidade, os dados tratados, o prazo e o canal para exercício dos meus direitos. A manifestação abaixo é específica para o uso de biometria facial descrito neste documento.</p><div class="choice">☐ <strong>Autorizo</strong> o tratamento da minha biometria facial para a finalidade de identificação e autenticação de marcações de ponto descrita acima.</div><div class="choice">☐ <strong>Não autorizo</strong> o uso da biometria facial e solicito orientação sobre o método alternativo disponibilizado pela empresa.</div></section>
      <div class="signature"><div class="line">Assinatura do(a) colaborador(a)</div><div class="line">Responsável pela empresa</div></div><p style="margin-top:18px">Local e data: ______________________________________________</p>
      <div class="notice"><strong>Importante:</strong> este modelo documenta informação e manifestação do titular, mas não define por si só a base legal adequada nem garante conformidade. A empresa deve validar o texto, a base legal, a retenção e a alternativa com sua assessoria jurídica ou encarregado de dados antes de coletar assinaturas.</div>
      <p class="footer">Documento individual para assinatura física. A geração deste arquivo não registra assinatura nem altera o cadastro biométrico do colaborador.</p>
    </main></body></html>`;
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  printWindow.setTimeout(() => printWindow.print(), 350);
}

function AuditScreen({ company, onAction }: { company: MainCompanyProfile | null; onAction: (action: string) => void }) {
  const companyId = useActiveCompanyId();
  const [employees, setEmployees] = useState<LocalEmployee[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [retentionPeriod, setRetentionPeriod] = useState("");

  useEffect(() => {
    let mounted = true;
    void listEmployees(companyId).then((saved) => {
      if (!mounted) return;
      const mapped = saved.map((employee) => toLocalEmployee(employee as unknown as Record<string, unknown>, employee.id));
      setEmployees(mapped);
      setEmployeeId((current) => current || mapped[0]?.employeeId || "");
    }).catch((error) => console.error("Falha ao carregar colaboradores para o termo biométrico.", error));
    return () => { mounted = false; };
  }, [companyId]);

  const selectedEmployee = employees.find((employee) => employee.employeeId === employeeId);

  function generateConsentTerm() {
    if (!selectedEmployee || !retentionPeriod.trim()) {
      onAction("Selecione o colaborador e informe o prazo de retenção definido pela empresa.");
      return;
    }
    try {
      openBiometricConsentTerm({ company, employee: selectedEmployee, retentionPeriod: retentionPeriod.trim() });
      onAction("Termo individual aberto para imprimir ou salvar em PDF. A assinatura deve ser coletada fisicamente.");
    } catch {
      onAction("O navegador bloqueou a janela do termo. Permita pop-ups para este endereço e tente novamente.");
    }
  }

  return (
    <TwoColumn>
      <ComplianceCard />
      <Panel title="LGPD e consentimento" subtitle="Cuidados antes da biometria real">
        <CheckList items={["Informação específica sobre biometria facial", "Base legal e texto ainda exigem validação jurídica", "Alternativa disponível: PIN + foto", "Prazo de retenção informado pela empresa", "Canal para solicitações do titular"]} />
        <div className="mt-4 grid gap-3">
          <Field label="Colaborador do termo">
            <select className="input" onChange={(event) => setEmployeeId(event.target.value)} value={employeeId}>
              {employees.length ? employees.map((employee) => <option key={employee.employeeId} value={employee.employeeId}>{employee.name}</option>) : <option value="">Nenhum colaborador cadastrado</option>}
            </select>
          </Field>
          <Field label="Prazo de retenção informado pela empresa">
            <input className="input" onChange={(event) => setRetentionPeriod(event.target.value)} placeholder="Ex.: enquanto durar a finalidade, conforme política validada" value={retentionPeriod} />
          </Field>
        </div>
        <ActionRow>
          <button className="primary-button" disabled={!selectedEmployee} onClick={generateConsentTerm} type="button">Gerar termo do colaborador</button>
          <button className="secondary-button" onClick={() => onAction("Relatorio de impacto")} type="button">Relatorio de impacto</button>
        </ActionRow>
        <p className="mt-3 text-xs leading-5 text-[#64748b]">O termo abre para impressão ou salvamento em PDF. A assinatura não é registrada no sistema; valide o conteúdo jurídico antes de usar.</p>
      </Panel>
    </TwoColumn>
  );
}

function AdminScreen(props: {
  company: MainCompanyProfile | null;
  config: TenantSaasConfig | null;
  invites: TenantInvite[];
  onAction: (action: string) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <>
      <AdminCentral {...props} />
      <details className="mt-4 rounded-lg border border-[#cbd8cf] bg-[#edf3ec] p-3">
        <summary className="cursor-pointer px-2 py-2 text-sm font-semibold text-[#315352]">
          Controles técnicos, REP-P e permissões avançadas
        </summary>
        {advancedOpen ? <AdminComplianceScreen {...props} /> : null}
        {!advancedOpen ? (
          <button className="secondary-button mt-2" onClick={() => setAdvancedOpen(true)} type="button">
            Abrir controles avançados
          </button>
        ) : null}
      </details>
    </>
  );
}

function AdminComplianceScreen({
  company,
  config,
  invites,
  onAction,
}: {
  company: MainCompanyProfile | null;
  config: TenantSaasConfig | null;
  invites: TenantInvite[];
  onAction: (action: string) => void;
}) {
  const companyId = useActiveCompanyId();
  const effectiveConfig: TenantSaasConfig = config || {
    aiCredits: { balance: 150, bonus: 0, included: 150, renewalMonth: new Date().toISOString().slice(0, 7), status: "Ativo", used: 0 },
    billing: { amount: "R$ 0,00", dueDate: "", graceDays: 5, status: "Teste" },
    employeeLimit: 25,
    name: "Cliente Face ID",
    plan: "Essencial",
    status: "Teste",
    tenantId: companyId,
  };

  const pendingInvites = invites.filter((invite) => invite.status === "Ativo").length;
  const remainingCredits = effectiveConfig.aiCredits.balance;
  const usedCredits = effectiveConfig.aiCredits.used;
  const [readinessCheck, setReadinessCheck] = useState<{
    missingFields: string[];
    officialReady: boolean;
    signatureStatus: string;
  } | null>(null);
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  const [syncingPortal, setSyncingPortal] = useState(false);
  const [portalSyncMessage, setPortalSyncMessage] = useState("");
  const repP = company?.repP && typeof company.repP === "object"
    ? company.repP as Record<string, unknown>
    : {};
  const inpiRegistration = String(repP.inpiRegistration || company?.inpiRegistration || "").trim();
  const technicalStatementAttached = repP.technicalStatementAttached === true;
  const certificateConfigured = repP.certificateConfigured === true;

  async function checkRepReadiness() {
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = `${today.slice(0, 8)}01`;
    setCheckingReadiness(true);
    try {
      const result = await generateRepExports(companyId, monthStart, today);
      setReadinessCheck({
        missingFields: result.missingFields,
        officialReady: result.officialReady,
        signatureStatus: result.signatureStatus,
      });
      onAction(result.officialReady ? "REP-P validado para o periodo atual." : "Verificacao REP-P concluida com pendencias.");
    } catch (error) {
      console.error(error);
      setReadinessCheck({
        missingFields: ["Nao foi possivel concluir a verificacao. Confira autenticacao, empresa e periodo."],
        officialReady: false,
        signatureStatus: "verification_error",
      });
      onAction("Nao foi possivel verificar a prontidao REP-P.");
    } finally {
      setCheckingReadiness(false);
    }
  }

  async function handlePortalSync() {
    setSyncingPortal(true);
    setPortalSyncMessage("");
    try {
      const result = await syncPortalSnapshot();
      setPortalSyncMessage(`Central sincronizada: ${result.clients} cliente(s) e ${result.users} usuario(s).`);
    } catch (error) {
      console.error(error);
      setPortalSyncMessage("Nao foi possivel sincronizar a Central agora.");
    } finally {
      setSyncingPortal(false);
    }
  }

  const adminMetrics = [
    ["Clientes", "1", effectiveConfig.status.toLowerCase()],
    ["Funcionarios", String(effectiveConfig.employeeLimit), "limite contratado"],
    ["Convites", String(pendingInvites), "ativos"],
    ["IA", String(remainingCredits), `${usedCredits} creditos usados`],
  ];

  const permissionRows = [
    ["Developer", "Orquestracs", "Todos os clientes, suporte, bloqueios e auditoria"],
    ["Proprietario", "Cliente", "Empresa, usuarios, jornadas, ponto e relatorios"],
    ["Administrador", "Cliente", "Operacao, colaboradores, escalas e fechamento mensal"],
    ["Leitor", "Cliente", "Consulta de relatorios e espelho de ponto"],
  ];

  return (
    <>
      <Panel title="Admin Orquestracs" subtitle="Central interna do desenvolvedor">
        <div className="grid gap-3 md:grid-cols-4">
          {adminMetrics.map(([label, value, detail]) => (
            <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-4" key={label}>
              <p className="text-xs font-semibold uppercase text-[#667085]">{label}</p>
              <p className="mt-2 text-2xl font-semibold text-[#101923]">{value}</p>
              <p className="mt-1 text-xs text-[#667085]">{detail}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-[1.3fr_0.7fr]">
          <div className="rounded-md border border-[#e3e8ee] bg-white">
            <div className="border-b border-[#e3e8ee] px-4 py-3">
              <p className="text-sm font-semibold text-[#26323f]">Clientes do SaaS</p>
              <p className="mt-1 text-xs text-[#667085]">Controle comercial e operacional das empresas contratantes.</p>
            </div>
            <div className="table-scroll">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead className="bg-[#f6f8fa] text-xs uppercase text-[#667085]">
                  <tr>
                    {["Cliente", "Status", "Plano", "Mensalidade", "Vencimento", "IA"].map((head) => (
                      <th className="px-4 py-3 font-semibold" key={head}>{head}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-[#e3e8ee]">
                    {[
                      effectiveConfig.name,
                      effectiveConfig.status,
                      effectiveConfig.plan,
                      effectiveConfig.billing.amount,
                      effectiveConfig.billing.dueDate || "Nao definido",
                      `${effectiveConfig.aiCredits.balance}/${effectiveConfig.aiCredits.included}`,
                    ].map((cell, index) => (
                      <td
                        className={`px-4 py-3 ${index === 0 ? "font-semibold text-[#101923]" : "text-[#667085]"}`}
                        key={`${index}-${cell}`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-4">
            <p className="text-sm font-semibold text-[#26323f]">Contrato do cliente</p>
            <p className="mt-1 text-xs leading-5 text-[#667085]">
              Controle de plano, cobranca e bloqueio automatico apos a tolerancia.
            </p>
            <div className="mt-4 grid gap-3">
              <Field label="Cliente">
                <input className="input" defaultValue={effectiveConfig.name} placeholder="Nome do cliente" />
              </Field>
              <Field label="Status cliente">
                <select className="input" defaultValue={effectiveConfig.status}>
                  <option>Ativo</option>
                  <option>Teste</option>
                  <option>Pausado</option>
                  <option>Bloqueado</option>
                </select>
              </Field>
              <Field label="Plano">
                <select className="input" defaultValue={effectiveConfig.plan}>
                  <option>Essencial</option>
                  <option>Profissional</option>
                  <option>Enterprise</option>
                </select>
              </Field>
              <Field label="Mensalidade">
                <input className="input" defaultValue={effectiveConfig.billing.amount} placeholder="R$ 199,00" />
              </Field>
              <Field label="Vencimento">
                <input className="input" defaultValue={effectiveConfig.billing.dueDate} placeholder="10/08/2026" />
              </Field>
              <Field label="Bloqueio apos">
                <input className="input" defaultValue={String(effectiveConfig.billing.graceDays)} inputMode="numeric" placeholder="5" />
              </Field>
            </div>
          </div>
        </div>

        <ActionRow>
          <SaveButton onClick={() => onAction("Salvar configuracao Admin SaaS")}>Salvar Admin</SaveButton>
          <button className="secondary-button" disabled={syncingPortal} onClick={() => void handlePortalSync()} type="button">
            {syncingPortal ? "Sincronizando..." : "Sincronizar Central"}
          </button>
          <button className="secondary-button" onClick={() => onAction("Auditoria global")} type="button">
            Logs globais
          </button>
          <button className="secondary-button" onClick={() => onAction("Bloqueio de cliente")} type="button">
            Bloquear cliente
          </button>
        </ActionRow>
        {portalSyncMessage ? <p className="mt-3 text-sm font-semibold text-[#2d6c5d]">{portalSyncMessage}</p> : null}
      </Panel>

      <Panel title="Preparação REP-P" subtitle="Acompanhamento técnico e das providências externas">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[
            ["Registro do programa no INPI", inpiRegistration ? "Informado" : "Pendente", inpiRegistration ? "success" : "pending"],
            ["Certificado ICP-Brasil", certificateConfigured ? "Configurado" : "Pendente", certificateConfigured ? "success" : "pending"],
            ["Atestado técnico e termo", technicalStatementAttached ? "Anexado" : "Pendente", technicalStatementAttached ? "success" : "pending"],
            ["AFD, AEJ e recibos", "Prévia técnica", "review"],
          ].map(([label, value, status]) => (
            <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-4" key={label}>
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-[#26323f]">{label}</p>
                <span className={`h-2.5 w-2.5 rounded-full ${status === "success" ? "bg-[#2d6c5d]" : status === "review" ? "bg-[#d5962c]" : "bg-[#b7791f]"}`} />
              </div>
              <p className="mt-2 text-sm font-semibold text-[#101923]">{value}</p>
              <p className="mt-1 text-xs leading-5 text-[#667085]">
                {status === "success" ? "Informação registrada no cadastro do cliente." : status === "review" ? "Geração disponível para conferência; assinatura ainda não configurada." : "Ação externa ou configuração administrativa necessária."}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-md border border-[#efd9a8] bg-[#fff8e9] p-4 text-sm leading-6 text-[#6f4c0a]">
          O sistema está em pré-validação. O modo oficial depende do registro no INPI, certificado e assinaturas ICP-Brasil, documentação técnica e validação jurídica aplicável.
        </div>
        <ActionRow>
          <button className="secondary-button" disabled={checkingReadiness} onClick={() => void checkRepReadiness()} type="button">
            {checkingReadiness ? "Verificando..." : "Verificar prontidão agora"}
          </button>
        </ActionRow>
        {readinessCheck && (
          <div className={`mt-4 rounded-md border p-4 ${readinessCheck.officialReady ? "border-[#b9ddd3] bg-[#f1faf7] text-[#18594c]" : "border-[#efd9a8] bg-[#fff8e9] text-[#6f4c0a]"}`}>
            <p className="text-sm font-semibold">
              {readinessCheck.officialReady ? "Verificação concluída sem pendências." : "Ainda não está pronto para uso oficial."}
            </p>
            <p className="mt-1 text-xs leading-5">Status da assinatura: {readinessCheck.signatureStatus}.</p>
            {readinessCheck.missingFields.length > 0 && (
              <ul className="mt-3 grid gap-1 text-xs leading-5">
                {readinessCheck.missingFields.map((field) => <li key={field}>• {field}</li>)}
              </ul>
            )}
          </div>
        )}
      </Panel>

      <TwoColumn>
        <Panel title="Convites" subtitle="Entrada por convite, como no Orquestra Hub">
          <div className="grid gap-3">
            <MaskedField label="Nome" mask="name" placeholder="Nome Do Convidado" />
            <Field label="E-mail">
              <input className="input" placeholder="usuario@empresa.com" type="email" />
            </Field>
            <Field label="Cliente">
              <select className="input">
                <option>CNPJ principal</option>
                <option>Novo cliente</option>
              </select>
            </Field>
            <Field label="Perfil">
              <select className="input">
                <option>Proprietario</option>
                <option>Administrador</option>
                <option>Leitor</option>
              </select>
            </Field>
          </div>
          <ActionRow>
            <button className="primary-button" onClick={() => onAction("Convite por e-mail")} type="button">
              Gerar codigo
            </button>
            <button className="secondary-button" onClick={() => onAction("Reenviar convite")} type="button">
              Reenviar
            </button>
          </ActionRow>
          <div className="mt-5 grid gap-2">
            {invites.length ? (
              invites.map((invite) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#e3e8ee] bg-[#fbfcfd] px-3 py-3"
                  key={invite.code}
                >
                  <div>
                    <strong className="text-sm text-[#101923]">{invite.code}</strong>
                    <p className="mt-1 text-xs text-[#667085]">
                      {invite.companyName} - {invite.role} - {invite.status} - validade de 7 dias
                    </p>
                  </div>
                  <button
                    className="mini-button"
                    onClick={() => navigator.clipboard.writeText(invite.code)}
                    type="button"
                  >
                    Copiar
                  </button>
                </div>
              ))
            ) : (
              <p className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] px-3 py-3 text-sm text-[#667085]">
                Nenhum convite gerado ainda.
              </p>
            )}
          </div>
        </Panel>

        <Panel title="Creditos do agente IA" subtitle="Cota por cliente e por plano">
          <div className="grid gap-3">
            <Field label="Creditos mensais">
              <input className="input" defaultValue={String(effectiveConfig.aiCredits.included)} inputMode="numeric" placeholder="150" />
            </Field>
            <Field label="Creditos disponiveis">
              <input className="input" defaultValue={String(effectiveConfig.aiCredits.balance)} inputMode="numeric" placeholder="150" />
            </Field>
            <Field label="Creditos usados">
              <input className="input" defaultValue={String(effectiveConfig.aiCredits.used)} inputMode="numeric" placeholder="0" />
            </Field>
            <Field label="Limite funcionarios">
              <input className="input" defaultValue={String(effectiveConfig.employeeLimit)} inputMode="numeric" placeholder="25" />
            </Field>
            <Field label="Status pagamento">
              <select className="input" defaultValue={effectiveConfig.billing.status}>
                <option>Em dia</option>
                <option>Teste</option>
                <option>Inadimplente</option>
                <option>Bloqueado</option>
              </select>
            </Field>
            <Field label="Status IA">
              <select className="input" defaultValue={effectiveConfig.aiCredits.status}>
                <option>Ativo</option>
                <option>Bloqueado</option>
              </select>
            </Field>
          </div>
          <div className="mt-4 rounded-md border border-[#d9e0e7] bg-[#fbfcfd] p-4">
            <p className="text-sm font-semibold text-[#26323f]">Assistente interno</p>
            <p className="mt-1 text-xs leading-5 text-[#667085]">
              Ajuda guiada por tela, consumo de IA, historico e bloqueio por cota entram nesta camada.
            </p>
          </div>
        </Panel>
      </TwoColumn>

      <Panel title="Permissoes" subtitle="Matriz base para Auth, Firestore Rules e telas">
        <div className="grid gap-3 md:grid-cols-4">
          {permissionRows.map(([profile, scope, description]) => (
            <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-4" key={profile}>
              <p className="text-sm font-semibold text-[#101923]">{profile}</p>
              <p className="mt-1 text-xs font-semibold uppercase text-[#18594c]">{scope}</p>
              <p className="mt-2 text-xs leading-5 text-[#667085]">{description}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Governanca" subtitle="Base comercial, suporte e seguranca">
        <div className="grid gap-3 md:grid-cols-3">
          {[
            ["Clientes", "Ativar, pausar, cancelar e acompanhar limite contratado."],
            ["Auditoria", "Logs globais para suporte sem alterar batidas originais."],
            ["Cobranca", "Plano, funcionarios ativos, vencimento e recorrencia."],
          ].map(([title, text]) => (
            <div className="rounded-md border border-[#e3e8ee] bg-white p-4" key={title}>
              <p className="text-sm font-semibold text-[#26323f]">{title}</p>
              <p className="mt-1 text-xs leading-5 text-[#667085]">{text}</p>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}

function AssistantPanel({
  active,
  config,
  onClose,
  onConsumeCredit,
  onNavigate,
}: {
  active: Section;
  config: TenantSaasConfig | null;
  onClose: () => void;
  onConsumeCredit: () => Promise<void>;
  onNavigate: (section: Section) => void;
}) {
  const activeCompanyId = useActiveCompanyId();
  const help: Record<Section, { title: string; steps: string[]; questions: string[] }> = {
    Painel: {
      title: "Visao geral do sistema",
      steps: [
        "Acompanhe colaboradores, horas previstas, horas trabalhadas e saldo do banco.",
        "Use Nova batida para abrir a sala de ponto.",
        "Use Exportar relatorio para ir direto aos relatorios.",
      ],
      questions: ["Como vejo atrasos?", "Como confiro banco de horas?", "Como gero relatorio?"],
    },
    Empresa: {
      title: "Cadastro da empresa",
      steps: [
        "Cadastre razao social, CNPJ, responsavel e contato.",
        "Depois cadastre uma ou mais escalas coletivas da empresa.",
        "A empresa pode convidar proprietario, administrador e leitor.",
      ],
      questions: ["Como cadastrar escala?", "Quem deve ser proprietario?", "Posso trocar o CNPJ?"],
    },
    Colaboradores: {
      title: "Cadastro de funcionarios",
      steps: [
        "Preencha nome, CPF, admissao, celular, cargo, departamento e PIN.",
        "Escolha se o funcionario usa jornada coletiva ou jornada individual.",
        "Depois cadastre o Face ID com foto e consentimento.",
      ],
      questions: ["Quando usar jornada individual?", "Como cadastrar Face ID?", "Para que serve o PIN?"],
    },
    "Sala de ponto": {
      title: "Tablet da sala de ponto",
      steps: [
        "Deixe esta tela aberta no tablet da sala de ponto.",
        "O funcionario fica em frente a camera para o Face ID identificar.",
        "Se o reconhecimento falhar, use PIN + foto como contingencia.",
      ],
      questions: ["Como confirmar presenca?", "Quando usar PIN + foto?", "O que fica registrado?"],
    },
    "Ponto externo": {
      title: "Ponto externo pelo celular",
      steps: [
        "O administrador autoriza o ponto externo no cadastro do colaborador.",
        "O colaborador informa o PIN e faz o reconhecimento facial no celular.",
        "O sistema registra horario, aparelho, foto, localizacao e motivo como evidencias.",
      ],
      questions: ["Quem pode usar?", "E se o GPS falhar?", "O que fica registrado?"],
    },
    Batidas: {
      title: "Sala de ponto",
      steps: [
        "O tablet fica com a camera ativa na sala de ponto.",
        "O funcionario se posiciona na frente da camera para reconhecimento facial.",
        "Se identificado, o sistema registra a batida correta com evidencia.",
      ],
      questions: ["E se o rosto nao reconhecer?", "Como ajustar batida?", "O que fica salvo?"],
    },
    "Banco de horas": {
      title: "Banco de horas",
      steps: [
        "Confira saldo positivo ou negativo por funcionario.",
        "Analise faltantes, extras, abonos e ocorrencias.",
        "Feche o periodo apenas depois da conferencia.",
      ],
      questions: ["Como abonar horas?", "Como fechar periodo?", "Como ver saldo individual?"],
    },
    "Fechamento mensal": {
      title: "Fechamento mensal",
      steps: [
        "Escolha mes, ano e responsavel pela conferencia.",
        "Confira faltas, atrasos, banco de horas, ajustes e observacoes.",
        "Gere a folha do contador e a ficha individual para ciencia do funcionario.",
      ],
      questions: ["O que enviar ao contador?", "Quando fechar o mes?", "Como gerar ficha individual?"],
    },
    Relatorios: {
      title: "Relatorios",
      steps: [
        "Gere relatorio geral com todos os funcionarios.",
        "Gere relatorio individual por colaborador e periodo.",
        "Use o modelo de jornada detalhada para conferencia e assinatura.",
      ],
      questions: ["Como gerar PDF?", "Tem relatorio geral?", "Tem relatorio individual?"],
    },
    "LGPD e auditoria": {
      title: "LGPD e auditoria",
      steps: [
        "Colete consentimento antes da biometria.",
        "Mantenha alternativa por PIN + foto em caso de falha facial.",
        "Nao edite batida original; crie ajuste rastreado.",
      ],
      questions: ["Biometria pode?", "Como funciona log inviolavel?", "Precisa termo?"],
    },
    Configuracoes: {
      title: "Metodos de identificacao",
      steps: [
        "Escolha a preferencia futura entre Face ID, digital e PIN + foto.",
        "A selecao de um leitor e apenas avaliacao; nao ativa o equipamento.",
        "A digital so podera entrar no quiosque depois de um teste de hardware e revisao de seguranca e privacidade.",
      ],
      questions: ["Quais leitores foram avaliados?", "A digital ja esta ativa?", "Como manter o PIN como alternativa?"],
    },
    Admin: {
      title: "Admin Orquestracs",
      steps: [
        "Use esta area para controle interno da plataforma.",
        "Gerencie convites, usuarios e permissoes do CNPJ ativo.",
        "Separe perfis: proprietario, administrador, leitor e desenvolvedor.",
      ],
      questions: ["Como convidar usuario?", "Quem tem acesso total?", "O leitor pode editar?"],
    },
  };

  const current = help[active];
  const aiCredits = config?.aiCredits || { balance: 0, included: 0, status: "Bloqueado", used: 0 };
  const creditsBlocked = aiCredits.status === "Bloqueado" || aiCredits.balance <= 0;
  const [selectedQuestion, setSelectedQuestion] = useState(current.questions[0]);
  const [assistantMessage, setAssistantMessage] = useState("");
  const visibleQuestion = current.questions.includes(selectedQuestion) ? selectedQuestion : current.questions[0];

  async function selectQuestion(question: string) {
    if (creditsBlocked) {
      setAssistantMessage("Creditos IA esgotados ou bloqueados. Ajuste a cota na aba Admin.");
      return;
    }

    try {
      await onConsumeCredit();
      setSelectedQuestion(question);
      setAssistantMessage("1 credito IA consumido nesta pergunta.");
    } catch (error) {
      console.error(error);
      setAssistantMessage("Nao foi possivel consumir credito IA. Verifique a cota na Admin.");
    }
  }

  function openPortalPurchase(packageId: string, credits: number) {
    try {
      const paymentsUrl = process.env.NEXT_PUBLIC_ORQUESTRA_PORTAL_PAYMENTS_URL || "https://portal.orquestracs.com/pagamentos";
      const url = new URL(paymentsUrl);
      url.searchParams.set("sourceSystem", "orquestracs_face_id");
      url.searchParams.set("product", "ai_credits");
      url.searchParams.set("packageId", packageId);
      url.searchParams.set("credits", String(credits));
      url.searchParams.set("externalCustomerId", config?.tenantId || activeCompanyId);
      url.searchParams.set("returnUrl", window.location.href);
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    } catch {
      setAssistantMessage("O endereço do Portal ainda não está configurado.");
    }
  }

  return (
    <div className="assistant-shell">
      <div className="assistant-backdrop" onClick={onClose} />
      <aside className="assistant-panel">
        <div className="flex items-start justify-between gap-4 border-b border-[#e3e8ee] p-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#2d6c5d]">
              Assistente Face ID
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[#101923]">{current.title}</h2>
            <p className="mt-2 text-xs font-semibold text-[#667085]">
              Creditos IA: {aiCredits.balance}/{aiCredits.included} disponiveis
            </p>
          </div>
          <button className="mini-button" onClick={onClose} type="button">Fechar</button>
        </div>

        <section className="border-b border-[#e3e8ee] bg-[#fbfcfd] p-5">
          <p className="text-sm font-semibold text-[#26323f]">Comprar créditos no Portal</p>
          <p className="mt-1 text-xs leading-5 text-[#667085]">A cobrança e o valor são calculados pelo Portal Orquestra.cs.</p>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[["ai-100", 100], ["ai-300", 300], ["ai-1000", 1000]].map(([packageId, credits]) => (
              <button className="mini-button" key={packageId} onClick={() => openPortalPurchase(String(packageId), Number(credits))} type="button">
                {credits} · Comprar
              </button>
            ))}
          </div>
        </section>

        <div className="grid gap-5 p-5">
          <section>
            <p className="text-sm font-semibold text-[#26323f]">Passo a passo desta tela</p>
            <div className="mt-3 grid gap-2">
              {current.steps.map((step, index) => (
                <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3 text-sm leading-6 text-[#52616f]" key={step}>
                  <strong className="mr-2 text-[#18594c]">{index + 1}.</strong>
                  {step}
                </div>
              ))}
            </div>
          </section>

          <section>
            <p className="text-sm font-semibold text-[#26323f]">Perguntas rapidas</p>
            <div className="mt-3 grid gap-2">
              {current.questions.map((question) => (
                <button
                  className="rounded-md border border-[#d9e0e7] bg-white px-3 py-2 text-left text-sm font-semibold text-[#26323f] hover:border-[#18594c] hover:text-[#18594c] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={creditsBlocked}
                  key={question}
                  onClick={() => void selectQuestion(question)}
                  type="button"
                >
                  {question}
                </button>
              ))}
            </div>
            {assistantMessage && (
              <p className="mt-3 rounded-md border border-[#efd9a8] bg-[#fff8e9] p-3 text-sm font-semibold text-[#8a5a00]">
                {assistantMessage}
              </p>
            )}
            <div className="mt-3 rounded-md border border-[#cfe3dc] bg-[#f1faf7] p-3 text-sm leading-6 text-[#24594d]">
              <p className="font-semibold">{visibleQuestion}</p>
              <p className="mt-1">
                Siga o passo a passo desta tela. Quando a integracao real estiver
                conectada, o assistente tambem podera abrir o modulo certo e validar
                os dados preenchidos.
              </p>
            </div>
          </section>

          <section>
            <p className="text-sm font-semibold text-[#26323f]">Atalhos guiados</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {(["Empresa", "Colaboradores", "Sala de ponto", "Relatorios"] as Section[]).map((section) => (
                <button
                  className="secondary-button"
                  key={section}
                  onClick={() => onNavigate(section)}
                  type="button"
                >
                  {section}
                </button>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

function EmployeesTable({
  canEdit = true,
  embedded = false,
  employeesList = employees,
  onAction,
  onEdit,
  onNew,
  onView,
  photoUrls = {},
  compact = false,
}: {
  canEdit?: boolean;
  embedded?: boolean;
  employeesList?: EmployeeRow[];
  onAction: (action: string) => void;
  onEdit?: (employee: EmployeeRow) => void;
  onNew?: () => void;
  onView?: (employee: EmployeeRow) => void;
  photoUrls?: Record<string, string>;
  compact?: boolean;
}) {
  const tableContent = (
    <>
      {!compact && (
        <div className="flex flex-col gap-3 border-b border-[#e3e8ee] p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium text-[#667085]">Equipe</p>
            <h2 className="mt-1 text-xl font-semibold text-[#101923]">Colaboradores e banco de horas</h2>
          </div>
          {canEdit && (
            <button className="secondary-button w-fit" onClick={() => (onNew ? onNew() : onAction("Novo colaborador"))} type="button">Novo colaborador</button>
          )}
        </div>
      )}
      <div className="table-scroll hidden lg:block">
        <table className="w-full min-w-[1040px] border-collapse text-left text-sm">
          <thead className="bg-[#f8fafb] text-xs uppercase text-[#667085]">
            <tr>
              <th className="px-5 py-3 font-semibold">Funcionario</th>
              <th className="px-5 py-3 font-semibold">CPF</th>
              <th className="px-5 py-3 font-semibold">Cargo</th>
              <th className="px-5 py-3 font-semibold">Admissao</th>
              <th className="px-5 py-3 font-semibold">CBO</th>
              <th className="px-5 py-3 font-semibold">Turno</th>
              <th className="px-5 py-3 font-semibold">Banco</th>
              <th className="px-5 py-3 font-semibold">Status</th>
              <th className="px-5 py-3 font-semibold">Acoes</th>
            </tr>
          </thead>
          <tbody>
            {employeesList.length === 0 ? (
              <tr>
                <td className="px-5 py-8 text-center text-[#667085]" colSpan={9}>
                  Nenhum colaborador cadastrado ainda.
                </td>
              </tr>
            ) : (
              employeesList.map((employee) => (
                <tr className="border-t border-[#e3e8ee]" key={employee.employeeId || employee.name}>
                  <td className="px-5 py-4 font-semibold text-[#101923]">
                    <div className="flex items-center gap-3">
                      {employee.employeeId && photoUrls[employee.employeeId] ? (
                        <img
                          alt={`Foto de ${employee.name}`}
                          className="h-9 w-9 rounded-md border border-[#d9e0e7] object-cover"
                          src={photoUrls[employee.employeeId]}
                        />
                      ) : (
                        <span className="grid h-9 w-9 place-items-center rounded-md border border-[#d9e0e7] bg-[#fbfcfd] text-xs font-bold text-[#18594c]">
                          {employee.name.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span>{employee.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-[#667085]">{employee.cpf}</td>
                  <td className="px-5 py-4 text-[#667085]">{employee.role}</td>
                  <td className="px-5 py-4 text-[#667085]">{employee.admissionDate || "-"}</td>
                  <td className="px-5 py-4 text-[#667085]">{employee.cbo || "-"}</td>
                  <td className="px-5 py-4 text-[#667085]">{employee.shift}</td>
                  <td className="px-5 py-4 font-semibold text-[#101923]">{employee.bank}</td>
                  <td className="px-5 py-4">
                    <span className="rounded-full border border-[#d8e1ff] bg-[#f2f5ff] px-3 py-1 text-xs font-semibold text-[#3446a3]">
                      {employee.faceIdStatus === "registered"
                        ? "Face ID cadastrado"
                        : employee.pinConfigured
                          ? "PIN pronto - Face ID pendente"
                          : employee.status}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                  <div className="flex gap-2">
                    {canEdit && (
                      <button className="mini-button" onClick={() => (onEdit ? onEdit(employee) : onAction(`Editar ${employee.name}`))} type="button">Editar</button>
                    )}
                    <button className="mini-button" onClick={() => (onView ? onView(employee) : onAction(`Ver ${employee.name}`))} type="button">Ver</button>
                  </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 p-4 lg:hidden">
        {employeesList.length === 0 ? (
          <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-4 text-center text-sm text-[#667085]">
            Nenhum colaborador cadastrado ainda.
          </div>
        ) : (
          employeesList.map((employee) => (
            <article className="min-w-0 rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={`mobile-employee-${employee.employeeId || employee.name}`}>
              <div className="flex min-w-0 items-start gap-3">
                {employee.employeeId && photoUrls[employee.employeeId] ? (
                  <img
                    alt={`Foto de ${employee.name}`}
                    className="h-11 w-11 shrink-0 rounded-md border border-[#d9e0e7] object-cover"
                    src={photoUrls[employee.employeeId]}
                  />
                ) : (
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-[#d9e0e7] bg-white text-sm font-bold text-[#18594c]">
                    {employee.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-semibold text-[#101923]">{employee.name}</p>
                  <p className="mt-1 break-words text-xs text-[#667085]">{employee.role} · {employee.shift}</p>
                  <span className="mt-2 inline-flex max-w-full rounded-full border border-[#d8e1ff] bg-[#f2f5ff] px-2.5 py-1 text-[11px] font-semibold leading-4 text-[#3446a3]">
                    {employee.faceIdStatus === "registered"
                      ? "Face ID cadastrado"
                      : employee.pinConfigured
                        ? "PIN pronto - Face ID pendente"
                        : employee.status}
                  </span>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                {[
                  ["CPF", employee.cpf],
                  ["Admissão", employee.admissionDate || "-"],
                  ["CBO", employee.cbo || "-"],
                  ["Banco", employee.bank],
                ].map(([label, value]) => (
                  <div className="min-w-0 rounded-md border border-[#e3e8ee] bg-white px-2.5 py-2" key={label}>
                    <p className="text-[10px] font-semibold uppercase text-[#667085]">{label}</p>
                    <p className="mt-1 break-words font-semibold text-[#26323f]">{value}</p>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {canEdit && (
                  <button className="mini-button flex-1" onClick={() => (onEdit ? onEdit(employee) : onAction(`Editar ${employee.name}`))} type="button">Editar</button>
                )}
                <button className="mini-button flex-1" onClick={() => (onView ? onView(employee) : onAction(`Ver ${employee.name}`))} type="button">Ver</button>
              </div>
            </article>
          ))
        )}
      </div>
    </>
  );

  if (embedded) {
    return <div className="app-table-shell min-w-0 overflow-hidden">{tableContent}</div>;
  }

  return (
    <section className="app-table-shell min-w-0">
      {tableContent}
    </section>
  );
}

function ReportPreview({
  employees,
  endDate,
  loading,
  punches,
  selectedEmployeeId,
  startDate,
}: {
  employees: LocalEmployee[];
  endDate: string;
  loading: boolean;
  punches: Punch[];
  selectedEmployeeId: string;
  startDate: string;
}) {
  const reportEmployees = selectedEmployeeId === "all"
    ? employees
    : employees.filter((employee) => employee.employeeId === selectedEmployeeId);
  const reportPeriodCount = Math.max(2, ...reportEmployees.map((employee) => getSchedulePeriods(employee.schedule).length));
  const reportStages = scheduledPunchOrder.slice(0, reportPeriodCount * 2);
  const journeyLabels = ["Data", "Dia", ...reportStages, "Trabalhadas", "Banco/Falta", "Ocorrência"];
  const selectedEmployeeName = selectedEmployeeId === "all"
    ? "Todos os colaboradores"
    : employees.find((employee) => employee.employeeId === selectedEmployeeId)?.name || "Colaborador não encontrado";
  const employeeNames = useMemo(
    () => new Map(employees.map((employee) => [employee.employeeId, employee.name])),
    [employees],
  );
  const localDateKey = (date: Date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  const journeyRows = useMemo(() => {
    const grouped = new Map<string, Punch[]>();
    punches.forEach((punch) => {
      const dateKey = localDateKey(punchDate(punch));
      const key = `${punch.employeeId}|${dateKey}`;
      grouped.set(key, [...(grouped.get(key) || []), punch]);
    });

    return [...grouped.entries()]
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, dayPunches]) => {
        const [employeeId, dateKey] = key.split("|");
        const date = new Date(`${dateKey}T12:00:00`);
        const ordered = dayPunches.sort((first, second) => punchDate(first).getTime() - punchDate(second).getTime());
        const employee = employees.find((item) => item.employeeId === employeeId);
        const periods = getSchedulePeriods(employee?.schedule);
        const matchedStages = reportStages.map((stage) => ordered.find((punch) =>
          scheduledStageForPunch(punch, employee?.schedule || { start: "07:00", breakStart: "11:30", breakEnd: "13:00", end: "17:15", toleranceMinutes: 10 }) === stage,
        ));
        const workedMinutes = periods.reduce((total, _period, index) => {
          const entry = matchedStages[index * 2];
          const exit = matchedStages[index * 2 + 1];
          return total + (entry && exit
            ? Math.max(0, Math.round((punchDate(exit).getTime() - punchDate(entry).getTime()) / 60000))
            : 0);
        }, 0);
        const workedLabel = workedMinutes ? `${String(Math.floor(workedMinutes / 60)).padStart(2, "0")}:${String(workedMinutes % 60).padStart(2, "0")}` : "--";
        const statuses = [...new Set(ordered.map((punch) => formatPunchStatus(punch.status)))];
        const bankOrMissing = ordered.some((punch) => punch.status === "bank_hours")
          ? "Hora extra"
          : matchedStages.filter(Boolean).length < periods.length * 2
            ? `${periods.length * 2 - matchedStages.filter(Boolean).length} pendente(s)`
            : "Regular";
        return [
          date.toLocaleDateString("pt-BR"),
          `${employeeNames.get(employeeId) || "Colaborador"} · ${date.toLocaleDateString("pt-BR", { weekday: "short" })}`,
          ...matchedStages.map((punch) => punch ? formatPunchTime(punch) : "--"),
          workedLabel,
          bankOrMissing,
          statuses.join(", ") || "Sem ocorrência",
        ];
      });
  }, [employeeNames, employees, punches, reportStages]);
  const attentionCount = punches.filter((punch) => punch.status !== "on_time").length;
  const employeeCount = new Set(punches.map((punch) => punch.employeeId)).size;
  const formatReportDate = (value: string) => value
    ? new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR")
    : "data não informada";
  const displayPeriod = `${formatReportDate(startDate)} - ${formatReportDate(endDate)}`;

  return (
    <section className="app-table-shell min-w-0">
      <div className="grid gap-3 border-b border-[#e3e8ee] p-5 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <p className="text-sm font-medium text-[#667085]">Relatório de jornada detalhada</p>
          <h2 className="mt-1 text-xl font-semibold text-[#101923]">Período {displayPeriod}</h2>
        </div>
        <div className="grid gap-1 text-sm text-[#667085] lg:text-right">
          <span>Colaborador: {selectedEmployeeName}</span>
          <span>{loading ? "Atualizando dados..." : `${punches.length} registro(s) encontrado(s)`}</span>
        </div>
      </div>

      <div className="grid gap-3 p-5 md:grid-cols-4">
        {[
          ["Registros", String(punches.length)],
          ["Jornadas", String(journeyRows.length)],
          ["Colaboradores", String(employeeCount)],
          ["Ocorrências", String(attentionCount)],
        ].map(([label, value]) => (
          <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={label}>
            <p className="text-xs font-semibold uppercase text-[#667085]">{label}</p>
            <strong className="mt-2 block text-lg text-[#101923]">{value}</strong>
          </div>
        ))}
      </div>

      <div className="table-scroll hidden px-5 pb-5 lg:block">
        <table className="w-full min-w-[840px] border-collapse text-left text-sm">
          <thead className="bg-[#101923] text-xs uppercase text-white">
            <tr>
              {journeyLabels.map((head, index) => (
                <th className="px-3 py-3 font-semibold" key={`${head}-${index}`}>{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {journeyRows.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-[#667085]" colSpan={journeyLabels.length}>
                  Nenhuma jornada registrada para o periodo.
                </td>
              </tr>
            ) : (
              journeyRows.map((row) => (
                <tr className="border-b border-[#e3e8ee]" key={`${row[0]}-${row[1]}`}>
                  {row.map((cell, index) => (
                    <td className={`px-3 py-3 ${index >= 6 ? "font-semibold text-[#26323f]" : "text-[#667085]"}`} key={`${row[0]}-${cell}-${index}`}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 px-5 pb-5 lg:hidden">
        {journeyRows.length === 0 ? (
          <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-4 text-center text-sm text-[#667085]">
            Nenhuma jornada registrada para o período.
          </div>
        ) : (
          journeyRows.map((row) => (
            <article className="min-w-0 rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={`mobile-report-${row[0]}-${row[1]}`}>
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[#e3e8ee] pb-2">
                <div>
                  <p className="text-xs font-semibold uppercase text-[#667085]">{journeyLabels[0]}</p>
                  <p className="mt-1 text-sm font-semibold text-[#101923]">{row[0]}</p>
                </div>
                <span className="rounded-md border border-[#d9e0e7] bg-white px-2 py-1 text-xs font-semibold text-[#667085]">{row[1]}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                {row.slice(2).map((cell, index) => (
                  <div className="min-w-0 rounded-md border border-[#e3e8ee] bg-white px-2.5 py-2" key={`${journeyLabels[index + 2]}-${cell}`}>
                    <p className="text-[10px] font-semibold uppercase text-[#667085]">{journeyLabels[index + 2]}</p>
                    <p className={`mt-1 break-words ${index >= 4 ? "font-semibold text-[#26323f]" : "text-[#667085]"}`}>{cell}</p>
                  </div>
                ))}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function CollapsiblePanel({
  children,
  isOpen,
  onToggle,
  subtitle,
  title,
}: {
  children: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  subtitle: string;
  title: string;
}) {
  return (
    <section className="app-panel overflow-hidden">
      <button
        aria-expanded={isOpen}
        className="app-panel-toggle flex w-full items-center justify-between gap-4 text-left transition"
        onClick={onToggle}
        type="button"
      >
        <span>
          <span className="app-panel-kicker">{subtitle}</span>
          <span className="app-panel-title">{title}</span>
        </span>
        <span className="app-panel-toggle-icon">
          {isOpen ? "-" : "+"}
        </span>
      </button>
      {isOpen && <div className="app-panel-body">{children}</div>}
    </section>
  );
}

function Panel({
  children,
  subtitle,
  title,
}: {
  children: React.ReactNode;
  subtitle: string;
  title: string;
}) {
  return (
    <section className="app-panel min-w-0">
      <div className="app-panel-heading">
        <p className="app-panel-kicker">{subtitle}</p>
        <h2 className="app-panel-title">{title}</h2>
      </div>
      <div className="app-panel-body">{children}</div>
    </section>
  );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <label className="app-field">
      {label}
      {children}
    </label>
  );
}

function MaskedField({
  label,
  mask,
  onChange,
  placeholder,
  value: controlledValue,
}: {
  label: string;
  mask: MaskType;
  onChange?: (value: string) => void;
  placeholder: string;
  value?: string;
}) {
  const [internalValue, setInternalValue] = useState(controlledValue || "");
  const value = onChange && controlledValue !== undefined ? controlledValue : internalValue;

  useEffect(() => {
    if (onChange || controlledValue === undefined) return undefined;

    const syncId = window.setTimeout(() => setInternalValue(controlledValue), 0);
    return () => window.clearTimeout(syncId);
  }, [controlledValue, onChange]);

  return (
    <Field label={label}>
      <input
        className="input"
        onChange={(event) => {
          const nextValue = applyMask(event.target.value, mask);
          if (!onChange) setInternalValue(nextValue);
          onChange?.(nextValue);
        }}
        placeholder={placeholder}
        value={value}
      />
    </Field>
  );
}

function JourneySummary({
  breakEnd,
  breakStart,
  days,
  end,
  start,
}: {
  breakEnd: string;
  breakStart: string;
  days: number;
  end: string;
  start: string;
}) {
  const alert = getJourneyAlert({ breakEnd, breakStart, days, end, start });
  const toneClass = {
    attention: "journey-alert-attention",
    critical: "journey-alert-critical",
    ok: "journey-alert-ok",
    warning: "journey-alert-warning",
  }[alert.tone];

  return (
    <div className={`journey-alert ${toneClass}`}>
      <p className="text-xs font-semibold uppercase">Carga calculada</p>
      <strong className="mt-2 block text-xl">
        {calculateWeeklyHours({ breakEnd, breakStart, days, end, start })}
      </strong>
      <p className="mt-3 text-sm font-semibold">{alert.title}</p>
      <p className="mt-1 text-xs leading-5">{alert.message}</p>
    </div>
  );
}

function TimeStepper({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <Field label={label}>
      <input
        className="input"
        onChange={(event) => onChange(maskTime(event.target.value))}
        placeholder="00:00"
        type="time"
        value={value}
      />
    </Field>
  );
}

function mapPunchType(kind: string): PunchType {
  const normalized = kind.toLowerCase();
  const scheduledStage = /^(entrada|sa[ií]da)\s+([1-4])$/i.exec(kind.trim());
  if (scheduledStage) {
    const [, direction, stageNumber] = scheduledStage;
    if (direction.toLowerCase() === "entrada") {
      return stageNumber === "2" ? "lunch_back" : "entry";
    }
    return stageNumber === "1" ? "lunch_out" : "exit";
  }
  if (normalized.includes("intervalo") || normalized.includes("almoco") || normalized.includes("almoço")) return "lunch_out";
  if (normalized.includes("retorno") || normalized.includes("volta")) return "lunch_back";
  if (normalized.includes("saida") || normalized.includes("saída")) return "exit";
  return "entry";
}

function punchDate(punch: Punch) {
  const value = punch.occurredAt as unknown;
  if (value instanceof Date) return value;
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate() as Date;
  }
  return new Date(String(value));
}

function formatUnknownDateTime(value: unknown) {
  if (value instanceof Date) return value.toLocaleString("pt-BR");
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).toLocaleString("pt-BR");
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "Horario indisponivel" : date.toLocaleString("pt-BR");
}

function formatPunchDateTime(punch: Punch) {
  const date = punchDate(punch);
  if (Number.isNaN(date.getTime())) return "Horario indisponivel";
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatPunchTime(punch: Punch) {
  const date = punchDate(punch);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatPunchType(type: PunchType) {
  const labels: Record<PunchType, string> = {
    entry: "Entrada",
    exit: "Saida",
    lunch_back: "Entrada",
    lunch_out: "Saida",
  };
  return labels[type];
}

function formatPunchStatus(status: PunchStatus) {
  const labels: Record<PunchStatus, string> = {
    early: "Adiantado",
    external_work: "Trabalho externo",
    late: "Atraso",
    bank_hours: "Banco de horas",
    on_time: "No horario",
    outside_shift: "Fora da jornada",
    possible_forgotten: "Possivel esquecimento",
  };
  return labels[status];
}

function getMonthPeriod(year: number, month: number): MonthPeriod {
  const start = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  const end = isCurrentMonth
    ? new Date(Math.min(monthEnd.getTime(), new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999).getTime()))
    : monthEnd;
  const label = start.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  return { end, label, month, start, year };
}

function dateTimeFromInputs(dateValue: string, timeValue: string) {
  const [inputYear, inputMonth, inputDay] = dateValue.split("-").map(Number);
  const [inputHour, inputMinute] = timeValue.split(":").map(Number);
  if (![inputYear, inputMonth, inputDay, inputHour, inputMinute].every(Number.isFinite)) return null;

  const date = new Date(inputYear, inputMonth - 1, inputDay, inputHour, inputMinute, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameDay(first: Date, second: Date) {
  return first.getFullYear() === second.getFullYear()
    && first.getMonth() === second.getMonth()
    && first.getDate() === second.getDate();
}

function getCompanyWorkPolicy(company: MainCompanyProfile | null): WorkPolicy {
  const policy = (company?.workPolicy || {}) as Partial<WorkPolicy>;
  return {
    ...DEFAULT_WORK_POLICY,
    ...policy,
    afternoonAbsenceWeight: Number(policy.afternoonAbsenceWeight ?? DEFAULT_WORK_POLICY.afternoonAbsenceWeight),
    fullDayAbsenceWeight: Number(policy.fullDayAbsenceWeight ?? DEFAULT_WORK_POLICY.fullDayAbsenceWeight),
    morningAbsenceWeight: Number(policy.morningAbsenceWeight ?? DEFAULT_WORK_POLICY.morningAbsenceWeight),
    scheduledDays: Number(policy.scheduledDays ?? DEFAULT_WORK_POLICY.scheduledDays),
    toleranceMinutes: Number(policy.toleranceMinutes ?? DEFAULT_WORK_POLICY.toleranceMinutes),
  };
}

function positiveDifference(actual?: Punch, expectedTime?: string, toleranceMinutes = 0) {
  if (!actual || !expectedTime) return 0;
  const date = punchDate(actual);
  if (Number.isNaN(date.getTime())) return 0;
  const actualMinutes = date.getHours() * 60 + date.getMinutes();
  return Math.max(0, actualMinutes - minutesFromTime(expectedTime) - toleranceMinutes);
}

function earlyDifference(actual?: Punch, expectedTime?: string, toleranceMinutes = 0) {
  if (!actual || !expectedTime) return 0;
  const date = punchDate(actual);
  if (Number.isNaN(date.getTime())) return 0;
  const actualMinutes = date.getHours() * 60 + date.getMinutes();
  return Math.max(0, minutesFromTime(expectedTime) - actualMinutes - toleranceMinutes);
}

function workedPeriodMinutes(start?: Punch, end?: Punch) {
  if (!start || !end) return 0;
  const startDate = punchDate(start);
  const endDate = punchDate(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 60000));
}

function expectedDailyMinutes(employee: LocalEmployee) {
  return getSchedulePeriods(employee.schedule).reduce(
    (total, period) => total + Math.max(0, minutesFromTime(period.end) - minutesFromTime(period.start)),
    0,
  );
}

function localDateKey(date: Date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function hasApprovedAbsenceJustification(
  justifications: AttendanceJustification[],
  employeeId: string,
  date: Date,
  period: "morning" | "afternoon",
) {
  return justifications.some((justification) =>
    justification.employeeId === employeeId
    && justification.date === localDateKey(date)
    && justification.status === "approved"
    && justification.type !== "late_justification"
    && (justification.period === period || justification.period === "full_day"),
  );
}

function hasApprovedLateJustification(
  justifications: AttendanceJustification[],
  employeeId: string,
  date: Date,
  period: "morning" | "afternoon",
) {
  return justifications.some((justification) =>
    justification.employeeId === employeeId
    && justification.date === localDateKey(date)
    && justification.status === "approved"
    && justification.type === "late_justification"
    && (justification.period === period || justification.period === "full_day"),
  );
}

function buildMonthlyMirrorSummary(
  employee: LocalEmployee,
  punches: Punch[],
  period: MonthPeriod,
  workPolicy: WorkPolicy,
  justifications: AttendanceJustification[] = [],
  bankAdjustments: BankHoursAdjustment[] = [],
): MonthlyMirrorSummary {
  const validPunches = punches
    .filter((punch) => {
      const date = punchDate(punch);
      return date >= period.start && date <= period.end;
    })
    .sort((first, second) => punchDate(first).getTime() - punchDate(second).getTime());
  const rows: MonthlyMirrorRow[] = [];
  const expectedMinutes = expectedDailyMinutes(employee);
  const scheduledWorkdays = workPolicy.scheduledDays;

  for (let day = 1; day <= period.end.getDate(); day += 1) {
    const date = new Date(period.year, period.month - 1, day);
    const dayPunches = validPunches.filter((punch) => sameDay(punchDate(punch), date));
    const periods = getSchedulePeriods(employee.schedule);
    const scheduledPunches: Partial<Record<ScheduledPunch, Punch>> = {};
    dayPunches.forEach((punch) => {
      const stage = scheduledStageForPunch(punch, employee.schedule);
      if (stage) scheduledPunches[stage] = punch;
    });
    const periodPunchCounts = periods.map((_, index) => [
      scheduledPunches[`Entrada ${index + 1}` as ScheduledPunch],
      scheduledPunches[`Saída ${index + 1}` as ScheduledPunch],
    ].filter(Boolean).length);

    const isWorkday = date.getDay() !== 0 && date.getDay() <= scheduledWorkdays;
    const morningPunches = periodPunchCounts[0] || 0;
    const afternoonPunches = periodPunchCounts.slice(1).reduce((total, count) => total + count, 0);
    const justifiedMorning = hasApprovedAbsenceJustification(justifications, employee.employeeId, date, "morning");
    const justifiedAfternoon = hasApprovedAbsenceJustification(justifications, employee.employeeId, date, "afternoon");
    const rawMissingMorning = isWorkday && morningPunches === 0;
    const rawMissingAfternoon = isWorkday && periods.length > 1 && afternoonPunches === 0;
    const missingMorning = rawMissingMorning && !justifiedMorning;
    const missingAfternoon = rawMissingAfternoon && !justifiedAfternoon;
    const incompleteMorning = isWorkday && morningPunches === 1 && !justifiedMorning;
    const incompleteAfternoon = isWorkday && periodPunchCounts.slice(1).some((count) => count === 1) && !justifiedAfternoon;
    const workedMinutes = periods.reduce((total, _period, index) => total + workedPeriodMinutes(
      scheduledPunches[`Entrada ${index + 1}` as ScheduledPunch],
      scheduledPunches[`Saída ${index + 1}` as ScheduledPunch],
    ), 0);
    const lateMinutes = periods.reduce((total, period, index) => {
      const justified = hasApprovedLateJustification(justifications, employee.employeeId, date, index === 0 ? "morning" : "afternoon");
      const entryPunch = scheduledPunches[`Entrada ${index + 1}` as ScheduledPunch];
      return total + (justified ? 0 : positiveDifference(entryPunch, period.start, workPolicy.toleranceMinutes));
    }, 0);
    const earlyLeaveMinutes = periods.reduce((total, period, index) => total + earlyDifference(
      scheduledPunches[`Saída ${index + 1}` as ScheduledPunch],
      period.end,
      workPolicy.toleranceMinutes,
    ), 0);
    const balanceMinutes = workPolicy.bankHoursEnabled
      ? isWorkday ? workedMinutes - expectedMinutes : workedMinutes
      : 0;
    const hasApprovedJustification = justifications.some((justification) =>
      justification.employeeId === employee.employeeId
      && justification.date === localDateKey(date)
      && justification.status === "approved",
    );
    const status = !isWorkday && !dayPunches.length
      ? "Sem expediente aparente"
      : missingMorning && missingAfternoon
        ? "Falta dia inteiro"
        : missingMorning || missingAfternoon
          ? "Falta por periodo"
          : incompleteMorning || incompleteAfternoon
            ? "Conferir esquecimento"
        : lateMinutes || earlyLeaveMinutes
          ? "Com ocorrencia"
          : hasApprovedJustification
            ? "Justificado"
          : "Completo";

    rows.push({
      balanceMinutes,
      date,
      earlyLeaveMinutes,
      incompleteAfternoon,
      incompleteMorning,
      isWorkday,
      justifiedAfternoon,
      justifiedMorning,
      label: date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", weekday: "short" }),
      lateMinutes,
      missingAfternoon,
      missingMorning,
      scheduledPunches,
      status,
      workedMinutes,
    });
  }

  const missingMornings = rows.filter((row) => row.missingMorning).length;
  const missingAfternoons = rows.filter((row) => row.missingAfternoon).length;
  const incompleteMornings = rows.filter((row) => row.incompleteMorning).length;
  const incompleteAfternoons = rows.filter((row) => row.incompleteAfternoon).length;
  const absencePoints = workPolicy.absenceMode === "day"
    ? rows.filter((row) => row.missingMorning || row.missingAfternoon).reduce(
        (total, row) =>
          total + (row.missingMorning && row.missingAfternoon
            ? workPolicy.fullDayAbsenceWeight
            : Math.max(workPolicy.morningAbsenceWeight, workPolicy.afternoonAbsenceWeight)),
        0,
      )
    : missingMornings * workPolicy.morningAbsenceWeight
      + missingAfternoons * workPolicy.afternoonAbsenceWeight;
  const lateMinutes = rows.reduce((total, row) => total + row.lateMinutes, 0);
  const earlyLeaveMinutes = rows.reduce((total, row) => total + row.earlyLeaveMinutes, 0);
  const totalWorkedMinutes = rows.reduce((total, row) => total + row.workedMinutes, 0);
  const manualBalanceMinutes = bankAdjustments
    .filter((adjustment) => adjustment.employeeId === employee.employeeId)
    .filter((adjustment) => adjustment.status === "approved")
    .filter((adjustment) => {
      const firstDay = `${period.year}-${String(period.month).padStart(2, "0")}-01`;
      const lastDay = localDateKey(period.end);
      return adjustment.effectiveDate >= firstDay && adjustment.effectiveDate <= lastDay;
    })
    .reduce((total, adjustment) => total + adjustment.minutes, 0);
  const totalBalanceMinutes = rows.reduce((total, row) => total + row.balanceMinutes, 0) + manualBalanceMinutes;

  return {
    absencePoints,
    bankAdjustmentMinutes: manualBalanceMinutes,
    earlyLeaveMinutes,
    employee,
    incompleteAfternoons,
    incompleteMornings,
    lateMinutes,
    missingAfternoons,
    missingMornings,
    pendingDays: rows.filter((row) => !["Completo", "Justificado"].includes(row.status) && row.isWorkday).length,
    periodLabel: period.label,
    rows,
    totalBalanceMinutes,
    totalPunches: validPunches.length,
    totalWorkedMinutes,
  };
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function punchTime(punch?: Punch) {
  if (!punch) return "-";
  const date = punchDate(punch);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function openPrintableMonthlyMirror({
  company,
  generatedAt,
  period,
  printWindow: openedWindow,
  responsible,
  summaries,
  workPolicy,
}: {
  company: MainCompanyProfile | null;
  generatedAt: Date;
  period: MonthPeriod;
  printWindow?: Window | null;
  responsible: string;
  summaries: MonthlyMirrorSummary[];
  workPolicy: WorkPolicy;
}) {
  const address = (company?.address || {}) as Record<string, string>;
  const companyName = String(company?.legalName || company?.tradeName || "Empresa");
  const companyCnpj = String(company?.cnpj || "CNPJ nao informado");
  const companyAddress = [address.street, address.number, address.district, address.city, address.state]
    .filter(Boolean)
    .join(", ");

  const employeeSections = summaries.map((summary) => `
    <section class="page">
      <header class="doc-header">
        <div>
          <p class="eyebrow">Espelho de ponto mensal</p>
          <h1>${escapeHtml(companyName)}</h1>
          <p>CNPJ: ${escapeHtml(companyCnpj)}</p>
          <p>${escapeHtml(companyAddress || "Endereco nao informado")}</p>
        </div>
        <div class="period">
          <strong>${escapeHtml(period.label)}</strong>
          <span>Gerado em ${escapeHtml(generatedAt.toLocaleString("pt-BR"))}</span>
        </div>
      </header>

      <div class="employee-grid">
        <div><span>Colaborador</span><strong>${escapeHtml(summary.employee.name)}</strong></div>
        <div><span>Matricula</span><strong>${escapeHtml(summary.employee.registration || "-")}</strong></div>
        <div><span>PIN</span><strong>${summary.employee.pinConfigured ? "Configurado" : "Pendente"}</strong></div>
        <div><span>Cargo</span><strong>${escapeHtml(summary.employee.role || "-")}</strong></div>
        <div><span>CPF</span><strong>${escapeHtml(summary.employee.cpf || "-")}</strong></div>
        <div><span>Admissao</span><strong>${escapeHtml(summary.employee.admissionDate || "-")}</strong></div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Dia</th>
            ${getSchedulePeriods(summary.employee.schedule).map((_, index) => `<th>Entrada ${index + 1}</th><th>Saída ${index + 1}</th>`).join("")}
            <th>Trabalhadas</th>
            <th>Banco</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${summary.rows.map((row) => `
            <tr>
              <td>${escapeHtml(row.label)}</td>
              ${getSchedulePeriods(summary.employee.schedule).map((_, index) => `<td>${escapeHtml(punchTime(row.scheduledPunches[`Entrada ${index + 1}` as ScheduledPunch]))}</td><td>${escapeHtml(punchTime(row.scheduledPunches[`Saída ${index + 1}` as ScheduledPunch]))}</td>`).join("")}
              <td>${escapeHtml(formatDurationClock(row.workedMinutes))}</td>
              <td>${escapeHtml(formatDurationClock(row.balanceMinutes))}</td>
              <td>${escapeHtml(row.status)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>

      <div class="summary">
        <div><span>Total de batidas</span><strong>${summary.totalPunches}</strong></div>
        <div><span>Falta manha</span><strong>${summary.missingMornings}</strong></div>
        <div><span>Falta tarde</span><strong>${summary.missingAfternoons}</strong></div>
        <div><span>Batida incompleta</span><strong>${summary.incompleteMornings + summary.incompleteAfternoons}</strong></div>
        <div><span>Faltas calculadas</span><strong>${summary.absencePoints}</strong></div>
        <div><span>Atrasos</span><strong>${escapeHtml(formatDurationClock(summary.lateMinutes))}</strong></div>
        <div><span>Saida antecipada</span><strong>${escapeHtml(formatDurationClock(summary.earlyLeaveMinutes))}</strong></div>
        <div><span>Banco de horas</span><strong>${escapeHtml(formatDurationClock(summary.totalBalanceMinutes))}</strong></div>
         <div><span>Ajustes aprovados</span><strong>${escapeHtml(formatDurationClock(summary.bankAdjustmentMinutes))}</strong></div>
        <div><span>Dias pendentes</span><strong>${summary.pendingDays}</strong></div>
        <div><span>Responsavel</span><strong>${escapeHtml(responsible || "Nao informado")}</strong></div>
      </div>

      <div class="policy">
        <strong>Regra aplicada</strong>
        <p>Controle de faltas: ${escapeHtml(workPolicy.absenceMode === "day" ? "por dia" : "por periodo")}.</p>
        <p>Peso das faltas: manha ${workPolicy.morningAbsenceWeight}, tarde ${workPolicy.afternoonAbsenceWeight}, dia inteiro ${workPolicy.fullDayAbsenceWeight}.</p>
        <p>Batida parcial no periodo entra como pendencia de conferencia, nao como falta automatica.</p>
        <p>Jornada semanal: ${workPolicy.scheduledDays} dias. Tolerancia: ${workPolicy.toleranceMinutes} minutos. Banco de horas: ${workPolicy.bankHoursEnabled ? "ativo" : "inativo"}.</p>
        <p>Trabalho externo: ${escapeHtml(workPolicy.externalWorkPolicy)}. Ajuste/esquecimento: ${escapeHtml(workPolicy.forgottenPunchPolicy)}.</p>
      </div>

      <p class="statement">
        Declaro que conferi o espelho de ponto do periodo acima. Em caso de divergencia, o colaborador podera registrar ressalva antes do fechamento definitivo.
      </p>

      <div class="signatures">
        <div><span></span><strong>Assinatura do colaborador</strong></div>
        <div><span></span><strong>Assinatura do responsavel/RH</strong></div>
      </div>
    </section>
  `).join("");

  const html = `<!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8" />
        <title>Espelho de ponto - ${escapeHtml(period.label)}</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; background: #eef2f5; color: #101923; font-family: Arial, Helvetica, sans-serif; }
          .toolbar { position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; justify-content: flex-end; padding: 12px; background: #101923; }
          button { border: 0; border-radius: 6px; padding: 10px 14px; font-weight: 700; cursor: pointer; }
          .print { background: #38c793; color: #082c22; }
          .close { background: #fff; color: #26323f; }
          .page { width: 210mm; min-height: 297mm; margin: 14px auto; padding: 14mm; background: #fff; page-break-after: always; }
          .doc-header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #101923; padding-bottom: 14px; }
          .eyebrow { margin: 0 0 6px; color: #18594c; font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
          h1 { margin: 0 0 8px; font-size: 20px; }
          p { margin: 3px 0; font-size: 12px; line-height: 1.45; }
          .period { min-width: 150px; text-align: right; }
          .period strong, .period span { display: block; }
          .period span { margin-top: 6px; color: #667085; font-size: 11px; }
          .employee-grid, .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 14px 0; }
          .employee-grid div, .summary div { border: 1px solid #d9e0e7; border-radius: 6px; padding: 8px; }
          span { display: block; color: #667085; font-size: 10px; font-weight: 700; text-transform: uppercase; }
          strong { display: block; margin-top: 4px; font-size: 12px; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; }
          th { background: #101923; color: white; text-align: left; }
          th, td { border: 1px solid #d9e0e7; padding: 6px; }
          tr:nth-child(even) td { background: #fbfcfd; }
          .statement { margin-top: 18px; border: 1px solid #d9e0e7; border-radius: 6px; padding: 10px; }
          .policy { margin-top: 14px; border: 1px solid #d9e0e7; border-radius: 6px; padding: 10px; background: #fbfcfd; }
          .policy strong { margin: 0 0 6px; }
          .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 34px; }
          .signatures span { height: 44px; border-bottom: 1px solid #101923; }
          .signatures strong { text-align: center; }
          @media print {
            body { background: #fff; }
            .toolbar { display: none; }
            .page { margin: 0; box-shadow: none; }
          }
        </style>
      </head>
      <body>
        <div class="toolbar">
          <button class="close" onclick="window.close()">Fechar</button>
          <button class="print" onclick="window.print()">Imprimir / salvar PDF</button>
        </div>
        ${employeeSections}
      </body>
    </html>`;

  const printWindow = openedWindow || window.open("", "_blank", "width=1100,height=800");
  if (!printWindow) throw new Error("monthly-pdf-popup-blocked");
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  printWindow.setTimeout(() => printWindow.print(), 350);
}

function openPrintableMonthlySummary({
  company,
  generatedAt,
  period,
  printWindow: openedWindow,
  responsible,
  summaries,
}: {
  company: MainCompanyProfile | null;
  generatedAt: Date;
  period: MonthPeriod;
  printWindow?: Window | null;
  responsible: string;
  summaries: MonthlyMirrorSummary[];
}) {
  const companyName = String(company?.legalName || company?.tradeName || "Empresa");
  const companyCnpj = String(company?.cnpj || "CNPJ não informado");
  const totalAbsences = summaries.reduce((total, summary) => total + summary.absencePoints, 0);
  const totalExtraMinutes = summaries.reduce((total, summary) => total + Math.max(summary.totalBalanceMinutes, 0), 0);
  const totalBalanceMinutes = summaries.reduce((total, summary) => total + summary.totalBalanceMinutes, 0);
  const bankClass = (minutes: number) => minutes > 0 ? "positive" : minutes < 0 ? "negative" : "neutral";
  const bankLabel = (minutes: number) => minutes > 0 ? "Banco positivo" : minutes < 0 ? "Banco negativo" : "Sem saldo";
  const formatSignedClock = (minutes: number) => minutes > 0 ? `+${formatDurationClock(minutes)}` : formatDurationClock(minutes);
  const rows = summaries.map((summary) => {
    const balanceMinutes = summary.totalBalanceMinutes;
    return `<tr>
      <td><strong>${escapeHtml(summary.employee.name)}</strong><span>${escapeHtml(summary.employee.role || "Cargo não informado")}</span></td>
      <td>${escapeHtml(period.label)}</td>
      <td class="absence">${escapeHtml(summary.absencePoints)}</td>
      <td class="extra">${escapeHtml(formatDurationClock(Math.max(balanceMinutes, 0)))}</td>
      <td><strong>${escapeHtml(formatSignedClock(balanceMinutes))}</strong></td>
      <td><span class="badge ${bankClass(balanceMinutes)}">${bankLabel(balanceMinutes)}</span></td>
    </tr>`;
  }).join("");
  const html = `<!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8" />
        <title>Espelho de ponto resumido mensal - ${escapeHtml(companyName)}</title>
        <style>
          @page { size: A4 landscape; margin: 10mm; }
          * { box-sizing: border-box; }
          body { margin: 0; background: #eef2f5; color: #142235; font-family: Arial, Helvetica, sans-serif; }
          .toolbar { position: sticky; top: 0; z-index: 2; display: flex; justify-content: flex-end; gap: 8px; padding: 12px; background: #0b1722; }
          button { border: 0; border-radius: 6px; padding: 10px 14px; font-weight: 700; cursor: pointer; }
          .print { background: #16a879; color: #fff; }
          .close { background: #fff; color: #26323f; }
          main { width: 297mm; min-height: 190mm; margin: 14px auto; padding: 12mm; background: #fff; }
          header { display: flex; justify-content: space-between; gap: 20px; border-bottom: 2px solid #087f69; padding-bottom: 14px; }
          .eyebrow { margin: 0 0 6px; color: #087f69; font-size: 10px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
          h1 { margin: 0 0 8px; font-size: 22px; }
          p { margin: 4px 0; font-size: 12px; line-height: 1.5; }
          .generated { min-width: 180px; color: #64748b; font-size: 11px; text-align: right; }
          .totals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 18px 0; }
          .total { border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; }
          .total span, td span { display: block; color: #64748b; font-size: 10px; }
          .total strong { display: block; margin-top: 5px; font-size: 17px; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; }
          th { background: #0b1722; color: #fff; text-align: left; }
          th, td { border: 1px solid #e2e8f0; padding: 8px; vertical-align: middle; }
          tr:nth-child(even) td { background: #f8fafc; }
          td strong { display: block; font-size: 12px; }
          .absence, .extra { font-weight: 700; }
          .badge { display: inline-block; border-radius: 999px; padding: 5px 9px; font-size: 10px; font-weight: 800; }
          .positive { background: #d1fae5; color: #047857; }
          .negative { background: #fee2e2; color: #b91c1c; }
          .neutral { background: #e2e8f0; color: #475569; }
          .note { margin-top: 14px; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; color: #64748b; font-size: 10px; }
          footer { display: flex; justify-content: space-between; gap: 20px; margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 10px; color: #64748b; font-size: 10px; }
          @media print { body { background: #fff; } .toolbar { display: none; } main { width: auto; min-height: auto; margin: 0; padding: 0; } }
        </style>
      </head>
      <body>
        <div class="toolbar"><button class="close" onclick="window.close()">Fechar</button><button class="print" onclick="window.print()">Imprimir / salvar PDF</button></div>
        <main>
          <header>
            <div><p class="eyebrow">Orquestracs Face ID</p><h1>Espelho de ponto resumido mensal</h1><p>${escapeHtml(companyName)}</p><p>CNPJ: ${escapeHtml(companyCnpj)}</p></div>
            <div class="generated"><strong>${escapeHtml(period.label)}</strong><br>Gerado em ${escapeHtml(generatedAt.toLocaleString("pt-BR"))}<br>Responsável: ${escapeHtml(responsible || "Não informado")}</div>
          </header>
          <section class="totals">
            <div class="total"><span>Funcionários</span><strong>${summaries.length}</strong></div>
            <div class="total"><span>Total de faltas</span><strong>${totalAbsences}</strong></div>
            <div class="total"><span>Total de horas extras</span><strong>${escapeHtml(formatDurationClock(totalExtraMinutes))}</strong></div>
            <div class="total"><span>Saldo geral do banco</span><strong>${escapeHtml(formatSignedClock(totalBalanceMinutes))}</strong></div>
          </section>
          <table>
            <thead><tr><th>Funcionário</th><th>Mês do fechamento</th><th>Faltas</th><th>Horas extras</th><th>Banco de horas</th><th>Situação</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="6">Nenhum funcionário selecionado para este fechamento.</td></tr>`}</tbody>
          </table>
          <div class="note">Horas extras mostram somente o saldo positivo do banco. Saldo negativo aparece em vermelho e saldo positivo aparece em verde para facilitar a conferência do escritório contábil.</div>
          <footer><span>Documento resumido para conferência mensal.</span><span>Assinatura do responsável: ____________________________________</span></footer>
        </main>
      </body>
    </html>`;
  const printWindow = openedWindow || window.open("", "_blank", "width=1100,height=800");
  if (!printWindow) throw new Error("monthly-summary-pdf-popup-blocked");
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  printWindow.setTimeout(() => printWindow.print(), 350);
}

function openPrintableDataReport({
  company,
  fields,
  printWindow: openedWindow,
  rows = [],
  title,
}: {
  company: MainCompanyProfile | null;
  fields: Record<string, string>;
  printWindow?: Window | null;
  rows?: string[][];
  title: string;
}) {
  const companyName = String(company?.legalName || company?.tradeName || "Empresa");
  const companyCnpj = String(company?.cnpj || "CNPJ não informado");
  const generatedAt = new Date().toLocaleString("pt-BR");
  const fieldRows = Object.entries(fields).filter(([, value]) => String(value).trim());
  const tableRows = rows.length
    ? `<table><thead><tr>${rows[0].map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead><tbody>${rows.slice(1).map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
    : `<div class="empty">Os dados detalhados serão preenchidos após a geração do espelho mensal no Fechamento mensal.</div>`;
  const html = `<!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(title)} - ${escapeHtml(companyName)}</title>
        <style>
          @page { size: A4; margin: 12mm; }
          * { box-sizing: border-box; }
          body { margin: 0; background: #eef2f5; color: #142235; font-family: Arial, Helvetica, sans-serif; }
          .toolbar { position: sticky; top: 0; z-index: 2; display: flex; justify-content: flex-end; gap: 8px; padding: 12px; background: #0b1722; }
          button { border: 0; border-radius: 6px; padding: 10px 14px; font-weight: 700; cursor: pointer; }
          .print { background: #16a879; color: #fff; }
          .close { background: #fff; color: #26323f; }
          main { width: 210mm; min-height: 270mm; margin: 14px auto; padding: 14mm; background: #fff; }
          header { display: flex; justify-content: space-between; gap: 20px; border-bottom: 2px solid #087f69; padding-bottom: 14px; }
          .eyebrow { margin: 0 0 6px; color: #087f69; font-size: 10px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
          h1 { margin: 0 0 8px; font-size: 22px; }
          p { margin: 4px 0; font-size: 12px; line-height: 1.5; }
          .generated { min-width: 145px; color: #64748b; font-size: 11px; text-align: right; }
          .section { margin-top: 18px; }
          .section h2 { margin: 0 0 8px; color: #142235; font-size: 14px; }
          .fields { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
          .field { min-height: 46px; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; }
          .field span { display: block; color: #64748b; font-size: 9px; font-weight: 800; text-transform: uppercase; }
          .field strong { display: block; margin-top: 5px; overflow-wrap: anywhere; font-size: 11px; }
          table { width: 100%; border-collapse: collapse; font-size: 10px; }
          th { background: #0b1722; color: #fff; text-align: left; }
          th, td { border: 1px solid #e2e8f0; padding: 6px; vertical-align: top; }
          tr:nth-child(even) td { background: #f8fafc; }
          .empty { border: 1px solid #e2e8f0; background: #f8fafc; padding: 14px; color: #64748b; font-size: 12px; }
          footer { margin-top: 28px; border-top: 1px solid #e2e8f0; padding-top: 10px; color: #64748b; font-size: 10px; }
          @media print { body { background: #fff; } .toolbar { display: none; } main { width: auto; min-height: auto; margin: 0; padding: 0; } }
        </style>
      </head>
      <body>
        <div class="toolbar"><button class="close" onclick="window.close()">Fechar</button><button class="print" onclick="window.print()">Imprimir / salvar PDF</button></div>
        <main>
          <header><div><p class="eyebrow">Orquestracs Face ID</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(companyName)}</p><p>CNPJ: ${escapeHtml(companyCnpj)}</p></div><div class="generated">Gerado em<br><strong>${escapeHtml(generatedAt)}</strong></div></header>
          <section class="section"><h2>Dados do relatório</h2><div class="fields">${fieldRows.length ? fieldRows.map(([label, value]) => `<div class="field"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("") : `<div class="empty">Nenhum filtro foi informado.</div>`}</div></section>
          <section class="section"><h2>Detalhamento</h2>${tableRows}</section>
          <footer>Documento para conferência administrativa. Para o fechamento mensal completo com jornadas, faltas, banco de horas e assinaturas, use o PDF gerado na aba Fechamento mensal.</footer>
        </main>
      </body>
    </html>`;
  const printWindow = openedWindow || window.open("", "_blank", "width=1100,height=800");
  if (!printWindow) throw new Error("data-report-pdf-popup-blocked");
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  printWindow.setTimeout(() => printWindow.print(), 350);
}

function SaveButton({
  children,
  disabled = false,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => Promise<void> | void;
}) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

  async function handleClick() {
    if (disabled || status === "saving") return;

    setStatus("saving");
    try {
      await onClick();
      setStatus("saved");
      window.setTimeout(() => setStatus("idle"), 2200);
    } catch {
      setStatus("idle");
    }
  }

  return (
    <button
      className={`primary-button save-button ${status === "saved" ? "save-button-saved" : ""}`}
      disabled={disabled || status === "saving"}
      onClick={handleClick}
      type="button"
    >
      <span className={`save-button-icon ${status === "saving" ? "save-button-spinner" : ""}`}>
        {status === "saved" ? "✓" : ""}
      </span>
      {status === "saving" ? "Salvando..." : status === "saved" ? "Salvo" : children}
    </button>
  );
}

function ActionRow({ children }: { children: React.ReactNode }) {
  return <div className="app-action-row">{children}</div>;
}

function CheckList({ items }: { items: string[] }) {
  return (
    <div className="app-checklist">
      {items.map((item) => (
        <div className="info-note" key={item}>
          <span className="info-note-icon" aria-hidden="true" />
          <span>{item}</span>
        </div>
      ))}
    </div>
  );
}

function TwoColumn({ children }: { children: React.ReactNode }) {
  return <div className="app-two-column">{children}</div>;
}
