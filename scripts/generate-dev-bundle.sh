#!/usr/bin/env bash

set -e
set -u

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Read the bundle version from the meteor shell script.
BUNDLE_VERSION=$(perl -ne 'print $1 if /BUNDLE_VERSION=(\S+)/' meteor)
if [ -z "$BUNDLE_VERSION" ]; then
    echo "BUNDLE_VERSION not found"
    exit 1
fi

source "$SCRIPT_DIR/build-dev-bundle-common.sh"
source "$SCRIPT_DIR/local-settings.sh"

if [[ "$METEOR_DEV_BUNDLE_EXTERNAL_VERSION" == "true" ]] ; then
    BUNDLE_VERSION="UNKNOWN"
fi

if [[ "$METEOR_DEV_BUNDLE_OUTPUT_TAR" == "" ]] ; then
    METEOR_DEV_BUNDLE_OUTPUT_TAR="${CHECKOUT_DIR}/dev_bundle_${PLATFORM}_${BUNDLE_VERSION}.tar.gz"
fi

echo CHECKOUT DIR IS "$CHECKOUT_DIR"
echo BUILDING DEV BUNDLE "$BUNDLE_VERSION" IN "$DIR" to "$METEOR_DEV_BUNDLE_OUTPUT_TAR"

cd "$DIR"

extractNodeFromLocalTarGz() {
    if [ -f "$METEOR_DEV_BUNDLE_LOCAL_NODE" ] ; then
        echo "Skipping download and installing Node from local $METEOR_DEV_BUNDLE_LOCAL_NODE" >&2
        tar --strip-components 1 -zxf "$METEOR_DEV_BUNDLE_LOCAL_NODE"
        return 0
    fi
    return 1
}

extractNodeFromTarGz() {
    LOCAL_TGZ="${CHECKOUT_DIR}/node_${PLATFORM}_v${NODE_VERSION}.tar.gz"
    if [ -f "$LOCAL_TGZ" ]
    then
        echo "Skipping download and installing Node from $LOCAL_TGZ" >&2
        tar zxf "$LOCAL_TGZ"
        return 0
    fi
    return 1
}

downloadNodeFromS3() {
    test -n "${NODE_BUILD_NUMBER}" || return 1
    S3_HOST="s3.amazonaws.com/com.meteor.jenkins"
    S3_TGZ="node_${UNAME}_${ARCH}_v${NODE_VERSION}.tar.gz"
    NODE_URL="https://${S3_HOST}/dev-bundle-node-${NODE_BUILD_NUMBER}/${S3_TGZ}"
    echo "Downloading Node from ${NODE_URL}" >&2
    curl "${NODE_URL}" | tar zx --strip 1
}

# Nodejs 14 official download source has been discontinued, we are switching to our custom source https://static.meteor.com
downloadOfficialNode14() {
    METEOR_NODE_URL="https://static.meteor.com/dev-bundle-node-os/v${NODE_VERSION}/${NODE_TGZ}"
    echo "Downloading Node from ${METEOR_NODE_URL}" >&2
    curl "${METEOR_NODE_URL}" | tar zx --strip-components 1
}

downloadOfficialNode() {
    NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TGZ}"
    echo "Downloading Node from ${NODE_URL}" >&2
    curl "${NODE_URL}" | tar zx --strip-components 1
}

downloadReleaseCandidateNode() {
    NODE_URL="https://nodejs.org/download/rc/v${NODE_VERSION}/${NODE_TGZ}"
    echo "Downloading Node from ${NODE_URL}" >&2
    curl "${NODE_URL}" | tar zx --strip-components 1
}

# Try each strategy in the following order:
extractNodeFromLocalTarGz || extractNodeFromTarGz || downloadNodeFromS3 || \
  downloadOfficialNode14 || downloadReleaseCandidateNode

if [[ "$METEOR_DEV_BUNDLE_LOCAL_MONGO" != "" ]] ; then
    echo "Copying mongodb from local dir: $METEOR_DEV_BUNDLE_LOCAL_MONGO"
    mkdir -p "mongodb/bin"
    cp "${METEOR_DEV_BUNDLE_LOCAL_MONGO}/bin/mongod" "mongodb/bin"
    if [ -f "${METEOR_DEV_BUNDLE_LOCAL_MONGO}/bin/mongo" ]; then
        cp "${METEOR_DEV_BUNDLE_LOCAL_MONGO}/bin/mongo" "mongodb/bin"
    fi
    if [ -f "${METEOR_DEV_BUNDLE_LOCAL_MONGO}/bin/mongos" ]; then
        cp "${METEOR_DEV_BUNDLE_LOCAL_MONGO}/bin/mongos" "mongodb/bin"
    fi
else
    # On macOS, download MongoDB from mongodb.com. On Linux, download a custom build
    # that is compatible with current distributions. If a 32-bit Linux is used,
    # download a 32-bit legacy version from mongodb.com instead.
    MONGO_VERSION=$MONGO_VERSION_64BIT

    if [ $ARCH = "i686" ] && [ $OS = "linux" ]; then
        MONGO_VERSION=$MONGO_VERSION_32BIT
    fi

    case $OS in
        macos) MONGO_BASE_URL="https://fastdl.mongodb.org/osx" ;;
        linux)
            [ $ARCH = "i686" ] &&
                MONGO_BASE_URL="https://fastdl.mongodb.org/linux" ||
                MONGO_BASE_URL="https://github.com/meteor/mongodb-builder/releases/download/v${MONGO_VERSION}"
            ;;
    esac


    if [ $OS = "macos" ] && [ "$(uname -m)" = "arm64" ] ; then
      MONGO_NAME="mongodb-${OS}-x86_64-${MONGO_VERSION}"
    else
      MONGO_NAME="mongodb-${OS}-${ARCH}-${MONGO_VERSION}"
    fi

    MONGO_TGZ="${MONGO_NAME}.tgz"
    MONGO_URL="${MONGO_BASE_URL}/${MONGO_TGZ}"
    echo "Downloading Mongo from ${MONGO_URL}"
    curl -L "${MONGO_URL}" | tar zx

    # Put Mongo binaries in the right spot (mongodb/bin)
    mkdir -p "mongodb/bin"
    mv "${MONGO_NAME}/bin/mongod" "mongodb/bin"
    mv "${MONGO_NAME}/bin/mongos" "mongodb/bin"
    rm -rf "${MONGO_NAME}"
