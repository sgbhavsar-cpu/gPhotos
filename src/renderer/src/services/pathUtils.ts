/**
 * Joins a virtual storage's local mirror root with its name, matching
 * whichever path separator the root itself already uses — the renderer has
 * no access to Node's path module (especially not the browser/mobile
 * client), and a literal '\\' broke every mirror path on Linux/macOS hosts
 * (e.g. "/root/GPhotos_VirtualMirrors\\TestNAS", which isn't a valid path on
 * either OS).
 */
export function joinMirrorPath(root: string, name: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${name}`;
}
