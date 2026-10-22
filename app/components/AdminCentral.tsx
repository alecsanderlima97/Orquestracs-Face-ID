"use client";

import { useEffect, useMemo, useState } from "react";
import { createTenantInvite, listPlatformTenantClients, saveTenantSaasConfig, subscribePlatformTenantClients, type TenantAdminClient, type TenantAdminUser, type TenantInvite, type TenantSaasConfig } from "@/lib/services/tenant-access";
import { saveTenantCompany } from "@/lib/services/companies";
import { adjustAiCredits } from "@/lib/services/ai-credits";
import { subscribePortalSyncStatus, syncPortalSnapshot, type PortalSyncStatus } from "@/lib/services/portal-sync";

type CentralCompany = Record<string, unknown>;

type CentralAdminProps = {
  company: CentralCompany | null;
  config: TenantSaasConfig | null;
  invites: TenantInvite[];
  onAction: (action: string) => void;
};

type ClientForm = {
  companyName: string;
  legalName: string;
  tradeName: string;
  responsibleName: string;
  email: string;
  phone: string;
  document: string;
  plan: TenantSaasConfig["plan"];
  status: TenantSaasConfig["status"];
  monthlyFee: string;
  dueDate: string;
  graceDays: string;
  registrationDate: string;
  paymentMethod: string;
  notes: string;
  cep: string;
  street: string;
  number: string;
  complement: string;
  neighborhood: string;
  city: string;
  state: string;
  mapsUrl: string;
};

type AdminColumnKey =
  | "client"
  | "plan"
  | "status"
  | "registration"
  | "due"
  | "situation"
  | "lastAccess"
  | "online"
  | "credits"
  | "actions";

type AdminClientRow = TenantAdminClient & {
  name: string;
  responsible: string;
  email: string;
  phone: string;
  document: string;
  registrationDate: string;
  dueDate: string;
  situation: string;
  lastAccess: string;
  online: boolean;
};

const COLUMN_ORDER_KEY = "orquestracs-face-id-central-admin-columns-v1";
const ORQUESTRA_PORTAL_ADMIN_URL = process.env.NEXT_PUBLIC_ORQUESTRA_PORTAL_ADMIN_URL || "https://portal.orquestracs.com/#admin-orquestra";
const DEFAULT_COLUMN_ORDER: AdminColumnKey[] = [
  "client",
  "plan",
  "status",
  "registration",
  "due",
  "situation",
  "lastAccess",
  "online",
  "credits",
  "actions",
];

const COLUMN_LABELS: Record<AdminColumnKey, string> = {
  client: "Cliente",
  plan: "Plano",
  status: "Status",
  registration: "Inscrição",
  due: "Vencimento",
  situation: "Situação calculada",
  lastAccess: "Último acesso",
  online: "Online",
  credits: "Créditos IA",
  actions: "Ação",
};

const EMPTY_FORM: ClientForm = {
  city: "",
  companyName: "",
  complement: "",
  document: "",
  dueDate: "",
  email: "",
  graceDays: "5",
  legalName: "",
  mapsUrl: "",
  monthlyFee: "R$ 0,00",
  neighborhood: "",
  notes: "",
  number: "",
  paymentMethod: "PIX",
  phone: "",
  plan: "Essencial",
  registrationDate: "",
  responsibleName: "",
  state: "",
  status: "Teste",
  street: "",
  tradeName: "",
  cep: "",
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value);
}

function companyField(company: CentralCompany, key: string) {
  return text(company[key]);
}

function nestedField(company: CentralCompany, section: string, key: string) {
  const value = company[section];
  return value && typeof value === "object" ? text((value as Record<string, unknown>)[key]) : "";
}

function formatDate(value: string | undefined, fallback = "Sem registro") {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("pt-BR");
}

