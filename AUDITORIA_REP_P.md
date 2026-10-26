# ORQUESTRA FACE ID - Auditoria e Adequacao para REP-P

**Data da auditoria:** 26/10/2026  
**Escopo:** repositorio atual do Orquestra Face ID, Firebase, autenticacao, Firestore, Storage, Cloud Functions, tela operacional, tratamento de jornada e integracao com o Portal Orquestra.cs.  
**Referencia do codigo auditado:** `6cce427` (`main` / `origin/main`).

> Este documento e um diagnostico tecnico. Nao e atestado de conformidade, homologacao, parecer juridico ou autorizacao para comercializar o produto como REP-P oficial.

## Atualizacao da implementacao local - 26/10/2026

Depois da fotografia inicial acima, foram aplicados ajustes no codigo local para reduzir os riscos apontados. Eles ainda precisam ser publicados e validados no projeto Firebase de producao:

- o registro de ponto passou a exigir chave idempotente e a devolver o mesmo resultado quando a mesma tentativa e reenviada;
- ajustes manuais, justificativas e cadastro de Face ID passaram a usar callable server-side, com validacao de papel, empresa, dados do colaborador e trilha de auditoria encadeada;
- acoes de ajuste e justificativa agora entram como `pending` e possuem fila de aprovacao/rejeicao;
- o cadastro facial exige aceite explicito da finalidade biometrica e registra a versao do consentimento;
- alteracoes de colaboradores passam a gerar evento automatico de auditoria com os nomes dos campos alterados;
- a interface operacional passou a selecionar a empresa ativa da sessao, em vez de direcionar os fluxos operacionais sempre para `main`;
- as regras do Firestore bloquearam escritas diretas do navegador em pontos originais, idempotencia, ajustes, justificativas, Face ID e logs de auditoria.

Isso melhora a fundacao tecnica, mas nao altera a conclusao juridica: assinatura CAdES/PAdES, registro no INPI, certificado ICP-Brasil, testes formais, backup/recuperacao e validacao profissional continuam pendentes.

## 1. Conclusao executiva

O produto possui uma **fundacao relevante de pre-validacao**: autenticacao Firebase, controle de acesso inicial, registro server-side, NSR sequencial, encadeamento SHA-256, colecao separada para registros originais, comprovantes, consulta de ultimas 48 horas, ajustes separados e uma previa tecnica de AFD/AEJ.

Ainda falta uma distancia importante para uso oficial como REP-P. A classificacao geral e:

| Area | Classificacao | Leitura pratica |
| --- | --- | --- |
| Fundacao de registro e armazenamento | Parcialmente conforme | Ha controles importantes, mas faltam testes formais, idempotencia, tratamento de falhas e prova independente de conformidade do leiaute. |
| Comprovante e acesso do trabalhador | Parcialmente conforme | Existe fluxo de consulta e impressao, mas o PDF ainda nao possui assinatura PAdES e o fluxo depende da sessao/estrutura atual do sistema. |
| AFD e AEJ oficiais | Nao conforme/concluido | O sistema gera previa, mas ainda nao gera e entrega os arquivos assinados CAdES detached `.p7s`. |
| PTRP e espelho de ponto | Parcialmente conforme | Existe relatorio imprimivel e tratamento inicial, mas ainda faltam fechamento formal, assinatura, testes e evidencias de ponta a ponta. |
| Multi-tenant SaaS | Nao conforme para escala comercial | O frontend e varios servicos operacionais ainda usam a empresa fixa `main`; isso impede considerar o isolamento entre clientes concluido. |
| Biometria e LGPD | Parcialmente conforme | Ha protecao de Storage, PIN alternativo e campos de consentimento, mas faltam fluxo explicito, finalidade, retencao, exclusao, acesso e evidencia server-side. |
| Auditoria, backup e recuperacao | Parcialmente conforme/insuficiente | Ha colecoes e regras de imutabilidade, mas faltam trilha automatica completa, backup gerenciado e teste de restauracao. |
| Integracao com Portal | Tecnica implementada em parte | Ha comandos, snapshot e gatilhos de sincronizacao. Isso nao substitui os requisitos legais do REP-P. |

**Resposta direta:** nao falta refazer tudo, mas ainda faltam blocos criticos. A interface operacional esta bem adiantada; os itens que impedem a declaracao oficial sao principalmente de backend, criptografia, evidencias, isolamento multiempresa e providencias externas.

## 2. O que ja foi feito

### 2.1 Registro, imutabilidade e rastreabilidade inicial

