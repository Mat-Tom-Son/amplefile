import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";

function accountName(database: "passwd" | "group", id: number): Promise<string> {
  return new Promise((resolve) => {
    execFile("getent", [database, String(id)], { timeout: 1_000, maxBuffer: 8_192 }, (error, stdout) => {
      const name = error ? "" : stdout.split(":", 1)[0];
      resolve(name && !/[\x00-\x1f\x7f]/.test(name) ? name : String(id));
    });
  });
}

function permissionsText(mode: number): string {
  const octal = (mode & 0o7777).toString(8).padStart(4, "0");
  const access = [6, 3, 0].map((shift) => {
    const bits = (mode >> shift) & 7;
    const special = (mode & (0o1000 << (shift / 3))) !== 0;
    const specialLetter = shift === 0 ? "t" : "s";
    const execute = bits & 1 ? (special ? specialLetter : "x") : (special ? specialLetter.toUpperCase() : "-");
    return `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${execute}`;
  }).join("");
  return `${access} (${octal})`;
}

export async function readLinuxEntryDetails(path: string) {
  const info = await lstat(path);
  const [owner, group] = await Promise.all([accountName("passwd", info.uid), accountName("group", info.gid)]);
  return {
    createdAt: info.birthtimeMs > 0 ? info.birthtime.toISOString() : null,
    modifiedAt: info.mtime.toISOString(),
    permissions: permissionsText(info.mode),
    owner,
    group,
  };
}
