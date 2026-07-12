FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && cp src/extension-worker.js dist/

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
RUN npm install --omit=dev
# Nightly Trivy scan in CI; blue-green deploy via registry tag swap
EXPOSE 8090
CMD ["node", "dist/index.js"]
