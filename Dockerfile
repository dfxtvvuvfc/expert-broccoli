FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=optional
COPY . .
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache curl unzip ca-certificates libstdc++ \
  && update-ca-certificates
ARG XRAY_VERSION=26.9.8
ARG TARGETARCH
RUN set -eux; \
  case "${TARGETARCH:-amd64}" in \
    amd64) XARCH=64 ;; \
    arm64) XARCH=arm64-v8a ;; \
    *) echo "Unsupported architecture: ${TARGETARCH}"; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-${XARCH}.zip" -o /tmp/xray.zip; \
  mkdir -p /opt/xray; \
  unzip -q /tmp/xray.zip -d /opt/xray; \
  test -x /opt/xray/xray; \
  rm -f /tmp/xray.zip; \
  chmod +x /opt/xray/xray
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server.js ./server.js
RUN mkdir -p /data && chown -R node:node /app /data /opt/xray
USER node
ENV NODE_ENV=production \
    DATA_DIR=/data \
    XRAY_BIN=/opt/xray/xray \
    XRAY_LISTEN_PORT=10000 \
    XRAY_API_PORT=10085
EXPOSE 3000
CMD ["node","server.js"]
