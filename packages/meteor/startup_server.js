var insideStartupHookKey = "_meteorInsideStartupHook";

Meteor._isInsideStartupHook = function () {
  return !!Meteor._getValueFromAslStore(insideStartupHookKey);
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
      var existingStore = Meteor._getAslStore() || {};
      var newStore = Object.assign({}, existingStore);
      newStore[insideStartupHookKey] = true;
      return Meteor._getAsl().run(newStore, callback);
    });
  } else {
    // We already started up. Just call it now.
    callback();
  }
};
