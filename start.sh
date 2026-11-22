#!/usr/bin/env bash
# Arranca la API propia, que sirve el front y es la unica que habla con meta-api.
set -euo pipefail

cd "$(dirname "$0")"

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8787}"

# La tienda local es de un solo operador: se fija la sesion para que los
# archivos sigan visibles aunque el navegador borre sus cookies.
# Para aislar por perfil de navegador, arranca con OWNER_SESSION vacio:
#   OWNER_SESSION= ./start.sh
export OWNER_SESSION="${OWNER_SESSION-local-operator-front}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js es necesario (18+)." >&2
  exit 1
fi

echo "Front:   http://${HOST}:${PORT}/"
echo "API:     http://${HOST}:${PORT}/api/"
echo "Meta API: configurable desde el panel del front (boton 'Probar')."

exec node api/server.mjs
