import { collection, doc, getDoc, getDocs, increment, query, serverTimestamp, setDoc, Timestamp, updateDoc, where } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase/client";

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
    included: number;
    status: "Ativo" | "Bloqueado";
    used: number;
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

  return {
    companyName: String(data.companyName || "Empresa"),
    role: (data.role || "reader") as TenantRole,
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
  const data = snapshot.data() || {};
  const aiCredits = data.aiCredits || {};
  const billing = data.billing || {};

  return {
    aiCredits: {
      balance: Number(aiCredits.balance || 150),
      included: Number(aiCredits.included || 150),
      status: (aiCredits.status || "Ativo") as TenantSaasConfig["aiCredits"]["status"],
      used: Number(aiCredits.used || 0),
    },
    billing: {
      amount: String(billing.amount || "R$ 0,00"),
      dueDate: String(billing.dueDate || ""),
      graceDays: Number(billing.graceDays || 5),
      status: (billing.status || "Teste") as TenantSaasConfig["billing"]["status"],
    },
    employeeLimit: Number(data.employeeLimit || 25),
    name: String(data.name || "Cliente Face ID"),
    plan: (data.plan || "Essencial") as TenantSaasConfig["plan"],
    status: (data.status || "Teste") as TenantSaasConfig["status"],
    tenantId,
  };
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

export async function consumeAiCredit(tenantId = DEFAULT_TENANT_ID, amount = 1) {
  const current = await getTenantSaasConfig(tenantId);

  if (current.aiCredits.status === "Bloqueado" || current.aiCredits.balance < amount) {
    throw new Error("ai-credits-unavailable");
  }

  await updateDoc(doc(db, `tenants/${tenantId}`), {
    "aiCredits.balance": increment(-amount),
    "aiCredits.used": increment(amount),
    updatedAt: serverTimestamp(),
  });

  return {
    ...current,
    aiCredits: {
      ...current.aiCredits,
      balance: current.aiCredits.balance - amount,
      used: current.aiCredits.used + amount,
    },
  };
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
