var Fiber = Npm.require('fibers');

var insideStartupHookSymbol = Symbol("_meteorInsideStartupHook");

Meteor._isInsideStartupHook = function () {
  return !!Fiber.current[insideStartupHookSymbol];
};

Meteor.startup = function startup(callback) {
  callback = Meteor.wrapFn(callback);
  if (process.env.METEOR_PROFILE) {
    // Create a temporary error to capture the current stack trace.
    var error = new Error("Meteor.startup");

    // Capture the stack trace of the Meteor.startup call, excluding the
    // startup stack frame itself.
    Error.captureStackTrace(error, startup);

    callback.stack = error.stack
      .split(/\n\s*/) // Split lines and remove leading whitespace.
      .slice(0, 2) // Only include the call site.
      .join(" ") // Collapse to one line.
      .replace(/^Error: /, ""); // Not really an Error per se.
  }

  var bootstrap = global.__meteor_bootstrap__;
  if (bootstrap &&
      bootstrap.startupHooks) {
    bootstrap.startupHooks.push(function () {
      try {
        Fiber.current[insideStartupHookSymbol] = true;
        callback();
      } finally {
        delete Fiber.current[insideStartupHookSymbol];
      }
    });
  } else {
    // We already started up. Just call it now.
    callback();
  }
};
