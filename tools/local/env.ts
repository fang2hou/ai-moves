// The TypeScript scripts in this directory are command-line tools whose input is the process
// environment; this module is the only place they read it.
export function readEnv(name: string): string | undefined {
  // oxlint-disable-next-line node/no-process-env -- A command-line script takes its input from the environment.
  return process.env[name];
}