fi

# export path so we use the downloaded node and npm
export PATH="$DIR/bin:$PATH"

if [[ "$METEOR_DEV_BUNDLE_OVERRIDE_NPM" != "false" ]] ; then
    cd "$DIR/lib"
    # Overwrite the bundled version with the latest version of npm.
    npm install "npm@$NPM_VERSION"
    npm config set python `which python3`
else
    echo "Skipping install of npm"
fi

which node
which npm
npm version

# Make node-gyp use Node headers and libraries from $DIR/include/node.
export HOME="$DIR"
export USERPROFILE="$DIR"
export npm_config_nodedir="$DIR"

INCLUDE_PATH="${DIR}/include/node"
echo "Contents of ${INCLUDE_PATH}:"
ls -al "$INCLUDE_PATH"

# When adding new node modules (or any software) to the dev bundle,
# remember to update LICENSE.txt! Also note that we include all the
# packages that these depend on, so watch out for new dependencies when
# you update version numbers.

# First, we install the modules that are dependencies of tools/server/boot.js:
# the modules that users of 'meteor bundle' will also have to install. We save a
# shrinkwrap file with it, too.  We do this in a separate place from
# $DIR/server-lib/node_modules originally, because otherwise 'npm shrinkwrap'
# will get confused by the pre-existing modules.
mkdir "${DIR}/build/npm-server-install"
cd "${DIR}/build/npm-server-install"
node "${CHECKOUT_DIR}/scripts/dev-bundle-server-package.js" > package.json
# XXX For no apparent reason this npm install will fail with an EISDIR
# error if we do not help it by creating the .npm/_locks directory.
mkdir -p "${DIR}/.npm/_locks"
npm install
npm outdated
npm audit || true
npm shrinkwrap

mkdir -p "${DIR}/server-lib/node_modules"
# This ignores the stuff in node_modules/.bin, but that's OK.
cp -R node_modules/* "${DIR}/server-lib/node_modules/"

mkdir -p "${DIR}/etc"
mv package.json npm-shrinkwrap.json "${DIR}/etc/"

# Now, install the npm modules which are the dependencies of the command-line
# tool.
mkdir "${DIR}/build/npm-tool-install"
cd "${DIR}/build/npm-tool-install"
if [[ "$METEOR_DEV_BUNDLE_OVERRIDE_NPM" == "false" ]] ; then
    sed -e 's/npm:/\/\/ npm:/g' "${CHECKOUT_DIR}/scripts/dev-bundle-tool-package.js" > "$DIR/dev-bundle-tool-package.js"
    node "$DIR/dev-bundle-tool-package.js" >package.json
    rm -f "$DIR/dev-bundle-tool-package.js"
else
    node "${CHECKOUT_DIR}/scripts/dev-bundle-tool-package.js" >package.json
fi
npm install
npm outdated
npm audit || true
cp -R node_modules/* "${DIR}/lib/node_modules/"
# Also include node_modules/.bin, so that `meteor npm` can make use of
# commands like node-gyp and node-pre-gyp.
cp -R node_modules/.bin "${DIR}/lib/node_modules/"

cd "${DIR}/lib"

cd node_modules

## Clean up some bulky stuff.

# Used to delete bulky subtrees. It's an error (unlike with rm -rf) if they
# don't exist, because that might mean it moved somewhere else and we should
# update the delete line.
delete () {
    if [ ! -e "$1" ]; then
        echo "Missing (moved?): $1"
        exit 1
    fi
    rm -rf "$1"
}

# Since we install a patched version of pacote in $DIR/lib/node_modules,
# we need to remove npm's bundled version to make it use the new one.
if [ -d "pacote" ]
then
    delete npm/node_modules/pacote
    mv pacote npm/node_modules/
fi

delete sqlite3/deps
delete sqlite3/node_modules/node-pre-gyp
delete wordwrap/test
delete moment/min

# Remove esprima tests to reduce the size of the dev bundle
find . -path '*/esprima-fb/test' | xargs rm -rf

# Sanity check to see if we're not breaking anything by replacing npm
INSTALLED_NPM_VERSION=$(cat "$DIR/lib/node_modules/npm/package.json" |
xargs -0 node -e "console.log(JSON.parse(process.argv[1]).version)")
if [ "$INSTALLED_NPM_VERSION" != "$NPM_VERSION" ] && [[ "$METEOR_DEV_BUNDLE_OVERRIDE_NPM" != "false" ]]; then
  echo "Error: Unexpected NPM version in lib/node_modules: $INSTALLED_NPM_VERSION"
  echo "Update this check if you know what you're doing."
  exit 1
fi

echo BUNDLING

cd "$DIR"

if [[ "$BUNDLE_VERSION" != "UNKNOWN" ]] ; then
    echo "${BUNDLE_VERSION}" > .bundle_version.txt
fi

rm -rf build CHANGELOG.md ChangeLog LICENSE README.md .npm

mkdir -p "$( dirname "$METEOR_DEV_BUNDLE_OUTPUT_TAR" )"
tar czf "$METEOR_DEV_BUNDLE_OUTPUT_TAR" .

echo DONE
