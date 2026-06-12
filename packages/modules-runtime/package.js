Package.describe({
  name: "modules-runtime",
  version: '0.13.2',
  summary: "CommonJS module system",
  git: "https://github.com/benjamn/install",
  documentation: "README.md"
});

Package.onUse(function(api) {
  // Vendored copy of @meteorjs/install 0.14.0 with a fix for resolving
  // scoped package names without a subpath in extractPackageName.
  api.addFiles("install.js", [
    "client",
    "server"
  ], {
    bare: true
  });

  api.addFiles(['./errors/importsErrors.js',
    './errors/cannotFindMeteorPackage.js']);
  api.addFiles('modern.js', 'modern');
  api.addFiles('legacy.js', 'legacy');
  api.addFiles('server.js', 'server');
  api.addFiles('profile.js');
  api.addFiles('verifyErrors.js');

  api.export('meteorInstall');
  api.export('verifyErrors');
});

Package.onTest(function(api) {
  api.use("tinytest");
  api.use("modules"); // Test modules-runtime via modules.
  api.addFiles("modules-runtime-tests.js");
});
