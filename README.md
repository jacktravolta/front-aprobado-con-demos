# Front + API propia (meta-api bridge)

El sistema quedo dividido en dos piezas con una unica regla:

> **El front nunca habla con `meta-api`. La API propia es la unica que comunica con
> `meta-api` y devuelve el resultado al front.**

`meta-api` no se modifica: solo se consume por su contrato real
(`/health`, `/v1/models`, `/v1/chat/completions`, `/v1/ajustes`, `/v1/media`).

## Estructura

```
front/
  index.html            front React (bundle original, intacto)
  meta-api-client.js    panel de conexion + gestor de archivos + puente de "actions"
  media-results.js      boton "Implementar", "Mejorar con IA" y panel de resultados
  demos/                material de ejemplo
  README.txt            notas del front original
api/
  server.mjs            API propia (Node, sin dependencias)
  media.mjs             clasificacion de medios y extraccion segura de ZIP
  data/
    config.json         configuracion (incluye la key, permisos 0600)
    records.json        registros de "Mis Resultados" (actions)
    files.json          indice de archivos generados
  storage/files/<id>/   bytes de cada archivo generado
start.sh                arranque local
```

## Arranque

```bash
./start.sh            # http://127.0.0.1:8787
# o
PORT=9000 node api/server.mjs
```

Requisitos: Node.js 18+ y `meta-api` corriendo (por defecto `http://127.0.0.1:8055`).

## Configuracion

Se hace desde el panel **Conexion API** del front (abajo a la izquierda):

| Campo | Que hace |
| --- | --- |
| Base URL de meta-api | URL del proveedor OpenAI-compatible (`http://127.0.0.1:8055`) |
| API key | Opcional mientras `meta-api` este en `auth: abierta`. La key se guarda **solo en el servidor** (`api/data/config.json`, modo `0600`); el navegador nunca la recibe |
| Modelo | `meta-ai` por defecto |
| Pedir ZIP | Pide `resultado.zip` con todos los archivos generados |
| Guardar archivos en la API propia | Pone `fileStorage: local` en `meta-api` para poder descargarlos |

El boton **Probar** consulta `GET /api/health`, que valida `/health` y `/v1/models`.

## Endpoints de la API propia

| Endpoint | Metodo | Que hace |
| --- | --- | --- |
| `/api/config` | GET / PUT | Configuracion publica (sin key) |
| `/api/health` | GET | Estado de la conexion con `meta-api` |
| `/api/improve` | POST | Mejora un texto o un prompt (`mode: text` \| `prompt`) |
| `/api/chat`, `/api/generate` | POST | Envia el prompt a `meta-api`, descarga y guarda todo lo generado |
| `/api/files` | GET | Lista de archivos generados |
| `/api/files/:id/:name` | GET | Sirve el archivo (`?inline=1` para previsualizar, `?download=1` para descargar) |
| `/api/files/:id` | DELETE | Elimina el archivo y su indice |
| `/actions`, `/api/actions` | POST | `records.list` / `records.create` / `records.delete` (Mis Resultados) |

## Flujo del front

- **Mejorar con IA**: cada campo de texto y cada prompt tiene su boton. Se habilita
  cuando hay texto, llama a `POST /api/improve` y devuelve la respuesta al mismo campo.
  El prompt a `meta-api` exige explicitamente devolver solo el resultado final, sin
  comentarios, prefijos ni markdown; la API limpia los envoltorios habituales.
- **Implementar**: aparece junto a "Copiar prompt" en todos los modulos. Envia el
  prompt a la API propia, que llama a `meta-api`, descarga imagenes, videos, audio,
  SRT, ZIP y demas, los guarda y los devuelve con una URL del mismo origen.
- **Resultados**: el panel final muestra galeria de imagenes, reproductores de video y
  audio, vista previa de subtitulos y descarga de cada archivo y del ZIP.

## Persistencia

Sin base de datos. Todo es JSON de texto plano:

- `api/data/config.json` — configuracion
- `api/data/records.json` — registros de "Mis Resultados"
- `api/data/files.json` — indice de archivos (id, nombre, mime, bytes, kind, url)

Los bytes viven en `api/storage/files/<id>/`. Un ZIP se conserva como bundle y ademas
se descomprime para registrar cada archivo interno como recurso individual.
