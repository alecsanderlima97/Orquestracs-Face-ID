import assert from "node:assert/strict";
import test from "node:test";
import {
  PIN_ATTEMPT_WINDOW_MS,
  PIN_MAX_FAILED_ATTEMPTS,
  PUNCH_MIN_INTERVAL_MS,
  dayKeyFor,
  evaluatePinAttempts,
  evaluatePunchGuard,
  isValidPunchPhotoPath,
  nextPunchGuard,
  recordPinFailure,
} from "../functions/punch-guard.js";

const NOW = Date.parse("2026-11-03T15:00:00-03:00");

test("dayKeyFor usa o dia civil de São Paulo", () => {
  // 02:30 UTC de 04/11 ainda é 03/11 em São Paulo (UTC-3).
  assert.equal(dayKeyFor(new Date("2026-11-04T02:30:00Z")), "2026-11-03");
  assert.equal(dayKeyFor(new Date("2026-11-03T15:00:00Z")), "2026-11-03");
});

test("permite a primeira marcação do dia sem guarda", () => {
  const result = evaluatePunchGuard({ dayKey: "2026-11-03", guard: null, nowMs: NOW, scheduledPunch: "Entrada 1" });
  assert.equal(result.ok, true);
});

test("bloqueia nova marcação dentro do intervalo mínimo", () => {
  const guard = { dayKey: "2026-11-03", doneToday: ["Entrada 1"], lastOccurredAtMs: NOW - 30_000 };
  const result = evaluatePunchGuard({ dayKey: "2026-11-03", guard, nowMs: NOW, scheduledPunch: "Saída 1" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "cooldown");
});

test("libera marcação após o intervalo mínimo", () => {
  const guard = { dayKey: "2026-11-03", doneToday: ["Entrada 1"], lastOccurredAtMs: NOW - PUNCH_MIN_INTERVAL_MS };
  const result = evaluatePunchGuard({ dayKey: "2026-11-03", guard, nowMs: NOW, scheduledPunch: "Saída 1" });
  assert.equal(result.ok, true);
});

test("bloqueia repetir a mesma etapa no mesmo dia, mesmo fora do cooldown", () => {
  const guard = { dayKey: "2026-11-03", doneToday: ["Entrada 1", "Saída 1"], lastOccurredAtMs: NOW - 3_600_000 };
  const result = evaluatePunchGuard({ dayKey: "2026-11-03", guard, nowMs: NOW, scheduledPunch: "Entrada 1" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "duplicate_stage");
});

test("etapas de outro dia não bloqueiam", () => {
  const guard = { dayKey: "2026-11-02", doneToday: ["Entrada 1"], lastOccurredAtMs: NOW - 86_400_000 };
  const result = evaluatePunchGuard({ dayKey: "2026-11-03", guard, nowMs: NOW, scheduledPunch: "Entrada 1" });
  assert.equal(result.ok, true);
});

test("nextPunchGuard acumula as etapas do dia e reinicia no dia seguinte", () => {
  let guard = nextPunchGuard({ guard: null, nowMs: NOW, scheduledPunch: "Entrada 1", dayKey: "2026-11-03" });
  guard = nextPunchGuard({ guard, nowMs: NOW + 1, scheduledPunch: "Saída 1", dayKey: "2026-11-03" });
  assert.deepEqual(guard.doneToday, ["Entrada 1", "Saída 1"]);
  guard = nextPunchGuard({ guard, nowMs: NOW + 2, scheduledPunch: "Entrada 2", dayKey: "2026-11-04" });
  assert.deepEqual(guard.doneToday, ["Entrada 2"]);
});

test("PIN: bloqueia após o limite de falhas na janela", () => {
  let state = null;
  for (let index = 0; index < PIN_MAX_FAILED_ATTEMPTS; index += 1) {
    const check = evaluatePinAttempts({ state, nowMs: NOW + index });
    assert.equal(check.locked, false);
    state = recordPinFailure({ state, nowMs: NOW + index });
  }
  const blocked = evaluatePinAttempts({ state, nowMs: NOW + 1000 });
  assert.equal(blocked.locked, true);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= PIN_ATTEMPT_WINDOW_MS);
});

test("PIN: libera novamente depois da janela", () => {
  let state = null;
  for (let index = 0; index < PIN_MAX_FAILED_ATTEMPTS; index += 1) {
    state = recordPinFailure({ state, nowMs: NOW });
  }
  const later = evaluatePinAttempts({ state, nowMs: NOW + PIN_ATTEMPT_WINDOW_MS + 1 });
  assert.equal(later.locked, false);
});

test("PIN: exige caminho de foto do próprio colaborador e da própria empresa", () => {
  const good = "companies/c1/employees/e1/punches/2026-11-03/abc.webp";
  assert.equal(isValidPunchPhotoPath({ photoPath: good, companyId: "c1", employeeId: "e1" }), true);
  assert.equal(isValidPunchPhotoPath({ photoPath: good, companyId: "c2", employeeId: "e1" }), false);
  assert.equal(isValidPunchPhotoPath({ photoPath: good, companyId: "c1", employeeId: "e2" }), false);
  assert.equal(isValidPunchPhotoPath({ photoPath: "pending-storage-photo", companyId: "c1", employeeId: "e1" }), false);
  assert.equal(isValidPunchPhotoPath({ photoPath: "face-id-local-profile", companyId: "c1", employeeId: "e1" }), false);
  assert.equal(
    isValidPunchPhotoPath({ photoPath: "companies/c1/employees/e1/punches/../face-id/x.webp", companyId: "c1", employeeId: "e1" }),
    false,
  );
});
