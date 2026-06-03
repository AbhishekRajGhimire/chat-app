export function avatarSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${path}&token=${localStorage.getItem('access_token')}`;
}
