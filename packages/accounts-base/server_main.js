import { AccountsServer } from "./accounts_server.js";

if (process.env.LOCAL_STORAGE_NAMESPACE !== undefined) {
  __meteor_runtime_config__.LOCAL_STORAGE_NAMESPACE =
    process.env.LOCAL_STORAGE_NAMESPACE;
}

/**
 * @namespace Accounts
 * @summary The namespace for all server-side accounts-related methods.
 */
Accounts = new AccountsServer(Meteor.server);

// Users table. Don't use the normal autopublish, since we want to hide
// some fields. Code to autopublish this is in accounts_server.js.
// XXX Allow users to configure this collection name.

/**
 * @summary A [Mongo.Collection](#collections) containing user documents.
 * @locus Anywhere
 * @type {Mongo.Collection}
 * @importFromPackage meteor
*/
Meteor.users = Accounts.users;

export {
  // Since this file is the main module for the server version of the
  // accounts-base package, properties of non-entry-point modules need to
  // be re-exported in order to be accessible to modules that import the
  // accounts-base package.
  AccountsServer
};
