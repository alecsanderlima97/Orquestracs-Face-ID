import { addDoc, collection } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { AuditLog } from "@/lib/models";

function auditLogsRef(companyId: string) {
  return collection(db, "companies", companyId, "auditLogs");
}

export async function createAuditLog(companyId: string, log: Omit<AuditLog, "id">) {
  return addDoc(auditLogsRef(companyId), log);
}
