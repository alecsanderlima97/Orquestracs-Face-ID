import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getFunctions, httpsCallable } from "firebase/functions";
import { firebaseApp } from "@/lib/firebase/client";
import type { Punch, PunchAdjustment } from "@/lib/models";

const functions = getFunctions(firebaseApp, "us-east1");

function punchesRef(companyId: string) {
  return collection(db, "companies", companyId, "punches");
}

function adjustmentsRef(companyId: string) {
  return collection(db, "companies", companyId, "adjustments");
}

export async function listPunchAdjustments(companyId: string) {
  const snapshot = await getDocs(adjustmentsRef(companyId));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as PunchAdjustment);
}

export async function listEmployeePunches(companyId: string, employeeId: string) {
  const snapshot = await getDocs(
    query(punchesRef(companyId), where("employeeId", "==", employeeId)),
  );
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Punch);
}

export async function listEmployeePunchesByIds(companyId: string, employeeIds: string[]) {
  const uniqueIds = Array.from(new Set(employeeIds.filter(Boolean)));
  if (!uniqueIds.length) return [];

  const snapshots = await Promise.all(
    uniqueIds.map((employeeId) =>
      getDocs(query(punchesRef(companyId), where("employeeId", "==", employeeId))),
    ),
  );

  return snapshots.flatMap((snapshot) =>
    snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Punch),
  );
}

export async function createPunchAdjustment(
  companyId: string,
  adjustment: Omit<PunchAdjustment, "id">,
) {
  const callable = httpsCallable<
    Omit<PunchAdjustment, "id"> & { companyId: string },
    { adjustmentId: string; status: string }
  >(functions, "createPunchAdjustment");
  const result = await callable({ ...adjustment, companyId });
  return { id: result.data.adjustmentId, ...result.data };
}

export async function reviewPunchAdjustment(
  companyId: string,
  adjustmentId: string,
  decision: "approved" | "rejected",
  reviewReason = "",
) {
  const callable = httpsCallable<
    { companyId: string; adjustmentId: string; decision: "approved" | "rejected"; reviewReason: string },
    { adjustmentId: string; status: string }
  >(functions, "reviewPunchAdjustment");
  const result = await callable({ companyId, adjustmentId, decision, reviewReason });
  return result.data;
}
