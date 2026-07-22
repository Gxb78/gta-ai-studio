import type { IsoDateTime, JsonObject, JsonValue, Uuid } from "../../contracts/src/common.js";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface StudioLogEvent {
  readonly schema_version: "1.0";
  readonly timestamp: IsoDateTime;
  readonly level: LogLevel;
  readonly event: string;
  readonly service: string;
  readonly message: string;
  readonly trace_id: Uuid | null;
  readonly project_id: Uuid | null;
  readonly job_id: Uuid | null;
  readonly duration_ms: number | null;
  readonly attributes: JsonObject;
}

const sensitiveKey = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)/i;

function redactValue(key: string, value: JsonValue): JsonValue {
  if (sensitiveKey.test(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((child) => redactValue(key, child));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactValue(childKey, child)]));
  }
  return value;
}

export function redactAttributes(attributes: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, redactValue(key, value)]));
}

