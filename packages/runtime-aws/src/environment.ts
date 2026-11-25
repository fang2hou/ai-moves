import { AppError } from "@ai-moves/kernel/errors/app-error";

import type { AwsCredentialSource } from "./json-client.ts";

export type AwsServiceName = "dynamodb" | "s3" | "sqs" | "ssm";

export interface AwsEnvironment {
  readonly region: string;
  readonly credentials: AwsCredentialSource;
  // A local emulator endpoint per service, when one is configured.
  readonly endpoints: Readonly<Partial<Record<AwsServiceName, string>>>;
}

type EnvRecord = Readonly<Record<string, string | undefined>>;

function required(env: EnvRecord, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new AppError("CONFIG_INVALID", { message: `${name} is not set`, context: { name } });
  }
  return value;
}

function endpoint(env: EnvRecord, service: AwsServiceName): string | undefined {
  const value = env[`AWS_ENDPOINT_URL_${service.toUpperCase()}`] ?? env["AWS_ENDPOINT_URL"];
  if (value === undefined || value === "") return undefined;
  const parsed = URL.parse(value);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new AppError("CONFIG_INVALID", {
      message: "AWS endpoint override must be an HTTP URL",
      context: { service },
    });
  }
  return parsed.href;
}

// Reads the variables the Lambda runtime sets (and the AWS CLI honours locally): region, the
// execution role's credentials, and the standard endpoint overrides. The caller passes the
// environment so this package never reads process state itself.
export function readAwsEnvironment(env: EnvRecord): AwsEnvironment {
  const region = env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"];
  if (region === undefined || !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(region)) {
    throw new AppError("CONFIG_INVALID", { message: "AWS_REGION is not a region name" });
  }
  const credentials = {
    accessKeyId: required(env, "AWS_ACCESS_KEY_ID"),
    secretAccessKey: required(env, "AWS_SECRET_ACCESS_KEY"),
    sessionToken: env["AWS_SESSION_TOKEN"],
  };
  const endpoints: Partial<Record<AwsServiceName, string>> = {};
  for (const service of ["dynamodb", "s3", "sqs", "ssm"] as const) {
    const value = endpoint(env, service);
    if (value !== undefined) endpoints[service] = value;
  }
  return { region, credentials: () => Promise.resolve(credentials), endpoints };
}
