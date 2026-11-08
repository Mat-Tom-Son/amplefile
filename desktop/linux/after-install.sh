#!/bin/sh
set -eu
# Keep the GUI launcher and shell command distinct. Never overwrite an unrelated CLI.
amplefile_cli='/opt/${sanitizedProductName}/bin/amplefile'
if [ ! -e /usr/bin/amplefile ] && [ ! -L /usr/bin/amplefile ]; then
  ln -s "$amplefile_cli" /usr/bin/amplefile
elif [ "$(readlink /usr/bin/amplefile 2>/dev/null || true)" = "$amplefile_cli" ]; then
  :
else
  echo 'amplefile: /usr/bin/amplefile is already owned by another installation; leaving it unchanged.' >&2
fi
