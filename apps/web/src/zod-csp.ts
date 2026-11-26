import { z } from "zod";

// The desk's Content-Security-Policy forbids eval, so disable Zod's JIT capability probe.
z.config({ jitless: true });