function formatDateTime(value: string | undefined, fallback = "Sem registro") {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function toClientForm(client: AdminClientRow): ClientForm {
  const company = client.company;
  return {
    ...EMPTY_FORM,
    city: nestedField(company, "address", "city"),
    companyName: client.name,
    complement: nestedField(company, "address", "complement"),
    document: companyField(company, "cnpj") || companyField(company, "cpf") || client.document,
    dueDate: client.config.billing.dueDate,
    email: client.email,
    graceDays: String(client.config.billing.graceDays),
    legalName: companyField(company, "legalName"),
    mapsUrl: companyField(company, "mapsUrl"),
    monthlyFee: client.config.billing.amount,
    neighborhood: nestedField(company, "address", "district") || nestedField(company, "address", "neighborhood"),
    notes: companyField(company, "internalNotes"),
    number: nestedField(company, "address", "number"),
    paymentMethod: companyField(company, "paymentMethod") || "PIX",
    phone: client.phone,
    plan: client.config.plan,
    registrationDate: companyField(company, "registrationDate") || companyField(company, "createdAt"),
    responsibleName: client.responsible,
    state: nestedField(company, "address", "state"),
    status: client.config.status,
    street: nestedField(company, "address", "street"),
    tradeName: companyField(company, "tradeName") || client.name,
    cep: nestedField(company, "address", "zipCode") || nestedField(company, "address", "cep"),
  };
}

function buildFallbackClient(company: CentralCompany | null, config: TenantSaasConfig | null): TenantAdminClient | null {
  if (!company && !config) return null;

  const companyData = company || {};
  const name = text(config?.name) || companyField(companyData, "tradeName") || companyField(companyData, "legalName") || "Empresa sem nome";
  const fallbackConfig: TenantSaasConfig = config || {
    aiCredits: {
      balance: 100,
      bonus: 0,
      included: 100,
      renewalMonth: new Date().toISOString().slice(0, 7),
      status: "Ativo",
      used: 0,
    },
    billing: { amount: "R$ 0,00", dueDate: "", graceDays: 5, status: "Teste" },
    employeeLimit: 25,
    name,
    plan: "Essencial",
    status: "Teste",
    tenantId: "main",
  };

  return {
    company: companyData,
    config: fallbackConfig,
    tenantId: fallbackConfig.tenantId || "main",
    users: [],
  };
}

function toAdminClientRow(client: TenantAdminClient): AdminClientRow {
  const sortedUsers = [...client.users].sort((left, right) => (right.lastAccessAt || right.lastActivityAt || "").localeCompare(left.lastAccessAt || left.lastActivityAt || ""));
  const lastUser = sortedUsers[0];
  const company = client.company;
  const dueDate = client.config.billing.dueDate;
  let situation = "Sem vencimento";

  if (dueDate) {
    const due = new Date(dueDate);
    if (!Number.isNaN(due.getTime())) {
      const days = Math.ceil((due.getTime() - Date.now()) / 86400000);
      situation = days >= 0 ? `Em dia: vence em ${days} dia(s)` : `Em atraso há ${Math.abs(days)} dia(s)`;
    }
  }

  return {
    ...client,
    document: companyField(company, "cnpj") || companyField(company, "cpf"),
    dueDate,
    email: companyField(company, "contactEmail"),
    lastAccess: formatDateTime(lastUser?.lastAccessAt || lastUser?.lastActivityAt || client.lastUpdatedAt),
    name: client.config.name || companyField(company, "tradeName") || companyField(company, "legalName") || "Empresa sem nome",
    online: Boolean(client.users.some((user) => user.online)),
    phone: companyField(company, "contactPhone"),
    registrationDate: companyField(company, "registrationDate") || companyField(company, "createdAt"),
    responsible: companyField(company, "contactName"),
    situation,
  };
}

function statusClass(status: TenantSaasConfig["status"]) {
  if (status === "Ativo") return "central-status-active";
  if (status === "Teste") return "central-status-trial";
  return "central-status-inactive";
}

function roleLabel(role: TenantAdminUser["role"]) {
  return role === "owner" ? "Proprietário" : role === "admin" ? "Administrador" : role === "developer" ? "Desenvolvedor" : "Leitor";
}

function fieldValue(form: ClientForm, key: keyof ClientForm) {
  return form[key];
}

export default function AdminCentral({ company, config, invites, onAction }: CentralAdminProps) {
  const [clients, setClients] = useState<AdminClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [expandedClient, setExpandedClient] = useState<string | null>(null);
  const [editingClient, setEditingClient] = useState<AdminClientRow | null>(null);
  const [creditClient, setCreditClient] = useState<AdminClientRow | null>(null);
  const [paymentClient, setPaymentClient] = useState<AdminClientRow | null>(null);
  const [newClientOpen, setNewClientOpen] = useState(false);
  const [newClientForm, setNewClientForm] = useState<ClientForm>(EMPTY_FORM);
  const [editForm, setEditForm] = useState<ClientForm>(EMPTY_FORM);
  const [creditAmount, setCreditAmount] = useState("100");
  const [creditReason, setCreditReason] = useState("");
  const [columnOrder, setColumnOrder] = useState<AdminColumnKey[]>(DEFAULT_COLUMN_ORDER);
  const [draggedColumn, setDraggedColumn] = useState<AdminColumnKey | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [portalSyncStatus, setPortalSyncStatus] = useState<PortalSyncStatus>({ lastClients: 0, lastUsers: 0, status: "idle" });

  const fallbackClient = useMemo(() => buildFallbackClient(company, config), [company, config]);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(COLUMN_ORDER_KEY) || "null") as AdminColumnKey[] | null;
      if (stored && stored.length === DEFAULT_COLUMN_ORDER.length && stored.every((item) => DEFAULT_COLUMN_ORDER.includes(item))) {
        window.setTimeout(() => setColumnOrder(stored), 0);
      }
    } catch {
      // A local preference never blocks the administrative screen.
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(COLUMN_ORDER_KEY, JSON.stringify(columnOrder));
  }, [columnOrder]);

  async function loadClients(showRefresh = false) {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    setMessage("");
    try {
      const remoteClients = await listPlatformTenantClients();
      const withFallback = fallbackClient && !remoteClients.some((client) => client.tenantId === fallbackClient.tenantId)
        ? [...remoteClients, fallbackClient]
        : remoteClients;
      setClients(withFallback.map(toAdminClientRow));
      if (showRefresh) setMessage("Central atualizada com os dados disponíveis.");
    } catch (error) {
      console.error(error);
      setClients(fallbackClient ? [toAdminClientRow(fallbackClient)] : []);
      setMessage("Não foi possível atualizar a lista agora. Os dados já carregados continuam disponíveis.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const unsubscribe = subscribePlatformTenantClients(
      (remoteClients) => {
        const withFallback = fallbackClient && !remoteClients.some((client) => client.tenantId === fallbackClient.tenantId)
          ? [...remoteClients, fallbackClient]
          : remoteClients;
        setClients(withFallback.map(toAdminClientRow));
        setLoading(false);
        setRefreshing(false);
      },
      (error) => {
        console.error(error);
        setClients(fallbackClient ? [toAdminClientRow(fallbackClient)] : []);
        setLoading(false);
        setRefreshing(false);
        setMessage("Não foi possível acompanhar os clientes em tempo real. Os dados carregados continuam disponíveis.");
      },
    );
    return unsubscribe;
    // The selected tenant changes only when the authenticated session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallbackClient?.tenantId]);

  useEffect(() => subscribePortalSyncStatus(setPortalSyncStatus, (error) => console.error(error)), []);

  function showMessage(nextMessage: string) {
    setMessage(nextMessage);
    window.setTimeout(() => setMessage((current) => current === nextMessage ? "" : current), 4200);
  }

  function openEditor(client: AdminClientRow) {
    setEditForm(toClientForm(client));
    setEditingClient(client);
  }

  async function handleSaveEdit() {
    if (!editingClient || !editForm.companyName.trim()) {
      showMessage("Informe o nome do cliente antes de salvar.");
      return;
    }

    setBusy("save-edit");
    try {
      const nextConfig: Omit<TenantSaasConfig, "tenantId"> = {
        ...editingClient.config,
        billing: {
          ...editingClient.config.billing,
          amount: editForm.monthlyFee || "R$ 0,00",
          dueDate: editForm.dueDate,
          graceDays: Number(editForm.graceDays) || 5,
        },
        name: editForm.companyName.trim(),
        plan: editForm.plan,
        status: editForm.status,
      };
      const address = {
        city: editForm.city,
        complement: editForm.complement,
        district: editForm.neighborhood,
        number: editForm.number,
        state: editForm.state,
        street: editForm.street,
        zipCode: editForm.cep,
      };
      await Promise.all([
        saveTenantSaasConfig(editingClient.tenantId, nextConfig),
        saveTenantCompany(editingClient.tenantId, {
          ...editingClient.company,
          address,
          cnpj: editForm.document,
          contactEmail: editForm.email,
          contactName: editForm.responsibleName,
          contactPhone: editForm.phone,
          internalNotes: editForm.notes,
          legalName: editForm.legalName,
          mapsUrl: editForm.mapsUrl,
          paymentMethod: editForm.paymentMethod,
          registrationDate: editForm.registrationDate,
          tradeName: editForm.tradeName || editForm.companyName,
        }),
      ]);
      setClients((current) => current.map((client) => client.tenantId === editingClient.tenantId
        ? toAdminClientRow({ ...client, company: { ...client.company, address, cnpj: editForm.document, contactEmail: editForm.email, contactName: editForm.responsibleName, contactPhone: editForm.phone, legalName: editForm.legalName, tradeName: editForm.tradeName || editForm.companyName }, config: { ...nextConfig, tenantId: client.tenantId } })
        : client));
      setEditingClient(null);
      showMessage("Cadastro do cliente salvo.");
      onAction("Cadastro do cliente atualizado na Central Admin.");
    } catch (error) {
      console.error(error);
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      showMessage(code === "permission-denied"
        ? "Não foi possível salvar: sua conta não tem permissão de administrador."
        : "Não foi possível salvar o cadastro. Verifique os dados e tente novamente.");
    } finally {
      setBusy("");
    }
  }

  async function handleCreateClient() {
    if (!newClientForm.companyName.trim()) {
      showMessage("Informe o nome da empresa para gerar o convite.");
      return;
    }

    setBusy("create-client");
    try {
      const tenantId = `tenant-${crypto.randomUUID().slice(0, 12)}`;
      const newConfig: Omit<TenantSaasConfig, "tenantId"> = {
        aiCredits: { balance: 100, bonus: 0, included: 100, renewalMonth: new Date().toISOString().slice(0, 7), status: "Ativo", used: 0 },
        billing: { amount: newClientForm.monthlyFee || "R$ 0,00", dueDate: newClientForm.dueDate, graceDays: Number(newClientForm.graceDays) || 5, status: "Teste" },
        employeeLimit: 25,
        name: newClientForm.companyName.trim(),
        plan: newClientForm.plan,
        status: "Teste",
      };
      await Promise.all([
        saveTenantSaasConfig(tenantId, newConfig),
        saveTenantCompany(tenantId, {
          address: { city: newClientForm.city, district: newClientForm.neighborhood, number: newClientForm.number, state: newClientForm.state, street: newClientForm.street, zipCode: newClientForm.cep },
          cnpj: newClientForm.document,
          contactEmail: newClientForm.email,
          contactName: newClientForm.responsibleName,
          contactPhone: newClientForm.phone,
          legalName: newClientForm.legalName,
          registrationDate: newClientForm.registrationDate,
          tradeName: newClientForm.tradeName || newClientForm.companyName,
        }),
      ]);
      const invite = await createTenantInvite({ companyName: newClientForm.companyName, role: "owner", tenantId });
      const createdClient: TenantAdminClient = {
        company: { cnpj: newClientForm.document, contactEmail: newClientForm.email, contactName: newClientForm.responsibleName, contactPhone: newClientForm.phone, legalName: newClientForm.legalName, registrationDate: newClientForm.registrationDate, tradeName: newClientForm.tradeName || newClientForm.companyName },
        config: { ...newConfig, tenantId },
        tenantId,
        users: [],
      };
      setClients((current) => [toAdminClientRow(createdClient), ...current]);
      setNewClientForm(EMPTY_FORM);
      setNewClientOpen(false);
      showMessage(`Cliente criado. Convite de proprietário: ${invite.code}`);
      onAction(`Novo cliente criado e convite gerado: ${invite.code}.`);
    } catch (error) {
      console.error(error);
      showMessage("Não foi possível criar o cliente. Confira a autorização da conta Orquestra.cs.");
    } finally {
      setBusy("");
    }
  }

  async function handleAddCredits() {
    if (!creditClient) return;
    const amount = Number(creditAmount);
    if (!Number.isInteger(amount) || amount < 1 || amount > 100000 || creditReason.trim().length < 5 || creditReason.trim().length > 300) {
      showMessage("Informe uma quantidade inteira de 1 a 100.000 e um motivo entre 5 e 300 caracteres.");
      return;
    }

    setBusy("add-credits");
    try {
      const result = await adjustAiCredits({ tenantId: creditClient.tenantId, credits: amount, reason: creditReason.trim() });
      setClients((current) => current.map((client) => client.tenantId === creditClient.tenantId
        ? { ...client, config: { ...client.config, aiCredits: { ...client.config.aiCredits, balance: result.balance, bonus: result.bonus, included: result.included, used: result.used } } }
        : client));
      setCreditClient(null);
      setCreditAmount("100");
      setCreditReason("");
      showMessage(`${amount} créditos adicionados com histórico administrativo.`);
    } catch (error) {
      console.error(error);
      showMessage("Não foi possível adicionar créditos. A operação exige a conta administradora oficial.");
    } finally {
      setBusy("");
    }
  }

  async function handlePaymentConfirm() {
    if (!paymentClient) return;
    setBusy("payment");
    try {
      const nextDueDate = new Date();
      nextDueDate.setDate(nextDueDate.getDate() + 30);
      const nextConfig: Omit<TenantSaasConfig, "tenantId"> = {
        ...paymentClient.config,
        billing: { ...paymentClient.config.billing, status: "Em dia", dueDate: nextDueDate.toISOString().slice(0, 10) },
      };
      await saveTenantSaasConfig(paymentClient.tenantId, nextConfig);
      setClients((current) => current.map((client) => client.tenantId === paymentClient.tenantId
        ? toAdminClientRow({ ...client, config: { ...nextConfig, tenantId: client.tenantId } })
        : client));
      setPaymentClient(null);
      showMessage("Pagamento confirmado e próximo vencimento atualizado.");
    } catch (error) {
      console.error(error);
      showMessage("Não foi possível registrar o pagamento.");
    } finally {
      setBusy("");
    }
  }

  async function handleTogglePause(client: AdminClientRow, skipConfirm = false) {
    const shouldPause = client.config.status !== "Pausado";
    if (!skipConfirm && !window.confirm(shouldPause ? "Pausar o acesso deste cliente? Os dados serão preservados." : "Reativar o acesso deste cliente?")) return;
    setBusy(`pause-${client.tenantId}`);
    try {
      const nextConfig: Omit<TenantSaasConfig, "tenantId"> = { ...client.config, status: shouldPause ? "Pausado" : "Ativo" };
      await saveTenantSaasConfig(client.tenantId, nextConfig);
      setClients((current) => current.map((item) => item.tenantId === client.tenantId ? toAdminClientRow({ ...item, config: { ...nextConfig, tenantId: item.tenantId } }) : item));
      showMessage(shouldPause ? "Cliente pausado. O cadastro foi preservado." : "Cliente reativado.");
    } catch (error) {
      console.error(error);
      showMessage("Não foi possível alterar o status do cliente.");
    } finally {
      setBusy("");
    }
  }

  async function handleRemove(client: AdminClientRow) {
    if (!window.confirm("Mover este cliente para a lista de inativos? Os dados serão preservados.")) return;
    await handleTogglePause(client, true);
  }

  function moveColumn(target: AdminColumnKey) {
    if (!draggedColumn || draggedColumn === target) return;
    setColumnOrder((current) => {
      const next = current.filter((column) => column !== draggedColumn);
      const index = next.indexOf(target);
      next.splice(index, 0, draggedColumn);
      return next;
    });
    setDraggedColumn(null);
  }

  async function handlePortalSync() {
    setSyncing(true);
    try {
      const result = await syncPortalSnapshot();
      showMessage(result.skipped
        ? "Já existe uma sincronização em andamento; o status será atualizado automaticamente."
        : `Portal sincronizado: ${result.clients} cliente(s) e ${result.users} usuário(s).`);
    } catch (error) {
      console.error(error);
      showMessage("Conector do Portal não configurado ou sem resposta.");
    } finally {
      setSyncing(false);
    }
  }

  const activeClients = clients.filter((client) => ["Ativo", "Teste"].includes(client.config.status));
  const inactiveClients = clients.filter((client) => !["Ativo", "Teste"].includes(client.config.status));
  const totalCredits = activeClients.reduce((total, client) => total + client.config.aiCredits.balance, 0);
  const portalStatusLabel = portalSyncStatus.status === "syncing"
    ? "Portal sincronizando"
    : portalSyncStatus.status === "success"
      ? `Portal conectado · ${formatDateTime(portalSyncStatus.lastSuccessAt, "agora")}`
      : portalSyncStatus.status === "error"
        ? "Portal com erro"
        : "Conector pronto";

  function updateForm(setter: (next: ClientForm) => void, form: ClientForm, key: keyof ClientForm, value: string) {
    setter({ ...form, [key]: value });
  }

  function renderClientCell(client: AdminClientRow, column: AdminColumnKey) {
    switch (column) {
      case "client":
        return (
          <td className="central-admin-client-cell" key={column}>
            <strong>{client.name}</strong>
            <span>{client.responsible || "Responsável não informado"}</span>
            <small>{client.phone || client.email || "Contato não informado"}</small>
            <div className="central-admin-meta-line"><span>{client.document ? "Cadastro documental" : "Sem documento cadastrado"}</span><span className="central-admin-badge neutral">{client.online ? "Online" : "Offline"}</span></div>
          </td>
        );
      case "plan":
        return <td key={column}><span className="central-admin-strong">Plano {client.config.plan}</span></td>;
      case "status":
        return <td key={column}><span className={`central-admin-status ${statusClass(client.config.status)}`}>{client.config.status}</span></td>;
      case "registration":
        return <td key={column}>{formatDate(client.registrationDate, "Sem registro")}</td>;
      case "due":
        return <td key={column}>{formatDate(client.dueDate, "Sem vencimento")}</td>;
      case "situation":
        return <td key={column}><span className={`central-admin-situation ${client.config.status === "Ativo" ? "good" : "attention"}`}>{client.situation}</span></td>;
      case "lastAccess":
        return <td key={column}>{client.lastAccess}</td>;
      case "online":
        return <td key={column}><span className="central-admin-badge neutral">{client.online ? "Online" : "Offline"}</span></td>;
      case "credits":
        return <td className="central-admin-credit-cell" key={column}>{client.config.aiCredits.balance}/{client.config.aiCredits.included}<small>{client.config.aiCredits.bonus} extras</small></td>;
      case "actions":
        return (
          <td className="central-admin-actions-cell" key={column}>
            <button aria-label={`Editar cadastro de ${client.name}`} className="central-admin-icon-button cyan" disabled={Boolean(busy)} onClick={() => openEditor(client)} title="Editar cadastro" type="button">✎</button>
            <button aria-label={`Confirmar pagamento de ${client.name}`} className="central-admin-icon-button green" disabled={Boolean(busy)} onClick={() => setPaymentClient(client)} title="Confirmar pagamento" type="button">R$</button>
            <button aria-label={`Adicionar créditos para ${client.name}`} className="central-admin-icon-button purple" disabled={Boolean(busy)} onClick={() => setCreditClient(client)} title="Adicionar créditos IA" type="button">✦</button>
            <button aria-label={`${client.config.status === "Pausado" ? "Reativar" : "Pausar"} ${client.name}`} className="central-admin-icon-button amber" disabled={Boolean(busy)} onClick={() => void handleTogglePause(client)} title={client.config.status === "Pausado" ? "Reativar acesso" : "Pausar acesso"} type="button">Ⅱ</button>
            <button aria-label={`Mover ${client.name} para inativos`} className="central-admin-icon-button red" disabled={Boolean(busy)} onClick={() => void handleRemove(client)} title="Mover para inativos" type="button">⌫</button>
          </td>
        );
      default:
        return null;
    }
  }

  function renderDetails(client: AdminClientRow) {
    const admins = client.users.filter((user) => user.role === "owner" || user.role === "admin");
    const readers = client.users.filter((user) => user.role === "reader");
    return (
      <tr className="central-admin-details-row" key={`${client.tenantId}-details`}>
        <td colSpan={columnOrder.length}>
          <div className="central-admin-details">
            <section className="central-admin-detail-card">
              <div className="central-admin-detail-heading"><div><strong>Sincronização com Portal</strong><span>Dados do vínculo deste cliente</span></div><span className="central-admin-synced">{portalSyncStatus.status === "success" || client.lastSyncAt ? "Sincronizado" : portalSyncStatus.status === "syncing" ? "Sincronizando" : "Aguardando"}</span></div>
              <dl className="central-admin-definition-grid">
                <div><dt>Identificador externo</dt><dd>{client.tenantId}</dd></div>
                <div><dt>ID interno</dt><dd>{client.tenantId}</dd></div>
                <div><dt>Data da última atualização</dt><dd>{formatDateTime(client.lastUpdatedAt)}</dd></div>
                <div><dt>Última sincronização</dt><dd>{formatDateTime(portalSyncStatus.lastSuccessAt || client.lastSyncAt)}</dd></div>
                <div><dt>Versão dos dados</dt><dd>{client.config.dataVersion ?? "Não informado"}</dd></div>
                <div><dt>Erro da última sincronização</dt><dd>{portalSyncStatus.lastError || client.config.lastSyncError || "Nenhum erro informado"}</dd></div>
              </dl>
            </section>
            <section className="central-admin-detail-card">
              <div className="central-admin-detail-heading"><div><strong>Usuários e acessos</strong><span>Administradores: {admins.length}/{client.config.employeeLimit}</span></div><span className="central-admin-detail-link">Controle de acesso</span></div>
              <div className="central-admin-responsible"><span className="central-admin-user-icon">♛</span><div><small>Responsável principal</small><strong>{client.responsible || "Não informado"}</strong><span>{client.email || "Gmail não informado"}</span></div></div>
              <div className="central-admin-user-group"><div><strong>Colaboradores administrativos</strong><span>{admins.length} cadastrado(s)</span></div>{admins.length ? admins.map((user) => <UserLine key={user.id} user={user} />) : <p>Nenhum colaborador administrativo cadastrado.</p>}</div>
              <div className="central-admin-user-group"><div><strong>Usuários finais</strong><span>{readers.length} cadastrado(s)</span></div>{readers.length ? readers.map((user) => <UserLine key={user.id} user={user} />) : <p>Nenhum usuário final classificado neste sistema.</p>}</div>
              <div className="central-admin-limit"><span>Limite administrativo do plano</span><strong>{admins.length}/{client.config.employeeLimit} usados</strong></div>
            </section>
          </div>
        </td>
      </tr>
    );
  }

  function renderTable(items: AdminClientRow[], emptyMessage: string) {
    if (!items.length) return <div className="central-admin-empty">{emptyMessage}</div>;
    return (
      <div className="central-admin-table-scroll">
        <table className="central-admin-table">
          <thead><tr>{columnOrder.map((column) => <th draggable={column !== "actions"} key={column} onDragEnd={() => setDraggedColumn(null)} onDragOver={(event) => event.preventDefault()} onDragStart={() => setDraggedColumn(column)} onDrop={() => moveColumn(column)}>{column !== "actions" ? <span className="central-admin-drag-handle">⁙</span> : null}{COLUMN_LABELS[column]}</th>)}</tr></thead>
          <tbody>
            {items.map((client) => <>
              <tr className="central-admin-client-row" key={client.tenantId}>
                {columnOrder.map((column) => renderClientCell(client, column))}
              </tr>
              <tr className="central-admin-details-trigger" key={`${client.tenantId}-trigger`}>
                <td colSpan={columnOrder.length}><button aria-expanded={expandedClient === client.tenantId} className="central-admin-details-button" onClick={() => setExpandedClient((current) => current === client.tenantId ? null : client.tenantId)} type="button"><span><strong>Detalhes operacionais</strong><small>{client.name} · atualizado {client.lastUpdatedAt ? formatDateTime(client.lastUpdatedAt) : "agora"}</small></span><b>{expandedClient === client.tenantId ? "Fechar detalhes" : "Abrir detalhes"}</b></button></td>
              </tr>
              {expandedClient === client.tenantId ? renderDetails(client) : null}
            </>)}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="central-admin-page">
      <header className="central-admin-page-header">
        <div><p className="central-admin-eyebrow">Orquestra.cs · Face ID</p><h1>Admin Orquestra.cs</h1><p>Central exclusiva para clientes, planos, créditos e status de assinatura.</p></div>
        <div className="central-admin-header-actions"><span className="central-admin-portal-status" data-status={portalSyncStatus.status}>{portalStatusLabel}</span><span>Atualizado em {new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</span><button className="central-admin-header-button cyan" disabled={syncing} onClick={() => void handlePortalSync()} type="button">{syncing ? "Sincronizando..." : "⇧ Sincronizar Portal"}</button><button className="central-admin-header-button success" onClick={() => void loadClients(true)} type="button">✓ {refreshing ? "Atualizando" : "Atualizado"}</button><a aria-label="Abrir Central Admin do Portal" className="central-admin-header-button portal" href={ORQUESTRA_PORTAL_ADMIN_URL} rel="noreferrer" target="_blank">↗ Central Admin Portal</a></div>
      </header>

      <section className="central-admin-notice"><div><strong>Admin Orquestra.cs</strong><p>Controle comercial dos clientes, convites, planos e status de assinatura.</p><span>Clientes sem configuração usam tolerância de 5 dias úteis</span></div><div className="central-admin-summary"><strong>{activeClients.length}</strong><span>clientes ativos</span><strong>{totalCredits}</strong><span>créditos disponíveis</span></div></section>

      <section className={`central-admin-new-client ${newClientOpen ? "open" : ""}`}>
        <button aria-expanded={newClientOpen} className="central-admin-new-client-toggle" onClick={() => setNewClientOpen((open) => !open)} type="button"><span className="central-admin-feature-icon">⚑</span><span><strong>Novo cliente e convite comercial</strong><small>Abra para cadastrar os dados completos e gerar o convite de acesso.</small></span><b>{newClientOpen ? "⌃" : "⌄"}</b></button>
        {newClientOpen ? <div className="central-admin-inline-form"><ClientFormFields form={newClientForm} onChange={(key, value) => updateForm(setNewClientForm, newClientForm, key, value)} compact /><div className="central-admin-form-actions"><button className="central-admin-button muted" onClick={() => setNewClientOpen(false)} type="button">Cancelar</button><button className="central-admin-button primary" disabled={busy === "create-client"} onClick={() => void handleCreateClient()} type="button">{busy === "create-client" ? "Criando..." : "Gerar convite"}</button></div></div> : null}
      </section>

      <section className="central-admin-list-section">
        <div className="central-admin-list-toolbar"><div><p>Clientes</p><span>{loading ? "Carregando dados reais..." : `${activeClients.length} cliente(s) ativo(s)`}</span></div><button aria-label="Restaurar ordem original das colunas" className="central-admin-reset-button" onClick={() => setColumnOrder(DEFAULT_COLUMN_ORDER)} title="Restaurar ordem das colunas" type="button">↻</button></div>
        {loading ? <div className="central-admin-loading">Carregando clientes autorizados...</div> : renderTable(activeClients, "Nenhum cliente ativo cadastrado.")}
      </section>

      <details className="central-admin-inactive"><summary>Clientes inativos <span>{inactiveClients.length}</span></summary><div>{renderTable(inactiveClients, "Nenhum cliente inativo.")}</div></details>
      {message ? <div className="central-admin-toast" role="status">{message}</div> : null}

      {editingClient ? <AdminModal title="Cadastro completo do cliente" subtitle={`Editar ${editingClient.name}`} onClose={() => setEditingClient(null)}><ClientFormFields form={editForm} onChange={(key, value) => updateForm(setEditForm, editForm, key, value)} /><div className="central-admin-form-actions"><button className="central-admin-button muted" onClick={() => setEditingClient(null)} type="button">Cancelar</button><button className="central-admin-button dark" disabled={busy === "save-edit"} onClick={() => void handleSaveEdit()} type="button">{busy === "save-edit" ? "Salvando..." : "Salvar alterações"}</button></div></AdminModal> : null}

      {creditClient ? <AdminModal title="Créditos IA" subtitle={creditClient.name} onClose={() => setCreditClient(null)}><div className="central-admin-credit-summary"><div><span>Saldo atual</span><strong>{creditClient.config.aiCredits.balance}</strong></div><div><span>Mensais</span><strong>{creditClient.config.aiCredits.included}</strong></div><div><span>Extras</span><strong>{creditClient.config.aiCredits.bonus}</strong></div></div><label className="central-admin-field"><span>Quantidade de créditos</span><input min="1" max="100000" onChange={(event) => setCreditAmount(event.target.value)} type="number" value={creditAmount} /></label><label className="central-admin-field"><span>Motivo obrigatório</span><textarea maxLength={300} onChange={(event) => setCreditReason(event.target.value)} placeholder="Ex.: compra do pacote de 300 créditos" value={creditReason} /></label><div className="central-admin-form-actions"><button className="central-admin-button muted" onClick={() => setCreditClient(null)} type="button">Cancelar</button><button className="central-admin-button purple" disabled={busy === "add-credits"} onClick={() => void handleAddCredits()} type="button">{busy === "add-credits" ? "Adicionando..." : "✦ Adicionar créditos"}</button></div></AdminModal> : null}

      {paymentClient ? <AdminModal title="Confirmar pagamento" subtitle={paymentClient.name} onClose={() => setPaymentClient(null)}><div className="central-admin-payment-note"><strong>Registrar pagamento manual</strong><p>Esta confirmação atualiza o status para “Em dia” e cria o próximo vencimento em 30 dias. A cobrança não é enviada a nenhum provedor.</p></div><div className="central-admin-payment-data"><span>Plano atual<strong>{paymentClient.config.plan}</strong></span><span>Mensalidade<strong>{paymentClient.config.billing.amount}</strong></span><span>Vencimento atual<strong>{formatDate(paymentClient.config.billing.dueDate, "Não definido")}</strong></span></div><div className="central-admin-form-actions"><button className="central-admin-button muted" onClick={() => setPaymentClient(null)} type="button">Cancelar</button><button className="central-admin-button dark" disabled={busy === "payment"} onClick={() => void handlePaymentConfirm()} type="button">{busy === "payment" ? "Confirmando..." : "✓ Confirmar pagamento"}</button></div></AdminModal> : null}

      {invites.length ? <section className="central-admin-invites"><div><strong>Convites recentes</strong><span>Os códigos continuam sujeitos à validade e às permissões do Firebase.</span></div><div>{invites.slice(0, 4).map((invite) => <span key={invite.code}>{invite.code} · {invite.companyName} · {invite.status}</span>)}</div></section> : null}
    </div>
  );
}

function UserLine({ user }: { user: TenantAdminUser }) {
  return <div className="central-admin-user-line"><span className={`central-admin-user-dot ${user.online ? "online" : ""}`} /><div><strong>{user.name}</strong><span>{roleLabel(user.role)} · {user.email || "e-mail não informado"}</span></div><small>{user.online ? "Online" : formatDateTime(user.lastAccessAt, "Sem acesso")}</small></div>;
}

function AdminModal({ children, onClose, subtitle, title }: { children: React.ReactNode; onClose: () => void; subtitle: string; title: string }) {
  return <div className="central-admin-modal-shell" role="presentation"><button aria-label="Fechar modal" className="central-admin-modal-backdrop" onClick={onClose} type="button" /><section aria-labelledby="central-admin-modal-title" aria-modal="true" className="central-admin-modal" role="dialog"><header><div><p className="central-admin-eyebrow">Cadastro completo do cliente</p><h2 id="central-admin-modal-title">{title}</h2><p>{subtitle}</p></div><button aria-label="Fechar modal" className="central-admin-modal-close" onClick={onClose} type="button">×</button></header><div className="central-admin-modal-body">{children}</div></section></div>;
}

function ClientFormFields({ compact = false, form, onChange }: { compact?: boolean; form: ClientForm; onChange: (key: keyof ClientForm, value: string) => void }) {
  const field = (key: keyof ClientForm, label: string, type = "text", placeholder = "") => <label className="central-admin-field"><span>{label}</span><input onChange={(event) => onChange(key, event.target.value)} placeholder={placeholder} type={type} value={fieldValue(form, key)} /></label>;
  return <div className={`central-admin-form-grid ${compact ? "compact" : ""}`}>
    {field("companyName", "Nome do cliente", "text", "Nome da empresa")}
    {field("responsibleName", "Responsável principal", "text", "Nome do responsável")}
    {field("email", "E-mail/Gmail de acesso", "email", "cliente@empresa.com")}
    {field("phone", "Telefone / WhatsApp", "tel", "(15) 99999-9999")}
    {field("document", "CPF ou CNPJ", "text", "00.000.000/0000-00")}
    <label className="central-admin-field"><span>Plano contratado</span><select onChange={(event) => onChange("plan", event.target.value)} value={form.plan}><option>Essencial</option><option>Profissional</option><option>Enterprise</option></select></label>
    {!compact ? <><label className="central-admin-field"><span>Status da assinatura</span><select onChange={(event) => onChange("status", event.target.value)} value={form.status}><option>Ativo</option><option>Teste</option><option>Pausado</option><option>Bloqueado</option></select></label>{field("legalName", "Razão social", "text", "Razão social")}{field("tradeName", "Nome fantasia", "text", "Nome fantasia")}{field("monthlyFee", "Mensalidade", "text", "R$ 199,00")}{field("dueDate", "Próximo vencimento", "date")}{field("registrationDate", "Data de inscrição", "date")}{field("graceDays", "Tolerância após vencimento", "number", "5")}{field("paymentMethod", "Forma de pagamento", "text", "PIX")}{field("cep", "CEP", "text", "00000-000")}{field("street", "Rua ou avenida", "text", "Rua")}{field("number", "Número", "text", "123")}{field("complement", "Complemento", "text", "Sala, galpão")}{field("neighborhood", "Bairro", "text", "Centro")}{field("city", "Cidade", "text", "Cidade")}{field("state", "Estado", "text", "SP")}{field("mapsUrl", "Link do Google Maps", "url", "https://maps.google.com")}</> : null}
    {!compact ? <label className="central-admin-field full"><span>Observações internas</span><textarea maxLength={1000} onChange={(event) => onChange("notes", event.target.value)} placeholder="Observações sobre o cliente" value={form.notes} /></label> : null}
  </div>;
}
