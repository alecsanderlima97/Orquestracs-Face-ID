import { readFile } from "node:fs/promises";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";

const projectId = "demo-orquestracs-face-id";
const rules = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");
const testEnv = await initializeTestEnvironment({
  projectId,
  firestore: { rules },
});

try {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    await Promise.all([
      setDoc(doc(db, "companies/tenant-a"), { name: "Empresa A" }),
      setDoc(doc(db, "companies/tenant-b"), { name: "Empresa B" }),
      setDoc(doc(db, "companies/tenant-a/employees/employee-a"), { name: "Colaborador A" }),
      setDoc(doc(db, "companies/tenant-b/employees/employee-b"), { name: "Colaborador B" }),
      setDoc(doc(db, "tenants/tenant-a/users/user-a"), { role: "owner" }),
      setDoc(doc(db, "tenants/tenant-b/users/user-b"), { role: "owner" }),
    ]);
  });

  const userA = testEnv.authenticatedContext("user-a", { email: "user-a@example.com" });
  const dbA = userA.firestore();

  await assertSucceeds(getDoc(doc(dbA, "companies/tenant-a")));
  await assertSucceeds(getDoc(doc(dbA, "companies/tenant-a/employees/employee-a")));
  await assertSucceeds(updateDoc(doc(dbA, "companies/tenant-a"), { name: "Empresa A atualizada" }));

  await assertFails(getDoc(doc(dbA, "companies/tenant-b")));
  await assertFails(getDoc(doc(dbA, "companies/tenant-b/employees/employee-b")));
  await assertFails(updateDoc(doc(dbA, "companies/tenant-b"), { name: "Acesso indevido" }));
  await assertFails(setDoc(doc(dbA, "tenants/tenant-b/users/user-a"), { role: "admin" }));
} finally {
  await testEnv.cleanup();
}

console.log("Firestore tenant isolation: OK");