- `functions/index.js` implementa `registerRepPunch` como funcao autenticada server-side.
- O registro utiliza horario do servidor, valida empresa/colaborador/tipo/origem e grava o ponto original.
- O NSR e mantido em `companies/{companyId}/repState/main` e o hash SHA-256 e encadeado com o registro anterior.
- O ponto original e separado em `punches` e `arpRecords`.
- As regras bloqueiam alteracao e exclusao direta de `punches` e `arpRecords` pelo navegador.
- Ajustes e justificativas foram modelados como eventos separados, preservando o registro original.
- O sistema diferencia ocorrencias como entrada, intervalo, retorno, saida, atraso, saida antecipada, banco de horas e trabalho externo.

**Estado:** boa base, mas ainda nao e prova de conformidade. O encadeamento precisa de testes de fixture, revisao do input exato do hash e tratamento de concorrencia, repeticao e falha.

### 2.2 Comprovantes e janela de 48 horas

- `listRecentRepReceipts` consulta comprovantes recentes para a administracao.
- `listOwnRepReceipts` consulta os comprovantes do proprio trabalhador por PIN e registra acesso.
- A resposta do registro inclui NSR, horario do servidor, empregador, trabalhador, hash e numero INPI quando cadastrado.
- A interface apresenta comprovante para impressao e identifica quando o documento ainda e de piloto.

**Estado:** parcialmente pronto. Falta garantir todos os campos exigidos por estabelecimento, disponibilizacao independente de privilegio administrativo quando aplicavel, comprovante PDF assinado e teste real de acesso imediatamente apos cada marcacao e durante as ultimas 48 horas.

### 2.3 AFD, AEJ e espelho

- `generateRepExports` monta uma previa de AFD e AEJ.
- O codigo possui rotina de CRC16/KERMIT e estrutura inicial de registros.
- A tela de relatorios apresenta a situacao de assinatura e nao declara o resultado como oficial.
- Existe relatorio mensal imprimivel e dados para conferencia do contador.

**Estado:** ainda e uma previa tecnica. O retorno informa `officialReady: false` e `signatureStatus: missing_icp_brasil`; o codigo ainda usa o marcador literal de assinatura, sem produzir o arquivo `.p7s` assinado.

### 2.4 Autenticacao, convites e permissao

- Firebase Authentication esta integrado com login e convite.
- Existem perfis `developer`, `owner`, `admin` e `reader`.
- As regras de Firestore e Storage bloqueiam operacoes criticas no navegador, incluindo exclusao de pontos, registros ARP e fotos de ponto.
- A Central Admin e a integracao com o Portal possuem controle de proprietario da plataforma e comandos idempotentes para sincronizacao.

**Estado:** parcialmente pronto. O uso de e-mail fixo para o proprietario da plataforma, em vez de claims/entitlement server-side, e fraco para um SaaS. Operacoes de tratamento ainda precisam sair do caminho direto do cliente.

### 2.5 Biometria, foto e alternativa por PIN

- Face ID usa camera, cadastro de foto primaria e reconhecimento local com `face-api`.
- Fotos podem ser armazenadas no Firebase Storage com limite e regras de acesso.
- Existe PIN alternativo para falha de reconhecimento.
- O cadastro registra campos como consentimento, capturador e data.
- O reset preserva historico em vez de apagar silenciosamente registros antigos.

**Estado:** parcialmente pronto. O consentimento esta sendo preenchido no fluxo, mas ainda nao ha evidencia suficiente de aceite explicito, identidade do operador autenticado, base legal, prazo de retencao, revogacao, exclusao e governanca dos templates/fotos biometricos.

## 3. O que foi encontrado e precisa ser corrigido

### P0 - bloqueia uso oficial ou escala comercial

