import type { JsonObject } from "../../contracts/src/common.js";

export type ErrorCategory = "domain" | "media" | "provider" | "storage" | "job" | "security" | "internal";

export interface StudioErrorShape {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: JsonObject;
}

export class StudioError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly details: JsonObject;

  constructor(shape: StudioErrorShape) {
    super(shape.message);
    this.name = "StudioError";
    this.code = shape.code;
    this.category = shape.category;
    this.retryable = shape.retryable;
    this.details = shape.details;
  }
}

