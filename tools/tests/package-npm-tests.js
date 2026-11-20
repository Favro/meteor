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

// Fixtures are built with frozen lockfiles off, and the frozen checks run with
// them on, whatever the environment sets, as CI does.
async function withFrozenLockfiles(frozen, run) {
  const inherited = process.env.METEOR_FROZEN_NPM_LOCKFILES;
  if (frozen) {
    process.env.METEOR_FROZEN_NPM_LOCKFILES = "true";
  } else {
    delete process.env.METEOR_FROZEN_NPM_LOCKFILES;
  }

  try {
    return await run();
  } finally {
    if (inherited === undefined) {
      delete process.env.METEOR_FROZEN_NPM_LOCKFILES;
    } else {
      process.env.METEOR_FROZEN_NPM_LOCKFILES = inherited;
    }
  }
}

async function updateDependencies(packageNpmDir, dependencies, packageName = "test:package") {
  const messages = await withFrozenLockfiles(false, () => buildmessage.capture(() =>
    meteorNpm.updateDependencies(packageName, packageNpmDir, dependencies, true)));
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

  // The package's test build shares its .npm directory, and leaves it as it is.
  const packageJsonBefore = readFile(packageNpmDir, "package.json");
  const lockfileBefore = readFile(packageNpmDir, "package-lock.json");
  await updateDependencies(packageNpmDir, dependencies, "local-test:test:package");
  assert.strictEqual(readFile(packageNpmDir, "package.json"), packageJsonBefore);
  assert.strictEqual(readFile(packageNpmDir, "package-lock.json"), lockfileBefore);

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

selftest.define("package npm - frozen lockfiles install only what is committed", ["net"], async function () {
  const packageNpmDir = files.pathJoin(files.mkdtemp("package-npm-frozen"), "pkg", ".npm", "package");
  const nodeModulesDir = files.pathJoin(packageNpmDir, "node_modules");
  const lockfilePath = files.pathJoin(packageNpmDir, "package-lock.json");
  const dependencies = { "left-pad": "1.3.0" };

  async function frozenUpdateMessages(dependencies) {
    const messages = await withFrozenLockfiles(true, () =>
      buildmessage.capture({ title: "installing" }, () =>
        meteorNpm.updateDependencies("test:package", packageNpmDir, dependencies, true)));
    return messages.hasMessages() ? messages.formatMessages() : "";
  }

  await updateDependencies(packageNpmDir, dependencies);
  const lockfile = readFile(packageNpmDir, "package-lock.json");

  files.rm_recursive(nodeModulesDir);
  assert.strictEqual(await frozenUpdateMessages(dependencies), "");
  assert.strictEqual(installedVersion(packageNpmDir, "left-pad"), "1.3.0");
  assert.strictEqual(readFile(packageNpmDir, "package-lock.json"), lockfile);

  assert.match(
    await frozenUpdateMessages({ ...dependencies, "is-number": "7.0.0" }),
    /match Npm\.depends/);
  assert.strictEqual(installedVersion(packageNpmDir, "is-number"), null);

  files.rm_recursive(nodeModulesDir);
  files.unlink(lockfilePath);
  assert.match(await frozenUpdateMessages(dependencies), /match Npm\.depends/);
  assert.strictEqual(installedVersion(packageNpmDir, "left-pad"), null);

  // A lockfile missing what package.json asks for: npm ci refuses it where npm
  // install would resolve the dependency anew.
  const outOfSync = JSON.parse(lockfile);
  delete outOfSync.packages[""].dependencies["left-pad"];
  delete outOfSync.packages["node_modules/left-pad"];
  files.writeFile(lockfilePath, JSON.stringify(outOfSync, null, 2) + "\n");
  assert.match(await frozenUpdateMessages(dependencies), /in sync/);
  assert.strictEqual(installedVersion(packageNpmDir, "left-pad"), null);
});

selftest.define("package npm - a linked package is judged by what it links to", async function () {
  const root = files.mkdtemp("package-npm-linked");
  const sourceNodeModules = files.pathJoin(root, "source", "node_modules");

  function writePackage(name, fileName) {
    const packageDir = files.pathJoin(sourceNodeModules, name);
    files.mkdir_p(packageDir);
    files.writeFile(files.pathJoin(packageDir, "package.json"),
      JSON.stringify({ name, version: "1.0.0" }));
    files.writeFile(files.pathJoin(packageDir, fileName), "");
  }

  // As a cached isopack holds its npm packages: links to the ones it was built
  // from.
  function linkedNodeModules(name, packageNames) {
    const nodeModulesDir = files.pathJoin(root, name, "node_modules");
    packageNames.forEach(packageName => {
      const linkPath = files.pathJoin(nodeModulesDir, packageName);
      files.mkdir_p(files.pathDirname(linkPath));
      files.symlink(files.pathJoin(sourceNodeModules, packageName), linkPath);
    });
    files.mkdir_p(nodeModulesDir);
    return nodeModulesDir;
  }

  writePackage("plain", "index.js");
  writePackage("native", "binding.node");

  assert.strictEqual(meteorNpm.dependenciesArePortable(
    linkedNodeModules("portable", ["plain"])), true);
  assert.strictEqual(meteorNpm.dependenciesArePortable(
    linkedNodeModules("non-portable", ["plain", "native"])), false);

  writePackage("@scope/native", "binding.node");
  assert.strictEqual(meteorNpm.dependenciesArePortable(
    linkedNodeModules("scoped-non-portable", ["plain", "@scope/native"])), false);

  // A link inside a package back up the tree is not followed.
  writePackage("looping", "index.js");
  const loopingNodeModules = files.pathJoin(sourceNodeModules, "looping", "node_modules");
  files.mkdir_p(loopingNodeModules);
  files.symlink("..", files.pathJoin(loopingNodeModules, "looping"));
  assert.strictEqual(meteorNpm.dependenciesArePortable(
    linkedNodeModules("looping", ["looping"])), true);

  // Nor does a link that leads to itself stop the check.
  const selfLinkedNodeModules = linkedNodeModules("self-linked", ["plain"]);
  files.symlink("itself", files.pathJoin(selfLinkedNodeModules, "itself"));
  assert.strictEqual(meteorNpm.dependenciesArePortable(selfLinkedNodeModules), true);
});