| Item | Evidencia | Problema | Aceite esperado |
| --- | --- | --- | --- |
| Isolamento real entre clientes | `app/page.tsx`, `lib/services/companies.ts`, `lib/services/rep-p.ts` e varios fluxos usam `companyId: "main"` / `MAIN_COMPANY_ID` | O login multi-tenant existe, mas as operacoes de ponto, colaboradores, relatorios e fechamento ainda podem cair na empresa fixa. | Dois clientes de teste nao conseguem ler, gravar, consultar ou exportar dados um do outro; o tenant vem da sessao/servidor e nao de um campo confiado do navegador. |
| Assinatura AFD | `functions/index.js`, `generateRepExports` | AFD e apenas texto de previa; nao existe CAdES detached real nem arquivo `.p7s`. | Arquivo AFD conforme leiaute, CRC validado por fixtures e `.p7s` CAdES verificavel com certificado ICP-Brasil do desenvolvedor. |
| Assinatura AEJ | `functions/index.js`, `generateRepExports` | AEJ tambem e previa e nao esta assinado. | AEJ conforme Anexo VI, com `.p7s` CAdES detached verificavel. |
| Comprovante PDF | `app/page.tsx`, funcao de impressao do recibo | A tela abre uma impressao HTML; nao ha PDF PAdES assinado nem artefato verificavel armazenado. | Comprovante gerado apos cada marcacao, com campos exigidos, PDF assinado PAdES e verificacao automatizada. |
| Tratamento e ajustes | `lib/services/punches.ts`, `lib/services/attendance-justifications.ts`, `app/page.tsx` | O navegador consegue criar ajuste/justificativa com `createdBy` textual e, em parte do fluxo, status aprovado diretamente. | Callable server-side valida identidade, tenant, papel, motivo, evidencia e transicao de estado; cada acao gera evento de auditoria imutavel. |
| Identidade do ator | `capturedBy: "web-kiosk"`, `createdBy` recebido do cliente | O texto informado pelo navegador nao prova quem executou a operacao. | Ator derivado de `request.auth`, com UID, papel, tenant, origem, data/hora e motivo gravados pelo servidor. |
| Idempotencia e falhas | `registerRepPunch` nao recebe chave idempotente de marcacao e a UI usa registros locais | Reenvio, queda de rede ou duplo clique podem gerar comportamento ambiguo; `offline` esta fixado em `0`. | Chave idempotente por tentativa, outbox/retry controlado, resultado deterministico e testes de queda, reenvio e concorrencia. |
| Backup e recuperacao | backup local JSON em `app/page.tsx`; sem rotina gerenciada comprovada | Backup do navegador nao e plano de continuidade do REP-P. | Backup automatico, retencao, acesso restrito, restauracao testada, RPO/RTO documentados e evidencia de sucesso. |

### P1 - necessario para uma operacao profissional

| Item | Situacao atual | Proximo resultado |
| --- | --- | --- |
| Modelo de estabelecimento | O estado do NSR esta por empresa, mas a arquitetura e o cadastro operacional ainda tratam uma empresa principal fixa. | Entidade de estabelecimento com CNPJ/CPF proprio, endereco e sequencia NSR independente. |
| AFD/AEJ formal | Layouts sao montados por helpers proprios e ainda nao foram comparados com fixtures oficiais. | Suite de testes com exemplos oficiais, validacao de campos, encoding, tamanho, CRC, terminador e assinatura. |
| Realtime operacional | O painel usa leituras e polling de aproximadamente 30 segundos em partes importantes. | `onSnapshot`/eventos server-side para status e atualizacao confiavel, sem depender de localStorage. |
| Auditoria | Existem colecoes e regras de criacao sem edicao, mas tambem ha escrita direta de logs pelo cliente e nao ha evento automatico para todas as operacoes. | Auditoria server-side abrangendo login, cadastro, biometria, ponto, justificativa, ajuste, exportacao, assinatura e acesso a comprovante. |
| Dados locais | `localStorage` ainda participa de dashboard, registros e reconhecimento facial. | LocalStorage somente como cache visual controlado; fonte oficial sempre Firebase/Cloud Functions. |
| Biometria | Fotos e descritores sao tratados no dispositivo; nao existe politica operacional completa. | Consentimento explicito, finalidade, minimizacao, retencao, revogacao, acesso, exclusao e registro do operador. |
| Acesso do trabalhador | Consulta e protegida por PIN dentro da estrutura atual de usuario autenticado. | Definir e testar acesso do trabalhador sem privilegio administrativo, com comprovante apos cada marcacao e janela minima de 48 horas. |
| Monitoramento | Nao ha evidencia de painel de falhas, fila de reprocessamento, alerta de assinatura ou integridade. | Alertas, logs tecnicos sem dados pessoais desnecessarios, acompanhamento de jobs e trilha de incidentes. |
| Mobile/tablet | A interface operacional foi adaptada, mas a validacao formal de camera, permissao, orientacao e perda de rede ainda precisa ser repetida por dispositivo. | Roteiro de aceite em tablet, celular e desktop, incluindo HTTPS, camera, troca de dispositivo e modo quiosque. |

### P2 - melhoria posterior

