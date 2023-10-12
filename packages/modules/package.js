Package.describe({
  name: "modules",
  version: '0.20.3',
  summary: "CommonJS module system",
  documentation: "README.md"
});

Npm.depends({
  "@meteorjs/reify": "0.25.4"
});

Package.onUse(function(api) {
  api.use("modules-runtime");
  api.use("modules-runtime-hot", { weak: true });
  api.mainModule("client.js", "client");
  api.mainModule("server.js", "server");
  api.export("meteorInstall");
});
