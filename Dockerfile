# Kairos backend — Railway-friendly root Dockerfile
FROM node:22-alpine AS build
WORKDIR /app

COPY kairos-backend/package.json kairos-backend/package-lock.json ./
RUN npm ci

COPY kairos-backend/tsconfig.json ./
COPY kairos-backend/src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY kairos-backend/package.json kairos-backend/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY kairos-backend/rag-corpus ./rag-corpus

EXPOSE 3001
CMD ["node", "dist/index.js"]

