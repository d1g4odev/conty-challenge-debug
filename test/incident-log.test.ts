import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { isPastDeadline } from "../src/deadlines.ts";
import { normalizeKey } from "../src/idempotency.ts";
import { seedIncident } from "../src/seed.ts";

type LogLine = {
  msg: string;
  mission_id?: string;
  idempotency_key?: string;
  approved_at?: string;
};

function setup() {
  const db = openDatabase(":memory:");
  seedIncident(db);
  return createApp(db);
}

function approve(app: ReturnType<typeof createApp>, body: Record<string, string>) {
  return app.request("/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("prazo no dia civil de São Paulo", () => {
  it("aceita o último milissegundo do dia do prazo", () => {
    expect(isPastDeadline("2026-03-13T02:59:59.999Z", "2026-03-12")).toBe(false);
  });

  it("expira no primeiro instante do dia seguinte", () => {
    expect(isPastDeadline("2026-03-13T03:00:00.000Z", "2026-03-12")).toBe(true);
  });

  it("aceita o início do dia do prazo, que em UTC ainda é o dia anterior", () => {
    expect(isPastDeadline("2026-03-12T03:00:00.000Z", "2026-03-12")).toBe(false);
  });
});

describe("chave de idempotência", () => {
  it("ignora espaço e caracteres invisíveis reenviados pelo provedor", () => {
    expect(normalizeKey("pay_7c1​")).toBe("pay_7c1");
    expect(normalizeKey("﻿pay_7c1 ")).toBe("pay_7c1");
    expect(normalizeKey("pay_22a ")).toBe("pay_22a");
  });

  it("mantém chaves diferentes separadas", () => {
    expect(normalizeKey("pay_7c1")).not.toBe(normalizeKey("pay_7c2"));
  });
});

describe("replay do log do incidente", () => {
  const approvals = readFileSync(new URL("../logs/incident.jsonl", import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogLine)
    .filter((line) => line.msg === "approval.received");

  it("credita cada missão uma vez, no valor certo", async () => {
    const app = setup();
    for (const line of approvals) {
      const res = await approve(app, {
        mission_id: line.mission_id!,
        approved_at: line.approved_at!,
        idempotency_key: line.idempotency_key!,
      });
      expect(res.status).toBeLessThan(300);
    }

    const expected: Record<string, number> = { msn_1842: 150, msn_1900: 150, msn_2044: 80 };
    for (const [missionId, amount] of Object.entries(expected)) {
      const res = await app.request(`/missions/${missionId}`);
      const body = (await res.json()) as { ledger: Array<{ amount_brl: number }> };
      expect(body.ledger.map((entry) => entry.amount_brl)).toEqual([amount]);
    }
  });

  it("responde 200 com o lançamento original no retry com caractere invisível", async () => {
    const app = setup();
    const first = await approve(app, {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_7c1",
    });
    const retry = await approve(app, {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_7c1​",
    });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    const original = (await first.json()) as { ledger: { id: string } };
    const repeated = (await retry.json()) as { ledger: { id: string } };
    expect(repeated.ledger.id).toBe(original.ledger.id);
  });
});
