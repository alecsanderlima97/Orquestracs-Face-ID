import { ref, uploadBytes } from "firebase/storage";
import { storage } from "@/lib/firebase/client";
import { reportPath } from "@/lib/firebase/paths";

export async function uploadReportPdf({
  blob,
  companyId,
  reportId,
}: {
  blob: Blob;
  companyId: string;
  reportId: string;
}) {
  const path = reportPath(companyId, reportId);
  await uploadBytes(ref(storage, path), blob, { contentType: "application/pdf" });
  return path;
}
