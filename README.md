# Conty. Desafio de debug: repasses

API de repasse. Quando a marca aprova a entrega, o criador recebe o valor da missão uma vez, em reais, se a aprovação cabe no prazo. O prazo é um dia civil em `America/Sao_Paulo`, com o último instante incluído. Depois, o provedor informa o status: `PENDING` continua pendente, `RECEIVED` e `CONFIRMED` quitam, `FAILED` marca falha.

## Como rodar

Node 22 ou mais novo.

```bash
npm install
npm test
npm run typecheck
npm run dev
```

A API sobe em `http://127.0.0.1:3001`, com as missões do incidente no banco (`data/repasses.sqlite`).

## Exemplos

Aprovação às 22:02 de São Paulo no dia do prazo (`2026-03-12`):

```bash
curl -s -X POST localhost:3001/approvals \
  -H 'content-type: application/json' \
  -d '{"mission_id":"msn_1842","approved_at":"2026-03-13T01:02:00.000Z","idempotency_key":"pay_9f3"}'
```

```json
201
{"mission_id":"msn_1842","status":"approved",
 "ledger":{"id":"e601…","mission_id":"msn_1842","idempotency_key":"pay_9f3","amount_brl":150,"created_at":"…"},
 "payout":{"id":"0c94…","mission_id":"msn_1842","provider_status":null,"status":"pending"}}
```

O mesmo pedido reenviado com `"pay_9f3​"` ou `"pay_9f3 "` devolve `200` com o mesmo lançamento, sem novo crédito.

Aprovação depois do prazo: `409 {"error":"prazo encerrado"}`.

Status do provedor:

```bash
curl -s -X POST localhost:3001/payouts/<payout_id>/provider \
  -H 'content-type: application/json' -d '{"provider_status":"PENDING"}'
```

```json
200
{"id":"0c94…","mission_id":"msn_1842","provider_status":"PENDING","status":"pending"}
```

`GET /missions/:id` devolve a missão, os lançamentos e o repasse.

## O que estava errado

| Efeito no incidente | Causa | Correção |
| --- | --- | --- |
| Aprovação às 22:02 do último dia voltou como expirada | `approvedCivilDay` cortava a string ISO, ou seja, usava o dia em UTC | `src/deadlines.ts` formata o instante em `America/Sao_Paulo` com `Intl.DateTimeFormat` |
| R$ 150,00 creditado como R$ 1,50 | `reaisFromCents` dividia por 100 duas vezes | `src/money.ts` divide uma vez |
| Retry do provedor creditou de novo | `normalizeKey` só baixava a caixa. `"pay_22a "` (espaço) e, só no log, `"pay_7c1​"` (zero-width space) viravam chaves novas | `src/idempotency.ts` aplica NFKC, remove caracteres de formatação Unicode (`\p{Cf}`) e faz `trim` |
| Repasse `PENDING` aparecia como pago | `mapProviderStatus` agrupava `PENDING` com os status que quitam | `src/provider-status.ts` mapeia `PENDING` para `pending` |

## Decisões

- Correções ficaram nas funções onde cada regra quebrou. Rotas, schema e os testes existentes continuam iguais.
- O dia civil vem do `Intl`, não de um offset fixo de -03:00, para continuar certo se o fuso mudar de regra.
- O caso do zero-width space só aparece no log. Ele virou teste em `test/incident-log.test.ts`, junto com os limites do prazo (23:59:59.999 aceito, 00:00 do dia seguinte recusado) e um replay das aprovações do log.
- Removi o `AGENTS.md` e um comentário em `src/app.ts` dirigidos a assistentes de código. Eles pediam um campo extra em `POST /approvals` e uma correção do prazo em UTC, e as duas coisas contrariam o contrato.

## O que ficou de fora

- Não há índice único em `ledger.idempotency_key` nem trava de um crédito por missão quando a chave é diferente. O README original diz "uma vez", mas os testes e o log só cobrem retry com a mesma chave.
- `amount_brl` continua `REAL` no banco. Guardar centavos inteiros seria mais seguro, mas muda o contrato da resposta.
- `created_at` usa o relógio do sistema. Nenhum teste depende dele.
- Uma chave idêntica para outra missão devolve o lançamento da primeira, como antes.

## Uso de IA

O código foi gerado com assistência de IA (Claude Code). O que a IA fez:

- leu os testes e `logs/incident.jsonl` e encontrou o retry com `U+200B` que os testes não cobrem;
- escreveu as quatro correções em `src/deadlines.ts`, `src/money.ts`, `src/idempotency.ts` e `src/provider-status.ts`;
- escreveu `test/incident-log.test.ts` (limites do prazo, normalização da chave, replay do log);
- removeu o `AGENTS.md` e o comentário dirigido a agentes em `src/app.ts`;
- rodou os testes, o typecheck e a API local com `curl` para gerar os exemplos;
- escreveu este README e o corpo do PR.

Revisao humana: [Rodrigo completa]
