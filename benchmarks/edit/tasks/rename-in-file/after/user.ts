export function fetchUser(id: string): User {
  return db.find(id);
}

export function greet(id: string): string {
  const user = fetchUser(id);
  return `hi ${user.name}`;
}

export function audit(id: string): void {
  record(fetchUser(id));
}

export const fetcher = { fetchUser };
