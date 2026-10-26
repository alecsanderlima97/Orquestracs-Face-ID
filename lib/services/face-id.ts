import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { ref, uploadBytes } from "firebase/storage";
import { db, firebaseApp, storage } from "@/lib/firebase/client";
import { facePhotoPath } from "@/lib/firebase/paths";
import type { FaceIdRecord } from "@/lib/models";

const functions = getFunctions(firebaseApp, "us-east1");

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
  const callable = httpsCallable<
    Omit<FaceIdRecord, "id"> & { consentVersion: string },
    { faceId: string }
  >(functions, "registerFaceIdCapture");
  const result = await callable({ ...record, consentVersion: "biometria-v1" });
  return { id: result.data.faceId };
}

export async function listFaceIdRecords(companyId: string, employeeId: string) {
  const snapshot = await getDocs(query(faceIdRef(companyId, employeeId), orderBy("createdAt", "desc")));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as FaceIdRecord);
}
