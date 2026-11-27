// Cadastro facial adaptativo: guarda poucos descritores (numeros do rosto, nunca fotos)
// de batidas confirmadas com reconhecimento de alta confianca, para melhorar o reconhecimento.
// Regras puras, sem acesso a banco, para serem testadas isoladamente.

export const ADAPTIVE_MAX_SAMPLES = 5;
// Mais rigoroso que o limiar de reconhecimento do quiosque (0,5): so aprende com certeza alta.
export const ADAPTIVE_MAX_DISTANCE = 0.4;
export const DESCRIPTOR_LENGTH = 128;

export function sanitizeDescriptor(value) {
  if (!Array.isArray(value) || value.length !== DESCRIPTOR_LENGTH) return null;
  const descriptor = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item) || Math.abs(item) > 2) return null;
    descriptor.push(Math.round(item * 100000) / 100000);
  }
  return descriptor;
}

export function sanitizeDistance(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

// Dia no fuso de Brasilia, para limitar a uma amostra por colaborador por dia.
export function brazilDayKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
    year: "numeric",
  }).format(date);
}

// Amostras validas: as do cadastro facial atual (posteriores ao ultimo cadastro).
export function activeSamples(samples, registeredAtMs) {
  if (!Array.isArray(samples)) return [];
  return samples.filter((sample) =>
    sample
    && Array.isArray(sample.descriptor)
    && sample.descriptor.length === DESCRIPTOR_LENGTH
    && Number.isFinite(sample.addedAtMs)
    && (!registeredAtMs || sample.addedAtMs >= registeredAtMs));
}

export function appendSample({ samples, descriptor, distance, now, registeredAtMs }) {
  const cleanDescriptor = sanitizeDescriptor(descriptor);
  if (!cleanDescriptor) return { ok: false, reason: "invalid-descriptor" };
  const cleanDistance = sanitizeDistance(distance);
  if (cleanDistance === null || cleanDistance > ADAPTIVE_MAX_DISTANCE) {
    return { ok: false, reason: "low-confidence" };
  }

  const current = activeSamples(samples, registeredAtMs);
  const today = brazilDayKey(now);
  if (current.some((sample) => brazilDayKey(new Date(sample.addedAtMs)) === today)) {
    return { ok: false, reason: "already-today" };
  }

  const next = [
    ...current,
    { addedAtMs: now.getTime(), descriptor: cleanDescriptor, distance: Math.round(cleanDistance * 1000) / 1000 },
  ].slice(-ADAPTIVE_MAX_SAMPLES);
  return { ok: true, samples: next };
}
