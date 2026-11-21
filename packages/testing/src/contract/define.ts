import { describe, it } from "vitest";

// A port contract is the behaviour every implementation of a port must show. It is written once,
// against a harness, and run against each implementation: the in-memory fake here, the Cloudflare
// adapter in its own package, and later an AWS adapter (architecture 3.6).

export interface ContractCase<Harness> {
  readonly name: string;
  readonly run: (harness: Harness) => Promise<void> | void;
}

export interface PortContract<Harness> {
  readonly port: string;
  readonly cases: readonly ContractCase<Harness>[];
}

export interface HarnessFactory<Harness> {
  // Called before every case, so no state leaks between cases.
  readonly create: () => Promise<Harness> | Harness;
  readonly dispose?: (harness: Harness) => Promise<void> | void;
}

export function definePortContract<Harness>(
  port: string,
  cases: readonly ContractCase<Harness>[],
): PortContract<Harness> {
  return { port, cases };
}

// Registers one test per contract case for the named implementation. Call it at the top level of a
// test file.
export function runPortContract<Harness>(
  contract: PortContract<Harness>,
  implementation: string,
  factory: HarnessFactory<Harness>,
): void {
  describe(`${contract.port} contract: ${implementation}`, () => {
    for (const contractCase of contract.cases) {
      it(contractCase.name, async () => {
        const harness = await factory.create();
        try {
          await contractCase.run(harness);
        } finally {
          await factory.dispose?.(harness);
        }
      });
    }
  });
}
