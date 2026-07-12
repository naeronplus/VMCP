FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/sandbox-service/package.json packages/sandbox-service/
RUN npm install --workspace=@vibrato/shared --workspace=@vibrato/orchestrator --workspace=@vibrato/dashboard
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/orchestrator packages/orchestrator
COPY packages/dashboard packages/dashboard
COPY AGENTS.md ./
COPY docs ./docs/
RUN npm run build -w @vibrato/shared \
 && npm run build -w @vibrato/dashboard \
 && npm run build -w @vibrato/orchestrator

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 8080
CMD ["sh", "-c", "npm run db:migrate -w @vibrato/orchestrator && npm run start -w @vibrato/orchestrator"]
