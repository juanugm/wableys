# WhatsApp Baileys Microservice

Microservicio Node.js para integrar WhatsApp Personal usando **Baileys** (WebSocket directo, sin Chromium).

## 🚀 Ventajas vs whatsapp-web.js

| Métrica | whatsapp-web.js | Baileys |
|---|---|---|
| RAM por sesión | 500-700 MB | 50-80 MB |
| Imagen Docker | ~1.5 GB | ~50 MB |
| Tiempo arranque | 15-30 seg | 2-5 seg |
| Costo Railway | ~$40/mes | **~$5-8/mes** |
| Dependencia | Chromium/Puppeteer | WebSocket directo |

## 📋 Requisitos

- Node.js 18+
- Cuenta en Railway.app (u otro hosting Node.js)
- WhatsApp instalado en tu teléfono

## 🚀 Deployment en Railway.app

### Paso 1: Preparar el repositorio

1. Crea un nuevo repositorio en GitHub
2. Copia los archivos de `whatsapp-baileys/` a tu repositorio:
   - `server.js`
   - `package.json`
   - `Dockerfile`
   - `.env.example`

### Paso 2: Configurar Railway

1. Ve a [Railway.app](https://railway.app) y crea una cuenta
2. Click en "New Project" → "Deploy from GitHub repo"
3. Selecciona tu repositorio
4. **Importante:** Agrega un volumen montado en `/app/auth_sessions` para persistir sesiones entre reinicios

### Paso 3: Configurar Variables de Entorno

En Railway, ve a Variables y agrega:

```bash
PORT=3000
WEBHOOK_URL=https://wmzbqsegsyagcjgxefqs.supabase.co/functions/v1/webhook-whatsapp-personal
WEBHOOK_SECRET=tu_secreto_compartido_aqui
MICROSERVICE_SECRET=tu_secreto_compartido_aqui
ALLOWED_ORIGINS=*
```

**IMPORTANTE:** Genera secretos fuertes:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Paso 4: Configurar Secrets en Supabase

1. Ve a tu proyecto Supabase → Settings → Edge Functions
2. Actualiza el secret:
   - `WHATSAPP_MICROSERVICE_URL`: URL de tu **nuevo** servicio Baileys en Railway

### Paso 5: Re-escanear QR

Después de desplegar, ve al panel de integraciones de tu app y escanea el QR **una única vez**. Baileys guardará las credenciales en disco y reconectará automáticamente.

## 💻 Testing Local

```bash
# Instalar dependencias
npm install

# Configurar .env
cp .env.example .env
# Editar .env con tus valores

# Ejecutar
npm run dev
```

## 📡 Endpoints (idénticos al microservicio anterior)

### GET / y GET /health
Health check del servicio.

### POST /init
Inicia una nueva sesión y genera QR.

```bash
curl -X POST http://localhost:3000/init \
  -H "Authorization: Bearer tu-secret" \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "uuid-del-agente"}'
```

### GET /status/:agent_id
Verifica el estado de conexión.

### POST /send
Envía un mensaje de WhatsApp.

```bash
curl -X POST http://localhost:3000/send \
  -H "Authorization: Bearer tu-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "uuid-del-agente",
    "to": "1234567890",
    "content": "Hola desde Baileys"
  }'
```

### GET /chats/:agent_id
Lista todos los chats.

### GET /messages/:agent_id/:chat_id
Obtiene mensajes de un chat específico.

### POST /disconnect/:agent_id
Desconecta y limpia la sesión.

## 🔄 Migración desde whatsapp-web.js

1. Despliega este nuevo microservicio en Railway (puede ser un servicio nuevo)
2. Actualiza `WHATSAPP_MICROSERVICE_URL` en Supabase con la nueva URL
3. Re-escanea el QR desde el panel de integraciones (una única vez)
4. Verifica que mensajes entrantes y salientes funcionen
5. Una vez confirmado, apaga el servicio viejo de whatsapp-web.js

**No se necesitan cambios en:**
- Edge Functions de Supabase
- Base de datos
- Frontend

## 🔒 Persistencia de Sesión

Baileys usa `useMultiFileAuthState` que guarda credenciales en archivos JSON ligeros (~100KB) en `/app/auth_sessions/`. En Railway, **debes montar un volumen** en esa ruta para que las sesiones persistan entre reinicios del contenedor.

## 💰 Costos Estimados

### Railway.app
- **1 número:** ~$5-8/mes (50-80MB RAM)
- **5 números:** ~$25-40/mes
- vs. whatsapp-web.js: ~$40/mes por 1 número

## 🐛 Troubleshooting

### Error: "Connection closed"
- Baileys reconecta automáticamente ante errores de red
- Si el error persiste, verifica que el volumen de Railway esté montado
- Revisa los logs para ver el código de desconexión

### QR no aparece
- Verifica que `MICROSERVICE_SECRET` coincida en ambos lados
- Revisa los logs del servicio en Railway

### Mensajes no llegan
- Verifica `WEBHOOK_URL` y `WEBHOOK_SECRET`
- Revisa los logs del edge function en Supabase
