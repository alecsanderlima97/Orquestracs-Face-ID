import { doc, onSnapshot } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { auth, db, firebaseApp } from "@/lib/firebase/client";
import { isPlatformOwnerEmail } from "@/lib/services/tenant-access";

type PortalSyncResult = {
  clients: number;
  ok: boolean;
  skipped?: boolean;
  users: number;
};

export type PortalSyncStatus = {
  lastAttemptAt?: string;
  lastClients: number;
  lastError?: string;
  lastFailureAt?: string;
  lastInboundAt?: string;
  lastInboundCommandId?: string;
  lastInboundStatus?: string;
  lastReason?: string;
  lastSuccessAt?: string;
  lastUsers: number;
  status: "idle" | "syncing" | "success" | "error";
};

const functions = getFunctions(firebaseApp, "us-east1");

export async function syncPortalSnapshot() {
  const callable = httpsCallable<Record<string, never>, PortalSyncResult>(functions, "syncPortalSnapshot");
  const response = await callable({});
  return response.data;
}

function timestampToIso(value: unknown) {
  if (value && typeof (value as { toDate?: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === "string" && value ? value : undefined;
}

function mapPortalSyncStatus(data: Record<string, unknown> = {}): PortalSyncStatus {
  const status = ["idle", "syncing", "success", "error"].includes(String(data.status))
    ? String(data.status) as PortalSyncStatus["status"]
    : "idle";
  return {
    lastAttemptAt: timestampToIso(data.lastAttemptAt),
    lastClients: Number(data.lastClients || 0),
    lastError: data.lastError ? String(data.lastError) : undefined,
    lastFailureAt: timestampToIso(data.lastFailureAt),
    lastInboundAt: timestampToIso(data.lastInboundAt),
    lastInboundCommandId: data.lastInboundCommandId ? String(data.lastInboundCommandId) : undefined,
    lastInboundStatus: data.lastInboundStatus ? String(data.lastInboundStatus) : undefined,
    lastReason: data.lastReason ? String(data.lastReason) : undefined,
    lastSuccessAt: timestampToIso(data.lastSuccessAt),
    lastUsers: Number(data.lastUsers || 0),
    status,
  };
}

export function subscribePortalSyncStatus(
  onChange: (status: PortalSyncStatus) => void,
  onError: (error: Error) => void,
) {
  if (!isPlatformOwnerEmail(auth.currentUser?.email)) {
    onError(new Error("platform-admin-required"));
    return () => undefined;
  }

  return onSnapshot(
    doc(db, "connectorState", "portal"),
    (snapshot) => onChange(mapPortalSyncStatus(snapshot.data() as Record<string, unknown> | undefined)),
    onError,
  );
}
