import { addDoc, collection, getDocs } from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { db, storage } from "@/lib/firebase/client";
import { attendanceEvidencePath } from "@/lib/firebase/paths";
import type { AttendanceJustification } from "@/lib/models";

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
  return addDoc(justificationsRef(companyId), justification);
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
