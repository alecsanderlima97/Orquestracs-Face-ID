import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, updateDoc, where } from "firebase/firestore";
import type { User } from "firebase/auth";
import { auth, db } from "@/lib/firebase/client";

export type TenantRole = "owner" | "admin" | "reader" | "developer";

export type TenantAccess = {
  companyName: string;
  role: TenantRole;
  tenantId: string;
};

export type TenantInvite = {
  code: string;
  companyName: string;
  createdAt?: Timestamp;
  expiresAt?: Timestamp;
  role: Exclude<TenantRole, "developer">;
  status: "Ativo" | "Usado" | "Cancelado" | "Expirado";
  tenantId: string;
  usedBy?: string;
};

export type TenantSaasConfig = {
  aiCredits: {
    balance: number;
    bonus: number;
    included: number;
    renewalMonth: string;
    status: "Ativo" | "Bloqueado";
    used: number;
    lastAdjustmentAt?: string;
    lastAdjustmentBy?: string;
  };
  billing: {
    amount: string;
    dueDate: string;
    graceDays: number;
    status: "Em dia" | "Teste" | "Inadimplente" | "Bloqueado";
  };
  employeeLimit: number;
  name: string;
  plan: "Essencial" | "Profissional" | "Enterprise";
  status: "Ativo" | "Teste" | "Pausado" | "Bloqueado";
  tenantId: string;
  dataVersion?: number;
  lastSyncError?: string;
};

export type TenantAdminUser = {
  id: string;
  name: string;
  email: string;
  role: TenantRole;
  active: boolean;
  lastActivityAt?: string;
  lastAccessAt?: string;
  device?: string;
  online: boolean;
};

export type TenantAdminClient = {
  tenantId: string;
  company: Record<string, unknown>;
  config: TenantSaasConfig;
  users: TenantAdminUser[];
  lastUpdatedAt?: string;
  lastSyncAt?: string;
};

export const PLATFORM_OWNER_EMAILS = ["orquestracs@gmail.com"];
export const DEFAULT_TENANT_ID = "main";

export function isPlatformOwnerEmail(email?: string | null) {
  return PLATFORM_OWNER_EMAILS.includes((email || "").toLowerCase());
}

export async function getUserTenantAccess(user: User): Promise<TenantAccess | null> {
  if (isPlatformOwnerEmail(user.email)) {
    return {
      companyName: "Orquestracs",
      role: "developer",
      tenantId: DEFAULT_TENANT_ID,
    };
  }

  const memberships = await getDocs(collection(db, `userTenants/${user.uid}/memberships`));
  if (memberships.empty) return null;

  const membership = memberships.docs[0];
  const data = membership.data();
  const tenantUser = await getDoc(doc(db, `tenants/${membership.id}/users/${user.uid}`));

  if (!tenantUser.exists()) return null;

  const canonicalAccess = tenantUser.data();

  return {
    companyName: String(data.companyName || "Empresa"),
    role: (canonicalAccess.role || "reader") as TenantRole,
    tenantId: membership.id,
  };
}

export async function createTenantInvite({
  companyName,
  role,
  tenantId = DEFAULT_TENANT_ID,
}: {
  companyName: string;
  role: Exclude<TenantRole, "developer">;
  tenantId?: string;
}) {
  const code = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  const invite: TenantInvite = {
    code,
    companyName: companyName.trim() || "Empresa convidada",
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
    role,
    status: "Ativo",
    tenantId,
  };

  await setDoc(doc(db, "invites", code), {
    ...invite,
    createdAt: serverTimestamp(),
  });

  return invite;
}

export async function listTenantInvites(tenantId = DEFAULT_TENANT_ID) {
  const snapshot = await getDocs(query(collection(db, "invites"), where("tenantId", "==", tenantId)));
  const now = Date.now();

  return snapshot.docs
    .map((item) => ({ ...item.data(), code: item.id }) as TenantInvite)
    .map((invite) =>
      invite.status === "Ativo" && invite.expiresAt && invite.expiresAt.toMillis() < now
        ? { ...invite, status: "Expirado" as const }
        : invite,
    )
    .sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
}

export async function getTenantSaasConfig(tenantId = DEFAULT_TENANT_ID): Promise<TenantSaasConfig> {
  const snapshot = await getDoc(doc(db, `tenants/${tenantId}`));
  return mapTenantSaasConfig(snapshot.data() || {}, tenantId);
}

