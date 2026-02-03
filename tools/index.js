const shouldLogUnitTestDiag = process.env.X_UNIT_TESTS === "true" || process.env.X_UNIT_TESTS === "1";
if (shouldLogUnitTestDiag) {
  try {
    let currentValue = process.env.NODE_ENV;
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      enumerable: true,
      get: function () {
        return currentValue;
      },
      set: function (value) {
        const prevValue = currentValue;
        currentValue = value;
        if (prevValue !== value) {
          console.log("[UnitTestDiag] NODE_ENV set", {
            prev: prevValue || "undefined",
            next: value || "undefined",
            stack: (new Error()).stack
          });
        }
      }
    });
    console.log("[UnitTestDiag] NODE_ENV hook installed", {
      initial: currentValue || "undefined"
    });
  } catch (error) {
    console.log("[UnitTestDiag] NODE_ENV hook failed", {
      message: error && error.message ? error.message : String(error)
    });
  }

  console.log("[UnitTestDiag] tool index start", {
    nodeEnv: process.env.NODE_ENV || "undefined",
    babelEnv: process.env.BABEL_ENV || "undefined",
    meteorProfile: process.env.METEOR_PROFILE || "undefined"
  });
}

require("./tool-env/install-promise.js");

require("./cli/dev-bundle-bin-commands.js").then(function (child) {
  if (! child) {
    // Use process.nextTick here to prevent the Promise from swallowing
    // errors from the rest of the setup code.
    process.nextTick(continueSetup);
  }
  // If we spawned a process to handle a dev_bundle/bin command like
  // `meteor npm` or `meteor node`, then don't run any other tool code.
}, function (error) {
  process.nextTick(function () {
    throw error;
  });
});

function continueSetup() {
  // Set up the Babel transpiler
  if (shouldLogUnitTestDiag) {
    console.log("[UnitTestDiag] tool index before install-babel", {
      nodeEnv: process.env.NODE_ENV || "undefined"
    });
  }
  require('./tool-env/install-babel.js');
  if (shouldLogUnitTestDiag) {
    console.log("[UnitTestDiag] tool index after install-babel", {
      nodeEnv: process.env.NODE_ENV || "undefined"
    });
  }

  // Run the Meteor command line tool
  if (shouldLogUnitTestDiag) {
    console.log("[UnitTestDiag] tool index before cli/main", {
      nodeEnv: process.env.NODE_ENV || "undefined"
    });
  }
  require('./cli/main.js');
}
