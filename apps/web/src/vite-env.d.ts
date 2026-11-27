interface ImportMetaEnv {
  readonly VITE_LOCALE?: string;
  readonly VITE_SITE_NAME?: string;
  // Same-origin path of the MCP endpoint, e.g. `/api/mcp`. Unset removes the submissions page.
  readonly VITE_MCP_PATH?: string;
}
