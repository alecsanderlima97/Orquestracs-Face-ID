import { ref, uploadBytes } from "firebase/storage";
import { punchPhotoPath } from "@/lib/firebase/paths";
import { storage } from "@/lib/firebase/client";

export async function uploadPunchPhoto({
  blob,
  companyId,
  employeeId,
  occurredAt,
  punchId,
}: {
  blob: Blob;
  companyId: string;
  employeeId: string;
  occurredAt: Date;
  punchId: string;
}) {
  const date = occurredAt.toISOString().slice(0, 10);
  const path = punchPhotoPath(companyId, employeeId, date, punchId);
  await uploadBytes(ref(storage, path), blob, { contentType: "image/webp" });
  return path;
}
