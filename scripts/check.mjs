// Validates src/ as a loadable extension without building it.
import { validateExtension } from "./lib/manifest.mjs";
import { done, fail, packageInfo, srcDir } from "./lib/project.mjs";

const { version } = await packageInfo();
const { manifest, errors } = await validateExtension(srcDir, { version });
for (const error of errors) fail(error);
if (!errors.length) done(`${manifest.name} ${manifest.version}: manifest, icons and file references are valid.`);
