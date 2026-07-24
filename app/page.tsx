"use client";

import { useEffect, useMemo, useState } from "react";

type Section =
  | "Painel"
  | "Empresa"
  | "Colaboradores"
  | "Escalas"
  | "Sala de ponto"
  | "Batidas"
  | "Banco de horas"
  | "Relatorios"
  | "LGPD e auditoria"
  | "Admin";

type MaskType = "name" | "cpf" | "cnpj" | "phone" | "time" | "pin" | "date" | "cep";

const employees = [
  {
    name: "Elivelton Aparecido",
    cpf: "471.073.068-71",
    role: "Instalador de som",
    shift: "08h as 18h",
    status: "Em jornada",
    bank: "+02:07",
    lastPunch: "15:07 - retorno",
  },
  {
    name: "Fatima Luana",
    cpf: "542.203.118-07",
    role: "Auxiliar administrativo",
    shift: "08h as 18h",
    status: "Intervalo",
    bank: "+04:59",
    lastPunch: "12:03 - saida",
  },
  {
    name: "Gideao do Amaral",
    cpf: "570.853.648-90",
    role: "Vendedor",
    shift: "09h as 19h",
    status: "Pendente",
    bank: "+04:17",
    lastPunch: "Sem batida hoje",
  },
  {
    name: "Julia Roberta",
    cpf: "000.000.000-00",
    role: "Movimentador financeiro",
    shift: "09h as 19h",
    status: "Ajuste RH",
    bank: "-01:10",
    lastPunch: "Marcacao incluida",
  },
];

const journeyRows = [
  ["01/06/26", "Seg", "08:00", "13:03", "15:07", "18:00", "07:56", "00:00", "Normal"],
  ["02/06/26", "Ter", "--", "11:30", "13:00", "17:15", "08:45", "00:00", "Esquec. entrada"],
  ["04/06/26", "Qui", "--", "--", "13:00", "17:15", "04:15", "1 falta", "Falta manha"],
  ["10/06/26", "Qua", "07:00", "11:30", "--", "--", "04:30", "1 falta", "Falta tarde"],
  ["15/06/26", "Seg", "--", "--", "--", "--", "00:00", "2 faltas", "Falta integral"],
  ["19/06/26", "Sex", "07:00G", "11:30G", "13:00G", "17:15G", "08:45", "Externo", "Gestor"],
];

const navItems: Section[] = [
  "Painel",
  "Empresa",
  "Colaboradores",
  "Escalas",
  "Sala de ponto",
  "Batidas",
  "Banco de horas",
  "Relatorios",
  "LGPD e auditoria",
  "Admin",
];

const auditLogs = [
  ["Original imutavel", "Batidas bloqueadas contra edicao direta"],
  ["Ajuste rastreado", "Responsavel, motivo e horario obrigatorios"],
  ["Prova digital", "Foto, PIN, IP, aparelho e hash por marcacao"],
  ["Relatorio mensal", "Espelho pronto para assinatura e conferencia"],
];

const metrics = [
  ["Colaboradores", "10", "ativos neste mes"],
  ["Horas previstas", "200:00", "48 horas semanais"],
  ["Horas trabalhadas", "185:24", "total consolidado"],
  ["Saldo do banco", "+02:07", "periodo 01/06 a 30/06"],
];

