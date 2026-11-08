#!/bin/sh
set -eu
amplefile_cli='/opt/${sanitizedProductName}/bin/amplefile'
if [ "$(readlink /usr/bin/amplefile 2>/dev/null || true)" = "$amplefile_cli" ]; then
  rm /usr/bin/amplefile
fi
# Folders, Pi resources, credentials, and application data belong to the person.
