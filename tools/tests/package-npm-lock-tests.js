import assert from 'node:assert';
import {
  packageNpmDirectoryLockPath,
  withPackageNpmDirectoryLock,
} from '../isobuild/meteor-npm.js';
const selftest = require('../tool-testing/selftest.js');
const files = require('../fs/files');
const utils = require('../utils/utils.js');
const cleanup = require('../tool-env/cleanup.js');

const { spawn } = require('child_process');
const fs = require('fs');

// The lock stands for a package's .npm directory, which does not have to exist.
function makePackageNpmDir() {
  const packageNpmDir = files.pathJoin(files.mkdtemp('npm-lock'), '.npm');
  // Real package directories are few and lasting, so their locks are left where
  // they are; one standing for a temporary directory is of no use to anything
  // once this run ends. Worked out now rather than on the way out, when the
  // directory it is named after may already have been cleaned up.
  const lockPath = packageNpmDirectoryLockPath(packageNpmDir);
  cleanup.onExit(() => fs.rmSync(lockPath, { force: true }));

  return packageNpmDir;
}

// The directory being guarded is renamed away by the work that is guarded, and
// these directories sit in the repositories packages are checked out from, so a
// lock in either place would be lost or would show up as an untracked file.
selftest.define("package npm lock - keeps the lock out of the guarded directory",
                async function () {
  const packageNpmDir = makePackageNpmDir();
  const lockPath = packageNpmDirectoryLockPath(packageNpmDir);

  assert.ok(! lockPath.startsWith(files.pathDirname(packageNpmDir)),
    `lock ${lockPath} is kept with the directory it guards`);
  // Where everything built from this checkout will look for it, whichever user
  // or Meteor installation started the build.
  assert.strictEqual(files.pathDirname(lockPath),
    files.pathJoin(files.getCurrentToolsDir(), '.meteor', 'locks'));
  // One directory, one lock, however the caller spells the path to it.
  const spelledWithDotDot = files.pathJoin(files.pathDirname(packageNpmDir),
    'elsewhere', '..', files.pathBasename(packageNpmDir));
  assert.strictEqual(packageNpmDirectoryLockPath(spelledWithDotDot), lockPath);
});

selftest.define("package npm lock - keeps another build out of one .npm directory",
                async function () {
  const packageNpmDir = makePackageNpmDir();
  const lockPath = packageNpmDirectoryLockPath(packageNpmDir);

  const result = await withPackageNpmDirectoryLock(packageNpmDir, async function () {
    // Stands in for the second build: it asks for the same lock and is told the
    // directory is busy rather than installing into it as well.
    const script = `
      const sqlite3 = require(${JSON.stringify(files.pathJoin(files.getDevBundle(), 'lib', 'node_modules', 'sqlite3'))});
      const db = new sqlite3.Database(${JSON.stringify(files.convertToOSPath(lockPath))});
      db.serialize(() => {
        db.run("PRAGMA busy_timeout = 100");
        db.run("BEGIN EXCLUSIVE", err => {
          console.log(err ? "busy:" + err.code : "acquired");
          process.exit(err ? 1 : 0);
        });
      });
    `;
    const other = spawn(process.execPath, ['-e', script],
      { stdio: ['ignore', 'pipe', 'inherit'] });

    let output = '';
    other.stdout.on('data', data => output += data);
    for (let waited = 0; waited < 10000 && output === ''; waited += 50) {
      await utils.sleepMs(50);
    }

    assert.strictEqual(output.trim(), 'busy:SQLITE_BUSY');
    return 'held throughout';
  });

  assert.strictEqual(result, 'held throughout');
});
