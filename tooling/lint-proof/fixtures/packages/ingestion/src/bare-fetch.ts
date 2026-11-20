export async function poll(url: string): Promise<number> {
  const response = await fetch(url);
  return response.status;
}
