import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_MAX_DISTANCE,
  ADAPTIVE_MAX_SAMPLES,
  activeSamples,
  appendSample,
  brazilDayKey,
  sanitizeDescriptor,
} from "../functions/face-adaptive.js";

const descriptor = (seed = 0.1) => Array.from({ length: 128 }, (_, index) => ((index % 7) - 3) * seed);
const at = (iso) => new Date(iso);

test("aceita descritor valido de 128 numeros", () => {
  assert.equal(sanitizeDescriptor(descriptor()).length, 128);
});

test("rejeita descritor com tamanho errado, texto, infinito ou valor absurdo", () => {
  assert.equal(sanitizeDescriptor(descriptor().slice(1)), null);
  assert.equal(sanitizeDescriptor([...descriptor().slice(1), "x"]), null);
  assert.equal(sanitizeDescriptor([...descriptor().slice(1), Infinity]), null);
  assert.equal(sanitizeDescriptor([...descriptor().slice(1), 50]), null);
  assert.equal(sanitizeDescriptor("abc"), null);
});

test("so aprende com certeza alta", () => {
  const now = at("2026-11-27T12:00:00Z");
  assert.equal(appendSample({ samples: [], descriptor: descriptor(), distance: ADAPTIVE_MAX_DISTANCE + 0.01, now }).reason, "low-confidence");
  assert.equal(appendSample({ samples: [], descriptor: descriptor(), distance: -1, now }).reason, "low-confidence");
  assert.equal(appendSample({ samples: [], descriptor: descriptor(), distance: "0.1", now }).reason, "low-confidence");
  assert.equal(appendSample({ samples: [], descriptor: descriptor(), distance: 0.3, now }).ok, true);
});

test("no maximo uma amostra por dia (fuso de Brasilia)", () => {
  const first = appendSample({ samples: [], descriptor: descriptor(), distance: 0.3, now: at("2026-11-27T11:00:00Z") });
  assert.equal(first.ok, true);
  const sameDay = appendSample({ samples: first.samples, descriptor: descriptor(0.2), distance: 0.3, now: at("2026-11-28T02:30:00Z") });
  assert.equal(sameDay.reason, "already-today", "23:30 em Brasilia ainda e o mesmo dia");
  const nextDay = appendSample({ samples: first.samples, descriptor: descriptor(0.2), distance: 0.3, now: at("2026-11-28T03:30:00Z") });
  assert.equal(nextDay.ok, true);
});

test("mantem so as 5 mais recentes", () => {
  let samples = [];
  for (let day = 1; day <= ADAPTIVE_MAX_SAMPLES + 2; day += 1) {
    const result = appendSample({ samples, descriptor: descriptor(day / 100), distance: 0.3, now: at(`2026-11-${String(day).padStart(2, "0")}T15:00:00Z`) });
    assert.equal(result.ok, true);
    samples = result.samples;
  }
  assert.equal(samples.length, ADAPTIVE_MAX_SAMPLES);
  assert.equal(brazilDayKey(new Date(samples[0].addedAtMs)), "2026-11-03");
});

test("ignora amostras anteriores ao cadastro facial atual", () => {
  const old = { addedAtMs: Date.parse("2026-11-01T12:00:00Z"), descriptor: descriptor(), distance: 0.3 };
  const recent = { addedAtMs: Date.parse("2026-11-20T12:00:00Z"), descriptor: descriptor(), distance: 0.3 };
  const registeredAtMs = Date.parse("2026-11-10T12:00:00Z");
  assert.deepEqual(activeSamples([old, recent], registeredAtMs), [recent]);
  assert.equal(activeSamples([old, { bad: true }], 0).length, 1);
  assert.deepEqual(activeSamples(null, 0), []);
});