- Consolidar componentes visuais e estados de carregamento/erro do modo quiosque.
- Melhorar filtros, busca, exportacao e acessibilidade das telas de colaboradores e relatorios.
- Evoluir assistente, creditos de IA e atalhos da Central Admin sem misturar essas funcoes com o nucleo legal do REP-P.
- Criar pagina de verificacao publica/privada do hash e da assinatura, sem expor dados pessoais alem do necessario.
- Documentar versionamento, changelog, hash do release e procedimento de atualizacao.

## 4. Matriz tecnica por requisito

| Requisito | Estado | Evidencia / observacao |
| --- | --- | --- |
| Registro autenticado no servidor | Parcialmente conforme | `registerRepPunch` existe e grava via Admin SDK; faltam idempotencia e testes de falha. |
| Registro original preservado | Parcialmente conforme | Regras bloqueiam edicao/exclusao em `punches` e `arpRecords`; ajustes ainda precisam de fluxo server-side completo. |
| NSR incremental | Parcialmente conforme | Existe estado por empresa; falta modelo definitivo por estabelecimento e teste de concorrencia. |
| Horario e fonte de tempo | Parcialmente conforme | Funcao usa horario do servidor, mas a interface e alguns registros locais usam `new Date()` do dispositivo. |
| Hash e integridade | Parcialmente conforme | SHA-256 encadeado existe; precisa validar exatamente o formato final e os casos de falha. |
| Comprovante apos marcacao | Parcialmente conforme | Retorno e tela existem; PDF PAdES ainda nao. |
| Consulta das ultimas 48 horas | Parcialmente conforme | Funcoes existem e registram acesso; precisa teste do fluxo do trabalhador e politica de identificacao. |
| AFD | Nao conforme/concluido | Previa sem assinatura CAdES detached. |
| AEJ | Nao conforme/concluido | Previa sem assinatura CAdES detached e sem validacao oficial de layout. |
| Espelho de ponto | Parcialmente conforme | Relatorio imprimivel existe; precisa artefato formal, versionamento e validacao do PTRP. |
| Ajustes justificados | Parcialmente conforme | Modelo existe; autorizacao, ator e auditoria precisam ser server-side. |
| Autenticacao | Parcialmente conforme | Firebase Auth e convites existem; endurecer claims, sessoes e separacao do trabalhador. |
| Autorizacao | Parcialmente conforme | Regras sao uma boa barreira inicial, mas varias operacoes sensiveis ainda aceitam dados de identidade enviados pelo cliente. |
| Multi-tenant | Nao conforme para SaaS | Fluxos operacionais hardcoded em `main`. |
| Biometria/LGPD | Parcialmente conforme | Protecao de Storage e alternativa por PIN existem; governanca do dado biometrico esta incompleta. |
| Auditoria | Parcialmente conforme | Colecao e bloqueio de alteracao existem; falta captura automatica e ator confiavel para todos os eventos. |
| Backup/DR | Nao conforme/concluido | Nao ha evidencia de backup gerenciado e restauracao testada. |
| Portal Orquestra.cs | Parcialmente implementado | Comandos, snapshot e gatilhos de sincronizacao existem; precisa teste de ida e volta e nao deve ser confundido com conformidade REP-P. |

## 5. Plano recomendado de execucao

### Fase P0 - fundacao que bloqueia a declaracao oficial

1. **Corrigir o contexto de tenant e estabelecimento.** Substituir o `main` operacional por contexto derivado da sessao, validar o tenant no servidor e preparar migracao sem misturar dados reais.
2. **Fechar o nucleo de registro.** Definir NSR por estabelecimento, chave idempotente, outbox/retry, politica de horario, concorrencia e comportamento diante de indisponibilidade.
3. **Fechar o PTRP e os ajustes.** Mover ajustes, justificativas, aprovacao e auditoria para funcoes server-side com estados explicitos.
4. **Implementar assinatura ICP-Brasil server-side.** AFD e AEJ em CAdES detached `.p7s`; comprovante PDF em PAdES; certificado protegido, sem navegador, Firestore ou GitHub.
5. **Validar leiautes.** Criar fixtures, testes de CRC-16/KERMIT, campos, encoding, NSR, CPF/CNPJ, datas, assinatura e verificacao independente.
6. **Fechar comprovante e trabalhador.** Acesso apos cada marcacao, consulta minima de 48 horas, identificacao do estabelecimento, verificacao de assinatura e trilha de acesso.
7. **Definir biometria e LGPD.** Aviso, consentimento quando aplicavel, finalidade, minimizacao, retencao, revogacao, exclusao, controle de acesso e resposta a titulares.
8. **Implementar backup e recuperacao.** Rotina gerenciada, retencao, restauracao em ambiente de teste e evidencias.

