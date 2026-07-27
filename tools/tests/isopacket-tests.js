import assert from 'node:assert';
import { isopacketBuildinfoIsCurrent } from '../tool-env/isopackets.js';
const selftest = require('../tool-testing/selftest.js');
const files = require('../fs/files');
const watch = require('../fs/watch');
const compiler = require('../isobuild/compiler.js');
const config = require('../meteor-services/config.js');

// Nothing was read, so nothing can be out of date: what is left to judge is who
// built it.
function buildinfo(properties) {
  return {
    builtBy: compiler.BUILT_BY,
    builtFrom: files.realpath(files.getCurrentToolsDir()),
    watchSet: new watch.WatchSet().toJSON(),
    ...properties,
  };
}

selftest.define("isopackets - takes what this checkout built with this tool",
                async function () {
  assert.strictEqual(isopacketBuildinfoIsCurrent(buildinfo()), true);
});

selftest.define("isopackets - rebuilds what was never built or built by another tool",
                async function () {
  assert.strictEqual(isopacketBuildinfoIsCurrent(null), false);
  assert.strictEqual(
    isopacketBuildinfoIsCurrent(buildinfo({ builtBy: 'some other version' })),
    false);
});

// Checkouts can share a warehouse, and the watch set of the checkout that built
// an isopacket stays up to date when read from another one, which would then run
// the first checkout's tool code.
selftest.define("isopackets - rebuilds what another checkout built",
                async function () {
  assert.strictEqual(
    isopacketBuildinfoIsCurrent(buildinfo({ builtFrom: files.mkdtemp('other-checkout') })),
    false);
  // Written before the checkout was recorded at all.
  assert.strictEqual(
    isopacketBuildinfoIsCurrent(buildinfo({ builtFrom: undefined })), false);
});

// A warehouse can be shared, and isopackets cannot: each checkout builds its own
// from its own sources, into a directory of its own.
selftest.define("isopackets - keeps the isopackets of two checkouts apart",
                async function () {
  const checkout = files.mkdtemp('checkout');
  const key = config.isopacketSourceKey(checkout);

  assert.strictEqual(config.isopacketSourceKey(checkout), key);
  assert.notStrictEqual(config.isopacketSourceKey(files.mkdtemp('checkout')), key);

  // One checkout reached two ways is still one checkout.
  const link = files.pathJoin(files.mkdtemp('link'), 'linked');
  files.symlink(checkout, link);
  assert.strictEqual(config.isopacketSourceKey(link), key);
});
