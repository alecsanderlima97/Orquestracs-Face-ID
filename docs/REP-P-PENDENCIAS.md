# Orquestracs Face ID - status de preparacao REP-P

Este documento registra o estado tecnico atual do produto. Ele nao constitui atestado de conformidade, homologacao ou parecer juridico.

## Ja preparado no sistema

- Registro de ponto feito por funcao server-side autenticada.
- NSR sequencial por empresa e encadeamento por hash SHA-256.
- Registro ARP separado para preservar a trilha do evento.
- Batida original sem edicao direta pelo navegador.
- Ajustes tratados como eventos separados, com justificativa e responsavel.
- Comprovante imediato com NSR, horario do servidor, trabalhador e hash.
- Consulta autenticada pelo PIN dos comprovantes do proprio colaborador nas ultimas 48 horas, com log de acesso.
- Geracao de previa tecnica de AFD e AEJ para conferencia.
- Indicacao visivel na Central Admin de pendencias externas.

## Ainda necessario antes de declarar uso oficial

- Registrar o programa de computador no INPI e arquivar o protocolo/registro.
- Confirmar titularidade, versao, hash e documentos da empresa desenvolvedora.
- Configurar certificado ICP-Brasil em ambiente server-side protegido.
- Implementar a assinatura CAdES destacada dos arquivos AFD e AEJ.
- Implementar a assinatura PAdES dos comprovantes PDF, se essa for a forma adotada.
- Validar CRC16/KERMIT e os layouts finais com o responsavel tecnico.
- Finalizar e assinar o Atestado Tecnico e Termo de Responsabilidade.
- Definir com o contador e o juridico a politica de ajustes, faltas, biometria, retencao e atendimento ao trabalhador.
- Executar testes de aceite com uma empresa piloto e guardar as evidencias.

## Importante

O codigo atual permanece em modo de pre-validacao. AFD, AEJ e PDF nao devem ser apresentados como arquivos oficiais enquanto a assinatura, os documentos e a validacao externa nao estiverem concluidos.

Certificados, chaves privadas e senhas nao devem ser commitados no GitHub, enviados ao navegador ou gravados em texto aberto no Firestore.

## Referencias oficiais para conferencia

- MTE - Perguntas e Respostas REP: https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/fiscalizacao-do-trabalho/Perguntas%20e%20Respostas%20REP
- MTE - Registro Eletronico de Ponto: https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/fiscalizacao-do-trabalho/rep
- INPI - Registro de Programa de Computador: https://www.gov.br/pt-br/servicos/solicitar-o-registro-de-programa-de-computador
