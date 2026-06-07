import { BASE_URL } from "./config";

export async function ping(): Promise<boolean> {
  const res = await fetch(`${BASE_URL}/health`);
  return res.ok;
}
