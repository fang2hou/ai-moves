export async function poll(url: string): Promise<number> {
  const response = await globalThis.fetch(url);
  return response.status;
}
