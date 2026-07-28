import assert from 'node:assert';
import { defaultLockRoot, exclusiveLockPath } from '../fs/exclusive-lock';
import { IsopackCache } from '../isobuild/isopack-cache.js';
const selftest = require('../tool-testing/selftest.js');
const files = require('../fs/files');
const { ProjectContext } = require('../project-context.js');

const packageNames = ['first-package', 'second-package'];

// What is in the place locks go when a caller names none. Everything built from
// this checkout shares it, so it is compared rather than emptied or counted.
function defaultLockRootEntries() {
  const lockRoot = defaultLockRoot();

  return files.exists(lockRoot) ? files.readdir(lockRoot).sort() : [];
}

// A cache with packages saved in it, as an application sharing a cache is given.
// Only wiping is exercised here, which reads nothing about the packages
// themselves, so what is saved need not be a real isopack.
function makeCache(options) {
  const cacheDir = files.pathJoin(files.mkdtemp('isopack-cache-wipe'), 'isopacks');

  for (const name of packageNames) {
    files.mkdir_p(files.pathJoin(cacheDir, name));
    files.writeFile(files.pathJoin(cacheDir, name, 'isopack.json'), 'saved');
  }

  return new IsopackCache(Object.assign({ cacheDir }, options));
}

function isopackDir(cache, name) {
  return files.pathJoin(cache.cacheDir, name);
}

// Where a project would put the locks of the cache it was pointed at, or of the
// cache it keeps to itself when it was pointed at none.
function isopackCacheLockRootFor(sharedCacheDir) {
  const previous = process.env.METEOR_ISOPACK_CACHE_DIR;
  if (sharedCacheDir) {
    process.env.METEOR_ISOPACK_CACHE_DIR = files.convertToOSPath(sharedCacheDir);
  } else {
    delete process.env.METEOR_ISOPACK_CACHE_DIR;
  }

  try {
    return new ProjectContext({
      projectDir: files.mkdtemp('isopack-cache-project'),
    }).isopackCacheLockRoot;
  } finally {
    if (previous === undefined) {
      delete process.env.METEOR_ISOPACK_CACHE_DIR;
    } else {
      process.env.METEOR_ISOPACK_CACHE_DIR = previous;
    }
  }
}

// The whole cache goes, but not the directory holding it: locks are named after
// the directory containing what they stand for, and a replacement directory
// would part every build from the locks it already holds.
selftest.define("isopack cache wipe - leaves the cache directory in place",
                async function () {
  const lockRoot = files.mkdtemp('isopack-cache-locks');
  const cache = makeCache({ lockRoot });
  const lockPathBefore = exclusiveLockPath(lockRoot, isopackDir(cache, 'first-package'));

  await cache.wipeCachedPackages();

  assert.ok(files.exists(cache.cacheDir),
    'the cache directory was taken away along with the packages in it');
  assert.strictEqual(
    exclusiveLockPath(lockRoot, isopackDir(cache, 'first-package')),
    lockPathBefore,
    'the packages of the wiped cache are locked under another name now');

  for (const name of packageNames) {
    assert.ok(! files.exists(isopackDir(cache, name)), `${name} was left behind`);
  }
});

selftest.define("isopack cache wipe - wipes only the packages it was given",
                async function () {
  const cache = makeCache({ lockRoot: files.mkdtemp('isopack-cache-locks') });

  await cache.wipeCachedPackages(['first-package']);

  assert.ok(! files.exists(isopackDir(cache, 'first-package')));
  assert.ok(files.exists(isopackDir(cache, 'second-package')));
});

// A dot-prefixed entry is another build's temporary directory, locked under the
// name of the package it will become rather than its own, so a wipe that took it
// would take it out from under the build writing it.
selftest.define("isopack cache wipe - leaves another build's temporary directory alone",
                async function () {
  const cache = makeCache({ lockRoot: files.mkdtemp('isopack-cache-locks') });
  const buildDir = files.pathJoin(cache.cacheDir, '.build123.first-package');
  files.mkdir_p(buildDir);
  files.writeFile(files.pathJoin(buildDir, 'isopack.json'), 'being written');

  await cache.wipeCachedPackages();

  assert.ok(files.exists(buildDir),
    "a temporary directory was taken out from under the build writing it");

  for (const name of packageNames) {
    assert.ok(! files.exists(isopackDir(cache, name)), `${name} was left behind`);
  }
});

// Nothing else reaches a cache that belongs to one project, so an ordinary
// application leaves no lock behind for the packages it builds. _withIsopackLock
// is called directly; there is no other way to ask whether a lock was taken.
selftest.define("isopack cache - takes no locks for a cache nothing else reaches",
                async function () {
  const cache = makeCache();
  const before = defaultLockRootEntries();

  const built = await cache._withIsopackLock('first-package', () => 'built');
  await cache.wipeCachedPackages();

  assert.strictEqual(built, 'built');
  assert.deepStrictEqual(defaultLockRootEntries(), before,
    'a cache belonging to one project left a lock behind');
  assert.ok(! files.exists(cache.cacheDir + '.locks'));

  for (const name of packageNames) {
    assert.ok(! files.exists(isopackDir(cache, name)), `${name} was left behind`);
  }
});

// Where a shared cache's locks go is what decides whether the applications
// sharing it meet over a package at all: they have to name the same place for
// them, having only the cache in common.
selftest.define("isopack cache - locks a shared cache beside the cache",
                async function () {
  const sharedCache = files.pathJoin(files.mkdtemp('isopack-cache-shared'),
    'os.osx.arm64');

  const lockRoot = isopackCacheLockRootFor(sharedCache);

  assert.ok(lockRoot, 'a shared cache was given nowhere to keep its locks');
  assert.strictEqual(files.pathDirname(lockRoot), files.pathDirname(sharedCache),
    'the locks of a shared cache are not kept beside it');
  // Not under the cache, which is wiped and replaced out from under them, and not
  // in this checkout or this user's home, which another application sharing the
  // cache does not have in common with this one.
  assert.ok(! lockRoot.startsWith(sharedCache + '/'));
  assert.ok(! lockRoot.startsWith(files.getCurrentToolsDir()));
  assert.ok(! lockRoot.startsWith(files.getHomeDir()));

  // A cache in the project's own local directory is reached by nothing else, so
  // there is nowhere its locks have to be and nothing to lock.
  assert.strictEqual(isopackCacheLockRootFor(null), null);
});

// What 'meteor rebuild' does in a project that has not been built yet, which has
// no more to answer for than a wipe that took everything away.
selftest.define("isopack cache wipe - has nothing to do before anything is saved",
                async function () {
  const cache = new IsopackCache({
    cacheDir: files.pathJoin(files.mkdtemp('isopack-cache-wipe'), 'isopacks'),
    lockRoot: files.mkdtemp('isopack-cache-locks'),
  });

  await cache.wipeCachedPackages();

  assert.ok(! files.exists(cache.cacheDir));
});