### Fase P1 - homologacao interna e piloto

1. Testar dois tenants, dois estabelecimentos e dispositivos diferentes.
2. Testar login, convite, permissao, modo quiosque, PIN, rosto, foto, queda de rede, reenvio, duplicidade e troca de dispositivo.
3. Testar exportacao AFD/AEJ e comprovante com ferramentas de validacao de assinatura.
4. Rodar piloto controlado com uma empresa, contador e responsavel tecnico.
5. Congelar uma versao, gerar hash do release e anexar relatorio de testes.

### Fase P2 - documentacao e liberacao

1. Preencher o pacote INPI com titularidade, conteudo tecnico, resumo/hash e declaracao exigida.
2. Obter o registro de programa de computador no INPI e guardar protocolo/certificado.
3. Preencher o Atestado Tecnico e Termo de Responsabilidade com a versao efetivamente testada.
4. Obter as assinaturas exigidas dos responsaveis legal e tecnico.
5. Publicar manual operacional, politica de privacidade/retencao, procedimento de suporte e checklist do contador.
6. Somente depois, alterar o status comercial para a descricao validada pelo juridico.

## 6. Documentos e providencias externas ainda pendentes

- Registro do programa no INPI; o projeto ja possui `docs/INPI-PACOTE.md`, mas os campos e o protocolo ainda estao vazios.
- Certificado digital ICP-Brasil qualificado e estrategia segura para uso server-side.
- Assinaturas CAdES detached do AFD/AEJ e PAdES dos comprovantes.
- Atestado Tecnico e Termo de Responsabilidade preenchidos com versao, hash, titular, empresa e estabelecimento e assinados pelos responsaveis.
- Politica de privacidade, biometria, retencao, exclusao, atendimento ao trabalhador e gestao de incidentes.
- Validacao do contador e do responsavel tecnico sobre jornadas, ajustes, faltas, atestados e espelho mensal.
- Aceite juridico sobre a forma de comercializacao e sobre a descricao do produto durante a fase de piloto.

O MTE informa que o REP-P precisa do registro do programa no INPI e que o AFD/AEJ usam CAdES detached `.p7s`; o comprovante PDF usa PAdES. Tambem informa a disponibilidade dos comprovantes apos cada marcacao e a extracao das ultimas 48 horas. A sequencia NSR e propria de cada estabelecimento. Referencias oficiais:

- MTE, Perguntas e Respostas da Portaria 671: https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/fiscalizacao-do-trabalho/Perguntas%20e%20Respostas%20REP
- MTE, Registro Eletronico de Ponto: https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/fiscalizacao-do-trabalho/rep
- INPI, Registro de Programa de Computador: https://www.gov.br/pt-br/servicos/solicitar-o-registro-de-programa-de-computador

## 7. Risco de comercializacao hoje

**Nao recomendar:** anunciar que o produto esta homologado, certificado, oficialmente conforme ou pronto para fiscalizacao.

**Possivel, com aprovacao juridica e comunicacao clara:** operar como piloto/pre-validacao de controle de jornada, deixando explicito que AFD, AEJ, PDF assinado, INPI, certificado e documentos externos ainda estao pendentes.

O risco principal nao esta na existencia da tela de bater ponto. Esta na capacidade de provar, em uma fiscalizacao ou disputa, que cada registro pertence ao estabelecimento correto, nao foi alterado, pode ser exportado no formato exigido, possui assinatura verificavel e pode ser recuperado com toda a trilha de auditoria.

## 8. Criterio para declarar pronto

O sistema somente deve sair de pre-validacao quando todos estes itens tiverem evidencia anexada:

- tenant e estabelecimento corretos em todos os fluxos;
- testes de isolamento entre clientes aprovados;
- registro, NSR, hash, idempotencia e falhas aprovados;
- AFD validado e assinado CAdES;
- AEJ validado e assinado CAdES;
- comprovante PDF validado e assinado PAdES;
- acesso do trabalhador apos cada marcacao e por 48 horas testado;
- ajustes, justificativas e auditoria server-side testados;
- backup e restauracao testados;
- biometria e LGPD documentadas;
- INPI, Atestado Tecnico e Termo de Responsabilidade concluidos;
- piloto aceito pelo contador e responsavel tecnico;
- versao/hash do release congelados e publicados na documentacao.

**Status final desta auditoria:** **Parcialmente conforme para pre-validacao tecnica; nao pronto para declaracao ou comercializacao como REP-P oficial.**
