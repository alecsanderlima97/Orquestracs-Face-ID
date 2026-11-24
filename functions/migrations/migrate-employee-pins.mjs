// Migra o hash do PIN de companies/{c}/employees/{e} (campo pinHash) para
// companies/{c}/employeePins/{e}, e remove pinHash/pinUpdatedAt/pin do colaborador.
//
// NAO EXECUTE contra dados reais sem autorizacao explicita e backup.
// Padrao: dry-run (somente contagem, nenhuma escrita).
//   node migrate-employee-pins.mjs --project <id-do-projeto>
// Escrita real (exige --execute):
//   node migrate-employee-pins.mjs --project <id-do-projeto> --execute
//
// Idempotente: colaboradores ja migrados (sem pinHash legado) sao ignorados.
// Nunca imprime PIN, hash ou CPF.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const projectIndex = args.indexOf("--project");
const projectId = projectIndex >= 0 ? args[projectIndex + 1] : process.env.GCLOUD_PROJECT;

if (!projectId) {
  console.error("Informe o projeto: --project <id> ou variavel GCLOUD_PROJECT.");
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();

const BATCH_LIMIT = 400;

async function main() {
  console.log(`Projeto: ${projectId} | modo: ${execute ? "EXECUCAO" : "dry-run (sem escrita)"}`);
  const companies = await db.collection("companies").select().get();

  let companiesScanned = 0;
  let legacyFound = 0;
  let duplicatesFound = 0;
  let migrated = 0;

  for (const company of companies.docs) {
    companiesScanned += 1;
    const employees = await db.collection(`companies/${company.id}/employees`).get();
    const hashCount = new Map();
    for (const employee of employees.docs) {
      const hash = employee.data().pinHash;
      if (hash) hashCount.set(hash, (hashCount.get(hash) || 0) + 1);
    }

    let batch = db.batch();
    let pending = 0;

    for (const employee of employees.docs) {
      const data = employee.data();
      if (!data.pinHash) continue;
      legacyFound += 1;

      // PIN compartilhado por mais de um colaborador: nenhum deles e migrado, sem escolher vencedor.
      if (hashCount.get(data.pinHash) > 1) {
        duplicatesFound += 1;
        continue;
      }

      if (!execute) continue;

      batch.set(db.doc(`companies/${company.id}/employeePins/${employee.id}`), {
        employeeId: employee.id,
        pinHash: data.pinHash,
        pinUpdatedAt: data.pinUpdatedAt || Timestamp.now(),
        migratedAt: FieldValue.serverTimestamp(),
      });
      batch.update(employee.ref, {
        pin: FieldValue.delete(),
        pinHash: FieldValue.delete(),
        pinUpdatedAt: FieldValue.delete(),
        pinConfigured: true,
      });
      pending += 2;
      migrated += 1;

      if (pending >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }

    if (execute && pending > 0) await batch.commit();
  }

  console.log(JSON.stringify({
    companiesScanned,
    legacyPinsFound: legacyFound,
    duplicatePinsSkipped: duplicatesFound,
    migrated: execute ? migrated : 0,
    mode: execute ? "execute" : "dry-run",
  }, null, 2));

  if (duplicatesFound > 0) {
    console.warn("Ha colaboradores com PIN duplicado no legado. Eles nao foram migrados; resolva antes de executar.");
  }
}

main().catch((error) => {
  console.error("Falha na migracao:", error.code || error.name);
  process.exit(1);
});
