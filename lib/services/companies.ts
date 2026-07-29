import { addDoc, collection, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { db } from "@/lib/firebase/client";
import { storage } from "@/lib/firebase/client";
import { companyLogoPath } from "@/lib/firebase/paths";
import type { Company } from "@/lib/models";

const companiesRef = collection(db, "companies");
export const MAIN_COMPANY_ID = "main";

export async function createCompany(company: Omit<Company, "id">) {
  return addDoc(companiesRef, company);
}

export async function getCompany(companyId: string) {
  const snapshot = await getDoc(doc(db, "companies", companyId));
  return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as Company) : null;
}

export async function listCompanies() {
  const snapshot = await getDocs(companiesRef);
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Company);
}

export async function updateCompany(companyId: string, data: Partial<Company>) {
  return updateDoc(doc(db, "companies", companyId), data);
}

export async function saveMainCompany(data: Record<string, unknown>) {
  return setDoc(
    doc(db, "companies", MAIN_COMPANY_ID),
    {
      ...data,
      id: MAIN_COMPANY_ID,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
}

export async function getMainCompany() {
  const snapshot = await getDoc(doc(db, "companies", MAIN_COMPANY_ID));
  return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as Record<string, unknown>) : null;
}

export async function uploadMainCompanyLogo(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "webp";
  const logoRef = ref(storage, companyLogoPath(MAIN_COMPANY_ID, extension));

  await uploadBytes(logoRef, file, {
    contentType: file.type || "image/webp",
  });

  const logoUrl = await getDownloadURL(logoRef);
  await saveMainCompany({ logoUrl });

  return logoUrl;
}
