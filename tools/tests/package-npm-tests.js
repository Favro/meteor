import assert from 'node:assert';
const selftest = require('../tool-testing/selftest.js');
const files = require('../fs/files');
const buildmessage = require('../utils/buildmessage.js');
const meteorNpm = require('../isobuild/meteor-npm.js');

// chalk takes supports-color ^5.3.0, so pinning an older version than the
// newest one npm would pick shows whether the pin is kept. react-dom brings
// react in as a peer dependency only, and less brings optional dependencies.
const DEPENDENCIES = {
  "chalk": "2.4.2",
  "react-dom": "18.3.1",
  "less": "4.1.1",
};

const PINNED = {
  key: "node_modules/supports-color",
  version: "5.4.0",
  resolved: "https://registry.npmjs.org/supports-color/-/supports-color-5.4.0.tgz",
  integrity: "sha512-zjaXglF5nnWpsq470jSv6P9DwPvgLkuapYmfDm3JWOm0vkNTVF2tI4UrN2r6jH1qM/uc/WtxYY1hYoA2dOKj5w==",
};

async function updateDependencies(packageNpmDir, dependencies) {
  const messages = await buildmessage.capture(() =>
    meteorNpm.updateDependencies("test:package", packageNpmDir, dependencies, true));
  assert.ok(! messages.hasMessages(), messages.formatMessages());
}

function readFile(packageNpmDir, name) {
  return files.readFile(files.pathJoin(packageNpmDir, name), "utf8");
}

function installedVersion(packageNpmDir, name) {
  const packageJsonPath =
    files.pathJoin(packageNpmDir, "node_modules", name, "package.json");
  return files.exists(packageJsonPath)
    ? JSON.parse(files.readFile(packageJsonPath, "utf8")).version
    : null;
}

selftest.define("package npm - installs what package-lock.json pins", ["net"], async function () {
  const root = files.mkdtemp("package-npm");
  const packageNpmDir = files.pathJoin(root, "pkg", ".npm", "package");
  const nodeModulesDir = files.pathJoin(packageNpmDir, "node_modules");

  // A file: dependency given by absolute path, as Npm.depends may give it.
  const localDir = files.pathJoin(root, "local-thing");
  files.mkdir_p(localDir);
  files.writeFile(files.pathJoin(localDir, "package.json"),
    JSON.stringify({ name: "local-thing", version: "1.0.0" }));
  const dependencies = { ...DEPENDENCIES, "local-thing": `file://${localDir}` };

  await updateDependencies(packageNpmDir, dependencies);

  const packageJson = JSON.parse(readFile(packageNpmDir, "package.json"));
  assert.strictEqual(packageJson.name, "test-package");
  assert.strictEqual(packageJson.dependencies["local-thing"], "file:../../../local-thing");
  assert.strictEqual(installedVersion(packageNpmDir, "local-thing"), "1.0.0");

  // Pin an older version, and install as a fresh checkout would: from
  // package.json and the lockfile, with nothing installed.
  const lockfile = JSON.parse(readFile(packageNpmDir, "package-lock.json"));
  assert.notStrictEqual(lockfile.packages[PINNED.key].version, PINNED.version);
  Object.assign(lockfile.packages[PINNED.key], {
    version: PINNED.version,
    resolved: PINNED.resolved,
    integrity: PINNED.integrity,
  });
  files.writeFile(files.pathJoin(packageNpmDir, "package-lock.json"),
    JSON.stringify(lockfile, null, 2) + "\n");
  const pinned = readFile(packageNpmDir, "package-lock.json");

  files.rm_recursive(nodeModulesDir);
  await updateDependencies(packageNpmDir, dependencies);
  assert.strictEqual(installedVersion(packageNpmDir, "supports-color"), PINNED.version);
  assert.ok(installedVersion(packageNpmDir, "react"), "react, a peer dependency, is missing");
  assert.ok(installedVersion(packageNpmDir, "image-size"),
    "image-size, an optional dependency, is missing");
  assert.strictEqual(readFile(packageNpmDir, "package-lock.json"), pinned);

  // Installed for something else, such as another Node version.
  files.writeFile(files.pathJoin(nodeModulesDir, ".meteor-npm-install"), "elsewhere");
  await updateDependencies(packageNpmDir, dependencies);
  assert.notStrictEqual(
    files.readFile(files.pathJoin(nodeModulesDir, ".meteor-npm-install"), "utf8"),
    "elsewhere");
  assert.strictEqual(readFile(packageNpmDir, "package-lock.json"), pinned);

  // A dependency nothing else uses added, and taken away again.
  await updateDependencies(packageNpmDir, { ...dependencies, "left-pad": "1.3.0" });
  assert.strictEqual(installedVersion(packageNpmDir, "left-pad"), "1.3.0");
  assert.strictEqual(installedVersion(packageNpmDir, "supports-color"), PINNED.version);

  await updateDependencies(packageNpmDir, dependencies);
  assert.strictEqual(installedVersion(packageNpmDir, "left-pad"), null);
  assert.strictEqual(readFile(packageNpmDir, "package-lock.json"), pinned);
});
