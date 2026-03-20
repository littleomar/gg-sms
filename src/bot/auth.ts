export function isAdminUser(userId: string | number | undefined | null, adminId: string): boolean {
  if (userId === undefined || userId === null) {
    return false;
  }
  return String(userId) === adminId;
}
