from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from pypdf import PdfReader


def clean(value: str) -> str:
    return " ".join(value.split()).strip()


def title_name(value: str) -> str:
    small_words = {"da", "de", "do", "das", "dos", "e"}
    parts = clean(value).lower().split()
    return " ".join(part if part in small_words else part.capitalize() for part in parts)


def extract_employees(pdf_path: Path) -> list[dict[str, str]]:
    reader = PdfReader(str(pdf_path))
    employees: list[dict[str, str]] = []

    for page_number, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").replace("\n", " ")
        employee_match = re.search(
            r"Salario do m.s\s+(\d{5})\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ ]+?)\s+\|?\s*PIS:",
            text,
            re.IGNORECASE,
        )
        if not employee_match:
            continue

        admission_match = re.search(r"Funcion.rio desde:\s*(\d{2}/\d{2}/\d{4})", text)
        cbo_match = re.search(r"CBO:([0-9-]+)", text)
        role_match = re.search(
            r"Funcion.rio desde:\s*\d{2}/\d{2}/\d{4}\s+\|?\s*(.+?)Cargo:",
            text,
            re.IGNORECASE,
        )

        employees.append(
            {
                "sourcePage": str(page_number),
                "registration": employee_match.group(1),
                "name": title_name(employee_match.group(2)),
                "cpf": "",
                "phone": "",
                "admissionDate": admission_match.group(1) if admission_match else "",
                "role": title_name(role_match.group(1)) if role_match else "",
                "department": "Geral",
                "cbo": cbo_match.group(1) if cbo_match else "",
                "pin": "",
                "journeyMode": "collective",
                "collectiveJourneyId": "empresa-padrao",
                "faceIdStatus": "not_registered",
                "active": True,
            }
        )

    return employees


def main() -> None:
    parser = argparse.ArgumentParser(description="Extrai colaboradores de holerites em PDF.")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--out", type=Path, default=Path("private/imports/employees-from-holerite.json"))
    args = parser.parse_args()

    employees = extract_employees(args.pdf)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(
            {
                "source": args.pdf.name,
                "total": len(employees),
                "employees": employees,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"{len(employees)} colaboradores extraidos para {args.out}")


if __name__ == "__main__":
    main()
