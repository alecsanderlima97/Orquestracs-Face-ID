import { addDoc, collection, doc, getDoc, getDocs, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { Company } from "@/lib/models";

const companiesRef = collection(db, "companies");

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
