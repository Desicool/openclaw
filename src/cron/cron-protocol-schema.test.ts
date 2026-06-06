import { describe, expect, it } from "vitest";
import {
  CronAddParamsSchema,
  CronJobSchema,
  CronJobStateSchema,
} from "../../packages/gateway-protocol/src/schema.js";

type SchemaLike = {
  properties?: Record<string, unknown>;
  deprecated?: boolean;
};

describe("cron protocol schema", () => {
  it("marks the legacy lastStatus alias deprecated", () => {
    const properties = (CronJobStateSchema as SchemaLike).properties ?? {};
    const lastStatus = properties.lastStatus as SchemaLike | undefined;
    if (!lastStatus) {
      throw new Error("expected legacy lastStatus schema alias");
    }
    expect(lastStatus.deprecated).toBe(true);
  });

  it("exposes failure-notification delivery state", () => {
    const properties = (CronJobStateSchema as SchemaLike).properties ?? {};
    expect(properties.lastFailureNotificationDelivered).toBeDefined();
    expect(properties.lastFailureNotificationDeliveryStatus).toBeDefined();
    expect(properties.lastFailureNotificationDeliveryError).toBeDefined();
  });
});

describe("cron protocol schema: idempotencyKey", () => {
  it("CronJobSchema carries idempotencyKey", () => {
    const properties = (CronJobSchema as SchemaLike).properties ?? {};
    expect(properties.idempotencyKey).toBeDefined();
  });

  it("CronAddParamsSchema carries idempotencyKey", () => {
    const properties = (CronAddParamsSchema as SchemaLike).properties ?? {};
    expect(properties.idempotencyKey).toBeDefined();
  });
});
