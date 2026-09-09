# mongo-prompt-library — Bun runtime
# Build:  docker build -t promptlib .
# Run:    docker run -p 3000:3000 -e MONGODB_URI=... -e LLM_API_KEY=... promptlib
FROM oven/bun:1 AS base
WORKDIR /app

# install deps first (cached layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# app code
COPY tsconfig.json ./
COPY src ./src
COPY console.html ./

# PORT is injected by the platform (Railway) or defaults to 3000 in code
EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]
