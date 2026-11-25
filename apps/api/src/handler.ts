/// <reference types="node" />
import { createLambdaApi, readAwsApiSettings } from "./lambda.ts";

// oxlint-disable-next-line node/no-process-env -- The Lambda runtime hands configuration to the entry point through the environment.
export const handler = createLambdaApi(readAwsApiSettings(process.env));
