import { createHash } from "node:crypto";
import type { JsonValue } from "../../contracts/src/common.js";

function normalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalize(value));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