const initialShifts = [
  {
    name: "Escala 07h as 17h15",
    weeklyHours: "48:00",
    start: "07:00",
    end: "17:15",
    breakStart: "11:30",
    breakEnd: "13:00",
    days: "6",
    tolerance: "10 min",
    extraPercent: "60%",
  },
  {
    name: "Escala 09h as 19h",
    weeklyHours: "48:00",
    start: "09:00",
    end: "19:00",
    breakStart: "13:00",
    breakEnd: "15:00",
    days: "6",
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

export default function Home() {
  const [active, setActive] = useState<Section>("Painel");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [currentDateTime, setCurrentDateTime] = useState("");
  const [notice, setNotice] = useState("Modo demonstrativo: nenhum dado sera enviado ao Firebase.");
  const [pin, setPin] = useState("");

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

  const title = useMemo(() => {
    const subtitles: Record<Section, string> = {
      Painel: "Visao geral da operacao",
      Empresa: "Cadastro e configuracao do CNPJ do sistema",
      Colaboradores: "Equipe, documentos, turnos e biometria",
      Escalas: "Jornadas, tolerancias e banco de horas",
      "Sala de ponto": "Tablet de reconhecimento facial",
      Batidas: "Registro por PIN, foto e evidencias",
      "Banco de horas": "Saldos, faltantes, extras e abonos",
      Relatorios: "Espelho de ponto e jornada detalhada",
      "LGPD e auditoria": "Consentimento, logs e trilha inviolavel",
      Admin: "Controle interno, convites e permissoes",
    };

    return subtitles[active];
  }, [active]);

  function go(section: Section) {
    setActive(section);
    setNotice(`Tela "${section}" aberta em modo demonstrativo.`);
  }

  function demoAction(action: string) {
    setNotice(`${action} preparado. Integracao real sera conectada somente depois.`);
  }

  function registerPunch(kind: string) {
    if (!pin.trim()) {
      setNotice("Informe um PIN para simular a batida.");
      return;
    }

    setNotice(`Batida de ${kind.toLowerCase()} simulada para o PIN ${pin}. Nada foi salvo fora da tela.`);
  }

  return (
    <main className="min-h-screen bg-[#f4f6f8] text-[#17202a]">
      <div className="mx-auto grid max-w-[1480px] gap-6 px-4 py-4 lg:grid-cols-[292px_1fr] lg:px-6">
        <aside className="rounded-lg border border-[#d9e0e7] bg-[#101923] p-4 text-white shadow-sm lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)]">
          <div className="flex h-full flex-col">
            <div className="border-b border-white/10 pb-5">
              <div className="flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-md bg-[#dcebe6] text-lg font-bold text-[#164d42]">
                  O
                </div>
                <div>
                  <p className="text-sm font-semibold">Orquestracs</p>
                  <p className="text-xs text-white/60">Face ID</p>
                </div>
              </div>
              <div className="mt-5 rounded-md border border-white/10 bg-white/[0.04] p-3">
                <p className="text-xs uppercase tracking-[0.12em] text-white/45">Empresa</p>
                <h2 className="mt-2 text-sm font-semibold">MULT PECAS ITABOA</h2>
                <p className="mt-1 text-xs text-white/55">CNPJ 42.838.913/0001-21</p>
              </div>
            </div>

            <nav className="mt-5 grid gap-1 text-sm">
              {navItems.map((item) => (
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
          <header className="rounded-lg border border-[#d9e0e7] bg-white p-5 shadow-sm">
            <div className="grid gap-5 xl:grid-cols-[1fr_auto] xl:items-center">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#2d6c5d]">
                  Orquestracs Face ID
                </p>
                <h1 className="mt-2 max-w-3xl text-2xl font-semibold text-[#101923] sm:text-3xl">
                  {title}
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-[#667085]">
                  Ponto inteligente para empresas que precisam de seguranca,
                  prova e conformidade.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                <div className="rounded-md border border-[#d9e0e7] bg-[#fbfcfd] px-3 py-2 text-right">
                  <p className="text-xs font-semibold uppercase text-[#667085]">Data e hora</p>
                  <p className="text-sm font-bold text-[#101923]">{currentDateTime}</p>
                </div>
                <button
                  className="h-10 rounded-md bg-[#18594c] px-4 text-sm font-semibold text-white shadow-sm"
                  onClick={() => go("Sala de ponto")}
                  type="button"
                >
                  Nova batida
                </button>
                <button
                  className="h-10 rounded-md border border-[#cbd5df] bg-white px-4 text-sm font-semibold text-[#26323f]"
                  onClick={() => go("Relatorios")}
                  type="button"
                >
                  Exportar relatorio
                </button>
              </div>
            </div>

            <div className="mt-5 rounded-md border border-[#d9e0e7] bg-[#fbfcfd] px-4 py-3 text-sm text-[#52616f]">
              {notice}
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

          {active === "Empresa" && <CompaniesScreen onAction={demoAction} />}
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
          {active === "Relatorios" && <ReportsScreen onAction={demoAction} />}
          {active === "LGPD e auditoria" && <AuditScreen onAction={demoAction} />}
          {active === "Admin" && <AdminScreen onAction={demoAction} />}
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
          onClose={() => setAssistantOpen(false)}
          onNavigate={go}
        />
      )}
    </main>
  );
}

function Metrics() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {metrics.map(([label, value, detail]) => (
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
  onRegister: (kind: string) => void;
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

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {["Entrada", "Intervalo", "Retorno", "Saida"].map((label) => (
              <button className="secondary-button" key={label} onClick={() => onRegister(label)} type="button">
                {label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 rounded-md border border-[#cfe3dc] bg-[#f1faf7] p-4 text-sm text-[#24594d] md:grid-cols-3">
            <span>Foto obrigatoria</span>
            <span>Horario do servidor</span>
            <span>Hash de auditoria</span>
          </div>
        </div>

        <CameraMock />
      </div>
    </section>
  );
}

function CameraMock() {
  return (
    <div className="rounded-lg border border-[#d9e0e7] bg-[#f8fafb] p-4 text-center">
      <div className="grid min-h-[190px] place-items-center rounded-md border border-dashed border-[#aeb9c5] bg-white">
        <div>
          <div className="mx-auto h-24 w-24 rounded-full border-[6px] border-[#18594c] bg-[#edf5f2]" />
          <p className="mt-3 text-sm font-semibold text-[#101923]">Camera pronta</p>
          <p className="mt-1 text-xs text-[#667085]">Captura no ato da marcacao</p>
        </div>
      </div>
    </div>
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

function CompaniesScreen({ onAction }: { onAction: (action: string) => void }) {
  const [companyJourney, setCompanyJourney] = useState({
    start: "07:00",
    lunchOut: "11:30",
    lunchBack: "13:00",
    end: "17:15",
    days: "6",
  });

  function updateCompanyJourney(field: keyof typeof companyJourney, value: string) {
    setCompanyJourney((current) => ({ ...current, [field]: value }));
  }

  return (
    <>
      <TwoColumn>
        <Panel title="Perfil da empresa" subtitle="Dados principais do CNPJ">
          <div className="grid gap-3 md:grid-cols-3">
            <MaskedField label="Razao social" mask="name" placeholder="Mult Pecas Itaboa" />
            <MaskedField label="Nome fantasia" mask="name" placeholder="Mult Pecas" />
            <MaskedField label="CNPJ" mask="cnpj" placeholder="00.000.000/0000-00" />
            <Field label="Inscricao estadual"><input className="input" placeholder="000.000.000.000" /></Field>
            <MaskedField label="Responsavel" mask="name" placeholder="Nome Do Responsavel" />
            <MaskedField label="Celular" mask="phone" placeholder="(00) 00000-0000" />
            <Field label="E-mail"><input className="input" placeholder="contato@empresa.com" /></Field>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <MaskedField label="CEP" mask="cep" placeholder="00000-000" />
            <Field label="Logradouro"><input className="input" placeholder="Rua, avenida ou estrada" /></Field>
            <Field label="Numero"><input className="input" placeholder="123" /></Field>
            <Field label="Complemento"><input className="input" placeholder="Galpao, sala, lote" /></Field>
            <Field label="Bairro"><input className="input" placeholder="Centro" /></Field>
            <Field label="Cidade"><input className="input" placeholder="Cidade" /></Field>
            <Field label="UF">
              <select className="input">
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
          <ActionRow>
            <button className="primary-button" onClick={() => onAction("Cadastro da empresa principal")} type="button">Salvar empresa</button>
            <button className="secondary-button" onClick={() => onAction("Validacao de CNPJ")} type="button">Validar CNPJ</button>
          </ActionRow>
        </Panel>

        <Panel title="Foto e backup" subtitle="Identidade visual e seguranca local">
          <div className="grid gap-4">
            <div className="grid min-h-[180px] place-items-center rounded-md border border-dashed border-[#aeb9c5] bg-[#fbfcfd] p-4 text-center">
              <div>
                <div className="mx-auto grid h-20 w-20 place-items-center rounded-md bg-[#edf5f2] text-2xl font-black text-[#18594c]">
                  O
                </div>
                <p className="mt-3 text-sm font-semibold text-[#26323f]">Logo ou foto da empresa</p>
                <p className="mt-1 text-xs leading-5 text-[#667085]">Usada em perfil, relatorios e tela do tablet.</p>
              </div>
            </div>
            <button className="secondary-button" onClick={() => onAction("Upload de logo da empresa")} type="button">Selecionar imagem</button>
            <button className="primary-button" onClick={() => onAction("Backup local completo")} type="button">Gerar backup local</button>
            <CheckList
              items={[
                "Backup inclui dados, relatorios e referencias das fotos",
                "Fotos ficam na nuvem e podem entrar no pacote quando disponivel",
                "Use backup mensal como camada extra de seguranca",
              ]}
            />
          </div>
        </Panel>
      </TwoColumn>

      <Panel title="Escalas da empresa" subtitle="Cadastre uma ou mais jornadas coletivas">
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
        <ActionRow>
          <button className="primary-button" onClick={() => onAction("Escala coletiva da empresa")} type="button">Salvar escala</button>
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
      </Panel>

      <TwoColumn>
        <Panel title="Politica de fotos" subtitle="Armazenamento e LGPD">
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
        </Panel>

        <Panel title="Regra de faltas" subtitle="Controle por periodo da empresa">
          <CheckList
            items={[
              "Manha sem nenhuma batida: 1 falta",
              "Tarde sem nenhuma batida: 1 falta",
              "Manha + tarde sem batida: 2 faltas",
              "Se bateu saida almoco, pode ser esquecimento da entrada",
              "Trabalho externo pode ser lancado pelo gestor com justificativa",
            ]}
          />
        </Panel>
      </TwoColumn>

      <TwoColumn>
        <Panel title="Usuarios da empresa" subtitle="Login por convite">
          <CheckList
            items={[
              "Proprietario tem acesso total",
              "Administrador gerencia operacao",
              "Leitor apenas visualiza relatorios",
              "Convites pendentes podem ser reenviados",
            ]}
          />
          <ActionRow>
            <button className="primary-button" onClick={() => onAction("Convidar usuario da empresa")} type="button">Convidar usuario</button>
          </ActionRow>
        </Panel>

        <Panel title="Ajuste permitido" subtitle="Substitui a caneta por log digital">
          <CheckList
            items={[
              "Esquecimento de batida exige evidencia no mesmo periodo",
              "Ajuste manual exige motivo e responsavel",
              "Batida do gestor para externo fica marcada como G",
              "Relatorio mostra falta, esquecimento e trabalho externo",
            ]}
          />
        </Panel>
      </TwoColumn>
    </>
  );
}

function EmployeesScreen({ onAction }: { onAction: (action: string) => void }) {
  const [journeyMode, setJourneyMode] = useState<"coletiva" | "individual">("coletiva");
  const [employeeJourney, setEmployeeJourney] = useState({
    start: "07:00",
    lunchOut: "11:30",
    lunchBack: "13:00",
    end: "17:15",
    days: "6",
  });

  function updateEmployeeJourney(field: keyof typeof employeeJourney, value: string) {
    setEmployeeJourney((current) => ({ ...current, [field]: value }));
  }

  return (
    <>
      <Panel title="Novo colaborador" subtitle="Dados para ponto, holerite e relatorio mensal">
        <p className="text-sm font-semibold text-[#26323f]">Dados pessoais</p>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <MaskedField label="Nome" mask="name" placeholder="Primeira Letra Maiuscula" />
          <MaskedField label="CPF" mask="cpf" placeholder="000.000.000-00" />
          <MaskedField label="PIN" mask="pin" placeholder="0000" />
          <MaskedField label="Celular" mask="phone" placeholder="(00) 00000-0000" />
        </div>

        <p className="mt-5 text-sm font-semibold text-[#26323f]">Dados trabalhistas</p>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <MaskedField label="Data de admissao" mask="date" placeholder="00/00/0000" />
          <MaskedField label="Cargo" mask="name" placeholder="Vendedor" />
          <MaskedField label="Departamento" mask="name" placeholder="Loja" />
          <Field label="CBO"><input className="input" placeholder="0000-00" /></Field>
          <Field label="N. carteira trabalho"><input className="input" placeholder="0000000" /></Field>
          <Field label="Serie CTPS"><input className="input" placeholder="0000" /></Field>
          <Field label="UF CTPS">
            <select className="input">
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
          <button className="primary-button" onClick={() => onAction("Cadastro de colaborador")} type="button">Cadastrar colaborador</button>
          <button className="secondary-button" onClick={() => onAction("Captura facial")} type="button">Cadastrar Face ID</button>
        </ActionRow>
      </Panel>
      <EmployeesTable onAction={onAction} />
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
            <button className="primary-button" onClick={saveShift} type="button">Salvar alteracoes</button>
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
  onRegister: (kind: string) => void;
  pin: string;
  setPin: (value: string) => void;
}) {
  return (
    <>
      <PunchCard onRegister={onRegister} pin={pin} setPin={setPin} />
      <Panel title="Ajuste de batida" subtitle="A batida original nao e alterada; o ajuste cria um novo registro">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Colaborador"><select className="input">{employees.map((employee) => <option key={employee.name}>{employee.name}</option>)}</select></Field>
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
      <Panel title="Regra operacional da empresa" subtitle="Como o sistema interpreta ausencia de batida">
        <div className="grid gap-3 md:grid-cols-2">
          <CheckList
            items={[
              "Nao bateu entrada, mas bateu saida almoco: possivel esquecimento",
              "Nao bateu entrada nem saida almoco: falta manha",
              "Nao bateu volta almoco, mas bateu saida: possivel esquecimento",
              "Nao bateu volta almoco nem saida: falta tarde",
            ]}
          />
          <CheckList
            items={[
              "Funcionario externo pode ter batida lancada pelo gestor",
              "Lancamento do gestor aparece marcado no relatorio",
              "Todo ajuste exige justificativa",
              "A batida original nunca e apagada",
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
  onRegister: (kind: string) => void;
  pin: string;
  setPin: (value: string) => void;
}) {
  const [recognized, setRecognized] = useState(false);
  const [selectedPunch, setSelectedPunch] = useState("Entrada");

  function identifyFace() {
    setRecognized(true);
    onAction("Reconhecimento facial no tablet");
  }

  function confirmPunch() {
    onAction(`Presenca confirmada por ${recognized ? "Face ID" : "PIN + foto"}`);
  }

  return (
    <section className="kiosk-screen rounded-lg border border-[#d9e0e7] bg-[#101923] p-5 text-white shadow-sm">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#b7d7ce]">
                Sala de ponto
              </p>
              <h2 className="mt-2 text-2xl font-semibold">Tablet em modo reconhecimento</h2>
              <p className="mt-2 text-sm text-white/60">
                Funcionarios chegam, ficam em frente a camera e confirmam a presenca.
              </p>
            </div>
            <span className="w-fit rounded-full bg-[#dcebe6] px-3 py-1 text-xs font-bold text-[#143f37]">
              Camera ativa
            </span>
          </div>

          <div className="mt-6 grid min-h-[430px] place-items-center rounded-lg border border-white/10 bg-[#0b121a] p-6">
            <div className="text-center">
              <div className="mx-auto grid h-52 w-52 place-items-center rounded-full border-[10px] border-[#dcebe6] bg-[#172632] shadow-[0_0_0_16px_rgba(220,235,230,0.06)]">
                <div className="h-32 w-24 rounded-[42%] border-4 border-[#b7d7ce]" />
              </div>
              <p className="mt-6 text-lg font-semibold">
                {recognized ? "Funcionario identificado" : "Aguardando rosto"}
              </p>
              <p className="mt-2 text-sm text-white/55">
                {recognized
                  ? "Elivelton Aparecido - pronto para confirmar batida"
                  : "Posicione o rosto no centro da camera"}
              </p>
            </div>
          </div>
        </div>

        <aside className="grid gap-4">
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
            <p className="text-sm font-semibold text-[#b7d7ce]">Confirmacao</p>
            <div className="mt-4 grid gap-3">
              <Field label="Tipo da batida">
                <select
                  className="input"
                  onChange={(event) => setSelectedPunch(event.target.value)}
                  value={selectedPunch}
                >
                  <option>Entrada</option>
                  <option>Saida almoco</option>
                  <option>Volta almoco</option>
                  <option>Fim do dia</option>
                </select>
              </Field>
              <button className="primary-button" onClick={identifyFace} type="button">
                Simular Face ID
              </button>
              <button className="secondary-button" onClick={confirmPunch} type="button">
                Confirmar presenca
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-white/10 bg-white p-5 text-[#17202a]">
            <p className="text-sm font-semibold text-[#26323f]">Fallback PIN + foto</p>
            <p className="mt-1 text-xs leading-5 text-[#667085]">
              Use quando o rosto nao reconhecer, funcionario for novo ou a luz estiver ruim.
            </p>
            <div className="mt-4 grid gap-3">
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
                onClick={() => onRegister(selectedPunch)}
                type="button"
              >
                Registrar por PIN + foto
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-[#cfe3dc] bg-[#f1faf7] p-4 text-[#24594d]">
            <p className="text-sm font-semibold">O que sera registrado</p>
            <div className="mt-3 grid gap-2 text-xs leading-5">
              <span>Funcionario identificado</span>
              <span>Foto da batida</span>
              <span>Horario do servidor</span>
              <span>Status: no horario, atraso ou fora da jornada</span>
              <span>Log inviolavel</span>
            </div>
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

function ReportsScreen({ onAction }: { onAction: (action: string) => void }) {
  return (
    <>
      <Panel title="Gerar relatorio" subtitle="Espelho de ponto e jornada detalhada">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Colaborador"><select className="input">{employees.map((employee) => <option key={employee.name}>{employee.name}</option>)}</select></Field>
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

function AdminScreen({ onAction }: { onAction: (action: string) => void }) {
  return (
    <>
      <TwoColumn>
        <Panel title="Admin Orquestracs" subtitle="Area interna do desenvolvedor">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-4">
              <p className="text-sm font-semibold text-[#26323f]">Controle do SaaS</p>
              <p className="mt-1 text-xs leading-5 text-[#667085]">
                Visao para acompanhar o CNPJ ativo, usuarios, plano, acessos e
                auditoria geral da instalacao.
              </p>
            </div>
            <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-4">
              <p className="text-sm font-semibold text-[#26323f]">Acesso protegido</p>
              <p className="mt-1 text-xs leading-5 text-[#667085]">
                Essa area deve existir apenas para usuarios internos Orquestracs com
                permissao de desenvolvedor/suporte.
              </p>
            </div>
          </div>
          <ActionRow>
            <button className="primary-button" onClick={() => onAction("Painel interno Orquestracs")} type="button">
              Ver empresa
            </button>
            <button className="secondary-button" onClick={() => onAction("Auditoria global")} type="button">
              Logs globais
            </button>
          </ActionRow>
        </Panel>

        <Panel title="Perfis de acesso" subtitle="Mesma logica de permissoes por convite">
          <CheckList
            items={[
              "Proprietario: acesso total da empresa",
              "Administrador: gerencia funcionarios, jornadas e relatorios",
              "Leitor: visualiza dados e relatorios sem alterar",
              "Desenvolvedor: acesso interno Orquestracs",
            ]}
          />
        </Panel>
      </TwoColumn>

      <Panel title="Convites de acesso" subtitle="Empresa e usuarios entram somente por convite">
        <div className="grid gap-3 md:grid-cols-4">
          <MaskedField label="Nome" mask="name" placeholder="Nome Do Convidado" />
          <Field label="E-mail">
            <input className="input" placeholder="usuario@empresa.com" />
          </Field>
          <Field label="Empresa">
            <select className="input">
              <option>MULT PECAS ITABOA</option>
            </select>
          </Field>
          <Field label="Permissao">
            <select className="input">
              <option>Proprietario</option>
              <option>Administrador</option>
              <option>Leitor</option>
            </select>
          </Field>
        </div>
        <ActionRow>
          <button className="primary-button" onClick={() => onAction("Convite por e-mail")} type="button">
            Enviar convite
          </button>
          <button className="secondary-button" onClick={() => onAction("Reenviar convite")} type="button">
            Reenviar pendentes
          </button>
        </ActionRow>
      </Panel>

      <Panel title="Matriz de permissoes" subtitle="Base para Auth, Firestore Rules e telas">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <thead className="bg-[#101923] text-xs uppercase text-white">
              <tr>
                <th className="px-4 py-3 font-semibold">Recurso</th>
                <th className="px-4 py-3 font-semibold">Proprietario</th>
                <th className="px-4 py-3 font-semibold">Administrador</th>
                <th className="px-4 py-3 font-semibold">Leitor</th>
                <th className="px-4 py-3 font-semibold">Desenvolvedor</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Empresa", "Criar/editar", "Editar", "Ver", "Suporte"],
                ["Funcionarios", "Total", "Criar/editar", "Ver", "Suporte"],
                ["Jornadas", "Total", "Criar/editar", "Ver", "Suporte"],
                ["Batidas", "Ver/ajustar", "Ver/ajustar", "Ver", "Auditar"],
                ["Relatorios", "Gerar/exportar", "Gerar/exportar", "Ver/exportar", "Auditar"],
                ["Usuarios", "Convidar/remover", "Convidar", "Sem acesso", "Suporte"],
              ].map((row) => (
                <tr className="border-b border-[#e3e8ee]" key={row[0]}>
                  {row.map((cell, index) => (
                    <td
                      className={`px-4 py-3 ${index === 0 ? "font-semibold text-[#101923]" : "text-[#667085]"}`}
                      key={`${row[0]}-${cell}`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function AssistantPanel({
  active,
  onClose,
  onNavigate,
}: {
  active: Section;
  onClose: () => void;
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
                  className="rounded-md border border-[#d9e0e7] bg-white px-3 py-2 text-left text-sm font-semibold text-[#26323f] hover:border-[#18594c] hover:text-[#18594c]"
                  key={question}
                  type="button"
                >
                  {question}
                </button>
              ))}
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
  onAction,
  compact = false,
}: {
  onAction: (action: string) => void;
  compact?: boolean;
}) {
  return (
    <section className="rounded-lg border border-[#d9e0e7] bg-white shadow-sm">
      {!compact && (
        <div className="flex flex-col gap-3 border-b border-[#e3e8ee] p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium text-[#667085]">Equipe</p>
            <h2 className="mt-1 text-xl font-semibold text-[#101923]">Colaboradores e banco de horas</h2>
          </div>
          <button className="secondary-button w-fit" onClick={() => onAction("Novo colaborador")} type="button">Novo colaborador</button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left text-sm">
          <thead className="bg-[#f8fafb] text-xs uppercase text-[#667085]">
            <tr>
              <th className="px-5 py-3 font-semibold">Funcionario</th>
              <th className="px-5 py-3 font-semibold">CPF</th>
              <th className="px-5 py-3 font-semibold">Cargo</th>
              <th className="px-5 py-3 font-semibold">Turno</th>
              <th className="px-5 py-3 font-semibold">Banco</th>
              <th className="px-5 py-3 font-semibold">Status</th>
              <th className="px-5 py-3 font-semibold">Acoes</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((employee) => (
              <tr className="border-t border-[#e3e8ee]" key={employee.name}>
                <td className="px-5 py-4 font-semibold text-[#101923]">{employee.name}</td>
                <td className="px-5 py-4 text-[#667085]">{employee.cpf}</td>
                <td className="px-5 py-4 text-[#667085]">{employee.role}</td>
                <td className="px-5 py-4 text-[#667085]">{employee.shift}</td>
                <td className="px-5 py-4 font-semibold text-[#101923]">{employee.bank}</td>
                <td className="px-5 py-4">
                  <span className="rounded-full border border-[#d8e1ff] bg-[#f2f5ff] px-3 py-1 text-xs font-semibold text-[#3446a3]">
                    {employee.status}
                  </span>
                </td>
                <td className="px-5 py-4">
                  <div className="flex gap-2">
                    <button className="mini-button" onClick={() => onAction(`Editar ${employee.name}`)} type="button">Editar</button>
                    <button className="mini-button" onClick={() => onAction(`Ver ${employee.name}`)} type="button">Ver</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
          <span>Colaborador: Elivelton Aparecido</span>
          <span>Emitido por: Fabio Cordeiro</span>
        </div>
      </div>

      <div className="grid gap-3 p-5 md:grid-cols-4">
        {[
          ["Horas previstas", "200:00"],
          ["Horas abonadas", "16:00"],
          ["Faltantes", "-07:13"],
          ["Saldo final", "+02:07"],
        ].map(([label, value]) => (
          <div className="rounded-md border border-[#e3e8ee] bg-[#fbfcfd] p-3" key={label}>
            <p className="text-xs font-semibold uppercase text-[#667085]">{label}</p>
            <strong className="mt-2 block text-lg text-[#101923]">{value}</strong>
          </div>
        ))}
      </div>

      <div className="grid gap-3 px-5 pb-5 md:grid-cols-4">
        {[
          ["Faltas manha", "1"],
          ["Faltas tarde", "1"],
          ["Esquecimentos", "1"],
          ["Trabalho externo", "1"],
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
            {journeyRows.map((row) => (
              <tr className="border-b border-[#e3e8ee]" key={`${row[0]}-${row[1]}`}>
                {row.map((cell, index) => (
                  <td className={`px-3 py-3 ${index >= 6 ? "font-semibold text-[#26323f]" : "text-[#667085]"}`} key={`${row[0]}-${cell}-${index}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  placeholder,
}: {
  label: string;
  mask: MaskType;
  placeholder: string;
}) {
  const [value, setValue] = useState("");

  return (
    <Field label={label}>
      <input
        className="input"
        onChange={(event) => setValue(applyMask(event.target.value, mask))}
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
