export async function get(request: Request): Promise<number> {
  const response = await fetch(request);
  return response.status;
}
