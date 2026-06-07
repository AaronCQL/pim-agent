import { API_BASE_URL } from "./config";

export async function ping(): Promise<boolean> {
  const res = await fetch(`${API_BASE_URL}/health`);
  return res.ok;
}
