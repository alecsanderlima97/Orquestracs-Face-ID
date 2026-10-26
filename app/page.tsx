"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getRedirectResult,
  onAuthStateChanged,
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
import { getCompany, getMainCompany, saveMainCompany, saveTenantCompany, uploadCompanyLogo } from "@/lib/services/companies";
import type {
  AttendanceJustification,
  AttendanceJustificationPeriod,
  AttendanceJustificationType,
  AdjustmentType,
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
  getUserTenantAccess,
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
  | "Escalas"
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

const TenantIdContext = createContext("main");

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
  employeeId?: string;
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
const REQUIRED_FACE_CAPTURES = 3;

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
    employeeId: String(employee.employeeId || employee.id || fallbackId),
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
      start: schedule.start || "07:00",
      toleranceMinutes: Number(schedule.toleranceMinutes || 10),
    },
    shift: String(employee.shift || "Jornada da empresa"),
    status: String(employee.status || "Pre-cadastro"),
  };
}

function employeeDocumentId(employee: Pick<LocalEmployee, "employeeId" | "name" | "registration">) {
  const registration = onlyDigits(employee.registration || "");
  if (registration) return `matricula-${registration}`;

  return `colaborador-${employee.name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || employee.employeeId}`;
}

const journeyRows: string[][] = [];

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
  punches: Partial<Record<PunchType, Punch>>;
  status: string;
  workedMinutes: number;
};

type MonthlyMirrorSummary = {
  absencePoints: number;
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

function inferNextPunchFromHistory(punches: Array<Pick<Punch, "occurredAt" | "type">>) {
  const orderedPunches = punches
    .map((punch) => ({ punch, date: punchDate(punch as Punch) }))
    .filter((item) => !Number.isNaN(item.date.getTime()))
    .sort((first, second) => first.date.getTime() - second.date.getTime())
    .map((item) => item.punch);

  const latestPunch = orderedPunches.at(-1);
  if (!latestPunch) return "Entrada 1";
  if (latestPunch.type === "exit") return null;
  if (latestPunch.type === "lunch_out") return "Entrada 2";
  if (latestPunch.type === "lunch_back") return "Saída 2";
  if (latestPunch.type === "entry") {
    const entryCount = orderedPunches.filter((punch) => punch.type === "entry").length;
    return entryCount >= 2 ? "Saída 2" : "Saída 1";
  }

  return "Entrada 1";
}

function inferNextPunch(employeeId: string) {
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
      type: mapPunchType(record.fields.Tipo || ""),
    }));

  return inferNextPunchFromHistory(punches);
}

