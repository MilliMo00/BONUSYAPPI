# Сборка и запуск одним образом: сервер отдаёт и API, и собранный веб-клиент.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
# Исходники сервера нужны CLI-командам (миграции, создание владельца, настройка бота).
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Миграции применяются при каждом старте: они идемпотентны.
CMD ["sh", "-c", "node apps/server/src/cli/migrate.ts && node apps/server/dist/main.js"]