function mapTenantSaasConfig(data: Record<string, unknown>, tenantId: string): TenantSaasConfig {
  const aiCredits = data.aiCredits && typeof data.aiCredits === "object"
    ? data.aiCredits as Record<string, unknown>
    : {};
  const billing = data.billing && typeof data.billing === "object"
    ? data.billing as Record<string, unknown>
    : {};

  return {
    aiCredits: {
      balance: Number(aiCredits.balance ?? 150),
      bonus: Number(aiCredits.bonus ?? 0),
      included: Number(aiCredits.included ?? 150),
      renewalMonth: String(aiCredits.renewalMonth ?? new Date().toISOString().slice(0, 7)),
      status: (aiCredits.status || "Ativo") as TenantSaasConfig["aiCredits"]["status"],
      used: Number(aiCredits.used ?? 0),
      lastAdjustmentAt: aiCredits.lastAdjustmentAt ? String(aiCredits.lastAdjustmentAt) : undefined,
      lastAdjustmentBy: aiCredits.lastAdjustmentBy ? String(aiCredits.lastAdjustmentBy) : undefined,
    },
    billing: {
      amount: String(billing.amount || "R$ 0,00"),
      dueDate: String(billing.dueDate || ""),
      graceDays: Number(billing.graceDays ?? 5),
      status: (billing.status || "Teste") as TenantSaasConfig["billing"]["status"],
    },
    employeeLimit: Number(data.employeeLimit ?? 25),
    name: String(data.name || "Cliente Face ID"),
    plan: (data.plan || "Essencial") as TenantSaasConfig["plan"],
    status: (data.status || "Teste") as TenantSaasConfig["status"],
    tenantId,
    dataVersion: Number.isInteger(data.dataVersion) ? Number(data.dataVersion) : undefined,
    lastSyncError: data.lastSyncError ? String(data.lastSyncError) : undefined,
  };
}

function timestampToIso(value: unknown) {
  if (value && typeof (value as { toDate?: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }

  if (typeof value === "string" && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  return undefined;
}

export async function listPlatformTenantClients(): Promise<TenantAdminClient[]> {
  if (!isPlatformOwnerEmail(auth.currentUser?.email)) {
    throw new Error("platform-admin-required");
  }

  const tenantsSnapshot = await getDocs(collection(db, "tenants"));
  const clients = await Promise.all(tenantsSnapshot.docs.map(async (tenantDocument) => {
    const tenantData = tenantDocument.data() || {};
    const companySnapshot = await getDoc(doc(db, `companies/${tenantDocument.id}`));
    const usersSnapshot = await getDocs(collection(db, `tenants/${tenantDocument.id}/users`));
    const users = usersSnapshot.docs.map((userDocument) => {
      const user = userDocument.data() || {};
      const lastActivityAt = timestampToIso(user.lastActivityAt || user.updatedAt);
      const lastAccessAt = timestampToIso(user.lastLoginAt || user.lastAccessAt || user.lastSeenAt);
      const lastSeenAt = timestampToIso(user.lastSeenAt || user.lastActivityAt || user.updatedAt);
      const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : 0;

      return {
        id: userDocument.id,
        name: String(user.name || user.email || "Usuario"),
        email: String(user.email || ""),
        role: (user.role || "reader") as TenantRole,
        active: user.active !== false,
        lastActivityAt,
        lastAccessAt,
        device: String(user.deviceType || user.device?.type || "") || undefined,
        online: Boolean(lastSeenMs && Date.now() - lastSeenMs <= 2 * 60 * 1000),
      } satisfies TenantAdminUser;
    });

    return {
      tenantId: tenantDocument.id,
      company: (companySnapshot.data() || {}) as Record<string, unknown>,
      config: mapTenantSaasConfig(tenantData, tenantDocument.id),
      users,
      lastUpdatedAt: timestampToIso(tenantData.updatedAt),
      lastSyncAt: timestampToIso(tenantData.lastSyncAt),
    } satisfies TenantAdminClient;
  }));

  return clients;
}

export async function saveTenantSaasConfig(
  tenantId = DEFAULT_TENANT_ID,
  config: Omit<TenantSaasConfig, "tenantId">,
) {
  await setDoc(
    doc(db, `tenants/${tenantId}`),
    {
      ...config,
      tenantId,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function acceptTenantInvite(code: string, user: User) {
  const normalizedCode = code.trim().toUpperCase();
  const snapshot = await getDoc(doc(db, "invites", normalizedCode));

  if (!snapshot.exists()) throw new Error("invite-not-found");

  const invite = { ...snapshot.data(), code: snapshot.id } as TenantInvite;
  const expired = invite.expiresAt && invite.expiresAt.toMillis() < Date.now();

  if (invite.status !== "Ativo" || expired) throw new Error("invite-unavailable");

  await setDoc(
    doc(db, `tenants/${invite.tenantId}/users/${user.uid}`),
    {
      createdAt: serverTimestamp(),
      email: user.email || "",
      inviteCode: normalizedCode,
      name: user.displayName || user.email || "Usuario",
      role: invite.role,
      userId: user.uid,
    },
    { merge: true },
  );

  await setDoc(
    doc(db, `userTenants/${user.uid}/memberships/${invite.tenantId}`),
    {
      companyName: invite.companyName,
      createdAt: serverTimestamp(),
      role: invite.role,
    },
    { merge: true },
  );

  await updateDoc(doc(db, "invites", normalizedCode), {
    status: "Usado",
    usedAt: serverTimestamp(),
    usedBy: user.uid,
  });

  return {
    companyName: invite.companyName,
    role: invite.role,
    tenantId: invite.tenantId,
  } satisfies TenantAccess;
}
