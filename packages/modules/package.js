Package.describe({
  name: "modules",
  version: "0.19.0",
  summary: "CommonJS module system",
  documentation: "README.md"
});

Npm.depends({
  "@meteorjs/reify": "0.24.0",
});

Package.onUse(function(api) {
  api.use("modules-runtime");
  api.use("modules-runtime-hot", { weak: true });
  api.mainModule("client.js", "client");
  api.mainModule("server.js", "server");
  api.export("meteorInstall");
});
