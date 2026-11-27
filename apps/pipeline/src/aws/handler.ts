/// <reference types="node" />
import { createLambdaPipeline, readAwsPipelineSettings } from "./lambda.ts";

// oxlint-disable-next-line node/no-process-env -- The Lambda runtime hands configuration to the entry point through the environment.
const pipeline = createLambdaPipeline(() => readAwsPipelineSettings(process.env));

export const tick = (event: unknown): Promise<void> => pipeline.tick(event);
export const queue = (event: unknown) => pipeline.queue(event);
// The environment-built settings carry no `identifySubmitter`, so this entry answers 401 until a
// deployment's own entry supplies one.
export const mcp = (event: unknown) => pipeline.mcp(event);
