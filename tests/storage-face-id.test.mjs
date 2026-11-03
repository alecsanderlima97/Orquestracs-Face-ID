import { readFile } from "node:fs/promises";
import { doc, setDoc } from "firebase/firestore";
import { getBytes, ref, uploadBytes } from "firebase/storage";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";

const projectId = "demo-orquestracs-face-id";
const firestoreRules = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");
const storageRules = await readFile(new URL("../storage.rules", import.meta.url), "utf8");
const testEnv = await initializeTestEnvironment({
  firestore: { rules: firestoreRules },
  projectId,
  storage: { rules: storageRules },
});

const facePath = "companies/tenant-a/employees/employee-a/face-id/photo-1.webp";
const punchPath = "companies/tenant-a/employees/employee-a/punches/2026-11-03/punch-1.webp";

try {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "tenants/tenant-a/users/owner-a"), { role: "owner" });
    await setDoc(doc(context.firestore(), "tenants/tenant-a/users/reader-a"), { role: "reader" });
    const bytes = new Uint8Array([1, 2, 3]);
    await uploadBytes(ref(context.storage(), facePath), bytes, { contentType: "image/webp" });
    await uploadBytes(ref(context.storage(), punchPath), bytes, { contentType: "image/webp" });
  });

  const owner = testEnv.authenticatedContext("owner-a", { email: "owner-a@example.com" }).storage();
  const reader = testEnv.authenticatedContext("reader-a", { email: "reader-a@example.com" }).storage();

  // Fotos de cadastro facial: somente administracao le (o coringa nao pode liberar para reader).
  await assertSucceeds(getBytes(ref(owner, facePath)));
  await assertFails(getBytes(ref(reader, facePath)));

  // Evidencia de batida continua disponivel para a leitura de tenant (regra inalterada).
  await assertSucceeds(getBytes(ref(reader, punchPath)));
} finally {
  await testEnv.cleanup();
}

console.log("Storage face-id isolation: OK");
