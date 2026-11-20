const blockedGlobals = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"] as const;

for (const name of blockedGlobals) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: () => {
      throw new Error(`Tests must not touch the network: global ${name} is disabled.`);
    },
  });
}
