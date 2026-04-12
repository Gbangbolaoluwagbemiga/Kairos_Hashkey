# Kairos API — production image for Railway / any container host
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY rag-corpus ./rag-corpus
EXPOSE 3001
# Railway sets PORT; app uses process.env.PORT || 3001
CMD ["node", "dist/index.js"]
