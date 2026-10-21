import { getFunctions, httpsCallable } from "firebase/functions";
import { firebaseApp } from "@/lib/firebase/client";

type PortalSyncResult = {
  clients: number;
  ok: boolean;
  users: number;
};

const functions = getFunctions(firebaseApp, "us-east1");

export async function syncPortalSnapshot() {
  const callable = httpsCallable<Record<string, never>, PortalSyncResult>(functions, "syncPortalSnapshot");
  const response = await callable({});
  return response.data;
}
