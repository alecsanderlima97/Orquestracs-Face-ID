import { addDoc, collection } from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { db, storage } from "@/lib/firebase/client";
import { facePhotoPath } from "@/lib/firebase/paths";
import type { FaceIdRecord } from "@/lib/models";

function faceIdRef(companyId: string, employeeId: string) {
  return collection(db, "companies", companyId, "employees", employeeId, "faceId");
}

export async function uploadFacePhoto({
  blob,
  companyId,
  employeeId,
  photoId,
}: {
  blob: Blob;
  companyId: string;
  employeeId: string;
  photoId: string;
}) {
  const path = facePhotoPath(companyId, employeeId, photoId);
  await uploadBytes(ref(storage, path), blob, { contentType: "image/webp" });
  return path;
}

export async function createFaceIdRecord(record: Omit<FaceIdRecord, "id">) {
  return addDoc(faceIdRef(record.companyId, record.employeeId), record);
}
