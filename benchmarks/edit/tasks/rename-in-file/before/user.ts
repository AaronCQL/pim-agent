export function getUser(id: string): User {
  return db.find(id);
}

export function greet(id: string): string {
  const user = getUser(id);
  return `hi ${user.name}`;
}

export function audit(id: string): void {
  record(getUser(id));
}

export const fetcher = { getUser };
