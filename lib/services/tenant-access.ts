import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, updateDoc, where } from "firebase/firestore";
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
