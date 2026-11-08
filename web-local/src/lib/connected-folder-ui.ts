
export function surfaceDomIdSuffix(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, (character) => `-${character.charCodeAt(0).toString(16)}-`);
}
