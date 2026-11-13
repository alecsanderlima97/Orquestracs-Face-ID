// Regras puras de proteção do registro de ponto e da verificação de PIN.
// Sem dependências do Firebase, para permitir testes unitários determinísticos.

export const PUNCH_MIN_INTERVAL_MS = 2 * 60 * 1000;
export const PIN_MAX_FAILED_ATTEMPTS = 5;
export const PIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

const SAO_PAULO_DAY = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/Sao_Paulo",
  year: "numeric",
});

// Dia civil no fuso de Sao Paulo, no formato AAAA-MM-DD.
export function dayKeyFor(date) {
  return SAO_PAULO_DAY.format(date);
}

// Decide se uma nova marcação pode ser gravada, dado o estado de guarda do colaborador.
// guard: { lastOccurredAtMs?, dayKey?, doneToday?: string[] } ou null.
export function evaluatePunchGuard({ guard, nowMs, scheduledPunch, dayKey }) {
  const lastMs = Number(guard?.lastOccurredAtMs || 0);
  if (lastMs && nowMs - lastMs < PUNCH_MIN_INTERVAL_MS) {
    const waitSeconds = Math.ceil((PUNCH_MIN_INTERVAL_MS - (nowMs - lastMs)) / 1000);
    return {
      code: "cooldown",
      message: `Aguarde ${Math.ceil(waitSeconds / 60)} minuto(s) antes de nova marcação.`,
      ok: false,
    };
  }

  const sameDay = guard?.dayKey === dayKey;
  const doneToday = sameDay && Array.isArray(guard?.doneToday) ? guard.doneToday : [];
  if (scheduledPunch && doneToday.includes(scheduledPunch)) {
    return {
      code: "duplicate_stage",
      message: `A marcação ${scheduledPunch} já foi registrada hoje.`,
      ok: false,
    };
  }

  return { ok: true };
}

// Atualiza a guarda após uma marcação gravada.
export function nextPunchGuard({ guard, nowMs, scheduledPunch, dayKey }) {
  const sameDay = guard?.dayKey === dayKey;
  const doneToday = sameDay && Array.isArray(guard?.doneToday) ? [...guard.doneToday] : [];
  if (scheduledPunch && !doneToday.includes(scheduledPunch)) doneToday.push(scheduledPunch);
  return {
    dayKey,
    doneToday,
    lastOccurredAtMs: nowMs,
    lastScheduledPunch: scheduledPunch || null,
  };
}

// Controle de tentativas de PIN: janela fixa de 10 minutos a partir da primeira falha.
// state: { failures, windowStartMs } ou null.
export function evaluatePinAttempts({ state, nowMs }) {
  const windowStartMs = Number(state?.windowStartMs || 0);
  const inWindow = windowStartMs && nowMs - windowStartMs < PIN_ATTEMPT_WINDOW_MS;
  const failures = inWindow ? Number(state?.failures || 0) : 0;
  if (failures >= PIN_MAX_FAILED_ATTEMPTS) {
    const retryAfterMs = PIN_ATTEMPT_WINDOW_MS - (nowMs - windowStartMs);
    return { locked: true, retryAfterMs, state: { failures, windowStartMs } };
  }
  return { locked: false, state: { failures, windowStartMs: inWindow ? windowStartMs : 0 } };
}

export function recordPinFailure({ state, nowMs }) {
  const windowStartMs = Number(state?.windowStartMs || 0);
  const inWindow = windowStartMs && nowMs - windowStartMs < PIN_ATTEMPT_WINDOW_MS;
  return {
    failures: (inWindow ? Number(state?.failures || 0) : 0) + 1,
    windowStartMs: inWindow ? windowStartMs : nowMs,
  };
}

// Confere se a foto de evidência pertence ao colaborador e à empresa corretos.
export function isValidPunchPhotoPath({ photoPath, companyId, employeeId }) {
  if (!photoPath || !companyId || !employeeId) return false;
  const prefix = `companies/${companyId}/employees/${employeeId}/punches/`;
  return photoPath.startsWith(prefix) && photoPath.length > prefix.length && !photoPath.includes("..");
}