async function resolveNextPunch(employeeId: string, companyId = "main") {
  const localNextPunch = inferNextPunch(employeeId);

  try {
    const serverPunches = await listEmployeePunches(companyId, employeeId);
    const today = new Date();
    const todayPunches = serverPunches.filter((punch) => sameDay(punchDate(punch), today));
    return todayPunches.length ? inferNextPunchFromHistory(todayPunches) : localNextPunch;
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

function getPunchTiming(employee: RecognizedFace, punchType: string) {
  const schedule = employee.schedule || {
    breakEnd: "13:00",
    breakStart: "11:30",
    end: "17:15",
    start: "07:00",
    toleranceMinutes: 10,
  };
  const expectedByPunch: Record<string, string> = {
    Entrada: schedule.start,
    "Entrada 1": schedule.start,
    "Saída almoço": schedule.breakStart,
    "Saída 1": schedule.breakStart,
    "Volta almoço": schedule.breakEnd,
    "Entrada 2": schedule.breakEnd,
    "Fim do dia": schedule.end,
    "Saída 2": schedule.end,
  };
  const expectedTime = expectedByPunch[punchType];
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const differenceMinutes = currentMinutes - minutesFromTime(expectedTime);
  const isExitPunch = ["Saída almoço", "Saída 1", "Fim do dia", "Saída 2"].includes(punchType);
  const isFinalExit = punchType === "Saída 2" || punchType === "Fim do dia";
  const hasBankHours = isFinalExit && differenceMinutes > 0;
  const timingLabel = hasBankHours
    ? "Banco de horas"
    : Math.abs(differenceMinutes) <= schedule.toleranceMinutes
    ? "No horário"
    : differenceMinutes < 0
      ? isExitPunch
        ? "Saída antecipada"
        : "Entrada antecipada"
      : isExitPunch
        ? "Intervalo iniciado após o horário"
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
  const [authLoading, setAuthLoading] = useState(true);
  const [accessLoading, setAccessLoading] = useState(true);
  const [accessError, setAccessError] = useState("");
  const [appAccess, setAppAccess] = useState<TenantAccess | null>(null);
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

  async function refreshCompanyProfile(companyId = appAccess?.tenantId || "main") {
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
    try {
      const access = await Promise.race([
        getUserTenantAccess(currentUser),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error("access-timeout")), 10000);
        }),
      ]);
      setAppAccess(access);
      void refreshCompanyProfile(access?.tenantId || "main");
      if (access?.role === "developer") {
        const [invites, config] = await Promise.all([
          listTenantInvites(access.tenantId),
          getTenantSaasConfig(access.tenantId),
        ]);
        setTenantInvites(invites);
        setSaasConfig(config);
      }
    } catch (error) {
      console.error(error);
      setAppAccess(null);
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
        void refreshCompanyProfile();
        void refreshAccess(currentUser);
      } else {
        setAppAccess(null);
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
      setLoginMessage("");
      setNotice(`Acesso liberado para ${access.companyName}.`);
    } catch (error) {
      console.error(error);
      setLoginMessage("Convite invalido, expirado ou ja utilizado.");
    }
  }

  const title = useMemo(() => {
    const subtitles: Record<Section, string> = {
      Painel: "Visao geral da operacao",
      Empresa: "Cadastro e configuracao do CNPJ do sistema",
      Colaboradores: "Equipe, documentos, turnos e biometria",
      Escalas: "Jornadas, tolerancias e banco de horas",
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

  async function demoAction(action: string) {
    const fields = collectVisibleFormData();
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

    if (action === "Convite por e-mail") {
      const roleByLabel: Record<string, "owner" | "admin" | "reader"> = {
        Administrador: "admin",
        Leitor: "reader",
        Proprietario: "owner",
      };
      const invite = await createTenantInvite({
        companyName: fields.Cliente || fields.Empresa || String(companyProfile?.tradeName || companyProfile?.legalName || "Empresa convidada"),
        role: roleByLabel[fields.Perfil || fields.Permissao || "Proprietario"] || "owner",
        tenantId: activeCompanyId,
      });
      setTenantInvites((items) => [invite, ...items]);
      setNotice(`Convite criado: ${invite.code}. Envie esse codigo para o cliente.`);
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
      downloadTextFile(
        `relatorio-jornada-${new Date().toISOString().slice(0, 10)}.txt`,
        `Orquestracs Face ID\nRelatorio de jornada\nGerado em: ${new Date().toLocaleString("pt-BR")}\n\n${JSON.stringify(fields, null, 2)}`,
      );
      setNotice("Relatorio gerado localmente com os dados disponiveis.");
      return;
    }

    if (action === "Exportacao fiscal") {
      downloadTextFile(
        `exportacao-fiscal-${new Date().toISOString().slice(0, 10)}.csv`,
        "campo,valor\n" +
          Object.entries(fields)
            .map(([key, value]) => `"${key}","${value}"`)
            .join("\n"),
        "text/csv",
      );
      setNotice("Exportacao fiscal gerada em CSV.");
      return;
    }

    if (action === "Folha mensal para contador") {
      const header = [
        "funcionario",
        "cpf",
        "cargo",
        "dias_trabalhados",
        "faltas_manha",
        "faltas_tarde",
        "atrasos",
        "banco_horas",
        "observacao",
      ];
      const csv = [
        header.join(","),
        ...monthlyClosingRows.map((row) => row.map((cell) => `"${cell}"`).join(",")),
      ].join("\n");

      downloadTextFile(
        `folha-mensal-contador-${new Date().toISOString().slice(0, 10)}.csv`,
        csv,
        "text/csv",
      );
      setNotice("Folha mensal para contador gerada em CSV.");
      return;
    }

    if (action === "Ficha individual de ciencia") {
      downloadTextFile(
        `ficha-ciencia-funcionario-${new Date().toISOString().slice(0, 10)}.txt`,
        `Orquestracs Face ID\nFicha individual de ciencia mensal\nGerado em: ${new Date().toLocaleString("pt-BR")}\n\nFuncionario: preencher apos selecionar colaborador\nPeriodo: preencher periodo\nFaltas manha: 0\nFaltas tarde: 0\nAtrasos: 00:00\nBanco de horas: 00:00\n\nAssinatura do funcionario: ______________________________\nAssinatura do responsavel: ______________________________`,
      );
      setNotice("Ficha individual de ciencia gerada.");
      return;
    }

    if (action === "Termo LGPD" || action === "Relatorio de impacto") {
      downloadTextFile(
        `${action.toLowerCase().replace(/\s+/g, "-")}.txt`,
        `${action}\nOrquestracs Face ID\nGerado em: ${new Date().toLocaleString("pt-BR")}\n\nDocumento gerado com os dados disponiveis no sistema.`,
      );
      setNotice(`${action} gerado localmente.`);
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

    setNotice(`${action} salvo localmente neste navegador. Firebase sera conectado depois.`);
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
      scheduledPunch: kind as "Entrada 1" | "Saída 1" | "Entrada 2" | "Saída 2",
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
              Registre entradas, intervalos e saídas com mais agilidade, segurança e rastreabilidade.
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
  const activeCompanyId = appAccess?.tenantId || "main";
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
  const companyAddress = (companyProfile?.address || {}) as Record<string, string>;
  const kioskLocation = weatherSnapshot?.source === "current"
    ? "Localização atual"
    : [companyAddress.city, companyAddress.state].filter(Boolean).join(" - ") || "Local da empresa";

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
              <p className="text-xs uppercase text-white/45">Empresa</p>
              <p className="mt-1 truncate text-sm font-semibold text-white">{String(companyName)}</p>
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

      <div className={kioskMode ? "kiosk-content-shell" : "mx-auto grid max-w-[1480px] gap-4 px-3 py-3 sm:px-4 sm:py-4 lg:grid-cols-[292px_minmax(0,1fr)] lg:gap-6 lg:px-6"}>
        <aside className={kioskMode ? "hidden" : "app-sidebar hidden rounded-lg border border-[#d9e0e7] p-4 text-white shadow-sm lg:sticky lg:top-4 lg:block lg:h-[calc(100vh-2rem)]"}>
          <div className="flex h-full flex-col">
            <div className="border-b border-white/10 pb-5">
              <div className="min-w-0">
                <img
                  alt="Orquestracs Face ID"
                  className="app-brand-wordmark-dark app-brand-wordmark-sidebar"
                  src="/orquestracs-face-id-wordmark.svg"
                />
              </div>
              <div className="mt-5 rounded-md border border-white/10 bg-white/[0.04] p-3">
                <p className="text-xs uppercase tracking-[0.12em] text-white/45">Empresa</p>
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
              </div>
            </div>

            <nav className="mt-5 grid gap-1 text-sm">
              {visibleNavItems.map((item) => (
                <button
                  className={`rounded-md px-3 py-2.5 text-left font-medium transition ${
                    active === item
                      ? "bg-[#dcebe6] text-[#143f37]"
                      : "text-white/70 hover:bg-white/[0.06] hover:text-white"
                  }`}
                  key={item}
                  onClick={() => go(item)}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </nav>

            <div className="mt-auto rounded-md border border-[#314450] bg-[#182530] p-3">
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
              <DailyOperationsPanel scheduledDays={getCompanyWorkPolicy(companyProfile).scheduledDays} />
            </>
          )}

          {active === "Empresa" && (
            <CompaniesScreen
              canEdit={isPlatformOwnerEmail(user.email) || appAccess?.role !== "reader"}
              company={companyProfile}
              key={String(companyProfile?.updatedAt || companyProfile?.logoUrl || "empty-company")}
              onAction={demoAction}
            />
          )}
          {active === "Colaboradores" && <EmployeesScreen canEdit={canManage} onAction={demoAction} />}
          {active === "Escalas" && <ShiftsScreen canEdit={canManage} onAction={demoAction} />}
          {active === "Sala de ponto" && (
            <KioskScreen
              dateLabel={headerDate}
              locationLabel={kioskLocation}
              onAction={demoAction}
              onExit={() => void handleLogout()}
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
          {active === "Banco de horas" && <HoursBankScreen canEdit={canManage} onAction={demoAction} />}
          {active === "Fechamento mensal" && <MonthlyClosingScreen company={companyProfile} onAction={demoAction} />}
          {active === "Relatorios" && <ReportsScreen onAction={demoAction} />}
          {active === "LGPD e auditoria" && <AuditScreen onAction={demoAction} />}
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
  | "done"
  | "off"
  | "pending"
  | "waiting"
  | "working";

type DailyEmployeeRow = {
  employee: LocalEmployee;
  pendingPunches: PunchType[];
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
  if (minutes < 14 * 60) return { detail: "Janela de almoço e intervalo.", icon: "🍽️", label: "Intervalo" };
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

function getDailyPendingPunches(
  employee: LocalEmployee,
  punches: Punch[],
  now: Date,
  scheduledDays: number,
  justifications: AttendanceJustification[] = [],
): PunchType[] {
  if (!isScheduledWorkday(now, scheduledDays)) return [];

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const schedule = employee.schedule;
  const todayPunches = punches.filter((punch) => isSameCalendarDay(punchDate(punch), now));
  const hasPunch = (type: PunchType) => todayPunches.some((punch) => punch.type === type);
  const start = getTimeMinutes(schedule.start);
  const lunchOut = getTimeMinutes(schedule.breakStart);
  const lunchBack = getTimeMinutes(schedule.breakEnd);
  const end = getTimeMinutes(schedule.end);
  const morningJustified = hasApprovedAbsenceJustification(justifications, employee.employeeId, now, "morning");
  const afternoonJustified = hasApprovedAbsenceJustification(justifications, employee.employeeId, now, "afternoon");

  if (currentMinutes < start) return [];

  const pending: PunchType[] = [];
  if (!hasPunch("entry") && !morningJustified) pending.push("entry");
  if (currentMinutes >= lunchOut && !hasPunch("lunch_out") && !morningJustified) pending.push("lunch_out");
  if (currentMinutes >= lunchBack && !hasPunch("lunch_back") && !afternoonJustified) pending.push("lunch_back");
  if (currentMinutes >= end && !hasPunch("exit") && !afternoonJustified) pending.push("exit");
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
  const hasPunch = (type: PunchType) => todayPunches.some((punch) => punch.type === type);
  const morningClosed = currentMinutes >= getTimeMinutes(schedule.breakEnd);
  const afternoonClosed = currentMinutes >= getTimeMinutes(schedule.end);
  const morningJustified = hasApprovedAbsenceJustification(justifications, employee.employeeId, now, "morning");
  const afternoonJustified = hasApprovedAbsenceJustification(justifications, employee.employeeId, now, "afternoon");
  const morningMissing = morningClosed && !morningJustified && !hasPunch("entry") && !hasPunch("lunch_out");
  const afternoonMissing = afternoonClosed && !afternoonJustified && !hasPunch("lunch_back") && !hasPunch("exit");

  return {
    afternoon: afternoonMissing && !morningMissing,
    fullDay: morningMissing && afternoonMissing,
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
  const start = getTimeMinutes(schedule.start);
  const lunchOut = getTimeMinutes(schedule.breakStart);
  const lunchBack = getTimeMinutes(schedule.breakEnd);
  const end = getTimeMinutes(schedule.end);

  if (currentMinutes < start) return "waiting";
  const absencePeriods = getDailyAbsencePeriods(employee, punches, now, scheduledDays, justifications);
  if (absencePeriods.fullDay) return "absence_full_day";
  if (absencePeriods.morning) return "absence_morning";
  if (absencePeriods.afternoon) return "absence_afternoon";
  if (getDailyPendingPunches(employee, punches, now, scheduledDays, justifications).length > 0) return "pending";
  if (currentMinutes < lunchOut) return "working";
  if (currentMinutes < lunchBack) return "break";
  if (currentMinutes < end) return "working";
  return "done";
}

function dailyStatusLabel(statusKey: DailyStatusKey) {
  const labels: Record<DailyStatusKey, string> = {
    absence_afternoon: "Falta tarde - justificar",
    absence_full_day: "Falta dia inteiro - justificar",
    absence_morning: "Falta manhã - justificar",
    break: "Intervalo",
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

function DailyOperationsPanel({ scheduledDays }: { scheduledDays: number }) {
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

  function renderPunchCell(row: DailyEmployeeRow, type: PunchType, expected: string) {
    const punch = row.punches.find(
      (punch) => punch.type === type && isSameCalendarDay(punchDate(punch), now),
    );
    const confirmed = Boolean(punch);
    const pending = row.pendingPunches.includes(type);
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
          <div className="dashboard-live-meta">
            <span>{period.icon} {period.label} · ao vivo</span>
            <strong>{currentTime}</strong>
            <small>{currentDate}</small>
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
              <option value="break">Intervalo</option>
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
                {["Funcionário", "Escala", "Entrada", "Intervalo", "Retorno", "Saída", "Última batida", "Status"].map((head) => (
                  <th key={head}>{head}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8}><div className="dashboard-empty-state">Carregando colaboradores...</div></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8}><div className="dashboard-empty-state">{employeesList.length ? "Nenhum colaborador corresponde ao filtro." : "Nenhum colaborador cadastrado."}</div></td></tr>
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
                  <td>{renderPunchCell(row, "entry", row.employee.schedule.start)}</td>
                  <td>{renderPunchCell(row, "lunch_out", row.employee.schedule.breakStart)}</td>
                  <td>{renderPunchCell(row, "lunch_back", row.employee.schedule.breakEnd)}</td>
                  <td>{renderPunchCell(row, "exit", row.employee.schedule.end)}</td>
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
                {[
                  { label: "Entrada", value: renderPunchCell(row, "entry", row.employee.schedule.start) },
                  { label: "Intervalo", value: renderPunchCell(row, "lunch_out", row.employee.schedule.breakStart) },
                  { label: "Retorno", value: renderPunchCell(row, "lunch_back", row.employee.schedule.breakEnd) },
                  { label: "Saída", value: renderPunchCell(row, "exit", row.employee.schedule.end) },
                ].map(({ label, value }) => (
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
    exit: "Saida",
    lunch_back: "Retorno do intervalo",
    lunch_out: "Saida para intervalo",
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
            {["Entrada", "Intervalo", "Retorno", "Saida"].map((label) => (
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
  company,
  onAction,
}: {
  canEdit: boolean;
  company: MainCompanyProfile | null;
  onAction: (action: string) => void;
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
  const [companyJourney, setCompanyJourney] = useState({
    start: "07:00",
    lunchOut: "11:30",
    lunchBack: "13:00",
    end: "17:15",
    days: "5",
  });

  function updateCompanyJourney(field: keyof typeof companyJourney, value: string) {
    setCompanyJourney((current) => ({ ...current, [field]: value }));
  }

  function setCompanySection(section: keyof typeof openCompanySections, open: boolean) {
    setOpenCompanySections((current) => ({ ...current, [section]: open }));
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
        subtitle="Jornadas coletivas usadas pelos colaboradores"
      >
        <fieldset disabled={!canEdit}>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Nome da escala"><input className="input" placeholder="Operacional 07h as 17h15" /></Field>
          <TimeStepper label="Entrada" onChange={(value) => updateCompanyJourney("start", value)} value={companyJourney.start} />
          <TimeStepper label="Saida almoco" onChange={(value) => updateCompanyJourney("lunchOut", value)} value={companyJourney.lunchOut} />
          <TimeStepper label="Volta almoco" onChange={(value) => updateCompanyJourney("lunchBack", value)} value={companyJourney.lunchBack} />
          <TimeStepper label="Fim do dia" onChange={(value) => updateCompanyJourney("end", value)} value={companyJourney.end} />
          <Field label="Dias por semana">
            <select className="input" onChange={(event) => updateCompanyJourney("days", event.target.value)} value={companyJourney.days}>
              <option value="5">5 dias</option>
              <option value="6">6 dias</option>
              <option value="7">7 dias</option>
            </select>
          </Field>
          <JourneySummary
            breakEnd={companyJourney.lunchBack}
            breakStart={companyJourney.lunchOut}
            days={Number(companyJourney.days)}
            end={companyJourney.end}
            start={companyJourney.start}
          />
        </div>
        </fieldset>
        <ActionRow>
          <SaveButton disabled={!canEdit} onClick={() => onAction("Escala coletiva da empresa")}>Salvar escala</SaveButton>
          <button className="secondary-button" onClick={() => onAction("Previa da jornada coletiva")} type="button">Ver previa</button>
        </ActionRow>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {initialShifts.map((shift) => (
            <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={shift.name}>
              <p className="text-sm font-semibold text-[#26323f]">{shift.name}</p>
              <p className="mt-1 text-xs text-[#667085]">
                {shift.start} - {shift.breakStart} / {shift.breakEnd} - {shift.end}
              </p>
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
          <CheckList
            items={[
              "Proprietario tem acesso total",
              "Administrador gerencia operacao",
              "Leitor apenas visualiza relatorios",
              "Convites pendentes podem ser reenviados",
            ]}
          />
        <ActionRow>
            <SaveButton disabled={!canEdit} onClick={() => onAction("Convidar usuario da empresa")}>Convidar usuario</SaveButton>
        </ActionRow>
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

function EmployeesScreen({ canEdit, onAction }: { canEdit: boolean; onAction: (action: string) => void }) {
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
  const [faceCompletion, setFaceCompletion] = useState<{
    employee: LocalEmployee;
    nextPending: LocalEmployee | null;
  } | null>(null);
  const [employeeJourney, setEmployeeJourney] = useState({
    start: "07:00",
    lunchOut: "11:30",
    lunchBack: "13:00",
    end: "17:15",
    days: "5",
  });

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
    const schedule =
      journeyMode === "individual"
        ? {
            breakEnd: employeeJourney.lunchBack,
            breakStart: employeeJourney.lunchOut,
            end: employeeJourney.end,
            start: employeeJourney.start,
            toleranceMinutes: 10,
          }
        : {
            breakEnd: companyShift.breakEnd,
            breakStart: companyShift.breakStart,
            end: companyShift.end,
            start: companyShift.start,
            toleranceMinutes: Number.parseInt(companyShift.tolerance, 10) || 10,
          };
    const employee: LocalEmployee = {
      active: selectedEmployee?.active !== false,
      admissionDate: employeeForm.admissionDate || "Nao informado",
      bank: "00:00",
      cbo: employeeForm.cbo || "",
      cpf: employeeForm.cpf || "Não informado",
      department: employeeForm.department || "Geral",
      employeeId: editingEmployeeId || crypto.randomUUID(),
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
      Object.entries(employee).filter(([key]) => key !== "pin"),
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

  function markFaceRegistered(captureCount: number, photoBlob?: Blob) {
    if (!selectedEmployee) return;
    if (!biometricConsentAccepted) {
      onAction("Confirme o aceite biometrico antes de salvar o cadastro facial.");
      return;
    }
    const completed = captureCount >= REQUIRED_FACE_CAPTURES;
    const captureId = crypto.randomUUID();

    const updated = localEmployees.map((employee) =>
      employee.employeeId === selectedEmployee.employeeId
        ? {
            ...employee,
            faceIdStatus: completed ? "registered" as const : employee.faceIdStatus,
            status: completed ? "Face ID cadastrado" : `Face ID ${captureCount}/${REQUIRED_FACE_CAPTURES}`,
          }
        : employee,
    );
    const current = updated.find((employee) => employee.employeeId === selectedEmployee.employeeId) || null;
    const nextPending = updated.find(
      (employee) => employee.employeeId !== selectedEmployee.employeeId && employee.faceIdStatus !== "registered",
    );

    window.localStorage.setItem(LOCAL_EMPLOYEES_KEY, JSON.stringify(updated));
    setLocalEmployees(updated);
    setSelectedEmployee(current);
    if (current) {
      void upsertEmployee(companyId, employeeDocumentId(current), {
        faceCaptureCount: captureCount,
        faceIdStatus: completed ? "registered" : current.faceIdStatus,
        ...(completed ? { faceRegisteredAt: new Date().toISOString(), status: "Face ID cadastrado" } : { status: `Face ID ${captureCount}/${REQUIRED_FACE_CAPTURES}` }),
      });

      if (photoBlob) {
        void uploadFacePhoto({
          blob: photoBlob,
          companyId,
          employeeId: current.employeeId,
          photoId: captureId,
        }).then((photoPath) => {
          void createFaceIdRecord({
            capturedBy: "server-authenticated",
            companyId,
            consentAcceptedAt: new Date(),
            createdAt: new Date(),
            employeeId: current.employeeId,
            photoPath,
          });
        });
      }
    }

    if (completed) {
      setReplaceFaceProfile(false);
      setShowFaceCamera(false);
      if (current) {
        setFaceCompletion({ employee: current, nextPending: nextPending || null });
      }
      onAction(
        `${selectedEmployee.name}: Face ID concluído. Confira o nome antes de cadastrar outro colaborador.`,
      );
      return;
    }

    onAction(`${selectedEmployee.name}: captura ${captureCount}/${REQUIRED_FACE_CAPTURES} salva.`);
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
                  {initialShifts.map((shift) => (
                    <option key={shift.name}>
                      {shift.name} - {shift.start} as {shift.breakStart} / {shift.breakEnd} as {shift.end}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="rounded-md border border-[#cfe3dc] bg-[#f1faf7] p-3 text-sm text-[#24594d]">
                O colaborador seguira a regra padrao da empresa. Se precisar
                excecao, selecione jornada individual.
              </div>
            </div>
          ) : (
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              <TimeStepper label="Entrada" onChange={(value) => updateEmployeeJourney("start", value)} value={employeeJourney.start} />
              <TimeStepper label="Saida almoco" onChange={(value) => updateEmployeeJourney("lunchOut", value)} value={employeeJourney.lunchOut} />
              <TimeStepper label="Volta almoco" onChange={(value) => updateEmployeeJourney("lunchBack", value)} value={employeeJourney.lunchBack} />
              <TimeStepper label="Fim do dia" onChange={(value) => updateEmployeeJourney("end", value)} value={employeeJourney.end} />
              <Field label="Dias por semana">
                <select className="input" onChange={(event) => updateEmployeeJourney("days", event.target.value)} value={employeeJourney.days}>
                  <option value="5">5 dias</option>
                  <option value="6">6 dias</option>
                  <option value="7">7 dias</option>
                </select>
              </Field>
              <JourneySummary
                breakEnd={employeeJourney.lunchBack}
                breakStart={employeeJourney.lunchOut}
                days={Number(employeeJourney.days)}
                end={employeeJourney.end}
                start={employeeJourney.start}
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
                Status: {selectedEmployee!.faceIdStatus === "registered" ? "Face ID cadastrado" : "Aguardando captura"}
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
                Faça {REQUIRED_FACE_CAPTURES} capturas com boa luz. Ao concluir, a câmera será encerrada e você confirmará o próximo nome manualmente.
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

    const nextPunch = inferNextPunch(registered.employeeId);
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
              <option value="Entrada 1">Entrada</option>
              <option value="Saida 1">Inicio do intervalo</option>
              <option value="Entrada 2">Retorno do intervalo</option>
              <option value="Saida 2">Saida</option>
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
  dateLabel: string;
  locationLabel: string;
  onAction: (action: string) => void;
  onExit: () => void;
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
  const [confirmation, setConfirmation] = useState<{
    employeeName: string;
    time: string;
    type: string;
  } | null>(null);
  const [faceProfileSources, setFaceProfileSources] = useState<FaceProfileSource[]>([]);
  const confirmPanelRef = useRef<HTMLDivElement>(null);
  const resetTimerRef = useRef<number | null>(null);

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
                const faceRecords = await listFaceIdRecords(companyId, employee.employeeId);
                photoPaths = faceRecords.slice(0, 3).map((record) => record.photoPath);
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
    if (!("speechSynthesis" in window)) return;

    window.speechSynthesis.cancel();
    const voiceMessage = new SpeechSynthesisUtterance(message);
    voiceMessage.lang = "pt-BR";
    const portugueseVoices = window.speechSynthesis
      .getVoices()
      .filter((voice) => voice.lang.toLowerCase().startsWith("pt"));
    const naturalVoice =
      portugueseVoices.find((voice) => /natural|online|francisca|luciana|maria/i.test(voice.name)) ||
      portugueseVoices[0];
    if (naturalVoice) voiceMessage.voice = naturalVoice;
    voiceMessage.rate = 0.98;
    voiceMessage.pitch = 1.03;
    voiceMessage.volume = 0.92;
    window.speechSynthesis.speak(voiceMessage);
  }

  function voiceName(name: string) {
    return name.trim().split(/\s+/)[0] || "colaborador";
  }

  function speakPunchConfirmation(type: string, name: string) {
    const firstName = voiceName(name);
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
    const message = type === "Saída 1"
      ? `Ponto registrado. Bom intervalo, ${firstName}!`
      : type === "Entrada 2"
        ? `Ponto registrado. ${greeting}, ${firstName}! Bom retorno.`
        : type === "Saída 2"
          ? `Ponto registrado. ${greeting}, ${firstName}! Bom descanso.`
          : `Ponto registrado. ${greeting}, ${firstName}!`;
    speak(message);
  }

  async function identifyFace(employee: RecognizedFace, photoBlob?: Blob) {
    setSequenceLoading(true);
    const nextPunch = await resolveNextPunch(employee.employeeId, companyId);
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

    const timing = getPunchTiming(recognizedEmployee, selectedPunch);
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
    }, 3000);
  }

  const punchOptions = [
    { description: "Início da jornada", icon: "👋", label: "Entrada 1", value: "Entrada 1" },
    { description: "Início do intervalo", icon: "🍽️", label: "Saída 1", value: "Saída 1" },
    { description: "Retorno ao trabalho", icon: "↩️", label: "Entrada 2", value: "Entrada 2" },
    { description: "Fim da jornada", icon: "🏠", label: "Saída 2", value: "Saída 2" },
  ];
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
          <button className="kiosk-exit-button" onClick={onExit} type="button">Sair</button>
        </div>
      </header>

      <div className="kiosk-workspace md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="kiosk-recognition-panel">
          <div className="kiosk-stepper" aria-label="Etapas do registro">
            {[
              ["1", "Reconhecimento", "Posicione o rosto"],
              ["2", "Identificação", "Validando funcionário"],
              ["3", "Registro", "Gravando ponto"],
              ["4", "Confirmação", "Mensagem de voz"],
            ].map(([step, label, detail], index) => (
              <div className={`kiosk-step ${index === 0 && !recognizedEmployee ? "is-active" : recognizedEmployee && index === 1 ? "is-active" : confirmation && index === 3 ? "is-active" : ""}`} key={step}>
                <span className="kiosk-step-icon">{index === 0 ? "◉" : index === 1 ? "♙" : index === 2 ? "✓" : "◖"}</span>
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
    </section>
  );
}

function HoursBankScreen({ canEdit, onAction }: { canEdit: boolean; onAction: (action: string) => void }) {
  return (
    <>
      <Metrics />
      <Panel title="Banco de horas" subtitle="Saldos por colaborador e periodo">
        <EmployeesTable canEdit={canEdit} onAction={onAction} compact />
        {canEdit && (
          <ActionRow>
            <button className="primary-button" onClick={() => onAction("Fechamento do banco")} type="button">Fechar periodo</button>
            <button className="secondary-button" onClick={() => onAction("Abono de horas")} type="button">Registrar abono</button>
          </ActionRow>
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
        const [savedInFirebase, savedJustifications, savedAdjustments] = await Promise.all([
          listEmployees(companyId),
          listAttendanceJustifications(companyId),
          listPunchAdjustments(companyId),
        ]);
        if (!mounted) return;
        setEmployeesList(
          savedInFirebase.map((employee) =>
            toLocalEmployee(employee as unknown as Record<string, unknown>, employee.id),
          ),
        );
        setAttendanceJustifications(savedJustifications);
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

  async function generateMonthlyMirror() {
    if (!selectedEmployees.length) {
      onAction("Nenhum colaborador selecionado para gerar espelho mensal.");
      return;
    }

    const period = getMonthPeriod(Number(year), Number(month));
    const summaries = await Promise.all(
      selectedEmployees.map(async (employee) => {
        const punches = await listEmployeePunchesByIds(companyId, [
          employee.employeeId,
        ]);
        return buildMonthlyMirrorSummary(employee, punches, period, workPolicy, attendanceJustifications);
      }),
    );

    setLastSummary(summaries);
    openPrintableMonthlyMirror({
      company,
      generatedAt: new Date(),
      period,
      responsible,
      summaries,
      workPolicy,
    });
    onAction("Espelho mensal aberto para impressao. Use Salvar como PDF se quiser arquivar.");
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

  function exportMonthlyCsv() {
    if (!lastSummary.length) {
      onAction("Gere o espelho mensal antes de exportar para o contador.");
      return;
    }

    const rows = [
      ["Funcionario", "Matricula", "Periodo", "Dias", "Batidas", "Falta manha", "Falta tarde", "Batida incompleta", "Faltas calculadas", "Atrasos", "Banco", "Pendencias", "Responsavel"],
      ...lastSummary.map((summary) => [
        summary.employee.name,
        summary.employee.registration || "",
        summary.periodLabel,
        String(summary.rows.length),
        String(summary.totalPunches),
        String(summary.missingMornings),
        String(summary.missingAfternoons),
        String(summary.incompleteMornings + summary.incompleteAfternoons),
        String(summary.absencePoints),
        formatDurationClock(summary.lateMinutes),
        formatDurationClock(summary.totalBalanceMinutes),
        String(summary.pendingDays),
        responsible,
      ]),
    ];

    downloadTextFile(
      `espelho-ponto-contador-${year}-${month}.csv`,
      rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n"),
      "text/csv",
    );
    onAction("CSV mensal para contador gerado.");
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
          <button className="primary-button" disabled={loading} onClick={() => void generateMonthlyMirror()} type="button">Imprimir / salvar PDF</button>
          <button className="secondary-button" onClick={exportMonthlyCsv} type="button">Exportar para contador</button>
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
              "CSV mensal para importacao/conferencia",
              "PDF geral da empresa",
              "Ficha individual para ciencia do funcionario",
              "Historico de ajustes e abonos do periodo",
            ]}
          />
        </Panel>
      </TwoColumn>
    </>
  );
}

function ReportsScreen({ onAction }: { onAction: (action: string) => void }) {
  const companyId = useActiveCompanyId();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const [startDate, setStartDate] = useState(monthStart);
  const [endDate, setEndDate] = useState(today);
  const [exporting, setExporting] = useState(false);

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
            <select className="input">
              <option>Nenhum colaborador cadastrado</option>
            </select>
          </Field>
          <Field label="Inicio"><input className="input" onChange={(event) => setStartDate(event.target.value)} type="date" value={startDate} /></Field>
          <Field label="Fim"><input className="input" onChange={(event) => setEndDate(event.target.value)} type="date" value={endDate} /></Field>
          <Field label="Tipo"><select className="input"><option>Jornada detalhada</option><option>Espelho de ponto</option><option>Banco de horas</option></select></Field>
        </div>
        <ActionRow>
          <button className="primary-button" onClick={() => onAction("Geracao de PDF")} type="button">Gerar PDF</button>
          <button className="secondary-button" disabled={exporting} onClick={() => void exportFiscalFiles()} type="button">
            {exporting ? "Gerando..." : "Exportar AFD + AEJ"}
          </button>
        </ActionRow>
      </Panel>
      <ReportPreview />
    </>
  );
}

function AuditScreen({ onAction }: { onAction: (action: string) => void }) {
  return (
    <TwoColumn>
      <ComplianceCard />
      <Panel title="LGPD e consentimento" subtitle="Cuidados antes da biometria real">
        <CheckList items={["Consentimento destacado", "Base legal revisada", "Alternativa em caso de falha facial", "Retencao e descarte configuraveis", "Direitos do titular documentados"]} />
        <ActionRow>
          <button className="primary-button" onClick={() => onAction("Termo LGPD")} type="button">Gerar termo</button>
          <button className="secondary-button" onClick={() => onAction("Relatorio de impacto")} type="button">Relatorio de impacto</button>
        </ActionRow>
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
    Escalas: {
      title: "Jornadas e turnos",
      steps: [
        "Crie ou edite a jornada coletiva da empresa.",
        "Defina entrada, saida almoco, volta almoco e fim do dia.",
        "Configure tolerancia e percentual de hora extra.",
      ],
      questions: ["Como editar turno?", "Como funciona tolerancia?", "Qual regra vale para feriado?"],
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

function ReportPreview() {
  const journeyLabels = ["Data", "Dia", "Entrada", "Saída intervalo", "Retorno", "Saída final", "Trabalhadas", "Banco/Falta", "Ocorrência"];

  return (
    <section className="app-table-shell min-w-0">
      <div className="grid gap-3 border-b border-[#e3e8ee] p-5 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <p className="text-sm font-medium text-[#667085]">Relatorio de jornada detalhada</p>
          <h2 className="mt-1 text-xl font-semibold text-[#101923]">Periodo 01/06/2026 - 30/06/2026</h2>
        </div>
        <div className="grid gap-1 text-sm text-[#667085] lg:text-right">
          <span>Colaborador: selecione um colaborador</span>
          <span>Emitido por: usuario logado</span>
        </div>
      </div>

      <div className="grid gap-3 p-5 md:grid-cols-4">
        {[
          ["Horas previstas", "00:00"],
          ["Horas abonadas", "00:00"],
          ["Faltantes", "00:00"],
          ["Saldo final", "00:00"],
        ].map(([label, value]) => (
          <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={label}>
            <p className="text-xs font-semibold uppercase text-[#667085]">{label}</p>
            <strong className="mt-2 block text-lg text-[#101923]">{value}</strong>
          </div>
        ))}
      </div>

      <div className="grid gap-3 px-5 pb-5 md:grid-cols-4">
        {[
          ["Faltas manha", "0"],
          ["Faltas tarde", "0"],
          ["Esquecimentos", "0"],
          ["Trabalho externo", "0"],
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
              {["Data", "Dia", "Entrada", "Saida", "Retorno", "Saida", "Trabalhadas", "Banco/Falta", "Ocorrencia"].map((head, index) => (
                <th className="px-3 py-3 font-semibold" key={`${head}-${index}`}>{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {journeyRows.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-[#667085]" colSpan={9}>
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
    lunch_back: "Retorno",
    lunch_out: "Intervalo",
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
  const end = new Date(year, month, 0, 23, 59, 59, 999);
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
  const schedule = employee.schedule;
  return Math.max(0, minutesFromTime(schedule.breakStart) - minutesFromTime(schedule.start))
    + Math.max(0, minutesFromTime(schedule.end) - minutesFromTime(schedule.breakEnd));
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
    const punchesByType: Partial<Record<PunchType, Punch>> = {};
    dayPunches.forEach((punch) => {
      punchesByType[punch.type] = punch;
    });

    const isWorkday = date.getDay() !== 0 && date.getDay() <= scheduledWorkdays;
    const morningPunches = [punchesByType.entry, punchesByType.lunch_out].filter(Boolean).length;
    const afternoonPunches = [punchesByType.lunch_back, punchesByType.exit].filter(Boolean).length;
    const justifiedMorning = hasApprovedAbsenceJustification(justifications, employee.employeeId, date, "morning");
    const justifiedAfternoon = hasApprovedAbsenceJustification(justifications, employee.employeeId, date, "afternoon");
    const rawMissingMorning = isWorkday && morningPunches === 0;
    const rawMissingAfternoon = isWorkday && afternoonPunches === 0;
    const missingMorning = rawMissingMorning && !justifiedMorning;
    const missingAfternoon = rawMissingAfternoon && !justifiedAfternoon;
    const incompleteMorning = isWorkday && morningPunches === 1 && !justifiedMorning;
    const incompleteAfternoon = isWorkday && afternoonPunches === 1 && !justifiedAfternoon;
    const workedMinutes =
      workedPeriodMinutes(punchesByType.entry, punchesByType.lunch_out)
      + workedPeriodMinutes(punchesByType.lunch_back, punchesByType.exit);
    const lateMinutes =
      (hasApprovedLateJustification(justifications, employee.employeeId, date, "morning")
        ? 0
        : positiveDifference(punchesByType.entry, employee.schedule.start, workPolicy.toleranceMinutes))
      + (hasApprovedLateJustification(justifications, employee.employeeId, date, "afternoon")
        ? 0
        : positiveDifference(punchesByType.lunch_back, employee.schedule.breakEnd, workPolicy.toleranceMinutes));
    const earlyLeaveMinutes =
      earlyDifference(punchesByType.lunch_out, employee.schedule.breakStart, workPolicy.toleranceMinutes)
      + earlyDifference(punchesByType.exit, employee.schedule.end, workPolicy.toleranceMinutes);
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
      punches: punchesByType,
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
  const totalBalanceMinutes = rows.reduce((total, row) => total + row.balanceMinutes, 0);

  return {
    absencePoints,
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
  responsible,
  summaries,
  workPolicy,
}: {
  company: MainCompanyProfile | null;
  generatedAt: Date;
  period: MonthPeriod;
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
            <th>Entrada</th>
            <th>Saida almoco</th>
            <th>Retorno</th>
            <th>Saida</th>
            <th>Trabalhadas</th>
            <th>Banco</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${summary.rows.map((row) => `
            <tr>
              <td>${escapeHtml(row.label)}</td>
              <td>${escapeHtml(punchTime(row.punches.entry))}</td>
              <td>${escapeHtml(punchTime(row.punches.lunch_out))}</td>
              <td>${escapeHtml(punchTime(row.punches.lunch_back))}</td>
              <td>${escapeHtml(punchTime(row.punches.exit))}</td>
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

  const printWindow = window.open("", "_blank", "noopener,noreferrer,width=1100,height=800");
  if (!printWindow) return;
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
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
