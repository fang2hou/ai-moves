export async function post(request: Request): Promise<number> {
  const response = await fetch(request);
  return response.status;
}
