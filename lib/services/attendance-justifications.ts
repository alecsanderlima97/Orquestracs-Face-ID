import { collection, getDocs } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { ref, uploadBytes } from "firebase/storage";
import { db, firebaseApp, storage } from "@/lib/firebase/client";
import { attendanceEvidencePath } from "@/lib/firebase/paths";
import type { AttendanceJustification } from "@/lib/models";

const functions = getFunctions(firebaseApp, "us-east1");

function justificationsRef(companyId: string) {
  return collection(db, "companies", companyId, "attendanceJustifications");
}

export async function listAttendanceJustifications(companyId: string) {
  const snapshot = await getDocs(justificationsRef(companyId));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as AttendanceJustification);
}

export async function createAttendanceJustification(
  companyId: string,
  justification: Omit<AttendanceJustification, "id">,
) {
  const callable = httpsCallable<
    Omit<AttendanceJustification, "id"> & { companyId: string },
    { justificationId: string; status: string }
  >(functions, "createAttendanceJustification");
  const result = await callable({ ...justification, companyId });
  return { id: result.data.justificationId, ...result.data };
}

export async function reviewAttendanceJustification(
  companyId: string,
  justificationId: string,
  decision: "approved" | "rejected",
  reviewReason = "",
) {
  const callable = httpsCallable<
    { companyId: string; justificationId: string; decision: "approved" | "rejected"; reviewReason: string },
    { justificationId: string; status: string }
  >(functions, "reviewAttendanceJustification");
  const result = await callable({ companyId, justificationId, decision, reviewReason });
  return result.data;
}

export async function uploadAttendanceEvidence({
  blob,
  companyId,
  employeeId,
  date,
  evidenceId,
}: {
  blob: Blob;
  companyId: string;
  employeeId: string;
  date: string;
  evidenceId: string;
}) {
  const extension = blob.type === "application/pdf" ? "pdf" : "jpg";
  const path = attendanceEvidencePath(companyId, employeeId, date, evidenceId, extension);
  await uploadBytes(ref(storage, path), blob, { contentType: blob.type });
  return path;
}
