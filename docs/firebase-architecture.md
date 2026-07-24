# Orquestracs Face ID - Firebase

Esta estrutura nao importa dados demonstrativos para o Firebase.

## Colecoes

- `companies`
- `companies/{companyId}/employees`
- `companies/{companyId}/journeys`
- `companies/{companyId}/punches`
- `companies/{companyId}/adjustments`
- `companies/{companyId}/auditLogs`
- `companies/{companyId}/employees/{employeeId}/faceId`
- `invites`

## Storage

- `companies/{companyId}/employees/{employeeId}/face-id/{photoId}.webp`
- `companies/{companyId}/employees/{employeeId}/punches/{date}/{punchId}.webp`
- `companies/{companyId}/reports/{reportId}.pdf`

## Permissoes

- `developer`: suporte interno Orquestracs.
- `owner`: acesso total da empresa.
- `admin`: gerencia operacao da empresa.
- `reader`: visualiza dados e relatorios.

## Retencao

Fotos de batida devem seguir a politica da empresa:

- padrao recomendado: 5 anos;
- opcoes: 2 anos, 5 anos ou personalizado;
- exclusao deve gerar log;
- nao excluir se houver auditoria, disputa ou processo.
