import { addDoc, collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { Punch, PunchAdjustment } from "@/lib/models";

function punchesRef(companyId: string) {
  return collection(db, "companies", companyId, "punches");
}

function adjustmentsRef(companyId: string) {
  return collection(db, "companies", companyId, "adjustments");
}

export async function createPunch(companyId: string, punch: Omit<Punch, "id">) {
  return addDoc(punchesRef(companyId), punch);
}

export async function listEmployeePunches(companyId: string, employeeId: string) {
  const snapshot = await getDocs(
    query(punchesRef(companyId), where("employeeId", "==", employeeId)),
  );
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Punch);
}

export async function createPunchAdjustment(
  companyId: string,
  adjustment: Omit<PunchAdjustment, "id">,
) {
  return addDoc(adjustmentsRef(companyId), adjustment);
}
