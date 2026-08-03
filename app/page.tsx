"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { FaceCamera, type RecognizedFace } from "@/app/components/FaceCamera";
import { auth } from "@/lib/firebase/client";
import { getMainCompany, saveMainCompany, uploadMainCompanyLogo } from "@/lib/services/companies";
import type { Punch, PunchStatus, PunchType } from "@/lib/models";
import { createFaceIdRecord, uploadFacePhoto } from "@/lib/services/face-id";
import { listEmployees, upsertEmployee } from "@/lib/services/employees";
import { uploadPunchPhoto } from "@/lib/services/punch-photos";
import { createPunch, listEmployeePunchesByIds } from "@/lib/services/punches";
import { getStorageFileUrl } from "@/lib/services/storage-files";
import {
  acceptTenantInvite,
  consumeAiCredit,
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
  | "Batidas"
  | "Banco de horas"
  | "Fechamento mensal"
  | "Relatorios"
  | "LGPD e auditoria"
  | "Admin";

type MaskType = "name" | "cpf" | "cnpj" | "phone" | "time" | "pin" | "date" | "cep";
type EmployeeSection = "detail" | "face" | "form" | "list";

const employees: EmployeeRow[] = [];

type EmployeeRow = {
  admissionDate?: string;
  bank: string;
  cbo?: string;
  cpf: string;
  department?: string;
  employeeId?: string;
  faceIdStatus?: "not_registered" | "registered";
  lastPunch: string;
  name: string;
  phone?: string;
  pin?: string;
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
  faceIdStatus?: "not_registered" | "registered";
  journeyMode?: "collective" | "individual";
  name: string;
  phone?: string;
  pin?: string;
  registration?: string;
  role?: string;
};

const LOCAL_EMPLOYEES_KEY = "orquestracs-face-id-local-employees-v2";
const REQUIRED_FACE_CAPTURES = 3;

function getLocalEmployees() {
  try {
    return JSON.parse(window.localStorage.getItem(LOCAL_EMPLOYEES_KEY) || "[]") as LocalEmployee[];
  } catch {
    return [];
  }
}

function toLocalEmployee(employee: Record<string, unknown>, fallbackId: string): LocalEmployee {
  const schedule = (employee.schedule || {}) as LocalEmployee["schedule"];

  return {
    admissionDate: String(employee.admissionDate || "Nao informado"),
    bank: String(employee.bank || "00:00"),
    cbo: String(employee.cbo || ""),
    cpf: String(employee.cpf || "Nao informado"),
    department: String(employee.department || "Geral"),
    employeeId: String(employee.employeeId || employee.id || fallbackId),
    faceIdStatus: (employee.faceIdStatus || "not_registered") as LocalEmployee["faceIdStatus"],
    lastPunch: String(employee.lastPunch || "Sem batida hoje"),
    name: String(employee.name || "Colaborador sem nome"),
    phone: String(employee.phone || ""),
    pin: String(employee.pin || ""),
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
  "Admin",
  "Empresa",
  "Colaboradores",
  "Sala de ponto",
  "Banco de horas",
  "Fechamento mensal",
  "Relatorios",
  "LGPD e auditoria",
];

type MainCompanyProfile = Record<string, unknown> & {
  cnpj?: string;
  legalName?: string;
  logoUrl?: string;
  tradeName?: string;
};

const VANMART_INITIAL_COMPANY_PROFILE = {
  address: {
    city: "Ribeirao Branco",
    complement: "",
    district: "",
    number: "880",
    state: "SP",
    street: "Rua Capitao Elias Pereira",
    zipCode: "",
  },
  cnpj: "44.215.194/0001-18",
  contactEmail: "",
  contactName: "",
  contactPhone: "",
  legalName: "COMERCIO DE MADEIRAS VANMART LTDA",
  stateRegistration: "",
  tradeName: "Vanmart",
};

const auditLogs = [
  ["Original imutavel", "Batidas bloqueadas contra edicao direta"],
  ["Ajuste rastreado", "Responsavel, motivo e horario obrigatorios"],
  ["Prova digital", "Foto, PIN, IP, aparelho e hash por marcacao"],
  ["Relatorio mensal", "Espelho pronto para assinatura e conferencia"],
];

const monthlyClosingRows: string[][] = [];

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

function addMinutesToTime(value: string, amount: number) {
  const normalized = maskTime(value || "0000");
  const [hour = "0", minute = "0"] = normalized.split(":");
  const total = Number(hour) * 60 + Number(minute) + amount;
  const day = 24 * 60;
  const wrapped = ((total % day) + day) % day;
  const nextHour = Math.floor(wrapped / 60).toString().padStart(2, "0");
  const nextMinute = (wrapped % 60).toString().padStart(2, "0");

  return `${nextHour}:${nextMinute}`;
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
};

function getLocalRecords() {
  return JSON.parse(
    window.localStorage.getItem("orquestracs-face-id-local-records") || "[]",
  ) as LocalRecord[];
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
    .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));

  if (!punches.length) return "Entrada 1";

  const nextByLastPunch: Record<string, string | null> = {
    Entrada: "Saída 1",
    "Entrada 1": "Saída 1",
    "Saída almoço": "Entrada 2",
    "Saída 1": "Entrada 2",
    "Volta almoço": "Saída 2",
    "Entrada 2": "Saída 2",
    "Fim do dia": null,
    "Saída 2": null,
  };

  return nextByLastPunch[punches[0].fields.Tipo] ?? "Entrada 1";
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

  return {
    currentTime: now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    differenceMinutes,
    expectedTime,
    outsideTolerance: Math.abs(differenceMinutes) > schedule.toleranceMinutes,
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
  const [authLoading, setAuthLoading] = useState(true);
  const [accessLoading, setAccessLoading] = useState(true);
  const [appAccess, setAppAccess] = useState<TenantAccess | null>(null);
  const [currentDateTime, setCurrentDateTime] = useState("");
  const [companyProfile, setCompanyProfile] = useState<MainCompanyProfile | null>(null);
  const [inviteCode, setInviteCode] = useState("");
  const [saasConfig, setSaasConfig] = useState<TenantSaasConfig | null>(null);
  const [tenantInvites, setTenantInvites] = useState<TenantInvite[]>([]);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginMessage, setLoginMessage] = useState("");
  const [notice, setNotice] = useState("Sistema pronto. Cadastre empresa, usuarios e colaboradores para iniciar.");
  const [pin, setPin] = useState("");
  const [user, setUser] = useState<User | null>(null);

  async function refreshCompanyProfile() {
    const company = await getMainCompany();
    if (company) {
      setCompanyProfile(company as MainCompanyProfile);
      return;
    }

    await saveMainCompany(VANMART_INITIAL_COMPANY_PROFILE);
    setCompanyProfile(VANMART_INITIAL_COMPANY_PROFILE as MainCompanyProfile);
    setNotice("Dados iniciais da empresa salvos no Firebase.");
  }

  async function refreshAccess(currentUser: User) {
    setAccessLoading(true);
    try {
      const access = await getUserTenantAccess(currentUser);
      setAppAccess(access);
      if (access?.role === "developer") {
        const [invites, config] = await Promise.all([
          listTenantInvites(access.tenantId),
          getTenantSaasConfig(access.tenantId),
        ]);
        setTenantInvites(invites);
        setSaasConfig(config);
      }
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
      Batidas: "Registro por PIN, foto e evidencias",
      "Banco de horas": "Saldos, faltantes, extras e abonos",
      "Fechamento mensal": "Conferencia mensal para contador",
      Relatorios: "Espelho de ponto e jornada detalhada",
      "LGPD e auditoria": "Consentimento, logs e trilha inviolavel",
      Admin: "Controle interno, convites e permissoes",
    };

    return subtitles[active];
  }, [active]);

  function go(section: Section) {
    setActive(section);
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
        await saveMainCompany({
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
        });
        await refreshCompanyProfile();
        setNotice("Empresa salva no Firebase em companies/main.");
      } catch (error) {
        console.error(error);
        setNotice("Nao foi possivel salvar no Firebase. Verifique Auth/Regras do Firestore.");
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
        tenantId: appAccess?.tenantId || "main",
      });
      setTenantInvites((items) => [invite, ...items]);
      setNotice(`Convite criado: ${invite.code}. Envie esse codigo para o cliente.`);
      return;
    }

    if (action === "Salvar configuracao Admin SaaS") {
      const tenantId = appAccess?.tenantId || "main";
      const config = {
        aiCredits: {
          balance: Number(onlyDigits(fields["Creditos disponiveis"] || fields["Creditos mensais"] || "150")) || 150,
          included: Number(onlyDigits(fields["Creditos mensais"] || "150")) || 150,
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
      setNotice("Configuracao SaaS salva em tenants/main.");
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

  async function registerPunch(kind: string, employee?: RecognizedFace, exception?: PunchException, photoBlob?: Blob) {
    if (!employee && !pin.trim()) {
      setNotice("Informe um PIN para simular a batida.");
      return false;
    }

    const occurredAt = new Date();
    const serverRecordedAt = new Date();
    const employeeName = employee?.name || "Colaborador identificado por PIN";
    const employeeId = employee?.employeeId || `pin-${pin.trim()}`;
    const punchId = crypto.randomUUID();
    let photoPath = employee ? "face-id-local-profile" : "pending-storage-photo";

    if (photoBlob) {
      try {
        photoPath = await uploadPunchPhoto({
          blob: photoBlob,
          companyId: "main",
          employeeId,
          occurredAt,
          punchId,
        });
      } catch (error) {
        console.error(error);
        setNotice("A foto nao foi salva no Storage. A batida continuara com evidencia pendente.");
      }
    }

    const punchPayload = {
      companyId: "main",
      deviceId: "web-kiosk",
      employeeId,
      occurredAt: occurredAt.toISOString(),
      photoPath,
      source: employee ? "face_id" as const : "pin_photo" as const,
      status: (exception ? "outside_shift" : "on_time") as PunchStatus,
      type: mapPunchType(kind),
    };

    try {
      await createPunch("main", {
        ...punchPayload,
        hash: await createAuditHash(punchPayload),
        occurredAt,
        serverRecordedAt,
      });
    } catch (error) {
      console.error(error);
      setNotice("Nao foi possivel salvar a batida no Firebase. Verifique a conexao e tente novamente.");
      return false;
    }

    appendLocalRecord(`Batida: ${kind}`, "Sala de ponto", {
      Colaborador: employeeName,
      "ID do colaborador": employee?.employeeId || "Identificação por PIN",
      Horário: occurredAt.toISOString(),
      Método: employee ? "Face ID" : "PIN + foto",
      Tipo: kind,
      ...(exception
        ? {
            "Confirmação de exceção": "Sim",
            "Diferença": formatDurationClock(exception.differenceMinutes),
            "Horário previsto": exception.expectedTime,
          }
        : {}),
    });
    setNotice(
      `${employeeName}: ${kind.toLowerCase()} registrada às ${occurredAt.toLocaleTimeString("pt-BR")}.`,
    );
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
      <main className="grid min-h-screen place-items-center bg-[#f4f6f8] px-4 text-[#17202a]">
        <section className="w-full max-w-md rounded-lg border border-[#d9e0e7] bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#2d6c5d]">
            Orquestracs Face ID
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-[#101923]">Entrar no sistema</h1>
          <p className="mt-2 text-sm leading-6 text-[#667085]">
            Acesso restrito para usuarios convidados da empresa.
          </p>

          <div className="mt-6 grid gap-3">
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
  const visibleNavItems = navItems.filter((item) => item !== "Admin" || isDeveloperUser);
  const companyName =
    companyProfile?.tradeName || companyProfile?.legalName || "Empresa principal";
  const companyCnpj = companyProfile?.cnpj || "CNPJ nao cadastrado";

  return (
    <main className="min-h-screen bg-[#f4f6f8] text-[#17202a]">
      <div className="mx-auto grid max-w-[1480px] gap-6 px-4 py-4 lg:grid-cols-[292px_1fr] lg:px-6">
        <aside className="rounded-lg border border-[#d9e0e7] bg-[#101923] p-4 text-white shadow-sm lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)]">
          <div className="flex h-full flex-col">
            <div className="border-b border-white/10 pb-5">
              <div className="flex items-center gap-3">
                <img
                  alt="Orquestracs Face ID"
                  className="h-12 w-[180px] rounded-md bg-white object-contain p-1.5"
                  src="/orquestracs-face-id-logo.svg"
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

        <section className="grid gap-5">
          <header className="rounded-lg border border-[#d9e0e7] bg-white px-5 py-4 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#2d6c5d]">
                  Orquestracs Face ID
                </p>
                <h1 className="mt-1 text-2xl font-semibold text-[#101923]">
                  {title}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[#667085]">
                  Ponto inteligente com reconhecimento facial, auditoria e fechamento mensal.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                <div className="rounded-md border border-[#d9e0e7] bg-[#fbfcfd] px-3 py-2 text-right">
                  <p className="text-xs font-semibold uppercase text-[#667085]">Data e hora</p>
                  <p className="text-sm font-bold text-[#101923]">{currentDateTime}</p>
                </div>
                <button
                  className="secondary-button"
                  onClick={handleLogout}
                  type="button"
                >
                  Sair
                </button>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2 text-xs font-medium text-[#667085]">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#edf5f2] text-[11px] font-bold text-[#18594c]">
                i
              </span>
              <p className="leading-5">{notice}</p>
            </div>
          </header>

          {active === "Painel" && (
            <>
              <Metrics />
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_370px]">
                <PunchCard
                  onRegister={registerPunch}
                  pin={pin}
                  setPin={setPin}
                />
                <ComplianceCard />
              </div>
              <EmployeesTable onAction={demoAction} />
              <ReportPreview />
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
          {active === "Colaboradores" && <EmployeesScreen onAction={demoAction} />}
          {active === "Escalas" && <ShiftsScreen onAction={demoAction} />}
          {active === "Sala de ponto" && (
            <KioskScreen
              onAction={demoAction}
              onRegister={registerPunch}
              pin={pin}
              setPin={setPin}
            />
          )}
          {active === "Batidas" && (
            <PunchesScreen
              onAction={demoAction}
              onRegister={registerPunch}
              pin={pin}
              setPin={setPin}
            />
          )}
          {active === "Banco de horas" && <HoursBankScreen onAction={demoAction} />}
          {active === "Fechamento mensal" && <MonthlyClosingScreen onAction={demoAction} />}
          {active === "Relatorios" && <ReportsScreen onAction={demoAction} />}
          {active === "LGPD e auditoria" && <AuditScreen onAction={demoAction} />}
          {active === "Admin" && (
            <AdminScreen config={saasConfig} invites={tenantInvites} onAction={demoAction} />
          )}
        </section>
      </div>

      <button
        className="assistant-launcher"
        onClick={() => setAssistantOpen(true)}
        type="button"
      >
        Assistente Face ID
      </button>

      {assistantOpen && (
        <AssistantPanel
          active={active}
          config={saasConfig}
          onClose={() => setAssistantOpen(false)}
          onConsumeCredit={async () => {
            const tenantId = appAccess?.tenantId || "main";
            const updated = await consumeAiCredit(tenantId, 1);
            setSaasConfig(updated);
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
            void uploadMainCompanyLogo(file)
              .then(async () => {
                await refreshCompanyProfile();
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
  );
}

function Metrics() {
  const [dashboardMetrics, setDashboardMetrics] = useState([
    ["Colaboradores", "0", "cadastros carregados"],
    ["Face ID", "0", "cadastros prontos"],
    ["Batidas hoje", "0", "registros locais do dia"],
    ["Pendencias", "0", "Face ID pendente"],
  ]);

  useEffect(() => {
    const employeesList = getLocalEmployees();
    const today = new Date().toDateString();
    const todayPunches = getLocalRecords().filter((record) => {
      const timestamp = record.fields["Horário"] || record.fields["HorÃ¡rio"] || record.savedAt;
      return record.action.startsWith("Batida:") && new Date(timestamp).toDateString() === today;
    });
    const faceReady = employeesList.filter((employee) => employee.faceIdStatus === "registered").length;
    const pendingFace = employeesList.filter((employee) => employee.faceIdStatus !== "registered").length;

    setDashboardMetrics([
      ["Colaboradores", String(employeesList.length), "cadastros na base"],
      ["Face ID", String(faceReady), "cadastros prontos"],
      ["Batidas hoje", String(todayPunches.length), "registros do dia"],
      ["Pendencias", String(pendingFace), "Face ID pendente"],
    ]);
  }, []);

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {dashboardMetrics.map(([label, value, detail]) => (
        <div className="rounded-lg border border-[#d9e0e7] bg-white p-4 shadow-sm" key={label}>
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium text-[#667085]">{label}</p>
            <span className="h-2 w-2 rounded-full bg-[#2d6c5d]" />
          </div>
          <strong className="mt-4 block text-2xl font-semibold text-[#101923]">{value}</strong>
          <span className="mt-1 block text-xs text-[#7c8895]">{detail}</span>
        </div>
      ))}
    </div>
  );
}

function PunchCard({
  onRegister,
  pin,
  setPin,
}: {
  onRegister: (kind: string, employee?: RecognizedFace, exception?: PunchException, photoBlob?: Blob) => Promise<boolean>;
  pin: string;
  setPin: (value: string) => void;
}) {
  return (
    <section className="rounded-lg border border-[#d9e0e7] bg-white p-5 shadow-sm">
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
    <section className="rounded-lg border border-[#d9e0e7] bg-white p-5 shadow-sm">
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
              <select className="input">
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
              <select className="input">
                <option>Obrigatoria</option>
                <option>Opcional</option>
                <option>Bloqueada</option>
              </select>
            </Field>
            <Field label="Valor falta manha"><input className="input" placeholder="1" /></Field>
            <Field label="Valor falta tarde"><input className="input" placeholder="1" /></Field>
            <Field label="Valor falta dia inteiro"><input className="input" placeholder="2" /></Field>
            <Field label="Trabalho externo">
              <select className="input">
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

function EmployeesScreen({ onAction }: { onAction: (action: string) => void }) {
  const [journeyMode, setJourneyMode] = useState<"coletiva" | "individual">("coletiva");
  const emptyEmployeeForm = {
    admissionDate: "",
    cbo: "",
    cpf: "",
    department: "",
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
  const [openEmployeeSections, setOpenEmployeeSections] = useState<Record<EmployeeSection, boolean>>({
    detail: false,
    face: false,
    form: false,
    list: true,
  });
  const [showFaceCamera, setShowFaceCamera] = useState(false);
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
      const punches = await listEmployeePunchesByIds("main", [
        employee.employeeId,
        employee.pin ? `pin-${employee.pin}` : "",
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
        const savedInFirebase = await listEmployees("main");
        if (!mounted) return;

        const mapped = savedInFirebase.map((employee) =>
          toLocalEmployee(employee as unknown as Record<string, unknown>, employee.id),
        );
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
  }, []);

  useEffect(() => {
    localEmployees.forEach((employee) => {
      if (!employee.profilePhotoPath || employeePhotoUrls[employee.employeeId]) return;

      void getStorageFileUrl(employee.profilePhotoPath)
        .then((url) => setEmployeePhotoUrls((current) => ({ ...current, [employee.employeeId]: url })))
        .catch(() => undefined);
    });
  }, [employeePhotoUrls, localEmployees]);

  function updateEmployeeForm(field: keyof typeof employeeForm, value: string) {
    setEmployeeForm((current) => ({ ...current, [field]: value }));
  }

  function startNewEmployee() {
    setEmployeeForm(emptyEmployeeForm);
    setEditingEmployeeId(null);
    setSelectedEmployee(null);
    setShowFaceCamera(false);
    setOpenEmployeeSections({ detail: false, face: false, form: true, list: true });
    onAction("Novo colaborador: formulario limpo para cadastro.");
    document.getElementById("employee-form-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function cancelEmployeeEdit() {
    setEmployeeForm(emptyEmployeeForm);
    setEditingEmployeeId(null);
    setShowFaceCamera(false);
    setEmployeeSection("form", false);
    onAction("Edicao cancelada. Nenhuma alteracao foi salva.");
  }

  function startFaceRegistration(employee?: EmployeeRow) {
    const target = employee
      ? toLocalEmployee(employee as unknown as Record<string, unknown>, employee.employeeId || employee.name)
      : facePendingEmployees[0];

    if (!target) {
      onAction("Todos os colaboradores ja estao com Face ID cadastrado.");
      return;
    }

    setSelectedEmployee(target);
    setEditingEmployeeId(null);
    setShowFaceCamera(true);
    setOpenEmployeeSections({ detail: false, face: true, form: false, list: true });
    onAction(`Cadastro de Face ID iniciado para ${target.name}.`);
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
    const selected = toLocalEmployee(employee as unknown as Record<string, unknown>, employee.employeeId || employee.name);
    setSelectedEmployee(selected);
    setEditingEmployeeId(employeeDocumentId(selected));
    setShowFaceCamera(false);
    setOpenEmployeeSections({ detail: false, face: false, form: true, list: true });
    setEmployeeForm({
      admissionDate: selected.admissionDate || "",
      cbo: selected.cbo || "",
      cpf: selected.cpf === "Nao informado" ? "" : selected.cpf,
      department: selected.department || "",
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
            faceIdStatus: employee.faceIdStatus || "not_registered",
            lastPunch: "Sem batida hoje",
            name: employee.name.trim(),
            phone: employee.phone || "",
            pin: employee.pin || "",
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

        await Promise.all(
          mappedEmployees.map((employee) =>
            upsertEmployee("main", employeeDocumentId(employee), {
              ...employee,
              importSource: "holerite",
              importedAt: new Date().toISOString(),
            }),
          ),
        );

        const existingIds = new Set(mappedEmployees.map((employee) => employeeDocumentId(employee)));
        const updated = [
          ...mappedEmployees,
          ...localEmployees.filter((employee) => !existingIds.has(employeeDocumentId(employee))),
        ];
        window.localStorage.setItem(LOCAL_EMPLOYEES_KEY, JSON.stringify(updated));
        setLocalEmployees(updated);
        setSelectedEmployee(mappedEmployees[0]);
        onAction(`${mappedEmployees.length} colaboradores salvos no Firebase para revisao.`);
      } catch {
        onAction("Nao foi possivel importar os colaboradores. Verifique login e permissoes.");
      }
    };

    reader.readAsText(file);
  }

  async function saveEmployee() {
    if (!employeeForm.name.trim() || employeeForm.pin.length < 4) {
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
      admissionDate: employeeForm.admissionDate || "Nao informado",
      bank: "00:00",
      cbo: employeeForm.cbo || "",
      cpf: employeeForm.cpf || "Não informado",
      department: employeeForm.department || "Geral",
      employeeId: editingEmployeeId || crypto.randomUUID(),
      faceIdStatus: selectedEmployee?.faceIdStatus || "not_registered",
      lastPunch: "Sem batida hoje",
      name: employeeForm.name.trim(),
      phone: employeeForm.phone || "",
      pin: employeeForm.pin,
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

    await upsertEmployee("main", documentId, {
      ...employee,
      ...(editingEmployeeId ? {} : { createdAt: new Date().toISOString() }),
      source: "manual",
    });

    window.localStorage.setItem(LOCAL_EMPLOYEES_KEY, JSON.stringify(updated));
    setLocalEmployees(updated);
    setSelectedEmployee(employee);
    setEditingEmployeeId(documentId);
    setShowFaceCamera(false);
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
    if (!file || !selectedEmployee) return;

    if (!file.type.startsWith("image/")) {
      onAction("Escolha um arquivo de imagem para a foto do colaborador.");
      return;
    }

    try {
      const photoPath = await uploadFacePhoto({
        blob: file,
        companyId: "main",
        employeeId: selectedEmployee.employeeId,
        photoId: `perfil-${crypto.randomUUID()}`,
      });
      updateEmployeeProfilePhoto(selectedEmployee, photoPath, URL.createObjectURL(file));
      await upsertEmployee("main", employeeDocumentId(selectedEmployee), { profilePhotoPath: photoPath });
      onAction(`Foto de ${selectedEmployee.name} atualizada.`);
    } catch (error) {
      console.error(error);
      onAction("Nao foi possivel salvar a foto do colaborador. Verifique Storage e permissao.");
    }
  }

  function markFaceRegistered(captureCount: number, photoBlob?: Blob) {
    if (!selectedEmployee) return;
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
    setSelectedEmployee(completed && nextPending ? nextPending : current);
    if (current) {
      void upsertEmployee("main", employeeDocumentId(current), {
        faceCaptureCount: captureCount,
        faceIdStatus: completed ? "registered" : current.faceIdStatus,
        ...(completed ? { faceRegisteredAt: new Date().toISOString(), status: "Face ID cadastrado" } : { status: `Face ID ${captureCount}/${REQUIRED_FACE_CAPTURES}` }),
      });

      if (photoBlob) {
        void uploadFacePhoto({
          blob: photoBlob,
          companyId: "main",
          employeeId: current.employeeId,
          photoId: captureId,
        }).then((photoPath) => {
          updateEmployeeProfilePhoto(current, photoPath, URL.createObjectURL(photoBlob));
          void upsertEmployee("main", employeeDocumentId(current), { profilePhotoPath: photoPath });
          void createFaceIdRecord({
            capturedBy: "web-kiosk",
            companyId: "main",
            consentAcceptedAt: new Date(),
            createdAt: new Date(),
            employeeId: current.employeeId,
            photoPath,
          });
        });
      }
    }

    if (completed) {
      onAction(
        nextPending
          ? `${selectedEmployee.name}: Face ID concluido. Proximo: ${nextPending.name}.`
          : `${selectedEmployee.name}: Face ID concluido. Todos os pendentes foram finalizados.`,
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
          <MaskedField label="PIN" mask="pin" onChange={(value) => updateEmployeeForm("pin", value)} placeholder="0000" value={employeeForm.pin} />
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
          <SaveButton onClick={saveEmployee}>{editingEmployeeId ? "Salvar alteracoes" : "Cadastrar colaborador"}</SaveButton>
          {editingEmployeeId && (
            <button className="secondary-button" onClick={cancelEmployeeEdit} type="button">Cancelar edicao</button>
          )}
          <button className="secondary-button" onClick={() => startFaceRegistration(selectedEmployee || undefined)} type="button">Cadastrar Face ID do selecionado</button>
          <label className="secondary-button cursor-pointer">
            Importar holerite JSON
            <input
              accept="application/json"
              className="hidden"
              onChange={(event) => importEmployeesFromJson(event.target.files?.[0])}
              type="file"
            />
          </label>
        </ActionRow>
        {false && showFaceCamera && selectedEmployee && (
          <div className="mt-5 grid gap-4 rounded-lg border border-[#cfe3dc] bg-[#101923] p-4 text-white lg:grid-cols-[minmax(0,1fr)_280px]">
            <FaceCamera
              compact
              employee={{
                employeeId: selectedEmployee!.employeeId,
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
              <button className="primary-button" onClick={() => startFaceRegistration()} type="button">Iniciar proximo pendente</button>
              {selectedEmployee && (
                <button className="secondary-button" onClick={() => startFaceRegistration(selectedEmployee)} type="button">Capturar selecionado</button>
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
        {showFaceCamera && selectedEmployee && (
          <div className="mt-5 grid gap-4 rounded-lg border border-[#cfe3dc] bg-[#101923] p-4 text-white lg:grid-cols-[minmax(0,1fr)_280px]">
            <FaceCamera
              compact
              employee={{
                employeeId: selectedEmployee!.employeeId,
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
                Faca pelo menos {REQUIRED_FACE_CAPTURES} capturas com boa luz. O sistema avanca para o proximo pendente quando concluir.
              </p>
              <p className="mt-3 text-xs font-semibold text-white">
                Status: {selectedEmployee!.faceIdStatus === "registered" ? "Face ID cadastrado" : "Aguardando captura"}
              </p>
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
              <label className="secondary-button mt-3 inline-flex cursor-pointer items-center">
                Alterar foto
                <input
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => void changeEmployeePhoto(event.target.files?.[0])}
                  type="file"
                />
              </label>
            </div>
          </div>
          <div id="employee-detail-panel" className="grid gap-3 md:grid-cols-4">
            {[
              ["Nome", selectedEmployee.name],
              ["Matricula", selectedEmployee.registration || "-"],
              ["PIN", selectedEmployee.pin ? `${selectedEmployee.pin} - pronto` : "Pendente"],
              ["CPF", selectedEmployee.cpf || "-"],
              ["Admissao", selectedEmployee.admissionDate || "-"],
              ["Cargo", selectedEmployee.role || "-"],
              ["Departamento", selectedEmployee.department || "-"],
              ["CBO", selectedEmployee.cbo || "-"],
              ["Jornada", selectedEmployee.shift || "-"],
              ["Face ID", selectedEmployee.faceIdStatus === "registered" ? "Cadastrado" : "Pendente"],
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
            <button className="secondary-button" onClick={() => startFaceRegistration(selectedEmployee)} type="button">Cadastrar Face ID</button>
            <label className="secondary-button cursor-pointer">
              Alterar foto
              <input
                accept="image/*"
                className="hidden"
                onChange={(event) => void changeEmployeePhoto(event.target.files?.[0])}
                type="file"
              />
            </label>
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

function ShiftsScreen({ onAction }: { onAction: (action: string) => void }) {
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
            <SaveButton onClick={saveShift}>Salvar alteracoes</SaveButton>
            <button className="secondary-button" onClick={() => onAction("Previa de calculo do turno")} type="button">Ver calculo</button>
          </ActionRow>
        </Panel>
        <Panel title="Regras trabalhistas" subtitle="Base visual do calculo">
          <CheckList items={["Horas extras em dias uteis configuraveis", "Feriados e DSR: regra separada", "Banco por vigencia mensal", "Folga e feriado como ocorrencia"]} />
        </Panel>
      </TwoColumn>

      <Panel title="Turnos cadastrados" subtitle="Selecione um turno para editar">
        <div className="overflow-x-auto">
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
  onRegister: (kind: string, employee?: RecognizedFace, exception?: PunchException, photoBlob?: Blob) => Promise<boolean>;
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

function KioskScreen({
  onAction,
  onRegister,
  pin,
  setPin,
}: {
  onAction: (action: string) => void;
  onRegister: (kind: string, employee?: RecognizedFace, exception?: PunchException, photoBlob?: Blob) => Promise<boolean>;
  pin: string;
  setPin: (value: string) => void;
}) {
  const [recognizedEmployee, setRecognizedEmployee] = useState<RecognizedFace | null>(null);
  const [selectedPunch, setSelectedPunch] = useState("Entrada 1");
  const [journeyFinished, setJourneyFinished] = useState(false);
  const [timingWarning, setTimingWarning] = useState<PunchException | null>(null);
  const [recognizedPhoto, setRecognizedPhoto] = useState<Blob | undefined>();
  const [blockingMessage, setBlockingMessage] = useState("");
  const [kioskDetailsOpen, setKioskDetailsOpen] = useState(false);
  const [pinFallbackOpen, setPinFallbackOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    employeeName: string;
    time: string;
    type: string;
  } | null>(null);
  const confirmPanelRef = useRef<HTMLDivElement>(null);
  const resetTimerRef = useRef<number | null>(null);

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

  function identifyFace(employee: RecognizedFace, photoBlob?: Blob) {
    const nextPunch = inferNextPunch(employee.employeeId);
    setTimingWarning(null);
    setBlockingMessage("");
    setRecognizedPhoto(photoBlob);
    setRecognizedEmployee(employee);
    setJourneyFinished(nextPunch === null);
    if (employee.punchMode !== "manual" && nextPunch) setSelectedPunch(nextPunch);
    onAction(`${employee.name} reconhecido experimentalmente neste aparelho`);
    if (nextPunch === null) {
      speak(`${employee.name}, jornada encerrada.`);
    } else if (employee.punchMode === "manual") {
      speak(`${employee.name}, escolha a marcação.`);
    } else {
      speak(`${employee.name}. ${nextPunch}. Confirme.`);
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
      };
      setTimingWarning(warning);
      const direction = timing.differenceMinutes < 0 ? "antes" : "depois";
      speak(`${selectedPunch} fora do horário. ${formatDurationSpeech(timing.differenceMinutes)} ${direction}. Confirme novamente.`);
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
    speak(`${selectedPunch} registrada com sucesso, ${recognizedEmployee.name}, às ${time}.`);

    resetTimerRef.current = window.setTimeout(() => {
      setConfirmation(null);
      setRecognizedEmployee(null);
      setSelectedPunch("Entrada 1");
      setJourneyFinished(false);
      setTimingWarning(null);
      setRecognizedPhoto(undefined);
      setBlockingMessage("");
    }, 6000);
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

  return (
    <section className="kiosk-screen rounded-lg border border-[#d9e0e7] bg-[#101923] p-4 text-white shadow-sm md:p-5">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4 md:p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#b7d7ce]">
                Sala de ponto
              </p>
              <h2 className="mt-2 text-xl font-semibold md:text-2xl">Tablet em modo reconhecimento</h2>
              <p className="mt-1 text-sm text-white/60">
                Funcionarios chegam, ficam em frente a camera e confirmam a presenca.
              </p>
            </div>
            <span className="w-fit rounded-full bg-[#dcebe6] px-3 py-1 text-xs font-bold text-[#143f37]">
              Camera ativa
            </span>
          </div>

          <div className="mt-4">
            <FaceCamera onRecognized={identifyFace} onStatus={onAction} />
            <p className="mt-3 text-center text-sm text-white/55">
              {recognizedEmployee
                ? `${recognizedEmployee.name} reconhecido - pronto para confirmar a batida`
                : "Teste experimental: cadastre e reconheça o rosto neste aparelho"}
            </p>
          </div>
        </div>

        <aside className="grid content-start gap-3">
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4 md:p-5" ref={confirmPanelRef}>
            <p className="text-lg font-semibold text-white">
              {manualSelection ? "Escolha a marcação" : "Marcação identificada"}
            </p>
            <div className="mt-4 grid gap-3">
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
                <div className="rounded-xl border-2 border-[#7ee2c4] bg-[#dcebe6] p-5 text-center text-[#143f37]">
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
                  <p className="mt-2 text-xl font-black">HORÁRIO DIFERENTE</p>
                  <p className="mt-3 text-base font-bold">
                    Previsto: {timingWarning.expectedTime} • Agora: {timingWarning.currentTime}
                  </p>
                  <p className="mt-2 text-sm">
                    {formatDurationShort(Math.abs(timingWarning.differenceMinutes))}{" "}
                    {timingWarning.differenceMinutes < 0 ? "antes" : "depois"} do horário.
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
                className="min-h-16 rounded-xl bg-[#38c793] px-5 text-lg font-black text-[#082c22] shadow-lg transition hover:-translate-y-0.5 hover:bg-[#45d8a2] disabled:cursor-not-allowed disabled:bg-[#52616f] disabled:text-white/50 disabled:hover:translate-y-0"
                disabled={!recognizedEmployee || journeyFinished || Boolean(confirmation) || Boolean(blockingMessage)}
                onClick={() => void confirmPunch()}
                type="button"
              >
                {timingWarning ? "⚠ CONFIRMAR MESMO ASSIM" : "✓ CONFIRMAR PONTO"}
              </button>
              {recognizedEmployee && !confirmation && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    className="secondary-button border-white/25 bg-white/[0.06] text-white hover:bg-white/10"
                    onClick={() => resetRecognition()}
                    type="button"
                  >
                    Cancelar
                  </button>
                  <button
                    className="secondary-button border-[#f5b942] bg-[#fff4d6] text-[#6b4500] hover:bg-[#ffe8a6]"
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
            <div aria-live="assertive" className="rounded-xl border-4 border-[#7ee2c4] bg-[#dff8ee] p-6 text-center text-[#0b4939] shadow-lg">
              <span aria-hidden="true" className="block text-6xl">✓</span>
              <p className="mt-3 text-2xl font-black">PONTO REGISTRADO</p>
              <p className="mt-2 text-lg font-bold">{confirmation.employeeName}</p>
              <p className="mt-1 text-base">{confirmation.type} • {confirmation.time}</p>
            </div>
          )}

          <div className="rounded-lg border border-white/10 bg-white text-[#17202a]" id="kiosk-pin-fallback">
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

          <div className="rounded-lg border border-[#cfe3dc] bg-[#f1faf7] text-[#24594d]">
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
        </aside>
      </div>
    </section>
  );
}

function HoursBankScreen({ onAction }: { onAction: (action: string) => void }) {
  return (
    <>
      <Metrics />
      <Panel title="Banco de horas" subtitle="Saldos por colaborador e periodo">
        <EmployeesTable onAction={onAction} compact />
        <ActionRow>
          <button className="primary-button" onClick={() => onAction("Fechamento do banco")} type="button">Fechar periodo</button>
          <button className="secondary-button" onClick={() => onAction("Abono de horas")} type="button">Registrar abono</button>
        </ActionRow>
      </Panel>
    </>
  );
}

function MonthlyClosingScreen({ onAction }: { onAction: (action: string) => void }) {
  return (
    <>
      <Panel title="Fechamento mensal" subtitle="Conferencia antes de enviar para o contador">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Mes"><select className="input"><option>Junho</option><option>Julho</option><option>Agosto</option></select></Field>
          <Field label="Ano"><input className="input" placeholder="2026" /></Field>
          <Field label="Status"><select className="input"><option>Em conferencia</option><option>Fechado</option><option>Reaberto</option></select></Field>
          <Field label="Responsavel"><input className="input" placeholder="Nome do responsavel" /></Field>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-5">
          {[
            ["Funcionarios", "0"],
            ["Faltas manha", "0"],
            ["Faltas tarde", "0"],
            ["Atrasos", "00:00"],
            ["Ajustes", "0"],
          ].map(([label, value]) => (
            <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={label}>
              <p className="text-xs font-semibold uppercase text-[#667085]">{label}</p>
              <strong className="mt-2 block text-lg text-[#101923]">{value}</strong>
            </div>
          ))}
        </div>

        <ActionRow>
          <button className="primary-button" onClick={() => onAction("Folha mensal para contador")} type="button">Gerar folha do contador</button>
          <button className="secondary-button" onClick={() => onAction("Ficha individual de ciencia")} type="button">Ficha para assinatura</button>
          <button className="secondary-button" onClick={() => onAction("Fechamento mensal bloqueado")} type="button">Fechar mes</button>
        </ActionRow>
      </Panel>

      <Panel title="Conferencia por funcionario" subtitle="Base do arquivo mensal e da ficha individual">
        <div className="overflow-x-auto">
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
                  "Atrasos",
                  "Banco",
                  "Observacao",
                ].map((head) => (
                  <th className="px-4 py-3 font-semibold" key={head}>{head}</th>
                ))}
              </tr>
          </thead>
          <tbody>
            {monthlyClosingRows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-[#667085]" colSpan={9}>
                  Nenhum fechamento mensal gerado ainda.
                </td>
              </tr>
            ) : (
              monthlyClosingRows.map((row) => (
                  <tr className="border-b border-[#e3e8ee]" key={`${row[0]}-${row[1]}`}>
                    {row.map((cell, index) => (
                      <td
                        className={`px-4 py-3 ${index === 0 ? "font-semibold text-[#101923]" : "text-[#667085]"}`}
                        key={`${row[0]}-${cell}-${index}`}
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
  return (
    <>
      <Panel title="Gerar relatorio" subtitle="Espelho de ponto e jornada detalhada">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Colaborador">
            <select className="input">
              <option>Nenhum colaborador cadastrado</option>
            </select>
          </Field>
          <Field label="Inicio"><input className="input" placeholder="01/06/2026" /></Field>
          <Field label="Fim"><input className="input" placeholder="30/06/2026" /></Field>
          <Field label="Tipo"><select className="input"><option>Jornada detalhada</option><option>Espelho de ponto</option><option>Banco de horas</option></select></Field>
        </div>
        <ActionRow>
          <button className="primary-button" onClick={() => onAction("Geracao de PDF")} type="button">Gerar PDF</button>
          <button className="secondary-button" onClick={() => onAction("Exportacao fiscal")} type="button">Exportar fiscal</button>
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

function AdminScreen({
  config,
  invites,
  onAction,
}: {
  config: TenantSaasConfig | null;
  invites: TenantInvite[];
  onAction: (action: string) => void;
}) {
  const effectiveConfig: TenantSaasConfig = config || {
    aiCredits: { balance: 150, included: 150, status: "Ativo", used: 0 },
    billing: { amount: "R$ 0,00", dueDate: "", graceDays: 5, status: "Teste" },
    employeeLimit: 25,
    name: "Cliente Face ID",
    plan: "Essencial",
    status: "Teste",
    tenantId: "main",
  };

  const pendingInvites = invites.filter((invite) => invite.status === "Ativo").length;
  const remainingCredits = effectiveConfig.aiCredits.balance;
  const usedCredits = effectiveConfig.aiCredits.used;

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
            <div className="overflow-x-auto">
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
          <button className="secondary-button" onClick={() => onAction("Auditoria global")} type="button">
            Logs globais
          </button>
          <button className="secondary-button" onClick={() => onAction("Bloqueio de cliente")} type="button">
            Bloquear cliente
          </button>
        </ActionRow>
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

  useEffect(() => {
    setSelectedQuestion(current.questions[0]);
    setAssistantMessage("");
  }, [active, current.questions]);

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
              <p className="font-semibold">{selectedQuestion}</p>
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
  embedded = false,
  employeesList = employees,
  onAction,
  onEdit,
  onNew,
  onView,
  photoUrls = {},
  compact = false,
}: {
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
          <button className="secondary-button w-fit" onClick={() => (onNew ? onNew() : onAction("Novo colaborador"))} type="button">Novo colaborador</button>
        </div>
      )}
      <div className="overflow-x-auto">
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
                        : employee.pin
                          ? "PIN pronto - Face ID pendente"
                          : employee.status}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                  <div className="flex gap-2">
                    <button className="mini-button" onClick={() => (onEdit ? onEdit(employee) : onAction(`Editar ${employee.name}`))} type="button">Editar</button>
                    <button className="mini-button" onClick={() => (onView ? onView(employee) : onAction(`Ver ${employee.name}`))} type="button">Ver</button>
                  </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );

  if (embedded) {
    return <div className="overflow-hidden rounded-md border border-[#e3e8ee]">{tableContent}</div>;
  }

  return (
    <section className="rounded-lg border border-[#d9e0e7] bg-white shadow-sm">
      {tableContent}
    </section>
  );
}

function ReportPreview() {
  return (
    <section className="rounded-lg border border-[#d9e0e7] bg-white shadow-sm">
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

      <div className="overflow-x-auto px-5 pb-5">
        <table className="w-full min-w-[840px] border-collapse text-left text-sm">
          <thead className="bg-[#101923] text-xs uppercase text-white">
            <tr>
              {["Data", "Dia", "Entrada", "Saida", "Retorno", "Saida", "Trabalhadas", "Banco/Falta", "Ocorrencia"].map((head) => (
                <th className="px-3 py-3 font-semibold" key={head}>{head}</th>
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
    <section className="rounded-lg border border-[#d9e0e7] bg-white shadow-sm">
      <button
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-[#f8fafb]"
        onClick={onToggle}
        type="button"
      >
        <span>
          <span className="block text-sm font-medium text-[#667085]">{subtitle}</span>
          <span className="mt-1 block text-xl font-semibold text-[#101923]">{title}</span>
        </span>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-[#d9e0e7] bg-[#fbfcfd] text-lg font-semibold text-[#26323f]">
          {isOpen ? "-" : "+"}
        </span>
      </button>
      {isOpen && <div className="border-t border-[#e3e8ee] p-5">{children}</div>}
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
    <section className="rounded-lg border border-[#d9e0e7] bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-[#667085]">{subtitle}</p>
      <h2 className="mt-1 text-xl font-semibold text-[#101923]">{title}</h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <label className="grid gap-2 text-sm font-semibold text-[#26323f]">
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
    if (!onChange && controlledValue !== undefined) {
      setInternalValue(controlledValue);
    }
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
    on_time: "No horario",
    outside_shift: "Fora da jornada",
    possible_forgotten: "Possivel esquecimento",
  };
  return labels[status];
}

async function createAuditHash(payload: Record<string, unknown>) {
  const value = JSON.stringify(payload);
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
  return <div className="mt-5 flex flex-wrap gap-2">{children}</div>;
}

function CheckList({ items }: { items: string[] }) {
  return (
    <div className="grid gap-3">
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
  return <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_370px]">{children}</div>;
}
