import { addDoc, collection, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { Employee } from "@/lib/models";

function employeesRef(companyId: string) {
  return collection(db, "companies", companyId, "employees");
}

export async function createEmployee(companyId: string, employee: Omit<Employee, "id">) {
  return addDoc(employeesRef(companyId), employee);
}

export async function upsertEmployee(companyId: string, employeeId: string, employee: Record<string, unknown>) {
  return setDoc(
    doc(db, "companies", companyId, "employees", employeeId),
    {
      ...employee,
      companyId,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function getEmployee(companyId: string, employeeId: string) {
  const snapshot = await getDoc(doc(db, "companies", companyId, "employees", employeeId));
  return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as Employee) : null;
}

export async function listEmployees(companyId: string) {
  const snapshot = await getDocs(employeesRef(companyId));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Employee);
}

export async function updateEmployee(
  companyId: string,
  employeeId: string,
  data: Partial<Employee>,
) {
  return updateDoc(doc(db, "companies", companyId, "employees", employeeId), data);
}
