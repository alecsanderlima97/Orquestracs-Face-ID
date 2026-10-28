import { collection, getDocs } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { firebaseApp, db } from "@/lib/firebase/client";
import type { BankHoursAdjustment } from "@/lib/models";

const functions = getFunctions(firebaseApp, "us-east1");

function adjustmentsRef(companyId: string) {
  return collection(db, "companies", companyId, "bankHoursAdjustments");
}

export async function listBankHoursAdjustments(companyId: string) {
  const snapshot = await getDocs(adjustmentsRef(companyId));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as BankHoursAdjustment);
}

export async function createBankHoursAdjustment(
  companyId: string,
  adjustment: Pick<BankHoursAdjustment, "employeeId" | "effectiveDate" | "minutes" | "direction" | "reason" | "responsibleName">,
) {
  const callable = httpsCallable<
    Pick<BankHoursAdjustment, "employeeId" | "effectiveDate" | "minutes" | "direction" | "reason" | "responsibleName"> & { companyId: string },
    { adjustmentId: string; status: string }
  >(functions, "createBankHoursAdjustment");
  const result = await callable({ ...adjustment, companyId });
  return { id: result.data.adjustmentId, ...result.data };
}

export async function reviewBankHoursAdjustment(
  companyId: string,
  adjustmentId: string,
  decision: "approved" | "rejected",
  reviewReason = "",
) {
  const callable = httpsCallable<
    { companyId: string; adjustmentId: string; decision: "approved" | "rejected"; reviewReason: string },
    { adjustmentId: string; status: string }
  >(functions, "reviewBankHoursAdjustment");
  const result = await callable({ companyId, adjustmentId, decision, reviewReason });
  return result.data;
}
