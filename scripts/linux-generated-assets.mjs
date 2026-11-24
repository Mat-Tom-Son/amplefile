// The files the Linux packages take from out/generated-linux-assets: the
// maintainer scripts (Electron Builder's desktop and AppArmor setup extended
// with AmpleFile's CLI link) and, for an enrolling RPM, the dnf repository
// entry (scripts/linux-package-repository.cjs). Written before every
// Electron Builder run that makes a DEB or RPM.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const { linuxRpmEnrolment, repositoryEntry } = createRequire(import.meta.url)("./linux-package-repository.cjs");

/** Writes the generated Linux package assets under `root` and returns the RPM's enrolment. */
export async function writeGeneratedLinuxAssets(root, identity) {
  const hooks = join(root, "out/generated-linux-assets");
  await mkdir(hooks, { recursive: true });
  for (const name of ["after-install", "after-remove"]) {
    const upstream = await readFile(join(root, `node_modules/app-builder-lib/templates/linux/${name}.tpl`), "utf8");
    const cli = await readFile(join(root, `desktop/linux/${name}.sh`), "utf8");
    const guard = name === "after-remove" ? await readFile(join(root, "desktop/linux/before-remove.sh"), "utf8") : "";
    await writeFile(join(hooks, `${name}.sh`), `${guard}${upstream}\n${cli}\n`);
  }
  const enrolment = linuxRpmEnrolment(root, identity);
  await rm(join(hooks, "rpm"), { recursive: true, force: true });
  if (enrolment.enrolled) {
    await mkdir(join(hooks, "rpm"), { recursive: true });
    await writeFile(join(hooks, "rpm", `${enrolment.repository.id}.repo`), repositoryEntry(identity));
  }
  return enrolment;
}
