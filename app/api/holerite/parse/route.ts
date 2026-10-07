import { PDFParse } from "pdf-parse";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const firebaseApiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;

PDFParse.setWorker(
  pathToFileURL(path.join(process.cwd(), "node_modules/pdf-parse/dist/worker/pdf.worker.mjs")).toString(),
);

function firstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return "";
}

function formatCpf(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length !== 11) return value.trim();
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

function cleanValue(value: string) {
  return value
    .replace(/[|]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/[.;,:-]+$/, "")
    .trim();
}

function parseHoleriteText(text: string) {
  const normalized = text.replace(/\u00a0/g, " ").replace(/\r/g, "");
  const lines = normalized
    .split("\n")
    .map((line) => cleanValue(line))
    .filter(Boolean);
  const compact = lines.join(" ");

  const employeeLine = normalized.match(
    /(?:^|\n)\s*(\d{3,})\s+([A-ZÀ-Ü][A-ZÀ-Ü' ]{4,})\s*\n\s*PIS\s*:/m,
  );

  const name = cleanValue(firstMatch(normalized, [
    employeeLine ? new RegExp(`(?:^|\\n)\\s*${employeeLine[1]}\\s+([^\\n]+)\\s*\\n\\s*PIS\\s*:`, "m") : /$a/,
    /(?:nome\s+(?:do\s+)?(?:funcion[aá]rio|empregado|colaborador))\s*[:\-]?\s*([^\n]+)/i,
  ]));
  const cpfRaw = firstMatch(compact, [
    /(?:CPF|C\.P\.F\.?)\s*[:\-]?\s*([\d.\s]{3,14}-?\d{2})/i,
  ]);
  const registration = cleanValue(employeeLine?.[1] || firstMatch(compact, [
    /(?:matr[ií]cula|registro|c[oó]digo\s+do\s+empregado)\s*[:\-]?\s*([A-Z0-9./-]{2,})/i,
  ]));
  const role = cleanValue(firstMatch(normalized, [
    /\n\s*([A-ZÀ-Ü][A-ZÀ-Ü0-9 /.'-]{3,})\s+Cargo\s*:\s*\d+/m,
    /(?:cargo|fun[cç][aã]o)\s*[:\-]?\s*([^\n]+)/i,
  ]));
  const department = cleanValue(firstMatch(normalized, [
    /Local\s*:\s*\d+\s+([A-ZÀ-Ü][A-ZÀ-Ü ]+?)(?=\s+Funcion[aá]rio\b)/i,
    /(?:departamento|setor)\s*[:\-]?\s*([^\n]+)/i,
  ]));
  const cbo = cleanValue(firstMatch(compact, [
    /CBO\s*[:\-]?\s*([\d.-]{4,})/i,
  ]));
  const admissionDate = cleanValue(firstMatch(compact, [
    /(?:data\s+de\s+)?admiss[aã]o\s*[:\-]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    /funcion[aá]rio\s+desde\s*[:\-]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
  ]));
  const phone = cleanValue(firstMatch(compact, [
    /(?:celular|telefone|fone)\s*[:\-]?\s*(\(?\d{2}\)?\s*\d{4,5}[-\s]?\d{4})/i,
  ]));

  const fields = {
    admissionDate,
    cbo,
    cpf: cpfRaw ? formatCpf(cpfRaw) : "",
    department,
    name,
    phone,
    registration,
    role,
  };
  const missingLabels = [
    ["name", "nome"],
    ["cpf", "CPF"],
    ["registration", "matrícula"],
    ["role", "cargo"],
    ["admissionDate", "data de admissão"],
    ["cbo", "CBO"],
  ] as const;
  const missing = missingLabels.filter(([key]) => !fields[key]).map(([, label]) => label);

  return {
    fields,
    missing,
    textFound: Boolean(normalized.trim()),
  };
}

async function hasAuthenticatedFirebaseUser(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token || !firebaseApiKey) return false;

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`,
      {
        body: JSON.stringify({ idToken: token }),
        cache: "no-store",
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    if (!response.ok) return false;
    const result = await response.json() as { users?: unknown[] };
    return Array.isArray(result.users) && result.users.length > 0;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  let parser: PDFParse | null = null;

  try {
    if (!(await hasAuthenticatedFirebaseUser(request))) {
      return Response.json(
        { error: "Sua sessão expirou ou não foi encontrada. Entre novamente para importar o holerite." },
        { status: 401 },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return Response.json({ error: "Envie um arquivo PDF de holerite." }, { status: 400 });
    }

    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      return Response.json({ error: "Nesta primeira leitura, envie um holerite em PDF." }, { status: 415 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return Response.json({ error: "O PDF deve ter no máximo 10 MB." }, { status: 413 });
    }

    parser = new PDFParse({ data: Buffer.from(await file.arrayBuffer()) });
    const result = await parser.getText();
    const parsed = parseHoleriteText(result.text || "");

    if (!parsed.textFound) {
      return Response.json(
        { error: "Não foi localizado texto no PDF. Esse holerite parece escaneado; será necessário OCR ou digitação assistida." },
        { status: 422 },
      );
    }

    return Response.json({
      fields: parsed.fields,
      fileName: file.name,
      missing: parsed.missing,
      pages: result.total,
      stored: false,
      warnings: result.total > 1
        ? ["Este PDF tem várias páginas. O sistema pré-preenche o primeiro colaborador encontrado; para cadastro em lote, importe cada holerite individualmente."]
        : [],
    });
  } catch (error) {
    console.error("Holerite parse failed", error);
    return Response.json(
      { error: "Não foi possível ler este PDF. Confira se o arquivo está íntegro e tente novamente." },
      { status: 422 },
    );
  } finally {
    await parser?.destroy();
  }
}
