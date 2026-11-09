const path = require("node:path").posix;

const mockUnsubscribe = jest.fn(async () => {});
const mockSubscribe = jest.fn(async () => ({ unsubscribe: mockUnsubscribe }));

jest.mock(
  "@parcel/watcher",
  () => ({
    __esModule: true,
    default: { subscribe: mockSubscribe },
  }),
  { virtual: true },
);

jest.mock("./safe-watcher-legacy", () => ({
  watch: jest.fn(),
  addWatchRoot: jest.fn(),
  closeAllWatchers: jest.fn(),
}));

jest.mock("../tool-env/profile", () => ({
  Profile: (_name, fn) => fn,
}));

jest.mock("../tool-env/meteor-config", () => ({
  getMeteorConfig: () => ({ modern: { watcher: true } }),
}));

jest.mock("./files", () => ({
  statOrNull: (filePath) => ({
    isDirectory: () => !/\.(js|json)$/.test(filePath),
  }),
  lstat: () => ({ isSymbolicLink: () => false }),
  toPosixPath: (filePath) => filePath,
  convertToOSPath: (filePath) => filePath,
  pathRelative: path.relative,
  watchFile: jest.fn(),
  unwatchFile: jest.fn(),
  pathResolve: path.resolve,
  pathDirname: path.dirname,
}));

const safeWatcher = require("./safe-watcher.ts");

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));
const activeWatchers = [];

const watch = (filePath) => {
  const callback = jest.fn();
  activeWatchers.push(safeWatcher.watch(filePath, callback));
  return callback;
};

// Watches the root the way a package's source directory is watched, and returns
// a function that delivers native watcher events for it.
async function watchRoot(root) {
  safeWatcher.addWatchRoot(root);
  await flushPromises();

  const subscription = mockSubscribe.mock.calls.find(([dir]) => dir === root);
  expect(subscription).toBeDefined();

  return (events) => subscription[1](null, events);
}

beforeEach(() => {
  mockSubscribe.mockClear();
  mockUnsubscribe.mockClear();
});

afterEach(async () => {
  activeWatchers.splice(0).forEach((watcher) => watcher.close());
  await safeWatcher.closeAllWatchers();
});

// Meteor replaces a package's .npm directory by renaming a new one into place,
// which the native watcher reports as an event for the directory alone.
describe("safe watcher events for a directory replaced as a whole", () => {
  const root = "/app/packages/minifiers";
  const npmDir = `${root}/.npm/plugin/minifyStdCSS`;

  it("tells files below a directory that is created", async () => {
    const emit = await watchRoot(root);
    const shrinkwrap = watch(`${npmDir}/npm-shrinkwrap.json`);
    const readme = watch(`${npmDir}/README.js`);

    emit([{ type: "create", path: npmDir }]);

    expect(shrinkwrap).toHaveBeenCalledWith("change");
    expect(readme).toHaveBeenCalledWith("change");
  });

  it("tells files below a directory that is deleted", async () => {
    const emit = await watchRoot(root);
    const shrinkwrap = watch(`${npmDir}/npm-shrinkwrap.json`);

    emit([{ type: "delete", path: npmDir }]);

    expect(shrinkwrap).toHaveBeenCalledWith("delete");
  });

  it("does not tell files below a directory that is only updated", async () => {
    const emit = await watchRoot(root);
    const shrinkwrap = watch(`${npmDir}/npm-shrinkwrap.json`);

    emit([{ type: "update", path: npmDir }]);

    expect(shrinkwrap).not.toHaveBeenCalled();
  });

  it("does not tell files in a sibling whose name starts the same", async () => {
    const emit = await watchRoot(root);
    const sibling = watch(`${npmDir}-other/npm-shrinkwrap.json`);

    emit([{ type: "create", path: npmDir }]);

    expect(sibling).not.toHaveBeenCalled();
  });

  it("tells the directory itself once", async () => {
    const emit = await watchRoot(root);
    const directory = watch(npmDir);

    emit([{ type: "create", path: npmDir }]);

    expect(directory).toHaveBeenCalledTimes(1);
  });
});
