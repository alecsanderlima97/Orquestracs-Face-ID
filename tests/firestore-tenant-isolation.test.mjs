import { readFile } from "node:fs/promises";
import { doc, getDoc, setDoc, Timestamp, updateDoc } from "firebase/firestore";
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
      setDoc(doc(db, "tenants/tenant-a/users/admin-a"), { role: "admin" }),
      setDoc(doc(db, "tenants/tenant-b/users/user-b"), { role: "owner" }),
      setDoc(doc(db, "invites/EMAIL1234"), {
        email: "invitee@example.com",
        expiresAt: Timestamp.fromDate(new Date(Date.now() + 60 * 60 * 1000)),
        role: "admin",
        status: "Ativo",
        tenantId: "tenant-a",
      }),
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

  const adminDb = testEnv.authenticatedContext("admin-a", { email: "admin-a@example.com" }).firestore();
  const inviteDoc = (role) => ({
    email: "new-user@example.com",
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 60 * 60 * 1000)),
    role,
    status: "Ativo",
    tenantId: "tenant-a",
  });
  await assertSucceeds(setDoc(doc(adminDb, "invites/ADMIN1234"), inviteDoc("reader")));
  await assertFails(setDoc(doc(adminDb, "invites/OWNER123"), inviteDoc("owner")));

  const invitedUserDb = testEnv.authenticatedContext("invited-user", { email: "invitee@example.com" }).firestore();
  const wrongUserDb = testEnv.authenticatedContext("wrong-user", { email: "other@example.com" }).firestore();
  const acceptedInviteUser = {
    email: "invitee@example.com",
    inviteCode: "EMAIL1234",
    role: "admin",
    userId: "invited-user",
  };
  await assertSucceeds(setDoc(doc(invitedUserDb, "tenants/tenant-a/users/invited-user"), acceptedInviteUser));
  await assertFails(setDoc(doc(wrongUserDb, "tenants/tenant-a/users/wrong-user"), {
    ...acceptedInviteUser,
    email: "other@example.com",
    userId: "wrong-user",
  }));

  // Pontos, biometria e configuracao REP-P: o navegador nao pode alterar nem ler estados internos.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await Promise.all([
      setDoc(doc(db, "tenants/tenant-a/users/reader-a"), { role: "reader" }),
      setDoc(doc(db, "companies/tenant-a"), { name: "Empresa A", repP: { mode: "pilot" }, inpiRegistration: "" }),
      setDoc(doc(db, "companies/tenant-a/employees/employee-a/faceId/face-1"), {
        photoPath: "companies/tenant-a/employees/employee-a/face-id/p.webp",
      }),
      setDoc(doc(db, "companies/tenant-a/punchGuard/employee-a"), { lastOccurredAtMs: 1 }),
      setDoc(doc(db, "companies/tenant-a/pinAttempts/user-a"), { failures: 0 }),
      setDoc(doc(db, "companies/tenant-a/employeePins/employee-a"), { employeeId: "employee-a", pinHash: "hash-a" }),
      setDoc(doc(db, "companies/tenant-a/punches/punch-a"), { employeeId: "employee-a", type: "entry" }),
    ]);
  });

  const readerA = testEnv.authenticatedContext("reader-a", { email: "reader-a@example.com" }).firestore();
  await assertFails(getDoc(doc(readerA, "companies/tenant-a/employees/employee-a/faceId/face-1")));
  await assertSucceeds(getDoc(doc(dbA, "companies/tenant-a/employees/employee-a/faceId/face-1")));
  await assertFails(getDoc(doc(dbA, "companies/tenant-a/punchGuard/employee-a")));
  await assertFails(setDoc(doc(dbA, "companies/tenant-a/punchGuard/employee-a"), { lastOccurredAtMs: 0 }));
  await assertFails(getDoc(doc(dbA, "companies/tenant-a/pinAttempts/user-a")));
  await assertFails(setDoc(doc(dbA, "companies/tenant-a/pinAttempts/user-a"), { failures: 0 }));
  await assertFails(getDoc(doc(readerA, "companies/tenant-a/employeePins/employee-a")));
  await assertFails(getDoc(doc(dbA, "companies/tenant-a/employeePins/employee-a")));
  await assertFails(setDoc(doc(dbA, "companies/tenant-a/employeePins/employee-a"), { pinHash: "novo" }));
  await assertFails(updateDoc(doc(dbA, "companies/tenant-a/employees/employee-a"), { pinHash: "novo" }));
  await assertSucceeds(updateDoc(doc(dbA, "companies/tenant-a/employees/employee-a"), { pinConfigured: true }));
  await assertFails(updateDoc(doc(dbA, "companies/tenant-a"), { repP: { mode: "production" } }));
  await assertFails(updateDoc(doc(dbA, "companies/tenant-a"), { inpiRegistration: "123" }));
  await assertSucceeds(updateDoc(doc(dbA, "companies/tenant-a"), { name: "Empresa A revisada" }));
  // Positivo: fechar o coringa nao pode bloquear leituras legitimas de colecoes com regra explicita.
  await assertSucceeds(getDoc(doc(dbA, "companies/tenant-a/punches/punch-a")));
  await assertFails(getDoc(doc(readerA, "companies/tenant-a/receiptAccessLogs/log-1")));
} finally {
  await testEnv.cleanup();
}

console.log("Firestore tenant isolation: OK");
